/**
 * The shell: decide whether we are signed in, then show one of three screens.
 *
 * No router. There are exactly three states and one of them is modal on the others, so
 * a routing library would be more moving parts than the whole app has screens. The
 * browser back button is handled explicitly for the one navigation that matters —
 * leaving a scan — because on a phone that is the button people actually use.
 */

import { Loader2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { LoginScreen } from './components/LoginScreen'
import { ScanView } from './components/ScanView'
import { SessionList } from './components/SessionList'
import { type User, logout, me, setSessionLostHandler, tokenLooksValid, tokens } from './lib/api'

type Phase = 'checking' | 'signed-out' | 'signed-in'

const IDENTITY_KEY = 'mycodescan.identity'

/**
 * Remembers who signed in, so a reload does not have to ask the server.
 *
 * Necessary because the backend has no `me` endpoint. Only display fields are kept — the
 * credential is the token, and this is not it.
 */
export function rememberIdentity(user: User): void {
  try {
    window.localStorage.setItem(IDENTITY_KEY, JSON.stringify(user))
  } catch {
    // The session still works; a reload will just show less.
  }
}

function storedIdentity(): User {
  try {
    const raw = window.localStorage.getItem(IDENTITY_KEY)
    if (raw) return JSON.parse(raw) as User
  } catch {
    // fall through
  }
  return { id: '', email: '', name: 'Signed in' }
}

export function App() {
  const [phase, setPhase] = useState<Phase>('checking')
  const [user, setUser] = useState<User | null>(null)
  const [openScanId, setOpenScanId] = useState<string | null>(null)

  /* One place decides that the session is over, wherever the 401 came from. */
  useEffect(() => {
    setSessionLostHandler(() => {
      setUser(null)
      setOpenScanId(null)
      setPhase('signed-out')
    })
  }, [])

  /*
   * Decide from the token itself whether we are still signed in.
   *
   * There is no `api/auth/me` on this backend — it 404s — so there is nothing to ask. The
   * token is a JWT carrying its own expiry, which is enough to avoid showing a session list
   * that would fail on its first request. If it turns out to be rejected anyway, the 401
   * handler below drops it.
   *
   * The display name is remembered locally alongside it, since there is no endpoint to ask
   * who the token belongs to.
   */
  useEffect(() => {
    let alive = true

    /* Cheap local check first: an expired token needs no round trip to reject. */
    if (!tokenLooksValid()) {
      tokens.clear()
      setPhase('signed-out')
      return
    }

    /*
     * Then confirm with the server. `me` exists on these routes, so guessing from the token
     * alone would be a worse answer — it cannot know a revoked account or a token signed with
     * a rotated secret.
     *
     * The remembered identity is shown immediately so the list is not blocked on the request.
     */
    setUser(storedIdentity())
    setPhase('signed-in')

    void (async () => {
      try {
        const current = await me()
        if (!alive) return
        rememberIdentity(current)
        setUser(current)
      } catch {
        /* A 401 has already cleared the session through the handler above. Anything else — a
           dead connection — leaves the remembered identity in place rather than signing a
           shopkeeper out because the shop's wifi dropped. */
      }
    })()

    return () => {
      alive = false
    }
  }, [])

  const closeScan = useCallback(() => setOpenScanId(null), [])

  /*
   * The hardware back button closes an open scan rather than leaving the app.
   *
   * A history entry is pushed when a scan opens so there is something to pop. Without
   * this, back would exit to whatever page preceded the app — losing the operator's
   * place mid-shelf, which on a phone is the difference between usable and infuriating.
   */
  useEffect(() => {
    if (!openScanId) return
    window.history.pushState({ scan: openScanId }, '')
    const onPop = () => closeScan()
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [openScanId, closeScan])

  const signOut = () => {
    void logout()
    try {
      window.localStorage.removeItem(IDENTITY_KEY)
    } catch {
      // nothing to do
    }
    setUser(null)
    setOpenScanId(null)
    setPhase('signed-out')
  }

  if (phase === 'checking') {
    return (
      <div className="grid min-h-full place-items-center">
        <Loader2 className="h-6 w-6 animate-spin text-brand-400" />
      </div>
    )
  }

  if (phase === 'signed-out' || !user) {
    return (
      <LoginScreen
        onSignedIn={(signedIn) => {
          rememberIdentity(signedIn)
          setUser(signedIn)
          setPhase('signed-in')
        }}
      />
    )
  }

  if (openScanId) {
    return (
      <ScanView
        scanId={openScanId}
        onBack={() => {
          /* Pop the entry pushed when the scan opened, so back does not have to be
             pressed twice. */
          if (window.history.state?.scan === openScanId) window.history.back()
          else closeScan()
        }}
      />
    )
  }

  return <SessionList user={user} onOpen={setOpenScanId} onSignOut={signOut} />
}
