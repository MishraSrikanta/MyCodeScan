/**
 * Draws a barcode as SVG.
 *
 * ── Why SVG and not canvas ──────────────────────────────────────────────────
 * A barcode is a set of hard-edged rectangles whose *exact* widths are the data. Canvas
 * rasterises at screen resolution, so a label printed from a canvas is scanning a photograph
 * of a barcode at 96 dpi — bars land on half-pixels, adjacent bars merge, and the label reads
 * intermittently in a way that looks like a bad printer rather than a bad program. SVG hands
 * the printer the geometry and lets it rasterise at its own 300 or 600 dpi.
 *
 * ── Why the width is in millimetres ─────────────────────────────────────────
 * The one number that decides whether a label scans is the module width — the narrow bar, `X`
 * in the specifications. It is a *physical* measurement: below about 0.25 mm a thermal printer
 * cannot resolve the bars and a phone camera cannot either. Sizing this component in `px` or
 * percentages would make that number depend on the printer's idea of a CSS pixel, which is
 * exactly the sort of thing that works on the machine it was tested on. So the SVG is given a
 * width in millimetres and a viewBox in modules, and the browser does the arithmetic.
 *
 * ── Quiet zones are part of the barcode ─────────────────────────────────────
 * The white margin either side is not padding; a scanner uses it to find the symbol's edges,
 * and a label trimmed flush to the first bar does not read. Ten modules for Code 128, and the
 * asymmetric eleven/seven that EAN-13 requires — with the leading digit printed *inside* the
 * left quiet zone, which is where it is supposed to go and why the zone is wider on that side.
 */

import { useMemo } from 'react'
import { encodeCode128 } from '../lib/code128'
import { encodeEan13 } from '../lib/ean13'
import type { SubFormat } from '../lib/subbarcode'

/** Narrow-bar widths, in millimetres. */
export const MODULE_WIDTHS = {
  /** As small as a 203 dpi thermal printer can hold and a phone can still read. */
  small: 0.3,
  /** The comfortable default. */
  medium: 0.38,
  /** For a coil label read across a store room, or a printer with a worn head. */
  large: 0.5,
} as const

export type BarcodeSize = keyof typeof MODULE_WIDTHS

interface Bar {
  /** Left edge, in modules. */
  at: number
  width: number
  /** True for a guard bar, which is drawn longer. */
  guard: boolean
}

/** Turns a bit string into merged runs of bars, which is far fewer rects than one per module. */
function barsFromBits(bits: string, guardModules: [number, number][]): Bar[] {
  const isGuard = new Set<number>()
  for (const [start, length] of guardModules) {
    for (let offset = 0; offset < length; offset += 1) isGuard.add(start + offset)
  }

  const bars: Bar[] = []
  let at = 0
  while (at < bits.length) {
    if (bits[at] !== '1') {
      at += 1
      continue
    }
    let width = 0
    while (at + width < bits.length && bits[at + width] === '1') width += 1
    bars.push({ at, width, guard: isGuard.has(at) })
    at += width
  }
  return bars
}

/** Code 128 gives alternating widths starting with a bar; expand them to bit positions. */
function barsFromWidths(widths: number[]): Bar[] {
  const bars: Bar[] = []
  let at = 0
  widths.forEach((width, index) => {
    if (index % 2 === 0) bars.push({ at, width, guard: false })
    at += width
  })
  return bars
}

interface Drawn {
  bars: Bar[]
  /** Symbol width in modules, quiet zones excluded. */
  modules: number
  quietLeft: number
  quietRight: number
  /** What to print beneath, already grouped the way the symbology expects. */
  caption: string[]
  /** How much taller guard bars are drawn, in modules. Zero when there are none. */
  guardDrop: number
  error: string
}

function draw(value: string, format: SubFormat): Drawn {
  const empty: Drawn = {
    bars: [],
    modules: 1,
    quietLeft: 0,
    quietRight: 0,
    caption: [],
    guardDrop: 0,
    error: '',
  }

  try {
    if (format === 'ean13') {
      const symbol = encodeEan13(value)
      return {
        bars: barsFromBits(symbol.bits, symbol.guardModules),
        modules: symbol.bits.length,
        /* The specification's asymmetric zones. The leading digit lives in the left one. */
        quietLeft: 11,
        quietRight: 7,
        /* Printed as the specification groups it: leading digit, then two blocks of six. */
        caption: [symbol.digits.slice(0, 1), symbol.digits.slice(1, 7), symbol.digits.slice(7)],
        guardDrop: 5,
        error: '',
      }
    }

    const symbol = encodeCode128(value)
    return {
      bars: barsFromWidths(symbol.widths),
      modules: symbol.modules,
      quietLeft: 10,
      quietRight: 10,
      caption: [value],
      guardDrop: 0,
      error: '',
    }
  } catch (caught) {
    return { ...empty, error: (caught as Error).message }
  }
}

export function Barcode({
  value,
  format = 'code128',
  size = 'medium',
  /** Bar height in millimetres. 10 mm is the shortest a hand scanner reads reliably. */
  heightMm = 14,
  showText = true,
  className = '',
}: {
  value: string
  format?: SubFormat
  size?: BarcodeSize
  heightMm?: number
  showText?: boolean
  className?: string
}) {
  const drawn = useMemo(() => draw(value, format), [value, format])
  const module = MODULE_WIDTHS[size]

  if (drawn.error) {
    return (
      <p className={`text-[11px] leading-snug text-rose-500 ${className}`} role="alert">
        {drawn.error}
      </p>
    )
  }

  /* Everything below is in modules; the SVG's own width in millimetres scales it. */
  const barHeight = heightMm / module
  /* A 3 mm band under the bars, so the caption is legible on a stamp-sized label without
     stealing height from the symbol. Converted to modules, like everything else here. */
  const captionHeight = showText ? 3 / module : 0
  const totalModules = drawn.quietLeft + drawn.modules + drawn.quietRight
  const totalHeight = barHeight + drawn.guardDrop + captionHeight
  const widthMm = totalModules * module

  /* EAN-13's leading digit sits in the left quiet zone; the other two blocks sit under their
     halves of the symbol, between the guards. */
  const captionY = barHeight + drawn.guardDrop + captionHeight * 0.82
  const captionSize = captionHeight * 0.72

  return (
    <svg
      className={className}
      width={`${widthMm}mm`}
      height={`${totalHeight * module}mm`}
      viewBox={`0 0 ${totalModules} ${totalHeight}`}
      preserveAspectRatio="xMidYMid meet"
      /* Rectangles snapped to whole device pixels: the difference between a label that scans
         first time and one that scans on the third try. */
      shapeRendering="crispEdges"
      role="img"
      aria-label={`Barcode ${value}`}
    >
      {/* The quiet zones have to be white, not transparent, or a tinted card behind the
          label eats the margin the scanner needs. */}
      <rect x="0" y="0" width={totalModules} height={totalHeight} fill="#fff" />

      {drawn.bars.map((bar) => (
        <rect
          key={bar.at}
          x={drawn.quietLeft + bar.at}
          y="0"
          width={bar.width}
          height={barHeight + (bar.guard ? drawn.guardDrop : 0)}
          fill="#000"
        />
      ))}

      {showText &&
        (format === 'ean13' ? (
          <g fill="#000" fontSize={captionSize} fontFamily="monospace" letterSpacing={captionSize * 0.12}>
            {/* Leading digit, in the left quiet zone. */}
            <text x={drawn.quietLeft - 2} y={captionY} textAnchor="end">
              {drawn.caption[0]}
            </text>
            {/* The two blocks of six, centred on their halves of the symbol. The left block
                occupies modules 3–44 of the symbol and the right 50–91, so those are the
                midpoints — not the midpoints of each half of the whole symbol, which would
                push both blocks into the guards. */}
            <text x={drawn.quietLeft + 23.5} y={captionY} textAnchor="middle">
              {drawn.caption[1]}
            </text>
            <text x={drawn.quietLeft + 70.5} y={captionY} textAnchor="middle">
              {drawn.caption[2]}
            </text>
          </g>
        ) : (
          <text
            x={totalModules / 2}
            y={captionY}
            textAnchor="middle"
            fill="#000"
            fontSize={captionSize}
            fontFamily="monospace"
            letterSpacing={captionSize * 0.14}
          >
            {drawn.caption[0]}
          </text>
        ))}
    </svg>
  )
}
