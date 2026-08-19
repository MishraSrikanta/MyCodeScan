/**
 * The book of sub-labels that have been printed, kept on the device.
 *
 * ── Why this is local and not on the server ─────────────────────────────────
 * Deliberate, and asked for: the backend is not touched by this feature. It also happens to
 * be the right place. A Code 128 sub-barcode is *self-describing* — `200002222S5` already
 * says which product and how much — so a till reading one needs no lookup and no network.
 * Nothing here is required for a label to work; this is a record of what was printed, so the
 * same portion can be reprinted, corrected, or recognised when it comes back to the counter.
 *
 * That means the record and the printed label can disagree, and the honest thing is to say so
 * rather than pretend otherwise. See `retiredCodes` below.
 *
 * The EAN-13 format is the one case where the record earns its keep beyond convenience: those
 * codes carry only a six-digit reference to the parent, so a saved label is the only thing on
 * this device that can turn one back into a barcode. `findByItemRef` is that lookup.
 *
 * ── Editing a printed label ─────────────────────────────────────────────────
 * The quantity lives *inside* the barcode, so changing it changes the code. There is no way to
 * correct a label already stuck on a bag except to print a new one — a barcode is ink, not a
 * database row. What this module can do is remember that the old code used to mean this
 * portion, so that when the bag turns up at the counter with the *old* sticker on it, the app
 * says "that label is out of date, it is 4.5 kg now" instead of shrugging. That is the whole
 * reason `retiredCodes` exists.
 */

import { type SubFormat, buildInStoreEan13, buildSubCode, itemRefFor, parseAnySubCode } from './subbarcode'

const STORE_KEY = 'mycodescan.sublabels'

/** Units a shop actually sells loose goods in. Free text is allowed too. */
export const UNITS = ['kg', 'g', 'm', 'cm', 'ft', 'ltr', 'ml', 'pcs', 'coil', 'roll', 'box', 'bag']

export interface SubLabel {
  /** Stable across edits, unlike `code`. */
  id: string
  /** Which symbology and payload shape this label was printed in. */
  format: SubFormat
  /** The current printed code — `200002222S5`, or thirteen digits for the EAN-13 format. */
  code: string
  /** The product's own barcode. Always kept, even for EAN-13 labels that cannot carry it. */
  parent: string
  /** The six-digit in-store reference, for EAN-13 labels. '' for Code 128. */
  itemRef: string
  qty: number
  /** The product's selling unit. Label decoration only — it is not inside the code. */
  unit: string
  /** Anything worth writing on the label: a batch, a coil number, a customer name. */
  note: string
  createdAt: string
  updatedAt: string
  /** How many labels have been sent to the printer for this portion. */
  printed: number
  /**
   * Codes this portion used to carry, newest last.
   *
   * A scan that matches one of these means somebody is holding a bag with an out-of-date
   * sticker on it. Worth catching loudly: the old sticker says 5 kg and the record says 4.5,
   * and silently taking either number is how a shop loses money slowly.
   */
  retiredCodes: string[]
}

function read(): SubLabel[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    /* Tolerate records written before the EAN-13 format existed: they were all Code 128. */
    return (parsed as SubLabel[]).map((label) => ({
      ...label,
      format: label.format ?? 'code128',
      itemRef: label.itemRef ?? '',
      retiredCodes: label.retiredCodes ?? [],
    }))
  } catch {
    return []
  }
}

function write(labels: SubLabel[]): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(labels))
  } catch {
    /* Storage full or private browsing. A Code 128 label still prints and still scans — the
       code carries its own meaning — so this is a lost record, not a lost sale. */
  }
}

/** Newest first, which is the order somebody reprinting a label wants. */
export function listLabels(): SubLabel[] {
  return read().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/**
 * The saved label for a six-digit in-store reference, if there is one.
 *
 * The reverse of the squeeze the EAN-13 format performs. MyStokio does this against its own
 * product list; here there is no product list, so the only source is labels printed on this
 * device.
 */
export function findByItemRef(itemRef: string): SubLabel | null {
  return read().find((label) => label.itemRef === itemRef) ?? null
}

/**
 * Another product already using this six-digit reference, if any.
 *
 * The EAN-13 format's one real hazard: two parents whose barcodes end their bodies with the
 * same six digits produce labels that are indistinguishable, and the till would sell whichever
 * it found first. Uncommon, silent, and worth a hard stop at print time — which is the only
 * moment somebody is present to resolve it.
 *
 * This can only see labels printed on this device. MyStokio can do better, because it has the
 * whole product list; SUBBARCODE-LOGIC.md gives the query.
 */
export function itemRefClash(parent: string, itemRef: string): SubLabel | null {
  const wanted = parent.trim()
  return read().find((label) => label.itemRef === itemRef && label.parent !== wanted) ?? null
}

export type LookupHit =
  /** The scanned code is the current code for a saved label. */
  | { kind: 'current'; label: SubLabel }
  /** The scanned code is a sticker this portion no longer carries. */
  | { kind: 'retired'; label: SubLabel }
  /** A valid sub-barcode nobody here printed — another device, or a reinstall. */
  | { kind: 'unknown'; format: SubFormat; parent: string; itemRef: string; qty: number }
  /** Not a sub-barcode at all. Treat it as a parent product code. */
  | { kind: 'parent'; code: string }

/**
 * Works out what a scanned code is.
 *
 * The order is the order from subbarcode.ts, one step down: an exact match against a label we
 * printed beats parsing, because a saved label knows its unit, its note and — for the EAN-13
 * format — which product it is actually for, and a parse knows none of that. Retired codes are
 * checked before falling through to a bare parse, so an out-of-date sticker is reported as out
 * of date rather than silently accepted at its old weight.
 */
export function lookup(code: string): LookupHit {
  const trimmed = code.trim()
  const labels = read()

  const current = labels.find((label) => label.code === trimmed)
  if (current) return { kind: 'current', label: current }

  const retired = labels.find((label) => label.retiredCodes.includes(trimmed))
  if (retired) return { kind: 'retired', label: retired }

  const parsed = parseAnySubCode(trimmed)
  if (parsed) {
    /* An EAN-13 sub-code carries no parent. If a label on this device used the same reference,
       borrow its parent — a different quantity of the same product is the likely case. */
    const known = parsed.format === 'ean13' ? findByItemRef(parsed.itemRef) : null
    return {
      kind: 'unknown',
      format: parsed.format,
      parent: parsed.parent || known?.parent || '',
      itemRef: parsed.itemRef,
      qty: parsed.qty,
    }
  }

  return { kind: 'parent', code: trimmed }
}

function now(): string {
  return new Date().toISOString()
}

export interface SubLabelInput {
  format: SubFormat
  parent: string
  qty: number
  unit: string
  note?: string
  /**
   * The six-digit in-store reference, for the EAN-13 format.
   *
   * Derived from a GTIN parent when left out. Must be supplied for a parent that is not
   * GTIN-shaped, because there are no digits to derive it from.
   */
  itemRef?: string
}

/** The printed code an input would produce. Throws with a readable reason if it cannot. */
export function codeFor(input: SubLabelInput): string {
  if (input.format === 'ean13') {
    const itemRef = input.itemRef || itemRefFor(input.parent)
    return buildInStoreEan13(itemRef, input.qty)
  }
  return buildSubCode(input.parent, input.qty)
}

/**
 * Saves a new label, or returns the existing one if that exact portion is already recorded.
 *
 * Same parent and same quantity produce the same code by design, so a second "generate" for
 * 5 kg of the same wire is a reprint, not a duplicate. Its unit and note are updated, because
 * the person typing them now is more current than the person who typed them last week.
 */
export function saveLabel(input: SubLabelInput): SubLabel {
  const code = codeFor(input)
  const labels = read()

  const existing = labels.find((label) => label.code === code)
  if (existing) {
    existing.unit = input.unit
    existing.note = input.note ?? existing.note
    existing.updatedAt = now()
    write(labels)
    return existing
  }

  const label: SubLabel = {
    id: crypto.randomUUID(),
    format: input.format,
    code,
    parent: input.parent.trim(),
    itemRef: input.format === 'ean13' ? input.itemRef || itemRefFor(input.parent) : '',
    qty: input.qty,
    unit: input.unit,
    note: input.note ?? '',
    createdAt: now(),
    updatedAt: now(),
    printed: 0,
    retiredCodes: [],
  }
  labels.push(label)
  write(labels)
  return label
}

/**
 * Changes a saved label, returning it with whatever its code is now.
 *
 * If the quantity moved, the code moves with it and the old one is retired rather than
 * forgotten — a bag with the old sticker on it is still out there. If the new code collides
 * with another saved label, that other label wins and this one folds into it, because two
 * records claiming the same barcode is a state nothing downstream could resolve.
 */
export function editLabel(labelId: string, patch: Partial<SubLabelInput>): SubLabel {
  const labels = read()
  const label = labels.find((candidate) => candidate.id === labelId)
  if (!label) throw new Error('That label is no longer saved on this device.')

  const next: SubLabelInput = {
    format: patch.format ?? label.format,
    parent: (patch.parent ?? label.parent).trim(),
    qty: patch.qty ?? label.qty,
    unit: patch.unit ?? label.unit,
    note: patch.note ?? label.note,
    itemRef: patch.itemRef ?? label.itemRef,
  }
  const nextCode = codeFor(next)
  const nextItemRef = next.format === 'ean13' ? next.itemRef || itemRefFor(next.parent) : ''

  if (nextCode !== label.code) {
    const clash = labels.find((candidate) => candidate.id !== labelId && candidate.code === nextCode)
    if (clash) {
      /* Fold into the existing record and drop this one, carrying the retired codes across so
         no old sticker loses its trail. */
      clash.unit = next.unit
      clash.note = next.note ?? clash.note
      clash.retiredCodes = [...new Set([...clash.retiredCodes, ...label.retiredCodes, label.code])]
      clash.updatedAt = now()
      write(labels.filter((candidate) => candidate.id !== labelId))
      return clash
    }
    label.retiredCodes = [...label.retiredCodes, label.code]
  }

  label.format = next.format
  label.parent = next.parent
  label.qty = next.qty
  label.unit = next.unit
  label.note = next.note ?? ''
  label.itemRef = nextItemRef
  label.code = nextCode
  label.updatedAt = now()
  write(labels)
  return label
}

/** Counts a trip to the printer, so the list can show which labels are actually in use. */
export function countPrint(labelId: string, copies: number): void {
  const labels = read()
  const label = labels.find((candidate) => candidate.id === labelId)
  if (!label) return
  label.printed += copies
  label.updatedAt = now()
  write(labels)
}

export function deleteLabel(labelId: string): void {
  write(read().filter((label) => label.id !== labelId))
}

/** Distinct parent codes seen so far, newest first — the suggestion list on the form. */
export function recentParents(limit = 8): string[] {
  const seen: string[] = []
  for (const label of listLabels()) {
    if (!seen.includes(label.parent)) seen.push(label.parent)
    if (seen.length >= limit) break
  }
  return seen
}
