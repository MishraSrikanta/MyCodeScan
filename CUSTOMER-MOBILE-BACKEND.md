# Customer mobile: what the backend needs

**The phone side is done and shipping.** It asks for the number when Done is pressed and sends it
on the finishing `PATCH`. Until the backend below is in place the number is simply not kept, and
nothing else breaks — see *Until then* at the bottom.

This is a delta against `API-CONTRACT.md` §5. That file is read-only on purpose, so it has not been
edited: apply this, then update the contract and its test suite in the same change.

---

## Why not put it in the scan ID

You asked for the number *in the scan ID*. It cannot go there, and the reason is worth having in
writing because it is not obvious.

**The number is not known when the ID is generated.** The ID is created by `POST api/v1/scans`, the
moment "Start a new scan" is tapped, before a single barcode is read. The customer is identified at
the *end* of the job — often the customer is not even at the counter yet when picking starts. So an
ID containing the mobile would have to be **renamed** later.

**Renaming the ID loses scans.** The scan ID is the primary key and it is in the URL of every other
request. The phone's offline queue holds unsent barcodes keyed by that ID, and `flush()` drops any
entry whose scan returns `404` — that rule exists so a deleted scan cannot block the queue forever.
Rename the scan mid-session and every queued barcode 404s and is discarded. On the connection where
that matters most, the back room, this is a silent, unrecoverable loss of the exact work the queue
exists to protect.

So: a separate field, and the scan ID never changes. The number is stored *alongside* the ID and
displayed next to it, which gives you the filtering you want without touching the key.

---

## 1. The schema

Two lines on `scanSchema`, alongside `label`:

```js
    label: { type: String, default: "", maxlength: 80 },
    /*
     * The customer this basket is for, digits only, 6-15.
     *
     * Set at the end of a scan rather than the start: the phone asks for it when Done is pressed,
     * because that is when the customer is actually known. Empty means nobody is attached, which
     * is the common case.
     *
     * Digits only is enforced in the route, not here — a setter that silently rewrites input makes
     * a validation failure look like a successful save of something else.
     */
    customerMobile: { type: String, default: "", maxlength: 15 },
```

And an index, only if you add the server-side filter in step 4:

```js
/* Finding one customer's baskets, scoped to one owner. */
scanSchema.index({ ownerId: 1, customerMobile: 1 });
```

**Store digits only.** The client already strips `+`, spaces, hyphens and brackets before sending,
but normalise server-side too — anything else can write to this API, and `+91 98765 43210` stored
next to `919876543210` is one customer that filters as two.

```js
const normaliseMobile = (raw) => String(raw ?? "").replace(/\D/g, "");
```

### Two things your schema already gets right

**`scanId` is `unique: true` and the primary handle.** That is exactly why the number cannot live
inside it — see the section above.

**The TTL index carries this for free.** `expireAfterSeconds` on `updatedAt` already drops sessions
30 days after the last write, so a phone number cannot outlive the basket it belongs to. That index
was tidiness for barcode numbers; from this change on it is your retention policy, so confirm it is
actually built in production — a TTL index that was never created fails silently and forever.

---

## 2. `PATCH api/v1/scans/{scanId}` — accept the field

Currently updates `label` and/or `status`. Add a third optional field.

```json
{ "status": "ready", "label": "Shelf 3", "customerMobile": "9876543210" }
```

- Optional, like the others. Only supplied fields change.
- Normalise to digits, then validate: **6–15 digits**, or empty.
- Empty string **clears** it. That is the only way to remove a number once set, and somebody will
  need to — a number gets typed against the wrong basket eventually.
- Reject anything else with the existing shape:
  `400 VALIDATION_FAILED`, `details: { customerMobile: "6-15 digits" }`.

```js
if (body.customerMobile !== undefined) {
  const digits = normaliseMobile(body.customerMobile);
  if (digits && (digits.length < 6 || digits.length > 15)) {
    return sendError(res, 400, "VALIDATION_FAILED", "customerMobile must be 6-15 digits.", origin, {
      customerMobile: "6-15 digits",
    });
  }
  scan.customerMobile = digits;
}
```

Saving bumps `updatedAt`, which restarts the 30-day TTL and floats the scan to the top of the
picker. Both are what you want: attaching a customer is real activity on that basket.

> Six is low enough for a short local number; fifteen is E.164's ceiling, so a country code fits.
> If you widen these, widen `maxLength={15}` on the input in `ScanView.tsx` to match.

Accepting it on `POST api/v1/scans` as well is harmless but pointless — the client has nothing to
send at creation time, which is the whole reason it is asked at Done.

---

## 3. Return it

Add `customerMobile` to whatever builds the scan JSON — the equivalent of `serialiseScan` — so it
appears in **both** `GET api/v1/scans` (the summary list) and `GET api/v1/scans/{scanId}`.

```js
customerMobile: scan.customerMobile || "",
```

**This is the step most likely to be missed.** The scan JSON is a hand-built projection, not
`toJSON()`, so adding the field to the schema does nothing on its own — without the serialiser line
the number is stored perfectly and never comes back, which looks exactly like a save that failed.

The list endpoint is the one that matters most: it is what the biller is looking at when they need
to find a basket, and a field present only on the detail endpoint would mean fetching every scan to
filter.

Omit the key, or send `""` — the client treats both as "no customer".

---

## 4. Filtering (optional, recommended)

`GET api/v1/scans?customerMobile=9876543210`

Match on a **substring** of the digits, not equality. Somebody standing at a till with a queue types
the last four, not thirteen.

With Mongo, and scoped to the owner so the index above is used:

```js
const wanted = normaliseMobile(req.query.customerMobile);
const query = { ownerId };
if (wanted) query.customerMobile = { $regex: wanted };
```

No `$options` — the value is digits, so there is no case to be insensitive about.

One caveat on the index: an unanchored `$regex` cannot use it, so that lookup is a scan of the
owner's sessions. Anchoring it — `{ $regex: "^" + wanted }` — makes it a prefix match the index can
serve, at the cost of the biller typing the number from the front rather than the last four. With
one shop's 30 days of sessions behind an `ownerId` filter, neither will be measurable; take the
unanchored one unless you are holding far more than that.

Combines with the existing `?status=` filter. Skip this if you would rather filter client-side —
MyStockio already has the whole list in hand.

---

## 5. Privacy — read this before shipping

This is the first personal data this backend has ever held. Until now the honest claim in
`README.md` was *"barcode strings and quantities, nothing else"*, and that claim stops being true
the moment this ships.

Concretely:

- **Update the Privacy section of `README.md`.** A promise that quietly stops holding is worse than
  one never made.
- **The 30-day pruning now matters more.** It was tidiness for barcode numbers; it is retention
  policy for phone numbers. Make sure it actually runs in production.
- **It is on the isolation boundary.** Scans are already per-account; make sure the new field cannot
  leak through any endpoint that is not — the same rule the contract's `isolation` tests cover.
- Depending on where the shop operates, a customer phone number attached to a purchase may be
  regulated. Worth ten minutes of somebody's attention before it is in a database.

---

## 6. Keep the contract honest

`API-CONTRACT.md` is read-only because two front-ends and a test suite are written against it. When
this lands, in the same change:

- add `customerMobile` to the scan object table in §5;
- document the `PATCH` field and its validation;
- add cases to `server-reference/contract.test.mjs` — set, clear, reject 5 digits, reject 16, and
  confirm it survives a round trip through the list endpoint;
- implement it in `server-reference/server.mjs` so the reference stays a working reference.

To edit the contract: `attrib -R API-CONTRACT.md` on Windows, `chmod +w` elsewhere.

---

## Until then

Nothing is blocked. The client sends `customerMobile` on the finishing `PATCH` and handles both
kinds of backend:

- **Ignores unknown fields** (the reference server, and most Express handlers) — the scan is marked
  ready, the number is dropped, and the day this ships it starts being kept with no client change.
- **Strict validator, answers `400`** — the client retries once *without* the field, so the scan
  still finishes, and then tells the operator plainly: *"SC-7QK2M is saved and ready, but this
  backend does not store a customer mobile number yet."*

That second path is why Done cannot break while you are working on this. It is in
`updateScan()` in `src/lib/api.ts`; delete it once the field is live, and the retry stops being
reachable.
