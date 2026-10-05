// 局域网 HTTP 服务：手机端页面 + JSON/SSE 接口 + 鉴权。
//
// 为什么不用宿主的 ctx.webServer：它只监听 127.0.0.1（实测），手机连不上。
// 这个插件因此自己起一个监听 0.0.0.0 的服务，并用**随机令牌**把访问收窄到
// 「拿到配对链接的人」。
//
// 安全模型（务必和 README 保持一致）：
//   - 令牌 128 位随机、只存在本机 state.json；
//   - 三种携带方式：`?k=<token>`（首次配对）、Cookie `mc_auth`、请求头 `X-MC-Token`；
//   - 首次用 `?k=` 访问成功后会种一个 HttpOnly Cookie 并 302 到 `/`，避免令牌留在
//     浏览器历史与地址栏；
//   - 比较用 timingSafeEqual，避免按字符比较带来的时间侧信道；
//   - **没有令牌就什么都拿不到**（页面、脚本、接口一律 401）。

import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

// 版本透传：外壳用 `?v=` 重新加载时整张模块图都要重新求值（见 boot.js）。
const VERSION = new URL(import.meta.url).search
const { listLanAddresses, primaryLanAddress } = await import(`./net.js${VERSION}`)
const { log } = await import(`./log.js${VERSION}`)
const { appCss, appJs, indexHtml } = await import(`./ui.js${VERSION}`)

/** HTTP 请求体上限：手机只发短消息与作答，256KB 很宽裕。 */
const MAX_BODY_BYTES = 256 * 1024

/** SSE 心跳间隔：防止中间设备把空闲连接掐掉。 */
const SSE_PING_MS = 25_000

/** 状态快照推送的最小间隔（同一时间窗内的多次变更合并成一次）。 */
const BROADCAST_THROTTLE_MS = 200

/** 端口被占用时向后尝试的次数。 */
const PORT_RETRIES = 10

/** Cookie 名。 */
const COOKIE_NAME = 'mc_auth'

/** 页面/脚本在手机浏览器里的缓存策略：脚本要能随插件更新，所以不缓存。 */
const NO_STORE = { 'Cache-Control': 'no-store' }

/**
 * 恒定时间比较两个令牌。
 *
 * @param {string} left 待比较值
 * @param {string} right 期望值
 * @returns {boolean} 是否相等
 */
function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  // 长度不同时也要走一次比较（对长度做恒定时间），再返回 false。
  if (a.length !== b.length) {
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

/**
 * 解析 Cookie 头。
 *
 * @param {string | undefined} header Cookie 头
 * @returns {Record<string, string>} 键值表
 */
function parseCookies(header) {
  const out = {}
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

/**
 * 读请求体并解析 JSON。
 *
 * @param {import('node:http').IncomingMessage} req 请求
 * @returns {Promise<any>} 解析结果（空体返回 {}）
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8').trim()
      if (text === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 手机端服务。
 */
export class MobileServer {
  /**
   * @param {{ token: string, config: Record<string, any> }} options 令牌与运行参数
   */
  constructor({ token, config }) {
    this.token = token
    this.config = config
    /** @type {import('node:http').Server | null} */
    this.server = null
    /** 是否正在监听。设置页的总开关据此判断要不要真的启停。 */
    this.listening = false
    /** 实际生效的端口（可能与配置不同：被占用时会顺延）。 */
    this.port = config.port
    /** @type {Set<import('node:http').ServerResponse>} 在线 SSE 连接。 */
    this.clients = new Set()
    /** @type {any} bridge，由 attach 注入。 */
    this.bridge = null
    this.pingTimer = null
    this.broadcastTimer = null
  }

  /**
   * 注入业务侧；服务只负责传输与鉴权。
   *
   * @param {any} bridge MobileBridge
   */
  attach(bridge) {
    this.bridge = bridge
  }

  /** 在线手机数量。 */
  clientCount() {
    return this.clients.size
  }

  /**
   * 换一个新令牌。旧的配对链接会在下一次请求时立即失效。
   *
   * 不重启监听：令牌只是每个请求比较的一个字段，换掉即刻生效。
   *
   * @param {string} token 新令牌
   */
  setToken(token) {
    this.token = token
  }

  /**
   * 启动监听。端口被占用时自动向后顺延，返回实际端口。
   *
   * @returns {Promise<number>} 实际端口
   */
  async start() {
    for (let attempt = 0; attempt <= PORT_RETRIES; attempt += 1) {
      const port = this.config.port + attempt
      try {
        await this.listen(port, this.config.bindHost)
        // 读回真实端口：`port: 0` 时由系统分配（测试用），顺延时也要反映实际值。
        const address = this.server?.address?.()
        this.port = address !== null && typeof address === 'object' ? address.port : port
        if (this.port !== this.config.port) log(`server: 端口 ${this.config.port} 被占用或由系统分配，实际使用 ${this.port}`)
        this.pingTimer = setInterval(() => this.ping(), SSE_PING_MS)
        this.pingTimer.unref?.()
        log(`server: 监听 http://${this.config.bindHost}:${this.port} (${listLanAddresses().join(', ') || '无局域网地址'})`)
        return this.port
      } catch (error) {
        if (error && error.code === 'EADDRINUSE') continue
        throw error
      }
    }
    throw new Error(`端口 ${this.config.port}..${this.config.port + PORT_RETRIES} 都被占用`)
  }

  /**
   * 在指定端口监听。
   *
   * @param {number} port 端口
   * @param {string} host 监听地址
   * @returns {Promise<void>}
   */
  listen(port, host) {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          log(`server: 请求处理异常 ${String(error)}`)
          if (!res.headersSent) json(res, 500, { error: '内部错误' })
          else res.end()
        })
      })
      const onError = (error) => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        this.server = server
        this.listening = true
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
  }

  /** 停止监听并断开所有手机连接。 */
  async stop() {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.broadcastTimer !== null) {
      clearTimeout(this.broadcastTimer)
      this.broadcastTimer = null
    }
    for (const client of this.clients) {
      try {
        client.end()
      } catch {
        /* 连接可能已经断了 */
      }
    }
    this.clients.clear()
    const server = this.server
    this.server = null
    this.listening = false
    if (server === null) return
    await new Promise((resolve) => server.close(() => resolve()))
  }

  /** @returns {string} 给手机用的配对地址（含令牌）。 */
  pairingUrl() {
    return `http://${primaryLanAddress()}:${this.port}/?k=${this.token}`
  }

  /** @returns {string[]} 所有可用的配对地址（多网卡时都给出来）。 */
  allPairingUrls() {
    const hosts = listLanAddresses()
    return (hosts.length > 0 ? hosts : ['127.0.0.1']).map((host) => `http://${host}:${this.port}/?k=${this.token}`)
  }

  /**
   * 校验请求是否携带有效令牌。
   *
   * @param {import('node:http').IncomingMessage} req 请求
   * @param {URL} url 解析后的地址
   * @returns {{ ok: boolean, fromQuery: boolean }} 校验结果
   */
  authorize(req, url) {
    const queryToken = url.searchParams.get('k')
    if (safeEqual(queryToken ?? '', this.token)) return { ok: true, fromQuery: true }
    const headerToken = req.headers['x-mc-token']
    if (safeEqual(typeof headerToken === 'string' ? headerToken : '', this.token)) return { ok: true, fromQuery: false }
    const cookies = parseCookies(req.headers.cookie)
    if (safeEqual(cookies[COOKIE_NAME] ?? '', this.token)) return { ok: true, fromQuery: false }
    return { ok: false, fromQuery: false }
  }

  /**
   * 处理一个请求。
   *
   * @param {import('node:http').IncomingMessage} req 请求
   * @param {import('node:http').ServerResponse} res 响应
   */
  async handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const auth = this.authorize(req, url)

    if (!auth.ok) {
      json(res, 401, { error: '未授权：请用带令牌的配对链接打开本页' }, { 'WWW-Authenticate': 'MC token' })
      return
    }

    // 首次用 ?k= 打开：种 Cookie 并把令牌从地址栏 / 历史里去掉。
    if (auth.fromQuery && url.pathname === '/' && req.method === 'GET') {
      res.writeHead(302, {
        'Set-Cookie': `${COOKIE_NAME}=${encodeURIComponent(this.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
        Location: '/',
        ...NO_STORE,
      })
      res.end()
      return
    }

    const path = url.pathname

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      send(res, 200, 'text/html; charset=utf-8', indexHtml(), NO_STORE)
      return
    }
    if (req.method === 'GET' && path === '/app.css') {
      send(res, 200, 'text/css; charset=utf-8', appCss(), NO_STORE)
      return
    }
    if (req.method === 'GET' && path === '/app.js') {
      send(res, 200, 'text/javascript; charset=utf-8', appJs(), NO_STORE)
      return
    }
    if (req.method === 'GET' && path === '/favicon.ico') {
      send(res, 204, 'image/x-icon', '')
      return
    }
    if (req.method === 'GET' && path === '/qr.svg') {
      const svg = this.bridge?.qrSvg?.() ?? ''
      if (svg === '') {
        json(res, 500, { error: '二维码生成失败（地址过长）' })
        return
      }
      send(res, 200, 'image/svg+xml; charset=utf-8', svg, NO_STORE)
      return
    }
    if (req.method === 'GET' && path === '/api/state') {
      json(res, 200, this.bridge.snapshot(), NO_STORE)
      return
    }
    if (req.method === 'GET' && path === '/api/events') {
      this.openStream(req, res)
      return
    }
    if (req.method === 'POST') {
      await this.handleAction(req, res, path)
      return
    }
    json(res, 404, { error: '没有这个接口' })
  }

  /**
   * 处理写操作。
   *
   * @param {import('node:http').IncomingMessage} req 请求
   * @param {import('node:http').ServerResponse} res 响应
   * @param {string} path 路径
   */
  async handleAction(req, res, path) {
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      json(res, 400, { error: String(error instanceof Error ? error.message : error) })
      return
    }
    try {
      if (path === '/api/answer') {
        await this.bridge.answer(body)
      } else if (path === '/api/send') {
        await this.bridge.sendMessage(body)
      } else if (path === '/api/arm') {
        this.bridge.setArmed(body.sessionId, body.armed === true)
      } else if (path === '/api/stop') {
        this.bridge.stopSession(body.sessionId)
      } else if (path === '/api/prefs') {
        this.bridge.setPrefs(body)
      } else {
        json(res, 404, { error: '没有这个接口' })
        return
      }
      json(res, 200, { ok: true }, NO_STORE)
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * 建立一条 SSE 连接，并立刻推一份当前快照。
   *
   * @param {import('node:http').IncomingMessage} req 请求
   * @param {import('node:http').ServerResponse} res 响应
   */
  openStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // 允许同源之外的调试工具直连（仍需令牌）。
      'X-Accel-Buffering': 'no',
    })
    res.write('retry: 3000\n\n')
    this.clients.add(res)
    log(`server: 手机已连接（在线 ${this.clients.size}）`)
    this.pushOne(res)
    const cleanup = () => {
      if (this.clients.delete(res)) log(`server: 手机已断开（在线 ${this.clients.size}）`)
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
  }

  /**
   * 给单个连接推当前快照。
   *
   * @param {import('node:http').ServerResponse} res 连接
   */
  pushOne(res) {
    try {
      res.write(`event: state\ndata: ${JSON.stringify(this.bridge.snapshot())}\n\n`)
    } catch (error) {
      log(`server: 推送失败 ${String(error)}`)
      this.clients.delete(res)
    }
  }

  /** SSE 心跳（注释帧，不触发前端事件）。 */
  ping() {
    for (const client of this.clients) {
      try {
        client.write(': ping\n\n')
      } catch {
        this.clients.delete(client)
      }
    }
  }

  /** 合并短时间内的多次变更后向外广播一次完整快照。 */
  broadcast() {
    if (this.clients.size === 0) return
    if (this.broadcastTimer !== null) return
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      for (const client of this.clients) this.pushOne(client)
    }, BROADCAST_THROTTLE_MS)
    this.broadcastTimer.unref?.()
  }
}

/**
 * 发一个响应。
 *
 * @param {import('node:http').ServerResponse} res 响应
 * @param {number} status 状态码
 * @param {string} type Content-Type
 * @param {string} body 正文
 * @param {Record<string, string>} [extra] 额外响应头
 */
function send(res, status, type, body, extra) {
  res.writeHead(status, { 'Content-Type': type, ...(extra ?? {}) })
  res.end(body)
}

/**
 * 发一个 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} res 响应
 * @param {number} status 状态码
 * @param {unknown} value 值
 * @param {Record<string, string>} [extra] 额外响应头
 */
function json(res, status, value, extra) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value), extra)
}
