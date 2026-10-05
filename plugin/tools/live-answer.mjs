// 模拟"一台已经配对的手机"：连上 SSE，看到待办就自动作答。
//
// 用途：在没有第二台设备的情况下，实机验证"审批 / 提问真的会被手机接管并作答"。
//
// 用法：
//   node tools/live-answer.mjs [--port 8799] [--count 1] [--seconds 90]
//                              [--approval allow|deny] [--pick first|last]
//                              [--custom 文本] [--verbose]
//
// 退出码：0 = 至少答完 --count 条；1 = 超时没等到待办（可能是没武装，或没被接管）。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 解析命令行参数。
 *
 * @returns {Record<string, any>} 参数表
 */
function parseArgs() {
  const out = { port: 8799, count: 1, seconds: 90, approval: 'allow', pick: 'last', custom: '', verbose: false }
  const argv = process.argv.slice(2)
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (key === '--verbose') {
      out.verbose = true
      continue
    }
    if (key === '--port') out.port = Number(value)
    else if (key === '--count') out.count = Number(value)
    else if (key === '--seconds') out.seconds = Number(value)
    else if (key === '--approval') out.approval = value
    else if (key === '--pick') out.pick = value
    else if (key === '--custom') out.custom = value
    else continue
    index += 1
  }
  return out
}

const args = parseArgs()
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const state = JSON.parse(readFileSync(join(DSH_HOME, 'dsh-mobile-console', 'state.json'), 'utf-8'))
const token = state.token
const BASE = `http://127.0.0.1:${args.port}`
const headers = { 'x-mc-token': token }

/**
 * 发一个写请求。
 *
 * @param {string} path 路径
 * @param {any} body 请求体
 * @returns {Promise<any>} 响应
 */
async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status} ${text}`)
  return text
}

process.stdout.write(`已在 ${BASE} 上等待待办（最多 ${args.count} 条 / ${args.seconds} 秒）…\n`)

const controller = new AbortController()
const stream = await fetch(`${BASE}/api/events`, { headers: { 'cookie': `mc_auth=${token}` }, signal: controller.signal })
const reader = stream.body.getReader()
const decoder = new TextDecoder()

let buffer = ''
let answered = 0
/** 已经处理过的请求 id，避免同一份快照重复作答。 */
const handled = new Set()
const deadline = Date.now() + args.seconds * 1000

while (answered < args.count && Date.now() < deadline) {
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

    const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
    if (dataLine === undefined) continue
    let snapshot
    try {
      snapshot = JSON.parse(dataLine.slice(6))
    } catch {
      continue
    }
    if (args.verbose) process.stdout.write(`   快照：待办 ${snapshot.pending.length}，会话 ${snapshot.sessions.length}\n`)

    for (const item of snapshot.pending) {
      if (handled.has(item.id)) continue
      handled.add(item.id)
      try {
        if (item.kind === 'approval') {
          await post('/api/answer', { requestId: item.id, decision: args.approval })
          answered += 1
          process.stdout.write(`✅ 已代答审批：${item.toolName} → ${args.approval}\n`)
        } else {
          const answers = item.questions.map((question) => {
            const labels = (question.options ?? []).map((option) => option.label)
            if (labels.length === 0) return { id: question.id, selected: [], custom: args.custom || '手机自动作答' }
            const label = args.pick === 'first' ? labels[0] : labels[labels.length - 1]
            return { id: question.id, selected: [label] }
          })
          await post('/api/answer', { requestId: item.id, answers })
          answered += 1
          process.stdout.write(`✅ 已代答提问：${JSON.stringify(answers)}\n`)
        }
      } catch (error) {
        process.stdout.write(`⚠️ 作答失败（可能已超时/已被别处作答）：${String(error)}\n`)
        handled.delete(item.id)
      }
      if (answered >= args.count) break
    }
  }
}

controller.abort()
if (answered >= args.count) {
  process.stdout.write(`完成：代答 ${answered} 条。\n`)
  process.exitCode = 0
} else {
  process.stdout.write(`超时：只代答了 ${answered} 条（没等到待办——确认会话已武装，且插件已接管）。\n`)
  process.exitCode = 1
}
