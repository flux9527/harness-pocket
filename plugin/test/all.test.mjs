// 总测试入口：逐个套件跑，每个套件**独立进程**。
//
// 为什么要分进程：插件的数据目录（`DATA_DIR`）在模块加载时就由 DSH_HOME 定下来了，
// 同进程内先跑的套件会把这个值钉死，后面的套件就写不到自己的临时目录里。分进程还顺带
// 让「装配 → 卸载 → 再装配」这条最容易出问题的路径每次都是干净状态。
//
// 用 `stdio: 'inherit'` 而不是管道：受限沙箱下带管道的 spawn 会 EPERM，而继承 stdio 可用；
// 顺带让每个套件的失败点直接打在同一个输出里。

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 套件顺序：纯函数 → 桥接 → 传输 → 装配 → 浏览器半边。QR 放最前面（最快、最独立）。 */
const SUITES = ['qr.test.mjs', 'bridge.test.mjs', 'server.test.mjs', 'wiring.test.mjs', 'client.test.mjs']

let failed = 0
const results = []

for (const suite of SUITES) {
  process.stdout.write(`\n${'='.repeat(60)}\n▶ ${suite}\n${'='.repeat(60)}\n`)
  const result = spawnSync(process.execPath, [join(HERE, suite)], { stdio: 'inherit' })
  const status = result.status ?? 1
  results.push({ suite, status })
  if (status !== 0) failed += 1
}

process.stdout.write(`\n${'='.repeat(60)}\n汇总\n${'='.repeat(60)}\n`)
for (const item of results) {
  process.stdout.write(`${item.status === 0 ? '✅' : '❌'} ${item.suite}（退出码 ${item.status}）\n`)
}
process.stdout.write(`\n${results.length - failed}/${results.length} 个套件通过\n`)
process.exitCode = failed === 0 ? 0 : 1
