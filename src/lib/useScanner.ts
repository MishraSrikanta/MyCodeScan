/**
 * Camera barcode decoding, as a hook.
 *
 * A leaner sibling of the scanner in MyStockio, carrying over the four failures that
 * cost real time to diagnose there. Each one leaves the viewfinder live and nothing
 * happening, which is indistinguishable to the person holding the phone, so each is
 * detected and named rather than swallowed:
 *
 *   · Not a secure origin. `navigator.mediaDevices` is simply undefined on plain http,
 *     which reads as "this browser can't" when the truth is "this URL can't".
 *
 *   · `new BarcodeDetector({ formats })` throws when the platform supports none of the
 *     requested formats. Guarded separately, so it disables one decoder rather than the
 *     whole scanner.
 *
 *   · On Android the native detector is backed by a Play Services module fetched on
 *     demand, and until it lands every `detect()` call rejects. Counted, and the
 *     fallback takes over.
 *
 *   · `@zxing/browser` 0.2 has no `reset()`; it returns controls with `stop()`. Calling
 *     `reset?.()` optionally does nothing at all and leaves the decoder running.
 *
 * ── Confirm mode ─────────────────────────────────────────────────────────────
 * A decoder reads a barcode *every frame it can see one* — thirty times a second. Firing the
 * handler on each read is the obvious implementation and it is wrong: sweeping a camera past a
 * shelf adds the same item a dozen times, and the operator's only clue is a quantity that has
 * silently run away from what is in the basket. A time-based repeat guard helps but cannot fix
 * it, because there is no interval that both stops runaway counting and still lets somebody
 * deliberately scan the same tin twice.
 *
 * So `confirm` inverts who decides. The decoder *arms* — it holds the code it read — and the code
 * is handed over only when `capture()` is called, from a button the operator presses. Reading and
 * recording become two separate acts, which is what they always were.
 *
 * Two states, and the interface is expected to make them visible:
 *
 *   · **seeking** — nothing has been read yet. `candidate` is ''.
 *   · **armed** — a barcode is held and ready. `candidate` is that code.
 *
 * ── The candidate stays armed after a capture ────────────────────────────────
 * `capture()` does *not* clear it, and there is no discard. That is what makes counting fast: six
 * identical tins is six taps of one button, with the camera never leaving the shelf. Clearing on
 * capture would mean re-aiming at the same barcode between every tin and waiting out a repeat
 * guard each time — the slow, fiddly version of exactly the same work.
 *
 * The candidate is replaced when a *different* barcode is read, so moving to the next item needs
 * no button at all. It is never cleared by the barcode merely leaving the frame: the operator's
 * thumb is on the button, not on the phone's aim, and greying it out mid-sequence would break the
 * run of taps it exists to support.
 *
 * The cost, and it is real: point the camera at nothing and the last code is still armed, so a
 * stray tap adds another of it. That is why the button carries the code it will record rather than
 * the word "Capture" alone — the operator is looking at the thing they are about to add.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { IScannerControls } from '@zxing/browser'

/** The formats a shop actually prints or receives. */
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar', 'qr_code']

/** Consecutive native failures that mean the native decoder will not work here. */
const NATIVE_FAILURE_LIMIT = 15

/**
 * One scan per barcode per this long.
 *
 * Free-running mode only, where it is the only thing stopping a code held still from firing every
 * frame. Confirm mode needs no such guard: arming is idempotent — reading the same barcode again
 * is a no-op, because it is already the candidate — and the operator's finger sets the pace.
 */
const REPEAT_GUARD_MS = 1200

interface NativeDetector {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>
}

interface NativeDetectorCtor {
  new (options?: { formats?: string[] }): NativeDetector
  getSupportedFormats?: () => Promise<string[]>
}

export type DecoderKind = 'native' | 'zxing' | 'none'

const CAMERA_KEY = 'mycodescan.cameraId'

function rememberedCamera(): string {
  try {
    return window.localStorage.getItem(CAMERA_KEY) ?? ''
  } catch {
    return ''
  }
}

function rememberCamera(id: string): void {
  try {
    if (id) window.localStorage.setItem(CAMERA_KEY, id)
    else window.localStorage.removeItem(CAMERA_KEY)
  } catch {
    // Nothing to do; the choice just will not persist.
  }
}

/** Why the camera cannot open on this origin, or '' when it can. */
function originProblem(): string {
  if (window.isSecureContext) return ''
  const host = window.location.hostname
  const onLan = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.endsWith('.local')
  return onLan
    ? `Browsers only allow the camera over HTTPS. This page is on http://${host}, so the camera is blocked before the app is even asked. Open the app over HTTPS.`
    : 'Browsers only allow the camera on a secure (HTTPS) page. Open this app over HTTPS, or type barcodes by hand.'
}

async function pickNative(): Promise<NativeDetector | null> {
  const Ctor = (window as unknown as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector
  if (!Ctor) return null

  let formats = [...FORMATS]
  try {
    const supported = await Ctor.getSupportedFormats?.()
    if (supported) {
      formats = formats.filter((format) => supported.includes(format))
      if (formats.length === 0) return null
    }
  } catch {
    // Try the full list.
  }

  try {
    return new Ctor({ formats })
  } catch {
    return null
  }
}

export interface ScannerState {
  videoRef: React.RefObject<HTMLVideoElement>
  starting: boolean
  error: string
  decoder: DecoderKind
  torchOn: boolean
  torchAvailable: boolean
  cameras: MediaDeviceInfo[]
  cameraId: string
  chooseCamera: (id: string) => void
  toggleTorch: () => void
  /**
   * In confirm mode: the barcode being held, ready for `capture()`. '' until the first read.
   *
   * It survives a capture and survives the barcode leaving the frame; only a read of a *different*
   * barcode replaces it. Always '' when confirm mode is off.
   */
  candidate: string
  /** True while the camera is live, nothing has gone wrong, and nothing has been read yet. */
  seeking: boolean
  /** Records the held code. Can be called repeatedly — each call is one more of that item. */
  capture: () => void
}

/**
 * Runs the camera while `active`.
 *
 * With `confirm` off, `onCode` is called for each barcode read. With it on, reads *arm* instead
 * and `onCode` is called from `capture()` — see the note at the top of this file.
 *
 * `onCode` is held in a ref rather than closed over, because the decode loop is created once and
 * would otherwise keep calling the version of the handler that existed when the camera opened —
 * along with whatever state it had captured.
 */
export function useScanner(
  active: boolean,
  onCode: (code: string) => void,
  confirm = false,
): ScannerState {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const zxingRef = useRef<IScannerControls | null>(null)
  const liveRef = useRef(false)
  const lastHitRef = useRef<{ code: string; at: number }>({ code: '', at: 0 })

  const onCodeRef = useRef(onCode)
  useEffect(() => {
    onCodeRef.current = onCode
  }, [onCode])

  /* Both in refs as well as state: the decode loop is created once and reads them from a stale
     closure otherwise, and `accept` must see the *current* candidate to know to stay quiet. */
  const confirmRef = useRef(confirm)
  useEffect(() => {
    confirmRef.current = confirm
  }, [confirm])

  const candidateRef = useRef('')
  const [candidate, setCandidate] = useState('')

  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [decoder, setDecoder] = useState<DecoderKind>('none')
  const [torchOn, setTorchOn] = useState(false)
  const [torchAvailable, setTorchAvailable] = useState(false)
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [cameraId, setCameraId] = useState<string>(() => rememberedCamera())

  const accept = useCallback((raw: string) => {
    const code = raw.trim()
    if (!code) return

    if (confirmRef.current) {
      /*
       * Arming, not recording. No time guard: reading the barcode already held is a no-op, and a
       * different one simply takes its place — which is how moving to the next item works without
       * touching a button. Nothing here can add anything; only `capture` does that.
       */
      if (candidateRef.current === code) return
      candidateRef.current = code
      setCandidate(code)
      return
    }

    const now = Date.now()
    if (lastHitRef.current.code === code && now - lastHitRef.current.at < REPEAT_GUARD_MS) return
    lastHitRef.current = { code, at: now }
    onCodeRef.current(code)
  }, [])

  /**
   * Records the held code, and leaves it held.
   *
   * Deliberately repeatable: six identical tins is six taps, with the camera never leaving the
   * shelf. See the note at the top of this file for why it does not clear.
   */
  const capture = useCallback(() => {
    const code = candidateRef.current
    if (code) onCodeRef.current(code)
  }, [])

  const stop = useCallback(() => {
    liveRef.current = false
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    /* stop(), not reset() — see the note at the top of this file. */
    zxingRef.current?.stop()
    zxingRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setTorchOn(false)
    /* A held code belongs to a live camera. Keeping it across a stop would offer the operator a
       Capture button for something the closed camera saw a minute ago. */
    candidateRef.current = ''
    setCandidate('')
  }, [])

  useEffect(() => {
    if (!active) return
    let cancelled = false

    const fail = (message: string) => {
      if (cancelled) return
      stop()
      setStarting(false)
      setDecoder('none')
      setError(message)
    }

    const run = async () => {
      setError('')
      setStarting(true)

      const origin = originProblem()
      if (origin) {
        fail(origin)
        return
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        fail('This browser does not give web pages a camera. Type barcodes by hand instead.')
        return
      }

      const open = (deviceId: string) =>
        navigator.mediaDevices.getUserMedia({
          video: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
            width: { ideal: 1280 },
            height: { ideal: 720 },
            /* Continuous autofocus where offered: some phones otherwise open a
               fixed-focus wide lens that cannot resolve bars at arm's length, which
               looks exactly like a broken scanner. */
            advanced: [{ focusMode: 'continuous' }],
          } as unknown as MediaTrackConstraints,
          audio: false,
        })

      let stream: MediaStream
      try {
        try {
          stream = await open(cameraId)
        } catch (first) {
          /* A remembered camera that is no longer attached. Forget it and take what is
             there, rather than claiming the camera is broken. */
          const name = (first as Error).name
          if (!cameraId || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw first
          rememberCamera('')
          setCameraId('')
          stream = await open('')
        }
      } catch (caught) {
        const name = (caught as Error).name
        fail(
          name === 'NotAllowedError'
            ? 'Camera permission was refused. Allow camera access for this site, then reopen the scanner.'
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? 'No usable camera was found on this device.'
              : name === 'NotReadableError'
                ? 'The camera is in use by another app. Close it and try again.'
                : (caught as Error).message || 'The camera could not be opened.',
        )
        return
      }

      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      streamRef.current = stream
      const video = videoRef.current
      if (video) {
        video.srcObject = stream
        video.muted = true
        await video.play().catch(() => undefined)
      }

      const track = stream.getVideoTracks()[0]
      const capabilities = (track?.getCapabilities?.() ?? {}) as { torch?: boolean }
      setTorchAvailable(Boolean(capabilities.torch))

      /* Enumerate only now: labels are empty strings until permission is granted, so a
         picker built earlier could not name the cameras. */
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        if (!cancelled) setCameras(devices.filter((device) => device.kind === 'videoinput'))
      } catch {
        // A picker is a convenience; losing it must not stop scanning.
      }

      liveRef.current = true
      setStarting(false)

      const startZxing = async () => {
        if (cancelled || !liveRef.current) return
        setDecoder('zxing')
        try {
          const { BrowserMultiFormatReader } = await import('@zxing/browser')
          if (cancelled || !liveRef.current || !videoRef.current) return
          const reader = new BrowserMultiFormatReader()
          zxingRef.current = await reader.decodeFromVideoElement(videoRef.current, (result) => {
            if (result) accept(result.getText())
          })
        } catch {
          fail('No barcode decoder could start on this device. Type barcodes by hand instead.')
        }
      }

      const native = await pickNative()
      if (cancelled || !liveRef.current) return
      if (!native) {
        await startZxing()
        return
      }

      setDecoder('native')
      let consecutiveFailures = 0

      const tick = async () => {
        if (!liveRef.current || cancelled) return
        const element = videoRef.current
        if (element && element.readyState >= 2) {
          try {
            const codes = await native.detect(element)
            consecutiveFailures = 0
            if (codes.length > 0) accept(codes[0].rawValue)
          } catch {
            consecutiveFailures += 1
            if (consecutiveFailures >= NATIVE_FAILURE_LIMIT) {
              if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
              rafRef.current = null
              await startZxing()
              return
            }
          }
        }
        rafRef.current = requestAnimationFrame(() => void tick())
      }
      void tick()
    }

    void run()
    return () => {
      cancelled = true
      stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, cameraId])

  const chooseCamera = useCallback((id: string) => {
    rememberCamera(id)
    setCameraId(id)
  }, [])

  const toggleTorch = useCallback(() => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    /* `torch` is real on Android but absent from the DOM typings. */
    track
      .applyConstraints({ advanced: [{ torch: !torchOn }] } as unknown as MediaTrackConstraints)
      .then(() => setTorchOn((on) => !on))
      .catch(() => setTorchAvailable(false))
  }, [torchOn])

  return {
    videoRef,
    starting,
    error,
    decoder,
    torchOn,
    torchAvailable,
    cameras,
    cameraId,
    chooseCamera,
    toggleTorch,
    candidate,
    seeking: active && !error && !starting && !candidate,
    capture,
  }
}
