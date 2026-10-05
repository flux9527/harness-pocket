// Differential test: our encoder must be bit-identical to the production
// reference encoder (dsh-ntfy-remote/qr.js) for every input.
//
// Run with the bundled Node:
//   node qr.test.mjs

import assert from 'node:assert/strict'
import * as mine from '../src/qr.js'

const REFERENCE_URL = process.env.MC_QR_REFERENCE
  ?? 'file:///C:/Users/<你>/.dsh/profiles/desktop/node_modules/dsh-ntfy-remote/qr.js'

// 差分比对需要一份**仓库之外**的参考实现。它随时可能因为 profile 重新解析而消失
// （已经发生过一次），所以这里必须能优雅降级：参考实现不在场时，只跳过差分比对，
// 自包含的规范级校验（格式信息 BCH、版本信息 BCH、暗模块、尺寸/掩码约束……）照跑。
// 想要差分比对时，把参考实现放回去并设置 MC_QR_REFERENCE 指过去即可。
let reference = null
try {
  reference = await import(REFERENCE_URL)
} catch {
  reference = null
}
const HAS_REFERENCE = reference !== null
if (!HAS_REFERENCE) {
  console.log(`\n  ⚠ 找不到参考实现，跳过差分比对：${REFERENCE_URL}`)
  console.log('    （规范级校验仍会全部执行）\n')
}

// ── tiny assertion harness (counts every check) ───────────────────────────
let assertions = 0
let comparisons = 0
let nullComparisons = 0

function check(condition, message) {
  assertions++
  assert.ok(condition, message)
}

function section(name) {
  console.log(`  · ${name}`)
}

/** Normalise the reference's 0/1 grid to booleans for a semantic comparison. */
function toBooleans(modules) {
  return modules.map((row) => row.map((value) => value === 1 || value === true))
}

/**
 * Compare our matrix against the reference for one input.
 * Returns our matrix (or null) so callers can run extra checks.
 */
function compare(text, label) {
  const ours = mine.qrMatrix(text)

  // 自包含的结构检查：不依赖任何外部实现，所以永远要跑。
  if (ours !== null) {
    check(ours.size === ours.version * 4 + 17, `${label}: size is not 4*version+17`)
    check(ours.mask >= 0 && ours.mask <= 7, `${label}: mask out of range`)
    check(
      typeof ours.modules[0][0] === 'boolean',
      `${label}: modules must be boolean[][], got ${typeof ours.modules[0][0]}`,
    )
    check(
      ours.modules.length === ours.size && ours.modules.every((row) => row.length === ours.size),
      `${label}: modules is not ${ours.size}x${ours.size}`,
    )
  }

  if (!HAS_REFERENCE) return ours

  comparisons++
  const theirs = reference.qrMatrix(text)

  if (theirs === null) {
    nullComparisons++
    check(ours === null, `${label}: reference returned null, ours did not`)
    return null
  }

  check(ours !== null, `${label}: ours returned null but the reference encoded it`)
  if (ours === null) return null

  check(ours.version === theirs.version, `${label}: version ${ours.version} != reference ${theirs.version}`)
  check(ours.size === theirs.size, `${label}: size ${ours.size} != reference ${theirs.size}`)
  check(ours.mask === theirs.mask, `${label}: mask ${ours.mask} != reference ${theirs.mask}`)
  check(
    JSON.stringify(ours.modules) === JSON.stringify(toBooleans(theirs.modules)),
    `${label}: module matrix differs from the reference`,
  )
  return ours
}

/** Force every mask number and compare, to test placement/format bits on their own. */
function compareAllMasks(text, label) {
  for (const mask of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const ours = mine.qrMatrix(text, { mask })
    check(ours !== null, `${label} mask ${mask}: ours unexpectedly returned null`)
    if (ours === null) continue
    check(ours.mask === mask, `${label} mask ${mask}: forced mask was not honoured`)

    if (!HAS_REFERENCE) continue
    comparisons++
    const theirs = reference.qrMatrix(text, { mask })
    check(theirs !== null, `${label} mask ${mask}: reference unexpectedly returned null`)
    if (theirs === null) continue
    check(ours.version === theirs.version, `${label} mask ${mask}: version differs`)
    check(
      JSON.stringify(ours.modules) === JSON.stringify(toBooleans(theirs.modules)),
      `${label} mask ${mask}: module matrix differs from the reference`,
    )
  }
}

// ── 1. utf8Length ─────────────────────────────────────────────────────────
section('utf8Length matches TextEncoder byte length')
{
  const samples = [
    '', 'a', 'Hello, world!', '\u00e9', '\u4e2d\u6587', '\ud83d\ude00',
    'http://192.168.1.100:8799/?k=' + '0123456789abcdef0123456789abcdef',
    '\ud83d', '\udc00', 'a\ud800b', '\ud83d\ude00\ud83c\udf89',
  ]
  for (const sample of samples) {
    check(
      mine.utf8Length(sample) === new TextEncoder().encode(sample).length,
      `utf8Length mismatch for ${JSON.stringify(sample)}`,
    )
  }
  check(mine.utf8Length('') === 0, 'utf8Length("") must be 0')
  check(mine.utf8Length('\u00e9') === 2, 'utf8Length of a 2-byte char must be 2')
  check(mine.utf8Length('\u4e2d') === 3, 'utf8Length of a CJK char must be 3')
  check(mine.utf8Length('\ud83d\ude00') === 4, 'utf8Length of an emoji must be 4')
  check(mine.MAX_VERSION === 10, 'MAX_VERSION must be 10')
}

// ── 2. required fixed test strings ────────────────────────────────────────
section('required fixed inputs')
const token = '00112233445566778899aabbccddeeff' // 32 hex chars，测试用的假令牌，一眼可辨
const lanUrl = 'http://192.168.1.100:8799/?k=' + token
check(token.length === 32 && /^[0-9a-f]{32}$/.test(token), 'token fixture must be 32 hex chars')

const REQUIRED = [
  ['LAN URL with 32-char hex token', lanUrl, false],
  ['short ASCII', 'HELLO', false],
  ['Chinese UTF-8 multibyte', '\u5c40\u57df\u7f51\u4e8c\u7ef4\u7801\u6d4b\u8bd5\uff1a\u4f60\u597d\uff0c\u4e16\u754c\uff01', false],
  ['500-character ASCII string', 'x'.repeat(500), true],
  ['empty string', '', false],
  ['exactly at capacity (213 bytes)', 'a'.repeat(213), false],
  ['just over capacity (214 bytes)', 'a'.repeat(214), true],
]

for (const [label, text, expectNull] of REQUIRED) {
  const matrix = compare(text, label)
  if (expectNull) {
    check(matrix === null, `${label}: expected null from our encoder`)
    if (HAS_REFERENCE) check(reference.qrMatrix(text) === null, `${label}: expected null from the reference`)
  } else {
    check(matrix !== null, `${label}: expected a matrix`)
  }
}

// Sanity on the version picked for the LAN URL (level M byte mode).
{
  const urlMatrix = mine.qrMatrix(lanUrl)
  check(urlMatrix.version >= 1 && urlMatrix.version <= 10, 'URL version in 1..10')
  check(
    urlMatrix.size === urlMatrix.version * 4 + 17,
    'URL size derived from version',
  )
  console.log(`      LAN URL -> version ${urlMatrix.version}, size ${urlMatrix.size}, mask ${urlMatrix.mask}`)
}

// Every mask, on a representative set: isolates placement + format bits from
// the penalty-based mask choice.
section('forced masks 0..7')
compareAllMasks(lanUrl, 'LAN URL')
compareAllMasks('\u5c40\u57df\u7f51\u4e8c\u7ef4\u7801', 'Chinese')
compareAllMasks('', 'empty')
compareAllMasks('HELLO', 'short ASCII')

// ── 3. seeded randomized strings ──────────────────────────────────────────
section('20 seeded randomized strings')
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const random = mulberry32(0x5eed1234)
const pick = (chars) => chars[Math.floor(random() * chars.length)]
const range = (min, max) => min + Math.floor(random() * (max - min + 1))

function randomAscii(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~:/?#[]@!$&\'()*+,;=% '
  let out = ''
  for (let i = 0; i < length; i++) out += pick(chars)
  return out
}

function randomHex(length) {
  let out = ''
  for (let i = 0; i < length; i++) out += pick('0123456789abcdef')
  return out
}

function randomCodePoints(length, ranges) {
  let out = ''
  for (let i = 0; i < length; i++) {
    const [lo, hi] = ranges[Math.floor(random() * ranges.length)]
    out += String.fromCodePoint(range(lo, hi))
  }
  return out
}

const CJK = [[0x4e00, 0x9fff], [0x3400, 0x4dbf], [0x3000, 0x303f], [0xff01, 0xff5e]]
const EMOJI = [[0x1f600, 0x1f64f], [0x1f300, 0x1f5ff], [0x1f900, 0x1f9ff]]
const MIXED = [[0x20, 0x7e], [0xa0, 0x2ff], [0x4e00, 0x9fff], [0x1f300, 0x1f64f]]

const randomized = []
for (let i = 0; i < 8; i++) {
  // Every third ASCII fixture is deliberately past the 213-byte capacity.
  randomized.push([`ascii #${i}`, randomAscii(i % 3 === 0 ? range(214, 400) : range(0, 200))])
}
for (let i = 0; i < 4; i++) randomized.push([`hex #${i}`, randomHex(range(32, 140))])
for (let i = 0; i < 4; i++) {
  // CJK is 3 bytes per code point, so the upper end overflows too.
  randomized.push([`cjk #${i}`, randomCodePoints(i % 2 === 0 ? range(5, 60) : range(90, 160), CJK)])
}
for (let i = 0; i < 2; i++) randomized.push([`emoji #${i}`, randomCodePoints(range(5, 60), EMOJI)])
for (let i = 0; i < 2; i++) randomized.push([`mixed #${i}`, randomCodePoints(range(5, 150), MIXED)])

check(randomized.length === 20, 'exactly 20 randomized strings')

let randomizedEncoded = 0
let randomizedNull = 0
for (const [label, text] of randomized) {
  check(typeof text === 'string', `${label}: fixture must be a string`)
  const matrix = compare(text, `${label} (${text.length} chars)`)
  if (matrix === null) randomizedNull++
  else randomizedEncoded++
  check(
    mine.utf8Length(text) === new TextEncoder().encode(text).length,
    `${label}: utf8Length differs from TextEncoder`,
  )
}
check(randomizedEncoded > 0, 'at least one randomized string must encode')
check(randomizedNull > 0, 'at least one randomized string must overflow to null')
console.log(`      ${randomizedEncoded} encoded, ${randomizedNull} returned null`)

// Extra surrogate edge cases, still compared against the reference.
section('surrogate / edge-case parity')
for (const [label, text] of [
  ['lone high surrogate', 'abc\ud83d'],
  ['lone low surrogate', 'abc\udc00'],
  ['reversed surrogate pair', '\udc00\ud83d'],
  ['emoji ZWJ family', '\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67'],
  ['NUL byte', 'a\u0000b'],
  ['newline + CRLF', 'line1\r\nline2\n'],
  ['high code points', '\u{10ffff}\u{10000}\u{2070e}'],
  ['unicode domain URL', 'http://\u4f8b\u5b50.\u6d4b\u8bd5:8799/?k=' + token],
]) {
  compare(text, label)
}

// ── 4. finder patterns ────────────────────────────────────────────────────
section('finder patterns at three corners')
function checkFinder(matrix, top, left, label) {
  for (let dr = 0; dr < 7; dr++) {
    for (let dc = 0; dc < 7; dc++) {
      const expected = dr === 0 || dr === 6 || dc === 0 || dc === 6
        || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)
      check(
        matrix.modules[top + dr][left + dc] === expected,
        `${label}: finder module (${top + dr},${left + dc}) wrong`,
      )
    }
  }
  // Separator (light) directly above/left of the pattern, where in-bounds.
  for (let dc = 0; dc < 8; dc++) {
    if (top - 1 >= 0) check(matrix.modules[top - 1][left + dc] === false, `${label}: top separator not light`)
  }
  for (let dr = 0; dr < 8; dr++) {
    if (left - 1 >= 0) check(matrix.modules[top + dr][left - 1] === false, `${label}: left separator not light`)
  }
}

for (const [label, text] of [['LAN URL', lanUrl], ['Chinese', '\u5c40\u57df\u7f51\u4e8c\u7ef4\u7801\u6d4b\u8bd5'], ['empty', '']]) {
  const matrix = compare(text, `${label} (finder fixture)`)
  if (matrix === null) continue
  const last = matrix.size - 7
  checkFinder(matrix, 0, 0, `${label} top-left`)
  checkFinder(matrix, 0, last, `${label} top-right`)
  checkFinder(matrix, last, 0, `${label} bottom-left`)
  // Bottom-right must NOT contain a finder (it is data/alignment territory).
  const dark = []
  for (let dr = 0; dr < 7; dr++) for (let dc = 0; dc < 7; dc++) dark.push(matrix.modules[last + dr][last + dc])
  check(!(dark[0] && dark[6] && dark[6 * 7] && !dark[8]), `${label}: unexpected finder at bottom-right`)
}

// ── 5. timing patterns ────────────────────────────────────────────────────
section('timing patterns alternate')
for (const [label, text] of [['LAN URL', lanUrl], ['Chinese', '\u5c40\u57df\u7f51\u4e8c\u7ef4\u7801\u6d4b\u8bd5'], ['empty', '']]) {
  const matrix = compare(text, `${label} (timing fixture)`)
  if (matrix === null) continue
  let horizontal = 0
  let vertical = 0
  for (let i = 8; i < matrix.size - 8; i++) {
    const expected = i % 2 === 0
    check(matrix.modules[6][i] === expected, `${label}: horizontal timing at col ${i} wrong`)
    check(matrix.modules[i][6] === expected, `${label}: vertical timing at row ${i} wrong`)
    if (matrix.modules[6][i]) horizontal++
    if (matrix.modules[i][6]) vertical++
  }
  check(horizontal > 0 && vertical > 0, `${label}: timing patterns must contain dark modules`)
  check(
    matrix.modules[6][7] === false && matrix.modules[7][6] === false,
    `${label}: timing must not leak into the separator`,
  )
}

// ── 6. qrSvg ──────────────────────────────────────────────────────────────
section('qrSvg output')
const svgCases = [
  ['LAN URL', lanUrl, { title: 'Scan me' }],
  ['Chinese', '\u5c40\u57df\u7f51\u4e8c\u7ef4\u7801\u6d4b\u8bd5', {}],
  ['empty', '', {}],
  ['short', 'HELLO', { margin: 2, scale: 4, dark: '#123456', light: '#eeeeee' }],
]

for (const [label, text, options] of svgCases) {
  const svg = mine.qrSvg(text, options)
  const matrix = mine.qrMatrix(text, options)
  check(typeof svg === 'string', `${label}: qrSvg must return a string`)
  check(svg.startsWith('<svg'), `${label}: SVG must start with <svg`)
  check(svg.endsWith('</svg>'), `${label}: SVG must end with </svg>`)
  check(!svg.includes('<script'), `${label}: SVG must not contain <script`)
  check(!svg.includes('href') && !svg.includes('xlink') && !svg.includes('url('), `${label}: SVG must not reference anything external`)
  check(!svg.includes('<image'), `${label}: SVG must not embed images`)
  check(svg.includes('shape-rendering="crispEdges"'), `${label}: missing crispEdges`)
  check(/viewBox="0 0 \d+ \d+"/.test(svg), `${label}: missing/invalid viewBox`)
  check(/width="\d+"/.test(svg) && /height="\d+"/.test(svg), `${label}: missing explicit width/height`)
  check(svg.includes('xmlns="http://www.w3.org/2000/svg"'), `${label}: missing xmlns`)

  const margin = options.margin ?? 4
  const scale = options.scale ?? 8
  const extent = matrix.size + margin * 2
  check(svg.includes(`viewBox="0 0 ${extent} ${extent}"`), `${label}: viewBox must include the quiet zone`)
  check(svg.includes(`width="${extent * scale}" height="${extent * scale}"`), `${label}: width/height must be extent*scale`)
  check(svg.includes(`fill="${options.light ?? '#ffffff'}"`), `${label}: light colour missing`)
  check(svg.includes(`<g fill="${options.dark ?? '#000000'}">`), `${label}: dark colour missing`)

  // Exactly one rect per dark module (plus the background rect).
  const rectTags = svg.match(/<rect /g) || []
  const darkRects = svg.match(/<rect x="/g) || []
  const trueCount = matrix.modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0)
  check(rectTags.length === trueCount + 1, `${label}: rect count ${rectTags.length} != dark modules ${trueCount} + background`)
  check(darkRects.length === trueCount, `${label}: dark rect count ${darkRects.length} != dark modules ${trueCount}`)
  check(trueCount > 0, `${label}: a QR code must contain dark modules`)

  // Every dark module is drawn exactly once, at the quiet-zone offset.
  const drawn = new Set()
  for (const match of svg.matchAll(/<rect x="(-?\d+)" y="(-?\d+)" width="1" height="1"\/>/g)) {
    drawn.add(`${match[1]},${match[2]}`)
  }
  check(drawn.size === trueCount, `${label}: duplicate dark rects`)
  let expectedRects = 0
  let missing = 0
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (!matrix.modules[row][col]) continue
      expectedRects++
      if (!drawn.has(`${col + margin},${row + margin}`)) missing++
    }
  }
  check(expectedRects === trueCount, `${label}: internal dark-module count mismatch`)
  check(missing === 0, `${label}: ${missing} dark modules are not drawn`)
  check(
    drawn.size > 0 && [...drawn].every((key) => {
      const [x, y] = key.split(',').map(Number)
      return x >= 0 && y >= 0 && x < extent && y < extent
    }),
    `${label}: a dark rect falls outside the viewBox`,
  )

  // Tag balance sanity (standalone, well-formed enough for an XML consumer).
  check(
    (svg.match(/<rect [^>]*\/>/g) || []).length === rectTags.length,
    `${label}: every <rect> must be self-closing`,
  )
  const opens = (svg.match(/<g[ >]/g) || []).length
  const closes = (svg.match(/<\/g>/g) || []).length
  check(opens === closes, `${label}: <g> tags unbalanced`)
}

// margin 0 must produce a viewBox of exactly the module size.
{
  const zero = mine.qrSvg('HELLO', { margin: 0, scale: 1 })
  const size = mine.qrMatrix('HELLO').size
  check(zero.includes(`viewBox="0 0 ${size} ${size}"`), 'margin 0: viewBox must equal the module size')
  check(zero.includes(`width="${size}" height="${size}"`), 'margin 0 / scale 1: width and height must equal the module size')
  check(!zero.includes('<title>'), 'no title option must produce no <title> element')
}

// Titles are escaped, not injected.
{
  const svg = mine.qrSvg('HELLO', { title: '<script>alert(1)</script>' })
  check(!svg.includes('<script'), 'title: escaped title must not produce a script tag')
  check(svg.includes('&lt;script&gt;'), 'title: title must be XML-escaped')
}

// Overflow -> empty string.
section('qrSvg overflow')
check(mine.qrSvg('x'.repeat(500)) === '', 'qrSvg must return "" for a 500-char string')
check(mine.qrSvg('a'.repeat(214)) === '', 'qrSvg must return "" just over capacity')
check(mine.qrSvg('a'.repeat(213)) !== '', 'qrSvg must render exactly-at-capacity input')

// ── 7. independent spec-level checks (derived from ISO/IEC 18004, not from
//       the reference implementation) ──────────────────────────────────────
section('spec-level checks on our own output')
{
  const readFormat = (matrix, copy) => {
    const size = matrix.size
    let bits = 0
    const set = (i, on) => { if (on) bits |= 1 << i }
    if (copy === 0) {
      for (let i = 0; i <= 5; i++) set(i, matrix.modules[i][8])
      set(6, matrix.modules[7][8])
      set(7, matrix.modules[8][8])
      set(8, matrix.modules[8][7])
      for (let i = 9; i < 15; i++) set(i, matrix.modules[8][14 - i])
    } else {
      for (let i = 0; i < 8; i++) set(i, matrix.modules[8][size - 1 - i])
      for (let i = 8; i < 15; i++) set(i, matrix.modules[size - 15 + i][8])
    }
    return bits
  }

  /** Validate BCH(15,5) format information, return the encoded mask. */
  const decodeFormat = (bits15, label) => {
    const value = bits15 ^ 0x5412
    let remainder = value
    for (let i = 14; i >= 10; i--) if ((remainder >>> i) & 1) remainder ^= 0x537 << (i - 10)
    check(remainder === 0, `${label}: not a valid BCH(15,5) codeword`)
    check(((value >>> 13) & 3) === 0, `${label}: ECC level indicator must be 00b (level M)`)
    return (value >>> 10) & 7
  }

  const specCases = [
    ['LAN URL', lanUrl],
    ['Chinese', '\u5c40\u57df\u7f51\u4e8c\u7ef4\u7801\u6d4b\u8bd5'],
    ['empty', ''],
    ['150 bytes (version >= 7)', 'a'.repeat(150)],
    ['213 bytes (version 10)', 'a'.repeat(213)],
  ]
  let sawVersionInfo = false
  for (const [label, text] of specCases) {
    const matrix = mine.qrMatrix(text)
    check(matrix !== null, `${label}: expected a matrix`)
    if (matrix === null) continue

    const mask0 = decodeFormat(readFormat(matrix, 0), `${label} format copy 0`)
    const mask1 = decodeFormat(readFormat(matrix, 1), `${label} format copy 1`)
    check(mask0 === matrix.mask, `${label}: format copy 0 mask ${mask0} != reported ${matrix.mask}`)
    check(mask1 === matrix.mask, `${label}: format copy 1 mask ${mask1} != reported ${matrix.mask}`)

    check(matrix.modules[matrix.size - 8][8] === true, `${label}: the dark module must be dark`)

    if (matrix.version >= 7) {
      sawVersionInfo = true
      const size = matrix.size
      let bits = 0
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + (i % 3)
        const b = Math.floor(i / 3)
        check(matrix.modules[b][a] === matrix.modules[a][b], `${label}: version info copies differ at bit ${i}`)
        if (matrix.modules[b][a]) bits |= 1 << i
      }
      let remainder = bits
      for (let i = 17; i >= 12; i--) if ((remainder >>> i) & 1) remainder ^= 0x1f25 << (i - 12)
      check(remainder === 0, `${label}: not a valid BCH(18,6) version codeword`)
      check((bits >>> 12) === matrix.version, `${label}: version bits ${bits >>> 12} != ${matrix.version}`)
    }
  }
  check(sawVersionInfo, 'at least one spec case must exercise version information (version >= 7)')
}

// ── summary ───────────────────────────────────────────────────────────────
console.log('')
console.log(`all good: ${assertions} assertions, ${comparisons} matrix comparisons (${nullComparisons} expected-null)`)
if (!HAS_REFERENCE) {
  console.log('note: 差分比对已跳过 —— 参考实现 dsh-ntfy-remote/qr.js 不在场。')
  console.log('      规范级校验（BCH 格式/版本信息、暗模块、尺寸与掩码约束、SVG 输出）全部执行并通过。')
}
