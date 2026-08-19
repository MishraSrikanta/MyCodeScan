/**
 * Sub-barcodes: one printed label for one weighed or cut portion of a parent product.
 *
 * The problem this solves. A shop sells 8mm wire by the metre and cashew by the kilo. There
 * is one product in MyStokio, `200002222`, with one barcode — but what crosses the counter
 * is a 5 kg bag or a 12.75 m coil, and scanning the parent barcode can only ever say "one".
 * The weight is written on the bag in biro and typed in at the till, which is where the
 * mistakes are.
 *
 * The fix is to put the quantity *inside* the barcode, so that scanning the bag is scanning
 * "5 kg of 200002222". Nothing new is stored server-side and no product needs a second
 * catalogue entry — the parent barcode is still in the code, so a till that knows nothing
 * about this scheme still finds the product by stripping the suffix.
 *
 * ══ THE FORMAT ═══════════════════════════════════════════════════════════════
 *
 *     <parent barcode> S <quantity>          quantity uses P for the decimal point
 *
 *     200002222   +  5 kg     →  200002222S5
 *     200002222   +  2.5 kg   →  200002222S2P5
 *     200002222   +  0.25 kg  →  200002222S0P25
 *     200002222   +  12.75 m  →  200002222S12P75
 *
 * Five decisions in there, each of which had an alternative:
 *
 *   · **`S` rather than `-`.** A hyphen is already common inside real supplier barcodes and
 *     inside shops' own SKU codes, so a hyphen-delimited suffix collides with codes that
 *     exist. `S` immediately followed by digits and then the end of the string does not
 *     occur by accident in numeric barcodes. `-` is still *accepted* when reading, because
 *     tolerating it costs one character in a regex and rejecting a label somebody already
 *     printed costs an afternoon.
 *
 *   · **`P` for the decimal point.** A literal `.` is legal in Code 128 and would work, but
 *     these codes are also typed by hand into a search box, read aloud across a shop, and
 *     passed through keyboard-wedge scanners with their own punctuation quirks. Keeping the
 *     payload to letters and digits removes a whole class of "it works on my scanner".
 *
 *   · **The unit is not in the barcode.** `200002222S5` means five *of whatever that product
 *     is sold in* — the unit already on the product page in MyStokio. Putting `KG` in the
 *     code would let a label disagree with its own product, and a label that says 5 kg of a
 *     product priced per metre is a worse failure than a label that says 5.
 *
 *   · **No checksum of our own.** Code 128 carries a mod-103 check character inside the
 *     symbol, so a partial or smudged read *fails* rather than decoding to a different
 *     number. A payload checksum would guard against a hand-typed digit, which the editor
 *     in this app already guards against by showing what it parsed.
 *
 *   · **The parent stays whole and stays in front.** Nothing is hashed, shortened or looked
 *     up. Any system can recover the parent with a string operation, offline, with no table.
 *
 * ══ READING A CODE — THE ONE RULE THAT MATTERS ═══════════════════════════════
 *
 * When a scan arrives, look the **whole code up as a product first**. Only if nothing
 * matches should you try parsing it as a sub-barcode. In that order, a real product whose
 * barcode genuinely ends in `S` and digits still wins, and this scheme can never shadow a
 * product that exists. Reversing the order would eventually mis-sell one.
 *
 * ══ THE SECOND FORMAT ════════════════════════════════════════════════════════
 *
 * Everything above describes the Code 128 format, which is the default and the better one.
 * There is a second, all-numeric EAN-13 format further down this file for tills whose
 * scanners cannot read Code 128 at all. It is documented where it is defined.
 *
 * See SUBBARCODE-LOGIC.md for both, written for the MyStokio side.
 */

import { gtinWarning, isValidEan13, toEan13, withCheckDigit } from './ean13'

/* ──────────────────────────────────────────────────────────────── the format ── */

/** What this app prints between the parent code and the quantity. */
export const SUB_MARK = 'S'

/** What it will *read*. `S` is canonical; `-` is tolerated for labels printed elsewhere. */
const READ_MARKS = 'S\\-'

/** Stands in for the decimal point, so the payload stays alphanumeric. */
export const DECIMAL_MARK = 'P'

/** The most decimal places a quantity may carry — grams within a kilo, millilitres in a litre. */
export const MAX_DECIMALS = 3

/**
 * The shortest parent code this will split off.
 *
 * A guard against nonsense, not against collision: `S5` on its own is far more likely to be
 * somebody's internal shelf code than a sub-label for a two-character product.
 */
export const MIN_PARENT_LENGTH = 3

/** Largest quantity accepted. A 10,000 kg sub-portion is a typing mistake, not a sale. */
export const MAX_QTY = 9999

/**
 * `<parent><mark><digits>[P<digits>]` anchored to the end of the string.
 *
 * The leading group is greedy on purpose: it takes the **last** mark that still leaves a
 * valid quantity behind it, so a parent code that itself contains an `S` splits correctly.
 * `A1S2S5` reads as 5 of `A1S2`, which is the only reading that lets a parent code contain
 * the mark at all.
 */
const SUB_PATTERN = new RegExp(`^(.+)[${READ_MARKS}](\\d{1,4}(?:${DECIMAL_MARK}\\d{1,${MAX_DECIMALS}})?)$`)

/* ───────────────────────────────────────────────────────────────── quantities ── */

/**
 * Formats a quantity the way it appears inside a code: plain digits, `P` for the point, and
 * no trailing zeros.
 *
 * Trailing zeros are dropped so that 2.50 and 2.5 produce the *same* code. Two labels for
 * the same portion carrying different barcodes would each need their own entry in every
 * list that groups by code, for no reason a shopkeeper would ever be able to guess.
 */
export function encodeQty(qty: number): string {
  const fixed = qty.toFixed(MAX_DECIMALS)
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
  return trimmed.replace('.', DECIMAL_MARK)
}

/** Reads a quantity back out of a code. Returns NaN for anything malformed. */
export function decodeQty(encoded: string): number {
  const value = Number(encoded.replace(DECIMAL_MARK, '.'))
  return Number.isFinite(value) ? value : Number.NaN
}

/** Why this quantity cannot be printed, or '' when it can. */
export function qtyProblem(qty: number): string {
  if (!Number.isFinite(qty)) return 'Enter a quantity.'
  if (qty <= 0) return 'A quantity has to be more than zero.'
  if (qty > MAX_QTY) return `${MAX_QTY} is the most a single label can carry.`
  /* Compared through the encoder rather than by counting characters, so this agrees with
     what would actually be printed. */
  if (decodeQty(encodeQty(qty)) !== qty) {
    return `A quantity can have at most ${MAX_DECIMALS} decimal places.`
  }
  return ''
}

/* ────────────────────────────────────────────────────────────────── the codes ── */

/**
 * Why this parent barcode cannot be used at all, or '' when it can.
 *
 * Only the three things that genuinely make a label impossible. Anything a shop *might*
 * legitimately have chosen as a barcode is a warning, not a refusal — see `parentWarning`.
 */
export function parentProblem(parent: string): string {
  const code = parent.trim()
  if (!code) return 'Scan or type the product’s own barcode first.'
  if (code.length < MIN_PARENT_LENGTH) return `A product barcode is at least ${MIN_PARENT_LENGTH} characters.`
  if (!/^[\x20-\x7e]+$/.test(code)) return 'That barcode contains characters a printed label cannot carry.'
  return ''
}

/**
 * Something worth saying about a parent before printing, or '' when there is nothing.
 *
 * Two cases, both warnings rather than refusals, and for the same reason: each one is far more
 * often a mistake than not, but neither is *impossible*, and a shop's own numbering is not this
 * app's to overrule.
 *
 *   · **It already looks like a sub-barcode.** Almost always somebody pasted `200002222S5`
 *     where they meant `200002222`, and printing that would make `200002222S5S2` — a label for
 *     two of a five-kilo bag. But it does not actually break anything if it is deliberate: the
 *     greedy split in `parseSubCode` takes the *last* mark, so a nested code still reads back
 *     as exactly the parent that was given. So it is said out loud and then allowed.
 *
 *   · **It is GTIN-shaped with a wrong check digit.** Usually a mistyped digit; occasionally a
 *     shop's own thirteen-digit numbering that was never a GS1 code and never had a check
 *     digit. Refusing the second to catch the first would be the app claiming to know the
 *     shop's numbering better than the shop does.
 */
export function parentWarning(parent: string): string {
  const code = parent.trim()
  if (!code) return ''

  const nested = parseSubCode(code)
  if (nested?.mark === SUB_MARK) {
    return `That already looks like a sub-barcode — ${formatQty(nested.qty)} of ${nested.parent}. If you meant the product’s own barcode, use ${nested.parent}.`
  }

  return gtinWarning(code)
}

/**
 * Builds the printed code. The single function to copy into MyStokio.
 *
 * Throws on invalid input rather than returning something unprintable — the callers here
 * check with `parentProblem`/`qtyProblem` first, and a silently wrong label is the failure
 * this whole module exists to prevent.
 */
export function buildSubCode(parent: string, qty: number): string {
  const code = parent.trim()
  const parentIssue = parentProblem(code)
  if (parentIssue) throw new Error(parentIssue)
  const qtyIssue = qtyProblem(qty)
  if (qtyIssue) throw new Error(qtyIssue)
  return `${code}${SUB_MARK}${encodeQty(qty)}`
}

export interface ParsedSubCode {
  /** The product's own barcode. */
  parent: string
  /** How much of it, in the product's own selling unit. */
  qty: number
  /** Which mark was found — `S` for codes this app printed, `-` for a tolerated older one. */
  mark: string
}

/**
 * Splits a scanned code into parent and quantity, or returns null if it is not one of ours.
 *
 * **Call this second.** Look the whole code up as a product first — see the note at the top
 * of this file. A null here simply means "an ordinary barcode", which is the common case.
 */
export function parseSubCode(code: string): ParsedSubCode | null {
  const trimmed = code.trim()
  const match = SUB_PATTERN.exec(trimmed)
  if (!match) return null

  const [, parent, encodedQty] = match
  if (parent.length < MIN_PARENT_LENGTH) return null

  const qty = decodeQty(encodedQty)
  if (!Number.isFinite(qty) || qty <= 0) return null

  /* The mark sits between the two captures; read it rather than assuming which one matched. */
  const mark = trimmed[parent.length]

  return { parent, qty, mark }
}

/** `200002222S2P5` → `200002222 · 2.5` — for reading aloud and for labels. */
export function describeSubCode(parsed: ParsedSubCode, unit: string): string {
  return `${parsed.parent} · ${formatQty(parsed.qty)}${unit ? ` ${unit}` : ''}`
}

/** A quantity as a person writes it: `2.5`, not `2.500`. */
export function formatQty(qty: number): string {
  return encodeQty(qty).replace(DECIMAL_MARK, '.')
}

/* ══════════════════════════════════════════════ the EAN-13 in-store format ══ */

/**
 * The second format: a sub-barcode that is a genuine, all-numeric EAN-13.
 *
 * ── When to reach for it ────────────────────────────────────────────────────
 * Only when the Code 128 format above cannot be read. Plenty of counter scanners ship with
 * Code 128 disabled in firmware, and on that hardware a `200002222S5` label does not beep no
 * matter how correct the software is. This format is for those tills. Everywhere else the
 * Code 128 format is better, for the reason below.
 *
 * ── The format ──────────────────────────────────────────────────────────────
 *
 *     2  IIIIII  QQQQQ  C          13 digits
 *     │  │       │      └ EAN-13 mod-10 check digit
 *     │  │       └─────── quantity in hundredths: 00500 is 5, 00250 is 2.5, 12345 is 123.45
 *     │  └─────────────── in-store item number: six digits identifying the product
 *     └────────────────── GS1 reserves the 20–29 prefixes for a shop's own codes
 *
 *     EAN-13 parent 8901234567894, 5 kg   →   2 456789 00500 8   →  2456789005008
 *
 * ── The cost, stated plainly ────────────────────────────────────────────────
 * Thirteen digits is not enough room for a whole parent barcode *and* a quantity, so the
 * parent has to be squeezed into six digits and the code stops being self-describing. A
 * lookup is now required to know which product a label is for. That is the entire difference
 * between the two formats, and it is why Code 128 is the default.
 *
 * The squeeze costs a decimal place too: five digits of hundredths reach 999.99, against the
 * three decimal places the Code 128 format carries. Two formats, two limits — a 250 g portion
 * is `0.25` in both, but 12.5 g is only expressible in Code 128.
 *
 * ── What makes the lookup survivable ────────────────────────────────────────
 * The six digits are not assigned; they are **taken from the parent barcode itself** — the
 * last six digits of a GTIN's twelve-digit body, which is the item-reference part that a
 * manufacturer assigns sequentially. So MyStokio needs no new table and no synchronisation:
 * it finds the product by scanning its own catalogue for one whose barcode ends its body with
 * those six digits. The map is derived from data both sides already hold.
 *
 * The price of deriving rather than assigning is that two products can share those six
 * digits. It is uncommon within one shop's range — but it is possible, it is silent, and it
 * would sell the wrong product. So it must be *checked at print time*, against the shop's
 * product list, which is the one moment where somebody is present to resolve it.
 * `itemRefFor` returns the digits; checking them for a clash is the caller's job, and
 * SUBBARCODE-LOGIC.md spells out the query MyStokio should run.
 *
 * A parent that is not GTIN-shaped at all — `WIRE-8`, a shop's own short SKU — has no digits
 * to take, so for those the six-digit number has to be typed once and kept with the label.
 */

export type SubFormat = 'code128' | 'ean13'

/** The GS1-reserved prefix that marks a code as the shop's own. */
export const IN_STORE_PREFIX = '2'

/** Quantities are carried in hundredths — five digits is all the layout leaves for them. */
export const QTY_SCALE = 100

/** Five digits of hundredths: 99999 / 100. */
export const MAX_IN_STORE_QTY = 999.99

/** How many decimal places the EAN-13 format can carry, against `MAX_DECIMALS` for Code 128. */
export const IN_STORE_DECIMALS = 2

/** Digits in the in-store item number. */
const ITEM_REF_LENGTH = 6

/**
 * The six digits that stand for a parent barcode, or '' when they cannot be derived.
 *
 * The last six digits of the GTIN's twelve-digit body — positions 6 through 11 of the
 * normalised thirteen. UPC-A is widened to EAN-13 first, so American and European stock give
 * the same answer for the same product.
 */
export function itemRefFor(parent: string): string {
  const gtin = toEan13(parent.trim())
  if (!gtin) return ''
  return gtin.slice(6, 12)
}

/** Why a six-digit in-store item number is unusable, or '' when it is fine. */
export function itemRefProblem(itemRef: string): string {
  if (!new RegExp(`^\\d{${ITEM_REF_LENGTH}}$`).test(itemRef)) {
    return `An in-store item number is exactly ${ITEM_REF_LENGTH} digits.`
  }
  return ''
}

/** Why a quantity will not fit an EAN-13 sub-barcode, or '' when it will. */
export function inStoreQtyProblem(qty: number): string {
  const general = qtyProblem(qty)
  if (general) return general
  if (qty > MAX_IN_STORE_QTY) {
    return `An EAN-13 label holds at most ${MAX_IN_STORE_QTY}. Use the Code 128 format for more.`
  }
  /* Compared through the scale rather than by counting characters, so this agrees with what
     would actually be printed. */
  if (Math.round(qty * QTY_SCALE) / QTY_SCALE !== qty) {
    return `An EAN-13 label carries ${IN_STORE_DECIMALS} decimal places. Use the Code 128 format for finer amounts.`
  }
  return ''
}

/**
 * Builds the thirteen digits, check digit included.
 *
 * The quantity is rounded to hundredths on the way in — `inStoreQtyProblem` has already
 * refused anything finer, so this only ever tidies floating-point dust like 2.4999999999.
 */
export function buildInStoreEan13(itemRef: string, qty: number): string {
  const refIssue = itemRefProblem(itemRef)
  if (refIssue) throw new Error(refIssue)
  const qtyIssue = inStoreQtyProblem(qty)
  if (qtyIssue) throw new Error(qtyIssue)

  const hundredths = String(Math.round(qty * QTY_SCALE)).padStart(5, '0')
  return withCheckDigit(`${IN_STORE_PREFIX}${itemRef}${hundredths}`)
}

export interface ParsedInStoreEan13 {
  itemRef: string
  qty: number
}

/**
 * Reads an in-store EAN-13 back, or returns null.
 *
 * The check digit is required to match. That is what keeps false positives rare: an ordinary
 * thirteen-digit code beginning with 2 has a one-in-ten chance of passing by luck, and it has
 * to begin with 2 in the first place, which GS1 only allows for codes a shop assigned itself.
 *
 * It cannot, however, distinguish this scheme from *another* in-store scheme in the same
 * reserved range — a supermarket price-embedded label, say. Nothing can; the range is shared
 * by convention and carries no scheme identifier. Worth knowing if a shop already prints its
 * own 2-prefixed codes for something else.
 */
export function parseInStoreEan13(code: string): ParsedInStoreEan13 | null {
  const digits = code.trim()
  if (!/^\d{13}$/.test(digits)) return null
  if (digits[0] !== IN_STORE_PREFIX) return null
  if (!isValidEan13(digits)) return null

  const qty = Number(digits.slice(1 + ITEM_REF_LENGTH, 12)) / QTY_SCALE
  if (qty <= 0) return null

  return { itemRef: digits.slice(1, 1 + ITEM_REF_LENGTH), qty }
}

/* ───────────────────────────────────────────────────────── reading either one ── */

export interface AnySubCode {
  format: SubFormat
  /** The parent barcode, or '' for an EAN-13 sub-code, which only carries a reference to it. */
  parent: string
  /** The five-digit reference, for the EAN-13 format. '' for Code 128. */
  itemRef: string
  qty: number
}

/**
 * Tries both formats, Code 128 first.
 *
 * Order does not matter for correctness here — the two shapes cannot overlap, since a Code 128
 * sub-code must contain a letter or hyphen and an in-store EAN-13 is thirteen digits — but
 * the cheap and common case going first is worth having anyway.
 *
 * Still call this **after** looking the whole code up as a product. That rule does not change.
 */
export function parseAnySubCode(code: string): AnySubCode | null {
  const asCode128 = parseSubCode(code)
  if (asCode128) {
    return { format: 'code128', parent: asCode128.parent, itemRef: '', qty: asCode128.qty }
  }

  const asEan13 = parseInStoreEan13(code)
  if (asEan13) {
    return { format: 'ean13', parent: '', itemRef: asEan13.itemRef, qty: asEan13.qty }
  }

  return null
}
