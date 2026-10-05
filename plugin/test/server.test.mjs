// 传输层测试：鉴权、页面与接口、SSE 推送、端口顺延。
//
// 安全相关的用例是重点：手机控制台把会话内容暴露在局域网上，令牌是唯一的门。
// 「没有令牌什么都拿不到」「错令牌一律 401」这两条必须被固定住。

import { createServer } from 'node:http'

import { eq, ok, group, report, makeTempHome, sleep, keepAlive } from './harness.mjs'

process.env.DSH_HOME = makeTempHome('server')

const { MobileServer } = await import('../src/server.js')

const TOKEN = 'c0ffee'.repeat(5) + 'ab'

/**
 * 造一个只实现传输层所需方法的假桥接。
 *
 * @returns {any} 假桥接
 */
function fakeBridge() {
  const calls = []
  return {
    calls,
    snapshot: () => ({ ok: true, now: Date.now(), sessions: [], pending: [], feed: [], server: { port: 1 }, prefs: {} }),
    answer: (body) => calls.push({ method: 'answer', body }),
    sendMessage: async (body) => {
      calls.push({ method: 'send', body })
    },
    setArmed: (id, armed) => calls.push({ method: 'arm', id, armed }),
    stopSession: (id) => calls.push({ method: 'stop', id }),
    setPrefs: (body) => calls.push({ method: 'prefs', body }),
    qrSvg: () => '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  }
}

/**
 * 起一个测试用的服务。
 *
 * @param {Record<string, any>} [config] 覆盖配置
 * @returns {Promise<{server: any, bridge: any, base: string, stop: () => Promise<void>}>} 句柄
 */
async function startServer(config = {}) {
  const bridge = fakeBridge()
  const server = new MobileServer({ token: TOKEN, config: { port: 0, bindHost: '127.0.0.1', relayTimeoutSec: 60, ...config } })
  server.attach(bridge)
  await server.start()
  return {
    server,
    bridge,
    base: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(),
  }
}

group('鉴权：没有令牌什么都拿不到')
{
  const { base, stop } = await startServer()
  for (const path of ['/', '/app.css', '/app.js', '/api/state', '/qr.svg']) {
    const response = await fetch(base + path)
    eq(`${path} 应 401`, response.status, 401)
  }
  const wrong = await fetch(`${base}/?k=${'f'.repeat(TOKEN.length)}`)
  eq('错令牌 401', wrong.status, 401)
  const shortToken = await fetch(`${base}/?k=${TOKEN.slice(0, 4)}`)
  eq('长度不同的错令牌也是 401', shortToken.status, 401)
  const post = await fetch(`${base}/api/answer`, { method: 'POST', body: '{}' })
  eq('写接口同样 401', post.status, 401)
  await stop()
}

group('配对：?k= 种 Cookie 并 302 去掉地址栏里的令牌')
{
  const { base, stop } = await startServer()
  const response = await fetch(`${base}/?k=${TOKEN}`, { redirect: 'manual' })
  eq('重定向到干净地址', response.status, 302)
  eq('Location 是 /', response.headers.get('location'), '/')
  const cookie = response.headers.get('set-cookie') ?? ''
  ok('种了 Cookie', cookie.includes('mc_auth='))
  ok('Cookie 是 HttpOnly', /HttpOnly/i.test(cookie))
  ok('Cookie 是 SameSite=Lax', /SameSite=Lax/i.test(cookie))
  ok('令牌不出现在 Location 里', !(response.headers.get('location') ?? '').includes(TOKEN))

  const html = await fetch(`${base}/`, { headers: { cookie: `mc_auth=${TOKEN}` } })
  eq('凭 Cookie 可以打开页面', html.status, 200)
  eq('页面 Content-Type', html.headers.get('content-type'), 'text/html; charset=utf-8')
  const body = await html.text()
  ok('页面引用了样式', body.includes('/app.css'))
  ok('页面引用了脚本', body.includes('/app.js'))

  // 请求头形式也必须能用（便于脚本化调用）。
  const viaHeader = await fetch(`${base}/api/state`, { headers: { 'x-mc-token': TOKEN } })
  eq('凭请求头可以访问接口', viaHeader.status, 200)
  const snapshot = await viaHeader.json()
  eq('返回快照', snapshot.ok, true)
  await stop()
}

group('静态资源与二维码')
{
  const { base, stop } = await startServer()
  const headers = { cookie: `mc_auth=${TOKEN}` }
  const css = await fetch(`${base}/app.css`, { headers })
  eq('样式类型', css.headers.get('content-type'), 'text/css; charset=utf-8')
  ok('样式有内容', (await css.text()).length > 1000)

  const js = await fetch(`${base}/app.js`, { headers })
  eq('脚本类型', js.headers.get('content-type'), 'text/javascript; charset=utf-8')
  const script = await js.text()
  ok('脚本连的是 SSE', script.includes('/api/events'))
  // 动态内容一律用 textContent 构建，不做字符串拼 HTML（会话标题与模型输出都是不可信文本）。
  ok('没有用 innerHTML 拼动态内容', !/\.innerHTML\s*=/.test(script) && !script.includes('insertAdjacentHTML'))

  const qr = await fetch(`${base}/qr.svg`, { headers })
  eq('二维码类型', qr.headers.get('content-type'), 'image/svg+xml; charset=utf-8')
  ok('是 SVG', (await qr.text()).startsWith('<svg'))

  const missing = await fetch(`${base}/nope`, { headers })
  eq('未知路径 404', missing.status, 404)
  await stop()
}

group('写接口：把请求转给桥接')
{
  const { base, bridge, stop } = await startServer()
  const headers = { cookie: `mc_auth=${TOKEN}`, 'content-type': 'application/json' }

  const answer = await fetch(`${base}/api/answer`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'r1', decision: 'allow' }) })
  eq('作答 200', answer.status, 200)
  eq('转给了 answer', bridge.calls.at(-1), { method: 'answer', body: { requestId: 'r1', decision: 'allow' } })

  await fetch(`${base}/api/arm`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 's1', armed: true }) })
  eq('转给了 setArmed', bridge.calls.at(-1), { method: 'arm', id: 's1', armed: true })

  await fetch(`${base}/api/stop`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 's1' }) })
  eq('转给了 stopSession', bridge.calls.at(-1), { method: 'stop', id: 's1' })

  await fetch(`${base}/api/send`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 's1', text: '你好' }) })
  eq('转给了 sendMessage', bridge.calls.at(-1), { method: 'send', body: { sessionId: 's1', text: '你好' } })

  await fetch(`${base}/api/prefs`, { method: 'POST', headers, body: JSON.stringify({ autoArm: true }) })
  eq('转给了 setPrefs', bridge.calls.at(-1), { method: 'prefs', body: { autoArm: true } })

  const bad = await fetch(`${base}/api/answer`, { method: 'POST', headers, body: '{oops' })
  eq('坏 JSON 是 400', bad.status, 400)

  const unknown = await fetch(`${base}/api/nope`, { method: 'POST', headers, body: '{}' })
  eq('未知写接口 404', unknown.status, 404)
  await stop()
}

group('桥接抛错 → 400 且把原因带回手机')
{
  const { base, server, stop } = await startServer()
  server.bridge.answer = () => {
    throw new Error('该请求已失效')
  }
  const response = await fetch(`${base}/api/answer`, {
    method: 'POST',
    headers: { cookie: `mc_auth=${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'gone', decision: 'allow' }),
  })
  eq('状态码 400', response.status, 400)
  eq('原因回传', (await response.json()).error, '该请求已失效')
  await stop()
}

group('SSE：连上就先推一份快照，变更时再推')
{
  const { base, server, stop } = await startServer()
  const controller = new AbortController()
  const response = await fetch(`${base}/api/events`, {
    headers: { cookie: `mc_auth=${TOKEN}` },
    signal: controller.signal,
  })
  eq('SSE 200', response.status, 200)
  eq('SSE Content-Type', response.headers.get('content-type'), 'text/event-stream; charset=utf-8')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const readUntilState = async () => {
    // 服务端先写一个 `retry:` 帧，所以不能假设首个字节就是 state；而且要等整帧
    // （`\n\n` 结尾）到齐再切，否则会拿到半截 JSON。
    for (;;) {
      const start = buffer.indexOf('event: state')
      if (start >= 0) {
        const end = buffer.indexOf('\n\n', start)
        if (end >= 0) {
          const chunk = buffer.slice(start, end)
          buffer = buffer.slice(end + 2)
          return chunk
        }
      }
      const { value, done } = await reader.read()
      if (done) return ''
      buffer += decoder.decode(value, { stream: true })
    }
  }

  const first = await readUntilState()
  ok('首帧是 state 事件', first.startsWith('event: state'))
  const payload = JSON.parse(first.slice(first.indexOf('data: ') + 6))
  eq('首帧内容是快照', payload.ok, true)
  eq('服务端登记了 1 个在线连接', server.clientCount(), 1)

  server.broadcast()
  const second = await readUntilState()
  ok('变更后再次收到快照', second.includes('event: state'))

  controller.abort()
  // 断开是异步的：服务端要先收到 'close' 才会把计数减回去。这里原来写的是固定
  // `sleep(30)`，机器一忙（实测 Gradle 守护进程满载时）就会偶发失败——不是产品 bug，
  // 是断言在赌时延。改成轮询到归零，最多等 2 秒：空闲时立刻通过，忙时也不会误报。
  const deadline = Date.now() + 2000
  while (server.clientCount() !== 0 && Date.now() < deadline) await sleep(20)
  eq('断开后连接数归零', server.clientCount(), 0)
  await stop()
}

group('端口顺延：被占用时自动往后找')
{
  const blocker = createServer(() => {})
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const takenPort = blocker.address().port
  const { server, stop } = await startServer({ port: takenPort })
  // 不能断言"顺延后的端口正好是 takenPort + 1"：那个端口同样可能被别的进程占着，
  // 这种断言只在运气好时成立（实测偶发失败过）。改成断言"确实换了端口，而且真的在
  // 新端口上对外服务"——这既稳定，也比一个数字更强。
  ok('确实换了一个端口', server.port !== takenPort && server.port > 0)
  const response = await fetch(`http://127.0.0.1:${server.port}/api/state`, {
    headers: { 'x-mc-token': TOKEN },
  })
  eq('在新端口上确实能服务', response.status, 200)
  await stop()
  await new Promise((resolve) => blocker.close(resolve))
}

report('传输层')
