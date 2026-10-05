// 局域网地址发现。
//
// 手机要能打开就得给出**本机在局域网里的地址**，而不是 127.0.0.1。宿主自己的
// Web 服务绑在环回地址上，所以这一步是手机能否连上的前提。
//
// 只读取网卡状态，不发起任何网络请求。

import { networkInterfaces } from 'node:os'

/**
 * 判断一个地址是不是值得推荐给手机的局域网地址。
 * 优先级：私有网段 > 其它非环回 IPv4。
 *
 * @param {string} address IPv4 地址
 * @returns {number} 分数，越大越优先；0 表示不可用
 */
function scoreAddress(address) {
  const parts = address.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return 0
  const [a, b] = parts
  // 环回与链路本地（169.254/16）对手机没有意义。
  if (a === 127) return 0
  if (a === 169 && b === 254) return 0
  // 常见的家用 / 办公私有网段排前面，手机连上的概率最高。
  if (a === 192 && b === 168) return 100
  if (a === 10) return 90
  if (a === 172 && b >= 16 && b <= 31) return 80
  return 40
}

/**
 * 列出本机所有可用于手机访问的 IPv4 地址，按推荐顺序排列。
 *
 * @returns {string[]} 地址列表（可能为空：完全没有可用网卡时）
 */
export function listLanAddresses() {
  const found = []
  let interfaces
  try {
    interfaces = networkInterfaces()
  } catch {
    return found
  }
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      // family 在不同 Node 版本上可能是 'IPv4' 或 4。
      const isV4 = entry.family === 'IPv4' || entry.family === 4
      if (!isV4 || entry.internal === true) continue
      if (scoreAddress(entry.address) === 0) continue
      if (!found.includes(entry.address)) found.push(entry.address)
    }
  }
  found.sort((left, right) => scoreAddress(right) - scoreAddress(left))
  return found
}

/**
 * 挑一个最适合放进二维码的地址；没有可用网卡时回落到环回地址
 * （此时手机连不上，但桌面浏览器仍可用，便于排查）。
 *
 * @returns {string} IPv4 地址
 */
export function primaryLanAddress() {
  return listLanAddresses()[0] ?? '127.0.0.1'
}
