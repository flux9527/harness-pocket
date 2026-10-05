// dsh-mobile-console — 宿主挂载的稳定外壳（开发期自热重载）。
//
// 三条实测教训（与同目录 dsh-ntfy-remote 一致，都踩过）：
//   1. 宿主挂载的入口文件本身也被 Node 的 ESM 缓存锁住：profile 的 patchReload 触发了
//      重新挂载，import 命中的仍是缓存里的旧代码。所以入口文件名一旦挂上就不再改动，
//      实现全部放在 src/main.js，由这里按 `?v=` 动态加载。
//   2. cordis **不会**把 apply 的返回值当作清理函数，只有 ctx.effect() 注册的 disposer
//      会在 fiber 卸载时执行。因此 watch、定时器、监听服务都必须走 ctx.effect，否则
//      插件卸载后仍在后台跑（典型症状：端口一直被占）。
//   3. fiber 卸载后再往同一个 ctx 注册监听会抛错。热重载必须靠 ctx.effect 拿到旧实例
//      来清理，而不是复用同一个 ctx 反复注册。
//
// 本外壳会自监听 src/ 与 ui/，改完存盘约 0.3 秒后自动重载——这样开发时不用重启 DSH
// （重启会关掉正在看的这个网页）。

import { watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-mobile-console'

/** 依赖的服务：会话注册表与命令注册。 */
export const inject = ['agents', 'commands']

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 进程内的实例槽。
 *
 * 实机踩过：宿主重新挂载时是**先挂新实例、后卸旧实例**（甚至旧的不卸）。结果同一个进程里
 * 同时监听着 8799 和 8800，`/mobile` 命令重复注册报错，而手机还连在那个跑着旧代码的
 * 8799 上——用户会看到"明明改了代码却没生效"，而且配对地址会随端口漂移失效。
 *
 * 所以每个新实例挂载时先在槽里登记，并在第一次加载前把上一个实例收干净。
 * 用 `Symbol.for` 是为了让重新 import 出来的模块拿到同一个键。
 */
const INSTANCE_KEY = Symbol.for('dsh-mobile-console.instance')

/** 源文件改动合并成一次重载的等待时间。 */
const DEBOUNCE_MS = 300

/**
 * 外壳入口：加载实现、监听源文件、卸载时收尾。
 *
 * @param {any} ctx cordis 上下文
 */
export function apply(ctx) {
  const holder = /** @type {Record<symbol, any>} */ (/** @type {unknown} */ (globalThis))
  const previous = holder[INSTANCE_KEY]
  const state = { dispose: null, timer: null, reloading: false, queued: false, stopped: false }
  holder[INSTANCE_KEY] = state

  // 上一个实例如果已经加载出实现，就拿到它的 dispose 做交接；顺手把它标记为已停止，
  // 免得它还在排队的那次重载继续跑。
  let handoff = null
  if (previous !== undefined && previous !== state) {
    previous.stopped = true
    if (typeof previous.dispose === 'function') handoff = previous.dispose
  }

  /** 重新加载实现：先卸载上一版（**等它真的关掉监听**），再按新版本号导入。 */
  const reload = async () => {
    if (state.stopped) return
    if (state.reloading) {
      state.queued = true
      return
    }
    state.reloading = true
    try {
      // 交接：宿主重挂载留下旧实例时，必须先把它的监听和命令注册收掉，
      // 否则新实例会绑到下一个端口、/mobile 也会因重复注册而不可用。
      if (handoff !== null) {
        const disposePrevious = handoff
        handoff = null
        try {
          await disposePrevious()
        } catch (error) {
          process.stderr.write(`[dsh-mobile-console] 交接旧实例失败: ${String(error)}\n`)
        }
      }
      if (typeof state.dispose === 'function') {
        try {
          await state.dispose()
        } catch (error) {
          process.stderr.write(`[dsh-mobile-console] 卸载旧版失败: ${String(error)}\n`)
        }
      }
      state.dispose = null
      const module = await import(`./src/main.js?v=${Date.now()}`)
      const dispose = module.apply(ctx)
      state.dispose = typeof dispose === 'function' ? dispose : null
    } catch (error) {
      // 实现加载失败绝不能拖垮宿主：写 stderr，等下一次改动再试。
      process.stderr.write(`[dsh-mobile-console] 重载失败: ${String(error)}\n`)
    } finally {
      state.reloading = false
      if (state.queued) {
        state.queued = false
        void reload()
      }
    }
  }

  void reload()

  /** 只关心实现与界面资源；改测试文件之类的不会触发重载。 */
  const shouldReload = (filename) => typeof filename === 'string' && /\.(js|css|html)$/.test(filename)
  const watchers = []
  for (const dir of [join(HERE, 'src'), join(HERE, 'ui')]) {
    try {
      watchers.push(
        watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
          if (!shouldReload(filename)) return
          if (state.timer !== null) clearTimeout(state.timer)
          state.timer = setTimeout(() => {
            state.timer = null
            void reload()
          }, DEBOUNCE_MS)
        }),
      )
    } catch (error) {
      process.stderr.write(`[dsh-mobile-console] 无法监听 ${dir}: ${String(error)}\n`)
    }
  }

  // 清理必须走 ctx.effect：cordis 不调用 apply 的返回值。
  ctx.effect(() => () => {
    state.stopped = true
    // 只有槽里还是自己时才清空——否则会把已经接管的新实例从槽里挤掉。
    if (holder[INSTANCE_KEY] === state) delete holder[INSTANCE_KEY]
    if (state.timer !== null) clearTimeout(state.timer)
    for (const watcher of watchers) {
      try {
        watcher.close()
      } catch {
        /* 已经关了 */
      }
    }
    void state.dispose?.()
  })
}
