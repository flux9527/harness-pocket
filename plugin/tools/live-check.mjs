// 实机自检：对**正在运行的** DSH 里的插件实例做一次体检。
//
// 用法：
//   node tools/live-check.mjs [端口]
//
// 读的是 `$DSH_HOME/dsh-mobile-console/state.json` 里的令牌——也就是真实配对用的令牌，
// 所以这个脚本等价于"一台已经配对的手机"。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DATA_DIR = join(DSH_HOME, 'dsh-mobile-console')
const PORT = Number(process.argv[2] ?? 8799)
const BASE = `http://127.0.0.1:${PORT}`

let failed = 0
const check = (label, condition, extra = '') => {
  process.stdout.write(`${condition ? '✅' : '❌'} ${label}${extra === '' ? '' : ` — ${extra}`}\n`)
  if (!condition) failed += 1
}

/** @type {string} */
let token
try {
  token = JSON.parse(readFileSync(join(DATA_DIR, 'state.json'), 'utf-8')).token
} catch (error) {
  process.stdout.write(`❌ 读不到状态文件 ${join(DATA_DIR, 'state.json')}：${String(error)}\n`)
  process.exit(1)
}

const headers = { 'x-mc-token': token }

// 1. 未鉴权必须被拒绝
const unauthorized = await fetch(`${BASE}/api/state`)
check('未带令牌被拒绝（401）', unauthorized.status === 401, `HTTP ${unauthorized.status}`)

// 2. 带令牌拿快照
const stateResponse = await fetch(`${BASE}/api/state`, { headers })
check('带令牌可以取快照', stateResponse.status === 200, `HTTP ${stateResponse.status}`)
const snapshot = await stateResponse.json()
check('快照结构正常', snapshot.ok === true && Array.isArray(snapshot.sessions))
process.stdout.write(`   端口=${snapshot.server.port} 在线手机=${snapshot.server.clients} 会话=${snapshot.sessions.length} 待办=${snapshot.pending.length}\n`)
for (const session of snapshot.sessions) {
  const badge = session.status === 'running' ? '🟢运行中' : session.status === 'idle' ? '⚪空闲' : '🔴离线'
  process.stdout.write(`   - ${badge} ${session.armed ? '已武装' : '未武装'} ${session.id} （${session.title}）\n`)
}

// 3. 页面与资源
const page = await fetch(`${BASE}/?k=${token}`, { redirect: 'manual' })
check('配对链接可用（302 → 种 Cookie）', page.status === 302, `HTTP ${page.status}`)
const cookie = `mc_auth=${token}`
const html = await fetch(`${BASE}/`, { headers: { cookie } })
const body = await html.text()
check('页面可打开', html.status === 200)
check('页面含样式与脚本', body.includes('/app.css') && body.includes('/app.js'))
for (const asset of ['/app.css', '/app.js']) {
  const response = await fetch(`${BASE}${asset}`, { headers: { cookie } })
  check(`资源 ${asset} 可取`, response.status === 200, `${response.headers.get('content-type')}`)
}

// 4. 二维码
const qr = await fetch(`${BASE}/qr.svg`, { headers })
const svg = await qr.text()
check('二维码是 SVG', qr.status === 200 && svg.startsWith('<svg'))
check('二维码有实际模块', (svg.match(/<rect/g) ?? []).length > 100, `${(svg.match(/<rect/g) ?? []).length} 个模块`)

// 5. SSE 能连上（连上即收到一份快照）
const controller = new AbortController()
const stream = await fetch(`${BASE}/api/events`, { headers: { cookie }, signal: controller.signal })
check('SSE 可以连接', stream.status === 200)
const reader = stream.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
const deadline = Date.now() + 3000
while (!buffer.includes('event: state') && Date.now() < deadline) {
  const { value, done } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
}
check('SSE 首帧是状态快照', buffer.includes('event: state'))
controller.abort()

process.stdout.write(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}\n`)
process.exitCode = failed === 0 ? 0 : 1
