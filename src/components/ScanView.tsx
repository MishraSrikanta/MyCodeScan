/**
 * The scanning screen: camera above, the list of what has been scanned below.
 *
 * Same split as MyStokio's billing scanner, for the same reason — a full-screen camera hides
 * the thing being built, so the operator has to leave the camera after every item to check it
 * worked. Here the list is right there.
 *
 * ── Each scan saves itself ───────────────────────────────────────────────────
 * A barcode is queued locally and sent immediately. There is nothing to press and nothing to
 * remember: by the time the operator has moved to the next shelf, the item is on the server
 * and visible at the counter.
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
  ScanBarcode,
  Trash2,
  Upload,
  Video,
  Zap,
  ZapOff,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type Scan, getScan, removeItem, setItemQty, updateScan } from '../lib/api'
import { enqueue, flush, queueLength } from '../lib/queue'
import { useScanner } from '../lib/useScanner'

/** A local view of a line, so the list can update before the server replies. */
interface Line {
  barcode: string
  qty: number
}

function linesFrom(scan: Scan | null): Line[] {
  return (scan?.items ?? []).map((item) => ({ barcode: item.barcode, qty: item.qty }))
}

export function ScanView({ scanId, onBack }: { scanId: string; onBack: () => void }) {
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

  /** A barcode was read — from the camera or typed. */
  const onCode = useCallback(
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

  useEffect(
    () => () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current)
    },
    [],
  )

  const camera = useScanner(!loading && !error, onCode)

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

  const saveLabel = async () => {
    if (!scan || label === scan.label) return
    try {
      const fresh = await updateScan(scanId, { label })
      setScan(fresh)
    } catch (caught) {
      setError((caught as Error).message)
    }
  }

  /** Marks the session done and returns to the list. */
  const finish = async () => {
    setSavingStatus(true)
    setError('')
    try {
      await flush()
      refreshPending()
      await updateScan(scanId, { status: 'ready', label })
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
        <button onClick={() => void finish()} disabled={savingStatus} className="btn-primary shrink-0 px-3 text-sm">
          {savingStatus ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          Done
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

        {!camera.error && (
          <div className="pointer-events-none absolute inset-0 mx-auto grid max-w-[520px] place-items-center">
            <div className="relative h-[42%] w-[78%] max-w-sm">
              {[
                'left-0 top-0 border-l-4 border-t-4 rounded-tl-xl',
                'right-0 top-0 border-r-4 border-t-4 rounded-tr-xl',
                'left-0 bottom-0 border-b-4 border-l-4 rounded-bl-xl',
                'right-0 bottom-0 border-b-4 border-r-4 rounded-br-xl',
              ].map((corner) => (
                <span key={corner} className={`absolute h-9 w-9 border-brand-400 ${corner}`} />
              ))}
            </div>
          </div>
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

        {lastCode && !camera.error && (
          <p className="absolute inset-x-0 bottom-0 mx-auto max-w-[520px] truncate bg-gradient-to-t from-black/85 to-transparent px-4 pb-2 pt-6 text-center font-mono text-[13px] font-semibold">
            <Check className="mr-1 inline h-3.5 w-3.5 text-emerald-400" />
            {lastCode}
          </p>
        )}
      </div>

      {/* --------------------------------------------------------- controls */}
      <div className="shrink-0 space-y-2 px-3 pt-2.5">
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
          onBlur={() => void saveLabel()}
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
                  Point the camera at a barcode. Scan the same one twice to count two.
                </p>
              </div>
            </div>
          )}

          {/* Newest first: on a short list the alternative is that every new scan lands below
              the fold, which defeats having the list at all. */}
          {[...lines].reverse().map((line) => (
            <article
              key={line.barcode}
              className={`flex items-center gap-2 rounded-xl px-2.5 py-2 transition-colors ${
                flash === line.barcode ? 'bg-emerald-500/20' : 'bg-white/[0.06]'
              }`}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[13.5px]">{line.barcode}</span>

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
            </article>
          ))}
        </div>
      </div>
    </div>
  )
}
