/**
 * Tests for the offline scan queue.
 *
 *   npm run test:queue
 *
 * Each barcode uploads itself as it is read, which is only trustworthy because of the queue.
 * The assertions that earn their place are the failure ones, because the promises the flow
 * rests on are both about failure:
 *
 *   · a scan taken with no signal is not lost, and
 *   · a request that timed out after actually succeeding is not counted twice.
 *
 * Both are checked against the reference server, with failures injected by patching fetch —
 * the only way to make a real mid-sequence failure happen on demand.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * Resolved from the working directory, not from import.meta.url: this file is bundled before
 * it runs, and the bundle lives elsewhere. npm scripts run with the package root as cwd.
 */
const SERVER = join(process.cwd(), 'server-reference', 'server.mjs')
const PORT = 8797
const DATA_DIR = mkdtempSync(join(tmpdir(), 'queue-test-'))

/* localStorage, before any module that reads it is imported. */
const store = new Map<string, string>()
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
}

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) return
  failures += 1
  console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`)
}

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, MYCODESCAN_SECRET: 'queue-test' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`)
      if (response.ok) return
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('reference server did not start')
}

try {
  await waitForServer()

  const queue = await import('./queue')
  const api = await import('./api')

  /*
   * Guard before anything else: the host is compiled in, so a test that failed to redirect it
   * would create accounts and sessions on the real backend.
   */
  const base = (await import('./config')).apiBase()
  if (!base.startsWith(`http://127.0.0.1:${PORT}`)) {
    throw new Error(`client base is ${base}, not the test server — the build step did not pin it`)
  }
  console.log(`client base: ${base}`)

  /* Register signs in by itself now — it returns a token. */
  const account = await api.register({ name: 'Queue', email: 'q@shop.com', password: 'pw' })
  check('registered and signed in', api.tokens.access().length > 20)
  check('the account carries a one-year subscription', account.subscription?.plan === '1year', JSON.stringify(account.subscription))
  check('the subscription is not expired', !api.subscriptionExpired(account))

  /* And signing in again with the same credentials works. */
  const again = await api.login('q@shop.com', 'pw')
  check('login by email works', again.email === 'q@shop.com', JSON.stringify(again))

  const confirmed = await api.me()
  check('me confirms the token', confirmed.email === 'q@shop.com', JSON.stringify(confirmed))

  const scan = await api.createScan('Shelf 3', 'Android phone')
  check('a session is created up front, with an id', /^SC-/.test(scan.scanId), scan.scanId)

  const realFetch = globalThis.fetch
  const enqueueOne = (barcode: string) =>
    queue.enqueue({
      clientItemId: crypto.randomUUID(),
      scanId: scan.scanId,
      barcode,
      qty: 1,
      scannedAt: new Date().toISOString(),
    })

  /* ── the happy path ───────────────────────────────────────────────────────── */
  console.log('scan and send')

  enqueueOne('BC-RICE')
  check('a scan is queued locally first', queue.queueLength(scan.scanId) === 1)

  const first = await queue.flush()
  check('flush sends it', first.sent === 1, JSON.stringify(first))
  check('the queue is empty afterwards', queue.queueLength() === 0)

  const afterFirst = await api.getScan(scan.scanId)
  check('it reached the server', afterFirst.items.length === 1, JSON.stringify(afterFirst.items))

  /* Scanning the same code again increments rather than adding a second line. */
  enqueueOne('BC-RICE')
  await queue.flush()
  const afterRepeat = await api.getScan(scan.scanId)
  check('a repeat increments the same line', afterRepeat.items.length === 1, JSON.stringify(afterRepeat.items))
  check('...to two', afterRepeat.items[0]?.qty === 2, String(afterRepeat.items[0]?.qty))

  /* ── scanning with no signal ──────────────────────────────────────────────── */
  console.log('offline, then reconnected')

  globalThis.fetch = (async () => {
    throw new Error('offline')
  }) as typeof fetch

  enqueueOne('BC-DAL')
  enqueueOne('BC-OIL')
  const offline = await queue.flush()
  globalThis.fetch = realFetch

  check('an offline flush reports the failure', offline.failed === 1, JSON.stringify(offline))
  check('nothing was sent', offline.sent === 0)
  check('both scans are still queued', queue.queueLength(scan.scanId) === 2, String(queue.queueLength(scan.scanId)))

  const stillOffline = await api.getScan(scan.scanId)
  check('the server has not seen them', stillOffline.items.length === 1, JSON.stringify(stillOffline.items))

  const reconnected = await queue.flush()
  check('reconnecting sends the backlog', reconnected.sent === 2, JSON.stringify(reconnected))
  check('the queue drains', queue.queueLength() === 0)

  const afterReconnect = await api.getScan(scan.scanId)
  check('all three barcodes are present', afterReconnect.items.length === 3, JSON.stringify(afterReconnect.items))

  /* ── the case that would corrupt stock ───────────────────────────────────── */
  console.log('a request that succeeded but looked like it failed')

  /*
   * The nastiest real-world failure: the server accepts the item and the response is lost, so
   * the client believes it failed and retries. Without de-duplication on clientItemId the
   * barcode would be counted twice, and nobody would notice until a stock-take.
   */
  const sneaky = crypto.randomUUID()
  queue.enqueue({
    clientItemId: sneaky,
    scanId: scan.scanId,
    barcode: 'BC-GHOST',
    qty: 1,
    scannedAt: new Date().toISOString(),
  })

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const response = await realFetch(url, init)
    /* Let it through, then pretend the reply never arrived. */
    if (/\/items$/.test(String(url)) && init?.method === 'POST') throw new Error('reply lost')
    return response
  }) as typeof fetch

  const lost = await queue.flush()
  globalThis.fetch = realFetch
  check('the client believes it failed', lost.failed === 1, JSON.stringify(lost))
  check('so the scan stays queued', queue.queueLength(scan.scanId) === 1)

  const serverSaw = await api.getScan(scan.scanId)
  check(
    'the server did in fact record it',
    serverSaw.items.find((item) => item.barcode === 'BC-GHOST')?.qty === 1,
    JSON.stringify(serverSaw.items.map((i) => [i.barcode, i.qty])),
  )

  const retried = await queue.flush()
  check('the retry is accepted', retried.sent === 1, JSON.stringify(retried))

  const afterRetry = await api.getScan(scan.scanId)
  check(
    'and the barcode is still one, not two',
    afterRetry.items.find((item) => item.barcode === 'BC-GHOST')?.qty === 1,
    JSON.stringify(afterRetry.items.map((i) => [i.barcode, i.qty])),
  )

  /* ── a deleted session must not block the queue ──────────────────────────── */
  console.log('a scan deleted underneath the queue')

  const doomed = await api.createScan('Doomed', 'Android phone')
  queue.enqueue({
    clientItemId: crypto.randomUUID(),
    scanId: doomed.scanId,
    barcode: 'D-1',
    qty: 1,
    scannedAt: new Date().toISOString(),
  })
  enqueueOne('BC-AFTER')
  await api.deleteScan(doomed.scanId)

  const past404 = await queue.flush()
  check('the orphaned entry is abandoned', past404.dropped === 1, JSON.stringify(past404))
  check('...and the scan behind it still goes', past404.sent === 1, JSON.stringify(past404))
  check('the queue is clear', queue.queueLength() === 0)

  /* ── discarding a scan's queue ───────────────────────────────────────────── */
  const other = await api.createScan('Other', 'Android phone')
  queue.enqueue({
    clientItemId: crypto.randomUUID(),
    scanId: other.scanId,
    barcode: 'O-1',
    qty: 1,
    scannedAt: new Date().toISOString(),
  })
  enqueueOne('BC-KEEP')
  check('two scans queued across two sessions', queue.queueLength() === 2)

  queue.discardFor(other.scanId)
  check('discardFor clears only that session', queue.queueLength() === 1, String(queue.queueLength()))
  check('...and leaves the other', queue.queueLength(scan.scanId) === 1)

  await queue.flush()

  console.log()
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
} catch (caught) {
  failures += 1
  console.log(`ERROR  ${(caught as Error).message}`)
  console.log((caught as Error).stack)
} finally {
  child.kill()
  try {
    rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    // best effort
  }
  process.exitCode = failures === 0 ? 0 : 1
}
