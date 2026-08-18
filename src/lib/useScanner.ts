/**
 * Camera barcode decoding, as a hook.
 *
 * A leaner sibling of the scanner in MyStokio, carrying over the four failures that
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
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { IScannerControls } from '@zxing/browser'

/** The formats a shop actually prints or receives. */
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar', 'qr_code']

/** Consecutive native failures that mean the native decoder will not work here. */
const NATIVE_FAILURE_LIMIT = 15

/** One scan per barcode per this long, or a code held still fires every frame. */
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
}

/**
 * Runs the camera while `active`, calling `onCode` for each barcode read.
 *
 * `onCode` is held in a ref rather than closed over, because the decode loop is created
 * once and would otherwise keep calling the version of the handler that existed when
 * the camera opened — along with whatever state it had captured.
 */
export function useScanner(active: boolean, onCode: (code: string) => void): ScannerState {
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
    const now = Date.now()
    if (lastHitRef.current.code === code && now - lastHitRef.current.at < REPEAT_GUARD_MS) return
    lastHitRef.current = { code, at: now }
    onCodeRef.current(code)
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
  }
}
