// 装配层测试：用真正的 `apply()` 起插件，验证接线、命令与完整拆装。
//
// 这一层最有价值的三个断言：
//   1. 装配后真的能连上（页面/接口/二维码都通）；
//   2. 卸载后端口真的还回去了；
//   3. 再次装配复用**同一个端口** —— 热重载会反复装配/卸载，端口漂移会让已经配对好的
//      手机链接直接失效，这是最容易悄悄坏掉的地方。

import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { eq, ok, group, report, makeTempHome, sleep, FakeCtx } from './harness.mjs'

const HOME = makeTempHome('wiring')
process.env.DSH_HOME = HOME

const DATA_DIR = join(HOME, 'dsh-mobile-console')
mkdirSync(DATA_DIR, { recursive: true })

const { apply } = await import('../src/main.js')

/**
 * 找一个当前空闲的端口。
 *
 * @returns {Promise<number>} 端口号
 */
async function findFreePort() {
  // Windows 上刚 close 的监听端口可能短暂不可重绑，所以拿到端口后再亲测一次能绑上，
  // 否则插件启动时会被迫顺延到下一个端口，测试就会对着一个错的端口做断言。
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const probe = createServer(() => {})
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const port = probe.address().port
    await new Promise((resolve) => probe.close(resolve))
    await sleep(30)
    const verify = createServer(() => {})
    try {
      await new Promise((resolve, reject) => {
        verify.once('error', reject)
        verify.listen(port, '127.0.0.1', resolve)
      })
      await new Promise((resolve) => verify.close(resolve))
      return port
    } catch {
      // 这个端口不可重绑，换一个。
    }
  }
  throw new Error('找不到可用的端口')
}

const PORT = await findFreePort()
writeFileSync(
  join(DATA_DIR, 'config.json'),
  JSON.stringify({ port: PORT, bindHost: '127.0.0.1', relayTimeoutSec: 60, autoArm: false }),
)

/**
 * 从命令输出里抠出端口。
 *
 * @param {string} text 命令输出
 * @returns {number} 端口
 */
function portOf(text) {
  const match = /:(\d{2,5})\//.exec(text)
  return match === null ? 0 : Number(match[1])
}

/**
 * 跑一个命令。
 *
 * @param {FakeCtx} ctx 上下文
 * @param {string} rawInput 原始输入
 * @param {any} agent 触发命令的 agent
 * @returns {Promise<any>} 命令结果
 */
async function run(ctx, rawInput, agent) {
  const definition = ctx.command('mobile')
  if (definition === undefined) throw new Error('命令没有注册')
  return await definition.handler({ agent, rawInput })
}

/**
 * 等到插件报告出一个非零端口。
 *
 * @param {FakeCtx} ctx 上下文
 * @param {any} agent agent
 * @returns {Promise<number>} 端口
 */
async function waitForPort(ctx, agent) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(25)
    const result = await run(ctx, '/mobile url', agent)
    const port = portOf(result?.text ?? '')
    if (port !== 0) return port
  }
  return 0
}

/**
 * 造一对最小的 req / res，用来直接驱动插件注册在宿主 webServer 上的路由处理器。
 *
 * 宿主给的是 Node 的 IncomingMessage / ServerResponse，处理器只用到：`req.method`、
 * `req.url`、`req.headers`、把 req 当异步可迭代读 body，以及 `res.writeHead` / `res.end`。
 * 把这几样凑齐就够真跑一遍处理器逻辑。
 *
 * @param {string} method HTTP 方法
 * @param {string} url 路径
 * @param {{ headers?: Record<string, string>, body?: any }} [options] 选项
 * @returns {{ req: any, res: any, captured: { status: number, body: any } }} 交换对象
 */
function fakeExchange(method, url, options = {}) {
  const headers = { host: '127.0.0.1:19387', ...(options.headers ?? {}) }
  const text = options.body === undefined ? '' : JSON.stringify(options.body)
  const chunks = text === '' ? [] : [Buffer.from(text, 'utf8')]
  const req = {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  const captured = { status: 0, body: '' }
  const res = {
    writeHead(status) {
      captured.status = status
    },
    end(body) {
      captured.body = body ?? ''
    },
  }
  return { req, res, captured }
}

group('装配：接线齐全，服务真的起来了')
const ctx = new FakeCtx()
// 假装宿主有 webServer：这样插件会真的把设置页路由注册上来，测试就能直接驱动它
// （而不是我在测试里另写一份路由逻辑，那样测的是测试自己）。
const desktopRoutes = []
ctx.services.webServer = {
  register: (route) => {
    desktopRoutes.push(route)
    return () => {}
  },
}
const agent = ctx.addAgent({ id: 'session-wiring', session: { id: 'session-wiring', header: { cwd: 'C:\\workspace' } } })
const dispose = apply(ctx)
const port = await waitForPort(ctx, agent)
eq('监听在配置指定的端口上', port, PORT)

group('装配：事件与命令')
{
  for (const event of ['agent/status', 'agent/assistant-stream', 'session/event', 'agent/created', 'agent/disposed', 'approval/request', 'user-questions/request', 'tools/execute']) {
    ok(`注册了 ${event}`, ctx.has(event))
  }
  eq('审批是 prepend（要抢在网页端终结型作答者之前）', ctx.optionsFor('approval/request').prepend, true)
  eq('审批是 global（必须，否则作用域过滤收不到）', ctx.optionsFor('approval/request').global, true)
  eq('提问作答器是 prepend', ctx.optionsFor('user-questions/request').prepend, true)
  eq('提问作答器是 global', ctx.optionsFor('user-questions/request').global, true)
  eq('工具兜底是 global', ctx.optionsFor('tools/execute').global, true)
  eq('工具兜底不 prepen，避免绕过审批链', ctx.optionsFor('tools/execute').prepend, undefined)

  const definition = ctx.command('mobile')
  ok('/mobile 已注册', definition !== undefined)
  ok('带参数提示', typeof definition.input.hint === 'string' && definition.input.hint.includes('on'))
  ok('有描述', typeof definition.description === 'string' && definition.description.length > 5)
}

group('命令：状态 / 武装 / 二维码 / 帮助 / 错参数')
{
  eq('默认未武装', (await run(ctx, '/mobile', agent)).text.includes('未武装'), true)

  const on = await run(ctx, '/mobile on', agent)
  eq('on 是成功结果', on.kind, 'success')
  ok('on 后提示已武装', on.text.includes('已武装'))

  const status = await run(ctx, '/mobile status', agent)
  ok('status 反映武装状态', status.text.includes('已武装（手机接管审批与提问）'))
  ok('status 带余额行（Android 端也会把它放进 Live Updates）', status.text.includes('账户余额：'))

  const url = await run(ctx, '/mobile url', agent)
  eq('url 只输出地址', url.text.trim().startsWith('http://'), true)

  const qr = await run(ctx, '/mobile qr', agent)
  eq('qr 是成功结果', qr.kind, 'success')
  ok('二维码里有方块字符', qr.text.includes('█'))
  ok('二维码由多行组成', qr.text.split('\n').length > 20)

  const help = await run(ctx, '/mobile help', agent)
  ok('帮助列出 on/off', help.text.includes('/mobile on') && help.text.includes('/mobile off'))

  eq('未知参数是 error', (await run(ctx, '/mobile bogus', agent)).kind, 'error')

  const off = await run(ctx, '/mobile off', agent)
  eq('off 是成功结果', off.kind, 'success')
  eq('off 后回到未武装', (await run(ctx, '/mobile status', agent)).text.includes('未武装'), true)
}

group('端到端：真连一次 HTTP，且必须带令牌')
{
  const base = `http://127.0.0.1:${port}`
  eq('无令牌 401', (await fetch(`${base}/api/state`)).status, 401)

  const stateFile = JSON.parse(readFileSync(join(DATA_DIR, 'state.json'), 'utf-8'))
  ok('令牌已经落盘', /^[0-9a-f]{32}$/.test(stateFile.token))

  const authorized = await fetch(`${base}/api/state`, { headers: { 'x-mc-token': stateFile.token } })
  eq('带令牌 200', authorized.status, 200)
  const snapshot = await authorized.json()
  eq('快照可用', snapshot.ok, true)
  eq('会话列表是数组', Array.isArray(snapshot.sessions), true)
  // 快照必须包含配对地址（设置页要靠它复制/展示二维码），所以令牌本来就在里面；
  // 但要固定住"令牌只出现在 ?k= 链接里"——不能有别的字段顺手把它带出去。
  eq('令牌只以配对链接的形式出现', /^[0-9a-f]{32}$/.test(stateFile.token) && JSON.stringify(snapshot).split(stateFile.token).length - 1 === snapshot.server.urls.length, true)
  eq('tokenTail 只是末尾 4 位', snapshot.server.tokenTail, stateFile.token.slice(-4))
  eq('tokenTail 不泄露完整令牌', snapshot.server.tokenTail.length, 4)

  eq('配对链接可用', (await fetch(`${base}/?k=${stateFile.token}`, { redirect: 'manual' })).status, 302)

  const qrSvg = await fetch(`${base}/qr.svg`, { headers: { 'x-mc-token': stateFile.token } })
  eq('真二维码可用', qrSvg.status, 200)
  ok('二维码确实是 SVG', (await qrSvg.text()).includes('<svg'))
}

group('设置页路由：开关、配对地址、二维码、会话接管')
{
  eq('注册了同源路由', desktopRoutes.length, 1)
  eq('前缀正确', desktopRoutes[0].path, '/api/mobile-console')
  eq('按前缀匹配', desktopRoutes[0].kind, 'prefix')
  const handler = desktopRoutes[0].handler

  // --- 读状态 ---
  const status = fakeExchange('GET', '/api/mobile-console/status')
  await handler(status.req, status.res)
  eq('状态 200', status.captured.status, 200)
  const body = JSON.parse(status.captured.body)
  eq('开关是开的', body.enabled, true)
  eq('端口对得上', body.port, PORT)
  ok('给了配对地址', typeof body.url === 'string' && body.url.startsWith('http://'))
  ok('二维码是 data URL（前端直接 <img src>，不用 innerHTML）', body.qr.startsWith('data:image/svg+xml;base64,'))
  ok('地址里有令牌尾部', body.tokenTail.length === 4)
  ok('带余额字段', body.balance !== undefined && typeof body.balance.status === 'string')
  ok('带会话列表', Array.isArray(body.sessions) && body.sessions.length >= 1)

  // --- 信任围栏：前缀比内核的 /api 更长，必须自己挡住跨站与外部主机 ---
  const crossSite = fakeExchange('GET', '/api/mobile-console/status', { headers: { 'sec-fetch-site': 'cross-site' } })
  await handler(crossSite.req, crossSite.res)
  eq('跨站请求被拒', crossSite.captured.status, 403)

  const foreignHost = fakeExchange('GET', '/api/mobile-console/status', { headers: { host: 'evil.example.com' } })
  await handler(foreignHost.req, foreignHost.res)
  eq('非回环 Host 被拒（防 DNS 重绑定）', foreignHost.captured.status, 403)

  const foreignOrigin = fakeExchange('GET', '/api/mobile-console/status', { headers: { origin: 'http://evil.example.com' } })
  await handler(foreignOrigin.req, foreignOrigin.res)
  eq('异源 Origin 被拒', foreignOrigin.captured.status, 403)

  const sameOrigin = fakeExchange('GET', '/api/mobile-console/status', { headers: { origin: 'http://127.0.0.1:19387' } })
  await handler(sameOrigin.req, sameOrigin.res)
  eq('同源 Origin 放行', sameOrigin.captured.status, 200)

  // --- 会话接管开关 ---
  const arm = fakeExchange('POST', '/api/mobile-console/arm', { body: { sessionId: 'session-wiring', armed: true } })
  await handler(arm.req, arm.res)
  eq('接管 200', arm.captured.status, 200)
  eq('武装状态真的写进去了', (await run(ctx, '/mobile status', agent)).text.includes('已武装（手机接管审批与提问）'), true)

  const disarm = fakeExchange('POST', '/api/mobile-console/arm', { body: { sessionId: 'session-wiring', armed: false } })
  await handler(disarm.req, disarm.res)
  eq('取消接管 200', disarm.captured.status, 200)
  eq('取消后回到未武装', (await run(ctx, '/mobile status', agent)).text.includes('未武装'), true)

  // --- 参数校验 ---
  const badArm = fakeExchange('POST', '/api/mobile-console/arm', { body: { armed: true } })
  await handler(badArm.req, badArm.res)
  eq('缺 sessionId → 400', badArm.captured.status, 400)

  const badEnabled = fakeExchange('POST', '/api/mobile-console/enabled', { body: { enabled: 'yes' } })
  await handler(badEnabled.req, badEnabled.res)
  eq('enabled 不是布尔 → 400', badEnabled.captured.status, 400)

  const missing = fakeExchange('GET', '/api/mobile-console/nope')
  await handler(missing.req, missing.res)
  eq('未知接口 404', missing.captured.status, 404)

  // --- 总开关真的会停掉监听 ---
  const shut = fakeExchange('POST', '/api/mobile-console/enabled', { body: { enabled: false } })
  await handler(shut.req, shut.res)
  eq('关闭 200', shut.captured.status, 200)
  eq('关闭后状态里 enabled 是 false', JSON.parse(shut.captured.body).enabled, false)
  eq('关闭后不再给配对地址', JSON.parse(shut.captured.body).url, '')

  let refused = false
  try {
    await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'x-mc-token': 'x' } })
  } catch {
    refused = true
  }
  ok('关闭后端口真的关了（手机连不上）', refused)

  const reopen = fakeExchange('POST', '/api/mobile-console/enabled', { body: { enabled: true } })
  await handler(reopen.req, reopen.res)
  eq('重新开启 200', reopen.captured.status, 200)
  const reopened = JSON.parse(reopen.captured.body)
  eq('重新开启后 enabled 是 true', reopened.enabled, true)
  ok('重新开启后又有配对地址了', reopened.url.startsWith('http://'))
  const after = await fetch(`http://127.0.0.1:${reopened.port}/api/state`, { headers: { 'x-mc-token': 'x' } })
  eq('重新开启后端口真的活了（401 说明它又在服务了）', after.status, 401)
}

group('卸载：端口还回去、监听与命令都撤掉')
{
  const before = ctx.unregistered
  await dispose()
  ok('事件监听被注销', ctx.unregistered > before)
  eq('命令被注销', ctx.command('mobile'), undefined)

  let refused = false
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/state`, { headers: { 'x-mc-token': 'x' } })
  } catch {
    refused = true
  }
  ok('端口已经关闭，连不上了', refused)
}

group('热重载：再次装配复用同一个端口（配对链接不会失效）')
{
  const ctx2 = new FakeCtx()
  const agent2 = ctx2.addAgent({ id: 'session-again', session: { id: 'session-again', header: {} } })
  const dispose2 = apply(ctx2)
  const second = await waitForPort(ctx2, agent2)
  eq('第二次装配拿到了同一个端口', second, PORT)
  const stateFile = JSON.parse(readFileSync(join(DATA_DIR, 'state.json'), 'utf-8'))
  const snapshot = await (await fetch(`http://127.0.0.1:${PORT}/api/state`, { headers: { 'x-mc-token': stateFile.token } })).json()
  eq('复用后仍然可用', snapshot.ok, true)
  await dispose2()
}

report('装配层')
