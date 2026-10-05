// 测试基建：极简断言库 + 假 DSH 宿主（ctx / agent / 瀑布分发）。
//
// 为什么要自己搭：插件要测的是「和 DSH 的契约」——事件名、prepend/global 选项、
// 瀑布的 next() 语义、agent.followup 的参数形状。用一个可控的假宿主把这些契约
// 固定下来，比启动真宿主快几个数量级，也能精确制造超时/中止这类边界。

import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 测试计数与失败收集。 */
export const stats = { passed: 0, failed: 0, failures: [] }

/**
 * 断言为真。
 *
 * @param {string} label 用例名
 * @param {unknown} value 实际值
 */
export function ok(label, value) {
  if (value) {
    stats.passed += 1
    return
  }
  stats.failed += 1
  stats.failures.push(label)
  process.stdout.write(`  ✗ ${label}\n`)
}

/**
 * 断言相等（用 JSON 比较，足够覆盖这些值是字符串/数字/纯对象的情况）。
 *
 * @param {string} label 用例名
 * @param {unknown} actual 实际值
 * @param {unknown} expected 期望值
 */
export function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    stats.passed += 1
    return
  }
  stats.failed += 1
  stats.failures.push(`${label}\n      实际: ${a}\n      期望: ${b}`)
  process.stdout.write(`  ✗ ${label}\n      实际: ${a}\n      期望: ${b}\n`)
}

/**
 * 断言抛错。
 *
 * @param {string} label 用例名
 * @param {() => any} fn 待执行函数
 */
export async function rejects(label, fn) {
  try {
    await fn()
    stats.failed += 1
    stats.failures.push(label)
    process.stdout.write(`  ✗ ${label}（本应抛错却没有）\n`)
  } catch {
    stats.passed += 1
  }
}

/**
 * 分组打印。
 *
 * @param {string} title 组名
 */
export function group(title) {
  process.stdout.write(`\n${title}\n`)
}

/**
 * 造一个临时 DSH_HOME，避免测试写到真实用户目录。
 *
 * @param {string} tag 名字后缀
 * @returns {string} 目录路径
 */
export function makeTempHome(tag) {
  const dir = join(tmpdir(), `dsh-mobile-console-test-${tag}-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 假 agent。
 *
 * 会真的"跑回合"：`followup` 进来的消息先排队，空闲时开始下一轮，跑完依次发出
 * `user/message` → `assistant/message` → `turn/end`。这样才能复现"往一个正忙的会话
 * 注入消息"时的真实时序——原先每次 `whenIdle()` 都无条件假装立刻跑完，那条竞态根本
 * 测不出来。
 */
export class FakeAgent {
  /**
   * @param {string} id 会话 id
   * @param {Record<string, any>} [header] 会话头
   * @param {{ busy?: boolean, autoPump?: boolean, replies?: string[] }} [options] 选项：
   *   `busy` 一上来就有回合在跑；`autoPump: false` 表示跑完一轮后不自动开始排队中的
   *   下一轮，由测试手动 `pump()`（用来模拟宿主"过一会儿才收下消息"）；`replies` 是
   *   每一轮的脚本化回复。
   */
  constructor(id, header = {}, options = {}) {
    this.id = id
    this.messages = []
    this.cancelled = 0
    this.busy = options.busy === true
    this.autoPump = options.autoPump !== false
    this.replies = [...(options.replies ?? [])]
    this.queued = []
    this.idleWaiters = []
    this.turns = 0
    this.session = {
      id,
      seq: 0,
      header: { cwd: 'C:\\workspace', ...header },
      events: [],
      snapshotEvents(from) {
        return this.events.filter((event) => (typeof event.seq === 'number' ? event.seq >= from : true))
      },
    }
    this.inbox = {
      nextTurn: [],
      nextStep: [],
      remove: () => false,
    }
  }

  /**
   * 注入一条用户消息（记录形状，便于断言）。
   *
   * @param {any} message 消息
   */
  followup(message) {
    this.messages.push(message)
    this.queued.push(message)
    this.pump()
  }

  /** 空闲时开始排队中的下一轮。 */
  pump() {
    if (this.busy || this.queued.length === 0) return
    const message = this.queued.shift()
    this.busy = true
    this.turns += 1
    this.emit({ type: 'user/message', data: { message: { content: message.content } } })
    this.finish(this.replies.shift() ?? '好的')
  }

  /**
   * 结束当前这一轮，并指定这一轮的输出（不指定就用脚本里的下一条）。
   *
   * @param {string} [text] 这一轮的输出
   */
  endTurn(text) {
    if (this.busy) this.finish(text ?? this.replies.shift() ?? '好的')
  }

  /**
   * 收尾一轮：发回复、发 turn/end、放行等待空闲的人。
   *
   * @param {string} text 输出
   */
  finish(text) {
    this.emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    this.emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    this.busy = false
    for (const resolve of this.idleWaiters.splice(0)) resolve()
    if (this.autoPump) this.pump()
  }

  /** 等到当前回合结束；本来就空闲时立刻返回。 */
  async whenIdle() {
    if (!this.busy) return
    await new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  /**
   * 追加一条会话事件。
   *
   * @param {any} event 事件
   */
  emit(event) {
    this.session.seq += 1
    this.session.events.push({ seq: this.session.seq, ...event })
  }

  /** 取消当前回合。 */
  cancel() {
    this.cancelled += 1
  }
}

/**
 * 假 cordis 上下文。
 */
export class FakeCtx {
  constructor() {
    /** @type {Map<string, {handler: Function, options: any, order: number}[]>} */
    this.handlers = new Map()
    /** @type {Map<string, FakeAgent>} */
    this.agents = new Map()
    /** @type {Map<string, any>} 已注册的命令（与 `ctx.commands.register` 同形） */
    this.registered = new Map()
    /** @type {(() => any)[]} */
    this.effects = []
    /** @type {Record<string, any>} 可选的其它服务（如 webServer / deepseekAccount）。 */
    this.services = {}
    this.order = 0
    this.unregistered = 0
    const registered = this.registered
    /** `ctx.commands` 服务。 */
    this.commands = {
      register: (definition) => {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    }
  }

  /**
   * 注册一个事件监听（与 cordis 的 `ctx.on(event, handler, options)` 同形）。
   *
   * @param {string} event 事件名
   * @param {Function} handler 处理器
   * @param {any} [options] 选项（prepend / global）
   * @returns {() => void} 注销函数
   */
  on(event, handler, options) {
    const list = this.handlers.get(event) ?? []
    if (!this.handlers.has(event)) this.handlers.set(event, list)
    const entry = { handler, options: options ?? {}, order: (this.order += 1) }
    list.push(entry)
    return () => {
      const index = list.indexOf(entry)
      if (index >= 0) list.splice(index, 1)
      this.unregistered += 1
    }
  }

  /**
   * `ctx.get(name)`：提供 agents，以及用例可选的其它服务（如 webServer / deepseekAccount）。
   *
   * @param {string} name 服务名
   * @returns {any} 服务
   */
  get(name) {
    if (name === 'agents') {
      return {
        get: (id) => this.agents.get(id),
        list: () => [...this.agents.values()],
      }
    }
    return this.services?.[name]
  }

  /**
   * `ctx.inject(deps, callback)`：依赖就绪时立刻调用回调（假实现里服务是预置的，等价于
   * "已经就绪"），并把回调返回的 disposer 收下来。
   *
   * 回调收到的 `scoped` 是个最小上下文：`effect(fn)` 立刻执行 fn 并记住它返回的 disposer，
   * 与 cordis 的语义一致（`ctx.effect(() => disposer)`）。
   *
   * @param {string[]} deps 依赖的服务名
   * @param {(scoped: any) => any} callback 回调
   * @returns {() => void} 注销函数
   */
  inject(deps, callback) {
    const scoped = {
      ...this,
      effect: (setup) => {
        const disposer = typeof setup === 'function' ? setup() : undefined
        if (typeof disposer === 'function') this.effects.push(disposer)
        return disposer
      },
    }
    // cordis 里服务以 `ctx.<name>` 的形式暴露，所以依赖也要挂到 scoped 上。
    for (const dep of deps ?? []) scoped[dep] = this.services?.[dep]
    const value = callback(scoped)
    if (typeof value === 'function') {
      this.effects.push(value)
      return value
    }
    // 回调没返回 disposer 时，回一个"清掉它注册的所有 effect"的函数，够用。
    return () => {}
  }

  /**
   * `ctx.effect`：记下 disposer。
   *
   * @param {() => any} setup 建立函数
   */
  effect(setup) {
    this.effects.push(setup)
  }

  /** @returns {any} 上一次注册的命令定义（测试用） */
  command(name) {
    return this.registered.get(name)
  }

  /**
   * 加入一个 agent。
   *
   * @param {FakeAgent} agent agent
   * @returns {FakeAgent} 同一个 agent
   */
  addAgent(agent) {
    this.agents.set(agent.id, agent)
    return agent
  }

  /**
   * 触发一个普通（emit）事件。
   *
   * @param {string} event 事件名
   * @param {...any} args 参数
   * @returns {Promise<any[]>} 各处理器返回值
   */
  async emitEvent(event, ...args) {
    const out = []
    for (const entry of this.ordered(event)) out.push(await entry.handler(...args))
    return out
  }

  /**
   * 触发一个瀑布事件，语义与 DSH 一致：返回即接管，调用 next() 才继续。
   *
   * @param {string} event 事件名
   * @param {...any} args 参数
   * @returns {Promise<any>} 最终结果
   */
  async waterfall(event, ...args) {
    const list = this.ordered(event)
    let index = 0
    let reachedEnd = false
    const next = async () => {
      if (index >= list.length) {
        reachedEnd = true
        return undefined
      }
      const entry = list[index]
      index += 1
      return await entry.handler(...args, next)
    }
    const result = await next()
    return { result, reachedEnd }
  }

  /**
   * 按 prepend 语义排序处理器：prepend 的在前（后注册的先跑），其余按注册顺序。
   *
   * @param {string} event 事件名
   * @returns {any[]} 排序后的处理器
   */
  ordered(event) {
    const list = [...(this.handlers.get(event) ?? [])]
    const prepend = list.filter((entry) => entry.options.prepend === true).sort((a, b) => b.order - a.order)
    const normal = list.filter((entry) => entry.options.prepend !== true).sort((a, b) => a.order - b.order)
    return [...prepend, ...normal]
  }

  /**
   * 某个事件是否注册了处理器。
   *
   * @param {string} event 事件名
   * @returns {boolean} 是否注册
   */
  has(event) {
    return (this.handlers.get(event) ?? []).length > 0
  }

  /**
   * 取某个事件第一个处理器的选项（用来断言 prepend/global）。
   *
   * @param {string} event 事件名
   * @returns {any} 选项
   */
  optionsFor(event) {
    return this.handlers.get(event)?.[0]?.options
  }
}

/**
 * 造一个只满足桥接需要的假传输层。
 *
 * @param {{ clients?: number, url?: string }} [options] 选项
 * @returns {any} 假服务
 */
export function fakeServer(options = {}) {
  const clients = options.clients ?? 1
  const url = options.url ?? 'http://192.168.1.5:8799/?k=deadbeefdeadbeefdeadbeefdeadbeef'
  return {
    port: 8799,
    clientCount: () => clients,
    broadcast() {},
    allPairingUrls: () => [url],
    pairingUrl: () => url,
  }
}

/**
 * 等待若干毫秒。
 *
 * @param {number} ms 毫秒
 * @returns {Promise<void>} 完成
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 测试期间保持事件循环存活。
 *
 * 插件里的作答超时定时器是 `unref()` 的（生产环境里宿主始终有监听句柄，定时器照常触发；
 * unref 只是保证它不会拖住进程退出）。但在**孤立的测试进程**里，一个 unref 定时器可能
 * 成为唯一的待处理句柄，于是事件循环直接空掉、超时永远不触发（Node 会报
 * "unsettled top-level await"）。这里挂一个普通 interval 把循环撑住。
 */
let keepAliveHandle = null

/** 开始保活。 */
export function keepAlive() {
  if (keepAliveHandle === null) keepAliveHandle = setInterval(() => {}, 1000)
}

/** 结束保活（report 会自动调用）。 */
export function releaseKeepAlive() {
  if (keepAliveHandle !== null) {
    clearInterval(keepAliveHandle)
    keepAliveHandle = null
  }
}

/**
 * 汇总测试结果并按需以非零码退出。
 *
 * @param {string} title 套件名
 */
export function report(title) {
  releaseKeepAlive()
  process.stdout.write(`\n${title}：通过 ${stats.passed}，失败 ${stats.failed}\n`)
  if (stats.failed > 0) {
    process.stdout.write(`失败清单：\n - ${stats.failures.join('\n - ')}\n`)
    process.exitCode = 1
  }
}
