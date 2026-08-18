/**
 * The offline scan queue.
 *
 * Every scan is written here first and sent immediately afterwards. That ordering is the
 * whole design: a shop's back room and cold store are exactly where the signal dies, and a
 * scan that vanishes because a request failed means walking the shelves again. The operator
 * should never have to think about whether the network was up, and should never have to
 * remember to press anything — a scan is on the server moments after it is read.
 *
 * Each queued entry carries a `clientItemId`, generated once when the barcode is read and
 * reused on every retry. The server de-duplicates on it — see API-CONTRACT.md §5 — so a
 * request that timed out but actually succeeded cannot be counted twice. Without that key, a
 * flaky connection would inflate stock counts in a way nobody would notice until a stock-take
 * months later.
 */

import { addItem } from './api'

const QUEUE_KEY = 'mycodescan.queue'

export interface QueuedScan {
  /** Idempotency key. Generated at scan time, never regenerated on retry. */
  clientItemId: string
  scanId: string
  barcode: string
  qty: number
  /** When the barcode was actually read, not when it was sent. */
  scannedAt: string
  /** Failed attempts so far, for backing off and for the UI. */
  attempts: number
}

function read(): QueuedScan[] {
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as QueuedScan[]) : []
  } catch {
    return []
  }
}

function write(queue: QueuedScan[]): void {
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
  } catch {
    /* Storage full or blocked. Nothing useful to do — the flush below will still send
       whatever is in memory for this session. */
  }
}

export function queueLength(scanId?: string): number {
  const queue = read()
  return scanId ? queue.filter((entry) => entry.scanId === scanId).length : queue.length
}

export function enqueue(entry: Omit<QueuedScan, 'attempts'>): void {
  const queue = read()
  /* Guard against a double-enqueue of the same key — cheap, and makes the caller's job
     easier if a component ever re-renders mid-scan. */
  if (queue.some((existing) => existing.clientItemId === entry.clientItemId)) return
  queue.push({ ...entry, attempts: 0 })
  write(queue)
}

/** Drops everything queued for a scan — used when that scan is deleted. */
export function discardFor(scanId: string): void {
  write(read().filter((entry) => entry.scanId !== scanId))
}

let flushing = false

export interface FlushResult {
  sent: number
  failed: number
  /** Entries abandoned because the scan they belong to is gone. */
  dropped: number
  remaining: number
}

/**
 * Sends whatever is queued, oldest first.
 *
 * Oldest first matters: quantities accumulate, and while the totals would come out the same
 * either way, `firstScannedAt` on the server should reflect when the item was actually first
 * seen.
 *
 * Stops at the first network failure rather than hammering a dead connection, but keeps going
 * past a 404 — that entry belongs to a scan somebody deleted, and retrying it forever would
 * block every scan behind it.
 */
export async function flush(): Promise<FlushResult> {
  if (flushing) return { sent: 0, failed: 0, dropped: 0, remaining: queueLength() }
  flushing = true

  let sent = 0
  let failed = 0
  let dropped = 0

  try {
    /* Re-read between sends: a scan may finish or be deleted while this runs. */
    for (;;) {
      const queue = read()
      const entry = queue[0]
      if (!entry) break

      try {
        await addItem(entry.scanId, entry.barcode, entry.qty, entry.clientItemId)
        write(read().filter((candidate) => candidate.clientItemId !== entry.clientItemId))
        sent += 1
      } catch (caught) {
        const status = (caught as { status?: number }).status ?? 0

        if (status === 404 || status === 400) {
          /*
           * Either the scan is gone or the payload itself was rejected. Neither can ever
           * succeed, so the entry is abandoned rather than left to block the queue.
           */
          write(read().filter((candidate) => candidate.clientItemId !== entry.clientItemId))
          dropped += 1
          continue
        }

        /* Network failure, auth failure or a server error: leave it in place, record the
           attempt, and stop. Trying the rest now would only fail the same way. */
        const current = read()
        const head = current[0]
        if (head && head.clientItemId === entry.clientItemId) {
          head.attempts += 1
          write(current)
        }
        failed += 1
        break
      }
    }
  } finally {
    flushing = false
  }

  return { sent, failed, dropped, remaining: queueLength() }
}
