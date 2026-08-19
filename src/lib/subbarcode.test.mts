/**
 * The sub-barcode format, checked.
 *
 * Run with `npm run test:sub`. Same shape as queue.test.mts: bundled with esbuild, run on
 * plain node, no test framework.
 *
 * ── What is worth testing here, and what is not ─────────────────────────────
 * This file exists because of one specific failure: a label that scans cleanly as the *wrong
 * quantity*. Nothing else in the app can lose a shop money silently. So the tests below are
 * heavy on the two properties that prevent it —
 *
 *   · **Round trip.** Whatever `buildSubCode` writes, `parseSubCode` must read back as the
 *     same parent and the same number, for every combination of a parent shape and a quantity
 *     shape. A format that is 99% reversible is a format that mis-sells one label in a hundred.
 *
 *   · **No cross-talk.** The Code 128 format and the EAN-13 format must never parse as one
 *     another, and neither may claim an ordinary supplier barcode. This is the check that
 *     matters most, because a false positive here does not fail — it succeeds, at the wrong
 *     number.
 *
 * The barcode *symbols* are checked by round-tripping through `decodeCode128`, which reads the
 * bar widths back the way a scanner would rather than trusting the encoder's own arithmetic.
 */

import { assertTableSound, decodeCode128, encodeCode128 } from './code128'
import { EAN13_MODULES, ean13CheckDigit, encodeEan13, gtinWarning, isValidEan13, toEan13 } from './ean13'
import {
  buildInStoreEan13,
  buildSubCode,
  encodeQty,
  formatQty,
  inStoreQtyProblem,
  itemRefFor,
  parentProblem,
  parentWarning,
  parseAnySubCode,
  parseInStoreEan13,
  parseSubCode,
  qtyProblem,
} from './subbarcode'

let checks = 0

function ok(condition: unknown, what: string): void {
  checks += 1
  if (!condition) throw new Error(`FAIL: ${what}`)
}

function eq(actual: unknown, expected: unknown, what: string): void {
  checks += 1
  if (actual !== expected) {
    throw new Error(`FAIL: ${what} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

/* ─────────────────────────────────────────────────────────────────── code 128 ── */

/* Catches a typo anywhere in the 107-symbol table. */
assertTableSound()

for (const payload of ['200002222S5', '200002222S2P5', 'WIRE-8S12P75', '2234567005005', '1', '12']) {
  eq(decodeCode128(encodeCode128(payload).widths), payload, `code 128 round trip: ${payload}`)
}

/* Every four-character payload over an alphabet that exercises both code sets and the
   switches between them. This is what catches an off-by-one in the optimiser: a payload that
   switches to code C with an odd digit left over encodes fine and decodes shifted by one. */
{
  const alphabet = [...'019AZS-P']
  let exhaustive = 0
  for (const a of alphabet) {
    for (const b of alphabet) {
      for (const c of alphabet) {
        for (const d of alphabet) {
          const payload = a + b + c + d
          if (decodeCode128(encodeCode128(payload).widths) !== payload) {
            throw new Error(`FAIL: code 128 round trip: ${payload}`)
          }
          exhaustive += 1
        }
      }
    }
  }
  ok(exhaustive === 4096, 'exhaustive four-character sweep ran')
  checks += exhaustive
}

/* ───────────────────────────────────────────────────────────────────── ean-13 ── */

eq(ean13CheckDigit('400638133393'), 1, 'known EAN-13 check digit')
ok(isValidEan13('4006381333931'), 'a real EAN-13 validates')
ok(!isValidEan13('4006381333932'), 'a wrong check digit is refused')
eq(toEan13('036000291452'), '0036000291452', 'UPC-A widens to EAN-13')
ok(isValidEan13('036000291452'), 'a real UPC-A validates through the widening')
eq(toEan13('WIRE-8'), '', 'a non-GTIN is not widened')
eq(toEan13('12345678'), '', 'an EAN-8 is not a short EAN-13')
eq(gtinWarning('WIRE-8'), '', 'a non-GTIN gets no GTIN warning')
eq(gtinWarning('4006381333931'), '', 'a valid GTIN gets no warning')
ok(gtinWarning('4006381333932').includes('should be 1'), 'a bad check digit is named, not just flagged')

{
  const symbol = encodeEan13('4006381333931')
  eq(symbol.bits.length, EAN13_MODULES, 'an EAN-13 symbol is 95 modules')
  eq(symbol.bits.slice(0, 3), '101', 'start guard')
  eq(symbol.bits.slice(45, 50), '01010', 'centre guard')
  eq(symbol.bits.slice(92), '101', 'end guard')
  eq(symbol.digits, '4006381333931', 'the digits are carried through for printing')
}

/* ────────────────────────────────────────────────── the code 128 sub format ── */

eq(buildSubCode('200002222', 5), '200002222S5', '5 kg of 200002222')
eq(buildSubCode('200002222', 2.5), '200002222S2P5', '2.5 kg')
eq(buildSubCode('200002222', 0.25), '200002222S0P25', '250 g')
eq(buildSubCode('200002222', 12.75), '200002222S12P75', '12.75 m')
eq(buildSubCode('200002222', 2.5), buildSubCode('200002222', 2.5000), 'trailing zeros collapse to one code')
eq(encodeQty(1000), '1000', 'a whole number carries no decimal mark')
eq(formatQty(2.5), '2.5', 'quantities read back as people write them')

eq(parseSubCode('200002222S5')?.parent, '200002222', 'the parent comes back')
eq(parseSubCode('200002222S5')?.qty, 5, 'the quantity comes back')
eq(parseSubCode('200002222S2P5')?.qty, 2.5, 'a decimal quantity comes back')
eq(parseSubCode('200002222S0P25')?.qty, 0.25, 'a sub-unit quantity comes back')
eq(parseSubCode('200002222'), null, 'a plain parent barcode is not a sub-code')
eq(parseSubCode('4006381333931'), null, 'a supplier EAN-13 is not a Code 128 sub-code')
eq(parseSubCode('S5'), null, 'a parent below the minimum length is refused')
eq(parseSubCode('200002222S'), null, 'a mark with no quantity is refused')
eq(parseSubCode('200002222S0'), null, 'a zero quantity is refused')

/* The greedy split. A parent that itself contains the mark must still come back whole. */
eq(parseSubCode('A1S2S5')?.parent, 'A1S2', 'the last mark wins, so a parent may contain S')
eq(parseSubCode('A1S2S5')?.qty, 5, 'and the quantity is the one after it')
eq(parseSubCode('WIRE-8-12')?.parent, 'WIRE-8', 'a hyphen is tolerated when reading')
eq(parseSubCode('WIRE-8-12')?.mark, '-', 'and the mark that was found is reported')

/* `ABCS1` is in this list on purpose: it is a parent that itself reads as a sub-code, and the
   greedy split has to hand it back whole rather than peeling `S1` off it. */
for (const parent of ['200002222', '4006381333931', 'WIRE-8', 'ABCS1', 'X-Y-Z', '036000291452']) {
  for (const qty of [0.001, 0.25, 1, 2.5, 5, 12.75, 999, 9999]) {
    const code = buildSubCode(parent, qty)
    eq(parseSubCode(code)?.parent, parent, `parent survives ${code}`)
    eq(parseSubCode(code)?.qty, qty, `quantity survives ${code}`)
    eq(decodeCode128(encodeCode128(code).widths), code, `${code} prints and reads back`)
  }
}

ok(parentProblem('') !== '', 'an empty parent is refused')
ok(parentProblem('AB') !== '', 'a two-character parent is refused')
eq(parentProblem('200002222'), '', 'an ordinary parent is accepted')
eq(parentProblem('WIRE-8'), '', 'a hyphenated shop SKU is still allowed as a parent')

/* A parent that looks like a sub-code is warned about but not refused, and nesting it still
   round-trips — which is what makes allowing it defensible rather than merely permissive. */
eq(parentProblem('200002222S5'), '', 'a sub-code-shaped parent is not blocked')
ok(parentWarning('200002222S5').includes('200002222'), 'but it is warned about, naming the likely parent')
eq(parentWarning('200002222'), '', 'an ordinary parent draws no warning')
ok(parentWarning('4006381333932').includes('should be 1'), 'a GTIN with a bad check digit is warned about')
eq(parseSubCode(buildSubCode('200002222S5', 3))?.parent, '200002222S5', 'a nested parent still comes back whole')
eq(parseSubCode(buildSubCode('200002222S5', 3))?.qty, 3, 'and the outer quantity is the one read')

ok(qtyProblem(0) !== '', 'zero is refused')
ok(qtyProblem(-1) !== '', 'a negative quantity is refused')
ok(qtyProblem(10000) !== '', 'a quantity past the ceiling is refused')
ok(qtyProblem(0.0001) !== '', 'four decimal places are refused')
eq(qtyProblem(0.001), '', 'three decimal places are allowed')

/* ──────────────────────────────────────────────────── the ean-13 sub format ── */

/* 8901234567894 → body 890123456789 → last six 456789. */
eq(itemRefFor('8901234567894'), '456789', 'the item reference is the last six of the body')
/* 036000291452 widens to 0036000291452 → body 003600029145 → last six 029145. */
eq(itemRefFor('036000291452'), '029145', 'a UPC-A item reference comes via the widening')
eq(itemRefFor('WIRE-8'), '', 'a non-GTIN parent has no derivable item reference')

{
  /* The worked example from the format comment, computed by hand there and here. */
  const code = buildInStoreEan13(itemRefFor('8901234567894'), 5)
  eq(code, '2456789005008', 'the worked example from the format comment')
  eq(code.length, 13, 'an in-store code is 13 digits')
  eq(code[0], '2', 'and begins with the reserved in-store prefix')
  ok(isValidEan13(code), 'and carries a valid EAN-13 check digit')
  eq(parseInStoreEan13(code)?.itemRef, '456789', 'the item reference comes back')
  eq(parseInStoreEan13(code)?.qty, 5, 'the quantity comes back')
}

for (const itemRef of ['000000', '234567', '999999']) {
  for (const qty of [0.01, 0.25, 1, 2.5, 5, 12.75, 123.45, 999.99]) {
    const code = buildInStoreEan13(itemRef, qty)
    eq(code.length, 13, `13 digits for ${itemRef} / ${qty}`)
    ok(isValidEan13(code), `${code} has a valid check digit`)
    eq(parseInStoreEan13(code)?.itemRef, itemRef, `item reference survives ${code}`)
    eq(parseInStoreEan13(code)?.qty, qty, `quantity survives ${code}`)
    eq(encodeEan13(code).bits.length, EAN13_MODULES, `${code} draws as a real EAN-13`)
  }
}

ok(inStoreQtyProblem(0.001) !== '', 'three decimal places do not fit an EAN-13 label')
eq(inStoreQtyProblem(0.01), '', 'two decimal places do')
ok(inStoreQtyProblem(1000) !== '', 'past 999.99 does not fit')
eq(parseInStoreEan13('4006381333931'), null, 'a supplier EAN-13 is not an in-store sub-code')
eq(parseInStoreEan13('2456789005007'), null, 'a wrong check digit is not accepted')
/* A *valid* EAN-13 whose quantity field is all zeros, so this tests the zero guard rather
   than falling out at the check digit. */
ok(isValidEan13('2456789000003'), 'the zero-quantity fixture is otherwise a valid EAN-13')
eq(parseInStoreEan13('2456789000003'), null, 'a zero quantity is refused')

/* ────────────────────────────────────────────────────── no cross-talk at all ── */

eq(parseAnySubCode('200002222S5')?.format, 'code128', 'the Code 128 format is recognised')
eq(parseAnySubCode(buildInStoreEan13('234567', 5))?.format, 'ean13', 'the EAN-13 format is recognised')
eq(parseAnySubCode(buildInStoreEan13('234567', 5))?.itemRef, '234567', 'and surfaces its item reference')
eq(parseAnySubCode('200002222'), null, 'a plain parent is neither format')
eq(parseAnySubCode('4006381333931'), null, 'a supplier EAN-13 is neither format')
eq(parseAnySubCode('036000291452'), null, 'a supplier UPC-A is neither format')

for (const itemRef of ['000000', '234567', '999999']) {
  for (const qty of [0.01, 5, 999.99]) {
    eq(parseSubCode(buildInStoreEan13(itemRef, qty)), null, 'an in-store EAN-13 never reads as Code 128')
  }
}
for (const qty of [0.001, 5, 9999]) {
  eq(parseInStoreEan13(buildSubCode('200002222', qty)), null, 'a Code 128 sub-code never reads as an EAN-13')
}

console.log(`sub-barcode: all ${checks} checks passed`)
