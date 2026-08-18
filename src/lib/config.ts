/**
 * Backend address and endpoint paths.
 *
 * A deliberate copy of the shape of MyStokio's `src/api/config.ts`, because it is the same
 * backend and the same accounts. Two bases, one manual switch, and an endpoint enum whose
 * auth entries are identical to MyStokio's.
 *
 * ── Endpoint shapes come from the accountAuthRoutes router ────────────────────
 * Mounted at `/api/v1/auth`, so every auth path carries that prefix. Login takes an
 * **email**, registration takes a subscription plan, and both answer
 * `{ accessToken, account }`.
 *
 * ── Change the environment here ──────────────────────────────────────────────
 * `ENV` below is the single switch. It defaults to `'prod'` and is meant to be edited by
 * hand — not derived from `import.meta.env.DEV`, so that a development build points at
 * production unless somebody deliberately says otherwise. There is no runtime setting and
 * no address field in the interface: one compiled value, so the phone and the counter
 * cannot drift apart because somebody typed a different host into one of them.
 */

/** Deployed backend. This is the default. */
const PROD_BASE = 'https://financegpt-backend-phm6.onrender.com/'

/** Development backend. Point this wherever you test; it is not used unless ENV is 'dev'. */
const DEV_BASE = 'https://financegpt-backend-phm6.onrender.com/'

/**
 * Which base to use. **Edit this line to switch.**
 *
 * Typed as the union rather than inferred, so changing it to `'dev'` cannot silently widen
 * the type and slip past the compiler.
 */
const ENV: 'dev' | 'prod' = 'prod'

/** The backend base, always with exactly one trailing slash. */
export function apiBase(): string {
  const base = ENV === 'dev' ? DEV_BASE : PROD_BASE
  return base.endsWith('/') ? base : `${base}/`
}

/**
 * Endpoint paths, relative to `apiBase()`.
 *
 * LOGIN and REGISTER are MyStokio's own values, unchanged — the whole point is that both
 * apps call the same two endpoints, so one account works in both.
 *
 * The rest are added here. Note the split: auth is unversioned because those endpoints
 * already exist and are not ours to renumber, while the scan surface is versioned because
 * it is new and its shape may change without every phone being updated.
 */
export enum APIEndpoint {
  LOGIN = 'api/v1/auth/login',
  REGISTER = 'api/v1/auth/register',
  ME = 'api/v1/auth/me',
  LOGOUT = 'api/v1/auth/logout',
  SCANS = 'api/v1/scans',
}

/**
 * The subscription plan sent at registration.
 *
 * Mandatory: an account without a subscription has no expiry, and the login route needs one to
 * decide whether to show a renewal screen. The server computes the actual dates from this —
 * an expiry is never accepted as input — so this is the only part the client chooses.
 *
 * **This string must match a plan `buildSubscription()` recognises.** One year is the default
 * asked for; the server's own fallback is lifetime, so sending it explicitly is what makes the
 * two agree.
 */
export const DEFAULT_PLAN = '1year'

/**
 * The plans a new account can be opened on.
 *
 * Offered as a real choice rather than hidden, because the subscription decides when the
 * account stops working and the person creating it is the one who should know. The server
 * computes the dates from whichever of these is sent.
 *
 * **These keys must match what `buildSubscription()` recognises.**
 */
export const PLANS: { value: string; label: string; note: string }[] = [
  { value: '1year', label: '1 year', note: 'Renews yearly. The default.' },
  { value: '2year', label: '2 years', note: 'Two years from today.' },
  { value: 'lifetime', label: 'Lifetime', note: 'Never expires.' },
]

/** Joins the base and an endpoint. `apiBase()` ends in a slash; paths never start with one. */
export function getApiUrl(endpoint: APIEndpoint | string): string {
  return `${apiBase()}${String(endpoint).replace(/^\//, '')}`
}

/**
 * Token storage keys — MyStokio's own, from its `AUTH_STORAGE`.
 *
 * Shared on purpose: serve both apps from one origin and a single sign-in covers them.
 */
export const AUTH_STORAGE = {
  access: 'stockledger.accessToken',
  refresh: 'stockledger.refreshToken',
} as const

/**
 * The token MyStokio's demo fallback manufactures when its backend is unreachable.
 *
 * Treated as no token at all wherever it appears. MyStokio's `loginRequest` returns this
 * literal string whenever the real endpoint fails and the fields are merely non-empty, so
 * it genuinely turns up in shared storage. Sending it would produce a puzzling 401 about
 * scans; recognising it means asking for a real sign-in instead.
 */
export const DEMO_TOKEN = 'demo-token'
