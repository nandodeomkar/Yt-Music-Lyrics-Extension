/*
 * Service worker: owns tab opening, the side panel, keyboard commands,
 * context menus and every LRCLIB request.
 *
 * Lyrics are fetched here rather than in the panel page so that the side
 * panel — which the browser is free to tear down and rebuild — never loses a
 * result it already paid for, and so a song change can warm the cache before
 * the user looks at it.
 */
importScripts('./translit.js', './common.js');

var YTML = self.YTML;

/* -------------------------------------------------------- settings mirror */

/*
 * chrome.sidePanel.open() has to run synchronously inside the event that
 * carried the user gesture. A single `await` before it — including the one
 * needed to read the chosen provider out of chrome.storage — and Chrome
 * rejects the call, which is why every entry point except the popup used to
 * fall through to a tab.
 *
 * So the worker keeps a synchronous mirror of the settings: primed on load,
 * kept fresh by the change event, and re-primed by every openLyrics call.
 */
var settingsCache = null;

YTML.getSettings().then(function (s) { settingsCache = s; });

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'sync' || !settingsCache) return;
  Object.keys(changes).forEach(function (key) {
    settingsCache[key] = changes[key].newValue;
  });
});

/*
 * The provider a gesture-bearing listener has to assume, with no await
 * available to check. A worker that has just woken has no mirror yet; the
 * shipped default is the side panel, and opening it when the user actually
 * wanted Google is a smaller failure than never opening it at all. The caller
 * passes providerId: null in that case so openLyrics still resolves the real
 * provider from storage.
 */
function providerNow(useFallback) {
  var s = settingsCache || YTML.DEFAULTS;
  return useFallback ? s.fallbackProvider : s.provider;
}

/* ------------------------------------------------------------------ util */

function sendToTab(tabId, message) {
  return new Promise(function (resolve) {
    try {
      chrome.tabs.sendMessage(tabId, message, function (response) {
        void chrome.runtime.lastError;
        resolve(response || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

async function findMusicTab() {
  var active = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active[0] && /^https:\/\/music\.youtube\.com\//.test(active[0].url || '')) {
    return active[0];
  }
  var all = await chrome.tabs.query({ url: 'https://music.youtube.com/*' });
  if (!all.length) return null;

  // Prefer a tab that is actually making sound.
  var audible = all.filter(function (t) { return t.audible; });
  return audible[0] || all[0];
}

async function getCurrentSong() {
  var tab = await findMusicTab();
  if (!tab) return { song: null, tab: null };
  var res = await sendToTab(tab.id, { type: 'get-song' });
  return { song: res && res.song ? res.song : null, tab: tab };
}

/* -------------------------------------------------------- song resolution */

/*
 * An upload's title tells you who uploaded it, not what the song is. When the
 * metadata looks like an upload rather than a catalogue entry, ask Apple's
 * search API — free, keyless, and it answers with a runtime, which is the only
 * field here that can prove a match wrong.
 *
 * Behind an optional permission: the extension contacts nothing but YouTube
 * Music and LRCLIB until the user turns this on in Settings.
 */
var ITUNES_ORIGIN = 'https://itunes.apple.com/*';
var LYRICSMINT_ORIGIN = 'https://lyricsmint.com/*';
var RESOLVE_LIMIT = 32;
var resolved = new Map();

/*
 * Asked before every optional-origin request rather than inferred from the
 * stored setting: the user can revoke a permission from chrome://extensions
 * without this extension hearing a word about it.
 */
function hasOrigin(origin) {
  return new Promise(function (resolve) {
    if (!chrome.permissions || !chrome.permissions.contains) {
      resolve(false);
      return;
    }
    try {
      chrome.permissions.contains({ origins: [origin] }, function (granted) {
        void chrome.runtime.lastError;
        resolve(!!granted);
      });
    } catch (e) {
      resolve(false);
    }
  });
}

async function resolveSong(song, settings) {
  if (!settings.resolveSong) return null;
  if (!YTML.looksUnreliable(song)) return null;

  var term = YTML.itunesTerm(song);
  if (!term) return null;

  // Cached per term *and* runtime: the runtime is half the match.
  var key = term + '|' + song.duration;
  if (resolved.has(key)) return resolved.get(key);

  if (!(await hasOrigin(ITUNES_ORIGIN))) return null;

  var match = null;
  try {
    var response = await fetch(
      'https://itunes.apple.com/search?media=music&entity=song&limit=8&term=' +
      encodeURIComponent(term)
    );
    if (response.ok) {
      var body = await response.json();
      var results = (body && body.results) || [];
      match = YTML.pickItunesMatch(results, song);

      // A refusal is as worth seeing as a match: it is the difference between
      // "we searched for the wrong song" and "the catalogue does not have it".
      console.log('[ytml] resolve', {
        term: term,
        candidates: results.length,
        best: results.map(function (item) {
          return (item.trackName || '?') + ' — ' + (item.artistName || '?') +
                 ' (' + YTML.itunesSeconds(item) + 's, score ' +
                 YTML.scoreItunesCandidate(item, song) + ')';
        }),
        accepted: match ? match.title + ' — ' + match.artist : 'none, below threshold'
      });
    }
  } catch (e) {
    match = null;       // offline, blocked, throttled — fall back to guessing
  }

  // A miss is worth remembering too, so a hopeless song costs one request.
  resolved.set(key, match);
  while (resolved.size > RESOLVE_LIMIT) {
    resolved.delete(resolved.keys().next().value);
  }
  return match;
}

/* ------------------------------------------------------------ lyricsmint */

/*
 * Tried only once LRCLIB has run out, and shaped into the same ranked-entry
 * form the panel already renders so nothing downstream has to know a second
 * provider exists.
 *
 * A guessed slug that 404s costs nothing; a guessed slug that resolves to the
 * wrong song would be worse than no lyrics, so the page title has to agree
 * with what we searched for before a word of it is used.
 */
async function lyricsMintLookup(song, settings) {
  if (!settings.useLyricsMint) return [];

  var paths = YTML.lyricsMintPaths(song);
  if (!paths.length) return [];
  if (!(await hasOrigin(LYRICSMINT_ORIGIN))) return [];

  for (var i = 0; i < paths.length; i++) {
    var url = 'https://lyricsmint.com/' + paths[i];
    try {
      var response = await fetch(url);
      if (!response.ok) continue;

      var html = await response.text();
      var pageTitle = YTML.lyricsMintPageTitle(html);
      var agreement = YTML.lyricsMintAgreement(song, pageTitle);
      if (agreement < 0.6) {
        console.log('[ytml] lyricsmint rejected', { url: url, pageTitle: pageTitle, overlap: agreement });
        continue;
      }

      var parsed = YTML.parseLyricsMint(html);
      // Hinglish is the point of this provider; the Devanagari is a fallback
      // the panel's own romanize button can still convert.
      var text = parsed.romanized || parsed.devanagari;
      if (!text) continue;

      console.log('[ytml] lyricsmint hit', { url: url, overlap: agreement, lines: text.split('\n').length });
      return [{
        score: 0,
        text: text,
        // Same shape as a ranked LRCLIB entry, minus the timings LyricsMint
        // does not publish — so the panel needs no idea a second provider exists.
        synced: '',
        item: {
          provider: 'lyricsmint',
          url: url,
          trackName: song.title,
          artistName: song.artist,
          duration: Number(song.duration) || 0
        }
      }];
    } catch (e) {
      // offline, blocked, throttled — try the next slug, then give up quietly
    }
  }

  return [];
}

/* ---------------------------------------------------------------- lrclib */

var CACHE_LIMIT = 24;
var cache = new Map();

function cacheGet(key) {
  if (!cache.has(key)) return null;
  var value = cache.get(key);
  cache.delete(key);       // re-insert so the Map order stays least-recent-first
  cache.set(key, value);
  return value;
}

function cachePut(key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
}

// Deliberately header-free: any custom header would turn this into a
// preflighted request for no benefit.
async function lrclib(pathAndQuery) {
  var response = await fetch('https://lrclib.net/api/' + pathAndQuery);
  if (!response.ok) throw new Error('LRCLIB ' + response.status);
  return response.json();
}

/*
 * One entry by id, for a pin. Separate from lrclib() because the two failures
 * mean different things here: a 404 is LRCLIB saying the entry is gone, which
 * the user should hear about, and anything else is a bad line, which they
 * should not. Only the first returns null; the rest throw and are swallowed.
 */
async function lrclibTrack(id) {
  var response = await fetch('https://lrclib.net/api/get/' + encodeURIComponent(id));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('LRCLIB ' + response.status);
  return response.json();
}

/* ------------------------------------------------------------------ pins */

/*
 * A pinned song remembers which LRCLIB entry was right and how far its timings
 * had to move. One storage key per song rather than one table: a point read on
 * every lookup, and no way for a side panel and a lyrics tab writing at the
 * same moment to overwrite each other's work.
 *
 * Every function here takes the *normalized* song — the one searchLyrics
 * returned, after resolveSong settled what the track actually is. Keying off
 * the upload's own title instead would file a pin where the next play can
 * never find it.
 */
function pinStorageKey(resolved) {
  return YTML.PIN_PREFIX + YTML.pinKey(resolved);
}

function pinRecords(resolved) {
  return new Promise(function (resolve) {
    var key = pinStorageKey(resolved);
    try {
      chrome.storage.local.get(key, function (stored) {
        void chrome.runtime.lastError;
        var list = stored && stored[key];
        resolve(Array.isArray(list) ? list : []);
      });
    } catch (e) {
      resolve([]);
    }
  });
}

function pinFor(resolved) {
  return pinRecords(resolved).then(function (records) {
    return YTML.pinRecordFor(records, resolved.duration);
  });
}

/*
 * Unlike a read, a failed write has to be heard: the panel shows a saved state
 * it would otherwise have no reason to doubt.
 */
function pinWrite(resolved, records) {
  return new Promise(function (resolve, reject) {
    var key = pinStorageKey(resolved);

    function done() {
      var err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message || 'storage write failed'));
      else resolve(true);
    }

    try {
      if (records.length) {
        var patch = {};
        patch[key] = records;
        chrome.storage.local.set(patch, done);
      } else {
        chrome.storage.local.remove(key, done);
      }
    } catch (e) {
      reject(e);
    }
  });
}

async function pinSave(resolved, id, off) {
  var records = await pinRecords(resolved);
  var seconds = Math.round(Number(resolved && resolved.duration));

  await pinWrite(resolved, YTML.pinRecordsWith(records, {
    dur: isFinite(seconds) && seconds > 0 ? seconds : 0,
    id: Number(id),
    off: YTML.clampOffset(off),
    at: Date.now()
  }));
  // Whatever this song last resolved to is now the wrong answer.
  cache.clear();
  return true;
}

async function pinRemove(resolved) {
  var records = await pinRecords(resolved);
  var target = YTML.pinRecordFor(records, resolved && resolved.duration);
  if (!target) return false;

  await pinWrite(resolved, records.filter(function (record) {
    return record !== target;
  }));
  cache.clear();
  return true;
}

/*
 * Returns the ranked matches for a song, newest query shape first. Network
 * failures are swallowed per query — a 500 on the strict search should still
 * let the looser one answer.
 */
async function searchLyrics(song, settings, opts) {
  var options = opts || {};
  var normalized = YTML.normalizeSong(song, settings);

  // Ask what the song actually is before asking where its lyrics are. A match
  // rewrites the title, artist, album and runtime, so everything below — cache
  // key included — keys off the resolved identity rather than the upload's.
  var match = await resolveSong(normalized, settings);
  if (match) {
    normalized = YTML.normalizeSong(YTML.applyItunesMatch(normalized, match), settings);
    console.log('[ytml] resolved', {
      from: YTML.itunesTerm(YTML.normalizeSong(song, settings)),
      to: normalized.title + ' — ' + normalized.artist,
      album: normalized.album,
      duration: normalized.duration,
      score: match.score
    });
  }

  var key = YTML.songKey(normalized);
  // A lookup with a duration can reach matches a durationless one cannot, so
  // the two must not share a cache entry — otherwise an early miss, recorded
  // before the player reported a length, would answer every later attempt.
  var slot = key + '|' + normalized.duration;

  /*
   * Ignoring the pin means ignoring the cache in both directions. Cache entries
   * record which pin produced them, so a ladder result filed under this slot
   * would go on answering pinned lookups with the wrong entry.
   */
  var usePin = !options.ignorePin;
  var canCache = usePin && key !== '|';
  var pin = usePin ? await pinFor(normalized) : null;
  var pinStale = false;

  if (canCache) {
    var hit = cacheGet(slot);
    if (hit) {
      return {
        song: normalized,
        results: hit.results,
        // An offset was measured against one entry. If what is cached did not
        // come from this pin, it is a different entry and must not inherit it.
        pin: pin && hit.pinId === pin.id ? pin : null,
        cached: true
      };
    }
  }

  /*
   * The whole point of a pin: one request for the entry the user already
   * decided was right, instead of a ladder of up to eleven guesses that may
   * never surface it. Everything below is the fallback.
   */
  if (pin) {
    try {
      var track = await lrclibTrack(pin.id);
      if (track === null) {
        // LRCLIB says the entry is gone. Worth telling the user, since only
        // they can pick a replacement.
        pinStale = true;
      } else {
        var pinned = YTML.rankLrclibResults([track], normalized);
        if (pinned.length) {
          if (canCache) cachePut(slot, { results: pinned, pinId: pin.id });
          return { song: normalized, results: pinned, pin: pin, cached: false };
        }
        // Still there, but with nothing usable left in it — an instrumental,
        // or an entry emptied since. Not gone, so not stale; just no help.
      }
    } catch (e) {
      // A bad line is not a stale pin. Fall through and say nothing.
    }
  }

  var queries = YTML.lrclibQueries(normalized);
  for (var i = 0; i < queries.length; i++) {
    var ranked = [];
    try {
      var body = await lrclib(queries[i].path);
      // /api/get answers with a single track; everything else with a list.
      ranked = YTML.rankLrclibResults(
        queries[i].single ? (body ? [body] : []) : body,
        normalized
      );
    } catch (e) {
      continue;
    }
    if (ranked.length) {
      if (canCache) cachePut(slot, { results: ranked, pinId: null });
      return { song: normalized, results: ranked, pinStale: pinStale, cached: false };
    }
  }

  // LRCLIB is out of ideas. Anything else the user has switched on gets a turn
  // before the panel reports nothing.
  var extra = await lyricsMintLookup(normalized, settings);
  if (extra.length) {
    if (canCache) cachePut(slot, { results: extra, pinId: null });
    return { song: normalized, results: extra, pinStale: pinStale, cached: false };
  }

  if (canCache) cachePut(slot, { results: [], pinId: null });
  return { song: normalized, results: [], pinStale: pinStale, cached: false };
}

/* ------------------------------------------------------------ side panel */

function sidePanelSupported() {
  return !!(chrome.sidePanel && chrome.sidePanel.open);
}

async function sidePanelIsOpen() {
  if (!chrome.runtime.getContexts) return false;
  try {
    var contexts = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
    return !!(contexts && contexts.length);
  } catch (e) {
    return false;
  }
}

/*
 * The gesture-bearing half of opening the panel. Awaits nothing, reads no
 * storage, and must be reached as the first statement of the listener that
 * received the click or the keystroke. Every failure — old browser, no
 * gesture, no window, panel disabled — resolves to false so the caller can
 * fall back to a normal tab.
 */
function openSidePanelNow(windowId) {
  // null means "not attempted" — no window to aim at, or no API to aim it
  // with — which tells openLyrics it is still worth trying the slow path. A
  // promise means the call went out and its result is the whole answer.
  if (!sidePanelSupported() || windowId == null) return null;
  try {
    return chrome.sidePanel.open({ windowId: windowId })
      .then(function () { return true; })
      .catch(function () { return false; });
  } catch (e) {
    return Promise.resolve(false);
  }
}

/*
 * Last resort for callers with no window to aim at. Resolving the window is
 * itself an await, so by the time this reaches sidePanel.open() the gesture is
 * gone and Chrome will refuse — it is here so those paths degrade to a tab
 * rather than throwing.
 */
async function openSidePanelSlow(windowId) {
  if (!sidePanelSupported()) return false;
  try {
    if (windowId == null) {
      var win = await chrome.windows.getCurrent();
      windowId = win && win.id;
    }
    if (windowId == null) return false;
    await chrome.sidePanel.open({ windowId: windowId });
    return true;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ open */

async function openLyrics(song, providerId, context) {
  var settings = await YTML.getSettings();
  settingsCache = settings;
  var provider = providerId || settings.provider;
  context = context || {};

  /*
   * Whether the side panel opens comes down to which surface the click or the
   * keystroke arrived on, and that is invisible from the outside — every
   * failure looks identically like "a tab appeared". So every attempt says
   * what it tried and what it got.
   */
  function done(where) {
    console.log('[ytml] open', {
      from: context.from || 'unknown',
      askedFor: providerId || '(default)',
      resolvedTo: provider,
      song: (song && song.title) || null,
      duration: (song && song.duration) || 0,
      panelAttempted: context.panelOpened ? 'in the listener' : 'after an await',
      landedIn: where
    });
    return { ok: true, where: where };
  }

  if (!song || !song.title) {
    var found = await getCurrentSong();
    song = found.song;
  }

  // The side panel always shows whatever is playing, so a one-off lookup
  // (a text selection, say) has to go somewhere that can hold a fixed song.
  if (provider === 'sidebar' && context.noSidebar) provider = 'panel';

  if (provider === 'sidebar') {
    // The listener normally started the open before handing over, precisely so
    // the gesture was still alive; awaiting its promise here is safe because
    // the API call already happened.
    var opened = context.panelOpened
      ? await context.panelOpened
      : await openSidePanelSlow(context.windowId);

    if (opened) {
      // The panel asks for the song itself once it boots; warming the cache
      // here means it usually has lyrics on first paint.
      if (song && song.title) searchLyrics(song, settings).catch(function () {});
      return done('sidebar');
    }
    provider = 'panel';   // side panel unavailable — fall back to the tab
  }

  if (!song || !song.title) {
    await chrome.tabs.create({
      url: chrome.runtime.getURL('src/lyrics.html') + '?error=nosong',
      active: true
    });
    return done('tab');
  }

  var url = YTML.providerUrl(provider, song, settings);
  await chrome.tabs.create({ url: url, active: !settings.openInBackground });
  return done('tab');
}

/* -------------------------------------------------------------- messages */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  if (msg.type === 'open-lyrics') {
    var windowId = sender.tab ? sender.tab.windowId : undefined;
    var wanted = msg.provider || providerNow(false);

    /*
     * First statement on whatever gesture arrived with the message. Chrome
     * carries user activation from an extension page reliably and from a
     * content script only sometimes, so this is worth attempting and never
     * worth relying on — a page button that cannot open the panel still gets
     * the lyrics tab below.
     */
    var panelOpened = (wanted === 'sidebar' && !msg.noSidebar)
      ? openSidePanelNow(windowId)
      : null;

    openLyrics(msg.song, msg.provider, {
      from: sender.tab ? 'page-button' : 'extension-page',
      windowId: windowId,
      panelOpened: panelOpened,
      noSidebar: !!msg.noSidebar
    }).then(sendResponse);
    return true;
  }

  if (msg.type === 'get-current-song') {
    getCurrentSong().then(sendResponse);
    return true;
  }

  if (msg.type === 'fetch-lyrics') {
    YTML.getSettings()
      .then(function (settings) { return searchLyrics(msg.song, settings); })
      .then(function (result) { sendResponse(result); })
      .catch(function (e) {
        sendResponse({ song: null, results: [], error: String(e && e.message || e) });
      });
    return true;
  }

  /*
   * Everything the ladder would have found, with the pin ignored — what backs
   * "Show other matches" on a song whose pin short-circuited the search. Takes
   * the raw song, like fetch-lyrics, because it runs the same lookup.
   */
  if (msg.type === 'fetch-alternates') {
    YTML.getSettings()
      .then(function (settings) {
        return searchLyrics(msg.song, settings, { ignorePin: true });
      })
      .then(function (result) { sendResponse(result); })
      .catch(function (e) {
        sendResponse({ song: null, results: [], error: String(e && e.message || e) });
      });
    return true;
  }

  /*
   * These two take `resolved` — the normalized song from a fetch-lyrics reply,
   * not the raw player metadata every other message carries. A pin filed under
   * an upload's own title is a pin the next play cannot find, and re-resolving
   * here would mean an iTunes round trip on a button press.
   */
  if (msg.type === 'pin-song') {
    pinSave(msg.resolved, msg.id, msg.off)
      .then(function () { sendResponse({ ok: true }); })
      .catch(function (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      });
    return true;
  }

  if (msg.type === 'unpin-song') {
    pinRemove(msg.resolved)
      .then(function (removed) { sendResponse({ ok: true, removed: removed }); })
      .catch(function (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      });
    return true;
  }

  // Broadcast from the content script. Extension pages listen for it
  // directly; the worker only uses it to warm the cache.
  if (msg.type === 'song-changed') {
    sidePanelIsOpen().then(function (open) {
      if (!open || !msg.song || !msg.song.title) return;
      return YTML.getSettings().then(function (settings) {
        return searchLyrics(msg.song, settings);
      });
    }).catch(function () { /* prefetch is best effort */ });
    return;
  }

  /*
   * Synced lyrics, both directions. The panel cannot reach the YouTube Music
   * tab itself — finding it is the worker's job already — so renewing the
   * position lease and seeking from a clicked line are both relayed. A reply
   * of ok:false means there was no tab or no player, which is the panel's cue
   * to stop showing a position it no longer knows.
   *
   * The 'player-position' broadcast coming back the other way is not handled
   * here at all: it is addressed to the panel, and the worker only has to not
   * mistake it for something of its own.
   */
  if (msg.type === 'sync-watch' || msg.type === 'seek-to') {
    findMusicTab().then(function (tab) {
      if (!tab) {
        sendResponse({ ok: false });
        return;
      }
      sendToTab(tab.id, msg).then(function (res) {
        sendResponse(res || { ok: false });
      });
    });
    return true;
  }

  if (msg.type === 'toggle-romanize-active') {
    findMusicTab().then(function (tab) {
      if (!tab) {
        sendResponse({ romanized: false, ok: false });
        return;
      }
      sendToTab(tab.id, { type: 'toggle-romanize' }).then(function (res) {
        sendResponse({ romanized: !!(res && res.romanized), ok: !!res });
      });
    });
    return true;
  }
});

/* -------------------------------------------------------------- commands */

/*
 * Deliberately not an async function: reading the provider from storage would
 * put an await in front of sidePanel.open() and cost the keystroke's gesture,
 * which is what kept Alt+L opening a tab instead of the panel.
 */
chrome.commands.onCommand.addListener(function (command, tab) {
  var windowId = tab ? tab.windowId : undefined;

  if (command === 'open-lyrics' || command === 'open-lyrics-fallback') {
    var useFallback = command === 'open-lyrics-fallback';
    var wanted = providerNow(useFallback);
    var panelOpened = wanted === 'sidebar' ? openSidePanelNow(windowId) : null;

    // A cold worker guessed; let openLyrics settle the provider from storage.
    openLyrics(null, settingsCache ? wanted : null, {
      from: 'shortcut:' + command,
      windowId: windowId,
      panelOpened: panelOpened
    });
    return;
  }

  if (command === 'toggle-romanize') {
    findMusicTab().then(function (musicTab) {
      if (musicTab) sendToTab(musicTab.id, { type: 'toggle-romanize' });
    });
  }
});

/* --------------------------------------------------------- context menus */

function buildMenus() {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: 'ytml-open',
      title: 'Open lyrics for the current song',
      contexts: ['page'],
      documentUrlPatterns: ['https://music.youtube.com/*']
    });
    // documentUrlPatterns does not apply to the action context, so this one
    // is registered separately and stays available from the toolbar icon.
    chrome.contextMenus.create({
      id: 'ytml-open-action',
      title: 'Open lyrics for the current song',
      contexts: ['action']
    });
    chrome.contextMenus.create({
      id: 'ytml-romanize',
      title: 'Romanize / restore the lyrics panel',
      contexts: ['page'],
      documentUrlPatterns: ['https://music.youtube.com/*']
    });
    chrome.contextMenus.create({
      id: 'ytml-sep',
      type: 'separator',
      contexts: ['page'],
      documentUrlPatterns: ['https://music.youtube.com/*']
    });

    YTML.PROVIDERS.forEach(function (p) {
      chrome.contextMenus.create({
        id: 'ytml-provider-' + p.id,
        title: p.id === 'sidebar' ? 'Lyrics in the side panel' : 'Lyrics on ' + p.label,
        contexts: ['page'],
        documentUrlPatterns: ['https://music.youtube.com/*']
      });
    });

    chrome.contextMenus.create({
      id: 'ytml-selection',
      title: 'Find English lyrics for "%s"',
      contexts: ['selection']
    });
  });
}

/*
 * The manifest already declares the panel, but its enabled flag is stored per
 * profile and a single setOptions({ enabled: false }) anywhere — ours or a
 * past version's — sticks until something sets it back. Asserting it on every
 * install and startup means a panel can never stay switched off.
 */
function enableSidePanel() {
  if (!chrome.sidePanel || !chrome.sidePanel.setOptions) return;
  try {
    chrome.sidePanel
      .setOptions({ path: 'src/sidepanel.html', enabled: true })
      .catch(function () { /* older builds simply do not have it */ });
  } catch (e) { /* ignore */ }
}

function setUp() {
  buildMenus();
  enableSidePanel();
}

chrome.runtime.onInstalled.addListener(setUp);
chrome.runtime.onStartup.addListener(setUp);

// onInstalled and onStartup both skip a plain service-worker restart, which is
// the common case after editing a file and hitting reload.
enableSidePanel();

// Same rule as the command listener: nothing may be awaited ahead of
// openSidePanelNow, so this one is not async either.
chrome.contextMenus.onClicked.addListener(function (info, tab) {
  var windowId = tab ? tab.windowId : undefined;
  var id = String(info.menuItemId);

  if (id === 'ytml-open' || id === 'ytml-open-action') {
    var wanted = providerNow(false);
    openLyrics(null, settingsCache ? wanted : null, {
      from: 'menu',
      windowId: windowId,
      panelOpened: wanted === 'sidebar' ? openSidePanelNow(windowId) : null
    });
    return;
  }
  if (id === 'ytml-romanize') {
    if (tab) sendToTab(tab.id, { type: 'toggle-romanize' });
    return;
  }
  if (id.indexOf('ytml-provider-') === 0) {
    var picked = id.replace('ytml-provider-', '');
    openLyrics(null, picked, {
      from: 'menu-provider',
      windowId: windowId,
      panelOpened: picked === 'sidebar' ? openSidePanelNow(windowId) : null
    });
    return;
  }
  if (id === 'ytml-selection' && info.selectionText) {
    openLyrics(
      { title: info.selectionText, rawTitle: info.selectionText, artist: '', album: '' },
      null,
      { from: 'menu-selection', windowId: windowId, noSidebar: true }
    );
  }
});
