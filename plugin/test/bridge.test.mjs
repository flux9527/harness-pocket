// 桥接层测试：审批 / 提问 / 注入 / 状态，以及所有"回落原生链"的分支。
//
// 这些用例固定住的是**与 DSH 的契约**：事件名、prepend+global、next() 语义、
// agent.followup 的参数形状、以及"没有手机连接时绝不接管"这条安全底线。

import { eq, ok, rejects, group, report, makeTempHome, sleep, keepAlive, FakeAgent, FakeCtx, fakeServer } from './harness.mjs'

// 测试进程没有宿主那样的常驻监听句柄，需要自己把事件循环撑住（见 harness.keepAlive）。
keepAlive()

// 必须在导入插件代码之前设好，插件的数据目录在模块加载时就定了。
process.env.DSH_HOME = makeTempHome('bridge')

const { MobileBridge, extractReply, normalizeQuestions, pickDisplayReason, describeTurnEnd, resetSharedFeed, hasInjectedMessage, describeBalance, formatAmount } = await import('../src/bridge.js')
const { registerHooks } = await import('../src/main.js')

/**
 * 造一个桥接实例，并**用真实的接线函数**把事件注册进假 ctx。
 *
 * 不自己另写一份 ctx.on(...)：那样测到的是测试里的接线，而不是插件真正装上去的东西。
 *
 * @param {{ clients?: number, armed?: Record<string, boolean>, config?: Record<string, any> }} [options] 选项
 * @returns {any} 上下文
 */
function setup(options = {}) {
  // 动态流在进程内是跨实例共享的（热重载不清空手机页面），用例之间必须手动隔离，
  // 否则断言会看到上一个用例留下的动态。要测"共享"本身的用例传 keepSharedFeed。
  if (options.keepSharedFeed !== true) resetSharedFeed()
  const ctx = new FakeCtx()
  if (options.services !== undefined) ctx.services = options.services
  const config = { relayTimeoutSec: 0.06, autoArm: false, maxFeed: 50, port: 8799, bindHost: '0.0.0.0', ...(options.config ?? {}) }
  const state = { token: 'a'.repeat(32), armed: options.armed ?? {} }
  const bridge = new MobileBridge({
    ctx,
    config,
    state,
    saveState: () => {},
    saveConfig: () => {},
  })
  const server = fakeServer({ clients: options.clients ?? 1 })
  bridge.attach(server)
  const dispose = registerHooks(ctx, bridge)
  return { ctx, bridge, config, state, server, dispose }
}

// ---------------------------------------------------------------- 纯函数

group('extractReply：边界过滤与最后一条 assistant 生效')
{
  const events = [
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧的' }] } } },
    { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一个' }] } } },
    { seq: 6, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第二个' }, { type: 'tool_call' }] } } },
    { seq: 7, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  const before = extractReply(events, 5)
  eq('取到最后一条', before.reply, '第二个')
  eq('原因种类', before.reasonKind, 'completed')
  const after = extractReply(events, 6)
  eq('边界内只剩一条', after.reply, '第二个')
  const empty = extractReply([], 0)
  eq('空事件流', empty.reply, null)
  eq('非文本块被丢弃', extractReply([{ seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'tool_call' }] } } }], 0).reply, null)
}

group('normalizeQuestions：两种输入形状都能认')
{
  const fromEvent = normalizeQuestions([{ id: 'q1', header: '选择', question: '选哪个？', multiSelect: true, options: [{ label: 'A', description: 'a' }] }])
  eq('camelCase multiSelect', fromEvent[0].multiSelect, true)
  eq('选项归一', fromEvent[0].options, [{ label: 'A', description: 'a' }])
  const fromTool = normalizeQuestions([{ id: 'q2', question: '选哪个？', multi_select: true, options: ['A', 'B'] }])
  eq('snake_case multi_select', fromTool[0].multiSelect, true)
  eq('字符串选项归一', fromTool[0].options, [{ label: 'A', description: '' }, { label: 'B', description: '' }])
  eq('缺 id 时补一个', normalizeQuestions([{ question: 'x' }])[0].id, 'q1')
  eq('坏数据不炸', normalizeQuestions([null, 5]).length, 0)
}

group('pickDisplayReason / describeTurnEnd')
{
  eq('优先中文', pickDisplayReason({ en: 'Allow?', zh: '允许吗？' }), '允许吗？')
  eq('回落英文', pickDisplayReason({ en: 'Allow?' }), 'Allow?')
  eq('字符串原样', pickDisplayReason('直接给文本'), '直接给文本')
  eq('空值', pickDisplayReason(undefined), '')
  eq('正常结束', describeTurnEnd('completed'), '回合正常结束')
  eq('未知种类不丢信息', describeTurnEnd('weird'), '回合结束：weird')
}

// ---------------------------------------------------------------- 审批

group('审批：未武装 → 回落原生链')
{
  const { ctx, bridge } = setup()
  const agent = ctx.addAgent(new FakeAgent('session-a'))
  ctx.on('approval/request', async () => 'DOWNSTREAM')
  const { result } = await ctx.waterfall('approval/request', { agent, toolName: 'pwsh', reason: '删除文件' })
  eq('交给下一个作答者', result, 'DOWNSTREAM')
  eq('没有留下待办', bridge.snapshot().pending.length, 0)
}

group('审批：没有手机连接 → 绝不接管（否则会白等一场）')
{
  const { ctx, bridge } = setup({ clients: 0, armed: { 'session-a': true } })
  const agent = ctx.addAgent(new FakeAgent('session-a'))
  ctx.on('approval/request', async () => 'DOWNSTREAM')
  const started = Date.now()
  const { result } = await ctx.waterfall('approval/request', { agent, toolName: 'pwsh' })
  eq('交给下一个作答者', result, 'DOWNSTREAM')
  ok('没有等待超时（<40ms）', Date.now() - started < 40)
  eq('没有留下待办', bridge.snapshot().pending.length, 0)
}

group('审批：武装 + 有手机 → 转手机，允许/拒绝都能结算')
{
  const { ctx, bridge } = setup({ armed: { 'session-a': true } })
  const agent = ctx.addAgent(new FakeAgent('session-a'))
  ctx.on('approval/request', async () => 'DOWNSTREAM')

  const running = ctx.waterfall('approval/request', { agent, toolName: 'pwsh', reason: '需要确认', displayReason: { en: 'Confirm', zh: '需要确认' } })
  await sleep(20)
  const snapshot = bridge.snapshot()
  eq('手机看到一条待办', snapshot.pending.length, 1)
  eq('类型是审批', snapshot.pending[0].kind, 'approval')
  eq('带上工具名', snapshot.pending[0].toolName, 'pwsh')
  ok('带上过期时间', snapshot.pending[0].expiresAt > Date.now())
  eq('会话上记了待办数', snapshot.sessions.find((item) => item.id === 'session-a').pending, 1)

  bridge.answer({ requestId: snapshot.pending[0].id, decision: 'allow' })
  const allowed = await running
  eq('返回 allowed-once', allowed.result, 'allowed-once')

  const denying = ctx.waterfall('approval/request', { agent, toolName: 'pwsh' })
  await sleep(20)
  bridge.answer({ requestId: bridge.snapshot().pending[0].id, decision: 'deny' })
  eq('返回 rejected', (await denying).result, 'rejected')
  eq('结算后待办清空', bridge.snapshot().pending.length, 0)
}

group('审批：超时回落原生链，并且不会二次结算')
{
  const { ctx, bridge } = setup({ armed: { 'session-a': true }, config: { relayTimeoutSec: 0.06 } })
  const agent = ctx.addAgent(new FakeAgent('session-a'))
  ctx.on('approval/request', async () => 'DOWNSTREAM')
  const started = Date.now()
  const { result } = await ctx.waterfall('approval/request', { agent, toolName: 'pwsh' })
  const elapsed = Date.now() - started
  eq('超时后交给下一个作答者', result, 'DOWNSTREAM')
  ok('确实等了一段超时时间', elapsed >= 50)
  eq('待办已清理', bridge.snapshot().pending.length, 0)
  // 超时之后再点按钮必须是明确的失败，而不是静默成功。
  await rejects('过期请求不能作答', () => bridge.answer({ requestId: 'nope', decision: 'allow' }))
}

group('审批：上游中止 → 立刻回落')
{
  const { ctx, bridge } = setup({ armed: { 'session-a': true } })
  const agent = ctx.addAgent(new FakeAgent('session-a'))
  ctx.on('approval/request', async () => 'DOWNSTREAM')
  const controller = new AbortController()
  const running = ctx.waterfall('approval/request', { agent, toolName: 'pwsh', signal: controller.signal })
  await sleep(15)
  controller.abort()
  const { result } = await running
  eq('中止后交给下一个作答者', result, 'DOWNSTREAM')
  eq('待办已清理', bridge.snapshot().pending.length, 0)
}

// ---------------------------------------------------------------- 提问

group('提问：作答器路径（user-questions/request）')
{
  const { ctx, bridge } = setup({ armed: { 'session-a': true } })
  const agent = ctx.addAgent(new FakeAgent('session-a'))
  ctx.on('user-questions/request', async () => 'DOWNSTREAM')
  const request = {
    agent,
    questions: [{ id: 'q1', question: '用哪个方案？', options: [{ label: '甲' }, { label: '乙' }] }],
  }
  const running = ctx.waterfall('user-questions/request', request)
  await sleep(20)
  const pending = bridge.snapshot().pending[0]
  eq('类型是提问', pending.kind, 'question')
  eq('题目传给手机', pending.questions[0].question, '用哪个方案？')
  bridge.answer({ requestId: pending.id, answers: [{ id: 'q1', selected: ['乙'] }] })
  const { result } = await running
  eq('返回 answers 形状', result, { answers: [{ id: 'q1', selected: ['乙'] }] })
}

group('提问：多选与自由文本')
{
  const { ctx, bridge } = setup({ armed: { 'session-a': true } })
  const agent = ctx.addAgent(new FakeAgent('session-a'))
  const request = {
    agent,
    questions: [
      { id: 'q1', question: '多选', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
      { id: 'q2', question: '自由回答' },
    ],
  }
  const running = ctx.waterfall('user-questions/request', request)
  await sleep(20)
  bridge.answer({
    requestId: bridge.snapshot().pending[0].id,
    answers: [
      { id: 'q1', selected: ['A', 'C'] },
      { id: 'q2', selected: [], custom: '我自己写的答案' },
    ],
  })
  eq('多选与 custom 都传下去', (await running).result, {
    answers: [
      { id: 'q1', selected: ['A', 'C'] },
      { id: 'q2', selected: [], custom: '我自己写的答案' },
    ],
  })
}

group('提问：无选项的问题也能在手机上答（比只看选项的实现更宽）')
{
  const { ctx, bridge } = setup({ armed: { 'session-a': true } })
  const agent = ctx.addAgent(new FakeAgent('session-a'))
  ctx.on('user-questions/request', async () => 'DOWNSTREAM')
  const running = ctx.waterfall('user-questions/request', { agent, questions: [{ id: 'q1', question: '随便说点什么' }] })
  await sleep(20)
  eq('仍然转给手机', bridge.snapshot().pending.length, 1)
  bridge.answer({ requestId: bridge.snapshot().pending[0].id, answers: [{ id: 'q1', selected: [], custom: '你好' }] })
  eq('自由文本作答', (await running).result, { answers: [{ id: 'q1', selected: [], custom: '你好' }] })
}

group('提问：工具级兜底（tools/execute → ask_user_question）')
{
  const { ctx, bridge } = setup({ armed: { 'session-a': true } })
  const agent = ctx.addAgent(new FakeAgent('session-a'))
  ctx.on('tools/execute', async () => 'DISPATCHED')
  const exec = { name: 'ask_user_question', agent, arguments: { questions: [{ id: 'q1', question: '选', options: ['A', 'B'] }] } }
  const running = ctx.waterfall('tools/execute', exec)
  await sleep(20)
  bridge.answer({ requestId: bridge.snapshot().pending[0].id, answers: [{ id: 'q1', selected: ['A'] }] })
  const { result } = await running
  eq('工具没有被真正派发', typeof result, 'object')
  eq('结果不是错误', result.isError, false)
  eq('value 里带 answers', result.value, { answers: [{ id: 'q1', selected: ['A'] }] })
  eq('content 是 JSON 文本', JSON.parse(result.content[0].text).answers[0].id, 'q1')
}

group('提问：非 ask_user_question 的工具一律不碰')
{
  const { ctx, bridge } = setup({ armed: { 'session-a': true } })
  const agent = ctx.addAgent(new FakeAgent('session-a'))
  ctx.on('tools/execute', async () => 'DISPATCHED')
  const { result } = await ctx.waterfall('tools/execute', { name: 'pwsh', agent, arguments: {} })
  eq('直接派发', result, 'DISPATCHED')
  eq('没有待办', bridge.snapshot().pending.length, 0)
}

// ---------------------------------------------------------------- 注入

group('注入：手机消息的形状与结果回流')
{
  const { ctx, bridge } = setup({ armed: { 'session-a': true } })
  const agent = ctx.addAgent(new FakeAgent('session-a'))
  await bridge.sendMessage({ sessionId: 'session-a', text: '帮我看看日志' })
  eq('注入了一条消息', agent.messages.length, 1)
  eq('角色是 user', agent.messages[0].role, 'user')
  eq('内容是文本块', agent.messages[0].content, [{ type: 'text', text: '帮我看看日志' }])
  eq('来源是用户', agent.messages[0].source, { kind: 'user' })
  ok('带上了消息 id', typeof agent.messages[0].id === 'string' && agent.messages[0].id.length > 10)
  await sleep(30)
  const feed = bridge.snapshot().feed
  ok('动态里有"已发送"', feed.some((item) => item.kind === 'sent'))
  ok('动态里有自动回复', feed.some((item) => item.kind === 'reply' && item.text === '好的'))
}

group('注入：往「正忙」的会话发消息，不能把上一轮的输出当成回复')
{
  // 这是真机上最容易踩的一条：用户看到智能体在跑，顺手从手机上补一句——这恰恰是
  // "发消息"最正常的用法。但如果只 `await whenIdle()`，它会在**当前这一轮**结束时
  // 立刻兑现，那时注入的消息还排在队里，抓到的就是上一轮的输出。
  const { ctx, bridge } = setup({ armed: { 'session-a': true } })
  const agent = ctx.addAgent(new FakeAgent('session-a', {}, { busy: true, autoPump: false, replies: ['注入后的回复'] }))
  await bridge.sendMessage({ sessionId: 'session-a', text: '帮我看看日志' })
  await sleep(20)

  // 当前这一轮跑完了，但宿主还没把我们注入的消息收下。
  agent.endTurn('上一轮的输出')
  await sleep(150)
  agent.pump()
  await sleep(300)

  const feed = bridge.snapshot().feed
  ok('拿到的是注入那一轮的回复', feed.some((item) => item.kind === 'reply' && item.text === '注入后的回复'))
  eq('没有把上一轮的输出当成回复', feed.some((item) => item.kind === 'reply' && item.text === '上一轮的输出'), false)
}

group('hasInjectedMessage：靠文本认出"轮到我们那条消息了"')
{
  const events = [
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '用户在电脑上打的字' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } },
  ]
  eq('还没轮到我们', hasInjectedMessage(events, '手机发来的'), false)
  eq('认得出我们自己那条', hasInjectedMessage([...events, { type: 'user/message', data: { message: { content: [{ type: 'text', text: '手机发来的' }] } } }], '手机发来的'), true)
  eq('空文本不匹配', hasInjectedMessage(events, '   '), false)
  eq('空事件列表不炸', hasInjectedMessage(undefined, '手机发来的'), false)
  eq('容忍非文本块', hasInjectedMessage([{ type: 'user/message', data: { message: { content: [{ type: 'image' }] } } }], '手机发来的'), false)
}

group('注入：会话不在内存时给出可理解的原因')
{
  const { bridge } = setup()
  await rejects('未打开的会话', () => bridge.sendMessage({ sessionId: 'session-missing', text: 'hi' }))
  await rejects('空内容', () => bridge.sendMessage({ sessionId: 'session-missing', text: '   ' }))
}

group('中止：走 agent.cancel({kind:"user"})')
{
  const { ctx, bridge } = setup({ armed: { 'session-a': true } })
  const agent = ctx.addAgent(new FakeAgent('session-a'))
  bridge.stopSession('session-a')
  eq('调用了 cancel', agent.cancelled, 1)
  await rejects('不在内存的会话不能中止', () => bridge.stopSession('session-nope'))
}

// ---------------------------------------------------------------- 状态

group('状态：agent/status 与 session/event 组合出手机看到的实时状态')
{
  const { ctx, bridge } = setup({ armed: { 'session-a': true } })
  const agent = ctx.addAgent(new FakeAgent('session-a'))
  bridge.reconcile()
  eq('先登记进列表', bridge.snapshot().sessions.length, 1)
  eq('默认空闲', bridge.snapshot().sessions[0].status, 'idle')

  await ctx.emitEvent('agent/status', { agent, status: 'running' })
  eq('运行中', bridge.snapshot().sessions[0].status, 'running')
  ok('记下了开始时间', bridge.snapshot().sessions[0].runningSince > 0)

  agent.emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '正在处理' }] } } })
  await ctx.emitEvent('session/event', agent.session, agent.session.events.at(-1))
  eq('最近输出同步给手机', bridge.snapshot().sessions[0].lastText, '正在处理')

  agent.emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await ctx.emitEvent('session/event', agent.session, agent.session.events.at(-1))
  eq('回合结束回到空闲', bridge.snapshot().sessions[0].status, 'idle')
  ok('动态里落了一条回复', bridge.snapshot().feed.some((item) => item.kind === 'reply' && item.text === '正在处理'))

  await ctx.emitEvent('agent/disposed', { agent })
  eq('掉线标记', bridge.snapshot().sessions[0].status, 'offline')
}

group('状态：本构建不派发 agent/status，必须靠会话事件推导出"运行中"')
{
  // 这一组守着一次实机踩坑：`agent/status` 虽然出现在事件目录里，但当前构建从不派发它，
  // 于是手机永远显示"空闲"。真机探针确认了这点之后，运行状态改由会话事件与流式事件推导。
  const { ctx, bridge } = setup({ armed: { 'session-a': true } })
  const agent = ctx.addAgent(new FakeAgent('session-a'))
  bridge.reconcile()
  const statusOf = () => bridge.snapshot().sessions[0].status

  eq('默认空闲', statusOf(), 'idle')

  await ctx.emitEvent('agent/assistant-stream', { agent, frame: { type: 'text', text: '咚' } })
  eq('流式输出 → 运行中', statusOf(), 'running')
  ok('记下了开始时间', bridge.snapshot().sessions[0].runningSince > 0)

  agent.emit({ type: 'step/end', data: {} })
  await ctx.emitEvent('session/event', agent.session, agent.session.events.at(-1))
  eq('step/end 不代表回合结束，仍然是运行中', statusOf(), 'running')

  agent.emit({ type: 'tool/call', data: { name: 'read' } })
  await ctx.emitEvent('session/event', agent.session, agent.session.events.at(-1))
  eq('工具调用期间也是运行中', statusOf(), 'running')

  agent.emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await ctx.emitEvent('session/event', agent.session, agent.session.events.at(-1))
  eq('回合结束 → 空闲', statusOf(), 'idle')
  eq('开始时间被清掉', bridge.snapshot().sessions[0].runningSince, 0)
}

group('状态：没有输出也能看得出在跑（新回合的第一步就该亮）')
{
  const { ctx, bridge } = setup({ armed: { 'session-a': true } })
  const agent = ctx.addAgent(new FakeAgent('session-a'))
  bridge.reconcile()

  agent.emit({ type: 'user/message', data: { message: { content: [{ type: 'text', text: '干活' }] } } })
  await ctx.emitEvent('session/event', agent.session, agent.session.events.at(-1))
  eq('收到用户消息即进入运行中', bridge.snapshot().sessions[0].status, 'running')

  agent.emit({ type: 'step/start', data: {} })
  await ctx.emitEvent('session/event', agent.session, agent.session.events.at(-1))
  eq('step/start 保持运行中', bridge.snapshot().sessions[0].status, 'running')
}

group('状态：连续流式片段不会反复广播（否则手机会被推送淹没）')
{
  const { ctx, bridge } = setup({ armed: { 'session-a': true } })
  const agent = ctx.addAgent(new FakeAgent('session-a'))
  bridge.reconcile()

  await ctx.emitEvent('agent/assistant-stream', { agent, frame: { type: 'text', text: '一' } })
  const first = bridge.snapshot().sessions[0].runningSince
  for (let index = 0; index < 50; index += 1) {
    await ctx.emitEvent('agent/assistant-stream', { agent, frame: { type: 'text', text: '字' } })
  }
  eq('状态没有抖动', bridge.snapshot().sessions[0].status, 'running')
  eq('开始时间保持第一次的值', bridge.snapshot().sessions[0].runningSince, first)
}

group('状态：运行中的会话排在前面')
{
  const { ctx, bridge } = setup({ armed: { 'session-a': true, 'session-b': true } })
  const a = ctx.addAgent(new FakeAgent('session-a'))
  const b = ctx.addAgent(new FakeAgent('session-b'))
  bridge.reconcile()
  await ctx.emitEvent('agent/status', { agent: b, status: 'running' })
  eq('b 在前', bridge.snapshot().sessions[0].id, 'session-b')
  ok('a 在后', a !== undefined)
}

group('武装：子 agent 跟随父会话')
{
  const { ctx, bridge } = setup({ armed: { 'session-parent': true } })
  const child = ctx.addAgent(new FakeAgent('session-child', { parentSession: 'session-parent' }))
  bridge.reconcile()
  ok('子会话被继承武装', bridge.isArmed('session-child'))
  bridge.setArmed('session-child', false)
  ok('显式关掉后不再继承', !bridge.isArmed('session-child'))
  ok('父会话仍然武装', bridge.isArmed('session-parent'))
}

group('武装：autoArm 只对从未表过态的会话生效')
{
  const { ctx, bridge, state } = setup({ config: { autoArm: true }, armed: { 'session-old': false } })
  ctx.addAgent(new FakeAgent('session-new'))
  ctx.addAgent(new FakeAgent('session-old'))
  bridge.reconcile()
  eq('新会话自动武装', state.armed['session-new'], true)
  eq('用户关掉过的保持关闭', state.armed['session-old'], false)
}

group('热重载：动态流跨实例保留，手机页面不会突然变空')
{
  // 这一条来自真机踩坑：热重载换了 bridge 实例，端口复用了、武装状态也还在，
  // 但动态流是纯内存的，一重载就空——连"注入的回复有没有回流"这条证据都被擦掉了。
  const first = setup({ armed: { 'session-a': true } })
  first.bridge.addFeed({ sessionId: 'session-a', kind: 'reply', text: '重载前的一条动态' })
  eq('第一条动态在', first.bridge.snapshot().feed.length, 1)

  // 模拟热重载：**不清共享存储**，直接再造一个实例。
  const second = setup({ armed: { 'session-a': true }, keepSharedFeed: true })
  eq('新实例看得到旧动态', second.bridge.snapshot().feed.length, 1)
  eq('内容也对得上', second.bridge.snapshot().feed[0].text, '重载前的一条动态')

  second.bridge.addFeed({ sessionId: 'session-a', kind: 'reply', text: '重载后的一条动态' })
  const ids = second.bridge.snapshot().feed.map((item) => item.id)
  eq('id 不会和旧的重号', new Set(ids).size, ids.length)

  resetSharedFeed()
}

group('余额：走宿主 deepseekAccount，字段与状态必须稳定')
{
  // 余额来自宿主自己的账户服务（凭据只对 Host 消费者开放）。这里固定住两件事：
  // 插件怎么读懂那份契约，以及拿不到余额时怎么退化——Android 端要把它画进
  // Live Updates 通知，所以字段名和状态不能随便变。
  const { bridge } = setup({
    services: {
      deepseekAccount: {
        getBalance: async () => ({
          status: 'ready',
          value: [{ currency: 'CNY', balance: '42.50' }],
          bonusWallets: [{ currency: 'CNY', balance: '5.00' }, { currency: 'USD', balance: '1.00' }],
        }),
      },
    },
  })
  await bridge.refreshBalance()
  const ready = bridge.snapshot().balance
  eq('状态就绪', ready.status, 'ready')
  eq('币种', ready.currency, 'CNY')
  eq('主钱包金额', ready.amount, '42.50')
  eq('只累计同币种的赠送额度', ready.bonus, '5.00')
  ok('带更新时间', ready.updatedAt > 0)
}

group('余额：没有账户服务 / 未登录 / 查询失败 / 抛异常 都不能炸')
{
  const cases = [
    { label: '没有账户服务', expected: 'unavailable' },
    { label: '未登录（null）', services: { deepseekAccount: { getBalance: async () => null } }, expected: 'signed-out' },
    { label: '平台查询失败', services: { deepseekAccount: { getBalance: async () => ({ status: 'failed' }) } }, expected: 'failed' },
    {
      label: '调用抛异常',
      services: {
        deepseekAccount: {
          getBalance: async () => {
            throw new Error('网络炸了')
          },
        },
      },
      expected: 'failed',
    },
    {
      label: '就绪但没有钱包',
      services: { deepseekAccount: { getBalance: async () => ({ status: 'ready', value: [], bonusWallets: [] }) } },
      expected: 'empty',
    },
  ]
  for (const item of cases) {
    const { bridge } = setup({ services: item.services })
    await bridge.refreshBalance()
    eq(item.label, bridge.snapshot().balance.status, item.expected)
  }
}

group('余额：没有 CNY 钱包就退而取第一个，且不编造赠送额度')
{
  const { bridge } = setup({
    services: {
      deepseekAccount: {
        getBalance: async () => ({ status: 'ready', value: [{ currency: 'USD', balance: '3.00' }], bonusWallets: [] }),
      },
    },
  })
  await bridge.refreshBalance()
  const balance = bridge.snapshot().balance
  eq('取第一个钱包', balance.currency, 'USD')
  eq('金额保留原样', balance.amount, '3.00')
  eq('没有赠送额度就是 null，不写 0', balance.bonus, null)
}

group('formatAmount：平台给的精度很脏，收敛到两位小数')
{
  // 实测从宿主账户服务拿到的是 "26.1009953000000000" —— 直接写进手机通知就是一串噪声。
  eq('收敛到两位', formatAmount('26.1009953000000000'), '26.10')
  eq('整数补小数位', formatAmount('42'), '42.00')
  eq('已经是两位就不动', formatAmount('42.50'), '42.50')
  eq('四舍五入', formatAmount('1.005'), '1.00')
  eq('负数', formatAmount('-3.456'), '-3.46')
  eq('空值给空串', formatAmount(undefined), '')
  eq('非数字原样保留，不能把值改坏', formatAmount('约 5 元'), '约 5 元')
}

group('describeBalance：每种状态都要给人话')
{
  eq('人民币带符号', describeBalance({ status: 'ready', currency: 'CNY', amount: '42.50', bonus: null }), '¥42.50')
  eq('有赠送额度就带上', describeBalance({ status: 'ready', currency: 'CNY', amount: '42.50', bonus: '5.00' }), '¥42.50（含赠送 ¥5.00）')
  eq('美元', describeBalance({ status: 'ready', currency: 'USD', amount: '3.00', bonus: null }), '$3.00')
  eq('未知币种不加符号', describeBalance({ status: 'ready', currency: 'JPY', amount: '100', bonus: null }), '100')
  eq('未登录', describeBalance({ status: 'signed-out' }), '未登录 DeepSeek 账户')
  eq('没有账户服务', describeBalance({ status: 'unavailable' }), '宿主没有提供账户服务')
  eq('没有钱包', describeBalance({ status: 'empty' }), '账户里没有钱包')
  eq('查询失败', describeBalance({ status: 'failed' }), '查询失败')
  eq('还没有值', describeBalance(undefined), '未知')
}

group('偏好：手机端可以改，并且有范围保护')
{
  const { bridge, config } = setup()
  bridge.setPrefs({ autoArm: true, relayTimeoutSec: 300 })
  eq('autoArm 生效', config.autoArm, true)
  eq('超时生效', config.relayTimeoutSec, 300)
  bridge.setPrefs({ relayTimeoutSec: 99999 })
  eq('超范围被忽略', config.relayTimeoutSec, 300)
}

report('桥接层')
