/**
 * The invite key that gates account creation.
 *
 * A copy of `SIGNUP_ACCESS_KEY` from MyStockio's `src/lib/legal.ts`. Duplicated rather
 * than imported because this folder is a separate deployable and must build with nothing
 * beside it — **if you change it there, change it here.**
 *
 * Why it matters that this exists at all: accounts are shared between the two apps now,
 * so a MyCodeScan signup creates an account that also signs in to MyStockio. Leaving this
 * gate off here would quietly open registration to everybody, having deliberately closed
 * it there.
 *
 * It is a client-side check, and the key ships in the bundle — a speed bump against
 * casual signups, not a security boundary. Anything that actually needs enforcing has to
 * be enforced by the backend.
 */
export const SIGNUP_ACCESS_KEY = 'Srikanta@123'
