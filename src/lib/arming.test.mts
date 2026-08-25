/**
 * The green light's timing rules.
 *
 * Run with `npm run test:arming`. These are twenty lines of arithmetic guarding a behaviour that
 * has now been got wrong three times, each time in a way that only showed up on a phone in a shop:
 * a light that fired on every frame, a light that never went out after a capture, a light that
 * never went out at all. The failures are all *timing*, so they are all testable — which is the
 * whole reason these rules were pulled out of the camera hook.
 *
 * The scenarios below are walked as sequences rather than checked as individual cases, because
 * every one of those bugs was a transition between two states that were each fine on their own.
 */

import {
  CANDIDATE_STALE_MS,
  CAPTURE_COOLDOWN_MS,
  type ArmState,
  armAction,
  isStale,
} from './arming'

let checks = 0

function eq(actual: unknown, expected: unknown, what: string): void {
  checks += 1
  if (actual !== expected) {
    throw new Error(`FAIL: ${what} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

const NOTHING: ArmState = { candidate: '', armAgainAt: 0 }

/* ─────────────────────────────────────────────────────── the basic three ── */

eq(armAction({ code: 'A', at: 1000 }, NOTHING), 'arm', 'a first read arms')
eq(
  armAction({ code: 'A', at: 1000 }, { candidate: 'A', armAgainAt: 0 }),
  'still-there',
  'reading the held barcode again is not a new arm',
)
eq(
  armAction({ code: 'B', at: 1000 }, { candidate: 'A', armAgainAt: 0 }),
  'arm',
  'a different barcode takes its place, so the next item needs no button',
)

/* ────────────────────────────────────────────────── the cooldown after a capture ── */

/*
 * The bug this catches: capture clears the candidate, but the barcode is usually still sitting in
 * frame, so without a cooldown the very next decoded frame re-arms it and the operator sees no
 * change at all. The button looks broken while working perfectly.
 */
{
  const capturedAt = 5000
  const afterCapture: ArmState = { candidate: '', armAgainAt: capturedAt + CAPTURE_COOLDOWN_MS }

  eq(
    armAction({ code: 'A', at: capturedAt + 1 }, afterCapture),
    'cooling-down',
    'the same barcode, still in frame, cannot re-arm immediately',
  )
  eq(
    armAction({ code: 'A', at: capturedAt + CAPTURE_COOLDOWN_MS - 1 }, afterCapture),
    'cooling-down',
    'nor a moment before the cooldown is up',
  )
  eq(
    armAction({ code: 'A', at: capturedAt + CAPTURE_COOLDOWN_MS }, afterCapture),
    'arm',
    'but it re-arms the moment the cooldown lapses',
  )
  /* A *different* barcode is held off too. Half a second is imperceptible when moving to the next
     item, and letting it through would mean the light's meaning depended on which barcode it was. */
  eq(
    armAction({ code: 'B', at: capturedAt + 1 }, afterCapture),
    'cooling-down',
    'a different barcode waits out the cooldown as well',
  )
}

/* ──────────────────────────────────────────────────── the light going out ── */

{
  const seenAt = 9000
  const held: ArmState = { candidate: 'A', armAgainAt: 0 }

  eq(isStale(held, seenAt, seenAt), false, 'a barcode just read is not stale')
  eq(isStale(held, seenAt, seenAt + CANDIDATE_STALE_MS - 1), false, 'nor one read a moment ago')
  eq(isStale(held, seenAt, seenAt + CANDIDATE_STALE_MS), true, 'but it goes out once the window passes')
  eq(isStale(NOTHING, seenAt, seenAt + 10_000), false, 'nothing held is never stale, however long ago')
}

/* ───────────────────────────────────────────── the sequence, end to end ── */

/*
 * A whole interaction, walked one read at a time. This is the check that matters: each rule above
 * passed in the broken versions too, and what was wrong was how they composed.
 */
{
  const state: ArmState = { candidate: '', armAgainAt: 0 }
  let lastSeen = 0
  const recorded: string[] = []

  /** One decoded frame. */
  const read = (code: string, at: number) => {
    const action = armAction({ code, at }, state)
    if (action === 'cooling-down') return
    lastSeen = at
    if (action === 'still-there') return
    state.candidate = code
  }

  /** The operator tapping the button. */
  const capture = (at: number) => {
    if (!state.candidate) return
    recorded.push(state.candidate)
    state.candidate = ''
    state.armAgainAt = at + CAPTURE_COOLDOWN_MS
  }

  /** The sweeper's quarter-second tick. */
  const sweep = (now: number) => {
    if (isStale(state, lastSeen, now)) state.candidate = ''
  }

  /* Point at a barcode: the light comes on. */
  read('A', 0)
  eq(state.candidate, 'A', 'the light comes on')

  /* Hold it there. It stays on, and does not re-fire anything. */
  for (let at = 33; at <= 990; at += 33) read('A', at)
  sweep(990)
  eq(state.candidate, 'A', 'holding steady keeps the light on past the staleness window')

  /* Tap Add. The light goes out. */
  capture(1000)
  eq(state.candidate, '', 'capturing puts the light out')
  eq(recorded.length, 1, 'and records exactly one')

  /* The barcode is still in frame — but the light stays out through the cooldown. */
  for (let at = 1010; at < 1000 + CAPTURE_COOLDOWN_MS; at += 33) read('A', at)
  eq(state.candidate, '', 'and it stays out while the barcode sits in frame, which is the point')

  /* Once the cooldown lapses it comes back, and a second tap is a second item. */
  read('A', 1000 + CAPTURE_COOLDOWN_MS)
  eq(state.candidate, 'A', 'the light returns after the cooldown')
  capture(1600)
  eq(recorded.length, 2, 'a second deliberate tap is a second item')
  eq(recorded[0], recorded[1], 'both of the same barcode')

  /* Now look away. Nothing reads, and the light goes out on its own. */
  sweep(1600 + CANDIDATE_STALE_MS)
  eq(state.candidate, '', 'looking away puts the light out with no capture at all')

  /* Point at something else: straight to green, no button in between. */
  read('B', 3000)
  eq(state.candidate, 'B', 'the next item needs no button')
  capture(3100)
  eq(recorded[2], 'B', 'and records itself')
  eq(recorded.length, 3, 'three items from three taps')
}

console.log(`arming: all ${checks} checks passed`)
