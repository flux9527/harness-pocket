/**
 * Zero-dependency QR Code encoder — pure ESM, no imports at all.
 *
 * Fixed choices (matching the production reference encoder used by this plugin):
 *   · byte mode, UTF-8 payload;
 *   · error correction level **M** (the format-information ECC indicator is 00b);
 *   · automatic version 1..10 selection, `null` when the payload does not fit
 *     (level M + byte mode tops out at 213 bytes at version 10).
 *
 * All eight masks are evaluated with the four ISO/IEC 18004 penalty rules and
 * the lowest-scoring one wins. Module grid convention: `modules[row][col]`,
 * `true` = dark. Tables and bit order follow ISO/IEC 18004.
 *
 * The public API is deliberately tiny:
 *   MAX_VERSION, qrMatrix(text, options), qrSvg(text, options), utf8Length(text)
 */

/** Highest supported QR version. */
export const MAX_VERSION = 10

/** Total codewords per version (ECC level M). Index = version. */
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346]

/** Error-correction codewords per block (ECC level M). Index = version. */
const EC_CODEWORDS_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]

/** Number of error-correction blocks (ECC level M). Index = version. */
const EC_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]

/** Alignment-pattern centre coordinates per version; version 1 has none. */
const ALIGNMENT_CENTRES = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
]

/** The five valid mask patterns, 0..7 (index is the mask number). */
const MASKS = [0, 1, 2, 3, 4, 5, 6, 7]

/** Data capacity of a version (in codewords) under ECC level M. */
function dataCodewordsFor(version) {
  return TOTAL_CODEWORDS[version] - EC_CODEWORDS_PER_BLOCK[version] * EC_BLOCKS[version]
}

/** Character-count indicator width: 16 bits from version 10 up, else 8. */
function countIndicatorBits(version) {
  return version >= 10 ? 16 : 8
}

// ── UTF-8 ─────────────────────────────────────────────────────────────────

/**
 * Encode text to UTF-8 bytes by hand (no TextEncoder / Buffer dependency),
 * following the same well-formedness rules as the WHATWG encoder: unpaired
 * surrogates become U+FFFD.
 *
 * @param {string} text source text
 * @returns {number[]} UTF-8 bytes
 */
function utf8Bytes(text) {
  const bytes = []
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
        i++
      } else {
        code = 0xfffd // lone high surrogate
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd // lone low surrogate
    }

    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return bytes
}

/**
 * Byte length of the UTF-8 encoding of `text`.
 *
 * @param {string} text source text
 * @returns {number} byte count
 */
export function utf8Length(text) {
  return utf8Bytes(text).length
}

// ── GF(2^8) arithmetic, primitive polynomial 0x11D ────────────────────────

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)

{
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  // Duplicated second half: exponent sums reach 508, so no modulo is needed.
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
}

/**
 * Multiply two field elements.
 *
 * @param {number} a factor
 * @param {number} b factor
 * @returns {number} product
 */
function gfMultiply(a, b) {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

const generatorCache = new Map()

/**
 * Generator polynomial g(x) = prod(x - a^i), coefficients in descending order
 * (leading coefficient always 1, length degree + 1).
 *
 * @param {number} degree number of EC codewords
 * @returns {number[]} coefficients
 */
function generatorPolynomial(degree) {
  const cached = generatorCache.get(degree)
  if (cached !== undefined) return cached

  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j] // subtraction in GF(2^8) is XOR
      next[j + 1] ^= gfMultiply(poly[j], GF_EXP[i])
    }
    poly = next
  }
  generatorCache.set(degree, poly)
  return poly
}

/**
 * Reed-Solomon remainder m(x)*x^degree mod g(x), i.e. the EC codewords of one
 * block, computed by synthetic division.
 *
 * @param {number[]} data block data codewords
 * @param {number} degree number of EC codewords
 * @returns {number[]} EC codewords
 */
function rsRemainder(data, degree) {
  const generator = generatorPolynomial(degree)
  const remainder = new Array(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    remainder.shift()
    remainder.push(0)
    for (let i = 0; i < degree; i++) remainder[i] ^= gfMultiply(generator[i + 1], factor)
  }
  return remainder
}

// ── Bit stream and codewords ──────────────────────────────────────────────

/**
 * Append the low `length` bits of `value`, most significant bit first.
 *
 * @param {number[]} bits destination
 * @param {number} value value
 * @param {number} length bit count
 */
function pushBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
}

/**
 * Smallest version that fits `byteLength` bytes, or null if none does.
 *
 * @param {number} byteLength payload size in bytes
 * @returns {number | null} version
 */
function pickVersion(byteLength) {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const capacityBits = dataCodewordsFor(version) * 8
    if (4 + countIndicatorBits(version) + byteLength * 8 <= capacityBits) return version
  }
  return null
}

/**
 * Assemble the data codewords: mode indicator, character count, payload,
 * terminator, byte alignment and the alternating 0xEC/0x11 pad codewords.
 *
 * @param {number[]} bytes payload bytes
 * @param {number} version chosen version
 * @returns {number[]} data codewords
 */
function buildDataCodewords(bytes, version) {
  const capacityBits = dataCodewordsFor(version) * 8
  const bits = []

  pushBits(bits, 0b0100, 4) // byte mode
  pushBits(bits, bytes.length, countIndicatorBits(version))
  for (const byte of bytes) pushBits(bits, byte, 8)

  pushBits(bits, 0, Math.min(4, capacityBits - bits.length)) // terminator
  pushBits(bits, 0, (8 - (bits.length % 8)) % 8) // pad to byte boundary

  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xfd) pushBits(bits, pad, 8)

  const codewords = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
    codewords.push(byte)
  }
  return codewords
}

/**
 * Split data into blocks, add EC codewords per block, then interleave both
 * sequences as the specification requires (long blocks last).
 *
 * @param {number[]} data data codewords
 * @param {number} version chosen version
 * @returns {number[]} interleaved final codewords
 */
function addErrorCorrection(data, version) {
  const blockCount = EC_BLOCKS[version]
  const ecLength = EC_CODEWORDS_PER_BLOCK[version]
  const shortLength = Math.floor(data.length / blockCount)
  const longBlocks = data.length % blockCount

  const dataBlocks = []
  const ecBlocks = []
  let offset = 0
  for (let i = 0; i < blockCount; i++) {
    const length = shortLength + (i >= blockCount - longBlocks ? 1 : 0)
    const block = data.slice(offset, offset + length)
    offset += length
    dataBlocks.push(block)
    ecBlocks.push(rsRemainder(block, ecLength))
  }

  const result = []
  const maxLength = shortLength + (longBlocks > 0 ? 1 : 0)
  for (let i = 0; i < maxLength; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i])
  }
  for (let i = 0; i < ecLength; i++) {
    for (const block of ecBlocks) result.push(block[i])
  }
  return result
}

// ── Matrix construction ───────────────────────────────────────────────────

/**
 * `size` x `size` grid filled with `fill`.
 *
 * @param {number} size edge length
 * @param {number | boolean} fill initial value
 * @returns {any[][]} grid
 */
function createGrid(size, fill) {
  return Array.from({ length: size }, () => new Array(size).fill(fill))
}

/**
 * Draw one finder pattern plus its light separator, marking every touched
 * module as reserved. The loop starts at -1 so the separator is included.
 *
 * @param {number[][]} modules module grid
 * @param {boolean[][]} reserved function-module flags
 * @param {number} size edge length
 * @param {number} top pattern top row
 * @param {number} left pattern left column
 */
function drawFinder(modules, reserved, size, top, left) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const row = top + dr
      const col = left + dc
      if (row < 0 || row >= size || col < 0 || col >= size) continue
      const inCore = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
      const dark = inCore && (
        dr === 0 || dr === 6 || dc === 0 || dc === 6
        || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)
      )
      modules[row][col] = dark ? 1 : 0
      reserved[row][col] = true
    }
  }
}

/**
 * Draw all function patterns and reserve the format/version information areas.
 * Values that depend on the mask (format bits) are written later.
 *
 * @param {number[][]} modules module grid
 * @param {boolean[][]} reserved function-module flags
 * @param {number} version chosen version
 */
function drawFunctionPatterns(modules, reserved, version) {
  const size = version * 4 + 17

  drawFinder(modules, reserved, size, 0, 0)
  drawFinder(modules, reserved, size, 0, size - 7)
  drawFinder(modules, reserved, size, size - 7, 0)

  // Timing patterns: row 6 and column 6, alternating, between the finders.
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0 ? 1 : 0
    modules[6][i] = dark
    reserved[6][i] = true
    modules[i][6] = dark
    reserved[i][6] = true
  }

  // Alignment patterns, skipping the three that would overlap a finder.
  const centres = ALIGNMENT_CENTRES[version]
  const finderCorners = [[6, 6], [6, size - 7], [size - 7, 6]]
  for (const row of centres) {
    for (const col of centres) {
      if (finderCorners.some(([fr, fc]) => fr === row && fc === col)) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1
          modules[row + dr][col + dc] = dark ? 1 : 0
          reserved[row + dr][col + dc] = true
        }
      }
    }
  }

  // Reserve the format-information area (both copies). (8,6) and (6,8) stay
  // timing modules even though they are flagged here.
  for (let i = 0; i <= 8; i++) {
    reserved[8][i] = true
    reserved[i][8] = true
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true
    reserved[size - 1 - i][8] = true
  }

  // The fixed dark module.
  modules[size - 8][8] = 1
  reserved[size - 8][8] = true

  // Version information (version >= 7 only), BCH(18,6), two copies.
  if (version >= 7) {
    let remainder = version
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
    const bits = (version << 12) | remainder
    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      modules[b][a] = bit
      reserved[b][a] = true
      modules[a][b] = bit
      reserved[a][b] = true
    }
  }
}

/**
 * Fill the data area with codeword bits: two columns at a time, right to left,
 * snaking up/down, skipping the column-6 timing line.
 *
 * @param {number[][]} modules module grid
 * @param {boolean[][]} reserved function-module flags
 * @param {number} size edge length
 * @param {number[]} codewords final codewords
 */
function drawCodewords(modules, reserved, size, codewords) {
  const totalBits = codewords.length * 8
  let bitIndex = 0

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5 // skip the vertical timing column
    const upward = ((right + 1) & 2) === 0
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j
        const row = upward ? size - 1 - vertical : vertical
        if (reserved[row][col] || bitIndex >= totalBits) continue
        modules[row][col] = (codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1
        bitIndex++
      }
    }
  }
}

/**
 * Does the mask invert the module at (row, col)?
 *
 * @param {number} mask mask number 0..7
 * @param {number} row row
 * @param {number} col column
 * @returns {boolean} whether to invert
 */
function maskApplies(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0
    case 1: return row % 2 === 0
    case 2: return col % 3 === 0
    case 3: return (row + col) % 3 === 0
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
  }
}

/**
 * XOR the mask into every non-function module.
 *
 * @param {number[][]} modules module grid
 * @param {boolean[][]} reserved function-module flags
 * @param {number} mask mask number
 */
function applyMask(modules, reserved, mask) {
  const size = modules.length
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!reserved[row][col] && maskApplies(mask, row, col)) modules[row][col] ^= 1
    }
  }
}

/**
 * 15-bit format information for ECC level M and the given mask:
 * 5 data bits, BCH(15,5) remainder, then XOR with 0x5412.
 *
 * @param {number} mask mask number 0..7
 * @returns {number} 15-bit value
 */
function formatBits(mask) {
  const data = mask // top two bits are 00 = level M
  let remainder = data << 10
  for (let i = 14; i >= 10; i--) {
    if (((remainder >>> i) & 1) !== 0) remainder ^= 0x537 << (i - 10)
  }
  return ((data << 10) | (remainder & 0x3ff)) ^ 0x5412
}

/**
 * Write both copies of the format information.
 *
 * @param {number[][]} modules module grid
 * @param {number} size edge length
 * @param {number} mask mask number
 */
function drawFormatBits(modules, size, mask) {
  const bits = formatBits(mask)
  const bit = (i) => (bits >>> i) & 1

  for (let i = 0; i <= 5; i++) modules[i][8] = bit(i)
  modules[7][8] = bit(6)
  modules[8][8] = bit(7)
  modules[8][7] = bit(8)
  for (let i = 9; i < 15; i++) modules[8][14 - i] = bit(i)

  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = bit(i)
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = bit(i)
}

/**
 * Count overlapping occurrences of `pattern` inside `line`.
 *
 * @param {string} line line of '0'/'1' characters
 * @param {string} pattern pattern to count
 * @returns {number} occurrences
 */
function countOccurrences(line, pattern) {
  let count = 0
  for (let i = 0; i + pattern.length <= line.length; i++) {
    let hit = true
    for (let j = 0; j < pattern.length; j++) {
      if (line[i + j] !== pattern[j]) {
        hit = false
        break
      }
    }
    if (hit) count++
  }
  return count
}

/** The two finder-like patterns penalised by mask rule 3. */
const RULE3_PATTERNS = ['10111010000', '00001011101']

/**
 * Sum of the four mask penalty rules (lower is better).
 *
 * @param {number[][]} modules module grid
 * @returns {number} penalty score
 */
function penaltyScore(modules) {
  const size = modules.length
  let score = 0

  // Rule 1 — runs of five or more same-coloured modules: 3 + (run - 5).
  const runPenalty = (lineAt) => {
    let run = 1
    for (let pos = 1; pos < size; pos++) {
      if (lineAt(pos) === lineAt(pos - 1)) {
        run++
      } else {
        if (run >= 5) score += run - 2
        run = 1
      }
    }
    if (run >= 5) score += run - 2
  }
  for (let row = 0; row < size; row++) runPenalty((col) => modules[row][col])
  for (let col = 0; col < size; col++) runPenalty((row) => modules[row][col])

  // Rule 2 — every 2x2 block of one colour: +3.
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const value = modules[row][col]
      if (
        value === modules[row][col + 1]
        && value === modules[row + 1][col]
        && value === modules[row + 1][col + 1]
      ) {
        score += 3
      }
    }
  }

  // Rule 3 — finder-like 1:1:3:1:1 patterns: +40 each.
  const lineScore = (lineAt) => {
    let line = ''
    for (let pos = 0; pos < size; pos++) line += lineAt(pos)
    for (const pattern of RULE3_PATTERNS) score += 40 * countOccurrences(line, pattern)
  }
  for (let row = 0; row < size; row++) lineScore((col) => modules[row][col])
  for (let col = 0; col < size; col++) lineScore((row) => modules[row][col])

  // Rule 4 — deviation from 50% dark: +10 per full 5 percentage points.
  let dark = 0
  for (const row of modules) for (const value of row) if (value === 1) dark++
  const percent = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(percent - 50) / 5) * 10

  return score
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Encode `text` into a QR module matrix.
 *
 * @param {string} text payload
 * @param {{mask?: number}} [options] `mask` forces a mask number (0..7)
 * @returns {{version: number, size: number, mask: number, modules: boolean[][]} | null}
 *   null when the payload needs more than version 10 at ECC level M
 */
export function qrMatrix(text, options = {}) {
  const bytes = utf8Bytes(text)
  const version = pickVersion(bytes.length)
  if (version === null) return null

  const size = version * 4 + 17
  const modules = createGrid(size, 0)
  const reserved = createGrid(size, false)
  drawFunctionPatterns(modules, reserved, version)
  drawCodewords(modules, reserved, size, addErrorCorrection(buildDataCodewords(bytes, version), version))

  const forced = options.mask
  const candidates = forced === undefined ? MASKS : [forced]

  let best = null
  for (const mask of candidates) {
    const candidate = modules.map((row) => row.slice())
    applyMask(candidate, reserved, mask)
    drawFormatBits(candidate, size, mask)
    const score = penaltyScore(candidate)
    if (best === null || score < best.score) best = { mask, score, modules: candidate }
  }

  return {
    version,
    size,
    mask: best.mask,
    modules: best.modules.map((row) => row.map((value) => value === 1)),
  }
}

/**
 * Escape a string for use as XML text/attribute content.
 *
 * @param {string} value raw text
 * @returns {string} escaped text
 */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Render `text` as a self-contained SVG (no external references, one `<rect>`
 * per dark module so the output can be verified module by module).
 *
 * @param {string} text payload
 * @param {{margin?: number, scale?: number, dark?: string, light?: string, title?: string, mask?: number}} [options]
 * @returns {string} SVG markup, or '' when the payload does not fit
 */
export function qrSvg(text, options = {}) {
  const matrix = qrMatrix(text, options)
  if (matrix === null) return ''

  const margin = options.margin ?? 4
  const scale = options.scale ?? 8
  const dark = options.dark ?? '#000000'
  const light = options.light ?? '#ffffff'
  const title = options.title ?? ''

  const extent = matrix.size + margin * 2
  const pixels = extent * scale

  let rects = ''
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (!matrix.modules[row][col]) continue
      rects += `<rect x="${col + margin}" y="${row + margin}" width="1" height="1"/>`
    }
  }

  const titleTag = title === '' ? '' : `<title>${escapeXml(title)}</title>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}"`
    + ` viewBox="0 0 ${extent} ${extent}" shape-rendering="crispEdges" role="img">`
    + titleTag
    + `<rect width="${extent}" height="${extent}" fill="${light}"/>`
    + `<g fill="${dark}">${rects}</g>`
    + '</svg>'
}
