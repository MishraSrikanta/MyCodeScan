/**
 * The scanning screen: camera above, the list of what has been scanned below.
 *
 * Same split as MyStockio's billing scanner, for the same reason — a full-screen camera hides
 * the thing being built, so the operator has to leave the camera after every item to check it
 * worked. Here the list is right there.
 *
 * ── The camera arms; the operator records ────────────────────────────────────
 * A decoder reads a barcode every frame it can see one, so a handler fired on each read turns one
 * sweep past a shelf into a dozen of the same item — silently, with nothing to notice but a
 * quantity that no longer matches the basket. So the viewfinder frame goes **green** when a
 * barcode is being read, **red** when there is none, and the code is added only when the button
 * beneath it is tapped.
 *
 * Green is a live reading, not a memory: it goes out the moment the camera looks away, and a
 * capture puts it out deliberately before it can come back. Both matter, because the button
 * carries the code it is about to add and the operator has to be able to trust that. See
 * lib/useScanner.ts.
 *
 * ── Every scan is a new item, unless you say otherwise ───────────────────────
 * Scanning a barcode already on the list does not silently add another. It asks, because the two
 * things a repeat can mean look identical from here: a second tin genuinely being counted, and a
 * barcode read twice because the operator lost track. Guessing the first inflates a count;
 * guessing the second loses a sale. Neither is recoverable later — nothing on the shelf records
 * which happened — so it is worth one tap to know.
 *
 * For a bulk count the stepper on the line is still the fast path: tapping + eight times beats
 * answering the same question eight times.
 *
 * Typing a barcode by hand skips the *capture* confirmation, because typing it is the
 * confirmation — but it still goes through the duplicate question.
 *
 * ── Each captured scan saves itself ──────────────────────────────────────────
 * Once captured, a barcode is queued locally and sent immediately. There is nothing further to
 * press and nothing to remember: by the time the operator has moved to the next shelf, the item
 * is on the server and visible at the counter.
 *
 * The queue is what makes that safe rather than merely optimistic. A scan is written to local
 * storage before any request goes out, so a dead signal delays the upload instead of losing
 * the scan, and the pending count tells the operator how far behind the network is. See
 * lib/queue.ts.
 *
 * ── Optimistic, then reconciled ──────────────────────────────────────────────
 * A scan appears in the list the instant the barcode is read, before the server has heard
 * about it. Waiting for a round trip would make the app feel broken on a weak connection and
 * unusable on none. Server responses then replace the local view, so the totals shown are the
 * server's own arithmetic rather than ours.
 *
 * ── Custom piece ─────────────────────────────────────────────────────────────
 * Some of what a shop scans is not a countable unit. Scan the wire, and the line says one — but
 * what is actually on the counter is a 12.75 m coil. **Custom piece** turns a scanned line into
 * a sub-barcode line: `200002222` becomes `200002222S12P75`, using the same suffix format as the
 * SubBarcode Printing section, so the till reads the quantity out of the code instead of
 * somebody typing it in.
 *
 * The line quantity keeps meaning what it meant: **how many pieces**. Three 5 kg bags is
 * `200002222S5` × 3, not `200002222` × 15. Conflating the two is the mistake the whole scheme
 * exists to prevent, so the two numbers stay separate — pieces on the line, size in the code.
 *
 * See lib/subbarcode.ts for the format and SUBBARCODE-LOGIC.md for the reading side.
 */

import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Keyboard,
  Loader2,
  Minus,
  Plus,
  Scale,
  ScanBarcode,
  Trash2,
  Upload,
  Video,
  X,
  Zap,
  ZapOff,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Scan, addItem, getScan, removeItem, setItemQty, updateScan } from '../lib/api'
import { enqueue, flush, queueLength } from '../lib/queue'
import {
  DECIMAL_MARK,
  MAX_DECIMALS,
  SUB_MARK,
  buildSubCode,
  encodeQty,
  formatQty,
  parentProblem,
  parseSubCode,
  qtyProblem,
} from '../lib/subbarcode'
import { type SubLabel, listLabels, saveLabel } from '../lib/sublabels'
import { useScanner } from '../lib/useScanner'
import { UnitPicker } from './UnitPicker'

/** A local view of a line, so the list can update before the server replies. */
interface Line {
  barcode: string
  qty: number
}

function linesFrom(scan: Scan | null): Line[] {
  return (scan?.items ?? []).map((item) => ({ barcode: item.barcode, qty: item.qty }))
}

/**
 * The product a line is for, whether or not the line is already a custom piece.
 *
 * The reason this exists rather than reading `line.barcode` directly: editing a custom piece
 * from 5 kg to 6 kg has to *replace* the suffix, not add a second one. Without this, a line
 * edited twice becomes `200002222S5S6` — which the greedy parser reads as six of a five-kilo
 * bag, a plausible-looking answer that is wrong.
 */
function parentOf(barcode: string): string {
  return parseSubCode(barcode)?.parent ?? barcode
}

/** Locally saved labels by code, so a line can show the unit that is not inside its barcode. */
function byCode(labels: SubLabel[]): Map<string, SubLabel> {
  return new Map(labels.map((label) => [label.code, label]))
}

export function ScanView({
  scanId,
  onBack,
  onEmptyChange,
}: {
  scanId: string
  onBack: () => void
  /** Reports whether this scan holds nothing, so the shell can delete it on the way out. */
  onEmptyChange: (empty: boolean) => void
}) {
  const [scan, setScan] = useState<Scan | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [label, setLabel] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastCode, setLastCode] = useState('')
  const [pending, setPending] = useState(0)
  const [manual, setManual] = useState('')
  const [showManual, setShowManual] = useState(false)
  const [savingStatus, setSavingStatus] = useState(false)

  /* The newest line is highlighted briefly, so a scan is visibly acknowledged even when the
     beep cannot be heard over a shop. */
  const [flash, setFlash] = useState('')
  const flashTimer = useRef<number | null>(null)

  /**
   * A barcode already on the list, waiting for the operator to say whether it is a second one.
   *
   * `qty` is captured when the question is asked rather than read live, so the dialog states the
   * count the operator was actually looking at when they scanned.
   */
  const [duplicate, setDuplicate] = useState<{ barcode: string; qty: number } | null>(null)

  /* The list as the scanner's long-lived callback needs to see it — see `onCode`. */
  const linesRef = useRef<Line[]>([])
  useEffect(() => {
    linesRef.current = lines
  }, [lines])

  /* ------------------------------------------------------- custom piece state */
  /** The barcode of the line whose custom-piece editor is open, or '' for none. */
  const [customFor, setCustomFor] = useState('')
  const [customQty, setCustomQty] = useState('')
  const [customUnit, setCustomUnit] = useState('kg')
  const [customNote, setCustomNote] = useState('')
  const [converting, setConverting] = useState(false)
  const [labels, setLabels] = useState<SubLabel[]>(() => listLabels())
  const labelFor = useMemo(() => byCode(labels), [labels])
  const customQtyRef = useRef<HTMLInputElement>(null)

  const refreshPending = useCallback(() => setPending(queueLength(scanId)), [scanId])

  /* ------------------------------------------------------------ initial load */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const loaded = await getScan(scanId)
        if (!alive) return
        setScan(loaded)
        setLines(linesFrom(loaded))
        setLabel(loaded.label)
      } catch (caught) {
        if (alive) setError((caught as Error).message)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [scanId])

  useEffect(() => {
    refreshPending()
  }, [refreshPending])

  /*
   * ── Is there anything in this scan? ─────────────────────────────────────────
   * Reported upward so the shell can delete a session nobody put anything into — see App.tsx.
   *
   * Three conditions, and each one is load-bearing:
   *
   *   · `scan` must be non-null. It is only set once `getScan` has *succeeded*, so a scan whose
   *     load failed on a flaky connection is never reported empty. Without this, opening a real
   *     scan in a dead spot and backing out would delete it — the worst possible bug to trade for
   *     a bit of tidiness.
   *
   *   · No lines. Includes the case where items were captured and then all deleted, which is
   *     genuinely an empty scan and should not survive either.
   *
   *   · Nothing queued. Barcodes waiting to upload are real captures the server has not heard
   *     about yet; the item count is zero only because the network is behind.
   */
  const empty = Boolean(scan) && lines.length === 0 && pending === 0
  useEffect(() => {
    onEmptyChange(empty)
  }, [empty, onEmptyChange])

  /* ------------------------------------------------------------------ sending */
  /**
   * Sends whatever is queued and adopts the server's version of the scan.
   *
   * Deliberately tolerant of failure: the queue holds the work, so a failed flush is a delay
   * rather than a loss, and shouting about it after every scan in a dead spot would be noise
   * the operator cannot act on.
   */
  const sync = useCallback(async () => {
    const result = await flush()
    refreshPending()
    if (result.sent === 0 && result.failed > 0) return
    try {
      const fresh = await getScan(scanId)
      setScan(fresh)
      setLines(linesFrom(fresh))
    } catch {
      // Keep the local view; the next sync will reconcile.
    }
  }, [scanId, refreshPending])

  /**
   * Records one of a barcode. No questions asked — the asking happens in `onCode`.
   */
  const record = useCallback(
    (barcode: string) => {
      setLastCode(barcode)

      /* Optimistic: show it immediately. */
      setLines((current) => {
        const existing = current.find((line) => line.barcode === barcode)
        if (existing) {
          return current.map((line) => (line.barcode === barcode ? { ...line, qty: line.qty + 1 } : line))
        }
        return [...current, { barcode, qty: 1 }]
      })

      setFlash(barcode)
      if (flashTimer.current) window.clearTimeout(flashTimer.current)
      flashTimer.current = window.setTimeout(() => setFlash(''), 900)

      /* Queue first, send second — see lib/queue.ts. */
      enqueue({
        clientItemId: crypto.randomUUID(),
        scanId,
        barcode,
        qty: 1,
        scannedAt: new Date().toISOString(),
      })
      refreshPending()
      void sync()
    },
    [scanId, sync, refreshPending],
  )

  /**
   * A barcode arrived — from the Add button or typed in.
   *
   * Every scan is treated as a *new* item unless it is already on the list, in which case it stops
   * here and asks. The reason is that the two things a repeat can mean look identical from here:
   * a second tin genuinely being counted, and a barcode read twice because the operator lost track
   * of what they had already done. Guessing the first quietly inflates a count; guessing the second
   * quietly loses a sale. Neither is recoverable later, because nothing on the shelf records which
   * happened — so it is worth one tap to know.
   *
   * The list is read through a ref: this callback is handed to `useScanner`, which holds it for the
   * life of the camera, and closing over `lines` would compare against whatever the list held when
   * the camera opened.
   */
  const onCode = useCallback(
    (barcode: string) => {
      const existing = linesRef.current.find((line) => line.barcode === barcode)
      if (existing) {
        setDuplicate({ barcode, qty: existing.qty })
        return
      }
      record(barcode)
    },
    [record],
  )

  useEffect(
    () => () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current)
    },
    [],
  )

  /*
   * Confirm mode: a read arms the button, it does not record anything.
   *
   * Without it, one sweep of the camera past a shelf adds the same item a dozen times — the
   * decoder reads every frame it can, and the operator's only clue is a quantity that has
   * silently run away from what is in the basket. See lib/useScanner.ts.
   */
  const camera = useScanner(!loading && !error, onCode, true)

  /* Flush when the connection comes back. */
  useEffect(() => {
    const onOnline = () => void sync()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [sync])

  /* --------------------------------------------------------------- edits */
  const changeQty = async (barcode: string, qty: number) => {
    if (qty <= 0) return
    setLines((current) => current.map((line) => (line.barcode === barcode ? { ...line, qty } : line)))
    try {
      /* Anything queued must land first, or the server would apply this exact quantity and
         then have queued increments added on top of it. */
      await flush()
      refreshPending()
      const fresh = await setItemQty(scanId, barcode, qty)
      setScan(fresh)
      setLines(linesFrom(fresh))
    } catch (caught) {
      setError((caught as Error).message)
    }
  }

  const drop = async (barcode: string) => {
    setLines((current) => current.filter((line) => line.barcode !== barcode))
    try {
      await flush()
      refreshPending()
      const fresh = await removeItem(scanId, barcode)
      setScan(fresh)
      setLines(linesFrom(fresh))
    } catch (caught) {
      setError((caught as Error).message)
    }
  }

  /* ------------------------------------------------------------- custom piece */
  /** Opens the editor for a line, pre-filled with whatever that line already says. */
  const openCustom = (barcode: string) => {
    const parsed = parseSubCode(barcode)
    const known = labelFor.get(barcode)
    setCustomFor(barcode)
    setCustomQty(parsed ? formatQty(parsed.qty) : '')
    setCustomUnit(known?.unit || 'kg')
    setCustomNote(known?.note || '')
    setError('')
    window.setTimeout(() => customQtyRef.current?.focus(), 60)
  }

  const closeCustom = () => {
    setCustomFor('')
    setCustomQty('')
  }

  /**
   * Turns a scanned line into a custom piece, or changes the size of one that already is.
   *
   * ── Why the line is added before the old one is removed ─────────────────────
   * Two requests, and either could fail. Adding first and removing second means a failure
   * halfway leaves a *duplicate* line, which is visible and can be deleted. The other order
   * means a failure halfway leaves *nothing* — the scanned item is gone and the shelf has to be
   * walked again. A visible mess beats a silent loss.
   *
   * ── Why the queue is flushed first ──────────────────────────────────────────
   * Same reason `changeQty` and `drop` do it: a queued increment for the old barcode that lands
   * after the removal would resurrect the line we just replaced.
   *
   * ── Why the unit is saved separately ────────────────────────────────────────
   * It is not in the barcode, and the scan endpoints hold nothing but barcodes and quantities.
   * So it goes to the local label book, which is also what makes the piece printable afterwards
   * from SubBarcode Printing.
   */
  const saveCustom = async () => {
    const line = lines.find((candidate) => candidate.barcode === customFor)
    if (!line) {
      closeCustom()
      return
    }

    const parent = parentOf(customFor)
    const qty = Number(customQty)
    const problem = parentProblem(parent) || (customQty.trim() ? qtyProblem(qty) : 'How much is in one piece?')
    if (problem) {
      setError(problem)
      return
    }

    const newCode = buildSubCode(parent, qty)
    setConverting(true)
    setError('')
    try {
      /* Recorded first and regardless: it is local, it cannot fail, and it is what carries the
         unit and note that the barcode itself does not. */
      saveLabel({ format: 'code128', parent, qty, unit: customUnit.trim(), note: customNote.trim() })
      setLabels(listLabels())

      if (newCode !== customFor) {
        await flush()
        refreshPending()
        /* The piece count travels across unchanged — three bags stay three bags. */
        await addItem(scanId, newCode, line.qty, crypto.randomUUID())
        const fresh = await removeItem(scanId, customFor)
        setScan(fresh)
        setLines(linesFrom(fresh))
        setFlash(newCode)
        if (flashTimer.current) window.clearTimeout(flashTimer.current)
        flashTimer.current = window.setTimeout(() => setFlash(''), 900)
      }
      closeCustom()
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setConverting(false)
    }
  }

  /** Puts a custom piece back to the plain product barcode it came from. */
  const clearCustom = async (barcode: string) => {
    const line = lines.find((candidate) => candidate.barcode === barcode)
    const parent = parentOf(barcode)
    if (!line || parent === barcode) return

    setConverting(true)
    setError('')
    try {
      await flush()
      refreshPending()
      await addItem(scanId, parent, line.qty, crypto.randomUUID())
      const fresh = await removeItem(scanId, barcode)
      setScan(fresh)
      setLines(linesFrom(fresh))
      closeCustom()
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setConverting(false)
    }
  }

  const saveLabelName = async () => {
    if (!scan || label === scan.label) return
    try {
      const fresh = await updateScan(scanId, { label })
      setScan(fresh)
    } catch (caught) {
      setError((caught as Error).message)
    }
  }

  /**
   * Marks the session done and returns to the list.
   *
   * An empty session is not marked ready — it is left for the shell to delete. A *ready* scan with
   * nothing in it is worse than no scan at all: it sits at the top of the list at the counter
   * looking like work that is waiting, and somebody picks it and gets nothing.
   */
  const finish = async () => {
    setSavingStatus(true)
    setError('')
    try {
      await flush()
      refreshPending()
      if (!empty) await updateScan(scanId, { status: 'ready', label })
      onBack()
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setSavingStatus(false)
    }
  }

  const totalUnits = lines.reduce((sum, line) => sum + line.qty, 0)

  if (loading) {
    return (
      <div className="grid min-h-full place-items-center">
        <p className="flex items-center gap-2 text-sm text-white/50">
          <Loader2 className="h-4 w-4 animate-spin" />
          Opening {scanId}…
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* ----------------------------------------------------------- header */}
      <header className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-[max(0.6rem,env(safe-area-inset-top))]">
        <button onClick={onBack} aria-label="Back to your scans" className="btn-ghost px-3">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[15px] font-bold tracking-wide text-brand-400">{scanId}</p>
          <p className="truncate text-[11.5px] text-white/45">
            {lines.length} item{lines.length === 1 ? '' : 's'} · {totalUnits} unit{totalUnits === 1 ? '' : 's'}
            {pending > 0 ? ` · ${pending} to upload` : ' · saved'}
          </p>
        </div>
        {/* An empty scan is discarded rather than finished, so the button says so. Labelling it
            "Done" and then silently deleting the session would be a small lie about a destructive
            action, even a harmless one. */}
        <button
          onClick={() => void finish()}
          disabled={savingStatus}
          className={`btn shrink-0 px-3 text-sm ${empty ? 'bg-white/10 text-white' : 'bg-brand-500 text-white hover:bg-brand-600'}`}
        >
          {savingStatus ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : empty ? (
            <X className="h-4 w-4" />
          ) : (
            <CheckCircle2 className="h-4 w-4" />
          )}
          {empty ? 'Discard' : 'Done'}
        </button>
      </header>

      {/* ------------------------------------------------------- viewfinder */}
      <div className="relative h-[32svh] max-h-[290px] shrink-0 overflow-hidden bg-black">
        {/* Centred column: in landscape the pane is far wider than it is tall, and
            object-cover would crop the feed to a useless strip. */}
        <div className="relative mx-auto h-full w-full max-w-[520px]">
          <video
            ref={camera.videoRef}
            playsInline
            muted
            autoPlay
            className={`h-full w-full object-cover ${camera.error ? 'opacity-20' : ''}`}
          />
        </div>

        {/* ------------------------------------------------- the red/green light
            The whole point of confirm mode is that the operator can tell, without looking away
            from the shelf, whether the app has a barcode. So it is the frame of the viewfinder
            that changes colour rather than a small icon somewhere: red for nothing readable,
            green for a code held and waiting. */}
        {!camera.error && !camera.starting && (
          <>
            <div
              className={`pointer-events-none absolute inset-0 mx-auto max-w-[520px] border-[5px] transition-colors duration-150 ${
                camera.candidate ? 'border-emerald-500' : 'border-rose-500/80'
              }`}
            />
            <div className="pointer-events-none absolute inset-0 mx-auto grid max-w-[520px] place-items-center">
              <div className="relative h-[42%] w-[78%] max-w-sm">
                {[
                  'left-0 top-0 border-l-4 border-t-4 rounded-tl-xl',
                  'right-0 top-0 border-r-4 border-t-4 rounded-tr-xl',
                  'left-0 bottom-0 border-b-4 border-l-4 rounded-bl-xl',
                  'right-0 bottom-0 border-b-4 border-r-4 rounded-br-xl',
                ].map((corner) => (
                  <span
                    key={corner}
                    className={`absolute h-9 w-9 transition-colors duration-150 ${
                      camera.candidate ? 'border-emerald-400' : 'border-white/50'
                    } ${corner}`}
                  />
                ))}
              </div>
            </div>
            <p
              className={`pointer-events-none absolute inset-x-0 top-0 mx-auto max-w-[520px] px-4 py-1.5 text-center text-[12px] font-bold transition-colors duration-150 ${
                camera.candidate ? 'bg-emerald-500 text-white' : 'bg-rose-500/90 text-white'
              }`}
            >
              {camera.candidate ? 'Ready — tap to add' : 'No barcode readable'}
            </p>
          </>
        )}

        {camera.error && (
          <div className="absolute inset-0 grid place-items-center p-5">
            <div className="max-w-sm text-center">
              <AlertTriangle className="mx-auto h-8 w-8 text-white/40" />
              <p className="mt-2 text-[14px] font-bold">Camera unavailable</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-white/60">{camera.error}</p>
              <p className="mt-2 text-[12px] text-white/40">You can still type barcodes below.</p>
            </div>
          </div>
        )}

        {camera.starting && !camera.error && (
          <p className="absolute inset-x-0 top-2 text-center text-[12px] text-white/60">Opening the camera…</p>
        )}

        {/* The held code, or the last one recorded once nothing is held. */}
        {(camera.candidate || lastCode) && !camera.error && (
          <p className="absolute inset-x-0 bottom-0 mx-auto max-w-[520px] truncate bg-gradient-to-t from-black/85 to-transparent px-4 pb-2 pt-6 text-center font-mono text-[13px] font-semibold">
            {camera.candidate ? (
              <ScanBarcode className="mr-1 inline h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <Check className="mr-1 inline h-3.5 w-3.5 text-white/50" />
            )}
            {camera.candidate || lastCode}
          </p>
        )}
      </div>

      {/* --------------------------------------------------------- controls */}
      <div className="shrink-0 space-y-2 px-3 pt-2.5">
        {/*
            The primary action, directly under the viewfinder where a thumb already is.

            One button, full width, and it carries the code it will add — the operator should be
            reading the number they are about to record, not the word "Capture". Disabled rather
            than hidden when there is nothing to add, because a button that appears and disappears
            is a button that gets mis-tapped.
        */}
        <button
          onClick={camera.capture}
          disabled={!camera.candidate}
          className={`btn w-full py-3.5 text-base ${
            camera.candidate ? 'bg-emerald-500 text-white hover:bg-emerald-600' : 'bg-white/10 text-white/40'
          }`}
        >
          <Check className="h-5 w-5 shrink-0" />
          <span className="truncate">
            {camera.candidate ? `Add ${camera.candidate}` : 'Point at a barcode'}
          </span>
        </button>

        <div className="no-scrollbar flex items-center justify-center gap-2 overflow-x-auto">
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

          <button onClick={() => setShowManual((value) => !value)} className="btn-ghost shrink-0 px-3 text-sm">
            <Keyboard className="h-4 w-4" />
            Type it
          </button>
        </div>

        {showManual && (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const code = manual.trim()
              if (!code) return
              onCode(code)
              setManual('')
            }}
            className="flex gap-2"
          >
            <input
              autoFocus
              value={manual}
              onChange={(event) => setManual(event.target.value)}
              inputMode="numeric"
              placeholder="Type or paste a barcode"
              className="field flex-1"
            />
            <button type="submit" disabled={!manual.trim()} className="btn-primary px-4">
              Add
            </button>
          </form>
        )}

        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          onBlur={() => void saveLabelName()}
          placeholder="Label this scan — e.g. Shelf 3, or Cold store"
          maxLength={80}
          className="field text-[14px]"
        />

        {pending > 0 && (
          <p className="flex items-center gap-2 text-[12px] text-amber-400">
            <Upload className="h-3.5 w-3.5" />
            {pending} waiting to upload — they will send themselves.
          </p>
        )}

        {error && (
          <p className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-2.5 text-[12.5px] leading-relaxed">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" />
            <span>{error}</span>
          </p>
        )}
      </div>

      {/* -------------------------------------------------------- duplicate */}
      {duplicate && (
        /* A real dialog rather than `window.confirm`: the native one is a different size and shape
           on every phone, cannot be styled to show a barcode legibly, and on some Android browsers
           steals focus from the camera in a way it does not give back. */
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="duplicate-title"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:items-center"
        >
          <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-ink p-4 shadow-2xl">
            <p id="duplicate-title" className="text-[16px] font-bold">
              Already scanned
            </p>
            <p className="mt-1 break-all font-mono text-[13.5px] text-brand-400">{duplicate.barcode}</p>
            <p className="mt-2 text-[13.5px] leading-relaxed text-white/65">
              This is on the list with {duplicate.qty} {duplicate.qty === 1 ? 'unit' : 'units'}. Add
              another one?
            </p>

            <div className="mt-4 flex gap-2">
              <button onClick={() => setDuplicate(null)} className="btn-ghost flex-1">
                No
              </button>
              <button
                onClick={() => {
                  record(duplicate.barcode)
                  setDuplicate(null)
                }}
                className="btn-primary flex-1"
              >
                <Plus className="h-4 w-4" />
                Yes, make it {duplicate.qty + 1}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------ items */}
      <div className="mt-2 flex min-h-0 flex-1 flex-col border-t border-white/10">
        <p className="shrink-0 px-4 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wider text-white/40">
          Scanned
        </p>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {lines.length === 0 && (
            <div className="grid h-full place-items-center px-6 text-center">
              <div>
                <ScanBarcode className="mx-auto h-7 w-7 text-white/20" />
                <p className="mt-2 text-[13.5px] font-semibold text-white/60">Nothing scanned yet</p>
                <p className="mt-1 text-[12px] leading-relaxed text-white/35">
                  Point the camera at a barcode. The frame turns green while one is being read — then
                  tap the button below to add it.
                </p>
              </div>
            </div>
          )}

          {/* Newest first: on a short list the alternative is that every new scan lands below
              the fold, which defeats having the list at all. */}
          {[...lines].reverse().map((line) => {
            const piece = parseSubCode(line.barcode)
            const known = labelFor.get(line.barcode)
            const open = customFor === line.barcode
            /* Live preview of the suffix, so `5.003` becoming `S5P003` is never a surprise. */
            const draftQty = Number(customQty)
            const suffix =
              customQty.trim() && Number.isFinite(draftQty) && !qtyProblem(draftQty)
                ? `${SUB_MARK}${encodeQty(draftQty)}`
                : ''

            return (
              <article
                key={line.barcode}
                className={`rounded-xl transition-colors ${
                  flash === line.barcode ? 'bg-emerald-500/20' : open ? 'bg-white/[0.1]' : 'bg-white/[0.06]'
                }`}
              >
                <div className="flex items-center gap-2 px-2.5 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-[13.5px]">
                      {piece ? (
                        <>
                          <span className="text-white/70">{piece.parent}</span>
                          <span className="font-bold text-brand-400">
                            {line.barcode.slice(piece.parent.length)}
                          </span>
                        </>
                      ) : (
                        line.barcode
                      )}
                    </p>
                    {piece && (
                      <p className="mt-0.5 text-[11.5px] text-brand-400">
                        {formatQty(piece.qty)} {known?.unit ?? ''} per piece
                        {known?.note ? ` · ${known.note}` : ''}
                      </p>
                    )}
                  </div>

                  <button
                    onClick={() => (open ? closeCustom() : openCustom(line.barcode))}
                    aria-label={`Custom piece for ${line.barcode}`}
                    aria-expanded={open}
                    className={`grid h-7 w-7 shrink-0 place-items-center rounded-md ${
                      piece || open ? 'bg-brand-500/25 text-brand-300' : 'text-white/30 hover:bg-white/10'
                    }`}
                  >
                    <Scale className="h-4 w-4" />
                  </button>

                  <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-black/30 p-0.5">
                    <button
                      onClick={() => void changeQty(line.barcode, line.qty - 1)}
                      disabled={line.qty <= 1}
                      aria-label={`One less of ${line.barcode}`}
                      className="grid h-7 w-7 place-items-center rounded-md text-white/80 hover:bg-white/10 disabled:opacity-30"
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </button>
                    <span className="min-w-[1.75rem] text-center text-[13px] font-bold">{line.qty}</span>
                    <button
                      onClick={() => void changeQty(line.barcode, line.qty + 1)}
                      aria-label={`One more of ${line.barcode}`}
                      className="grid h-7 w-7 place-items-center rounded-md text-white/80 hover:bg-white/10"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <button
                    onClick={() => void drop(line.barcode)}
                    aria-label={`Remove ${line.barcode}`}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-white/30 hover:bg-rose-500/20 hover:text-rose-400"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {/* ------------------------------------------- custom piece editor */}
                {open && (
                  <div className="space-y-2 border-t border-white/10 px-2.5 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-white/50">
                        Custom piece
                      </p>
                      <button onClick={closeCustom} aria-label="Close" className="text-white/40">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        ref={customQtyRef}
                        value={customQty}
                        onChange={(event) => setCustomQty(event.target.value)}
                        placeholder="5"
                        inputMode="decimal"
                        aria-label="How much in one piece"
                        className="field w-20 shrink-0 py-2 text-center text-[16px] font-bold"
                      />
                      <UnitPicker
                        key={customFor}
                        value={customUnit}
                        onChange={setCustomUnit}
                        className="w-20 shrink-0"
                      />
                      <input
                        value={customNote}
                        onChange={(event) => setCustomNote(event.target.value)}
                        placeholder="Note (optional)"
                        maxLength={40}
                        aria-label="Note"
                        className="field min-w-0 flex-1 py-2 text-[13px]"
                      />
                    </div>

                    <p className="font-mono text-[12.5px] leading-relaxed text-white/50">
                      {parentOf(line.barcode)}
                      <span className="font-bold text-brand-400">{suffix}</span>
                      {suffix ? '' : `${SUB_MARK}…`}
                    </p>

                    <p className="text-[11.5px] leading-relaxed text-white/40">
                      This is the size of <strong>one piece</strong>. The line still counts pieces, so{' '}
                      {line.qty} × {customQty.trim() || '5'} {customUnit || 'kg'} stays {line.qty} on the
                      line. Up to {MAX_DECIMALS} decimal places; a point prints as{' '}
                      <span className="font-mono">{DECIMAL_MARK}</span>.
                    </p>

                    <div className="flex gap-2">
                      {piece && (
                        <button
                          onClick={() => void clearCustom(line.barcode)}
                          disabled={converting}
                          className="btn-ghost flex-1 py-2 text-[13px]"
                        >
                          Back to plain
                        </button>
                      )}
                      <button
                        onClick={() => void saveCustom()}
                        disabled={converting || !suffix}
                        className="btn-primary flex-1 py-2 text-[13px]"
                      >
                        {converting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                        Save piece
                      </button>
                    </div>
                  </div>
                )}
              </article>
            )
          })}
        </div>
      </div>
    </div>
  )
}
