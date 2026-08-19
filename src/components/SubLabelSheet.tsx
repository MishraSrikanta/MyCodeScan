/**
 * The printable sheet.
 *
 * ── Why this is a screen and not a hidden print stylesheet ──────────────────
 * The usual trick is to leave the labels in the page, hidden, and reveal them in `@media
 * print`. It is less code and it is worse: nobody can see what is about to come out of the
 * printer, and the first thing anybody does with a label is hold it against a bag to check the
 * size. So the sheet is a real screen, on white, at the size it will print — and the print
 * stylesheet only has to hide the buttons around it.
 *
 * ── What goes on a label, and in what order ─────────────────────────────────
 * The quantity is the largest thing on it. A person picking a bag out of a crate is looking for
 * "5 kg", not for a barcode — the barcode is for the till. Below that the parent code, because
 * that is what somebody checks against a shelf, and only then the symbol. The full sub-code is
 * printed under the bars so that a label whose barcode has been scuffed can still be typed in
 * by hand, which is the failure this app cannot otherwise recover from.
 *
 * ── Copies ──────────────────────────────────────────────────────────────────
 * A shop weighing out twenty bags of the same thing wants twenty identical labels, so copies is
 * the first control and it defaults to one. Each label is `break-inside: avoid`, so a sheet that
 * runs past the bottom of the page splits between labels rather than through one.
 */

import { Loader2, Printer, X } from 'lucide-react'
import { useState } from 'react'
import { formatQty } from '../lib/subbarcode'
import type { SubLabel } from '../lib/sublabels'
import { Barcode, type BarcodeSize } from './Barcode'

const SIZES: { value: BarcodeSize; label: string; note: string }[] = [
  { value: 'small', label: 'Small', note: 'Tight labels. Needs a good printer.' },
  { value: 'medium', label: 'Medium', note: 'The safe default.' },
  { value: 'large', label: 'Large', note: 'Coils, crates, poor light.' },
]

export function SubLabelSheet({
  label,
  onClose,
  onPrinted,
}: {
  label: SubLabel
  onClose: () => void
  onPrinted: (copies: number) => void
}) {
  const [copies, setCopies] = useState(1)
  const [size, setSize] = useState<BarcodeSize>('medium')
  const [printing, setPrinting] = useState(false)

  const print = () => {
    setPrinting(true)
    onPrinted(copies)
    /*
     * `window.print()` blocks this thread until the dialog closes, so the count above has to be
     * recorded first or a cancelled dialog and a completed print look identical from here.
     * Counting an abandoned print is the lesser wrong: the number is there to show which labels
     * are in use, not to bill anybody.
     */
    window.print()
    setPrinting(false)
  }

  const dated = new Date(label.updatedAt).toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  })

  return (
    /* White, and not the app's dark theme: this is a preview of paper. */
    <div className="min-h-full bg-white text-slate-900">
      <header className="no-print sticky top-0 z-10 flex items-center gap-2 border-b border-slate-200 bg-white px-3 pb-2 pt-[max(0.6rem,env(safe-area-inset-top))]">
        <button
          onClick={onClose}
          aria-label="Close the print sheet"
          className="btn grid h-11 w-11 place-items-center rounded-xl bg-slate-100 px-0 text-slate-700 hover:bg-slate-200"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[15px] font-bold">{label.code}</p>
          <p className="truncate text-[11.5px] text-slate-500">
            {formatQty(label.qty)} {label.unit} of {label.parent}
          </p>
        </div>
        <button onClick={print} disabled={printing} className="btn-primary shrink-0 px-3 text-sm">
          {printing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
          Print
        </button>
      </header>

      <div className="no-print space-y-3 border-b border-slate-200 px-4 py-3">
        <label className="block">
          <span className="text-[12px] font-bold uppercase tracking-wider text-slate-500">Copies</span>
          <input
            type="number"
            min={1}
            max={100}
            value={copies}
            onChange={(event) => {
              const next = Number(event.target.value)
              setCopies(Number.isFinite(next) ? Math.min(100, Math.max(1, Math.round(next))) : 1)
            }}
            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-slate-900 focus:border-brand-500 focus:outline-none"
          />
        </label>

        <div>
          <span className="text-[12px] font-bold uppercase tracking-wider text-slate-500">Bar width</span>
          <div className="mt-1 flex gap-2">
            {SIZES.map((option) => (
              <button
                key={option.value}
                onClick={() => setSize(option.value)}
                className={`btn flex-1 flex-col gap-0 px-2 text-[13px] leading-tight ${
                  size === option.value
                    ? 'bg-brand-500 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-slate-500">
            {SIZES.find((option) => option.value === size)?.note} Narrower bars fit more on a label; too
            narrow and the printer cannot resolve them.
          </p>
        </div>

        <p className="text-[11.5px] leading-relaxed text-slate-500">
          Print at <strong>100%</strong> — any "fit to page" or "shrink to fit" scales the bars and the
          label stops scanning. Turn headers and footers off.
        </p>
      </div>

      {/* --------------------------------------------------------- the sheet */}
      <div className="print-sheet flex flex-wrap gap-3 p-4">
        {Array.from({ length: copies }, (_, index) => (
          <article
            key={index}
            className="print-label flex flex-col items-center gap-1 rounded-lg border border-slate-300 px-3 py-2"
          >
            <p className="self-stretch text-center text-[19px] font-black leading-none">
              {formatQty(label.qty)}
              {label.unit ? <span className="text-[13px] font-bold"> {label.unit}</span> : null}
            </p>
            <p className="self-stretch text-center font-mono text-[11px] leading-none text-slate-700">
              {label.parent}
            </p>
            <Barcode value={label.code} format={label.format} size={size} heightMm={13} />
            {(label.note || label.itemRef) && (
              <p className="self-stretch text-center text-[9px] leading-tight text-slate-500">
                {label.note}
                {label.note && label.itemRef ? ' · ' : ''}
                {label.itemRef ? `ref ${label.itemRef}` : ''}
              </p>
            )}
            <p className="self-stretch text-center text-[8px] leading-none text-slate-400">{dated}</p>
          </article>
        ))}
      </div>
    </div>
  )
}
