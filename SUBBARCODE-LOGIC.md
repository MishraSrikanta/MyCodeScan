# The sub-barcode format

**What to implement in MyStokio.** This document is the whole agreement; the implementation in
`src/lib/subbarcode.ts` follows it, and `src/lib/subbarcode.test.mts` checks it (4,451
assertions).

A sub-barcode is one printed label for one weighed or cut portion of a parent product — a 5 kg
bag of cashew, a 12.75 m coil of wire. The parent product keeps its single barcode and its
single catalogue entry; the quantity rides in the barcode so that scanning the bag *is* scanning
"5 kg of that product".

---

## The format

```
<parent barcode> S <quantity>
```

The parent barcode is copied **verbatim**. Nothing is shortened, renumbered, hashed or looked
up. The code just gets longer.

| Parent | Quantity | Sub-barcode |
| --- | --- | --- |
| `200002222` | 5 | `200002222S5` |
| `200002222` | 2.5 | `200002222S2P5` |
| `200002222` | 0.25 | `200002222S0P25` |
| `200002222` | 5.003 | `200002222S5P003` |
| `4006381333931` | 12.75 | `4006381333931S12P75` |
| `WIRE-8` | 100 | `WIRE-8S100` |

**Rules.**

- Marker is `S`, immediately after the parent, immediately before the quantity.
- The quantity is digits only, with `P` standing in for the decimal point.
- No trailing zeros: 2.50 and 2.5 must both produce `…S2P5`, or the same portion ends up with
  two different barcodes.
- Up to **4 integer digits** and **3 decimal places**. Maximum 9999, minimum 0.001.
- Printed as **Code 128**, which carries letters and has no length limit.

### Why these choices

**`S`, not `-`.** Hyphens already appear inside real supplier barcodes and shops' own SKUs
(`WIRE-8`, `PIPE-25`), so a hyphen-delimited suffix collides with codes that exist. `S` followed
by digits and then end-of-string does not occur by accident in numeric barcodes. **Reading
should still accept `-`** — one extra character in a regex, and it means a label printed under an
older scheme is not junk.

**`P`, not `.`.** A literal `.` is legal in Code 128 and would work. But these codes get typed
into search boxes, read aloud across a shop, and pushed through keyboard-wedge scanners with
their own punctuation quirks. Keeping the payload to letters and digits removes a class of "it
works on my scanner".

**The unit is not in the barcode.** `200002222S5` means five *of whatever that product is sold
in* — the unit already on the product page. Putting `KG` in the code would let a label disagree
with its own product, and "5 kg of a product priced per metre" is a worse failure than "5".

**No checksum in the payload.** Code 128 carries a mod-103 check character inside the symbol, so
a smudged or partial read *fails* rather than decoding as a different number. A payload checksum
would only guard against a hand-typed digit, which is a case where a human is present to look at
what the app says it parsed.

---

## Reading a code — the rule that matters most

```
1. Look the WHOLE scanned code up as a product barcode.
   Found?  → ordinary sale of that product, quantity 1. Stop here.

2. Not found? Now try to parse it as a sub-barcode.
   Parses? → sale of parent, quantity = the parsed number.

3. Neither? → unknown barcode, as today.
```

**Step 1 must come first.** In that order, a real product whose barcode genuinely ends in `S` and
digits still wins, and this scheme can never shadow a product that exists. Reverse the order and
it eventually mis-sells one.

### The parse

```js
const SUB_PATTERN = /^(.+)[S\-](\d{1,4}(?:P\d{1,3})?)$/

function parseSubCode(code) {
  const match = SUB_PATTERN.exec(code.trim())
  if (!match) return null

  const [, parent, encodedQty] = match
  if (parent.length < 3) return null              // guard against nonsense like "S5"

  const qty = Number(encodedQty.replace('P', '.'))
  if (!Number.isFinite(qty) || qty <= 0) return null

  return { parent, qty }
}
```

**The leading `(.+)` is greedy on purpose.** It takes the *last* marker that still leaves a valid
quantity behind it, so a parent code that itself contains an `S` splits correctly:

```
parseSubCode('A1S2S5')        → { parent: 'A1S2',      qty: 5 }
parseSubCode('200002222S5S3') → { parent: '200002222S5', qty: 3 }
```

A non-greedy `(.+?)` would give `parent: 'A1'`, `qty: 2` — the wrong product at the wrong weight.
This is the single most important line in the parse.

### The build

```js
function encodeQty(qty) {
  const fixed = qty.toFixed(3)
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
  return trimmed.replace('.', 'P')
}

function buildSubCode(parent, qty) {
  return `${parent.trim()}S${encodeQty(qty)}`
}
```

The `toFixed(3)` then trim is what guarantees no trailing zeros and no floating-point dust
(`2.4999999999` → `2.5`). Do it exactly this way in both apps or the two will occasionally
produce different codes for the same portion.

---

## Pieces versus size

Where a sub-barcode appears on a *line* — a scan session line, a bill line — the line quantity
means **how many pieces**, and the number in the barcode means **how much is in one piece**.

```
line barcode  200002222S5      ← 5 kg per bag
line quantity 3                ← three bags
total         15 kg
```

So MyStokio should multiply, not substitute: `lineQty × parsedQty` is the amount sold. Reading
the parsed quantity *as* the line quantity would turn three bags into three kilos.

---

## Editing a printed label

**The quantity is inside the barcode, so changing it changes the code.** A label already stuck on
a bag cannot be corrected — a barcode is ink, not a database row. An edit produces a *new* code
and the bag needs a new sticker.

What is worth doing, and what MyCodeScan does, is remembering the old code:

- keep the label's previous codes in a `retiredCodes` list;
- when a scan matches a retired code, say **"that sticker is out of date — this portion is 4.5 kg
  now"** rather than silently accepting either number.

Silently taking the old weight is how a shop loses money slowly, and it is the exact failure this
whole scheme is meant to remove.

---

## The EAN-13 fallback

Only for a till whose scanner cannot read Code 128 at all — plenty ship with it disabled in
firmware. **Prefer the format above everywhere else**, for the reason below.

```
2  IIIIII  QQQQQ  C          13 digits
│  │       │      └ standard EAN-13 mod-10 check digit
│  │       └─────── quantity in hundredths: 00500 = 5, 00250 = 2.5, 12345 = 123.45
│  └─────────────── in-store item number: six digits identifying the product
└────────────────── GS1 reserves the 20–29 prefixes for a shop's own codes
```

Worked example: parent `8901234567894`, 5 kg → `2` `456789` `00500` `8` → **`2456789005008`**.

**The cost.** Thirteen digits is not enough for a whole parent barcode *and* a quantity, so the
parent is squeezed to six digits and **the code stops being self-describing** — a lookup is now
required. That is the entire difference between the two formats. It also costs a decimal place:
999.99 maximum, two decimal places, against 9999 and three.

**What makes the lookup survivable — no new table.** The six digits are not assigned; they are
taken from the parent barcode:

```js
function itemRefFor(parent) {
  const gtin = toEan13(parent)        // 12-digit UPC-A → prefix a '0'; else ''
  return gtin ? gtin.slice(6, 12) : ''   // last six of the twelve-digit body
}
```

So MyStokio resolves a label by querying its **own product list**:

```js
function productForItemRef(itemRef, products) {
  const matches = products.filter((p) => itemRefFor(p.barcode) === itemRef)
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) return null      // unknown reference — ask
  throw new Error(`Reference ${itemRef} matches ${matches.length} products`)   // see below
}
```

**Run that same query at print time.** Two products whose barcodes end their bodies with the same
six digits produce indistinguishable labels, and the till would sell whichever it found first.
It is uncommon within one shop's range, it is silent, and it would be wrong. Printing is the one
moment somebody is present to resolve it, so refuse to print on a clash and let them pick a
different reference by hand.

For a parent that is not GTIN-shaped (`WIRE-8`) there are no digits to derive from — the six-digit
number has to be chosen once and stored with the product.

### Parsing it

```js
function parseInStoreEan13(code) {
  if (!/^\d{13}$/.test(code)) return null
  if (code[0] !== '2') return null
  if (!isValidEan13(code)) return null            // the check digit MUST be verified

  const qty = Number(code.slice(7, 12)) / 100
  if (qty <= 0) return null

  return { itemRef: code.slice(1, 7), qty }
}
```

Verifying the check digit is what keeps false positives rare. Note the limit: this **cannot** be
told apart from another in-store scheme in the same reserved range (a supermarket price-embedded
label, say). Nothing can — the range is shared by convention and carries no scheme identifier.
Worth knowing if the shop already prints 2-prefixed codes for something else.

### The two formats never collide

A Code 128 sub-code must contain a letter or hyphen; an in-store EAN-13 is thirteen digits. So
each parser rejects the other's output, and both reject ordinary supplier barcodes. The test
suite asserts this in both directions rather than assuming it.

---

## Checklist for the MyStokio side

- [ ] `parseSubCode` with the **greedy** leading group, and the `parent.length < 3` guard.
- [ ] `encodeQty` via `toFixed(3)` + trim, so both apps emit identical codes.
- [ ] Scan handling: **whole code as a product first**, sub-barcode parse second.
- [ ] A parsed sub-barcode adds the parent product at the parsed quantity — not quantity 1.
- [ ] On a line, amount sold is `lineQty × parsedQty` — pieces times size, never one or the other.
- [ ] The quantity is in the **product's own unit**; the barcode does not carry a unit.
- [ ] Retired codes are recognised and reported as out of date, not silently accepted.
- [ ] *If using the EAN-13 fallback:* `itemRefFor` by `slice(6, 12)` of the normalised GTIN, the
      check digit verified on read, and the clash query run **at print time**.
