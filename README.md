# YT Music Lyrics Router

A Chromium extension for the three things that go wrong with lyrics on YouTube Music:

1. **Most songs have no lyrics tab at all** — press <kbd>Alt</kbd>+<kbd>L</kbd> and the lyrics appear in the browser's side panel, next to the player, and follow the song as it changes.
2. **The ones that do are in Devanagari** — the extension romanizes the lyrics panel in place (<kbd>Alt</kbd>+<kbd>R</kbd>), so `तेरे बिना ज़िंदगी` becomes `tere bina zindagi`.
3. **The timed ones drift, or are the wrong take entirely** — nudge the timing until it fits, pick the right match if the ranker missed it, and **Pin** it. That song opens correct from then on.

It reads the song straight off the player bar, so it works with ad blockers and never touches the YouTube API.

## Install

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this folder.
4. Open <https://music.youtube.com>, play something, and hit <kbd>Alt</kbd>+<kbd>L</kbd>.

No build step, no dependencies. The side panel needs Chrome 114 or newer; on anything
older the extension opens its lyrics tab instead and everything else works the same.

## How to use it

| Action | What happens |
| --- | --- |
| <kbd>Alt</kbd>+<kbd>L</kbd> | Opens lyrics for the current song with your default provider — the side panel out of the box |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> | Same, but with the fallback provider |
| <kbd>Alt</kbd>+<kbd>R</kbd> | Romanize / restore the YouTube Music lyrics panel |
| Click a line in the panel | Jumps the player to it, when the track has timed lyrics |
| **Lyrics** button in the player bar | Same as Alt+L (Shift+click = fallback provider) |
| **अ→a** button in the player bar | Same as Alt+R |
| **Timing** −/+ in the panel | Moves the timed lines a quarter-second; Shift a second; hold to run |
| **Pin** in the panel | Remembers this match and its timing for this song, and uses them next time |
| Toolbar icon | Shows the detected song and every provider as a one-click list |
| Right-click on the page | Same options in the context menu |
| Right-click on selected text anywhere | "Find English lyrics for …" (always opens the lyrics tab, since the side panel only ever shows what is playing) |

Rebind the shortcuts at `chrome://extensions/shortcuts`.

## Providers

The default is the **side panel**: it sits beside YouTube Music, queries
[LRCLIB](https://lrclib.net) (free, no API key, no account) and re-searches on its own
every time the track changes. Hindi tracks on LRCLIB are usually already stored in
Hinglish; when they are not, the romanize button converts them, and that choice sticks
across songs. Where LRCLIB has the track timed, the panel follows the song line by line —
see *[Following the song](#following-the-song)*.

**Lyrics tab** is the same page in a normal tab, pinned to one song. It is what you get
on browsers without a side panel, from the selected-text menu, and from the panel's own
**Open in a tab** link.

### Working out which song it is

A song reaches YouTube Music as an original, a lyrical video, a remix and any number of
re-uploads, each titled by whoever uploaded it:

```
Odhani Odh Ke Nachu Lyrical Video Song | Tere Naam | Udit N |Alka Y | Sameer |Salman Khan
```

Cleanup gets that down to `Odhani Odh Ke Nachu` and pulls out `Tere Naam` as the film, but
no amount of it collapses five uploads to one identity. So when the metadata looks like an
upload — a credit roll in the title, a label where the artist should be, or a title that
lost most of itself to cleanup — the worker asks Apple's search API what the song is and
**checks the answer against the runtime it already read off the player**. The original and
the lyrical video share a runtime; the remix does not. That is the whole trick, and it is
the only signal in the match that can prove a candidate wrong rather than merely unlikely.

A match has to carry at least half the title *and* clear a score; with no runtime to
corroborate it, the bar rises to everything-else-perfect rather than the check being
waived. A wrong answer here is worse than none — it swaps a messy title for a confidently
wrong one — so failing to resolve simply falls back to the cleaned-up guess.

This is **off by default** and sits behind an optional permission: until you turn it on in
Settings the extension contacts nothing but YouTube Music and LRCLIB. Nothing but metadata
comes from Apple; no lyrics, and a catalogue entry that already knows its own title and
artist is never looked up at all.

### When LRCLIB has nothing

LRCLIB is community-maintained and its Hindi catalogue thins out fast the further back you
go. **LyricsMint** fills in part of that, in Hinglish, and files songs at a predictable
address:

```
https://lyricsmint.com/<film-or-artist-slug>/<song-slug>
```

which means no search page is scraped and no site is crawled — the slug is derivable from
the film and song already identified, so a lookup is one request to one guessable URL.
A wrong guess is a 404 rather than a wrong song.

Two guards, because a wrong page would be worse than no lyrics:

- The song title is slugged **as read** first, then again with a trailing `Song` / `Lyrics`
  / `Video` trimmed off. `Odhani Song` is the song called *Odhani*; `Swan Song` is not, and
  `cleanTitle` has to keep both, so the trimming happens only where a bad guess costs a 404.
- The fetched page's own `<title>` has to agree with the song, scored against **every**
  title variant. Verifying a page found by the trimmed slug against the untrimmed title
  would throw the right answer away for missing a word it never claimed to have.

It runs only after every LRCLIB rung has come back empty, and it is **off by default**
behind an optional permission. Parsing is string work rather than DOM work on purpose: an
MV3 service worker has no `DOMParser`, so a parser built on one could not run where the
fetch happens.

Coverage is real but partial — roughly 17,000 songs, skewed modern. Older soundtracks are
thin there too, and no fallback provider conjures lyrics that were never published.

### How a track is looked up

Most of the time a song that "is not on LRCLIB" is really a song one query failed to
find, so the worker walks a ladder of them, narrowest first, and stops at the first one
that returns lyrics:

| Attempt | Why it is there |
| --- | --- |
| `/api/get` with title, artist, album and **duration** | An exact lookup. LRCLIB only answers when the length matches within a couple of seconds, so a hit is the recording that is playing — not a cover, a remix or a sped-up edit |
| `/api/get` without the album | The album is the field most likely to be wrong |
| Structured search on title + artist + album | For a film song the album is usually the movie, which is how LRCLIB files most Bollywood tracks |
| Structured search on title + artist | |
| The same two in the **other script** | LRCLIB stores Hindi tracks in Devanagari or in Hinglish with no pattern to it, so both spellings get a turn |
| Free text, both scripts | LRCLIB's own fuzzy matching |
| Free text with the **film name** in place of the artist | YouTube Music often credits a label or the composer where LRCLIB filed the singer; the movie is the one term they agree on |
| Title alone | Widest net, most likely to be the wrong recording — which is then the ranker's problem |

Duration comes from the `<video>` element and the player's JS API, and also feeds the
ranking, so a search that returns six versions of a song prefers the one that runs to the
right length. A track with nothing to romanize and no film name skips most of the ladder;
a fully-populated Hindi track can cost up to eleven requests before giving up, all of
them cached afterwards, misses included.

### Following the song

LRCLIB stores a timed version of a good part of its catalogue — the same words with a
timestamp in front of each line — and the panel uses it when it is there. The line that is
singing is lit, the panel scrolls to keep it in view, and clicking any line jumps the
player to it. Nothing changes for a track that has no timings: it is the same block of
text it always was. The **Sync** button turns the highlight off for one song without
touching the setting, and the *Other matches* list marks the timed ones with `◍`, because
the best-scoring match is not always the one that is timed.

### Pinning a match

Two things go wrong once often enough to be worth remembering the answer to: the ranker
picks the wrong entry when the right one is sitting in *Other matches*, and it picks the
right entry whose timings run ahead of or behind this particular upload. Both are
decisions you only want to make once.

The **Timing** strip appears under the header whenever timed lines are on screen.
`−` and `+` move the words a quarter-second, Shift moves them a second, holding either
runs it, and pressing the value resets to zero. Positive delays the words. The range is a
minute either way, which is not for mistimed lyrics — it is for uploads padded with a
label bumper, a spoken intro or applause before a live take, where the words are right and
the whole file is simply late.

Because a line lasts several seconds, which line is lit cannot show a quarter-second
change. Two things do: the lit line carries a fill that crosses it as the song plays, and
the strip counts down to when the next line is due. Both move on every press. Tune until
the countdown passes zero as the voice starts the line.

**Pin** then saves it — which entry, and how far its timings moved. Play the song again
and the worker fetches that entry directly by id, one request instead of a ladder of up to
eleven, with the offset already applied. The button reads `Pinned` when the screen matches
what was saved, `Update` when you have moved the offset or chosen a different match, and
pressing it while it reads `Pinned` forgets the pin.

A pin is filed under the cleaned title, the artist, and the runtime to within two seconds.
The runtime is what keeps a live version, a remix or a sped-up edit from inheriting a
correction measured against the studio cut — those are different recordings and want their
own. One song can hold up to four, one per runtime.

Only an LRCLIB entry can be pinned, so the button hides itself for a LyricsMint result:
a pin is an id to re-fetch and those pages have none. They are found by guessing a URL from
the song anyway, so they will be found again.

If a pinned entry later disappears from LRCLIB, the panel says so and falls back to the
best match rather than drifting silently. The saved record survives that — LRCLIB restoring
an entry is likelier than you wanting your choice thrown away — until you press **Forget
it** in the notice.

The panel is handed a **clock rather than a stream**. Every message from the page wakes the
service worker, and `timeupdate` fires four times a second, so sending each one would spend
a wake-up on a number the panel can work out for itself. Instead the content script sends
one sample a second while the track plays — plus one the instant something happens that a
clock cannot predict, which is a play, a pause, a seek or a speed change — and the panel
interpolates between them off its own clock. A seek is answered immediately, so the only
error a listener can see is drift over at most a second, which is well under a line.

Two things stop it running when nobody is watching. The panel holds a **lease** that expires
on its own after twelve seconds, renewed every five while the highlight is on: a panel the
browser destroys without warning cannot leave the page publishing to nobody, and a track
with no timings never asks for one. And a position that nothing has confirmed for fifteen
seconds is treated as unknown rather than extrapolated forever — the tab has gone, or the
panel was asleep — so the highlight stops instead of wandering off. A *paused* position
never expires, because it is still true however long ago it arrived.

Scrolling yourself hands control back for six seconds. The events that count as scrolling
are the ones a person makes — a wheel, a drag of the scrollbar, the arrow keys — and
deliberately not the `scroll` event, which the panel's own smooth scrolling fires by the
dozen and which would therefore switch the following off every time it moved.

A **lyrics tab** can follow along too, but it is pinned to one song and the player is not,
so it checks: the same title cleanup runs on both sides, and it follows only while the two
agree. That check is also what stops a tab showing one song from seeking a different one.

If LRCLIB has nothing, the tab counts down and hands off to your fallback provider
(Google by default) with a **Stay here** button. The side panel never redirects itself —
it cannot load anything outside the extension — so it offers the fallback as a button.

The other providers just open a search:

| Provider | Good for |
| --- | --- |
| Google / DuckDuckGo | Anything. The query gets `lyrics english` appended (configurable) |
| Genius | Usually carries romanized Bollywood lyrics |
| Musixmatch | Hindi tracks are normally stored in Hinglish here |
| LyricsMint | Hinglish plus an English translation |
| AZLyrics | English / international tracks |

Change the default and fallback in the extension's **Settings** page (toolbar icon → Settings).

## Settings

- **Default / fallback provider** — what Alt+L and Alt+Shift+L do.
- **Extra search words** — appended to search-engine queries. `lyrics english` by default;
  `lyrics hinglish` or `lyrics meaning` also work well.
- **Include the album / movie name** — helps for film songs with generic titles.
- **Romanize Devanagari song titles before searching** — a Devanagari title searches badly;
  this converts it first.
- **Open in the background** — keeps YouTube Music focused.
- **Redirect when the panel finds nothing** — on by default.
- **Highlight the current line when the lyrics are timed** — on by default. See
  *Following the song* above; the panel's own **Sync** button overrides it for one song.
- **Identify uploads against the Apple Music catalogue** — off by default. Ticking it asks
  Chrome for permission to contact `itunes.apple.com`; unticking it revokes the permission
  again. See *Working out which song it is* above.
- **Look up missing lyrics on LyricsMint** — off by default, same permission dance for
  `lyricsmint.com`. Runs only once LRCLIB has come back empty. Lyrics are copyrighted and
  LyricsMint licenses them for its own site; this is for your own reading.
- **Show the player-bar button** / **auto-romanize** — for the on-page behaviour.
- **Transliteration test** — paste Devanagari and see exactly what the romanizer produces.

## The romanizer

`src/translit.js` is a self-contained Devanagari → Hinglish transliterator (no dependencies).
It aims at what a Hindi speaker would actually type, not strict IAST, which means guessing
at schwa deletion:

| Input | Output | Rule |
| --- | --- | --- |
| दिल | dil | word-final schwa dropped |
| मित्र | mitra | kept after a conjunct ending in a liquid |
| इश्क़ | ishq | dropped after other final clusters |
| धड़कन | dhadkan | second-syllable schwa dropped in long words |
| कमल | kamal | but not in short ones |
| बेवफ़ा | bevafaa | nor after a heavy first syllable |
| ज़िंदगी | zindagi | nor after a nasalised one |

It is a heuristic, so it will occasionally leave an extra vowel in (`shikavaa` for शिकवा).
That is deliberate — an extra vowel still reads fine, a missing one does not. Words the rules
genuinely get wrong go in the `EXCEPTIONS` map at the bottom of `src/translit.js`.

## Layout

```
manifest.json
icons/                 generated PNGs
src/
  translit.js          Devanagari -> Hinglish, no dependencies
  common.js            settings, title cleanup, provider URLs, LRCLIB ranking
  content.js           reads the player bar, injects buttons, romanizes the panel,
                       publishes the playing position while the panel asks for it
  page-bridge.js       runs in the page's MAIN world to read the player's JS API
                       and to seek it when a lyric line is clicked
  content.css
  background.js        service worker: side panel, tabs, shortcuts, menus, LRCLIB
  popup.html/.js/.css
  options.html/.js/.css
  lyrics.html          the LRCLIB panel pinned to one song (a tab)
  sidepanel.html/.css  the same panel, live, in the browser side panel
  lyrics.js            drives both — data-mode="live" or "static" — including the
                       LRC clock, the line highlight and click-to-seek
  lyrics.css
test/run-tests.js      node test/run-tests.js
test/fixtures/         a real LyricsMint page, trimmed, for the parser tests
```

The service worker owns every LRCLIB request and keeps the last two dozen results in
memory, keyed by song *and duration* — a lookup made before the player reported a length
cannot reach the exact-match endpoint, so its miss must not answer for the one made after. The side panel is a document the browser may destroy and rebuild at will, so
putting the cache behind it means reopening the panel is instant, and a song change can
warm the next result before you look at it.

## Tests

```bash
node test/run-tests.js
```

Covers the transliterator, the title cleanup, the provider URL builders, the LRCLIB
query/ranking logic, the LRC parser, and the pin keys, records and offset arithmetic —
everything that does not need a browser.

## Notes / limitations

- Song detection reads `ytmusic-player-bar`. If YouTube Music renames those classes the
  extension falls back to `navigator.mediaSession`, the player's own JS API (through
  `page-bridge.js`), the queue and the document title, and the injected buttons quietly
  disappear rather than breaking the page — the toolbar popup and shortcuts still work.
- `chrome.sidePanel.open()` only works inside a user gesture, and the gesture survives the
  hop from the page to the service worker but *not* a single `await` — including the one
  it takes to read the chosen provider out of `chrome.storage`. So the worker keeps a
  synchronous mirror of the settings and calls `open()` as the first statement of the
  listener that received the click or the keystroke; everything else happens afterwards.
  Any failure still falls through to the lyrics tab rather than doing nothing.
- Pins live in `chrome.storage.local`, which is per-browser and does not sync. A pin made
  in one browser is not visible in another, and uninstalling loses them. This is
  deliberate: `chrome.storage.sync` holds about 100 KB with an 8 KB item cap, 512 items and
  1,800 writes an hour, none of which suits a table that grows with listening. A pin record
  is roughly 50 bytes, so the 10 MB local budget holds well over a hundred thousand of
  them. Only the id and the offset are stored — never the lyrics themselves.
- The side panel is one panel per browser window, tracking whichever tab is playing —
  not one per tab.
- Only `music.youtube.com` and `lrclib.net` are in `host_permissions`; nothing else is read
  or contacted. `itunes.apple.com` and `lyricsmint.com` are `optional_host_permissions` —
  not granted at install, requested only when you tick the matching setting, and revoked
  when you untick it. The worker re-checks the grant before every request rather than
  trusting the stored setting, and the Settings page reconciles its checkboxes against the
  real grants on load, so revoking from `chrome://extensions` cannot leave a lying tickbox.
- The LyricsMint reader is regex over markup. It is verified against the page title before
  a word is used, but a redesign there will break it — it fails to nothing rather than to
  something wrong.
- Timings only ever come from LRCLIB. LyricsMint publishes none, so a track that reaches
  the panel through that fallback is plain text, and so is any track LRCLIB has stored
  without an LRC file.
- While the highlight is on, the service worker stays awake: the position sample travels
  through it once a second. That is the cost of the panel not being able to reach the
  YouTube Music tab itself, and it stops as soon as the lease lapses — a closed panel, or a
  song with no timings, costs nothing.
- Line timings are the whole line. Word-level (enhanced) LRC is parsed so its tags never
  reach the screen, but the word timings in it are not used.
- Medial schwa deletion beyond the second syllable is not attempted (तड़पना → `tadpanaa`,
  not `tadapnaa`).
