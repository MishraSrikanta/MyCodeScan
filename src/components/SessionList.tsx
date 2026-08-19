/**
 * The list of scan sessions, and the button that starts a new one.
 *
 * A session is created on the server the moment "Start a new scan" is tapped, so it has a scan
 * ID from the outset and every barcode saves itself as it is read. Nothing here needs saving
 * by hand.
 *
 * The scan ID is the largest thing on each row on purpose. It is the one piece of information
 * that has to cross the shop: somebody standing at the counter picks it out of a list in
 * MyStokio, and somebody in the store room may read it aloud. A row that led with the label
 * and buried the ID in grey small print would be a worse list even though it looks tidier.
 */

import {
  AlertTriangle,
  ChevronRight,
  Loader2,
  LogOut,
  Plus,
  Printer,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { type ScanSummary, type User, createScan, deleteScan, listScans } from '../lib/api'
import { discardFor, flush, queueLength } from '../lib/queue'

/** A device name nobody has to type. */
function guessDeviceName(): string {
  const ua = navigator.userAgent
  if (/iPhone|iPad/.test(ua)) return 'iPhone / iPad'
  if (/Android/.test(ua)) return 'Android phone'
  if (/Macintosh/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows PC'
  return 'Phone'
}

function when(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const minutesAgo = Math.round((Date.now() - date.getTime()) / 60000)
  if (minutesAgo < 1) return 'just now'
  if (minutesAgo < 60) return `${minutesAgo} min ago`
  return date.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function SessionList({
  user,
  onOpen,
  onSubBarcodes,
  onSignOut,
}: {
  user: User
  onOpen: (scanId: string) => void
  onSubBarcodes: () => void
  onSignOut: () => void
}) {
  const [scans, setScans] = useState<ScanSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [pending, setPending] = useState(queueLength())

  const refresh = useCallback(async () => {
    setError('')
    try {
      /* Send anything stranded from an earlier offline spell before reading, or the counts
         shown would be behind what the operator actually scanned. */
      if (queueLength() > 0) await flush()
      setPending(queueLength())
      setScans(await listScans())
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /* Flush when the connection returns, without the operator having to think about it. */
  useEffect(() => {
    const onOnline = () => void refresh()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [refresh])

  const start = async () => {
    setCreating(true)
    setError('')
    try {
      const scan = await createScan('', guessDeviceName())
      onOpen(scan.scanId)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setCreating(false)
    }
  }

  const remove = async (scanId: string) => {
    if (!window.confirm(`Delete ${scanId}? The barcodes in it are lost.`)) return
    try {
      await deleteScan(scanId)
      /* Anything still queued for it can never be sent now. */
      discardFor(scanId)
      setPending(queueLength())
      setScans((current) => current.filter((scan) => scan.scanId !== scanId))
    } catch (caught) {
      setError((caught as Error).message)
    }
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-lg flex-col px-4 pb-8 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">Your scans</h1>
          <p className="truncate text-[13px] text-white/50">{user.email || user.name}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button onClick={() => void refresh()} aria-label="Refresh" className="btn-ghost px-3">
            <RefreshCw className="h-4 w-4" />
          </button>
          <button onClick={onSignOut} aria-label="Sign out" className="btn-ghost px-3">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      <button onClick={() => void start()} disabled={creating} className="btn-primary w-full py-3.5 text-base">
        {creating ? <Loader2 className="h-5 w-5 animate-spin" /> : <Plus className="h-5 w-5" />}
        Start a new scan
      </button>

      {/* A separate errand, not a scan session: printing a label rather than reading one. It
          needs no session, no network and no server, so it sits outside the list rather than
          inside it. */}
      <button onClick={onSubBarcodes} className="btn-ghost mt-2 w-full py-3 text-[15px]">
        <Printer className="h-5 w-5" />
        SubBarcode Printing
      </button>

      {pending > 0 && (
        <p className="mt-3 flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-[13px]">
          <Upload className="h-4 w-4 shrink-0 text-amber-400" />
          <span>
            {pending} scan{pending === 1 ? '' : 's'} waiting to upload. They will send themselves when the connection
            returns.
          </span>
        </p>
      )}

      {error && (
        <p className="mt-3 flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-[13px] leading-relaxed">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
          <span>{error}</span>
        </p>
      )}

      <div className="mt-4 space-y-2">
        {loading && (
          <p className="flex items-center justify-center gap-2 py-8 text-sm text-white/45">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading your scans…
          </p>
        )}

        {!loading && scans.length === 0 && !error && (
          <div className="card text-center">
            <p className="text-[15px] font-semibold">No scans yet</p>
            <p className="mt-1 text-[13px] leading-relaxed text-white/50">
              Start one, walk the shelves, and it will be waiting at the counter when you bill.
            </p>
          </div>
        )}

        {scans.map((scan) => (
          <div key={scan.scanId} className="card flex items-center gap-3 p-3">
            <button onClick={() => onOpen(scan.scanId)} className="min-w-0 flex-1 text-left">
              <p className="flex items-center gap-2">
                <span className="font-mono text-[17px] font-bold tracking-wide text-brand-400">{scan.scanId}</span>
                {scan.status === 'ready' && (
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-bold text-emerald-400">
                    Ready
                  </span>
                )}
              </p>
              <p className="mt-0.5 truncate text-[13.5px] text-white/70">{scan.label || 'Untitled scan'}</p>
              <p className="mt-0.5 text-[12px] text-white/40">
                {scan.itemCount} item{scan.itemCount === 1 ? '' : 's'} · {scan.totalQty} unit
                {scan.totalQty === 1 ? '' : 's'} · {when(scan.updatedAt)}
              </p>
            </button>
            <button
              onClick={() => void remove(scan.scanId)}
              aria-label={`Delete ${scan.scanId}`}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white/30 transition-colors hover:bg-rose-500/20 hover:text-rose-400"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <ChevronRight className="h-4 w-4 shrink-0 text-white/25" />
          </div>
        ))}
      </div>

      <p className="mt-6 text-center text-[12px] leading-relaxed text-white/30">
        Every barcode saves itself as you scan it. A scan disappears from this list once it has been billed in MyStokio,
        and after 30 days regardless.
      </p>
    </div>
  )
}
