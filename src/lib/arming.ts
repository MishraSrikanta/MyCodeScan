/**
 * When the scanner's green light comes on, and when it goes out.
 *
 * Two rules, pulled out of useScanner.ts into plain functions with no React and no DOM, because
 * they are timing rules and timing rules are where this behaviour keeps going subtly wrong. Three
 * separate attempts at "the light should mean a barcode is in front of the camera" each looked
 * right and each was wrong in a way only visible on a phone in a shop: one fired on every frame,
 * one never went out after a capture, one never went out at all. They are worth twenty lines of
 * test, and a test needs them callable without a camera.
 *
 * See useScanner.ts for how they are used, and ScanView.tsx for what the operator sees.
 */

/**
 * How long arming stays shut off after a capture.
 *
 * Long enough for the red to register as a deliberate acknowledgement rather than a flicker, short
 * enough that the next item is never waiting on it. Below roughly a third of a second it reads as a
 * rendering glitch; above about a second it feels like the app is thinking.
 */
export const CAPTURE_COOLDOWN_MS = 500

/**
 * How long a candidate survives with no further read before it is dropped.
 *
 * This is what turns the light back to red when the camera moves away. It has to clear a decoder's
 * ordinary misses — a hand shake, a glare, a frame the detector simply failed on — without holding
 * a stale code long after the barcode is gone. Under about half a second the light flickers on any
 * slightly awkward angle; much over a second and it is still green while the shelf is out of view.
 */
export const CANDIDATE_STALE_MS = 800

/** What the scanner is holding, and until when it is refusing to hold anything new. */
export interface ArmState {
  /** The code currently held, or '' for none. */
  candidate: string
  /** No arming before this moment. Set when a capture happens. */
  armAgainAt: number
}

export type ArmAction =
  /** Too soon after a capture. Ignore the read entirely — it must not even count as "still there". */
  | 'cooling-down'
  /** The held barcode, read again. Nothing changes except that it is known to still be in frame. */
  | 'still-there'
  /** Something new. It becomes the candidate, replacing whatever was held. */
  | 'arm'

/**
 * What a decoded read should do.
 *
 * The `cooling-down` case has to come first and has to be total. If a read during the cooldown were
 * allowed to count as "still there" it would keep the freshness clock running, and a barcode left
 * sitting in frame would re-arm the instant the cooldown lapsed — which is the behaviour the
 * cooldown exists to prevent.
 */
export function armAction(read: { code: string; at: number }, state: ArmState): ArmAction {
  if (read.at < state.armAgainAt) return 'cooling-down'
  if (state.candidate === read.code) return 'still-there'
  return 'arm'
}

/**
 * Whether a held candidate should be dropped because nothing is reading it any more.
 *
 * Necessary because the decoders only ever report *success*: there is no "no barcode in this frame"
 * event to listen for, so the absence of reads is the only available signal and it has to be
 * noticed by looking at the clock.
 */
export function isStale(state: ArmState, lastSeen: number, now: number): boolean {
  if (!state.candidate) return false
  return now - lastSeen >= CANDIDATE_STALE_MS
}
