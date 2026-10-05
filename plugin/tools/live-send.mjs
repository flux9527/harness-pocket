// 模拟"一台已经配对的手机"发一条消息给某个会话，然后观察它的反应。
//
// 用法：
//   node tools/live-send.mjs --session <sessionId> --text "..." [--port 8799] [--seconds 30]
//
// 观察窗口内会打印：目标会话的状态变化、以及动态流里新出现的内容（含模型回复）。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 解析命令行参数。
 *
 * @returns {Record<string, any>} 参数表
 */
function parseArgs() {
  const out = { port: 8799, seconds: 30, session: '', text: '' }
  const argv = process.argv.slice(2)
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (key === '--port') out.port = Number(value)
    else if (key === '--seconds') out.seconds = Number(value)
    else if (key === '--session') out.session = value
    else if (key === '--text') out.text = value
    else continue
    index += 1
  }
  return out
}

const args = parseArgs()
if (args.session === '' || args.text === '') {
  process.stdout.write('用法：node tools/live-send.mjs --session <sessionId> --text "内容" [--seconds 30]\n')
  process.exit(2)
}

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const token = JSON.parse(readFileSync(join(DSH_HOME, 'dsh-mobile-console', 'state.json'), 'utf-8')).token
const BASE = `http://127.0.0.1:${args.port}`
const headers = { 'x-mc-token': token }

const response = await fetch(`${BASE}/api/send`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: args.session, text: args.text }),
})
process.stdout.write(`发送 → HTTP ${response.status} ${await response.text()}\n`)
if (!response.ok) process.exit(1)

const controller = new AbortController()
const stream = await fetch(`${BASE}/api/events`, { headers: { cookie: `mc_auth=${token}` }, signal: controller.signal })
const reader = stream.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
const seen = new Set()
let lastStatus = ''
const deadline = Date.now() + args.seconds * 1000

process.stdout.write(`观察 ${args.seconds} 秒…\n`)
while (Date.now() < deadline) {
  const { value, done } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  let start = buffer.indexOf('event: state')
  while (start >= 0) {
    const end = buffer.indexOf('\n\n', start)
    if (end < 0) break
    const frame = buffer.slice(start, end)
    buffer = buffer.slice(end + 2)
    start = buffer.indexOf('event: state')
    const line = frame.split('\n').find((item) => item.startsWith('data: '))
    if (line === undefined) continue
    const snapshot = JSON.parse(line.slice(6))
    const session = snapshot.sessions.find((item) => item.id === args.session)
    if (session !== undefined && session.status !== lastStatus) {
      lastStatus = session.status
      process.stdout.write(`   会话状态 → ${session.status}\n`)
    }
    for (const item of snapshot.feed) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      process.stdout.write(`   [${item.kind}] ${item.text.replace(/\s+/g, ' ').slice(0, 200)}\n`)
    }
  }
}
controller.abort()
process.stdout.write('观察结束。\n')
