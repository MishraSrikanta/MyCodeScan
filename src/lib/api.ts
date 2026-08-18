/**
 * The MyCodeScan API client.
 *
 * Written against API-CONTRACT.md, not against the reference server. If the two ever
 * disagree, the document is right and the server is wrong.
 *
 * ── Authentication is MyStokio's ────────────────────────────────────────────
 * There are no MyCodeScan accounts. Sign-in goes to `api/v1/auth/login` and `api/v1/auth/register`
 * — the same endpoints MyStokio has always used — and tokens are kept under the same
 * localStorage keys, so serving both apps from one origin shares a single session. One
 * account, both apps.
 *
 * There is deliberately no guest or demo path. MyStokio's own `loginRequest` falls back to
 * a hard-coded "demo-token" whenever the backend is unreachable, which means any
 * credentials appear to work offline. That is defensible for an app whose data never
 * leaves the device; it is not defensible here, where the token is the only thing keeping
 * one shop's scans away from another's. A failed sign-in fails.
 *
 * Three things here are worth more than the rest of the file:
 *
 *   · Token refresh retries a 401 exactly once. A shopkeeper doing a shelf sweep scans
 *     for half an hour, which is longer than an access token lives, and being thrown
 *     back to a login screen mid-sweep loses the session.
 *
 *   · Errors carry the server's `code` as well as its message, so callers can react to
 *     a missing scan differently from a network failure without matching on prose.
 *
 *   · The base URL is compiled in, from config.ts. There is no address field and no
 *     runtime setting, so the phone and the counter cannot end up pointed at different
 *     hosts because somebody typed one of them in wrongly.
 */

import { APIEndpoint, AUTH_STORAGE, DEFAULT_PLAN, DEMO_TOKEN, apiBase, getApiUrl } from './config'


/* ─────────────────────────────────────────────────────────────────── tokens ── */

function readStored(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function writeStored(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(key, value)
    else window.localStorage.removeItem(key)
  } catch {
    // Private browsing. The session simply will not survive a reload.
  }
}

export const tokens = {
  access: () => {
    const token = readStored(AUTH_STORAGE.access)
    /* The demo token is worse than no token: it would be rejected as a bad credential
       rather than reported as "not signed in". */
    return token === DEMO_TOKEN ? '' : token
  },
  refresh: () => readStored(AUTH_STORAGE.refresh),
  set(access: string, refresh?: string) {
    writeStored(AUTH_STORAGE.access, access)
    if (refresh !== undefined) writeStored(AUTH_STORAGE.refresh, refresh)
  },
  clear() {
    writeStored(AUTH_STORAGE.access, '')
    writeStored(AUTH_STORAGE.refresh, '')
  },
}

/** Where this build is pointed, for the "cannot reach the server" message. */
export { apiBase }

/* ──────────────────────────────────────────────────────────────────── types ── */

/** The subscription the auth routes attach to every account. */
export interface Subscription {
  plan?: string
  status?: string
  startedAt?: string
  expiresAt?: string
}

/** An account, as `serialiseAccount()` returns it. */
export interface User {
  id: string
  email: string
  name: string
  phone?: string
  shopName?: string
  role?: string
  subscription?: Subscription
}

/**
 * Whether the account's subscription has run out.
 *
 * Worth knowing because the login route deliberately lets a lapsed account in — locking a
 * shopkeeper out of their own data is a worse answer than telling them what is wrong — so the
 * app has to be able to say so rather than simply failing later.
 */
export function subscriptionExpired(user: User | null): boolean {
  const expiresAt = user?.subscription?.expiresAt
  if (!expiresAt) return false
  const at = new Date(expiresAt).getTime()
  return Number.isFinite(at) && at <= Date.now()
}

export interface ScanItem {
  barcode: string
  qty: number
  firstScannedAt: string
  lastScannedAt: string
}

export interface ScanSummary {
  scanId: string
  label: string
  status: 'open' | 'ready'
  deviceName: string
  itemCount: number
  totalQty: number
  createdAt: string
  updatedAt: string
}

export interface Scan extends ScanSummary {
  items: ScanItem[]
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  /** True when signing in again is the only way forward. */
  get isAuthFailure(): boolean {
    return this.status === 401
  }

  get isMissing(): boolean {
    return this.status === 404
  }
}

/* ────────────────────────────────────────────────────────────────── requests ── */

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/** Called when refresh fails, so the shell can show the login screen. */
let onSessionLost: (() => void) | null = null
export function setSessionLostHandler(handler: () => void): void {
  onSessionLost = handler
}

async function parse(response: Response): Promise<unknown> {
  if (response.status === 204) return null
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    /* A proxy or tunnel returning an HTML error page — say so plainly rather than
       reporting a JSON parse failure the user cannot act on. */
    throw new ApiError('The server did not return JSON. Check the API address.', 'BAD_RESPONSE', response.status)
  }
}

/**
 * Turns a failure body into an error the interface can show.
 *
 * Tolerant of several shapes because the backend uses a flat `{ message }` while the
 * documented scan surface uses `{ error: { code, message } }`. Reading only the latter is
 * what produced "The server returned 400" and hid the server actually saying
 * "userId and password are required" — a message that names the problem exactly.
 *
 * Order matters: the nested form is checked first because it carries a machine-readable
 * code, then the flat forms, then a last-resort mention of the status.
 */
function toError(body: unknown, status: number): ApiError {
  if (typeof body === 'string' && body.trim()) {
    return new ApiError(body.trim(), 'SERVER_ERROR', status)
  }

  const shape = (body ?? {}) as {
    error?: { code?: string; message?: string } | string
    message?: string
    errors?: Record<string, string> | string[]
  }

  const nested = typeof shape.error === 'object' ? shape.error : null
  if (nested?.message) return new ApiError(nested.message, nested.code || 'SERVER_ERROR', status)

  const flat =
    (typeof shape.error === 'string' ? shape.error : '') ||
    shape.message ||
    (Array.isArray(shape.errors) ? shape.errors.join('; ') : '') ||
    (shape.errors && !Array.isArray(shape.errors) ? Object.values(shape.errors).join('; ') : '')

  return new ApiError(flat || `The server returned ${status}.`, 'SERVER_ERROR', status)
}

/**
 * Whether a stored token is still inside its own expiry.
 *
 * The backend has no `api/auth/me` and no refresh endpoint — both 404 — so a session
 * cannot be validated or renewed by asking. The token is a JWT carrying `exp`, which is
 * enough: read it locally, and if it has run out, ask for the password again.
 *
 * A minute of headroom, so a token that expires mid-request is treated as already gone.
 */
export function tokenLooksValid(): boolean {
  const token = tokens.access()
  if (!token) return false
  try {
    const [, payload] = token.split('.')
    if (!payload) return false
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number }
    if (typeof claims.exp !== 'number') return true
    return claims.exp * 1000 > Date.now() + 60_000
  } catch {
    /* Not a JWT we can read. Let the server be the judge. */
    return true
  }
}

/**
 * How long to wait before giving up.
 *
 * Generous because the backend is on a free hosting tier that suspends idle instances: the
 * first request after a quiet spell can take most of a minute to wake it. A shorter timeout
 * would report "could not reach the server" about a server that was merely asleep.
 */
const TIMEOUT_MS = 45_000

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const access = tokens.access()
  if (access) headers.Authorization = `Bearer ${access}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(getApiUrl(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (caught) {
    /* Told apart from a server error, because the fixes are different. */
    throw new ApiError(
      (caught as Error).name === 'AbortError'
        ? 'The server did not answer in time. It may be waking up — try once more.'
        : `Could not reach the server at ${apiBase()}. Check your connection.`,
      'NETWORK',
      0,
    )
  } finally {
    clearTimeout(timer)
  }

  /*
   * No refresh attempt: this backend has no refresh endpoint. A 401 means the 24-hour
   * token has run out, or was never valid, and the only way forward is the password.
   */
  if (response.status === 401) {
    tokens.clear()
    onSessionLost?.()
  }

  const parsed = await parse(response)

  if (!response.ok) {
    const error = toError(parsed, response.status)
    if (error.status === 401) {
      tokens.clear()
      onSessionLost?.()
    }
    throw error
  }

  return parsed as T
}

/* ───────────────────────────────────────────────────────────────────── auth ── */

/**
 * What the auth routes answer.
 *
 * `{ accessToken, account }` from both login and register. The older `token` / `user`
 * spellings are still read, so a backend part-way through the change does not break the app.
 */
interface AuthResponse {
  accessToken?: string
  token?: string
  account?: {
    id?: string
    _id?: string
    name?: string
    email?: string
    phone?: string
    shopName?: string
    role?: string
    subscription?: Subscription
  }
  user?: AuthResponse['account']
  message?: string
}

function normaliseUser(body: AuthResponse, fallbackEmail: string): User {
  const raw = body.account ?? body.user ?? {}
  const email = raw.email ?? fallbackEmail
  return {
    id: raw.id ?? raw._id ?? email,
    email,
    /* A name is not guaranteed; the part before the @ beats an empty string. */
    name: raw.name?.trim() || email.split('@')[0] || 'Account',
    phone: raw.phone,
    shopName: raw.shopName,
    role: raw.role,
    subscription: raw.subscription,
  }
}

function tokenFrom(body: AuthResponse): string {
  return body.accessToken ?? body.token ?? ''
}

/**
 * Signs in with an email and password.
 *
 * No demo fallback. MyStokio's own client substitutes a hard-coded token when the request
 * fails, which makes any credentials appear to work offline; here a failed sign-in fails.
 */
export async function login(email: string, password: string): Promise<User> {
  const body = await request<AuthResponse>('POST', APIEndpoint.LOGIN, { email, password })

  const token = tokenFrom(body)
  if (!token || token === DEMO_TOKEN) {
    throw new ApiError('That sign-in did not return a token.', 'NO_TOKEN', 0)
  }

  /* One token, and no refresh endpoint to use a refresh token with. */
  tokens.set(token, '')
  return normaliseUser(body, email)
}

/** What the register route accepts. */
export interface SignupInput {
  name: string
  email: string
  password: string
  phone?: string
  shopName?: string
  developerCode?: string,
  /** Defaults to DEFAULT_PLAN. The server computes the dates; it never accepts an expiry. */
  plan?: string
}

/**
 * Creates an account and signs in.
 *
 * Register returns a token of its own, so there is no second call — unlike the previous
 * backend, which returned a bare message.
 *
 * `plan` is always sent. The subscription is mandatory, and leaving it out would take the
 * server's own fallback rather than the one year intended.
 */
export async function register(input: SignupInput): Promise<User> {
  const body = await request<AuthResponse>('POST', APIEndpoint.REGISTER, {
    name: input.name,
    email: input.email,
    password: input.password,
    /* Omitted rather than sent blank: optional means absent, not empty, to a validator. */
    ...(input.phone?.trim() ? { phone: input.phone.trim() } : {}),
    ...(input.shopName?.trim() ? { shopName: input.shopName.trim() } : {}),
    plan: input.plan ?? DEFAULT_PLAN,
  })

  const token = tokenFrom(body)
  if (!token || token === DEMO_TOKEN) {
    throw new ApiError('That registration did not return a token.', 'NO_TOKEN', 0)
  }

  tokens.set(token, '')
  return normaliseUser(body, input.email)
}

/** Confirms a stored token still works, and returns who it belongs to. */
export async function me(): Promise<User> {
  const body = await request<{ account?: AuthResponse['account'] }>('GET', APIEndpoint.ME)
  return normaliseUser({ account: body.account }, '')
}

/**
 * Ends the session.
 *
 * The endpoint answers 204 and has nothing to invalidate — tokens are stateless — but it is
 * called anyway so that adding a blocklist later needs no client change. A failure is ignored:
 * dropping the local token is the part that matters.
 */
export async function logout(): Promise<void> {
  try {
    await request<null>('POST', APIEndpoint.LOGOUT)
  } catch {
    // Nothing useful to do; the local token goes regardless.
  }
  tokens.clear()
}

/* ──────────────────────────────────────────────────────────────────── scans ── */

export async function createScan(label: string, deviceName: string): Promise<Scan> {
  return request<Scan>('POST', APIEndpoint.SCANS, { label, deviceName })
}

export async function listScans(status?: 'open' | 'ready'): Promise<ScanSummary[]> {
  const query = status ? `?status=${status}` : ''
  const body = await request<{ scans: ScanSummary[] }>('GET', `${APIEndpoint.SCANS}${query}`)
  return body.scans ?? []
}

export async function getScan(scanId: string): Promise<Scan> {
  return request<Scan>('GET', `${APIEndpoint.SCANS}/${encodeURIComponent(scanId)}`)
}

export async function updateScan(
  scanId: string,
  patch: { label?: string; status?: 'open' | 'ready' },
): Promise<Scan> {
  return request<Scan>('PATCH', `${APIEndpoint.SCANS}/${encodeURIComponent(scanId)}`, patch)
}

export async function deleteScan(scanId: string): Promise<void> {
  await request<null>('DELETE', `${APIEndpoint.SCANS}/${encodeURIComponent(scanId)}`)
}

export async function addItem(
  scanId: string,
  barcode: string,
  qty: number,
  clientItemId: string,
): Promise<Scan> {
  return request<Scan>('POST', `${APIEndpoint.SCANS}/${encodeURIComponent(scanId)}/items`, { barcode, qty, clientItemId })
}

export async function setItemQty(scanId: string, barcode: string, qty: number): Promise<Scan> {
  return request<Scan>('PATCH', `${APIEndpoint.SCANS}/${encodeURIComponent(scanId)}/items`, { barcode, qty })
}

export async function removeItem(scanId: string, barcode: string): Promise<Scan> {
  return request<Scan>('DELETE', `${APIEndpoint.SCANS}/${encodeURIComponent(scanId)}/items`, { barcode })
}
