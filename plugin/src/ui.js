// 手机端静态资源装载。
//
// 界面是真实的 `ui/*.html|css|js` 文件（不是塞在 JS 字符串里的大段模板），这样能正常
// 语法高亮与审查。代价是运行时要读盘——这里做了 mtime 缓存，只有文件真的变了才重新读，
// 开发期改完刷新手机页面就能看到，不用重启宿主。

import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 版本透传：外壳用 `?v=` 重新加载时整张模块图都要重新求值（见 boot.js）。
const VERSION = new URL(import.meta.url).search
const { log } = await import(`./log.js${VERSION}`)

const HERE = dirname(fileURLToPath(import.meta.url))
const UI_DIR = join(HERE, '..', 'ui')

/** 每个资源一份缓存：`{ mtimeMs, body }`。 */
const cache = new Map()

/**
 * 读取一个界面资源，带 mtime 缓存。
 *
 * @param {string} name 文件名（index.html / app.css / app.js）
 * @returns {string | null} 内容；读取失败返回 null
 */
export function readAsset(name) {
  const file = join(UI_DIR, name)
  let mtimeMs = 0
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch (error) {
    log(`ui: 资源缺失 ${name} ${String(error)}`)
    return null
  }
  const hit = cache.get(name)
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.body
  try {
    const body = readFileSync(file, 'utf-8')
    cache.set(name, { mtimeMs, body })
    return body
  } catch (error) {
    log(`ui: 读取失败 ${name} ${String(error)}`)
    return null
  }
}

/** 手机端页面。 */
export function indexHtml() {
  return readAsset('index.html') ?? '<!doctype html><meta charset="utf-8"><h1>界面资源缺失</h1>'
}

/** 手机端样式。 */
export function appCss() {
  return readAsset('app.css') ?? ''
}

/** 手机端脚本。 */
export function appJs() {
  return readAsset('app.js') ?? ''
}
