# Per-song lyrics preferences — design

**Date:** 2026-08-10
**Status:** approved, not yet implemented

## Problem

Two things go wrong repeatedly once synced lyrics are on:

1. The ranker picks a match that is correct, but whose timing runs ahead of or
   behind the recording YouTube Music is playing.
2. The ranker picks the wrong entry entirely, and the right one is sitting in
   **Other matches** — but that choice is thrown away when the song ends.

Both are decisions the user has already made once. Nothing persists them, so
they get made again on every play.

## What this adds

A single **Pin** button in the lyrics panel. Pressing it saves, for the song
currently playing, which LRCLIB entry was on screen and what timing offset was
applied to it. Next time that recording plays, the saved entry is fetched
directly and the offset is applied without asking.

Plus a `− 0.0s +` offset control, live while a song plays, persisted only when
Pin is pressed.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Scope | Pin only. No favourites list, no separate "like" | Pin already expresses "this is the right lyric for this song". A favourites list is a second UI surface with no dependency on this work; it can be its own project later |
| Identity | Cleaned title + artist + runtime within ±2s | An offset is a property of a *recording*. Sharing one pin across the studio cut, a live version and a sped-up edit would apply a measured offset to a track it was never measured against |
| Portability | Local only | `chrome.storage.sync` caps at 102,400 bytes / 8,192 per item / 512 items / 1,800 writes per hour, and degrades to local-only in a profile that is not signed in — which the neko profile never is (`BrowserSignin: 0`, `SyncDisabled: true`). Export/import can be added later without changing the storage layout |
| Application | Short-circuit via `GET /api/get/<id>` | One ~3 KB request instead of a ladder of up to eleven, and it reaches entries the ranker would never surface — which is exactly the case a pin exists to fix |
| Lyric text | Never persisted | 2–4 KB per song would exhaust the 10 MB budget around 3,000 songs, but the real reason is that the extension currently keeps nothing on disk. Holding a reference costs 50 bytes and preserves that |

## Data model

`chrome.storage.local`, one key per song. Point reads, no read-modify-write race
between a side panel and a lyrics tab, no whole-table rewrite per save.

```
key:   "ytml.pin." + pinKey
value: [ { dur: 278, id: 3417291, off: -1.2, at: 1786... } ]
```

| Field | Meaning |
| --- | --- |
| `dur` | whole seconds, as reported by the player when the pin was saved |
| `id` | LRCLIB track id |
| `off` | offset in seconds, a multiple of 0.25, positive delays the words |
| `at` | write time, for eviction order |

The value is an array so one title/artist pair can hold several recordings.
Newest first, capped at **4**, oldest evicted. The cap bounds a pathological
case: a track whose runtime is reported slightly differently on every play would
otherwise accumulate a record per play.

Roughly 50 bytes per record, so `storage.local`'s 10,485,760-byte ceiling holds
well over 100,000 recordings. No `unlimitedStorage` permission needed.

### `pinKey`

New, and deliberately not `songKey`. `songKey` strips everything outside
`[a-z0-9]`, so a Devanagari title with `romanizeQuery` off collapses to `""` and
every such song collides on the key `"|"`. That is harmless in the existing
24-entry memory cache, which guards with `if (key !== '|')`, and actively wrong
in a persistent table.

```js
function pinToken(text) {
  return romanizeIfNeeded(String(text == null ? '' : text), true)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function pinKey(song) {
  return pinToken(song && song.title) + '|' + pinToken(song && song.artist);
}
```

`romanizeIfNeeded` already guards on `hasDevanagari`, so this is a no-op for
Latin text and no new transliterator accessor is needed. Romanizing
unconditionally — rather than following the `romanizeQuery` setting — means one
canonical key per song, so toggling that setting cannot orphan existing pins.

`pinKey` takes the **normalized** song, so `cleanTitle` and `cleanArtist` have
already run and two different uploads of one track converge on one key.

`songKey` is unchanged; the cache slot and the query builder both depend on its
current behaviour.

### Pure helpers (in `common.js`, all testable)

| Function | Returns |
| --- | --- |
| `pinKey(song)` | storage key suffix |
| `pinRecordFor(records, duration)` | the record within ±2s, or `null`. Given `''` for the duration, returns the sole record when there is exactly one and `null` otherwise |
| `pinRecordsWith(records, record)` | new array, newest first, capped at 4, replacing any record at the same duration |

Constants: `PIN_MAX_RECORDS = 4`, `PIN_DURATION_TOLERANCE = 2`,
`OFFSET_STEP = 0.25`, `OFFSET_STEP_LARGE = 1`, `OFFSET_LIMIT = 15`.

## Lookup

In `searchLyrics()` in `src/background.js`, after `resolveSong` has settled the
identity and before the query ladder:

```
pin = pinFor(normalized)                    storage.local point read
  │ hit
GET /api/get/<pin.id>                       one request, ~3 KB
  │ ok
rankLrclibResults([item], normalized)       extracts text + synced
  │
return { song, results, pin }
```

Any of miss, 404 or thrown fetch falls through to the existing ladder unchanged.
A pinned result is written to the worker cache under the same slot as any other,
so a side panel the browser destroys and rebuilds still returns instantly.

### Cache entries carry the pin that produced them

*Added during stage 3 — the original design was wrong here.*

The worker cache stored bare results. That breaks as soon as a pin falls
through: the ladder's answer gets filed under the slot, and the next lookup
finds both a cache hit and a live pin, attaches the offset to it, and applies
timings measured against a completely different entry.

Cache values are therefore `{ results, pinId }`, and the offset is returned on a
cache hit only when `pinId` matches the pin now in storage. `pinSave` and
`pinRemove` also clear the cache outright — it holds 24 entries and refilling
costs one request, which is not worth the bookkeeping to invalidate precisely.

A 404 sets `pinStale: true` on the reply and leaves `pin` null, so the panel can
explain itself without misapplying an offset. A pinned entry that still exists
but yields nothing usable — an instrumental — is *not* stale: it falls through
silently, because "no longer on LRCLIB" would be a lie.

Placing this **after** `resolveSong` is load-bearing. Pins are written and read
against the resolved identity; a song pinned under its upload title would
otherwise never be found again under its real one. The panel already receives
the normalized song back as `result.song` and echoes it on save, so the write
costs no extra iTunes call.

`rankLrclibResults` is safe on a single pinned item: `plainLyricsOf` derives
plain text from the timed lines when `plainLyrics` is empty, so a synced-only
entry is not dropped by the ranker's `entry.text` filter.

**Duration not yet known.** `durationParam` returns `''` until the player
reports a runtime, which arrives a beat after the title. If exactly one record
exists under the key, use it. If several exist, apply none — the panel already
re-searches when the duration arrives, so the pin lands on the second pass.

## Write

New worker messages, alongside the existing `fetch-lyrics` / `sync-watch` set:

| Message | Payload | Effect |
| --- | --- | --- |
| `pin-song` | `{ song, id, off }` | write or replace the record for this key and duration |
| `unpin-song` | `{ song }` | remove the record `pinRecordFor` selects for this duration; delete the storage key when its array empties |
| `fetch-alternates` | `{ song }` | run the full ladder and return its ranked results, ignoring any pin |

`song` is the normalized song the panel was handed by `fetch-lyrics`. The worker
owns every storage write so the side panel and a lyrics tab cannot disagree.

## Offset

Applied at comparison time, never baked into the parsed lines:

```js
YTML.activeLineIndex(lrcLines, at - off);   // highlight
seekTo(line.time + off);                    // clicking a line
```

Keeping `lrcLines` pristine makes nudging free — no reparse — and composes
correctly with an LRC file's own `[offset:]` tag, which `parseLrc` has already
applied by the time these run.

Positive delays the words. Step 0.25s, Shift for 1.0s, and holding either button
repeats at 1.0s after a short delay. The offset takes effect live; it reaches
storage only when Pin is pressed. An offset on an unpinned song is discarded at
the song change.

The clamp is ±60s. It was ±15s until testing found the assumption behind it
wrong: 15s assumes a large error means the file belongs to another recording,
but YouTube Music routinely carries uploads padded with a label bumper, a spoken
intro or applause before a live take. The words are right and the whole file is
late by the length of the padding. Past a minute it really is the wrong
recording, and the fix is a different match rather than a bigger number.

A minute at quarter-second steps is 240 presses, which is why the buttons
repeat — a hold covers the full range in about five seconds.

## UI

The header row already carries five buttons and the side panel is narrow, so
this splits across two places rather than making that row wrap.

**Header** gains one button, **Pin**, visible whenever lyrics are on screen —
including plain-text-only entries, where picking the right match out of
**Other matches** is still worth remembering.

| State | Label | Click |
| --- | --- | --- |
| No pin for this song | `Pin`, outline | save current entry and offset |
| Saved, unchanged since | `Pinned`, filled | remove the pin |
| Saved, offset moved or another match picked | `Update`, filled with a dot | overwrite with current values |
| No lyrics on screen | hidden | — |

**Offset** sits in a thin strip below the header, present only while synced
lyrics are on: `− 0s +`. The readout carries a sign and trims trailing zeros —
`0s`, `+0.25s`, `−1.5s`. It is meaningless without timed lines and should not
hold header space when there are none.

**Other matches** becomes a `Show other matches` link when a pin short-circuited
the search, since only one entry was fetched. The link issues
`fetch-alternates`. Unpinned songs behave exactly as they do today.

Files touched: `src/sidepanel.html`, `src/lyrics.html`, `src/lyrics.css`,
`src/lyrics.js`.

## Failure handling

**Pinned id returns 404.** Fall through to the ladder and say so in the existing
notice element — *"Saved match is no longer on LRCLIB — showing the best match
instead"* — with an **Unpin** action. The record is **not** deleted
automatically: a 404 can be transient infrastructure, deletion is
unrecoverable, and one extra 3 KB request per play does not justify that trade.
It also self-heals if the entry returns.

**Fetch throws.** Silent fall-through to the ladder, pin untouched, no notice —
the same posture as the existing per-query `catch (e) { continue; }`.

**Storage write fails.** The button reverts to its previous state and shows
`Couldn't save` briefly. No silent success.

**Both views open.** `src/lyrics.js` already listens on
`chrome.storage.onChanged` for the `sync` area; it gains a `local` branch so a
pin made in the side panel updates the tab's button and the reverse.

**Pinned entry is instrumental.** `plainLyricsOf` and `syncedLyricsOf` both
return empty, the ranker filters the entry out, results come back empty and the
ladder runs. Correct, but incidental rather than intended, so it gets a test.

## Tests

Added to `test/run-tests.js`, which covers what runs without a browser:

- `pinKey` keeps two different Devanagari titles distinct instead of collapsing
  both to `""`
- `pinKey` returns the same key whether `romanizeQuery` is on or off
- two uploads of one song — different raw titles, same cleaned title — produce
  one key
- duration tolerance: 278 against 276 hits, 278 against 290 misses
- no duration: a single record is used, several records match nothing
- `pinRecordsWith` evicts the oldest past four, and replaces rather than
  duplicates a record at the same duration
- offset arithmetic through `activeLineIndex`: exactly on a line boundary, and a
  negative offset pushing past t=0
- an instrumental pinned entry yields no usable result

Storage and network paths stay manual, matching where the README already draws
that line.

## Out of scope

- A favourites list, play counts, or any browsable song history
- Cross-device replication of pins, automatic or manual. The storage layout
  supports adding export/import later without migration
- Persisting lyric text
- Editing individual line timings. This is a single whole-track offset

## Open items

None. The one that was here — offset strip spacing below ~360px — was settled
in stage 4 and turned out to be aimed at the wrong element; see below.

## Settled during stage 4: the header, not the strip

Measured against the real stylesheets at 300/320/360/420/500px.

The offset strip was never in danger: one row at every width, 139px used of 296
available at 320px, no overflow at 300px.

The header was. Five action pills fit down to 300px; the sixth pushed the row to
wrap below 360px, which is a large part of the side panel's usable range. Fixed
in `sidepanel.css` by tightening `.actions` from a 6px gap and 9px horizontal
padding to 4px and 7px, which holds one row from 320px — Chrome's practical
minimum — without reducing the font size. Below that only long titles wrap, and
`.bar` already wraps by design.

## Size

Roughly 250 lines net across `common.js`, `background.js`, `lyrics.js`, the two
HTML files and `lyrics.css`, plus about 120 lines of tests.
