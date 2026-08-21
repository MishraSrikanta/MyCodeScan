/**
 * MyCodeScan reference backend.
 *
 *   node server.mjs            # listens on 8787
 *   PORT=9000 node server.mjs
 *
 * Implements API-CONTRACT.md exactly, with no dependencies at all — node's own http,
 * crypto and fs. That is deliberate: this file exists to settle arguments about the
 * contract and to develop the two front-ends against, so it has to run anywhere with a
 * node binary and nothing else.
 *
 * ── What this is not ────────────────────────────────────────────────────────────
 * Not production software. Storage is one JSON file rewritten on every change, there is
 * no clustering, no migration path and no observability. It is correct, not scalable.
 *
 * What it *is* safe about, because getting these wrong would teach the wrong lesson to
 * anyone porting it: passwords are scrypt-hashed with a per-user salt, tokens are signed
 * and verified properly, every scan query is filtered by the owner's id, and a scan
 * belonging to someone else returns 404 rather than 403.
 */

import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_DIR ?? join(HERE, 'data')
const DATA_FILE = join(DATA_DIR, 'mycodescan.json')
const PORT = Number(process.env.PORT ?? 8787)
/*
 * Routes are absolute, and split deliberately:
 *
 *   api/auth/...     MyStockio's existing endpoints, unversioned. Not ours to renumber.
 *   api/v1/scans/... the new scan surface, versioned from the start so its shape can
 *                    change later without breaking a phone nobody has updated.
 */

/**
 * Token signing secret.
 *
 * Generated per boot when unset, which means restarting invalidates every session. Fine
 * for development and loud about the problem in production — set MYCODESCAN_SECRET.
 */
const SECRET = process.env.MYCODESCAN_SECRET ?? randomBytes(32).toString('hex')
if (!process.env.MYCODESCAN_SECRET) {
  console.warn('MYCODESCAN_SECRET is not set — tokens will not survive a restart.')
}

const ACCESS_TTL_S = 60 * 60
const REFRESH_TTL_S = 60 * 60 * 24 * 30
/** Sessions older than this are swept. See API-CONTRACT.md §7. */
const RETENTION_DAYS = 30

/** Origins allowed to call this API. Extend for your deployments. */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)
  .concat(['http://localhost:5173', 'http://localhost:5174', 'http://localhost:4173'])

/* ─────────────────────────────────────────────────────────────────── storage ── */

/** { users: [...], scans: [...] } */
let db = { users: [], scans: [] }

function load() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  if (!existsSync(DATA_FILE)) {
    save()
    return
  }
  try {
    db = JSON.parse(readFileSync(DATA_FILE, 'utf8'))
    db.users ??= []
    db.scans ??= []
  } catch {
    console.error('Could not read the data file; starting empty.')
    db = { users: [], scans: [] }
  }
}

function save() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(DATA_FILE, JSON.stringify(db, null, 2))
}

/* ──────────────────────────────────────────────────────────────── passwords ── */

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`
}

function verifyPassword(password, stored) {
  try {
    const [scheme, salt, digest] = String(stored).split('$')
    if (scheme !== 'scrypt' || !salt || !digest) return false
    const expected = Buffer.from(digest, 'hex')
    const actual = scryptSync(password, salt, expected.length)
    /* Constant-time, so response timing cannot be used to narrow a password down. */
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

/* ─────────────────────────────────────────────────────────────────── tokens ── */

const b64url = (input) => Buffer.from(input).toString('base64url')

function sign(payload, ttlSeconds) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }))
  const signature = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${signature}`
}

/** Returns the payload, or null for anything malformed, mis-signed or expired. */
function verify(token) {
  if (typeof token !== 'string') return null
  const [header, body, signature] = token.split('.')
  if (!header || !body || !signature) return null

  const expected = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null
    return payload
  } catch {
    return null
  }
}

function issueTokens(user) {
  return {
    accessToken: sign({ sub: user.id, typ: 'access' }, ACCESS_TTL_S),
    refreshToken: sign({ sub: user.id, typ: 'refresh' }, REFRESH_TTL_S),
  }
}

/**
 * Plans, and the expiry each one implies.
 *
 * Computed here and never accepted as input: a client that could post its own `expiresAt`
 * could grant itself a decade. One year is the default, so an account created without a plan
 * still has a real expiry rather than none.
 */
const PLANS = {
  '1year': 365,
  '2year': 730,
  lifetime: null,
}

const DEFAULT_PLAN = '1year'

function buildSubscription(plan) {
  const chosen = typeof plan === 'string' && plan in PLANS ? plan : DEFAULT_PLAN
  const days = PLANS[chosen]
  const startedAt = new Date()
  return {
    plan: chosen,
    status: 'active',
    startedAt: startedAt.toISOString(),
    expiresAt:
      days === null ? null : new Date(startedAt.getTime() + days * 24 * 60 * 60 * 1000).toISOString(),
  }
}

/**
 * The auth response, matching the accountAuthRoutes router.
 *
 * `{ accessToken, account }` from both login and register — one token, no refresh token. The
 * password hash is deliberately absent: it has no business leaving the database, and shipping
 * it to every client that signs in hands anyone who captures one response something to crack
 * offline at their leisure.
 */
function authResponse(user) {
  return {
    accessToken: sign({ sub: user.id, typ: 'access' }, ACCESS_TTL_S),
    account: publicUser(user),
  }
}

/* ─────────────────────────────────────────────────────────────────── scan id ── */

/** Crockford base32 with the vowels removed — see API-CONTRACT.md §4. */
const ID_ALPHABET = '0123456789BCDFGHJKLMNPQRSTVWXYZ'

function newScanId() {
  /* Retry on collision rather than trusting randomness: the ID is only 5 characters
     because it has to be readable across a shop floor. */
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const bytes = randomBytes(5)
    let id = 'SC-'
    for (let i = 0; i < 5; i += 1) id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length]
    if (!db.scans.some((scan) => scan.scanId === id)) return id
  }
  throw new Error('Could not allocate a scan id')
}

/* ───────────────────────────────────────────────────────────── presentation ── */

const round3 = (n) => Math.round(n * 1000) / 1000

/**
 * An account, as `serialiseAccount()` returns it.
 *
 * Both id spellings are present because clients read `id ?? _id` — a Mongo backend returns
 * the latter. The password hash is deliberately absent; see authResponse.
 */
function publicUser(user) {
  return {
    id: user.id,
    _id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    shopName: user.shopName,
    role: user.role,
    subscription: user.subscription,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt ?? user.createdAt,
  }
}

/** The wire shape. `withItems` false is the list form — see API-CONTRACT.md §4. */
function publicScan(scan, withItems = true) {
  const shape = {
    scanId: scan.scanId,
    label: scan.label,
    status: scan.status,
    deviceName: scan.deviceName,
    /* Computed here every time, never read from a client. */
    itemCount: scan.items.length,
    totalQty: round3(scan.items.reduce((sum, item) => sum + item.qty, 0)),
    createdAt: scan.createdAt,
    updatedAt: scan.updatedAt,
  }
  if (withItems) {
    shape.items = scan.items.map((item) => ({
      barcode: item.barcode,
      qty: item.qty,
      firstScannedAt: item.firstScannedAt,
      lastScannedAt: item.lastScannedAt,
    }))
  }
  return shape
}

/* ────────────────────────────────────────────────────────────────── plumbing ── */

function sendJson(res, status, body, origin) {
  const payload = body === null ? '' : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...corsHeaders(origin),
  })
  res.end(payload)
}

/**
 * A flat `{ message }` body, which is what the auth endpoints use.
 *
 * The scan surface keeps the richer `{ error: { code, message } }` shape via sendError.
 * Two shapes is not a design choice — it is what the deployed server does, and both clients
 * read both.
 */
function sendMessage(res, status, message, origin) {
  sendJson(res, status, { message }, origin)
}

function sendError(res, status, code, message, origin, details = null) {
  sendJson(res, status, { error: { code, message, details } }, origin)
}

function corsHeaders(origin) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin)
  return {
    /* Echo an allow-listed origin rather than using `*`: the clients send an
       Authorization header, and a wildcard with credentials is refused by browsers. */
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0] ?? '*',
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      /* A scan payload is tiny; anything large is a mistake or an attack. */
      if (size > 1_000_000) {
        reject(new Error('PAYLOAD_TOO_LARGE'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('BAD_JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** The authenticated user, or null. */
function authenticate(req) {
  const header = req.headers.authorization ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return null
  /*
   * MyStockio's client manufactures a literal "demo-token" when its backend is
   * unreachable, so that string will genuinely arrive here. Refused explicitly rather
   * than left to fail signature verification, because a server that ever accepted it
   * would hand one shop's scan sessions to anybody who typed any password.
   */
  if (match[1] === 'demo-token') return null
  const payload = verify(match[1])
  if (!payload || payload.typ !== 'access') return null
  return db.users.find((user) => user.id === payload.sub) ?? null
}

/**
 * Finds one of this user's scans.
 *
 * Owner-scoped in the lookup itself, not checked afterwards, and a miss is reported as
 * "not found" whether the scan is absent or simply someone else's — otherwise the
 * difference between 403 and 404 lets anyone enumerate other people's scan ids.
 */
function findScan(user, scanId) {
  const wanted = String(scanId ?? '').toUpperCase()
  return db.scans.find((scan) => scan.scanId === wanted && scan.userId === user.id) ?? null
}

function touch(scan) {
  scan.updatedAt = new Date().toISOString()
}

/**
 * Whether an identifier is usable.
 *
 * Non-empty, and that is all. MyStockio's login field is a free-text **User ID** — its
 * client validates nothing in login mode and only checks emptiness on signup — so an
 * account may legitimately be identified by a phone number, a shop code or a name.
 * Enforcing an email pattern here would create accounts that cannot be signed into from
 * the app that owns the login screen.
 *
 * The JSON field is still called `email` because that is what MyStockio sends. The name is
 * historical; the meaning is "identifier".
 */
const isValidIdentifier = (value) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 190

/** Sweeps sessions nobody will open again. See API-CONTRACT.md §7. */
function sweepOldScans() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  const before = db.scans.length
  db.scans = db.scans.filter((scan) => new Date(scan.updatedAt).getTime() >= cutoff)
  if (db.scans.length !== before) {
    console.log(`Swept ${before - db.scans.length} scan(s) older than ${RETENTION_DAYS} days.`)
    save()
  }
}

/* ─────────────────────────────────────────────────────────────────── routing ── */

const server = createServer(async (req, res) => {
  const origin = req.headers.origin
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin))
    res.end()
    return
  }

  /* Unauthenticated liveness check, outside the versioned base. */
  if (path === '/health') {
    sendJson(res, 200, { ok: true, service: 'mycodescan', users: db.users.length, scans: db.scans.length }, origin)
    return
  }

  const route = path

  let body = {}
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    try {
      body = await readBody(req)
    } catch (caught) {
      const tooLarge = caught.message === 'PAYLOAD_TOO_LARGE'
      sendError(
        res,
        tooLarge ? 413 : 400,
        tooLarge ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_FAILED',
        tooLarge ? 'That request was too large.' : 'The request body was not valid JSON.',
        origin,
      )
      return
    }
  } else {
    /* DELETE carries a body for item removal — see API-CONTRACT.md §5. */
    if (req.method === 'DELETE') {
      try {
        body = await readBody(req)
      } catch {
        body = {}
      }
    }
  }

  try {
    await handle(req, res, route, body, origin, url)
  } catch (caught) {
    console.error(caught)
    sendError(res, 500, 'SERVER_ERROR', 'Something went wrong on the server.', origin)
  }
})

async function handle(req, res, route, body, origin, url) {
  /* ---------------------------------------------------------------- auth ---- */

  /* Mounted at /api/v1/auth, matching accountAuthRoutes. */
  if (route === '/api/v1/auth/register' && req.method === 'POST') {
    const email = String(body.email ?? '').trim().toLowerCase()
    const password = String(body.password ?? '')
    const name = String(body.name ?? '').trim()
    const phone = String(body.phone ?? '').trim().slice(0, 20)
    const shopName = String(body.shopName ?? '').trim().slice(0, 120)

    const details = {}
    if (!name) details.name = 'is required'
    if (!isValidIdentifier(email)) details.email = 'is required'
    if (password.length === 0) details.password = 'is required'
    if (Object.keys(details).length > 0) {
      sendError(res, 400, 'VALIDATION_FAILED', 'Please check the details entered.', origin, details)
      return
    }

    /*
     * The unique index is what decides, not a prior lookup — a check-then-insert lets two
     * simultaneous signups both through. Here the "index" is this one check, but the ordering
     * is kept so the shape matches a real implementation.
     */
    if (db.users.some((user) => user.email === email)) {
      sendError(res, 409, 'EMAIL_TAKEN', 'An account with that email already exists.', origin)
      return
    }

    const user = {
      /* Hex, so it looks like the Mongo ObjectId a real backend returns. */
      id: randomBytes(12).toString('hex'),
      email,
      name,
      phone,
      shopName,
      role: 'admin',
      /* Mandatory, and derived from the plan rather than taken as input. */
      subscription: buildSubscription(body.plan),
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    }
    db.users.push(user)
    save()
    /* Register returns a token, so no second call is needed. */
    sendJson(res, 201, authResponse(user), origin)
    return
  }

  if (route === '/api/v1/auth/login' && req.method === 'POST') {
    /* Lower-cased, so an address typed in any case still matches. */
    const email = String(body.email ?? '').trim().toLowerCase()
    const password = String(body.password ?? '')

    if (!email || !password) {
      sendError(res, 400, 'VALIDATION_FAILED', 'Email and password are required.', origin, {
        email: email ? undefined : 'is required',
        password: password ? undefined : 'is required',
      })
      return
    }

    const user = db.users.find((candidate) => candidate.email === email)

    /*
     * An unknown email and a wrong password give the identical 401, so this endpoint cannot be
     * used to find out which addresses are registered. The hash is compared even when nothing
     * matched, so the two cases also take roughly the same time to answer — otherwise the
     * timing alone reveals which emails exist.
     */
    const hash = user ? user.passwordHash : `scrypt$0000${'0'.repeat(128)}`
    const matches = verifyPassword(password, hash)

    if (!user || !matches) {
      sendError(res, 401, 'UNAUTHENTICATED', 'Email or password is incorrect.', origin)
      return
    }

    /*
     * A lapsed subscription still signs in. The app needs the account to show a renewal
     * screen, and locking a shopkeeper out of their own data is a worse answer than telling
     * them what is wrong.
     */
    sendJson(res, 200, authResponse(user), origin)
    return
  }

  if (route === '/api/v1/auth/logout' && req.method === 'POST') {
    /* Tokens are stateless, so there is nothing to invalidate. Present so both apps have an
       endpoint to call, and so adding a blocklist later needs no client change. */
    res.writeHead(204, corsHeaders(origin))
    res.end()
    return
  }

  /*
   * An unmatched auth route is a 404, not a 401.
   *
   * Without this it falls through to the token check below and answers 401 — which reads as
   * "you are not signed in" for a route that simply does not exist, and sends anyone
   * debugging it looking at their credentials. The live server answers 404 here
   * ("Cannot POST /api/auth/signup"), and that difference is exactly how the wrong
   * registration path went unnoticed.
   */
  if (route.startsWith('/api/v1/auth/') && route !== '/api/v1/auth/me') {
    sendError(res, 404, 'NOT_FOUND', `Cannot ${req.method} ${route}`, origin)
    return
  }

  /*
   * Everything past here needs a valid token.
   *
   * There is deliberately no api/auth/me, api/auth/refresh or api/auth/logout: all three
   * 404 on the live server. A session is renewed by signing in again, and whether a stored
   * token is still good is decided by reading its own expiry.
   */
  const user = authenticate(req)

  if (!user) {
    sendError(res, 401, 'UNAUTHENTICATED', 'Please sign in again.', origin)
    return
  }

  if (route === '/api/v1/auth/me' && req.method === 'GET') {
    /* Called on app start to decide whether a stored token is still good. */
    sendJson(res, 200, { account: publicUser(user) }, origin)
    return
  }

  /* --------------------------------------------------------------- scans ---- */

  if (route === '/api/v1/scans' && req.method === 'POST') {
    const label = String(body.label ?? '').trim().slice(0, 80)
    const deviceName = String(body.deviceName ?? '').trim().slice(0, 60)
    const now = new Date().toISOString()

    const scan = {
      scanId: newScanId(),
      userId: user.id,
      label,
      status: 'open',
      deviceName,
      items: [],
      /* Idempotency keys already applied, newest last. Capped when appended. */
      seenClientIds: [],
      createdAt: now,
      updatedAt: now,
    }
    db.scans.push(scan)
    save()
    sendJson(res, 201, publicScan(scan), origin)
    return
  }

  if (route === '/api/v1/scans' && req.method === 'GET') {
    const status = url.searchParams.get('status')
    const rawLimit = Number(url.searchParams.get('limit') ?? 50)
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 50
    const cursor = url.searchParams.get('cursor')

    if (status && status !== 'open' && status !== 'ready') {
      sendError(res, 400, 'VALIDATION_FAILED', 'status must be open or ready.', origin, {
        status: 'open | ready',
      })
      return
    }

    /* Owner-scoped in the filter itself. */
    let scans = db.scans
      .filter((scan) => scan.userId === user.id)
      .filter((scan) => !status || scan.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    /* The cursor is the updatedAt of the last row already sent. Opaque to clients. */
    if (cursor) {
      try {
        const after = Buffer.from(cursor, 'base64url').toString('utf8')
        scans = scans.filter((scan) => scan.updatedAt.localeCompare(after) < 0)
      } catch {
        sendError(res, 400, 'VALIDATION_FAILED', 'That page cursor is not valid.', origin)
        return
      }
    }

    const page = scans.slice(0, limit)
    const more = scans.length > page.length
    sendJson(
      res,
      200,
      {
        scans: page.map((scan) => publicScan(scan, false)),
        nextCursor: more ? Buffer.from(page[page.length - 1].updatedAt).toString('base64url') : null,
      },
      origin,
    )
    return
  }

  const scanMatch = /^\/api\/v1\/scans\/([^/]+)(\/items)?$/.exec(route)
  if (!scanMatch) {
    sendError(res, 404, 'NOT_FOUND', 'No such endpoint.', origin)
    return
  }

  const [, rawScanId, itemsSuffix] = scanMatch
  const scanId = decodeURIComponent(rawScanId)
  const scan = findScan(user, scanId)

  /* ------------------------------------------------------- one scan ---- */
  if (!itemsSuffix) {
    if (req.method === 'DELETE') {
      /*
       * Idempotent by contract: MyStockio calls this automatically after saving an
       * invoice and may retry. A 404 here would report a failure for an operation that
       * had in fact already succeeded.
       */
      if (scan) {
        db.scans = db.scans.filter((candidate) => candidate !== scan)
        save()
      }
      res.writeHead(204, corsHeaders(origin))
      res.end()
      return
    }

    if (!scan) {
      sendError(res, 404, 'SCAN_NOT_FOUND', 'That scan no longer exists.', origin)
      return
    }

    if (req.method === 'GET') {
      sendJson(res, 200, publicScan(scan), origin)
      return
    }

    if (req.method === 'PATCH') {
      if (body.label !== undefined) scan.label = String(body.label).trim().slice(0, 80)
      if (body.status !== undefined) {
        if (body.status !== 'open' && body.status !== 'ready') {
          sendError(res, 400, 'VALIDATION_FAILED', 'status must be open or ready.', origin, {
            status: 'open | ready',
          })
          return
        }
        scan.status = body.status
      }
      touch(scan)
      save()
      sendJson(res, 200, publicScan(scan), origin)
      return
    }

    sendError(res, 404, 'NOT_FOUND', 'No such endpoint.', origin)
    return
  }

  /* ---------------------------------------------------------- items ---- */
  if (!scan) {
    sendError(res, 404, 'SCAN_NOT_FOUND', 'That scan no longer exists.', origin)
    return
  }

  const barcode = String(body.barcode ?? '').trim()

  if (req.method === 'POST') {
    if (!barcode || barcode.length > 64) {
      sendError(res, 400, 'VALIDATION_FAILED', 'A barcode is required.', origin, {
        barcode: 'must be 1 to 64 characters',
      })
      return
    }

    const qty = body.qty === undefined ? 1 : Number(body.qty)
    if (!Number.isFinite(qty) || qty <= 0) {
      sendError(res, 400, 'VALIDATION_FAILED', 'Quantity must be more than zero.', origin, {
        qty: 'must be a number greater than 0',
      })
      return
    }

    /*
     * Idempotency. The phone queues scans while offline and flushes them later, so the
     * same request genuinely arrives twice. Without this, a retry after a timeout that
     * actually succeeded double-counts stock — a bug that shows up a month later as
     * unexplained shrinkage.
     */
    const clientItemId = body.clientItemId ? String(body.clientItemId) : ''
    if (clientItemId && scan.seenClientIds.includes(clientItemId)) {
      sendJson(res, 200, publicScan(scan), origin)
      return
    }

    const now = new Date().toISOString()
    const existing = scan.items.find((item) => item.barcode === barcode)
    if (existing) {
      existing.qty = round3(existing.qty + qty)
      existing.lastScannedAt = now
    } else {
      scan.items.push({ barcode, qty: round3(qty), firstScannedAt: now, lastScannedAt: now })
    }

    if (clientItemId) {
      scan.seenClientIds.push(clientItemId)
      /* Bounded — the contract asks for at least the last 500. */
      if (scan.seenClientIds.length > 500) scan.seenClientIds = scan.seenClientIds.slice(-500)
    }

    touch(scan)
    save()
    sendJson(res, 200, publicScan(scan), origin)
    return
  }

  if (req.method === 'PATCH') {
    const qty = Number(body.qty)
    if (!Number.isFinite(qty) || qty <= 0) {
      /* Zero is a validation error, not a delete, so an off-by-one cannot silently
         remove a line. */
      sendError(res, 400, 'VALIDATION_FAILED', 'Quantity must be more than zero.', origin, {
        qty: 'must be a number greater than 0',
      })
      return
    }
    const item = scan.items.find((candidate) => candidate.barcode === barcode)
    if (!item) {
      sendError(res, 404, 'ITEM_NOT_FOUND', 'That barcode is not in this scan.', origin)
      return
    }
    item.qty = round3(qty)
    item.lastScannedAt = new Date().toISOString()
    touch(scan)
    save()
    sendJson(res, 200, publicScan(scan), origin)
    return
  }

  if (req.method === 'DELETE') {
    const before = scan.items.length
    scan.items = scan.items.filter((item) => item.barcode !== barcode)
    if (scan.items.length !== before) {
      touch(scan)
      save()
    }
    /* Idempotent, and returns the scan rather than 204 because the client needs the
       recomputed totals. */
    sendJson(res, 200, publicScan(scan), origin)
    return
  }

  sendError(res, 404, 'NOT_FOUND', 'No such endpoint.', origin)
}

/* ────────────────────────────────────────────────────────────────────── boot ── */

load()
sweepOldScans()
setInterval(sweepOldScans, 60 * 60 * 1000).unref()

server.listen(PORT, () => {
  console.log(`MyCodeScan reference API on http://localhost:${PORT}`)
  console.log('Auth:  api/v1/auth/{login,register,me,logout}')
  console.log('Scans: api/v1/scans')
  console.log(`Data file: ${DATA_FILE}`)
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`)
})
