// 配置与状态持久化。
//
//   config.json — 用户可改的运行参数（端口、监听地址、中转超时、默认武装策略）
//   state.json  — 插件自己维护的数据（**访问令牌**、已武装的会话集合）
//
// 两个文件都放在 `$DSH_HOME/dsh-mobile-console/`，都用「临时文件 + rename」原子写入：
// dsh 可能在任何时刻被 Ctrl-C，半截 JSON 会让下次启动直接失败（参考同目录 ntfy 插件
// 踩过的坑）。
//
// 令牌是这个插件的**唯一鉴权手段**（手机端与宿主之间共享），所以它只能生成一次、
// 之后从 state.json 读；每次启动重新生成会让已配对的手机全部失效。

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// 版本透传：外壳用 `?v=` 重新加载时整张模块图都要重新求值（见 boot.js）。
const VERSION = new URL(import.meta.url).search
const { DATA_DIR, log } = await import(`./log.js${VERSION}`)

/** 运行参数文件。 */
export const CONFIG_FILE = join(DATA_DIR, 'config.json')

/** 状态文件（含令牌）。 */
export const STATE_FILE = join(DATA_DIR, 'state.json')

/** 默认运行参数。 */
export const DEFAULT_CONFIG = {
  /** 手机控制台总开关。关掉后不再监听、也不再接管任何审批 / 提问。 */
  enabled: true,
  /** 手机端监听端口；被占用时会自动向后找一个空闲端口。 */
  port: 8799,
  /** 监听地址。默认 0.0.0.0 = 局域网内所有网卡，手机才能连上。 */
  bindHost: '0.0.0.0',
  /** 等手机作答的秒数；超时后回落给网页端原生弹窗，请求不会丢。 */
  relayTimeoutSec: 120,
  /** 新会话是否自动武装（= 允许手机接管它的审批 / 提问）。默认关闭，避免抢走桌面操作。 */
  autoArm: false,
  /** 手机上保留的动态条数上限（只在内存里，不落盘）。 */
  maxFeed: 100,
}

/** 需要从旧配置里清掉的废弃键（避免看起来还在生效）。 */
const OBSOLETE_KEYS = []

/** 状态默认值。 */
function defaultState() {
  return {
    /** 手机端访问令牌；首次运行生成，此后保持不变。 */
    token: '',
    /** 已武装的会话：`{ [sessionId]: true }`。 */
    armed: {},
  }
}

/**
 * 读 JSON；不存在或损坏都返回 null，由调用方决定默认值。
 *
 * @param {string} file 绝对路径
 * @returns {any | null} 解析结果或 null
 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * 原子写 JSON。
 *
 * @param {string} file 绝对路径
 * @param {unknown} value 待写入的值
 */
function writeJson(file, value) {
  mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
}

/**
 * 生成一个新的访问令牌（128 位随机数，32 位十六进制）。
 *
 * @returns {string} 令牌
 */
export function newToken() {
  return randomBytes(16).toString('hex')
}

/**
 * 读取并归一化运行参数。
 *
 * @returns {typeof DEFAULT_CONFIG} 完整配置
 */
export function loadConfig() {
  const raw = readJson(CONFIG_FILE)
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const config = { ...DEFAULT_CONFIG }

  if (typeof source.enabled === 'boolean') config.enabled = source.enabled
  if (Number.isInteger(source.port) && source.port >= 1 && source.port <= 65535) config.port = source.port
  if (typeof source.bindHost === 'string' && source.bindHost.trim() !== '') config.bindHost = source.bindHost.trim()
  if (Number.isFinite(source.relayTimeoutSec) && source.relayTimeoutSec >= 5 && source.relayTimeoutSec <= 3600) {
    config.relayTimeoutSec = Math.round(source.relayTimeoutSec)
  }
  if (typeof source.autoArm === 'boolean') config.autoArm = source.autoArm
  if (Number.isInteger(source.maxFeed) && source.maxFeed >= 10 && source.maxFeed <= 2000) config.maxFeed = source.maxFeed

  let dirty = raw === null
  for (const key of OBSOLETE_KEYS) {
    if (key in config) {
      delete config[key]
      dirty = true
    }
  }
  // 只在文件缺失或结构异常时回写，避免每次启动都动用户的文件。
  if (dirty || raw === null) {
    try {
      writeJson(CONFIG_FILE, config)
    } catch (error) {
      log(`config: 写入失败 ${String(error)}`)
    }
  }
  return config
}

/**
 * 写回运行参数。
 *
 * @param {typeof DEFAULT_CONFIG} config 完整配置
 */
export function saveConfig(config) {
  writeJson(CONFIG_FILE, config)
}

/**
 * 读取状态；令牌缺失时生成一个并立刻落盘。
 *
 * @returns {{token: string, armed: Record<string, boolean>}} 状态
 */
export function loadState() {
  const raw = readJson(STATE_FILE)
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const state = { ...defaultState(), ...source }
  if (state.armed === null || typeof state.armed !== 'object' || Array.isArray(state.armed)) state.armed = {}

  let dirty = false
  if (typeof state.token !== 'string' || !/^[0-9a-f]{16,128}$/.test(state.token)) {
    state.token = newToken()
    dirty = true
    log('state: 已生成新的访问令牌（旧的手机配对链接将失效）')
  }
  if (dirty) writeJson(STATE_FILE, state)
  return state
}

/**
 * 写回状态。
 *
 * @param {{token: string, armed: Record<string, boolean>}} state 完整状态
 */
export function saveState(state) {
  writeJson(STATE_FILE, state)
}

/**
 * 创建一个「合并短时间内的多次改动、只写一次盘」的保存器。
 *
 * 武装 / 取消武装会在手机上被连点，逐次落盘既慢也无必要。
 *
 * @param {() => object} snapshot 返回当前完整状态
 * @returns {{schedule: () => void, flush: () => void}} 保存器
 */
export function createStateSaver(snapshot) {
  let timer = null
  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    try {
      writeJson(STATE_FILE, snapshot())
    } catch (error) {
      log(`state: 保存失败 ${String(error)}`)
    }
  }
  return {
    schedule() {
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        flush()
      }, 500)
      // 不要因为一个待写的状态文件阻止进程退出。
      timer.unref?.()
    },
    flush,
  }
}
