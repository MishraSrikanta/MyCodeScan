/**
 * SubBarcode Printing — make a label for a weighed or cut portion of a parent product.
 *
 * ── The flow, in the order the work happens ─────────────────────────────────
 * **1. Scan the parent.** The camera opens on arrival, because there is always a parent
 * barcode and scanning it is the first thing anybody does. Typing it is there as the fallback,
 * not the main path. Once a parent is read the camera closes itself and the cursor lands in the
 * quantity box, so the whole label is two actions: point, then type a number.
 *
 * **2. Type the suffix quantity.** A small box, because the answer is short — `2`, `5`, `10`,
 * `5.003`. That number is the only thing added to the parent barcode.
 *
 * ── What the label is ───────────────────────────────────────────────────────
 * The parent barcode, unchanged, with the quantity appended after an `S`:
 *
 *     200002222  +  5      →  200002222S5
 *     200002222  +  5.003  →  200002222S5P003
 *
 * The parent digits are never rewritten, shortened, hashed or looked up. The code gets longer;
 * that is the whole cost. Anything reading it — MyStokio, a till, a person — recovers the
 * product by cutting at the last `S` and reads the quantity from what follows.
 *
 * ── The two jobs on this screen ─────────────────────────────────────────────
 * They are the same form, which is the point.
 *
 *   **Generate.** As above.
 *
 *   **Correct.** Scan a label that already exists and the form fills in with what that label
 *   says and becomes an editor.
 *
 * One form rather than two screens because they are one activity — somebody at the scales is
 * making labels and fixing labels in the same minute — and because a scan is the natural way
 * into both.
 *
 * ── The bit that is easy to get wrong ───────────────────────────────────────
 * Editing a printed label cannot change the printed label. The quantity is inside the barcode,
 * so a correction is a new barcode and the bag needs a new sticker. The interface says this out
 * loud, at the moment the quantity changes, rather than letting somebody believe they have
 * corrected a bag that is still in the crate with the old number on it.
 *
 * ── Nothing here touches the server ────────────────────────────────────────
 * By design. A sub-barcode is self-describing, so a till reading one needs no lookup; the saved
 * list is a local convenience for reprinting and correcting. See lib/sublabels.ts.
 */

import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  CameraOff,
  Check,
  Info,
  Pencil,
  Plus,
  Printer,
  ScanBarcode,
  Trash2,
  Video,
  X,
  Zap,
  ZapOff,
} from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  DECIMAL_MARK,
  IN_STORE_DECIMALS,
  MAX_DECIMALS,
  SUB_MARK,
  type SubFormat,
  encodeQty,
  formatQty,
  inStoreQtyProblem,
  itemRefFor,
  itemRefProblem,
  parentProblem,
  parentWarning,
  qtyProblem,
} from '../lib/subbarcode'
import {
  type SubLabel,
  codeFor,
  countPrint,
  deleteLabel,
  editLabel,
  itemRefClash,
  listLabels,
  lookup,
  recentParents,
  saveLabel,
} from '../lib/sublabels'
import { useScanner } from '../lib/useScanner'
import { Barcode } from './Barcode'
import { SubLabelSheet } from './SubLabelSheet'
import { UnitPicker } from './UnitPicker'

const FORMATS: { value: SubFormat; label: string; note: string }[] = [
  {
    value: 'code128',
    label: 'Code 128',
    note: `Keeps the parent barcode whole and adds the quantity after an ${SUB_MARK}. Up to ${MAX_DECIMALS} decimal places. This is the one to use.`,
  },
  {
    value: 'ean13',
    label: 'EAN-13',
    note: `Only for a till whose scanner cannot read Code 128 at all. Thirteen digits is not enough room for the parent barcode, so it carries a six-digit reference to it instead — and ${IN_STORE_DECIMALS} decimal places.`,
  },
]

/** What the form holds. Kept as strings, because a half-typed number is not a number. */
interface Draft {
  format: SubFormat
  parent: string
  qty: string
  unit: string
  note: string
  itemRef: string
}

const BLANK: Draft = { format: 'code128', parent: '', qty: '', unit: 'kg', note: '', itemRef: '' }

function draftFrom(label: SubLabel): Draft {
  return {
    format: label.format,
    parent: label.parent,
    qty: formatQty(label.qty),
    unit: label.unit,
    note: label.note,
    itemRef: label.itemRef,
  }
}

/** A message above the form, with a colour that means something. */
interface Notice {
  tone: 'good' | 'warn' | 'info'
  text: string
}

export function SubBarcodeView({ onBack }: { onBack: () => void }) {
  const [draft, setDraft] = useState<Draft>(BLANK)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [labels, setLabels] = useState<SubLabel[]>(() => listLabels())
  const [notice, setNotice] = useState<Notice | null>(null)
  const [error, setError] = useState('')
  const [printing, setPrinting] = useState<SubLabel | null>(null)

  /* Step one is scanning, so the camera is open on arrival rather than behind a button. */
  const [scanning, setScanning] = useState(true)
  const qtyRef = useRef<HTMLInputElement>(null)

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  const reload = useCallback(() => setLabels(listLabels()), [])

  const startNew = useCallback(() => {
    setDraft(BLANK)
    setEditingId(null)
    setNotice(null)
    setError('')
    setScanning(true)
  }, [])

  /* ------------------------------------------------------------- what a scan means */
  /**
   * One entry point for every code, from the camera or typed.
   *
   * The branches are `lookup`'s four outcomes, and each leaves the form in the state that needs
   * the fewest further taps. In every case the camera closes: a barcode has been read, the next
   * thing to do is type, and leaving a live camera running over the form would both drain the
   * phone and re-read the same code the moment somebody's hand moved.
   */
  const onCode = useCallback((code: string) => {
    setError('')
    setScanning(false)
    const hit = lookup(code)

    if (hit.kind === 'current') {
      setEditingId(hit.label.id)
      setDraft(draftFrom(hit.label))
      setNotice({
        tone: 'good',
        text: `${formatQty(hit.label.qty)} ${hit.label.unit} of ${hit.label.parent}. Change it below, or print more.`,
      })
      return
    }

    if (hit.kind === 'retired') {
      setEditingId(hit.label.id)
      setDraft(draftFrom(hit.label))
      setNotice({
        tone: 'warn',
        text: `That sticker is out of date. This portion is ${formatQty(hit.label.qty)} ${hit.label.unit} now, and its code is ${hit.label.code}. Print a new label and replace the old one.`,
      })
      return
    }

    if (hit.kind === 'unknown') {
      setEditingId(null)
      setDraft({
        ...BLANK,
        format: hit.format,
        parent: hit.parent,
        qty: formatQty(hit.qty),
        itemRef: hit.itemRef,
      })
      setNotice({
        tone: 'info',
        text: hit.parent
          ? `That is a sub-barcode for ${formatQty(hit.qty)} of ${hit.parent}, but it was not printed on this device. Fill in the unit and save it here.`
          : `That is an EAN-13 sub-barcode for ${formatQty(hit.qty)} of item reference ${hit.itemRef}, but nothing on this device says which product that is. Type the parent barcode in.`,
      })
      return
    }

    /* An ordinary barcode — a parent. The common case, and the one to make cheapest. */
    setEditingId(null)
    setDraft((current) => ({ ...current, parent: hit.code, itemRef: '' }))
    setNotice({ tone: 'good', text: `Parent barcode ${hit.code}. Now how much is in the bag?` })
    /* Straight into step two. The scan was the only thing the camera was for. */
    window.setTimeout(() => qtyRef.current?.focus(), 60)
  }, [])

  /* Confirm mode, for the same reason as the scan screen: a read arms the button rather than
     filling in the form off whatever drifted through frame. See lib/useScanner.ts. */
  const camera = useScanner(scanning, onCode, true)

  /* Read once per change to the saved list, not once per keystroke. */
  const parents = useMemo(() => recentParents(), [labels])

  /* ------------------------------------------------------------------- validation */
  const qty = Number(draft.qty)
  const derivedRef = itemRefFor(draft.parent)
  const effectiveRef = draft.itemRef || derivedRef

  const problems = useMemo(() => {
    const parent = parentProblem(draft.parent)
    if (parent) return { field: 'parent' as const, message: parent }

    if (!draft.qty.trim()) return { field: 'qty' as const, message: 'How much is in the bag?' }
    if (!Number.isFinite(qty)) return { field: 'qty' as const, message: 'That is not a number.' }
    const quantity = draft.format === 'ean13' ? inStoreQtyProblem(qty) : qtyProblem(qty)
    if (quantity) return { field: 'qty' as const, message: quantity }

    if (draft.format === 'ean13') {
      const reference = itemRefProblem(effectiveRef)
      if (reference) {
        return {
          field: 'itemRef' as const,
          message: derivedRef
            ? reference
            : 'This parent barcode is not an EAN-13 or UPC-A, so its six-digit reference cannot be worked out. Type one in, and use the same one every time for this product.',
        }
      }
      const clash = itemRefClash(draft.parent, effectiveRef)
      if (clash) {
        return {
          field: 'itemRef' as const,
          message: `Reference ${effectiveRef} is already in use by ${clash.parent}. Two products sharing it would scan as the same thing at the till — give this one a different reference.`,
        }
      }
    }

    return null
  }, [draft.parent, draft.qty, draft.format, qty, effectiveRef, derivedRef])

  const warning = parentWarning(draft.parent)

  /** What would be printed, or '' if the form is not ready. Live, so the preview follows typing. */
  const preview = useMemo(() => {
    if (problems) return ''
    try {
      return codeFor({
        format: draft.format,
        parent: draft.parent,
        qty,
        unit: draft.unit,
        itemRef: effectiveRef,
      })
    } catch {
      return ''
    }
  }, [problems, draft.format, draft.parent, draft.unit, qty, effectiveRef])

  const editing = editingId ? labels.find((label) => label.id === editingId) ?? null : null
  /* The one thing somebody must not miss: the code they already stuck on a bag has changed. */
  const codeMoved = Boolean(editing && preview && preview !== editing.code)

  /* ----------------------------------------------------------------------- saving */
  const commit = (thenPrint: boolean) => {
    if (problems) {
      setError(problems.message)
      return
    }
    setError('')
    try {
      const input = {
        format: draft.format,
        parent: draft.parent.trim(),
        qty,
        unit: draft.unit.trim(),
        note: draft.note.trim(),
        itemRef: effectiveRef,
      }
      const wasMoved = codeMoved
      const saved = editingId ? editLabel(editingId, input) : saveLabel(input)
      reload()
      setEditingId(saved.id)
      setDraft(draftFrom(saved))

      if (thenPrint) {
        setPrinting(saved)
        setNotice(null)
        return
      }
      setNotice({
        tone: wasMoved ? 'warn' : 'good',
        text: wasMoved
          ? `Saved as ${saved.code}. The old sticker no longer matches — print a new one and replace it.`
          : `Saved as ${saved.code}.`,
      })
    } catch (caught) {
      setError((caught as Error).message)
    }
  }

  const remove = (label: SubLabel) => {
    if (!window.confirm(`Forget ${label.code}? Labels already printed still scan; only this record goes.`)) {
      return
    }
    deleteLabel(label.id)
    reload()
    if (editingId === label.id) startNew()
  }

  if (printing) {
    return (
      <SubLabelSheet
        label={printing}
        onClose={() => {
          setPrinting(null)
          reload()
        }}
        onPrinted={(copies) => countPrint(printing.id, copies)}
      />
    )
  }

  const noticeStyle =
    notice?.tone === 'warn'
      ? 'border-amber-500/40 bg-amber-500/10'
      : notice?.tone === 'info'
        ? 'border-sky-500/40 bg-sky-500/10'
        : 'border-emerald-500/40 bg-emerald-500/10'

  /* The suffix as it will be printed, shown beside the box so the encoding of a decimal — 5.003
     becoming 5P003 — is never a surprise discovered on paper. */
  const suffixPreview =
    draft.format === 'code128' && Number.isFinite(qty) && qty > 0 && !qtyProblem(qty)
      ? `${SUB_MARK}${encodeQty(qty)}`
      : ''

  return (
    <div className="mx-auto flex min-h-full w-full max-w-lg flex-col px-4 pb-8 pt-[max(1rem,env(safe-area-inset-top))]">
      {/* ----------------------------------------------------------- header */}
      <header className="mb-3 flex items-center gap-2">
        <button onClick={onBack} aria-label="Back to your scans" className="btn-ghost px-3">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-[17px] font-bold leading-tight">SubBarcode Printing</h1>
          <p className="truncate text-[11.5px] text-white/45">
            The parent barcode, plus how much is in the bag
          </p>
        </div>
        <button
          onClick={() => setScanning((on) => !on)}
          className={`btn shrink-0 px-3 text-sm ${scanning ? 'bg-brand-500 text-white' : 'bg-white/10 text-white'}`}
        >
          {scanning ? <CameraOff className="h-4 w-4" /> : <Camera className="h-4 w-4" />}
          {scanning ? 'Stop' : 'Scan'}
        </button>
      </header>

      {/* ------------------------------------------------------- viewfinder */}
      {scanning && (
        <div className="mb-3 overflow-hidden rounded-2xl border border-white/10 bg-black">
          <div className="relative h-[26svh] max-h-[230px]">
            <video
              ref={camera.videoRef}
              playsInline
              muted
              autoPlay
              className={`h-full w-full object-cover ${camera.error ? 'opacity-20' : ''}`}
            />
            {!camera.error && !camera.starting && (
              <>
                {/* Red for nothing readable, green for a code held and waiting — the same light
                    as the scan screen, so the two behave alike. */}
                <div
                  className={`pointer-events-none absolute inset-0 border-[5px] transition-colors duration-150 ${
                    camera.candidate ? 'border-emerald-500' : 'border-rose-500/80'
                  }`}
                />
                <div className="pointer-events-none absolute inset-0 grid place-items-center">
                  <div
                    className={`h-[38%] w-[76%] max-w-sm rounded-xl border-2 transition-colors duration-150 ${
                      camera.candidate ? 'border-emerald-400' : 'border-white/50'
                    }`}
                  />
                </div>
                <p
                  className={`pointer-events-none absolute inset-x-0 top-0 px-4 py-1.5 text-center text-[12px] font-bold transition-colors duration-150 ${
                    camera.candidate ? 'bg-emerald-500 text-white' : 'bg-rose-500/90 text-white'
                  }`}
                >
                  {camera.candidate ? 'Barcode read — tap Capture' : 'No barcode readable'}
                </p>
                <p className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/85 to-transparent px-4 pb-2 pt-6 text-center font-mono text-[12.5px] font-semibold">
                  {camera.candidate ||
                    (draft.parent ? 'Scan a printed label to correct it' : 'Scan the product’s own barcode')}
                </p>
              </>
            )}
            {camera.error && (
              <div className="absolute inset-0 grid place-items-center p-4 text-center">
                <div>
                  <AlertTriangle className="mx-auto h-6 w-6 text-white/40" />
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-white/60">{camera.error}</p>
                  <p className="mt-1 text-[12px] text-white/40">Type the barcode below instead.</p>
                </div>
              </div>
            )}
            {camera.starting && !camera.error && (
              <p className="absolute inset-x-0 top-2 text-center text-[12px] text-white/60">
                Opening the camera…
              </p>
            )}
          </div>

          {!camera.error && (
            <div className="flex gap-2 p-2 pb-0">
              <button
                onClick={camera.capture}
                disabled={!camera.candidate}
                className={`btn min-w-0 flex-1 py-3 text-[15px] ${
                  camera.candidate
                    ? 'bg-emerald-500 text-white hover:bg-emerald-600'
                    : 'bg-white/10 text-white/40'
                }`}
              >
                <Check className="h-5 w-5 shrink-0" />
                <span className="truncate">
                  {camera.candidate ? `Capture ${camera.candidate}` : 'Capture'}
                </span>
              </button>
              {camera.candidate && (
                <button
                  onClick={camera.discard}
                  aria-label="Discard this barcode"
                  className="btn-ghost shrink-0 px-3"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          )}

          {(camera.torchAvailable || camera.cameras.length > 1) && (
            <div className="no-scrollbar flex items-center gap-2 overflow-x-auto p-2">
              {camera.torchAvailable && (
                <button
                  onClick={camera.toggleTorch}
                  className={`btn shrink-0 px-3 text-sm ${camera.torchOn ? 'bg-amber-400 text-slate-900' : 'bg-white/10 text-white'}`}
                >
                  {camera.torchOn ? <Zap className="h-4 w-4" /> : <ZapOff className="h-4 w-4" />}
                  {camera.torchOn ? 'Light on' : 'Light'}
                </button>
              )}
              {camera.cameras.length > 1 && (
                <label className="flex shrink-0 items-center gap-1.5 rounded-xl bg-white/10 pl-3 pr-1 text-sm font-semibold">
                  <Video className="h-4 w-4 shrink-0" />
                  <span className="sr-only">Which camera to scan with</span>
                  <select
                    value={camera.cameraId}
                    onChange={(event) => camera.chooseCamera(event.target.value)}
                    className="max-w-[8rem] truncate border-0 bg-transparent py-2.5 text-sm font-semibold text-white focus:outline-none"
                  >
                    <option value="" className="bg-slate-900">
                      Automatic
                    </option>
                    {camera.cameras.map((device, index) => (
                      <option key={device.deviceId} value={device.deviceId} className="bg-slate-900">
                        {device.label || `Camera ${index + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
        </div>
      )}

      {notice && (
        <p className={`mb-3 flex items-start gap-2 rounded-xl border p-3 text-[13px] leading-relaxed ${noticeStyle}`}>
          {notice.tone === 'warn' ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          ) : notice.tone === 'info' ? (
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
          ) : (
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
          )}
          <span className="min-w-0 flex-1">{notice.text}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss" className="shrink-0 text-white/40">
            <X className="h-3.5 w-3.5" />
          </button>
        </p>
      )}

      {/* ------------------------------------------------------------- form */}
      <section className="card space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[13px] font-bold uppercase tracking-wider text-white/50">
            {editing ? 'Editing a label' : 'New label'}
          </h2>
          {editing && (
            <button onClick={startNew} className="text-[12.5px] font-semibold text-brand-400">
              New label instead
            </button>
          )}
        </div>

        {/* ------------------------------------------------ step 1: the parent */}
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[12.5px] font-semibold text-white/70">
              <span className="mr-1.5 inline-grid h-4 w-4 place-items-center rounded-full bg-brand-500/25 text-[10px] font-bold text-brand-300">
                1
              </span>
              Parent barcode
            </span>
            {!scanning && (
              <button onClick={() => setScanning(true)} className="text-[12px] font-semibold text-brand-400">
                Scan it
              </button>
            )}
          </div>
          <input
            value={draft.parent}
            onChange={(event) => set('parent', event.target.value)}
            placeholder="Scan it, or type it — e.g. 200002222"
            inputMode="text"
            autoCapitalize="characters"
            className="field mt-1 font-mono"
          />
          <p className="mt-1 text-[11.5px] leading-relaxed text-white/40">
            Printed on the label exactly as it is. Nothing is shortened or renumbered.
          </p>
        </div>

        {!draft.parent && parents.length > 0 && (
          <div className="no-scrollbar -mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
            {parents.map((parent) => (
              <button
                key={parent}
                onClick={() => set('parent', parent)}
                className="shrink-0 rounded-lg bg-white/10 px-2.5 py-1.5 font-mono text-[12px] text-white/80 hover:bg-white/20"
              >
                {parent}
              </button>
            ))}
          </div>
        )}

        {warning && (
          <p className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-2.5 text-[12.5px] leading-relaxed">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
            <span>{warning}</span>
          </p>
        )}

        {/* ----------------------------------------------- step 2: the quantity */}
        <div>
          <span className="text-[12.5px] font-semibold text-white/70">
            <span className="mr-1.5 inline-grid h-4 w-4 place-items-center rounded-full bg-brand-500/25 text-[10px] font-bold text-brand-300">
              2
            </span>
            How much is in the bag
          </span>
          <div className="mt-1 flex items-center gap-2">
            {/* Small on purpose: the answer is one to five characters. */}
            <input
              ref={qtyRef}
              value={draft.qty}
              onChange={(event) => set('qty', event.target.value)}
              placeholder="5"
              inputMode="decimal"
              className="field w-24 shrink-0 text-center text-[17px] font-bold"
            />
            <UnitPicker
              key={editingId ?? 'new'}
              value={draft.unit}
              onChange={(unit) => set('unit', unit)}
              className="w-24 shrink-0"
            />
            {suffixPreview && (
              <span className="min-w-0 flex-1 truncate text-right font-mono text-[13px] text-white/50">
                adds <span className="font-bold text-brand-400">{suffixPreview}</span>
              </span>
            )}
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-white/40">
            Any number — <span className="font-mono">2</span>, <span className="font-mono">5</span>,{' '}
            <span className="font-mono">10</span>, <span className="font-mono">5.003</span> — up to{' '}
            {MAX_DECIMALS} decimal places. A decimal point is printed as{' '}
            <span className="font-mono">{DECIMAL_MARK}</span>, so 5.003 becomes{' '}
            <span className="font-mono">5{DECIMAL_MARK}003</span>. The unit is printed on the label but is{' '}
            <em>not</em> inside the barcode — the code says the number, and the product page in MyStokio
            says what it means.
          </p>
        </div>

        <label className="block">
          <span className="text-[12.5px] font-semibold text-white/70">Note on the label (optional)</span>
          <input
            value={draft.note}
            onChange={(event) => set('note', event.target.value)}
            placeholder="Batch, coil number, customer…"
            maxLength={40}
            className="field mt-1"
          />
        </label>

        {/* ------------------------------------------------------- symbology */}
        <div>
          <span className="text-[12.5px] font-semibold text-white/70">Barcode type</span>
          <div className="mt-1 flex gap-2">
            {FORMATS.map((option) => (
              <button
                key={option.value}
                onClick={() => set('format', option.value)}
                className={`btn flex-1 px-2 text-[13.5px] ${
                  draft.format === option.value ? 'bg-brand-500 text-white' : 'bg-white/10 text-white'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-white/40">
            {FORMATS.find((option) => option.value === draft.format)?.note}
          </p>
        </div>

        {draft.format === 'ean13' && (
          <label className="block">
            <span className="text-[12.5px] font-semibold text-white/70">In-store reference (6 digits)</span>
            <input
              value={draft.itemRef}
              onChange={(event) => set('itemRef', event.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder={derivedRef || '000000'}
              inputMode="numeric"
              className="field mt-1 font-mono"
            />
            <span className="mt-1 block text-[11.5px] leading-relaxed text-white/40">
              {derivedRef
                ? `Left blank, this uses ${derivedRef} — the last six digits of the parent barcode, which MyStokio can work out for itself with no lookup table.`
                : 'This parent is not an EAN-13, so there is nothing to derive it from. Choose a number and use the same one for this product every time.'}
            </span>
          </label>
        )}

        {/* ---------------------------------------------------------- preview */}
        {preview ? (
          <div>
            <div className="rounded-xl bg-white p-3">
              <div className="flex justify-center">
                <Barcode value={preview} format={draft.format} size="medium" heightMm={12} />
              </div>
            </div>
            {draft.format === 'code128' && (
              /* Split so the parent half is visibly untouched — the property that makes this
                 scheme safe to hand to a till that has never heard of it. */
              <p className="mt-2 text-center font-mono text-[14px]">
                <span className="text-white/90">{draft.parent.trim()}</span>
                <span className="font-bold text-brand-400">{suffixPreview}</span>
              </p>
            )}
          </div>
        ) : (
          <div className="grid place-items-center rounded-xl border border-dashed border-white/15 p-6 text-center">
            <div>
              <ScanBarcode className="mx-auto h-6 w-6 text-white/20" />
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-white/40">
                {problems?.message ?? 'Scan a parent barcode, then type a quantity.'}
              </p>
            </div>
          </div>
        )}

        {codeMoved && (
          <p className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-2.5 text-[12.5px] leading-relaxed">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
            <span>
              The quantity is inside the barcode, so this is a <strong>different code</strong> —{' '}
              <span className="font-mono">{editing?.code}</span> becomes{' '}
              <span className="font-mono">{preview}</span>. The sticker already on the bag cannot be
              corrected; print a new one and replace it. Scanning the old one will warn you.
            </span>
          </p>
        )}

        {error && (
          <p className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-2.5 text-[12.5px] leading-relaxed">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" />
            <span>{error}</span>
          </p>
        )}

        <div className="flex gap-2">
          <button onClick={() => commit(false)} disabled={!preview} className="btn-ghost flex-1 text-sm">
            {editing ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {editing ? 'Save changes' : 'Save'}
          </button>
          <button onClick={() => commit(true)} disabled={!preview} className="btn-primary flex-1 text-sm">
            <Printer className="h-4 w-4" />
            Save &amp; print
          </button>
        </div>
      </section>

      {/* ------------------------------------------------------------ saved */}
      <h2 className="mb-2 mt-5 text-[11px] font-bold uppercase tracking-wider text-white/40">
        Labels made here
      </h2>

      {labels.length === 0 ? (
        <div className="card text-center">
          <p className="text-[14.5px] font-semibold">Nothing yet</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-white/50">
            Make one above. Labels are kept on this phone only — a printed barcode carries its own
            meaning, so the till needs nothing from here.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {labels.map((label) => (
            <article key={label.id} className="card flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline gap-2">
                  <span className="text-[15px] font-bold">
                    {formatQty(label.qty)} {label.unit}
                  </span>
                  {label.format === 'ean13' && (
                    <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold text-white/60">
                      EAN-13
                    </span>
                  )}
                  {label.retiredCodes.length > 0 && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-400">
                      Reprint needed
                    </span>
                  )}
                </p>
                <p className="mt-0.5 truncate font-mono text-[12.5px] text-brand-400">{label.code}</p>
                <p className="mt-0.5 truncate text-[11.5px] text-white/40">
                  {label.parent}
                  {label.note ? ` · ${label.note}` : ''}
                  {label.printed > 0 ? ` · ${label.printed} printed` : ''}
                </p>
              </div>
              <button
                onClick={() => {
                  setEditingId(label.id)
                  setDraft(draftFrom(label))
                  setNotice(null)
                  setError('')
                  setScanning(false)
                  window.scrollTo({ top: 0, behavior: 'smooth' })
                }}
                aria-label={`Edit ${label.code}`}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white/40 hover:bg-white/10 hover:text-white"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                onClick={() => setPrinting(label)}
                aria-label={`Print ${label.code}`}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white/40 hover:bg-white/10 hover:text-white"
              >
                <Printer className="h-4 w-4" />
              </button>
              <button
                onClick={() => remove(label)}
                aria-label={`Forget ${label.code}`}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white/30 hover:bg-rose-500/20 hover:text-rose-400"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </article>
          ))}
        </div>
      )}

      <p className="mt-6 text-center text-[12px] leading-relaxed text-white/30">
        A sub-barcode is the product's own barcode with the quantity added to it — 5 kg of{' '}
        <span className="font-mono">200002222</span> is{' '}
        <span className="font-mono">200002222{SUB_MARK}5</span>. Cut at the last{' '}
        <span className="font-mono">{SUB_MARK}</span> and you have the product back.
      </p>
    </div>
  )
}
