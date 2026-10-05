// 日志与数据目录。
//
// 插件在 DSH 宿主进程里运行，没有自己的 stdout 控制台可以看，所以所有诊断信息
// 都落到 `$DSH_HOME/dsh-mobile-console/plugin.log`。手机连不上时，第一个要看的就是它。
//
// 日志只追加、不做异步：出问题的地方（卸载、断电）恰恰是异步写会丢的地方。

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH 数据根目录；宿主一定会设 DSH_HOME，没设时回落到 `~/.dsh`。 */
export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** 本插件的数据目录（配置、状态、日志都放这里）。 */
export const DATA_DIR = join(DSH_HOME, 'dsh-mobile-console')

/** 日志文件路径。 */
export const LOG_FILE = join(DATA_DIR, 'plugin.log')

/** 超过这个大小就轮转一次，避免长期运行把盘写满。 */
const MAX_LOG_BYTES = 1024 * 1024

/**
 * 追加一行日志。
 *
 * @param {string} line 日志内容（自动补时间戳与换行）
 */
export function log(line) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    // 轮转：只保留一份 .1 备份，够定位最近的问题。
    try {
      if (statSync(LOG_FILE).size > MAX_LOG_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`)
    } catch {
      // 文件不存在（首次）或轮转失败都不影响写日志本身。
    }
    const stamp = new Date().toISOString()
    appendFileSync(LOG_FILE, `${stamp} ${line}\n`, 'utf-8')
  } catch {
    // 日志失败绝不能反过来把插件搞崩；此时也没有更低层的通道可以报告。
  }
}

/**
 * 把任意异常压成一行可读文本。
 *
 * @param {unknown} error 任意抛出物
 * @returns {string} 单行描述
 */
export function describeError(error) {
  if (error instanceof Error) {
    return error.stack === undefined ? `${error.name}: ${error.message}` : error.stack.split('\n').slice(0, 3).join(' | ')
  }
  try {
    return String(error)
  } catch {
    return '(无法序列化的错误)'
  }
}
