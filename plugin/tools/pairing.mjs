// 打印配对链接与终端二维码 —— 和 `/mobile qr` 同源，但不需要在 DSH 会话里执行。
//
// 用法：
//   node tools/pairing.mjs [--port 8799]
//
// 链接里的令牌就是 `state.json` 里那个真实令牌，直接发给手机即可。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { asciiQr } from '../src/ascii.js'
import { listLanAddresses } from '../src/net.js'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DATA_DIR = join(DSH_HOME, 'dsh-mobile-console')

const argv = process.argv.slice(2)
const portIndex = argv.indexOf('--port')
let port = 8799
if (portIndex >= 0 && argv[portIndex + 1] !== undefined) port = Number(argv[portIndex + 1])
else {
  // 没指定就看配置里写的起始端口（实际端口可能因为占用顺延过，以 /mobile status 为准）。
  try {
    port = JSON.parse(readFileSync(join(DATA_DIR, 'config.json'), 'utf-8')).port ?? port
  } catch {
    // 用默认值
  }
}

let token
try {
  token = JSON.parse(readFileSync(join(DATA_DIR, 'state.json'), 'utf-8')).token
} catch {
  process.stdout.write(`读不到 ${join(DATA_DIR, 'state.json')} —— 插件还没启动过。\n`)
  process.exit(1)
}

const addresses = listLanAddresses()
if (addresses.length === 0) {
  process.stdout.write('没有找到局域网地址；确认电脑已经连上 Wi-Fi 或有线网。\n')
  process.exit(1)
}

process.stdout.write('配对链接（手机连同一个 Wi-Fi 后打开）：\n')
const urls = addresses.map((address) => `http://${address}:${port}/?k=${token}`)
for (const url of urls) process.stdout.write(`  ${url}\n`)

process.stdout.write('\n或者用这个二维码扫码打开：\n\n')
const art = asciiQr(urls[0])
process.stdout.write(art === '' ? '（二维码生成失败：地址太长，用小屏幕的浏览器扫描 /qr.svg 代替）\n' : `${art}\n`)
