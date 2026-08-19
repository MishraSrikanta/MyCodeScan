/**
 * A Code 128 encoder, written out rather than installed.
 *
 * Why not a library: the app has four dependencies and this is ~120 lines of table lookup
 * with no runtime and no DOM. A barcode generator is also the one thing here that must be
 * *exactly* right — a label that scans as the wrong number is worse than one that does not
 * scan at all — so it is worth having the arithmetic where it can be read and tested.
 *
 * Code 128 is the right symbology for this job:
 *
 *   · It carries letters, so a sub-quantity marker can be a letter rather than stolen from
 *     the digit space. EAN-13 and UPC-A are fixed-length digits only and could not hold
 *     `200002222S5` at all.
 *   · It has no fixed length, so a nine-digit parent code with a suffix is fine.
 *   · Its check character is part of the symbol, not the payload. A misread does not decode
 *     to a *different* quantity — it fails to decode. That is what makes it safe to put a
 *     weight inside a barcode without a checksum of our own.
 *
 * The app's own scanner already lists `code_128` first among the formats it accepts, so
 * labels printed here are read by the same phones that read the shop's supplier barcodes.
 *
 * ── The table ────────────────────────────────────────────────────────────────
 * Each of the 107 symbols is six alternating widths — bar, space, bar, space, bar, space —
 * in modules, summing to 11. The stop symbol is the exception: seven widths, summing to 13.
 * `assertTableSound()` checks both invariants; the test suite calls it, so a typo in the
 * table fails a test rather than printing crooked labels.
 */

/** Symbol patterns for values 0…106. Index 103/104/105 are START A/B/C, 106 is STOP. */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
]

const START_B = 104
const START_C = 105
const STOP = 106
/** Switch codes: value 99 means "code C from here" while in B; 100 means "code B" while in C. */
const TO_C = 99
const TO_B = 100

/** The widest and narrowest characters Code 128 B can carry — printable ASCII. */
const MIN_CHAR = 32
const MAX_CHAR = 126

export class BarcodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BarcodeError'
  }
}

/**
 * Whether a string can be printed as a Code 128 barcode here.
 *
 * Only printable ASCII. Code 128 can technically carry control characters and the FNC
 * codes, but nothing in this app needs them and a label whose payload contains a tab is a
 * label somebody will spend an afternoon on.
 */
export function canEncode(value: string): boolean {
  if (!value) return false
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < MIN_CHAR || code > MAX_CHAR) return false
  }
  return true
}

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9'
}

/** How many digits run from `at`, so the optimiser can decide between code sets. */
function digitRun(value: string, at: number): number {
  let length = 0
  while (at + length < value.length && isDigit(value[at + length])) length += 1
  return length
}

/**
 * Turns a payload into symbol values, choosing code sets to keep the label narrow.
 *
 * Code C packs two digits into one symbol, which matters more than it sounds: a sub-label
 * is printed on something the size of a postage stamp, and every symbol saved is width that
 * can go into the module size instead. `200002222S5` is 13 symbols in pure B and 9 with the
 * leading digits packed — a fifth narrower at the same module width.
 *
 * The rules below are the standard ones: pack a digit run of six or more, or four or more if
 * it ends the payload, and never pack an odd tail.
 */
function toValues(value: string): number[] {
  const values: number[] = []
  let position = 0
  const length = value.length
  const leadingDigits = digitRun(value, 0)

  /* Start in C when there is enough of a digit run at the front to pay for the start symbol. */
  let inC = leadingDigits >= 4 || (leadingDigits === length && length >= 2 && length % 2 === 0)
  values.push(inC ? START_C : START_B)

  while (position < length) {
    const run = digitRun(value, position)

    if (inC) {
      if (run >= 2) {
        const pairs = Math.floor(run / 2)
        for (let pair = 0; pair < pairs; pair += 1) {
          values.push(Number(value.slice(position, position + 2)))
          position += 2
        }
        /* Loop again: what is left is a lone odd digit or a non-digit, both handled below. */
        continue
      }
      values.push(TO_B)
      inC = false
      continue
    }

    const endsPayload = position + run === length
    if ((run >= 6 || (endsPayload && run >= 4)) && run % 2 === 0) {
      values.push(TO_C)
      inC = true
      continue
    }
    /* An odd run long enough to be worth packing: spend one character in B to make it even. */
    if (run >= 7) {
      values.push(value.charCodeAt(position) - MIN_CHAR)
      position += 1
      continue
    }

    values.push(value.charCodeAt(position) - MIN_CHAR)
    position += 1
  }

  /* The mod-103 check symbol: the start value plus each data value times its position. */
  let sum = values[0]
  for (let index = 1; index < values.length; index += 1) sum += values[index] * index
  values.push(sum % 103)
  values.push(STOP)

  return values
}

export interface Code128 {
  /** The payload, unchanged. */
  value: string
  /**
   * Alternating bar and space widths in modules, beginning with a bar and ending with one.
   * Quiet zones are *not* included — the renderer adds them, because how much white space
   * fits beside a label is a layout question.
   */
  widths: number[]
  /** Total width in modules, quiet zones excluded. */
  modules: number
}

/**
 * Encodes a payload.
 *
 * Throws rather than returning null: every caller here has already validated its input, and
 * a barcode that silently fails to render is a label printed blank.
 */
export function encodeCode128(value: string): Code128 {
  if (!canEncode(value)) {
    throw new BarcodeError('A barcode can only hold ordinary printable characters.')
  }

  const widths: number[] = []
  for (const symbol of toValues(value)) {
    for (const width of PATTERNS[symbol]) widths.push(Number(width))
  }

  return { value, widths, modules: widths.reduce((total, width) => total + width, 0) }
}

/**
 * Checks the pattern table's own invariants.
 *
 * Exported so the test suite can call it. Every symbol is three bars and three spaces
 * totalling eleven modules; the stop symbol is the documented exception. A single mistyped
 * digit anywhere in the table breaks one of those two rules, which is why this is worth more
 * than it looks.
 */
export function assertTableSound(): void {
  if (PATTERNS.length !== 107) {
    throw new BarcodeError(`The pattern table has ${PATTERNS.length} symbols, not 107.`)
  }
  PATTERNS.forEach((pattern, index) => {
    const expectedElements = index === STOP ? 7 : 6
    const expectedModules = index === STOP ? 13 : 11
    if (pattern.length !== expectedElements) {
      throw new BarcodeError(`Symbol ${index} has ${pattern.length} elements, not ${expectedElements}.`)
    }
    const total = [...pattern].reduce((sum, width) => sum + Number(width), 0)
    if (total !== expectedModules) {
      throw new BarcodeError(`Symbol ${index} is ${total} modules wide, not ${expectedModules}.`)
    }
  })
}

/**
 * Reads a bar/space width sequence back to its payload — a decoder, for the tests.
 *
 * Here rather than in the test file because it needs the pattern table, and exporting the
 * table so a test can invert it would make the table part of the interface. Round-tripping
 * through this is the only check that proves the encoder produces symbols a *scanner* would
 * agree with, rather than merely self-consistent ones.
 */
export function decodeCode128(widths: number[]): string {
  const lookup = new Map<string, number>()
  PATTERNS.forEach((pattern, index) => lookup.set(pattern, index))

  const symbols: number[] = []
  let at = 0
  while (at < widths.length) {
    /* Six elements each, except the stop symbol's seven — which is also the end. */
    const take = widths.length - at === 7 ? 7 : 6
    const key = widths.slice(at, at + take).join('')
    const symbol = lookup.get(key)
    if (symbol === undefined) throw new BarcodeError(`Unknown symbol at module ${at}: ${key}`)
    symbols.push(symbol)
    at += take
  }

  if (symbols.pop() !== STOP) throw new BarcodeError('The symbol sequence does not end with STOP.')

  const check = symbols.pop()
  let sum = symbols[0]
  for (let index = 1; index < symbols.length; index += 1) sum += symbols[index] * index
  if (check !== sum % 103) throw new BarcodeError(`Check symbol is ${check}, expected ${sum % 103}.`)

  const start = symbols.shift()
  if (start !== START_B && start !== START_C) throw new BarcodeError('Unsupported start symbol.')
  let inC = start === START_C

  let text = ''
  for (const symbol of symbols) {
    if (inC) {
      if (symbol === TO_B) {
        inC = false
        continue
      }
      text += String(symbol).padStart(2, '0')
      continue
    }
    if (symbol === TO_C) {
      inC = true
      continue
    }
    text += String.fromCharCode(symbol + MIN_CHAR)
  }
  return text
}
