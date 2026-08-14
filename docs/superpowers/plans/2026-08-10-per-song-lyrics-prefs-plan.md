# Per-song lyrics preferences — implementation plan

**Spec:** [`../specs/2026-08-10-per-song-lyrics-prefs-design.md`](../specs/2026-08-10-per-song-lyrics-prefs-design.md)
**Target version:** 1.4.3 → 1.5.0

Ordered so that everything testable lands first and nothing half-wired is ever
left in the tree. Each stage leaves the extension working. Stages 1 and 2 are
verifiable with `node test/run-tests.js`; from stage 3 on, verification moves to
the neko browser — edit on Windows, **Reload** on the extension card at
`chrome://extensions`, refresh the YouTube Music tab for content-script changes.

Each stage is one atomic commit's worth of work, should the project become a git
repo.

---

## Stage 1 — Key and record helpers

Pure functions only. No storage, no UI, no network.

**`src/common.js`**

- `PIN_MAX_RECORDS = 4`, `PIN_DURATION_TOLERANCE = 2`
- `pinToken(text)` — `romanizeIfNeeded(text, true)`, lowercase, strip
  `[^\p{L}\p{N}]+` with the `u` flag
- `pinKey(song)` — `pinToken(title) + '|' + pinToken(artist)`, taking the
  normalized song
- `pinRecordFor(records, duration)` — record within ±2s; given `''`, the sole
  record when there is exactly one, else `null`
- `pinRecordsWith(records, record)` — newest first, cap 4, replacing rather than
  duplicating a record at the same duration
- Add all five to the `YTML` export block at the bottom

**`test/run-tests.js`**

- two different Devanagari titles produce two different keys, neither `"|"`
- the same song keys identically with `romanizeQuery` on and off
- two uploads of one song — different raw titles, same cleaned title — converge
- tolerance: 278 matches 276, 278 misses 290
- empty duration: one record hits, three records return `null`
- `pinRecordsWith` evicts the oldest past four
- `pinRecordsWith` replaces, not duplicates, at an equal duration

**Done when** `node test/run-tests.js` passes and nothing else in the extension
has changed behaviour.

---

## Stage 2 — Offset arithmetic

The sign convention gets one definition rather than three call sites.

**`src/common.js`**

- `OFFSET_STEP = 0.25`, `OFFSET_STEP_LARGE = 1`, `OFFSET_LIMIT = 15`
- `shiftedPosition(at, off)` → `at - off` — where to look in the lyric
- `shiftedSeek(time, off)` → `time + off` — where to send the player
- `clampOffset(off)` — clamp to ±`OFFSET_LIMIT`, snap to a multiple of 0.25.
  The limit shipped at 15 and was raised to 60 during stage 5; see the spec for why
- `formatOffset(off)` — `0s`, `+0.25s`, `−1.5s`; signed, trailing zeros trimmed

**`test/run-tests.js`**

- `activeLineIndex(lines, shiftedPosition(at, off))` lands on the intended line
  when `at` sits exactly on a line boundary
- a negative offset pushing the lookup below t=0 returns the first line rather
  than throwing or going negative
- `clampOffset` snaps and clamps at both ends
- `formatOffset` across zero, positive, negative, whole and quarter values

**Done when** tests pass. Still nothing user-visible.

---

## Stage 3 — Worker storage and lookup

Invisible in the UI, but the feature works end to end from the console.

**`src/background.js`**

- `PIN_PREFIX = 'ytml.pin.'`
- `pinFor(normalized)` — point read, returns the selected record or `null`
- `pinSave(normalized, id, off)` — read, `pinRecordsWith`, write
- `pinRemove(normalized)` — read, drop the selected record, write; `remove()` the
  key when the array empties
- In `searchLyrics()`, after `resolveSong` and before the query ladder: on a pin
  hit, `GET /api/get/<id>`, run the single item through `rankLrclibResults`,
  cache it under the existing slot, and return `{ song, results, pin }`. Miss,
  404 and thrown fetch all fall through to the ladder unchanged
- Message handlers for `pin-song`, `unpin-song`, `fetch-alternates`

**Verify in neko**, from the side panel's devtools console — note
`DeveloperToolsAvailability: 2` in the neko policy blocks devtools there, so
either test this stage in desktop Chrome or temporarily set that policy to `1`:

1. `chrome.runtime.sendMessage({type:'pin-song', song, id, off})` for a song with
   a known-wrong default match
2. Replay the track; confirm the pinned entry comes back
3. Confirm the network panel shows one `/api/get/<id>` and no ladder

**Done when** a pin set by hand survives a replay and a service-worker restart.

---

## Stage 4 — Panel UI

**`src/sidepanel.html`** and **`src/lyrics.html`** — identical additions:

- `<button id="pinBtn" hidden>` in `.actions`
- an offset strip element between `<header>` and `#notice`, hidden by default,
  holding `offsetDown` / `offsetValue` / `offsetUp`

**`src/lyrics.css`** — the strip, plus `.pin--on` and `.pin--dirty` states.

**`src/lyrics.js`**

- hold `pin` and `offset` alongside the existing `song` / `songKey` state
- `renderEntry` seeds `offset` from the pin, or 0
- `paint()` drives the four-state Pin button and shows the strip only when
  `syncing()`
- `highlight()` uses `shiftedPosition`, the line click handler uses `shiftedSeek`
- offset buttons: `OFFSET_STEP`, `OFFSET_STEP_LARGE` on shift, re-`paint()`
- Pin click branches on state — save, remove, or overwrite
- picking a different alternate marks the state dirty
- add a `local` branch to the `chrome.storage.onChanged` listener so the two
  views stay in step
- `Show other matches` issues `fetch-alternates` and feeds `renderAlternates`

**Verify in neko**: play a track with visibly drifting lyrics, nudge the offset
until it tracks, press Pin, play something else, come back. Lyrics should land
already aligned with no interaction.

**Done when** that round trip works in both the side panel and a lyrics tab, and
a pin made in one updates the button in the other.

---

## Stage 5 — Failure paths

- 404 on the pinned id: fall through, show the notice with an **Unpin** action,
  leave the record in place
- storage write rejection: revert the button, flash `Couldn't save`
- test: an instrumental pinned entry yields no usable result and the ladder runs

**Verify** by pinning a real id, then editing the stored record to a nonexistent
id and replaying.

**Done when** a stale pin degrades to the normal ranked result with an
explanation rather than an empty panel.

---

## Stage 6 — Documentation and version

- `manifest.json`: `1.4.3` → `1.5.0`
- `README.md`: pinning in the usage table and a short section next to the
  synced-lyrics material; a line in **Notes / limitations** that pins are
  per-browser and do not sync
- `neko/README.md`: nothing needed — the mount is live, so a version bump is
  just a **Reload**

---

## Risks

| Risk | Handling |
| --- | --- |
| Offset feel is wrong at 0.25s steps | Cheap to change — one constant in stage 2. Judge it against real audio in stage 4 |
| Side-panel width below ~360px cramps the strip | The one open item in the spec. Settle it visually in stage 4 |
| Devtools are policy-disabled in neko | Stage 3 verification moves to desktop Chrome, or flip `DeveloperToolsAvailability` to `1` temporarily |
| `/api/get/<id>` shape changes | Already funnelled through `rankLrclibResults`, so it fails to the ladder rather than to a broken panel |
