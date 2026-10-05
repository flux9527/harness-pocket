// 把二维码渲染成字符画，便于直接在对话里扫。
//
// 用途：`/mobile qr`。桌面端打开手机控制台也能看到正规的 SVG 二维码，字符画只是
// 「不想切窗口」时的便利手段，因此清晰度优先于紧凑度：每个模块占 2 个字符宽。

const VERSION = new URL(import.meta.url).search
const { qrMatrix } = await import(`./qr.js${VERSION}`)

/** 静默区宽度（模块数）。二维码规范要求至少 4，字符画里 2 已经够扫。 */
const QUIET = 2

/**
 * 生成二维码字符画。
 *
 * @param {string} text 内容
 * @returns {string} 多行字符画；内容过长无法编码时返回空串
 */
export function asciiQr(text) {
  const matrix = qrMatrix(text)
  if (matrix === null) return ''
  const size = matrix.size
  const width = (size + QUIET * 2) * 2
  const lines = []
  const blank = ' '.repeat(width)
  for (let index = 0; index < QUIET; index += 1) lines.push(blank)
  for (let row = 0; row < size; row += 1) {
    let line = '  '.repeat(QUIET)
    for (let col = 0; col < size; col += 1) line += matrix.modules[row][col] ? '██' : '  '
    line += '  '.repeat(QUIET)
    lines.push(line)
  }
  for (let index = 0; index < QUIET; index += 1) lines.push(blank)
  return lines.join('\n')
}
