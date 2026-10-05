// dsh-mobile-console — 实现入口。
//
// 本文件不直接被宿主挂载；宿主挂载的是 boot.js 外壳，外壳按版本号动态 import 本文件
// （见 boot.js 顶部的三条实测教训）。因此这里对同级模块一律用「版本透传」导入。
//
// 装配顺序：配置/状态 → 桥接 → 传输层 → 事件与命令 → 启动监听。
// 任何一步失败都不能拖垮宿主：记日志并尽量降级（例如端口全被占用时不装载功能）。

const VERSION = new URL(import.meta.url).search

const { describeError, log } = await import(`./log.js${VERSION}`)
const { createStateSaver, loadConfig, loadState, saveConfig: persistConfig } = await import(`./config.js${VERSION}`)
const { MobileBridge, describeBalance } = await import(`./bridge.js${VERSION}`)
const { MobileServer } = await import(`./server.js${VERSION}`)
const { asciiQr } = await import(`./ascii.js${VERSION}`)
const { registerDesktopRoutes } = await import(`./desktop.js${VERSION}`)

export const name = 'dsh-mobile-console'

/** 依赖的服务：会话注册表与命令注册。 */
export const inject = ['agents', 'commands']

/**
 * 把桥接接到宿主的事件与命令上，返回一个总注销函数。
 *
 * 单独抽出来是为了**可测**：测试用假 ctx 调这个函数，就能验证到真实的事件名、
 * `prepend` / `global` 选项、以及命令元数据，而不是测试里另写一份接线。
 *
 * @param {any} ctx cordis 上下文
 * @param {any} bridge MobileBridge
 * @returns {() => void} 注销函数
 */
export function registerHooks(ctx, bridge) {
  /** 本次注册的所有注销函数，卸载时逆序执行。 */
  const disposers = []
  const own = (disposer) => {
    if (typeof disposer === 'function') disposers.push(disposer)
  }
  /** 事件处理器统一包一层 try/catch：插件绝不能因为自己的异常打断 agent 回合。 */
  const guard = (label, fn) => {
    return (...args) => {
      try {
        return fn(...args)
      } catch (error) {
        log(`${label}: 处理失败 ${describeError(error)}`)
        return undefined
      }
    }
  }

  // --- 状态事件 ---------------------------------------------------------
  //
  // 运行状态不是靠 `agent/status` 得到的：实机探针证明**本构建从不派发它**（注册了
  // 监听也一条都没收到，状态会永远停在"空闲"）。真正的信号来自下面两路：
  //   session/event 的 step/* tool/* assistant/* user/* → 有回合在跑
  //   session/event 的 turn/end                    → 回合结束，回到空闲
  //   agent/assistant-stream                       → 正在流式输出（进程内事件，最灵敏）
  // `agent/status` 仍然保留：将来构建真的派发它时，它是最权威的来源。
  own(
    ctx.on(
      'agent/status',
      guard('agent/status', (payload) => bridge.onAgentStatus(payload)),
      { global: true },
    ),
  )
  own(
    ctx.on(
      'agent/assistant-stream',
      (payload) => bridge.onAssistantStream(payload),
      { global: true },
    ),
  )
  own(
    ctx.on(
      'session/event',
      guard('session/event', (session, event) => bridge.onSessionEvent(session, event)),
      { global: true },
    ),
  )
  own(
    ctx.on(
      'agent/created',
      guard('agent/created', (payload) => {
        const agent = payload?.agent
        if (typeof agent?.id !== 'string') return
        bridge.ensureSession(agent.id, agent.session)
        bridge.touch()
      }),
      { global: true },
    ),
  )
  own(
    ctx.on(
      'agent/disposed',
      guard('agent/disposed', (payload) => {
        const id = payload?.agent?.id
        if (typeof id === 'string') bridge.markOffline(id)
      }),
      { global: true },
    ),
  )

  // --- 需要手机作答的三条瀑布 -------------------------------------------
  //
  // `approval/request` 必须 prepend + global：
  //   - 审批按 agent 作用域过滤分发（`@deepseek-ai/dsh-scope`），插件的 ctx 不在该
  //     agent 的作用域链里，不声明 global 就收不到（同目录生产插件实测踩过）；
  //   - 链上已存在网页端的终结型作答者（它不会调用 next()），prepend 让本插件先跑，
  //     未武装或超时时再 next() 交回，网页端行为不变。
  own(
    ctx.on('approval/request', (request, next) => bridge.handleApproval(request, next), {
      prepend: true,
      global: true,
    }),
  )
  own(
    ctx.on('user-questions/request', (request, next) => bridge.handleUserQuestion(request, next), {
      prepend: true,
      global: true,
    }),
  )
  // `tools/execute` 是提问的工具级兜底，理由见 bridge.handleToolExecute 的注释。
  own(ctx.on('tools/execute', (exec, next) => bridge.handleToolExecute(exec, next), { global: true }))

  // --- 桌面命令 ---------------------------------------------------------
  try {
    own(
      ctx.commands.register({
        name: 'mobile',
        description: '手机控制台：查看配对地址与二维码，或开启/关闭本会话的手机接管',
        input: { hint: '[on|off|status|url|qr|help]' },
        handler: (invocation) => runCommand(bridge, invocation),
      }),
    )
  } catch (error) {
    log(`命令注册失败，/mobile 本次不可用：${describeError(error)}`)
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        log(`注销失败 ${describeError(error)}`)
      }
    }
  }
}

/**
 * 插件入口。
 *
 * @param {any} ctx cordis 上下文
 * @returns {() => Promise<void>} 卸载函数（由 boot.js 外壳在重载或宿主卸载时调用）
 */
export function apply(ctx) {
  let config
  let state
  try {
    config = loadConfig()
    state = loadState()
  } catch (error) {
    log(`启动失败：配置/状态不可用 ${describeError(error)}`)
    return async () => {}
  }

  const stateSaver = createStateSaver(() => state)
  const bridge = new MobileBridge({
    ctx,
    config,
    state,
    saveState: () => stateSaver.schedule(),
    saveConfig: () => {
      try {
        persistConfig(config)
      } catch (error) {
        log(`config: 保存失败 ${describeError(error)}`)
      }
    },
  })
  const server = new MobileServer({ token: state.token, config })
  bridge.attach(server)
  server.attach(bridge)

  const disposeHooks = registerHooks(ctx, bridge)

  // --- 传输层：可以运行时开关 -------------------------------------------
  //
  // 设置页上的总开关就作用在这里。关掉时把监听停掉，正在等的审批 / 提问立刻回落给原生
  // 链路；会话表刷新**不停**，因为桌面设置页还要显示状态。
  /** @type {Promise<boolean>} */
  let started = Promise.resolve(false)

  const isEnabled = () => config.enabled === true && server.listening === true

  const startListener = async () => {
    if (server.listening === true) return true
    try {
      await server.start()
      log(`server: 已启动（设置页开启）port=${server.port}`)
      return true
    } catch (error) {
      log(`监听失败，手机控制台本次不可用：${describeError(error)}`)
      return false
    }
  }

  const stopListener = async () => {
    if (server.listening !== true) return
    try {
      await server.stop()
      log('server: 已停止（设置页关闭）')
    } catch (error) {
      log(`关闭监听失败 ${describeError(error)}`)
    }
    // 停监听会断开所有手机；正在等的待办必须马上回落，别让用户干等超时。
    bridge.settlePending()
  }

  const setEnabled = async (enabled) => {
    config.enabled = enabled === true
    if (config.enabled) await startListener()
    else await stopListener()
    bridge.touch()
  }

  /** 换一个新令牌，旧的配对链接立即失效。 */
  const rotateToken = async () => {
    const { newToken } = await import(`./config.js${VERSION}`)
    state.token = newToken()
    stateSaver.flush()
    server.setToken(state.token)
    log('state: 已在设置页重新生成访问令牌（旧的配对链接将失效）')
    bridge.touch()
  }

  if (config.enabled === true) {
    started = startListener()
    void started.then((okFlag) => {
      if (okFlag) log(`plugin loaded port=${server.port} sessions=${bridge.snapshot().sessions.length} autoArm=${config.autoArm === true}`)
    })
  } else {
    log('plugin loaded（总开关是关闭状态，不监听）')
  }

  bridge.start()

  // --- 桌面设置页入口（同源路由）----------------------------------------
  const disposeDesktop = registerDesktopRoutes(ctx, {
    bridge,
    server,
    config,
    saveConfig: () => {
      try {
        persistConfig(config)
      } catch (error) {
        log(`config: 保存失败 ${describeError(error)}`)
      }
    },
    saveState: () => stateSaver.schedule(),
    getState: () => state,
    getContext: () => ctx,
    isEnabled,
    setEnabled,
    rotateToken,
    onUnavailable: (error) => log(`desktop: 没有 webServer，设置页入口不可用 ${describeError(error)}`),
  })

  // --- 报告浏览器半边是否就位 -------------------------------------------
  //
  // 设置页入口出不出现，完全取决于浏览器半边有没有进客户端模块图；而它出问题时**没有任何
  // 报错**——只是设置里少一页。所以启动时主动查一次并写进日志，排查时一眼就能看到原因。
  try {
    ctx.inject(['clientModules'], (scoped) => {
      try {
        const graph = scoped.clientModules?.graph?.()
        const entry = graph?.entries?.find((item) => item?.id === 'dsh-mobile-console')
        if (entry === undefined) {
          log('desktop: 浏览器半边不在客户端模块图里，设置页不会出现（查 package.json 的 dsh.client 与 exports["./client"]）')
        } else {
          log(`desktop: 浏览器半边已注册 id=${entry.id} rev=${entry.rev} url=${entry.url}`)
        }
      } catch (error) {
        log(`desktop: 读取客户端模块图失败 ${describeError(error)}`)
      }
    })
  } catch (error) {
    log(`desktop: 无法订阅 clientModules ${describeError(error)}`)
  }

  // 卸载可能被调用两次：boot.js 交接旧实例时会调一次，旧 fiber 自己卸载时宿主还会再调
  // 一次。必须是幂等的，否则第二次会在"重复注销"上报错，噪音盖住真正的问题。
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    bridge.stop()
    stateSaver.flush()
    disposeDesktop()
    try {
      await started
    } catch {
      /* start 已经自己吞掉了错误并记了日志 */
    }
    try {
      await server.stop()
    } catch (error) {
      log(`关闭监听失败 ${describeError(error)}`)
    }
    disposeHooks()
    log('plugin unloaded')
  }
}

/**
 * `/mobile` 命令。
 *
 * @param {MobileBridge} bridge 桥接
 * @param {any} invocation 命令调用
 * @returns {{ kind: 'success', text: string } | { kind: 'error', text: string }} 结果
 */
function runCommand(bridge, invocation) {
  const agentId = invocation?.agent?.id
  const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput : ''
  const argument = raw
    .trim()
    .replace(/^\/mobile\b/i, '')
    .trim()
    .toLowerCase()

  const urls = bridge.server?.allPairingUrls?.() ?? []
  const url = urls[0] ?? '（未启动）'

  switch (argument) {
    case '':
    case 'status': {
      const armed = typeof agentId === 'string' ? bridge.isArmed(agentId) : false
      const clients = bridge.server?.clientCount?.() ?? 0
      const lines = [
        `手机控制台：${clients > 0 ? `已连接 ${clients} 台手机` : '当前没有手机连接'}`,
        `本会话：${armed ? '已武装（手机接管审批与提问）' : '未武装'}`,
        `账户余额：${describeBalance(bridge.snapshot().balance)}`,
        `配对地址：${url}`,
        '',
        '用手机浏览器打开上面的地址即可。命令：/mobile on · off · url · qr · help',
      ]
      return { kind: 'success', text: lines.join('\n') }
    }
    case 'on':
    case 'off': {
      if (typeof agentId !== 'string') return { kind: 'error', text: '这个命令需要在会话里执行' }
      bridge.setArmed(agentId, argument === 'on')
      return {
        kind: 'success',
        text:
          argument === 'on'
            ? `已武装本会话：审批与提问会转到手机。配对地址：${url}`
            : '已取消武装：审批与提问回到电脑上的原生弹窗。',
      }
    }
    case 'url':
      return { kind: 'success', text: url }
    case 'qr': {
      if (url === '（未启动）') return { kind: 'error', text: '手机控制台没有启动成功，请看插件日志。' }
      const art = asciiQr(url)
      if (art === '') return { kind: 'error', text: '二维码生成失败：配对地址过长。' }
      return { kind: 'success', text: `用手机相机扫描下面这张二维码（内容：${url}）：\n\n${art}` }
    }
    case 'help':
      return {
        kind: 'success',
        text: [
          '/mobile          查看状态与配对地址',
          '/mobile on       开启本会话的手机接管（审批 / 提问转到手机）',
          '/mobile off      关闭本会话的手机接管',
          '/mobile url      只输出配对地址',
          '/mobile qr       在对话里显示配对二维码',
          '/mobile help     显示本帮助',
        ].join('\n'),
      }
    default:
      return { kind: 'error', text: `未知参数「${argument}」。可用：on · off · status · url · qr · help` }
  }
}
