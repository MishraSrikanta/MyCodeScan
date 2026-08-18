/**
 * Checks the reference server against API-CONTRACT.md.
 *
 *   node contract.test.mjs
 *
 * Boots the server on a spare port with a throwaway data file, then exercises every
 * endpoint and every rule the contract states explicitly. If this passes, the document
 * and the implementation agree — which is the only way either can be trusted, since the
 * two front-ends are written against the document rather than against the server.
 *
 * The assertions worth their weight are the negative ones: that a wrong password and an
 * unknown email are indistinguishable, that another user's scan is 404 and not 403, that
 * DELETE is idempotent, and that a replayed clientItemId does not double-count.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 8791
/* The host root: paths carry their own api/ prefix, matching MyStokio. */
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'mycodescan-test-'))

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) return
  failures += 1
  console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`)
}

const child = spawn(process.execPath, [join(HERE, 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, MYCODESCAN_SECRET: 'test-secret', ALLOWED_ORIGINS: 'http://localhost:5174' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})

/** Waits for the port to answer rather than sleeping a guessed amount. */
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
  throw new Error('server did not start')
}

async function call(method, path, { token, body, origin } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (origin) headers.Origin = origin

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const text = await response.text()
  let json = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = { unparseable: text }
    }
  }
  return { status: response.status, json, headers: response.headers }
}

try {
  await waitForServer()

  /* ── auth ───────────────────────────────────────────────────────────────── */
  /*
   * The accountAuthRoutes router, mounted at /api/v1/auth. Login takes an email, registration
   * takes a subscription plan, and both answer { accessToken, account }.
   */
  console.log('auth')

  const regEmpty = await call('POST', '/api/v1/auth/register', { body: {} })
  check('register with no body is 400', regEmpty.status === 400, JSON.stringify(regEmpty.json))
  check(
    'register names every missing field',
    Boolean(regEmpty.json?.error?.details?.name && regEmpty.json?.error?.details?.email && regEmpty.json?.error?.details?.password),
    JSON.stringify(regEmpty.json?.error?.details),
  )

  const reg = await call('POST', '/api/v1/auth/register', {
    body: {
      name: 'Ramesh',
      email: 'Owner@Shop.com',
      password: 'password123',
      phone: '9876543210',
      shopName: 'Ramesh General Store',
      plan: '1year',
    },
  })
  check('register returns 201', reg.status === 201, JSON.stringify(reg.json))
  check('register returns a token straight away', typeof reg.json?.accessToken === 'string' && reg.json.accessToken.length > 20)
  check('register returns an account', Boolean(reg.json?.account?.id), JSON.stringify(reg.json?.account))
  check('the email is stored lower-cased', reg.json?.account?.email === 'owner@shop.com', reg.json?.account?.email)
  check('the optional fields are kept', reg.json?.account?.phone === '9876543210' && reg.json?.account?.shopName === 'Ramesh General Store')

  /* The subscription is mandatory, and computed rather than accepted. */
  const sub = reg.json?.account?.subscription
  check('an account has a subscription', Boolean(sub), JSON.stringify(sub))
  check('...on the plan asked for', sub?.plan === '1year', String(sub?.plan))
  check('...with a real expiry', Boolean(sub?.expiresAt) && new Date(sub.expiresAt).getTime() > Date.now())
  check(
    '...roughly a year away',
    Math.abs((new Date(sub.expiresAt).getTime() - Date.now()) / 86_400_000 - 365) < 2,
    sub?.expiresAt,
  )

  /* No plan at all still yields one year, so no account is left without an expiry. */
  const noPlan = await call('POST', '/api/v1/auth/register', {
    body: { name: 'NoPlan', email: 'noplan@shop.com', password: 'password123' },
  })
  check('a missing plan defaults to one year', noPlan.json?.account?.subscription?.plan === '1year', JSON.stringify(noPlan.json?.account?.subscription))

  /* An expiry is never taken from the client. */
  const forged = await call('POST', '/api/v1/auth/register', {
    body: {
      name: 'Forged',
      email: 'forged@shop.com',
      password: 'password123',
      subscription: { expiresAt: '2099-01-01T00:00:00.000Z' },
      plan: '1year',
    },
  })
  check(
    'a client-supplied expiry is ignored',
    new Date(forged.json?.account?.subscription?.expiresAt).getFullYear() < 2030,
    JSON.stringify(forged.json?.account?.subscription),
  )

  /* The hash must never leave the database. */
  check('register never returns a password hash', !JSON.stringify(reg.json).includes('$') || !JSON.stringify(reg.json).includes('scrypt'))

  const dupe = await call('POST', '/api/v1/auth/register', {
    body: { name: 'Again', email: 'owner@shop.com', password: 'password123', plan: '1year' },
  })
  check('a duplicate email is 409 EMAIL_TAKEN', dupe.status === 409 && dupe.json?.error?.code === 'EMAIL_TAKEN', JSON.stringify(dupe.json))

  const loginEmpty = await call('POST', '/api/v1/auth/login', { body: {} })
  check('login with no body is 400', loginEmpty.status === 400, JSON.stringify(loginEmpty.json))

  const wrongPassword = await call('POST', '/api/v1/auth/login', { body: { email: 'owner@shop.com', password: 'nope12345' } })
  const unknownEmail = await call('POST', '/api/v1/auth/login', { body: { email: 'ghost@shop.com', password: 'password123' } })
  check('a wrong password is 401', wrongPassword.status === 401, JSON.stringify(wrongPassword.json))
  check('an unknown email is 401', unknownEmail.status === 401)
  check(
    'the two are indistinguishable',
    wrongPassword.json?.error?.message === unknownEmail.json?.error?.message,
    `${wrongPassword.json?.error?.message} vs ${unknownEmail.json?.error?.message}`,
  )

  const login = await call('POST', '/api/v1/auth/login', { body: { email: 'OWNER@shop.com', password: 'password123' } })
  check('login is case-insensitive on email', login.status === 200, JSON.stringify(login.json))
  check('login returns accessToken and account', Boolean(login.json?.accessToken && login.json?.account))
  check('login returns no refresh token', login.json?.refreshToken === undefined)

  const token = login.json.accessToken

  const me = await call('GET', '/api/v1/auth/me', { token })
  check('me returns the account', me.status === 200 && me.json?.account?.email === 'owner@shop.com', JSON.stringify(me.json))
  check('me never returns a password hash', !JSON.stringify(me.json).includes('scrypt'))

  const meNoToken = await call('GET', '/api/v1/auth/me')
  check('me without a token is 401', meNoToken.status === 401, String(meNoToken.status))

  const loggedOut = await call('POST', '/api/v1/auth/logout', { token, body: {} })
  check('logout answers 204', loggedOut.status === 204, String(loggedOut.status))

  /* MyStokio's client manufactures this exact string when its backend is unreachable. */
  const demo = await call('GET', '/api/v1/scans', { token: 'demo-token' })
  check('the literal demo-token is refused', demo.status === 401, String(demo.status))

  const noAuth = await call('GET', '/api/v1/scans')
  check('no token is 401 UNAUTHENTICATED', noAuth.status === 401 && noAuth.json?.error?.code === 'UNAUTHENTICATED')

  const junkAuth = await call('GET', '/api/v1/scans', { token: 'not.a.token' })
  check('malformed token is 401', junkAuth.status === 401)

  /* An unmatched auth route is a 404, not a 401 — otherwise a wrong path reads as a
     credentials problem and sends anyone debugging it in the wrong direction. */
  const unmatchedAuth = await call('POST', '/api/v1/auth/signup', { body: { email: 'a@b.com', password: 'p' } })
  check('an unmatched auth route is 404', unmatchedAuth.status === 404, String(unmatchedAuth.status))

  /* ── scans ──────────────────────────────────────────────────────────────── */
  console.log('scans')

  const created = await call('POST', '/api/v1/scans', { token, body: { label: 'Shelf 3', deviceName: 'Android phone' } })
  check('create returns 201', created.status === 201, JSON.stringify(created.json))
  const scanId = created.json?.scanId
  check('scanId matches the documented format', /^SC-[0-9BCDFGHJKLMNPQRSTVWXYZ]{5}$/.test(scanId ?? ''), scanId)
  check('new scan starts open', created.json?.status === 'open')
  check('new scan has an empty item list', Array.isArray(created.json?.items) && created.json.items.length === 0)
  check('new scan totals are zero', created.json?.itemCount === 0 && created.json?.totalQty === 0)

  const list = await call('GET', '/api/v1/scans', { token })
  check('list returns the scan', list.status === 200 && list.json?.scans?.length === 1)
  check('list omits items', list.json?.scans?.[0]?.items === undefined)
  check('list reports nextCursor', list.json?.nextCursor === null)

  /* ── items ──────────────────────────────────────────────────────────────── */
  console.log('items')

  const noBarcode = await call('POST', `/api/v1/scans/${scanId}/items`, { token, body: {} })
  check('missing barcode is 400', noBarcode.status === 400 && noBarcode.json?.error?.details?.barcode !== undefined)

  const zeroQty = await call('POST', `/api/v1/scans/${scanId}/items`, { token, body: { barcode: '111', qty: 0 } })
  check('qty of zero is rejected on create', zeroQty.status === 400)

  await call('POST', `/api/v1/scans/${scanId}/items`, { token, body: { barcode: '2000000000017' } })
  const twice = await call('POST', `/api/v1/scans/${scanId}/items`, { token, body: { barcode: '2000000000017' } })
  check('re-scanning increments rather than duplicating', twice.json?.items?.length === 1, JSON.stringify(twice.json?.items))
  check('quantity became 2', twice.json?.items?.[0]?.qty === 2)
  check('lastScannedAt moved', twice.json?.items?.[0]?.lastScannedAt >= twice.json?.items?.[0]?.firstScannedAt)

  /* The idempotency rule — the whole reason clientItemId exists. */
  const key = 'fixed-key-1'
  const first = await call('POST', `/api/v1/scans/${scanId}/items`, { token, body: { barcode: '999', qty: 1, clientItemId: key } })
  const replay = await call('POST', `/api/v1/scans/${scanId}/items`, { token, body: { barcode: '999', qty: 1, clientItemId: key } })
  const line = replay.json?.items?.find((item) => item.barcode === '999')
  check('a replayed clientItemId does not double-count', line?.qty === 1, JSON.stringify(line))
  check('the replay still returns current state', first.status === 200 && replay.status === 200)

  const fractional = await call('POST', `/api/v1/scans/${scanId}/items`, { token, body: { barcode: 'LOOSE', qty: 0.5 } })
  check('fractional quantities are accepted', fractional.json?.items?.find((i) => i.barcode === 'LOOSE')?.qty === 0.5)

  const patched = await call('PATCH', `/api/v1/scans/${scanId}/items`, { token, body: { barcode: '2000000000017', qty: 5 } })
  check('patch sets an exact quantity', patched.json?.items?.find((i) => i.barcode === '2000000000017')?.qty === 5)

  const patchZero = await call('PATCH', `/api/v1/scans/${scanId}/items`, { token, body: { barcode: '2000000000017', qty: 0 } })
  check('patch to zero is a validation error, not a delete', patchZero.status === 400)

  const patchMissing = await call('PATCH', `/api/v1/scans/${scanId}/items`, { token, body: { barcode: 'NOPE', qty: 2 } })
  check('patching an absent barcode is 404 ITEM_NOT_FOUND', patchMissing.status === 404 && patchMissing.json?.error?.code === 'ITEM_NOT_FOUND')

  const removed = await call('DELETE', `/api/v1/scans/${scanId}/items`, { token, body: { barcode: '999' } })
  check('delete item returns the scan, not 204', removed.status === 200 && Array.isArray(removed.json?.items))
  check('the line is gone', !removed.json.items.some((item) => item.barcode === '999'))

  const removeAgain = await call('DELETE', `/api/v1/scans/${scanId}/items`, { token, body: { barcode: '999' } })
  check('deleting an absent item is idempotent', removeAgain.status === 200)

  /* Totals are computed, never trusted from the client. */
  const lied = await call('POST', `/api/v1/scans/${scanId}/items`, {
    token,
    body: { barcode: 'X1', qty: 1, itemCount: 999, totalQty: 999 },
  })
  check('client-supplied totals are ignored', lied.json?.itemCount === lied.json?.items?.length, JSON.stringify({ c: lied.json?.itemCount, n: lied.json?.items?.length }))

  /* ── label and status ───────────────────────────────────────────────────── */
  console.log('label and status')

  const ready = await call('PATCH', `/api/v1/scans/${scanId}`, { token, body: { status: 'ready', label: 'Shelf 3 and 4' } })
  check('status becomes ready', ready.json?.status === 'ready')
  check('label updated', ready.json?.label === 'Shelf 3 and 4')

  const backOpen = await call('PATCH', `/api/v1/scans/${scanId}`, { token, body: { status: 'open' } })
  check('ready can go back to open', backOpen.json?.status === 'open')

  const badStatus = await call('PATCH', `/api/v1/scans/${scanId}`, { token, body: { status: 'finished' } })
  check('an unknown status is rejected', badStatus.status === 400)

  const filtered = await call('GET', '/api/v1/scans?status=ready', { token })
  check('status filter works', filtered.json?.scans?.length === 0, JSON.stringify(filtered.json))

  const badFilter = await call('GET', '/api/v1/scans?status=nope', { token })
  check('an unknown status filter is 400', badFilter.status === 400)

  /* ── case-insensitive ids ───────────────────────────────────────────────── */
  const lower = await call('GET', `/api/v1/scans/${scanId.toLowerCase()}`, { token })
  check('scanId is case-insensitive on input', lower.status === 200 && lower.json?.scanId === scanId)

  /* ── isolation between users ────────────────────────────────────────────── */
  console.log('isolation')

  const other = await call('POST', '/api/v1/auth/register', {
    body: { name: 'Other', email: 'other@shop.com', password: 'password123', plan: '1year' },
  })
  check('the second account was created', other.status === 201, JSON.stringify(other.json))
  const otherToken = other.json.accessToken

  const otherList = await call('GET', '/api/v1/scans', { token: otherToken })
  check('a new user sees no scans', otherList.json?.scans?.length === 0)

  const peek = await call('GET', `/api/v1/scans/${scanId}`, { token: otherToken })
  check(
    "another user's scan is 404, never 403",
    peek.status === 404 && peek.json?.error?.code === 'SCAN_NOT_FOUND',
    `got ${peek.status} ${peek.json?.error?.code}`,
  )

  const hijack = await call('POST', `/api/v1/scans/${scanId}/items`, { token: otherToken, body: { barcode: 'EVIL' } })
  check("another user cannot add to someone else's scan", hijack.status === 404)

  const otherDelete = await call('DELETE', `/api/v1/scans/${scanId}`, { token: otherToken })
  check("another user's delete does not remove it", otherDelete.status === 204)
  const stillThere = await call('GET', `/api/v1/scans/${scanId}`, { token })
  check('...and the owner still has the scan', stillThere.status === 200)

  /* ── ordering ───────────────────────────────────────────────────────────── */
  console.log('ordering')

  const second = await call('POST', '/api/v1/scans', { token, body: { label: 'Second' } })
  await call('POST', `/api/v1/scans/${scanId}/items`, { token, body: { barcode: 'BUMP' } })
  const ordered = await call('GET', '/api/v1/scans', { token })
  check(
    'most recently updated comes first',
    ordered.json?.scans?.[0]?.scanId === scanId,
    `first is ${ordered.json?.scans?.[0]?.scanId}, expected ${scanId}`,
  )
  check('both scans listed', ordered.json?.scans?.length === 2)

  /* ── delete, and its idempotency ────────────────────────────────────────── */
  console.log('delete')

  const gone = await call('DELETE', `/api/v1/scans/${scanId}`, { token })
  check('delete returns 204', gone.status === 204)

  const goneAgain = await call('DELETE', `/api/v1/scans/${scanId}`, { token })
  check('delete is idempotent — 204 the second time, not 404', goneAgain.status === 204, `got ${goneAgain.status}`)

  const readGone = await call('GET', `/api/v1/scans/${scanId}`, { token })
  check('a deleted scan reads as 404', readGone.status === 404)

  await call('DELETE', `/api/v1/scans/${second.json.scanId}`, { token })

  /* ── CORS ───────────────────────────────────────────────────────────────── */
  console.log('cors')

  const preflight = await fetch(`${BASE}/api/v1/scans`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5174', 'Access-Control-Request-Method': 'POST' },
  })
  check('preflight answers 204', preflight.status === 204, String(preflight.status))
  check(
    'preflight echoes the allow-listed origin',
    preflight.headers.get('access-control-allow-origin') === 'http://localhost:5174',
    preflight.headers.get('access-control-allow-origin') ?? 'none',
  )
  check('preflight allows Authorization', (preflight.headers.get('access-control-allow-headers') ?? '').includes('Authorization'))
  check('preflight allows PATCH and DELETE', /PATCH/.test(preflight.headers.get('access-control-allow-methods') ?? '') && /DELETE/.test(preflight.headers.get('access-control-allow-methods') ?? ''))

  /* ── malformed input ────────────────────────────────────────────────────── */
  console.log('malformed input')

  const badJson = await fetch(`${BASE}/scans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{not json',
  })
  check('bad JSON is 400, not a crash', badJson.status === 400, String(badJson.status))

  const nowhere = await call('GET', '/nope', { token })
  check('an unknown route is 404', nowhere.status === 404)

  console.log()
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
} catch (caught) {
  failures += 1
  console.log(`ERROR  ${caught.message}`)
} finally {
  child.kill()
  try {
    rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    // best effort
  }
  process.exitCode = failures === 0 ? 0 : 1
}
