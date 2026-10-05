// dsh-mobile-console — 桌面（DSH Web 界面）半边：设置页要用的一组同源路由。
//
// 为什么走 DSH 自己的 webServer 而不是手机那个 8799 端口：浏览器打开的页面在
// `127.0.0.1:19387`，从那里去调 `http://<局域网IP>:8799` 是跨域，要么加 CORS、要么被浏览器
// 拦掉。注册成同源路由（`/api/mobile-console/*`）就没有这个问题，也顺带复用了宿主
// 自己的准入检查。
//
// ⚠️ 安全前提：本插件注册的前缀比内核的 `/api` 更长，而 webServer 是**最长前缀优先**，
// 所以这些路由跑在内核准入检查之前。不自己加围栏的话，任何能访问回环地址的东西都能拿到
// 配对令牌（那等于手机控制台的完整控制权）。下面两道防线与 DSH 内核给 `/api` 用的是同一套
// 判断：优先用宿主 `connection` 服务的准入结论，没有该服务时退回结构等价的本地围栏。

/** 同源路由前缀。 */
export const ROUTE_PREFIX = '/api/mobile-console'

/** 请求体上限：这里最大的请求也就是一个会话 id，1MB 绰绰有余。 */
const MAX_BODY_BYTES = 1024 * 1024

/** 同一个机器上的调用方可能用的主机名。 */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

/**
 * 把 Host / Origin / Referer 拆成 {scheme, hostname, port}，端口按协议补默认值。
 *
 * @param {string} value 原始值
 * @param {string} [defaultScheme] 没写协议时的默认协议
 * @returns {{scheme: string, hostname: string, port: string} | null} 结果
 */
function authorityOf(value, defaultScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.includes('://') ? value.trim() : `${defaultScheme ?? 'http'}://${value.trim()}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port }
}

/**
 * 结构等价的本地围栏：只允许回环主机名、拒绝跨站请求、Origin/Referer 必须与 Host 同源。
 *
 * Host 必须校验是为了防 DNS 重绑定——攻击者把自己的域名解析到 127.0.0.1 时，浏览器
 * 发出的 Host 就是那个域名，而不是回环地址。
 *
 * @param {import('node:http').IncomingMessage} req 请求
 * @returns {number | undefined} 该拒绝的 HTTP 状态码；放行时 undefined
 */
export function structuralRejection(req) {
  const host = authorityOf(req.headers?.host, 'http')
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 403

  const site = String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return 403

  for (const header of ['origin', 'referer']) {
    const raw = req.headers?.[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const authority = authorityOf(raw.trim())
    if (authority === null) return 403
    // 页面是明文 http 的回环地址，声称 https 或别的协议的 Origin 不是本页面。
    if (authority.scheme !== host.scheme || authority.hostname !== host.hostname || authority.port !== host.port) {
      return 403
    }
  }
  return undefined
}

/**
 * 判定一个请求该不该被拒。
 *
 * @param {import('node:http').IncomingMessage} req 请求
 * @param {any} connection 宿主的 connection 服务（可能不存在）
 * @returns {number | undefined} 状态码；放行时 undefined
 */
export function rejectionFor(req, connection) {
  if (connection !== undefined && connection !== null && typeof connection.admit === 'function') {
    try {
      const admission = connection.admit(req)
      if (admission !== null && typeof admission === 'object' && 'rejection' in admission) return admission.rejection
      return undefined
    } catch {
      // 宿主服务自己抛异常是它的问题，退回到本地围栏，不能因此对所有请求 500。
    }
  }
  return structuralRejection(req)
}

/**
 * 读一个 JSON 请求体。
 *
 * @param {import('node:http').IncomingMessage} req 请求
 * @returns {Promise<any>} 解析结果
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    // "发了 body 但不是 JSON" 是调用方的 bug，不该当成"没有 body"静默成功。
    throw new Error(`请求体不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`)
  }
}

/**
 * 建一个设置页用的路由处理器。
 *
 * @param {{
 *   bridge: any,
 *   server: any,
 *   config: any,
 *   saveConfig: () => void,
 *   saveState: () => void,
 *   setEnabled: (enabled: boolean) => Promise<void>,
 *   isEnabled: () => boolean,
 *   rotateToken: () => Promise<void>,
 *   getContext: () => any,
 * }} deps 依赖
 * @returns {(req: any, res: any) => Promise<void>} 处理器
 */
export function createDesktopHandler(deps) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.replace(ROUTE_PREFIX, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()

    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    }

    const rejection = rejectionFor(req, deps.getContext?.()?.get?.('connection'))
    if (rejection !== undefined) {
      return send(rejection, { error: rejection === 403 ? 'forbidden' : 'unauthorized' })
    }

    try {
      if (method === 'GET' && routePath === '/status') {
        return send(200, buildStatus(deps))
      }

      if (method === 'POST' && routePath === '/enabled') {
        const body = await readJson(req)
        if (typeof body.enabled !== 'boolean') return send(400, { error: 'enabled 必须是布尔值' })
        deps.config.enabled = body.enabled
        deps.saveConfig()
        await deps.setEnabled(body.enabled)
        return send(200, buildStatus(deps))
      }

      if (method === 'POST' && routePath === '/arm') {
        const body = await readJson(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '' || typeof body.armed !== 'boolean') {
          return send(400, { error: '需要 sessionId 与 armed' })
        }
        deps.bridge.setArmed(sessionId, body.armed)
        return send(200, buildStatus(deps))
      }

      if (method === 'POST' && routePath === '/prefs') {
        const body = await readJson(req)
        // 复用桥接自己的范围校验：越界的值会被忽略，而不是写进配置。
        deps.bridge.setPrefs(body ?? {})
        deps.saveConfig()
        return send(200, buildStatus(deps))
      }

      if (method === 'POST' && routePath === '/rotate') {
        await deps.rotateToken()
        return send(200, buildStatus(deps))
      }

      return send(404, { error: '没有这个接口' })
    } catch (error) {
      return send(400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * 组装状态页需要的一切。
 *
 * @param {any} deps 依赖
 * @returns {any} 状态
 */
function buildStatus(deps) {
  const snapshot = deps.bridge.snapshot()
  const enabled = deps.isEnabled()
  // 关掉时不能给地址：端口根本没在听，给一个连不上的链接只会让人白折腾。
  const url = enabled ? (deps.server?.pairingUrl?.() ?? '') : ''
  const svg = enabled ? deps.bridge.qrSvg() : ''
  return {
    ok: true,
    enabled,
    port: deps.server?.port ?? deps.config.port,
    bindHost: deps.config.bindHost,
    clients: deps.server?.clientCount?.() ?? 0,
    urls: enabled ? (deps.server?.allPairingUrls?.() ?? []) : [],
    url,
    // SVG 转成 data URL：前端直接 <img src>，不需要 innerHTML 注入。
    qr: svg === '' ? '' : `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
    tokenTail: typeof deps.getState?.()?.token === 'string' ? deps.getState().token.slice(-4) : '',
    balance: snapshot.balance,
    prefs: snapshot.prefs,
    sessions: snapshot.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      status: session.status,
      armed: session.armed,
      subagent: session.subagent,
      pending: session.pending,
      lastActivityAt: session.lastActivityAt,
    })),
    pending: snapshot.pending.length,
  }
}

/**
 * 把路由挂到宿主的 webServer 上。
 *
 * 用 `ctx.inject(['webServer'], …)` 而不是 `ctx.get('webServer')`：插件加载时该服务
 * 常常还没就绪，一次性读取会把"暂时没有"冻结成"永远没有"。同时把 disposer 收起来返回，
 * 因为热重载不会销毁 fiber，`ctx.effect` 那条路在热重载时不会跑。
 *
 * @param {any} ctx cordis 上下文
 * @param {any} deps 依赖
 * @returns {() => void} 注销函数
 */
export function registerDesktopRoutes(ctx, deps) {
  const disposers = []
  const once = (fn) => {
    let done = false
    return () => {
      if (done) return
      done = true
      try {
        fn()
      } catch {
        /* 已经清过了 */
      }
    }
  }

  try {
    const disposeInject = ctx.inject(['webServer'], (scoped) => {
      const webServer = scoped.webServer
      const disposeRoute = scoped.effect(
        () => webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: createDesktopHandler(deps) }),
        'dsh-mobile-console: desktop routes',
      )
      if (typeof disposeRoute === 'function') disposers.push(once(disposeRoute))
    })
    if (typeof disposeInject === 'function') disposers.push(once(disposeInject))
  } catch (error) {
    // 没有 webServer 时（比如纯 CLI 组合）只是没有设置页入口，插件本体照常工作。
    deps.onUnavailable?.(error)
  }

  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
  }
}
