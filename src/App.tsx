/**
 * The shell: decide whether we are signed in, then show one of four screens.
 *
 * No router. There are a handful of states and the ones that matter are modal on the
 * others, so a routing library would be more moving parts than the whole app has screens.
 * The browser back button is handled explicitly for the two navigations that matter —
 * leaving a scan, and leaving the sub-barcode section — because on a phone that is the
 * button people actually use.
 */

import { Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { LoginScreen } from './components/LoginScreen'
import { ScanView } from './components/ScanView'
import { SessionList } from './components/SessionList'
import { SubBarcodeView } from './components/SubBarcodeView'
import {
  type User,
  deleteScan,
  logout,
  me,
  setSessionLostHandler,
  tokenLooksValid,
  tokens,
} from './lib/api'

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
  const [subBarcodes, setSubBarcodes] = useState(false)

  /* One place decides that the session is over, wherever the 401 came from. */
  useEffect(() => {
    setSessionLostHandler(() => {
      setUser(null)
      setOpenScanId(null)
      setSubBarcodes(false)
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

  /*
   * ── Empty scans are not kept ────────────────────────────────────────────────
   * A session is created on the server the moment "Start a new scan" is tapped, and it has to be:
   * the operator taps it at the counter and then walks into the back room, where the signal dies.
   * Deferring creation until the first barcode would put that request in exactly the dead spot the
   * offline queue exists to survive, and the first scan of a session is the one most likely to be
   * lost. So the session is created early — and a session nobody ever put anything into is deleted
   * on the way out instead.
   *
   * It lives here rather than in ScanView because there are two ways out — the on-screen arrow and
   * the phone's own back button — and only one of them passes through a React handler. Both end up
   * in the `popstate` listener below, so this is the single place that closes a scan.
   *
   * ScanView reports its emptiness into this ref. A ref rather than state because nothing renders
   * from it, and because the value is read inside an event listener that must not be re-registered
   * on every keystroke in the label field.
   */
  const scanIsEmpty = useRef(false)

  /* Stable identity: ScanView reports through an effect, and a fresh function on every App
     render would re-run that effect on every keystroke in the scan's label field. */
  const noteScanEmpty = useCallback((emptyNow: boolean) => {
    scanIsEmpty.current = emptyNow
  }, [])

  const closeScan = useCallback(async (scanId: string) => {
    if (scanIsEmpty.current) {
      try {
        await deleteScan(scanId)
      } catch {
        /* Offline, or already gone. Nothing useful to do, and nothing is lost — the scan was
           empty. The server prunes abandoned sessions anyway. */
      }
    }
    scanIsEmpty.current = false
    setOpenScanId(null)
  }, [])

  /*
   * The hardware back button closes whatever is open rather than leaving the app.
   *
   * A history entry is pushed when a screen opens so there is something to pop. Without
   * this, back would exit to whatever page preceded the app — losing the operator's
   * place mid-shelf, which on a phone is the difference between usable and infuriating.
   *
   * One effect for both screens, keyed on which is open: only ever one of them is, and two
   * effects racing to push and pop the same history entry is a bug waiting for the day
   * somebody makes them coexist.
   */
  const openScreen = openScanId ? `scan:${openScanId}` : subBarcodes ? 'sub' : ''
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!openScreen) return
    window.history.pushState({ screen: openScreen }, '')
    const onPop = () => {
      if (openScanId) void closeScan(openScanId)
      setSubBarcodes(false)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [openScreen])

  const signOut = () => {
    void logout()
    try {
      window.localStorage.removeItem(IDENTITY_KEY)
    } catch {
      // nothing to do
    }
    setUser(null)
    setOpenScanId(null)
    setSubBarcodes(false)
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

  /*
   * Pops the entry pushed when the screen opened, so back does not have to be pressed twice.
   *
   * Note what this means for closing a scan: the common path is `history.back()`, which fires the
   * `popstate` listener above — so the on-screen arrow and the phone's own back button both end up
   * in the same handler, and the empty-scan cleanup only has to exist in one place. The fallback is
   * for the case where the history entry has already been consumed.
   */
  const leave = (fallback: () => void) => {
    if (window.history.state?.screen === openScreen) window.history.back()
    else fallback()
  }

  if (openScanId) {
    return (
      <ScanView
        scanId={openScanId}
        onEmptyChange={noteScanEmpty}
        onBack={() => leave(() => void closeScan(openScanId))}
      />
    )
  }

  if (subBarcodes) {
    return <SubBarcodeView onBack={() => leave(() => setSubBarcodes(false))} />
  }

  return (
    <SessionList
      user={user}
      onOpen={setOpenScanId}
      onSubBarcodes={() => setSubBarcodes(true)}
      onSignOut={signOut}
    />
  )
}
