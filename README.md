# MyCodeScan

The phone companion to MyStockio. Walk the shop scanning barcodes; the list is waiting at
the billing counter.

**This folder is self-contained.** Its own `package.json` and `node_modules`, sharing
nothing with the app beside it. Cut or copy the folder anywhere and it still builds.

```
mycodescan/
  API-CONTRACT.md        the backend agreement — read-only on purpose
  SUBBARCODE-LOGIC.md    the sub-barcode format, for the MyStockio side
  server-reference/      a working backend, zero dependencies
  src/                   the phone app
```

---

## Accounts are MyStockio's

There are no MyCodeScan accounts, and this app no longer creates them — **it signs in only**.
Registration is the one action here that writes something permanent and shared: an account made
in MyCodeScan signs in to MyStockio too, on the same subscription, and a shop's staff standing at
a shelf with a phone are not the people who should be opening it. Accounts are made in MyStockio.

`register()` and `SignupInput` stay in `lib/api.ts` on purpose — they are part of the documented
client surface for those routes, and deleting them would put the client out of step with
`API-CONTRACT.md` over a decision about which screens this app happens to show.

Sign-in goes to `api/auth/login` — the endpoint MyStockio already uses — so **one account works
in both apps**, and tokens are kept under the same keys. Serve both from one origin and a single
sign-in covers them.

**Nothing is validated on the way out.** Whatever is typed is sent as-is, matching MyStockio's own
`validate()`, which runs no checks in login mode. An account there may be identified by a phone
number, a shop code or a name, so enforcing an email pattern here would lock people out of
accounts that work perfectly in MyStockio. The backend is the authority on whether a credential
is acceptable, and it says so through `VALIDATION_FAILED`.

Paths split by age: **auth is unversioned** because those endpoints already exist, while
**scans are versioned** at `api/v1/scans` because they are new and their shape may change
without every phone being updated.

If you already run a backend for MyStockio, only section 5 of `API-CONTRACT.md` is left to
build.

There is no guest or demo mode. A scan session belongs to a user and is read back by that
same user at the counter; an anonymous session could be listed and billed by a stranger
pointed at the same server. Note also that MyStockio's own client falls back to a
hard-coded `"demo-token"` when its backend is unreachable — neither app here copies that,
and the reference server refuses that exact string.

## How it fits together

1. **On the phone** — sign in, start a scan, point the camera at barcodes. Each scan
   session gets a short ID like `SC-7QK2M`.
2. **On the PC** — MyStockio → New Sale → **MyCodeScan**. Your sessions are listed. Pick
   one and every barcode is added to the bill.
3. **After the invoice is saved** — MyStockio deletes the session automatically.

Three moving parts: this app, a backend, and MyStockio. The backend is the only one you
still have to arrange.

---

## SubBarcode Printing

A second, separate errand on the same app: **printing** a label for a weighed or cut portion
of a product, rather than reading one. For the wire sold by the metre and the cashew sold by
the kilo — where there is one product in MyStockio but what crosses the counter is a 5 kg bag.

Scan the product's own barcode, type how much is in the bag, print. The label carries the
parent barcode with the quantity added to it:

```
200002222  +  5 kg      →  200002222S5
200002222  +  5.003 kg  →  200002222S5P003
```

**The parent barcode is copied verbatim.** Nothing is shortened, renumbered, hashed or looked
up — the code just gets longer. Cut at the last `S` and you have the product back, which means
a till that has never heard of this scheme still finds the right product with one string
operation, offline, with no table.

Scanning a label that already exists opens it for correction. Worth knowing what that can and
cannot do: the quantity lives *inside* the barcode, so an edit produces a *different* barcode
and the bag needs a new sticker. The app retires the old code and warns if it is ever scanned
again, rather than letting somebody believe they corrected a bag that is still in the crate
with the old number on it.

Nothing in this section touches the server. It needs no scan session, no network and no
backend — the label is self-describing, so there is nothing for a server to hold.

### Custom piece, inside a scan

The same suffix logic is available while scanning. Every line in a scan session has a **custom
piece** button: tap it, say how much is in one piece, and the line's barcode becomes a
sub-barcode — `200002222` becomes `200002222S12P75`. The till then reads the quantity out of the
code instead of somebody typing it in at the counter.

The line quantity keeps meaning **how many pieces**. Three 5 kg bags is `200002222S5` × 3, not
`200002222` × 15 — pieces on the line, size in the code. Conflating those two numbers is the
mistake the whole scheme exists to prevent, so they stay separate.

Editing a piece replaces its suffix rather than adding a second one, and the new line is added
to the session *before* the old one is removed: if a request fails halfway, the result is a
visible duplicate that can be deleted, not a scanned item that has silently vanished.

**`SUBBARCODE-LOGIC.md` is the format**, written for whoever implements the reading side in
MyStockio. It includes the one rule that matters — look the whole code up as a product *first*,
parse it as a sub-barcode only if nothing matches — and an EAN-13 fallback for tills whose
scanners cannot read Code 128.

```bash
npm run test:sub   # 4,451 assertions over the format and both symbologies
```

---

## Run it

```bash
npm install
npm run api      # the reference backend on :8787
npm run dev      # this app on :5175
npm run test:api # check the backend against API-CONTRACT.md
```

Sign in with an account that already exists in MyStockio — this app cannot create one. The
backend address is compiled in rather than typed; see `src/lib/config.ts`, where one `ENV`
constant chooses between the dev and prod bases.

In MyStockio, sign in from **New Sale → MyCodeScan** with the same account.

### Camera access needs HTTPS

Browsers block the camera on any origin that is not HTTPS or `localhost`. `npm run dev`
serves your LAN address over plain http, so **the camera will not open on a phone against
the dev server** — the app says so plainly rather than appearing broken. Either deploy it
(any static host gives you HTTPS) or, for development only, allow the origin in Chrome
under `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.

---

## Deploy it

```bash
npm run build     # -> dist/
```

Upload the contents of `dist/` to any static host — Netlify, Vercel, Cloudflare Pages,
GitHub Pages, S3, ordinary shared hosting. `vite.config.ts` sets `base: './'`, so the
build works from a domain root, a subfolder or a CDN path without rebuilding.

The API address is already baked in, and there is no way to change it at runtime: `src/lib/config.ts`
holds the two bases and one `ENV` constant that picks between them. Edit that line and rebuild.

That is deliberate rather than unfinished. A host typed into the phone but not into the counter —
or the other way round — produces two apps that each work perfectly and cannot see each other's
scans, and the symptom ("no scans waiting") gives no hint of the cause.

### The backend

`server-reference/` implements every endpoint in `API-CONTRACT.md` and passes the
contract test suite, but it is **not production software**: storage is a single JSON file
rewritten on every change, and there is no clustering, migration path or monitoring.

Two honest options:

- **Deploy it as-is for one shop.** Set `MYCODESCAN_SECRET` (otherwise tokens die on every
  restart), set `ALLOWED_ORIGINS`, put it behind HTTPS, and back up `data/`. For a single
  shop's barcode lists this is genuinely adequate.
- **Build a real one.** Hand `API-CONTRACT.md` to whoever — or whatever — is writing it. If
  the server matches the document, both front-ends work unchanged. Point them at
  `server-reference/contract.test.mjs` too: it is 60-odd assertions covering every rule in
  the document, and it will run against any implementation by changing the base URL.

```bash
MYCODESCAN_SECRET=$(openssl rand -hex 32) \
ALLOWED_ORIGINS=https://scan.yourshop.com,https://shop.yourshop.com \
PORT=8787 node server-reference/server.mjs
```

---

## Why the contract file is read-only

`API-CONTRACT.md` is marked read-only on disk deliberately. Two front-ends and a test
suite are written against it, so it is not documentation *of* an implementation — it is
the agreement all three obey.

Editing it to match a server that drifted would silently break the other two. Change it
on purpose, together with the clients, or not at all. To edit:

```powershell
attrib -R API-CONTRACT.md      # Windows
chmod +w API-CONTRACT.md       # macOS / Linux
```

---

## What this app does that is not obvious

**Every barcode saves itself as it is read, and the queue is what makes that safe.** A scan is
written to local storage before any request goes out, so a dead signal delays the upload rather
than losing the scan. The pending count tells the operator how far behind the network is, and
the backlog sends itself when the connection returns. A shop's back room is exactly where the
signal dies, and a scan lost to a failed request means walking the shelves again.

**A retry cannot double-count.** Each queued scan carries an idempotency key generated once, at
the moment the barcode was read. The commonest real failure is a request the server accepted
whose reply was lost — the phone believes it failed and retries — and without that key the
barcode would be counted twice, a bug that surfaces months later as unexplained shrinkage.

Both are covered by `npm run test:queue`, which takes scans with the network cut, reconnects,
and separately forces a lost-reply retry to prove the count stays at one.

**The scan ID is the biggest thing on the screen.** It has to cross a shop: somebody at
the counter picks it out of a list, and somebody in the store room may read it aloud. It
uses Crockford base32 with the vowels removed, so there are no ambiguous characters and no
accidental words.

**The camera arms; you record.** The viewfinder frame turns **green** when a barcode is held
and ready, **red** when nothing has been read, and the code is added only when you tap the button
beneath it. This is not caution for its own sake: a decoder reads a barcode *every frame it can
see one*, thirty times a second, so recording on each read turns one sweep past a shelf into a
dozen of the same item — silently, with nothing to notice but a quantity that no longer matches
the basket. A time-based guard cannot fix that, because no interval both stops runaway counting
and still lets somebody deliberately scan the same tin twice. Separating reading from recording
does.

**The button stays armed, and adding is the only thing it does.** Six identical tins is six taps,
camera still pointed at the shelf. Moving to the next item needs no button at all — aiming at a
different barcode swaps what the button will add. There is nothing to dismiss and nothing to
reopen, because leaving and re-entering the camera once per item is the slow version of the same
work.

The cost is real and worth knowing: point the camera at nothing and the last code is still armed,
so a stray tap adds another of it. That is why the button carries the code it will add rather than
the word "Capture" alone.

Typing a barcode by hand skips the confirmation, because typing it *is* the confirmation.

**Adding the same barcode twice counts two.** Six identical tins is one line of six, not six
lines.

**A scan nobody put anything into is deleted on the way out.** The session is created on the
server the moment "Start a new scan" is tapped, and it has to be — the operator taps it at the
counter and then walks into the back room where the signal dies, so deferring that request until
the first barcode would put it in exactly the dead spot the queue exists to survive. Instead, a
session that is still empty when it closes is removed, by whichever way it was closed: the
on-screen arrow and the phone's own back button both route through one handler. An empty scan
is also *discarded* rather than marked ready, and the button says "Discard" so it is not a lie —
a ready scan with nothing in it sits at the top of the list at the counter looking like work
that is waiting, and somebody picks it and gets nothing.

The emptiness check requires the scan to have **loaded successfully** first. Opening a real scan
on a flaky connection and backing out must never delete it, which is the bug worth being careful
about here — tidiness is not worth trading for a lost shelf sweep.

**The barcode generator is written out rather than installed.** It is the one thing in the app
that must be *exactly* right — a label that scans as the wrong number is worse than one that
does not scan at all — so the arithmetic is where it can be read and tested. `code128.ts`
carries its own decoder, used only by the tests, so a generated symbol is checked by reading
the bar widths back the way a scanner would rather than by trusting the encoder's own sums.
`assertTableSound()` catches a typo anywhere in the 107-symbol pattern table.

**Barcodes are drawn as SVG sized in millimetres, not pixels.** The one number that decides
whether a label scans is the width of the narrowest bar, and that is a physical measurement.
Sizing in CSS pixels would make it depend on the printer's idea of a pixel — which is exactly
the sort of thing that works on the machine it was tested on.

---

## Privacy

This backend holds barcode strings and quantities, nothing else. It has no product
catalogue, no prices, no customers and no invoices, and it never will — matching barcodes
to products happens inside MyStockio, on the shop's own machine, against the shop's own
workbook.

That boundary is the point. MyStockio's promise is that shop data stays with the shop; a
list of barcode numbers is not shop data in any meaningful sense, while a product list
with cost prices would be.

Sessions are working notes, not records. Delete them after 30 days — the reference server
already does.

---

Stack: React 18 · TypeScript · Vite · Tailwind 3 · @zxing/browser · Lucide.
