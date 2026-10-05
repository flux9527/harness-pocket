// 核心业务：把 DSH 的审批 / 提问 / 会话状态桥接到手机控制台。
//
// 三条瀑布 + 一路事件流：
//   approval/request        → 手机允许 / 拒绝（超时回落原生链）
//   user-questions/request  → 手机作答（走"作答器"这一正规路径）
//   tools/execute           → ask_user_question 的工具级兜底（见 handleToolExecute 注释）
//   agent/status, session/event → 手机上的实时状态与动态
//
// 版本透传：外壳用 `?v=` 重新加载实现时，整张模块图都要重新求值（见 boot.js）。

const VERSION = new URL(import.meta.url).search

const { randomUUID } = await import('node:crypto')
const { describeError, log } = await import(`./log.js${VERSION}`)
const { qrSvg: encodeQrSvg } = await import(`./qr.js${VERSION}`)

/** 动态里最多保留的条数默认值（配置里可覆盖）。 */
const DEFAULT_MAX_FEED = 100

/** 单条动态正文的最大长度：手机上看不下更长的内容，超长只影响这一条。 */
const FEED_TEXT_LIMIT = 4000

/** 会话表重建（发现新会话 / 掉线会话）的间隔。 */
const RECONCILE_MS = 5000

/** 余额刷新间隔：余额变得很慢，5 分钟足够，也免得频繁去敲宿主的账户服务。 */
const BALANCE_REFRESH_MS = 5 * 60 * 1000

/** 手机没连上时，绝不接管审批 / 提问以免把回合卡住。 */
const MIN_CLIENTS_TO_INTERCEPT = 1

/**
 * 说明「这个会话事件属于一个正在进行的回合」的判定。
 *
 * 实机观测到的会话事件类型：`step/start`、`step/end`、`tool/call`、`tool/result`、
 * `assistant/message`、`user/message`、`turn/end`。除 `turn/end` 之外都还在回合内。
 * 用前缀而不是白名单，是为了新事件类型出现时不会悄悄丢掉"运行中"状态。
 */
export const IN_TURN_EVENT = /^(step|tool|assistant|user|turn)\//

/**
 * 动态流的**进程内共享**存储。
 *
 * 热重载会换掉整个 bridge 实例：端口能复用，武装状态落在 state.json 里，可动态流原本
 * 是纯内存的，一重载手机页面就空了——而且上一轮发生过一次，直接把"注入消息的回复有没有
 * 回流"这条证据擦掉了。所以把这一小段状态挂到 globalThis 上让新实例接着用。
 *
 * 跨进程天然隔离（每个 DSH 进程有自己的 globalThis），也不会落盘，重启即清空。
 * 用 `Symbol.for` 是为了让重新 import 出来的模块拿到同一个键。
 */
const FEED_KEY = Symbol.for('dsh-mobile-console.feed')

/**
 * 取共享的动态流存储。
 *
 * @returns {{items: any[], seq: number}} 共享存储
 */
function sharedFeedStore() {
  const holder = /** @type {Record<symbol, any>} */ (/** @type {unknown} */ (globalThis))
  if (holder[FEED_KEY] === undefined) holder[FEED_KEY] = { items: [], seq: 0 }
  return holder[FEED_KEY]
}

/** 清空共享的动态流。测试用：避免同一个进程里的用例互相看到对方的动态。 */
export function resetSharedFeed() {
  const holder = /** @type {Record<symbol, any>} */ (/** @type {unknown} */ (globalThis))
  delete holder[FEED_KEY]
}

/** 注入后等待「我们那条消息真的开始跑」的兜底上限。 */
const INJECT_DEADLINE_MS = 5 * 60 * 1000

/** 注入重试之间的间隔：只在"宿主还没收下消息"时才会用到。 */
const INJECT_RETRY_MS = 50

/**
 * 简单的延时。
 *
 * @param {number} ms 毫秒
 * @returns {Promise<void>} 完成
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 这一批会话事件里，有没有出现我们刚注入的那条用户消息。
 *
 * 用它来判断"这一轮是不是轮到我们了"——比对文本而不是只数事件条数，是因为会话里
 * 本来就可能有多条 user/message（用户自己在电脑上也在打字）。
 *
 * @param {readonly any[]} events 会话事件
 * @param {string} text 注入的文本
 * @returns {boolean} 是否已经出现
 */
export function hasInjectedMessage(events, text) {
  const needle = String(text ?? '').trim()
  if (needle === '') return false
  return (events ?? []).some(
    (event) => event?.type === 'user/message' && textOfContent(event.data?.message?.content).includes(needle),
  )
}

/**
 * 从会话事件里提取一次提问 / 注入之后的回复。
 *
 * 只看 `seq >= boundarySeq` 的事件，避免把注入之前的旧回复当成本次结果。
 * 事件形状来自 DSH 的真实会话日志（`assistant/message` 与 `turn/end`）。
 *
 * @param {readonly any[]} events 会话事件
 * @param {number} boundarySeq 注入前的 seq
 * @returns {{ reply: string | null, reasonKind: string | null }} 提取结果
 */
export function extractReply(events, boundarySeq) {
  let reply = null
  let reasonKind = null
  for (const event of events ?? []) {
    if (typeof event?.seq === 'number' && event.seq < boundarySeq) continue
    if (event.type === 'turn/end') {
      reasonKind = event.data?.reason?.kind ?? null
      continue
    }
    if (event.type === 'assistant/message') {
      const text = (event.data?.message?.content ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
      if (text !== '') reply = text
    }
  }
  return { reply, reasonKind }
}

/**
 * 从内容块数组里拼出纯文本。
 *
 * @param {readonly any[]} content 内容块
 * @returns {string} 文本
 */
export function textOfContent(content) {
  return (content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/**
 * 规整钱包金额。
 *
 * 平台返回的字符串精度很长（实测见过 "26.1009953000000000"），直接显示到手机通知上
 * 会是一串噪声。这里统一收敛到两位小数；不是数字就原样保留，绝不把值改坏。
 *
 * @param {any} value 原始金额
 * @returns {string} 两位小数的金额
 */
export function formatAmount(value) {
  const text = String(value ?? '').trim()
  if (text === '') return ''
  const number = Number(text)
  if (!Number.isFinite(number)) return text
  return number.toFixed(2)
}

/**
 * 把余额快照翻译成手机上能直接看的一句话。
 *
 * 每种失败状态都给一句人话，而不是显示空白——「为什么没有余额」比「没有余额」有用。
 *
 * @param {any} balance 余额快照
 * @returns {string} 描述
 */
export function describeBalance(balance) {
  if (balance === undefined || balance === null) return '未知'
  switch (balance.status) {
    case 'ready': {
      const symbol = balance.currency === 'CNY' ? '¥' : balance.currency === 'USD' ? '$' : ''
      const amount = `${symbol}${balance.amount}`
      if (balance.bonus === null || balance.bonus === undefined) return amount
      return `${amount}（含赠送 ${symbol}${balance.bonus}）`
    }
    case 'signed-out':
      return '未登录 DeepSeek 账户'
    case 'unavailable':
      return '宿主没有提供账户服务'
    case 'empty':
      return '账户里没有钱包'
    case 'unknown':
      return '还没查到'
    default:
      return '查询失败'
  }
}

/**
 * 把任意原因种类映射成一句人话。
 *
 * @param {string | null} kind 原因种类
 * @returns {string} 描述
 */
export function describeTurnEnd(kind) {
  switch (kind) {
    case 'completed':
      return '回合正常结束'
    case 'error':
      return '回合因错误结束'
    case 'max-tokens':
      return '达到输出上限'
    case 'blocked':
      return '被策略拦截'
    case 'interrupted':
      return '回合中断'
    case 'aborted':
      return '回合被中止'
    default:
      return kind === null ? '回合结束' : `回合结束：${kind}`
  }
}

/**
 * 把多语言的理由挑成一条字符串。
 *
 * @param {any} reason 审批请求上的 displayReason
 * @returns {string} 展示文本
 */
export function pickDisplayReason(reason) {
  if (reason === null || reason === undefined) return ''
  if (typeof reason === 'string') return reason
  if (typeof reason !== 'object') return String(reason)
  for (const key of ['zh', 'zh-CN', 'zh-Hans', 'en']) {
    if (typeof reason[key] === 'string' && reason[key] !== '') return reason[key]
  }
  for (const value of Object.values(reason)) {
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/**
 * 把两种提问输入（`user-questions/request` 与 `ask_user_question` 的 tool 参数）
 * 归一成前端认识的形状。
 *
 * @param {readonly any[]} raw 原始提问
 * @returns {any[]} 归一后的提问
 */
export function normalizeQuestions(raw) {
  const out = []
  for (const question of raw ?? []) {
    if (question === null || typeof question !== 'object') continue
    const options = []
    for (const option of question.options ?? []) {
      if (option !== null && typeof option === 'object' && typeof option.label === 'string') {
        options.push({ label: option.label, description: typeof option.description === 'string' ? option.description : '' })
      } else if (typeof option === 'string') {
        options.push({ label: option, description: '' })
      }
    }
    out.push({
      id: typeof question.id === 'string' && question.id !== '' ? question.id : `q${out.length + 1}`,
      header: typeof question.header === 'string' ? question.header : '',
      question: typeof question.question === 'string' ? question.question : '',
      detail: typeof question.detail === 'string' ? question.detail : '',
      multiSelect: question.multiSelect === true || question.multi_select === true,
      options,
    })
  }
  return out
}

/**
 * 手机控制台桥接。
 */
export class MobileBridge {
  /**
   * @param {{ ctx: any, config: Record<string, any>, state: any, saveState: () => void, saveConfig: () => void }} options 依赖
   */
  constructor({ ctx, config, state, saveState, saveConfig }) {
    this.ctx = ctx
    this.config = config
    this.state = state
    this.saveState = saveState
    this.saveConfig = saveConfig
    /** @type {any} MobileServer，由 main.js 注入。 */
    this.server = null

    /** 内存里的会话表：`id -> info`。 */
    this.sessions = new Map()
    /** 待手机作答的请求：`requestId -> {id, kind, item, resolve, timer, signal, onAbort}`。 */
    this.pending = new Map()
    /** 动态流：与热重载前的实例共享同一份，手机页面不会因为重载而清空。 */
    this.feedStore = sharedFeedStore()
    this.feed = this.feedStore.items
    /** 每次变更的自增号，用于判断是否需要广播。 */
    this.revision = 0
    this.reconcileTimer = null
    /** 账户余额快照，随每次快照推给手机（Android 端会把它放进 Live Updates 通知）。 */
    this.balance = { status: 'unknown', updatedAt: 0 }
    this.balanceTimer = null
    this.feedSeq = this.feedStore.seq
  }

  /**
   * 注入传输层。
   *
   * @param {any} server MobileServer
   */
  attach(server) {
    this.server = server
  }

  /** 启动周期性会话表核对与余额刷新。 */
  start() {
    this.reconcile()
    this.reconcileTimer = setInterval(() => this.reconcile(), RECONCILE_MS)
    this.reconcileTimer.unref?.()
    void this.refreshBalance()
    this.balanceTimer = setInterval(() => void this.refreshBalance(), BALANCE_REFRESH_MS)
    this.balanceTimer.unref?.()
  }

  /** 停止后台工作并让所有等待中的请求回落。 */
  stop() {
    if (this.reconcileTimer !== null) {
      clearInterval(this.reconcileTimer)
      this.reconcileTimer = null
    }
    if (this.balanceTimer !== null) {
      clearInterval(this.balanceTimer)
      this.balanceTimer = null
    }
    this.settlePending()
  }

  /**
   * 让所有等待手机作答的请求立刻回落给原生链路。
   *
   * 关掉手机控制台时用它：正在等的审批 / 提问必须马上放回电脑上的原生弹窗，
   * 而不是让用户干等到 120 秒超时。注意它**不动**会话表刷新——桌面设置页还要看状态。
   */
  settlePending() {
    for (const id of [...this.pending.keys()]) this.settle(id, null)
  }

  // ------------------------------------------------------------ 会话与状态

  /**
   * 取 `agents` 服务。
   *
   * @returns {any | undefined} 服务
   */
  agents() {
    return this.ctx.get('agents')
  }

  /**
   * 取宿主的账户服务。
   *
   * 用 `ctx.get` 而不是 inject：没登录 DeepSeek 账户时这个服务可能不存在，
   * 插件不该因为余额拿不到就装不上。
   *
   * @returns {any | undefined} 服务
   */
  account() {
    try {
      return this.ctx.get('deepseekAccount')
    } catch {
      return undefined
    }
  }

  /**
   * 刷新账户余额。
   *
   * 走宿主自己的 `deepseekAccount.getBalance()`——插件就跑在宿主进程里，这是唯一
   * 正规的取余额通道（凭据只对 Host 消费者开放），比自己拼第三方 API 可靠得多。
   *
   * 结果里只保留手机端要显示的字段：主钱包金额 + 赠送额度 + 币种。
   */
  async refreshBalance() {
    const account = this.account()
    if (account === undefined || typeof account.getBalance !== 'function') {
      this.balance = { status: 'unavailable', updatedAt: Date.now() }
      return
    }
    try {
      const result = await account.getBalance({
        version: '0.1.0',
        locale: 'zh-CN',
        // 契约要的是「本地相对 UTC 的偏移秒数」，和 Date 的 getTimezoneOffset 符号相反。
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      })
      if (result === null) {
        this.balance = { status: 'signed-out', updatedAt: Date.now() }
      } else if (result.status !== 'ready') {
        this.balance = { status: 'failed', updatedAt: Date.now() }
      } else {
        const wallets = result.value ?? []
        const bonuses = result.bonusWallets ?? []
        const main = wallets.find((wallet) => wallet?.currency === 'CNY') ?? wallets[0]
        if (main === undefined) {
          this.balance = { status: 'empty', updatedAt: Date.now() }
        } else {
          const bonus = bonuses
            .filter((wallet) => wallet?.currency === main.currency)
            .reduce((sum, wallet) => sum + (Number(wallet.balance) || 0), 0)
          this.balance = {
            status: 'ready',
            currency: main.currency,
            amount: formatAmount(main.balance),
            bonus: bonus > 0 ? bonus.toFixed(2) : null,
            updatedAt: Date.now(),
          }
        }
      }
    } catch (error) {
      log(`balance: 取余额失败 ${describeError(error)}`)
      this.balance = { status: 'failed', updatedAt: Date.now() }
    }
    this.touch()
  }

  /**
   * 取一个活着的 agent。
   *
   * @param {string} sessionId 会话 id
   * @returns {any | undefined} agent
   */
  agentFor(sessionId) {
    const agent = this.agents()?.get?.(sessionId)
    return agent ?? undefined
  }

  /**
   * 会话的展示标题。
   *
   * @param {string} sessionId 会话 id
   * @returns {string} 标题
   */
  labelFor(sessionId) {
    const info = this.sessions.get(sessionId)
    if (info !== undefined && info.title !== '') return info.title
    return String(sessionId ?? '').replace(/^session-/, '').slice(0, 12) || '未知会话'
  }

  /**
   * 得到一个会话的展示信息，必要时创建。
   *
   * @param {string} sessionId 会话 id
   * @param {any} [session] 真实会话对象（可选，用来补齐标题与工作目录）
   * @returns {any} 会话信息
   */
  ensureSession(sessionId, session) {
    let info = this.sessions.get(sessionId)
    if (info === undefined) {
      info = {
        id: sessionId,
        title: '',
        cwd: '',
        status: 'idle',
        runningSince: 0,
        lastActivityAt: 0,
        lastText: '',
        parentSession: '',
      }
      this.sessions.set(sessionId, info)
    }
    const header = session?.header
    if (header !== undefined && header !== null) {
      if (typeof header.cwd === 'string' && header.cwd !== '') info.cwd = header.cwd
      if (typeof header.parentSession === 'string' && header.parentSession !== '') info.parentSession = header.parentSession
      for (const key of ['title', 'name', 'summary']) {
        if (info.title === '' && typeof header[key] === 'string' && header[key] !== '') info.title = header[key]
      }
    }
    if (info.title === '' && info.cwd !== '') {
      const parts = info.cwd.split(/[\\/]/).filter((part) => part !== '')
      info.title = parts[parts.length - 1] ?? ''
    }
    return info
  }

  /**
   * 周期核对：把 `agents.list()` 里活着的会话纳入表，把掉线的标记出来。
   */
  reconcile() {
    let changed = false
    const seen = new Set()
    for (const agent of this.agents()?.list?.() ?? []) {
      if (agent === null || typeof agent?.id !== 'string') continue
      seen.add(agent.id)
      const info = this.ensureSession(agent.id, agent.session)
      if (info.status === 'offline') {
        info.status = 'idle'
        changed = true
      }
      // 自动武装只对"从未表过态"的会话生效：用户手动关掉过的不会被再次打开。
      if (this.config.autoArm === true && this.state.armed?.[agent.id] === undefined) {
        this.state.armed[agent.id] = true
        this.saveState()
        log(`arm: 自动武装新会话 ${agent.id}`)
        changed = true
      }
    }
    for (const info of this.sessions.values()) {
      if (!seen.has(info.id) && info.status !== 'offline') {
        info.status = 'offline'
        info.runningSince = 0
        changed = true
      }
    }
    if (changed) this.touch()
  }

  /**
   * 标记一个会话已经不在内存里。
   *
   * @param {string} sessionId 会话 id
   */
  markOffline(sessionId) {
    const info = this.sessions.get(sessionId)
    if (info === undefined) return
    if (info.status === 'offline') return
    info.status = 'offline'
    info.runningSince = 0
    this.touch()
  }

  /**
   * 处理 `agent/status`：这是运行时给出的权威运行状态。
   *
   * @param {{agent: any, status: string}} payload 事件负载
   */
  onAgentStatus(payload) {
    const id = payload?.agent?.id
    if (typeof id !== 'string') return
    const info = this.ensureSession(id, payload.agent.session)
    const status = payload.status === 'running' ? 'running' : 'idle'
    if (info.status === status) return
    info.status = status
    info.runningSince = status === 'running' ? Date.now() : 0
    log(`status: ${id} -> ${status}`)
    this.touch()
  }

  /**
   * 处理 `agent/assistant-stream`：进程内最灵敏的"正在输出"信号。
   *
   * 这个事件每个片段都会触发，所以只在状态**真的发生变化**时才广播，
   * 否则手机会被每秒几十次的推送淹没。
   *
   * @param {{agent: any, frame: any}} payload 事件负载
   */
  onAssistantStream(payload) {
    const id = payload?.agent?.id
    if (typeof id !== 'string') return
    const info = this.ensureSession(id, payload.agent.session)
    info.lastActivityAt = Date.now()
    if (info.status === 'running') return
    info.status = 'running'
    info.runningSince = Date.now()
    log(`status: ${id} -> running（流式输出）`)
    this.touch()
  }

  /**
   * 处理 `session/event`：累积最近输出、记录动态、维护运行状态。
   *
   * 运行状态主要靠这里推导：`step/*`、`tool/*`、`assistant/*`、`user/*` 都意味着
   * 一个回合正在进行，`turn/end` 才代表结束。**不能**用 `step/end`——一个回合里
   * 可以有多个步骤。
   *
   * @param {any} session 会话
   * @param {any} event 事件
   */
  onSessionEvent(session, event) {
    const id = typeof session?.id === 'string' ? session.id : undefined
    if (id === undefined) return
    const info = this.ensureSession(id, session)
    info.lastActivityAt = Date.now()
    const type = event?.type

    if (type === 'assistant/message') {
      const text = textOfContent(event.data?.message?.content)
      if (text !== '') info.lastText = text
      this.markRunning(id)
    } else if (type === 'turn/end') {
      const kind = event.data?.reason?.kind ?? null
      const text = info.lastText
      if (text !== '') {
        this.addFeed({ sessionId: id, kind: 'reply', text })
      } else if (kind !== null && kind !== 'completed') {
        this.addFeed({ sessionId: id, kind: 'error', text: describeTurnEnd(kind) })
      }
      info.lastText = ''
      this.markIdle(id)
    } else if (typeof type === 'string' && IN_TURN_EVENT.test(type)) {
      // 回合已经开始（但还没结束）——即使这一轮什么都不输出，手机也该看到"运行中"。
      this.markRunning(id)
    }
    this.touch()
  }

  /**
   * 标记会话正在运行。
   *
   * @param {string} sessionId 会话 id
   */
  markRunning(sessionId) {
    const info = this.sessions.get(sessionId)
    if (info === undefined || info.status === 'running') return
    info.status = 'running'
    info.runningSince = Date.now()
    log(`status: ${sessionId} -> running`)
    this.touch()
  }

  /**
   * 标记会话回到空闲。
   *
   * @param {string} sessionId 会话 id
   */
  markIdle(sessionId) {
    const info = this.sessions.get(sessionId)
    if (info === undefined || info.status === 'idle') return
    info.status = 'idle'
    info.runningSince = 0
    log(`status: ${sessionId} -> idle`)
    this.touch()
  }

  // ------------------------------------------------------------ 待办请求

  /**
   * 加入一条动态。
   *
   * @param {{sessionId: string, kind: string, text: string}} item 动态
   */
  addFeed(item) {
    const text = String(item.text ?? '').slice(0, FEED_TEXT_LIMIT)
    if (text.trim() === '') return
    this.feedSeq += 1
    this.feedStore.seq = this.feedSeq
    this.feed.unshift({
      id: `f${this.feedSeq}`,
      ts: Date.now(),
      sessionId: item.sessionId,
      sessionTitle: this.labelFor(item.sessionId),
      kind: item.kind,
      text,
    })
    const limit = this.config.maxFeed ?? DEFAULT_MAX_FEED
    if (this.feed.length > limit) this.feed.length = limit
  }

  /** 标记状态有变化并让传输层广播。 */
  touch() {
    this.revision += 1
    this.server?.broadcast?.()
  }

  /** @returns {boolean} 此时是否值得把请求转到手机上。 */
  canIntercept() {
    return (this.server?.clientCount?.() ?? 0) >= MIN_CLIENTS_TO_INTERCEPT
  }

  /**
   * 某个会话是否已授权手机接管审批 / 提问。
   * 子 agent 跟随其父会话：父会话武装了，它下面的子 agent 也一并接管，
   * 否则「Lead 授权了手机，Teammate 的审批照样卡在电脑上」会很难理解。
   *
   * @param {string} sessionId 会话 id
   * @returns {boolean} 是否接管
   */
  isArmed(sessionId) {
    const own = this.state.armed?.[sessionId]
    if (own === true) return true
    // 显式关掉过就到此为止：显式表态优先于继承，否则"我在子会话上点了关闭"会看起来失灵。
    if (own === false) return false
    const parent = this.sessions.get(sessionId)?.parentSession
    if (typeof parent === 'string' && parent !== '' && this.state.armed?.[parent] === true) return true
    return false
  }

  /**
   * 请求手机作答；超时 / 无手机 / 被中止都返回 null，由调用方回落原生链。
   *
   * @param {'approval' | 'question'} kind 请求类型
   * @param {any} agent 目标 agent
   * @param {Record<string, any>} fields 附加字段
   * @param {AbortSignal | undefined} signal 上游中止信号
   * @param {string} via 来源标记（approval / answerer / tool），只写日志
   * @returns {Promise<any | null>} 作答结果或 null
   */
  async waitForDecision(kind, agent, fields, signal, via) {
    if (!this.canIntercept()) return null
    if (signal?.aborted === true) return null

    const timeoutMs = Math.max(50, Math.round(this.config.relayTimeoutSec * 1000))
    const id = randomUUID()
    const now = Date.now()
    // 有请求必登记会话：否则手机「待办」里会冒出一个在「会话」列表里找不到的来源。
    const info = this.ensureSession(agent.id, agent.session)
    info.lastActivityAt = now
    const item = {
      id,
      kind,
      sessionId: agent.id,
      sessionTitle: this.labelFor(agent.id),
      createdAt: now,
      expiresAt: now + timeoutMs,
      ...fields,
    }
    let resolveFn = () => {}
    const promise = new Promise((resolve) => {
      resolveFn = resolve
    })
    const entry = { id, kind, item, resolve: resolveFn, timer: null, onAbort: null, signal, via }
    entry.timer = setTimeout(() => this.settle(id, null, '超时'), timeoutMs)
    entry.timer.unref?.()
    if (signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
      entry.onAbort = () => this.settle(id, null, '请求被上游中止')
      signal.addEventListener('abort', entry.onAbort, { once: true })
    }
    this.pending.set(id, entry)
    this.addFeed({ sessionId: agent.id, kind: 'info', text: kind === 'approval' ? `等待审批：${fields.toolName ?? ''}` : '等待你回答问题' })
    log(`relay: 转手机作答 kind=${kind} via=${via} session=${agent.id} tool=${fields.toolName ?? '-'} timeout=${timeoutMs}ms`)
    this.touch()
    return await promise
  }

  /**
   * 结算一条待办。
   *
   * @param {string} id 请求 id
   * @param {any} value 结果（null = 未作答）
   * @param {string} [why] 日志原因
   */
  settle(id, value, why) {
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    if (entry.timer !== null) clearTimeout(entry.timer)
    if (entry.onAbort !== null) {
      try {
        entry.signal?.removeEventListener?.('abort', entry.onAbort)
      } catch {
        /* 信号可能已经不可用 */
      }
    }
    if (why !== undefined) log(`relay: 未作答回落 kind=${entry.kind} via=${entry.via} session=${entry.item.sessionId} 原因=${why}`)
    entry.resolve(value)
    this.touch()
  }

  /**
   * 供手机调用的作答入口。
   *
   * @param {any} body 请求体
   */
  answer(body) {
    const id = typeof body?.requestId === 'string' ? body.requestId : ''
    const entry = this.pending.get(id)
    if (entry === undefined) throw new Error('该请求已失效：可能已超时、已被取消或已在电脑上作答')
    if (entry.kind === 'approval') {
      const decision = body?.decision === 'allow' ? 'allowed-once' : body?.decision === 'deny' ? 'rejected' : null
      if (decision === null) throw new Error('审批决定不合法')
      log(`relay: 手机作答 kind=approval session=${entry.item.sessionId} decision=${decision}`)
      this.settle(id, decision)
      return
    }
    const answers = []
    for (const raw of Array.isArray(body?.answers) ? body.answers : []) {
      if (raw === null || typeof raw !== 'object') continue
      const selected = Array.isArray(raw.selected) ? raw.selected.filter((label) => typeof label === 'string' && label !== '') : []
      const custom = typeof raw.custom === 'string' ? raw.custom.trim() : ''
      // 与生产插件保持一致：有选项就按选项作答，纯文本才走 custom。
      if (selected.length > 0) answers.push({ id: raw.id, selected })
      else if (custom !== '') answers.push({ id: raw.id, selected: [], custom })
      else answers.push({ id: raw.id, selected: [] })
    }
    if (answers.length === 0) throw new Error('没有可提交的回答')
    log(`relay: 手机作答 kind=question session=${entry.item.sessionId} questions=${answers.length}`)
    this.settle(id, answers)
  }

  // ------------------------------------------------------------ 注入与指令

  /**
   * 手机发来的消息 → 注入会话。
   *
   * @param {any} body 请求体
   * @returns {Promise<void>}
   */
  async sendMessage(body) {
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    const text = typeof body?.text === 'string' ? body.text : ''
    if (text.trim() === '') throw new Error('内容为空')
    const agent = this.agentFor(sessionId)
    if (agent === undefined) throw new Error('这个会话当前不在运行中，请先在 DSH 里打开它')
    if (typeof agent.followup !== 'function') throw new Error('这个会话不支持注入消息')

    const session = agent.session
    const boundarySeq = typeof session?.seq === 'number' ? session.seq : 0
    this.addFeed({ sessionId, kind: 'sent', text })
    this.touch()
    log(`inject: 手机消息注入 session=${sessionId} 字符=${text.length}`)

    // 不阻塞 HTTP 响应：注入后要等整轮跑完才拿得到回复，手机端靠 SSE 看结果。
    void this.runInjectedTurn(agent, text, boundarySeq)
  }

  /**
   * 注入并等待这一轮结束，把结果写进动态流。
   *
   * @param {any} agent 目标 agent
   * @param {string} text 用户消息
   * @param {number} boundarySeq 注入前的 seq
   * @returns {Promise<void>}
   */
  async runInjectedTurn(agent, text, boundarySeq) {
    const sessionId = agent.id
    try {
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })

      // 目标会话可能**正忙**——而"正忙时发消息"恰恰是最常见的用法。这时候直接
      // `await whenIdle()` 会在**当前这一轮**结束时立刻兑现，那时我们注入的消息还没
      // 轮到，抓到的会是上一轮的输出，手机上就会显示一条张冠李戴的"回复"。
      // 所以必须等到日志里真的出现了我们注入的那条 user/message，才算这一轮开始了。
      const events = await this.waitForInjectedTurn(agent, text, boundarySeq)

      const session = agent.session
      const { reply, reasonKind } = extractReply(events, boundarySeq)
      const info = this.ensureSession(sessionId, session)
      if (reply !== null) {
        info.lastText = reply
        this.addFeed({ sessionId, kind: 'reply', text: reply })
      } else if (reasonKind !== null && reasonKind !== 'completed') {
        this.addFeed({ sessionId, kind: 'error', text: describeTurnEnd(reasonKind) })
      }
    } catch (error) {
      log(`inject: 注入回合失败 ${describeError(error)}`)
      this.addFeed({ sessionId, kind: 'error', text: `注入失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      this.touch()
    }
  }

  /**
   * 等注入的那一轮**真的跑起来并跑完**，返回那时的事件列表。
   *
   * 循环的每一圈都以 `whenIdle()` 开头：它会一直阻塞到当前回合结束，所以正常情况下
   * 只会转一两圈，不是忙等。`INJECT_DEADLINE_MS` 只是兜底，避免异常情况下永远不返回。
   *
   * @param {any} agent 目标 agent
   * @param {string} text 注入的文本
   * @param {number} boundarySeq 注入前的 seq
   * @returns {Promise<readonly any[]>} 注入起点之后的事件
   */
  async waitForInjectedTurn(agent, text, boundarySeq) {
    const startedAt = Date.now()
    let events = this.sessionEventsAfter(agent, boundarySeq)
    for (;;) {
      await agent.whenIdle()
      events = this.sessionEventsAfter(agent, boundarySeq)
      if (hasInjectedMessage(events, text)) {
        // 已经看到我们自己那条消息了：再等一次空闲，确保这一轮已经跑完。
        await agent.whenIdle()
        events = this.sessionEventsAfter(agent, boundarySeq)
        return events
      }
      if (Date.now() - startedAt >= INJECT_DEADLINE_MS) return events
      // 还没轮到我们（宿主收下消息需要一点时间），喘口气再等下一次空闲窗口。
      await delay(INJECT_RETRY_MS)
    }
  }

  /**
   * 读注入起点之后的会话事件。
   *
   * @param {any} agent 目标 agent
   * @param {number} boundarySeq 注入前的 seq
   * @returns {readonly any[]} 事件列表
   */
  sessionEventsAfter(agent, boundarySeq) {
    const session = agent?.session
    try {
      return typeof session?.snapshotEvents === 'function' ? session.snapshotEvents(boundarySeq) : (session?.events ?? [])
    } catch (error) {
      log(`inject: 读取会话事件失败 ${describeError(error)}`)
      return []
    }
  }

  /**
   * 手机请求中止某个会话当前的回合。
   *
   * @param {string} sessionId 会话 id
   */
  stopSession(sessionId) {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) throw new Error('这个会话当前不在运行中')
    if (typeof agent.cancel !== 'function') throw new Error('这个会话不支持中止')
    agent.cancel({ kind: 'user' })
    this.addFeed({ sessionId, kind: 'info', text: '已从中止当前回合' })
    this.touch()
  }

  /**
   * 武装 / 取消武装一个会话。
   *
   * @param {string} sessionId 会话 id
   * @param {boolean} armed 是否武装
   */
  setArmed(sessionId, armed) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('缺少会话 id')
    // 显式记 true / false：`false` 表示"用户明确关掉过"，自动武装不会再把它打开。
    this.state.armed[sessionId] = armed === true
    this.saveState()
    log(`arm: ${sessionId} -> ${armed}`)
    this.touch()
  }

  /**
   * 保存手机端改动的偏好。
   *
   * @param {any} body 请求体
   */
  setPrefs(body) {
    if (typeof body?.autoArm === 'boolean') this.config.autoArm = body.autoArm
    if (Number.isFinite(body?.relayTimeoutSec)) {
      const value = Math.round(Number(body.relayTimeoutSec))
      if (value >= 5 && value <= 3600) this.config.relayTimeoutSec = value
    }
    this.saveConfig?.()
    this.touch()
  }

  // ------------------------------------------------------------ 审批与提问

  /**
   * `approval/request` 瀑布：手机优先，未武装或超时都回落原生链。
   *
   * @param {any} request 审批请求
   * @param {() => Promise<any>} next 下一个作答者
   * @returns {Promise<any>} 决定
   */
  async handleApproval(request, next) {
    const agent = request?.agent
    if (agent === undefined || agent === null || typeof agent.id !== 'string') return await next()
    if (!this.isArmed(agent.id) || !this.canIntercept()) return await next()
    const toolName = typeof request.toolName === 'string' ? request.toolName : '未知工具'
    try {
      const decision = await this.waitForDecision(
        'approval',
        agent,
        {
          toolName,
          reason: typeof request.reason === 'string' ? request.reason : '',
          displayReason: pickDisplayReason(request.displayReason),
        },
        request.signal,
        'approval',
      )
      if (decision === null) return await next()
      return decision
    } catch (error) {
      log(`approval: 处理失败，回落原生链 ${describeError(error)}`)
      return await next()
    }
  }

  /**
   * `user-questions/request` 瀑布：菜单式作答器的正规入口。
   *
   * @param {any} request 提问请求
   * @param {() => Promise<any>} next 下一个作答者
   * @returns {Promise<any>} 回答
   */
  async handleUserQuestion(request, next) {
    const agent = request?.agent
    if (agent === undefined || agent === null || typeof agent.id !== 'string') return await next()
    if (!this.isArmed(agent.id) || !this.canIntercept()) return await next()
    const questions = normalizeQuestions(request.questions)
    if (questions.length === 0) return await next()
    try {
      const answers = await this.waitForDecision('question', agent, { questions }, request.signal, 'answerer')
      if (answers === null) return await next()
      return { answers }
    } catch (error) {
      log(`question: 作答器路径失败，回落原生链 ${describeError(error)}`)
      return await next()
    }
  }

  /**
   * `tools/execute` 兜底：直接在工具派发层接管 `ask_user_question`。
   *
   * 为什么两条路都要：
   *   - `user-questions/request` 是运行时公开的"作答器"契约，语义最正；
   *   - 但现网经验（同目录 dsh-ntfy-remote 生产插件）是用 `tools/execute` 接管成功的，
   *     说明不同组合下未必都会走到那条瀑布。两条同时注册不会重复处理：`tools/execute`
   *     一旦返回结果，工具本体就不会执行，也就不会再产生 `user-questions/request`；
   *     反之它调用 next() 时，说明该会话未武装，瀑布那条也会同样 next()。
   *
   * @param {any} exec 工具执行
   * @param {() => Promise<any>} next 继续派发
   * @returns {Promise<any>} 结果
   */
  async handleToolExecute(exec, next) {
    if (exec?.name !== 'ask_user_question') return await next()
    const agent = exec.agent
    if (agent === undefined || agent === null || typeof agent.id !== 'string') return await next()
    if (!this.isArmed(agent.id) || !this.canIntercept()) return await next()
    const questions = normalizeQuestions(exec.arguments?.questions)
    if (questions.length === 0) return await next()
    try {
      const answers = await this.waitForDecision('question', agent, { questions }, exec.signal, 'tool')
      if (answers === null) return await next()
      const value = { answers }
      return { isError: false, value, content: [{ type: 'text', text: JSON.stringify(value) }] }
    } catch (error) {
      log(`question: 工具路径失败，回落原生链 ${describeError(error)}`)
      return await next()
    }
  }

  // ------------------------------------------------------------ 快照

  /**
   * 组装给手机端的完整快照。
   *
   * @returns {any} 快照
   */
  snapshot() {
    const sessions = []
    for (const info of this.sessions.values()) {
      // 从来没有活动、也没武装、也不在内存里的会话不值得占位置。
      if (info.status === 'offline' && !this.isArmed(info.id)) continue
      let pending = 0
      for (const entry of this.pending.values()) if (entry.item.sessionId === info.id) pending += 1
      sessions.push({
        id: info.id,
        title: this.labelFor(info.id),
        cwd: info.cwd,
        armed: this.isArmed(info.id),
        status: info.status,
        runningSince: info.runningSince,
        lastActivityAt: info.lastActivityAt,
        lastText: info.lastText.slice(0, 1200),
        pending,
        subagent: info.parentSession !== '',
      })
    }
    sessions.sort((left, right) => {
      if (left.status === 'running' && right.status !== 'running') return -1
      if (right.status === 'running' && left.status !== 'running') return 1
      if (left.pending !== right.pending) return right.pending - left.pending
      return right.lastActivityAt - left.lastActivityAt
    })

    const pending = [...this.pending.values()].map((entry) => entry.item)
    pending.sort((left, right) => left.createdAt - right.createdAt)

    return {
      ok: true,
      now: Date.now(),
      revision: this.revision,
      server: {
        port: this.server?.port ?? this.config.port,
        hosts: this.server?.allPairingUrls?.()?.map((url) => new URL(url).hostname) ?? [],
        urls: this.server?.allPairingUrls?.() ?? [],
        clients: this.server?.clientCount?.() ?? 0,
        tokenTail: typeof this.state.token === 'string' ? this.state.token.slice(-4) : '',
      },
      prefs: {
        relayTimeoutSec: this.config.relayTimeoutSec,
        autoArm: this.config.autoArm === true,
      },
      balance: this.balance,
      sessions,
      pending,
      feed: this.feed,
    }
  }

  /**
   * 生成配对地址的二维码 SVG。
   *
   * @returns {string} SVG；地址过长时为空串
   */
  qrSvg() {
    const url = this.server?.pairingUrl?.()
    if (typeof url !== 'string' || url === '') return ''
    return encodeQrSvg(url, { margin: 3, scale: 8, title: 'DSH 手机控制台配对地址', dark: '#0b1220', light: '#ffffff' })
  }
}
