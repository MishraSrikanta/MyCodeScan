/**
 * EAN-13 and UPC-A: check digits, validation, and the symbol itself.
 *
 * ── Why this is here at all ──────────────────────────────────────────────────
 * Two reasons, and the second is the important one.
 *
 * First, most parent barcodes in a shop *are* EAN-13. Knowing that a scanned or typed parent
 * is a well-formed EAN-13 — check digit and all — catches a mistyped digit at the moment the
 * label is being made, rather than at the counter three weeks later. A 13-digit code whose
 * check digit is wrong is almost always a typing slip, and saying so costs one line of
 * arithmetic.
 *
 * Second: plenty of tills are configured to read EAN and UPC only, with Code 128 switched
 * off in the scanner's own firmware. On that hardware a Code 128 sub-label simply does not
 * beep, and no amount of correct software helps. Those shops need a sub-label that *is* an
 * EAN-13, which is what `buildInStoreEan13` in subbarcode.ts produces — and it needs a real
 * EAN-13 symbol, which is what this file draws.
 *
 * ── UPC-A is EAN-13 ─────────────────────────────────────────────────────────
 * A 12-digit UPC-A is an EAN-13 with a leading zero. Everything here normalises to 13 digits
 * on the way in, so a shop with American stock does not need a second code path.
 *
 * ── The symbol ──────────────────────────────────────────────────────────────
 * 95 modules: guard, six left digits, centre guard, six right digits, guard. The first digit
 * is not drawn — it is carried by *which* of two alphabets each left digit uses, which is why
 * the table below has an L/G pattern per leading digit. It prints beside the symbol instead,
 * in the left quiet zone.
 */

/* Left-hand odd parity (set A). */
const SET_A = [
  '0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011',
]

/* Left-hand even parity (set B). */
const SET_B = [
  '0100111', '0110011', '0011011', '0100001', '0011101',
  '0111001', '0000101', '0010001', '0001001', '0010111',
]

/* Right-hand (set C) — the complement of set A. */
const SET_C = [
  '1110010', '1100110', '1101100', '1000010', '1011100',
  '1001110', '1010000', '1000100', '1001000', '1110100',
]

/** Which alphabet each of the six left digits uses, indexed by the leading digit. */
const PARITY = [
  'AAAAAA', 'AABABB', 'AABBAB', 'AABBBA', 'ABAABB',
  'ABBAAB', 'ABBBAA', 'ABABAB', 'ABABBA', 'ABBABA',
]

const GUARD = '101'
const CENTRE = '01010'

/** Total modules in an EAN-13 symbol, quiet zones excluded. */
export const EAN13_MODULES = 95

export class Ean13Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Ean13Error'
  }
}

/**
 * The mod-10 check digit for the twelve digits that precede it.
 *
 * Weights alternate 1, 3 from the left. Pass the first twelve digits of a 13-digit code, or
 * the first eleven of a UPC-A after normalising.
 */
export function ean13CheckDigit(body: string): number {
  if (!/^\d{12}$/.test(body)) throw new Ean13Error('A check digit needs exactly twelve digits.')
  let sum = 0
  for (let index = 0; index < 12; index += 1) {
    sum += Number(body[index]) * (index % 2 === 0 ? 1 : 3)
  }
  return (10 - (sum % 10)) % 10
}

/**
 * Turns a 12-digit UPC-A into its 13-digit EAN-13 equivalent, and leaves EAN-13 alone.
 *
 * Returns '' for anything that is neither, so callers can treat "not a GTIN" as an ordinary
 * outcome — most shop barcodes in this app are not.
 */
export function toEan13(code: string): string {
  const digits = code.trim()
  if (/^\d{13}$/.test(digits)) return digits
  if (/^\d{12}$/.test(digits)) return `0${digits}`
  /* An 8-digit EAN-8 is a different symbology, not a short EAN-13, so it is not widened. */
  return ''
}

/** Whether a code is a well-formed EAN-13 or UPC-A, check digit included. */
export function isValidEan13(code: string): boolean {
  const normalised = toEan13(code)
  if (!normalised) return false
  return ean13CheckDigit(normalised.slice(0, 12)) === Number(normalised[12])
}

/**
 * Why a 13-or-12-digit code is not a valid GTIN, or '' when it is — or when it is not
 * GTIN-shaped at all and the question does not apply.
 *
 * Split out from `isValidEan13` because a *warning* is the right response here, not a
 * rejection. Shops print their own 13-digit codes that were never GS1 codes and never had a
 * check digit; refusing to make a label for one would be the app deciding it knows the shop's
 * numbering better than the shop does.
 */
export function gtinWarning(code: string): string {
  const normalised = toEan13(code)
  if (!normalised) return ''
  if (isValidEan13(normalised)) return ''
  const expected = ean13CheckDigit(normalised.slice(0, 12))
  return `That looks like an EAN-13 but its last digit is ${normalised[12]}, where the check digit should be ${expected}. Worth re-scanning before you print.`
}

/**
 * Appends the correct check digit to twelve digits.
 *
 * Used when building an in-store sub-barcode, where the first twelve digits are chosen by us
 * and the thirteenth has to be computed or no scanner will accept the symbol.
 */
export function withCheckDigit(body: string): string {
  return `${body}${ean13CheckDigit(body)}`
}

export interface Ean13Symbol {
  /** One character per module, '1' for a bar. 95 long. */
  bits: string
  /** The 13 digits, for printing under the symbol. */
  digits: string
  /**
   * Module positions of the guard bars, which are drawn longer than the rest.
   *
   * Not decoration: the descenders are what separate the guard patterns from the digits for a
   * scanner reading the symbol at an angle, and they are what tells a person which way up the
   * label goes.
   */
  guardModules: [number, number][]
}

/**
 * Draws an EAN-13 symbol.
 *
 * Accepts a 12-digit UPC-A or a 13-digit EAN-13. A wrong check digit is *encoded as given*
 * rather than corrected: silently changing the number on a label to something that scans is
 * the one behaviour that could put the wrong barcode on a bag. `gtinWarning` is how the
 * interface tells somebody first.
 */
export function encodeEan13(code: string): Ean13Symbol {
  const digits = toEan13(code)
  if (!digits) throw new Ean13Error('An EAN-13 barcode needs exactly 13 digits (or 12 for UPC-A).')

  const leading = Number(digits[0])
  const parity = PARITY[leading]

  let bits = GUARD
  for (let index = 0; index < 6; index += 1) {
    const digit = Number(digits[index + 1])
    bits += parity[index] === 'A' ? SET_A[digit] : SET_B[digit]
  }
  bits += CENTRE
  for (let index = 7; index < 13; index += 1) {
    bits += SET_C[Number(digits[index])]
  }
  bits += GUARD

  return {
    bits,
    digits,
    /* Start, centre and end guards: 0–2, 45–49, 92–94. */
    guardModules: [
      [0, 3],
      [45, 5],
      [92, 3],
    ],
  }
}
