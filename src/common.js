/*
 * Shared config, title cleanup and lyrics-provider URL building.
 * Loaded as a classic script by the content script, the service worker
 * (via importScripts) and every extension page. Exposed as globalThis.YTML.
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    provider: 'sidebar',
    fallbackProvider: 'google',
    querySuffix: 'lyrics english',
    romanizeQuery: true,
    includeAlbum: false,
    autoRomanize: true,
    syncedLyrics: true,
    showPlayerButton: true,
    openInBackground: false,
    autoFallback: true,
    // Both off until the user grants the matching host permission.
    resolveSong: false,
    useLyricsMint: false
  };

  var PROVIDERS = [
    {
      id: 'sidebar',
      label: 'Side panel',
      hint: 'Keeps LRCLIB lyrics in the browser side panel beside YouTube Music, and follows the song as it changes.'
    },
    {
      id: 'panel',
      label: 'Lyrics tab',
      hint: 'Fetches lyrics from LRCLIB into an extension tab and romanizes any Devanagari.'
    },
    {
      id: 'google',
      label: 'Google',
      hint: 'Search "<song> <artist> lyrics english".'
    },
    {
      id: 'genius',
      label: 'Genius',
      hint: 'Usually carries romanized Bollywood lyrics.'
    },
    {
      id: 'musixmatch',
      label: 'Musixmatch',
      hint: 'Hindi tracks are normally stored in Hinglish here.'
    },
    {
      id: 'lyricsmint',
      label: 'LyricsMint',
      hint: 'Hinglish lyrics plus an English translation.'
    },
    {
      id: 'azlyrics',
      label: 'AZLyrics',
      hint: 'Good for English / international tracks.'
    },
    {
      id: 'duckduckgo',
      label: 'DuckDuckGo',
      hint: 'Search engine fallback without Google.'
    }
  ];

  // Junk that YouTube Music / labels staple onto titles.
  var TITLE_NOISE = [
    /\((?:[^()]*\b(?:official|lyric|lyrics|video|audio|hd|4k|full song|video song|visualizer|remaster(?:ed)?|explicit|reprise version)\b[^()]*)\)/gi,
    /\[(?:[^\[\]]*\b(?:official|lyric|lyrics|video|audio|hd|4k|full song|video song|visualizer|remaster(?:ed)?|explicit)\b[^\[\]]*)\]/gi,
    /\s*[-–—]\s*(?:official|lyrical)\s+(?:video|audio|song)\s*$/gi,
    /\bfull\s+(?:video\s+)?song\b/gi,
    /\bvideo\s+song\b/gi,
    /\b(?:official\s+)?(?:lyric|lyrical)\s+video\b/gi,
    /\bofficial\s+(?:music\s+)?video\b/gi,
    /*
     * Whatever format words are left clinging to the end. A trailing "Song"
     * only goes when something stronger precedes it, so "Swan Song" survives
     * and "Odhani Odh Ke Nachu Lyrical Video Song" does not.
     */
    /(?:\s+(?:official|lyrical|lyric|full|hd|4k|video|audio))+(?:\s+song)?\s*$/gi
  ];

  var BYLINE_NOISE = /^(?:\d[\d.,]*\s*[KMB]?\s*(?:views?|plays?)|\d{4}|album|single|song|video|episode)$/i;

  function collapse(text) {
    return String(text == null ? '' : text)
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—|•,]+/, '')
      .replace(/[\s\-–—|•,]+$/, '')
      .trim();
  }

  // Pulls "From \"Movie\"" out of a title: it is noise for the title but a
  // great extra search term for Bollywood tracks.
  function extractSource(title) {
    var m = String(title || '').match(/(?:\(|\[)\s*from\s*["“”']?([^"“”'\)\]]+)["“”']?\s*(?:\)|\])/i);
    return m ? collapse(m[1]) : '';
  }

  /*
   * Indian label uploads pack the whole credit roll into the title:
   *
   *   Odhani Odh Ke Nachu Lyrical Video Song | Tere Naam | Udit N |Alka Y
   *
   * The song is the first segment and the second is nearly always the film,
   * which is the one term LRCLIB is likely to share with us — the singers
   * further along are usually abbreviated past the point of being searchable.
   */
  function splitTitleCredits(title) {
    var parts = String(title == null ? '' : title)
      .split('|')
      .map(collapse)
      .filter(Boolean);
    return { title: parts[0] || '', credits: parts.slice(1) };
  }

  // The film, when the title carried one in its credits rather than in the
  // "(From ...)" that extractSource looks for.
  function creditedSource(title) {
    var credits = splitTitleCredits(title).credits;
    return credits.length ? cleanTitle(credits[0]) : '';
  }

  function cleanTitle(title) {
    var out = splitTitleCredits(title).title;
    out = out.replace(/(?:\(|\[)\s*from\s*[^\)\]]*(?:\)|\])/gi, ' ');
    for (var i = 0; i < TITLE_NOISE.length; i++) {
      out = out.replace(TITLE_NOISE[i], ' ');
    }
    out = out.replace(/\(\s*\)|\[\s*\]/g, ' ');
    return collapse(out);
  }

  function cleanArtist(artist) {
    var out = String(artist == null ? '' : artist);
    out = out.split(/\s*(?:,|&|feat\.?|ft\.?|with|x)\s+/i)[0];
    return collapse(out);
  }

  function isNoiseByline(part) {
    return !part || BYLINE_NOISE.test(collapse(part));
  }

  function romanizeIfNeeded(text, enabled) {
    if (!enabled) return text;
    var t = root.YTMLTranslit;
    if (t && t.hasDevanagari(text)) return t.romanize(text);
    return text;
  }

  /*
   * A Devanagari string and its romanization, in the order the user asked for.
   * LRCLIB stores Hindi tracks either way with no pattern to it, so a lookup
   * that only ever tries one script misses half of them; `main` is what the
   * user sees, `alt` is the other spelling to retry with.
   */
  function scriptPair(text, romanizeFirst) {
    var t = root.YTMLTranslit;
    if (!text || !t || !t.hasDevanagari(text)) return { main: text, alt: '' };
    var roman = t.romanize(text);
    if (roman === text) return { main: text, alt: '' };
    return romanizeFirst ? { main: roman, alt: text } : { main: text, alt: roman };
  }

  // Whole seconds, or '' when the player never told us. Kept as a string so an
  // absent duration drops out of a query the same way an absent album does.
  function durationParam(song) {
    var seconds = Math.round(Number(song && song.duration));
    return isFinite(seconds) && seconds > 0 ? String(seconds) : '';
  }

  function buildQuery(song, settings) {
    var s = settings || DEFAULTS;
    song = song || {};
    var parts = [];
    var title = romanizeIfNeeded(cleanTitle(song.title), s.romanizeQuery);
    var artist = romanizeIfNeeded(cleanArtist(song.artist), s.romanizeQuery);
    var album = romanizeIfNeeded(collapse(song.album), s.romanizeQuery);

    if (title) parts.push(title);
    if (artist) parts.push(artist);
    if (s.includeAlbum && album && album !== title) parts.push(album);
    return collapse(parts.join(' '));
  }

  function panelUrl(song, settings) {
    var s = settings || DEFAULTS;
    var params = new URLSearchParams();
    params.set('title', romanizeIfNeeded(cleanTitle(song && song.title), s.romanizeQuery));
    params.set('artist', romanizeIfNeeded(cleanArtist(song && song.artist), s.romanizeQuery));
    if (song && song.album) {
      params.set('album', romanizeIfNeeded(collapse(song.album), s.romanizeQuery));
    }
    if (song && song.source) params.set('source', song.source);
    if (song && song.rawTitle) params.set('raw', song.rawTitle);
    // Carried so the tab can use LRCLIB's exact lookup too, not just the panel.
    if (durationParam(song)) params.set('dur', durationParam(song));
    var base = (root.chrome && chrome.runtime && chrome.runtime.getURL)
      ? chrome.runtime.getURL('src/lyrics.html')
      : 'lyrics.html';
    return base + '?' + params.toString();
  }

  function providerUrl(id, song, settings) {
    var s = settings || DEFAULTS;
    var query = buildQuery(song, s);
    if (!query) query = collapse((song && song.rawTitle) || '');
    var suffixed = collapse(query + ' ' + (s.querySuffix || ''));
    var q = encodeURIComponent(query);
    var qs = encodeURIComponent(suffixed);

    switch (id) {
      // 'sidebar' is a destination rather than a URL. When the side panel is
      // unavailable the caller opens this same page in a tab instead, so both
      // ids resolve to the panel page.
      case 'sidebar':     return panelUrl(song, s);
      case 'panel':       return panelUrl(song, s);
      case 'google':      return 'https://www.google.com/search?q=' + qs;
      case 'duckduckgo':  return 'https://duckduckgo.com/?q=' + qs;
      case 'genius':      return 'https://genius.com/search?q=' + q;
      case 'musixmatch':  return 'https://www.musixmatch.com/search?query=' + q;
      case 'lyricsmint':  return 'https://lyricsmint.com/?s=' + q;
      case 'azlyrics':    return 'https://search.azlyrics.com/search.php?q=' + q;
      default:            return 'https://www.google.com/search?q=' + qs;
    }
  }

  /* ------------------------------------------------------ song resolution */

  /*
   * The same song reaches YouTube Music as an original, a lyrical video, a
   * remix and half a dozen community re-uploads, each titled by whoever
   * uploaded it. No amount of cleaning collapses those to one identity, so
   * when the metadata looks like an upload rather than a catalogue entry the
   * worker asks Apple's search API what the song actually is, and checks the
   * answer against the runtime it already read off the player.
   *
   * Everything here is pure — the fetch, the permission and the caching live
   * in the service worker.
   */

  // Uploader names that are a label or a channel rather than a performer.
  var LABEL_ARTIST = new RegExp(
    '\\b(?:t[-\\s]?series|zee music|sony music|tips|venus|saregama|shemaroo' +
    '|yrf|yash raj|speed records|eros|junglee|times music|aditya music' +
    '|lahari|goldmines|wave music|ultra)\\b' +
    '|\\b(?:records|recordings|music company|music india|music group' +
    '|entertainment|productions?|studios?|official)\\b', 'i');

  function isLabelArtist(artist) {
    var name = collapse(artist);
    return !!name && LABEL_ARTIST.test(name);
  }

  function tokens(text) {
    return String(text == null ? '' : text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter(Boolean);
  }

  // How much of `want` survives inside `got`, 0 to 1. Deliberately asymmetric:
  // a catalogue title carrying extra words is still the song we asked for.
  function titleOverlap(want, got) {
    var wanted = tokens(want);
    var found = tokens(got);
    if (!wanted.length || !found.length) return 0;

    var index = {};
    found.forEach(function (token) { index[token] = true; });

    var hits = 0;
    wanted.forEach(function (token) { if (index[token]) hits++; });
    return hits / wanted.length;
  }

  /*
   * Whether this song is worth spending a lookup on. A clean YouTube Music
   * catalogue entry already knows its own title and artist; an upload gives
   * itself away with a credit roll, a label in the artist slot, or a title
   * that lost most of itself to cleanup.
   */
  function looksUnreliable(song) {
    song = song || {};
    var title = collapse(song.title);
    if (!title) return false;

    var raw = collapse(song.rawTitle || song.title);
    if (splitTitleCredits(raw).credits.length) return true;
    if (!collapse(song.artist)) return true;
    if (isLabelArtist(song.artist)) return true;

    // "(From ...)" is information, not noise, so it does not count against it.
    var stripped = collapse(raw.replace(/(?:\(|\[)\s*from\s*[^\)\]]*(?:\)|\])/gi, ' '));
    return stripped.length > title.length * 1.5;
  }

  function itunesTerm(song) {
    song = song || {};
    var parts = [collapse(song.title)];
    if (!isLabelArtist(song.artist)) parts.push(collapse(song.artist));
    parts.push(collapse(song.source));

    var seen = {};
    var term = collapse(parts.filter(function (part) {
      var key = part.toLowerCase();
      if (!part || seen[key]) return false;
      seen[key] = true;
      return true;
    }).join(' '));

    // Long terms match worse, not better.
    return term.length > 120 ? collapse(term.slice(0, 120)) : term;
  }

  function itunesSeconds(item) {
    var ms = Number(item && item.trackTimeMillis);
    return isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  }

  function scoreItunesCandidate(item, song) {
    item = item || {};
    song = song || {};

    var score = 0;
    var overlap = titleOverlap(song.title, item.trackName);

    if (overlap >= 0.99) score += 5;
    else if (overlap >= 0.6) score += 3;
    else if (overlap >= 0.3) score += 1;
    else score -= 2;

    /*
     * The runtime is what separates the original from the remix, the extended
     * cut and the cover — every one of which carries a plausible title. It is
     * the only signal here that can actually falsify a match.
     */
    var want = Math.round(Number(song.duration));
    var got = itunesSeconds(item);
    if (want > 0 && got > 0) {
      var drift = Math.abs(want - got);
      if (drift <= 3) score += 6;
      else if (drift <= 10) score += 4;
      else if (drift <= 20) score += 1;
      else if (drift > 45) score -= 6;
    }

    if (!isLabelArtist(song.artist) && titleOverlap(song.artist, item.artistName) >= 0.5) score += 3;
    if (song.source && titleOverlap(song.source, item.collectionName) >= 0.5) score += 3;

    return score;
  }

  function pickItunesMatch(results, song) {
    if (!Array.isArray(results) || !results.length) return null;

    var best = null;
    results.forEach(function (item) {
      if (!item || !collapse(item.trackName)) return;
      var score = scoreItunesCandidate(item, song);
      if (!best || score > best.score) best = { item: item, score: score };
    });
    if (!best) return null;

    /*
     * A confident wrong answer is worse than none: it swaps a title that was
     * merely messy for one that is merely wrong, and the ladder below has no
     * way to tell. So a match needs most of the title as well as a real score,
     * and with no duration to corroborate it the bar goes up rather than the
     * check being waived — 11 is everything else scoring perfectly.
     */
    var overlap = titleOverlap(song && song.title, best.item.trackName);
    var corroborated = Math.round(Number(song && song.duration)) > 0 &&
                       itunesSeconds(best.item) > 0;

    if (overlap < 0.5) return null;
    if (best.score < (corroborated ? 8 : 11)) return null;

    return {
      title: collapse(best.item.trackName),
      artist: collapse(best.item.artistName),
      album: collapse(best.item.collectionName),
      duration: itunesSeconds(best.item),
      score: best.score
    };
  }

  function applyItunesMatch(song, match) {
    if (!match) return song;
    song = song || {};
    return Object.assign({}, song, {
      title: match.title,
      artist: match.artist,
      album: match.album || song.album,
      source: song.source || match.album,
      rawTitle: song.rawTitle || song.title,
      // The catalogue's release length is what LRCLIB filed the track under.
      // The video's runtime was only ever the thing we checked it against.
      duration: match.duration || song.duration,
      resolvedBy: 'itunes'
    });
  }

  /* ---------------------------------------------------------- lyricsmint */

  /*
   * LRCLIB is a community database and its Hindi catalogue thins out fast the
   * further back you go. LyricsMint fills part of that in, and files songs at
   *
   *   https://lyricsmint.com/<film-or-artist-slug>/<song-slug>
   *
   * which means no search page has to be scraped — the slug is derivable from
   * what we already know, and a wrong guess is a 404 rather than a wrong song.
   *
   * Everything here is string work on purpose: an MV3 service worker has no
   * DOMParser, and regex over markup that we then verify against the page
   * title beats shipping a parser we cannot run where the fetch happens.
   */

  var HTML_ENTITIES = {
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
    '&quot;': '"', '&#39;': "'", '&apos;': "'", '&hellip;': '…',
    '&ndash;': '–', '&mdash;': '—', '&rsquo;': '’', '&lsquo;': '‘'
  };

  function htmlToText(fragment) {
    return String(fragment == null ? '' : fragment)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|h[1-6]|li)>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&#(\d+);/g, function (whole, code) {
        var n = Number(code);
        return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
      })
      .replace(/&#x([0-9a-f]+);/gi, function (whole, hex) {
        var n = parseInt(hex, 16);
        return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
      })
      .replace(/&[a-z]+[0-9]*;/gi, function (entity) {
        var key = entity.toLowerCase();
        return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, key)
          ? HTML_ENTITIES[key] : entity;
      });
  }

  // One stanza, blank lines squeezed out. Returns '' for anything that was
  // only markup.
  function stanzaText(block) {
    return htmlToText(block)
      .split('\n')
      .map(collapse)
      .filter(Boolean)
      .join('\n');
  }

  // Share widgets and the print button live in <p> tags inside the same
  // section as the words do.
  var LYRICSMINT_FURNITURE = /share-button|data-controller|data-action|<script|<svg/i;

  /*
   * Both scripts, kept apart. LyricsMint puts the Hinglish and the Devanagari
   * in two tabs of one section, which reads as two runs of stanzas — telling
   * them apart by script is more robust than trying to follow the tab markup.
   */
  function parseLyricsMint(html) {
    var empty = { romanized: '', devanagari: '' };
    var section = String(html == null ? '' : html)
      .match(/<section[^>]*id=["']lyrics["'][^>]*>([\s\S]*?)<\/section>/i);
    if (!section) return empty;

    var blocks = section[1].match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || [];
    var roman = [];
    var devanagari = [];
    var t = root.YTMLTranslit;

    blocks.forEach(function (block) {
      if (LYRICSMINT_FURNITURE.test(block)) return;
      var text = stanzaText(block);
      if (!text) return;
      if (t && t.hasDevanagari(text)) devanagari.push(text);
      else roman.push(text);
    });

    return {
      romanized: roman.join('\n\n'),
      devanagari: devanagari.join('\n\n')
    };
  }

  /*
   * The page's own title, used to confirm the guessed slug landed on the right
   * song. "ODHANI LYRICS (ओढ़नी) - Made in China | Neha Kakkar, Darshan Raval"
   * becomes something titleOverlap can be pointed at.
   */
  function lyricsMintPageTitle(html) {
    var found = String(html == null ? '' : html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!found) return '';
    return collapse(htmlToText(found[1]).replace(/\blyrics\b/gi, ' '));
  }

  /*
   * How well a fetched page agrees with the song we asked for, scored against
   * every title variant rather than the one we happened to read. A trimmed
   * slug is allowed to find the page; verifying it against the untrimmed title
   * would then throw the right answer away for missing a word it never had.
   */
  function lyricsMintAgreement(song, pageTitle) {
    var best = 0;
    titleSlugVariants(song && song.title).forEach(function (slug) {
      var score = titleOverlap(slug.replace(/-/g, ' '), pageTitle);
      if (score > best) best = score;
    });
    return best;
  }

  function slugify(text) {
    return String(text == null ? '' : text)
      .toLowerCase()
      .replace(/[ऀ-ॿ]+/g, ' ')     // slugs are Latin only
      .replace(/['’‘`]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /*
   * Candidate paths, best guess first. The film is tried before the artist
   * because that is how LyricsMint files soundtrack songs, which is most of
   * what LRCLIB misses.
   */
  var LYRICSMINT_MAX_PATHS = 4;

  /*
   * "Odhani Song" is the song called Odhani; "Swan Song" is not. cleanTitle has
   * to keep both, because getting that wrong corrupts every search. A slug is
   * cheaper: a bad guess is a 404, so it can afford to try the trimmed form too.
   */
  function titleSlugVariants(title) {
    var slugs = [];
    var seen = {};

    function add(text) {
      var slug = slugify(text);
      if (!slug || seen[slug]) return;
      seen[slug] = true;
      slugs.push(slug);
    }

    add(title);
    add(String(title == null ? '' : title).replace(/\s+(?:song|lyrics|video|audio)\s*$/i, ''));
    return slugs;
  }

  function lyricsMintPaths(song) {
    song = song || {};
    var titles = titleSlugVariants(song.title);
    if (!titles.length) return [];

    var owners = [song.source, song.album, song.artist]
      .map(slugify)
      .filter(Boolean);

    var paths = [];
    var seen = {};

    // Title variant is the outer loop: the name we actually read is a better
    // bet under any owner than a trimmed guess under the likeliest one.
    titles.forEach(function (title) {
      owners.forEach(function (owner) {
        var path = owner + '/' + title;
        if (seen[path] || paths.length >= LYRICSMINT_MAX_PATHS) return;
        seen[path] = true;
        paths.push(path);
      });
    });

    return paths;
  }

  /* -------------------------------------------------------------- lrclib */

  /*
   * The song as every lyrics lookup wants it: title stripped of label junk,
   * a single artist, and Devanagari romanized when the user asked for that.
   * Both the tab panel (which gets pre-cleaned values through the URL) and the
   * side panel (which gets raw player-bar text) run through this, so the two
   * always search for exactly the same thing.
   */
  function normalizeSong(song, settings) {
    var s = settings || DEFAULTS;
    song = song || {};

    var titlePair = scriptPair(cleanTitle(song.title), s.romanizeQuery);
    var artistPair = scriptPair(cleanArtist(song.artist), s.romanizeQuery);

    // A song that reached us through the panel URL has already been romanized,
    // so the Devanagari is only still available on the untouched raw title.
    if (!titlePair.alt && song.rawTitle) {
      var rawPair = scriptPair(cleanTitle(song.rawTitle), s.romanizeQuery);
      if (rawPair.alt) titlePair.alt = rawPair.alt;
    }

    return {
      title: titlePair.main,
      artist: artistPair.main,
      // The same two fields spelled in the other script, blank when there is
      // no other script to spell them in.
      altTitle: titlePair.alt,
      altArtist: artistPair.alt,
      album: romanizeIfNeeded(collapse(song.album), s.romanizeQuery),
      source: collapse(song.source) ||
              extractSource(song.rawTitle || song.title) ||
              creditedSource(song.rawTitle || song.title),
      rawTitle: collapse(song.rawTitle || song.title),
      duration: durationParam(song),
      resolvedBy: collapse(song.resolvedBy)
    };
  }

  function matchKey(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  /*
   * The ladder of LRCLIB lookups, narrowest first: the first query that returns
   * anything usable wins, so an exact hit is never displaced by a loose title
   * search. Each entry is { path, single } — `single` marks /api/get, which
   * answers with one object instead of a list and 404s when it has no match.
   *
   * Most "this song is not on LRCLIB" turns out to be "our one query missed
   * it", which is what the alternate script, the album and the film name are
   * all here to catch.
   */
  function lrclibQueries(song) {
    song = song || {};

    var title = collapse(song.title);
    var artist = collapse(song.artist);
    var altTitle = collapse(song.altTitle);
    var altArtist = collapse(song.altArtist) || artist;
    var source = collapse(song.source);
    var album = collapse(song.album) || source;
    var duration = durationParam(song);

    var queries = [];
    var seen = {};

    // Skips itself if any field is blank, so the callers below stay readable.
    function query(endpoint, fields, single) {
      var parts = [];
      for (var i = 0; i < fields.length; i += 2) {
        if (!fields[i + 1]) return;
        parts.push(fields[i] + '=' + encodeURIComponent(fields[i + 1]));
      }
      var path = endpoint + '?' + parts.join('&');
      if (!parts.length || seen[path]) return;
      seen[path] = true;
      queries.push({ path: path, single: !!single });
    }

    /*
     * /api/get is an exact lookup and only answers when the duration matches
     * within a couple of seconds, so a hit here is the recording that is
     * actually playing rather than a cover, a remix or a sped-up edit. This is
     * the only reason the content script bothers to read a duration at all.
     */
    query('get', ['track_name', title, 'artist_name', artist, 'album_name', album, 'duration', duration], true);
    query('get', ['track_name', title, 'artist_name', artist, 'duration', duration], true);
    query('get', ['track_name', altTitle, 'artist_name', altArtist, 'duration', duration], true);

    /*
     * Structured search. The album gets exactly one attempt — for a film song
     * it is usually the movie, which is how LRCLIB files most Bollywood
     * tracks — but it is also the field most likely to be wrong, so it never
     * gets the last word.
     */
    query('search', ['track_name', title, 'artist_name', artist, 'album_name', album]);
    query('search', ['track_name', title, 'artist_name', artist]);
    query('search', ['track_name', altTitle, 'artist_name', altArtist]);

    // LRCLIB's own fuzzy matching, in both scripts.
    if (title) query('search', ['q', collapse(title + ' ' + artist)]);
    if (altTitle) query('search', ['q', collapse(altTitle + ' ' + altArtist)]);

    // The film instead of the artist: YouTube Music often credits a label or
    // the composer where LRCLIB filed the singer, and the movie name is the
    // one term both of them agree on.
    if (title && source) query('search', ['q', collapse(title + ' ' + source)]);

    // Title alone, last. Widest net, most likely to land on the wrong
    // recording, which is then the ranker's problem.
    query('search', ['track_name', title]);
    query('search', ['track_name', altTitle]);

    return queries;
  }

  function scoreLrclibResult(item, song) {
    var score = 0;
    var wantTitle = matchKey(song && song.title);
    var wantArtist = matchKey(song && song.artist);
    var gotTitle = matchKey(item.trackName || item.name);
    var gotArtist = matchKey(item.artistName);

    if (gotTitle && wantTitle) {
      if (gotTitle === wantTitle) score += 6;
      else if (gotTitle.indexOf(wantTitle) >= 0 || wantTitle.indexOf(gotTitle) >= 0) score += 3;
    }
    if (gotArtist && wantArtist) {
      if (gotArtist === wantArtist) score += 4;
      else if (gotArtist.indexOf(wantArtist) >= 0 || wantArtist.indexOf(gotArtist) >= 0) score += 2;
    }
    // A search hit that runs to the same length is almost always the same
    // recording; one that is minutes off is a different edit of the song.
    var wantSeconds = Math.round(Number(song && song.duration));
    var gotSeconds = Math.round(Number(item && item.duration));
    if (wantSeconds > 0 && gotSeconds > 0) {
      var drift = Math.abs(wantSeconds - gotSeconds);
      if (drift <= 2) score += 3;
      else if (drift <= 6) score += 1;
      else if (drift > 20) score -= 3;
    }

    if (item.plainLyrics) score += 2;
    if (item.syncedLyrics) score += 1;
    if (item.instrumental) score -= 8;
    return score;
  }

  // LRCLIB stores either plain text or an LRC file; strip the timestamps so
  // both render the same way.
  function plainLyricsOf(item) {
    if (!item) return '';
    if (item.plainLyrics) return item.plainLyrics;
    if (item.syncedLyrics) {
      return item.syncedLyrics
        .split('\n')
        .map(function (line) {
          return line.replace(/^\s*(?:\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]\s*)+/, '');
        })
        .filter(function (line) { return line.trim(); })
        .join('\n');
    }
    return '';
  }

  /* -------------------------------------------------------- synced lyrics */

  /*
   * A good share of LRCLIB's catalogue carries an LRC file next to the plain
   * text: the same words with a timestamp in front of each line, which is all
   * it takes to follow the song rather than read ahead of it.
   *
   *   [ti:Kesariya]          metadata, ignored except for offset
   *   [offset:+200]          milliseconds, + means show the words sooner
   *   [00:12.34]first line
   *   [00:15.00][02:04.10]a line that comes round twice
   *   [00:18.00]             a timed blank: the gap between two stanzas
   *
   * Timestamps are minutes:seconds with an optional fraction, so an alphabetic
   * key is what tells a metadata tag apart from a time. Everything is parsed
   * defensively — a file this can only half read still highlights the lines it
   * understood, and one it cannot read at all falls back to plain text.
   */

  // Written out at each use rather than shared: a /g regex carries its own
  // lastIndex, and one of these is read with .match and another with .replace.
  var LRC_STAMP = '\\[(\\d{1,3}):(\\d{1,2}(?:[.:]\\d{1,3})?)\\]';
  var LRC_META = /^\[([a-z]{2,})\s*:\s*([^\]]*)\]$/i;

  /*
   * Whitespace only. collapse() also eats a leading dash and a trailing comma,
   * which is right for a title and wrong for both a line of a song and a
   * negative offset — "- and then she said," is what was written.
   */
  function tidy(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  function lrcTime(stamp) {
    var parts = String(stamp).match(new RegExp(LRC_STAMP));
    if (!parts) return null;
    var pieces = parts[2].split(/[.:]/);
    var whole = Number(pieces[0]);
    // ".5", ".34" and ".340" all mean the same fraction of a second.
    var fraction = pieces.length > 1 ? Number('0.' + pieces[1]) : 0;
    if (!isFinite(whole) || !isFinite(fraction)) return null;
    return Number(parts[1]) * 60 + whole + fraction;
  }

  /*
   * An LRC file as { time, text } in playing order. A line that carries two
   * timestamps becomes two entries — that is how a chorus is written — and a
   * timed line with no words is kept, because it is what moves the highlight
   * off the last line of a verse during the interlude.
   */
  function parseLrc(text) {
    if (!text || typeof text !== 'string') return [];

    var lines = [];
    var offset = 0;
    var words = 0;

    text.split(/\r?\n/).forEach(function (raw) {
      var meta = tidy(raw).match(LRC_META);
      if (meta) {
        if (meta[1].toLowerCase() === 'offset') {
          var ms = Number(tidy(meta[2]));
          // Positive offset means the words are wanted sooner.
          if (isFinite(ms)) offset = ms / 1000;
        }
        return;
      }

      var stamps = raw.match(new RegExp(LRC_STAMP, 'g'));
      if (!stamps) return;

      var said = tidy(raw
        .replace(new RegExp(LRC_STAMP, 'g'), ' ')
        // Enhanced LRC times individual words. Nothing here uses word timing,
        // but the tags must not reach the screen.
        .replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, ' '));
      if (said) words++;

      stamps.forEach(function (stamp) {
        var at = lrcTime(stamp);
        if (at === null) return;
        lines.push({ time: Math.max(0, at - offset), text: said });
      });
    });

    // Timestamps and nothing else is an instrumental, not a lyric.
    if (!words) return [];

    return lines.sort(function (a, b) { return a.time - b.time; });
  }

  /*
   * The line that should be lit at `time`: the last one that has started.
   * Binary search because this runs several times a second.
   */
  function activeLineIndex(lines, time) {
    if (!Array.isArray(lines) || !lines.length) return -1;
    var at = Number(time);
    if (!isFinite(at)) return -1;

    var low = 0;
    var high = lines.length - 1;
    var found = -1;
    while (low <= high) {
      var mid = (low + high) >> 1;
      if (lines[mid].time <= at) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  // The LRC an entry carries, or '' — including for the entries that come from
  // somewhere other than LRCLIB, which never have one.
  function syncedLyricsOf(item) {
    if (!item || item.instrumental) return '';
    var text = item.syncedLyrics;
    return typeof text === 'string' && /\[\d/.test(text) ? text : '';
  }

  function rankLrclibResults(results, song) {
    if (!Array.isArray(results)) return [];
    return results
      .map(function (item) {
        return {
          item: item,
          score: scoreLrclibResult(item, song),
          text: plainLyricsOf(item),
          synced: syncedLyricsOf(item)
        };
      })
      .filter(function (entry) { return entry.text; })
      .sort(function (a, b) { return b.score - a.score; });
  }

  function songKey(song) {
    return matchKey(song && song.title) + '|' + matchKey(song && song.artist);
  }

  /* ----------------------------------------------------------------- pins */

  // The worker writes these and the panel watches them go by, so the prefix
  // cannot live in either one.
  var PIN_PREFIX = 'ytml.pin.';
  var PIN_MAX_RECORDS = 4;
  var PIN_DURATION_TOLERANCE = 2;

  /*
   * songKey strips everything outside [a-z0-9], which is enough for a key that
   * only has to hold for the length of a cache entry — a Devanagari title with
   * romanizeQuery off collapses to '' and searchLyrics skips the cache rather
   * than trusting it. A pin outlives the session and has nothing else to tell
   * songs apart by, so the same collapse would file every one of them together.
   *
   * This keeps letters in any script, and romanizes whatever the setting says,
   * so that turning romanizeQuery off cannot orphan what is already saved.
   */
  function pinToken(text) {
    return romanizeIfNeeded(String(text == null ? '' : text), true)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '');
  }

  function pinKey(song) {
    return pinToken(song && song.title) + '|' + pinToken(song && song.artist);
  }

  /*
   * Which saved record belongs to what is playing, if any. An offset is
   * measured against one recording, so a runtime disagreeing by more than a
   * couple of seconds is a different cut — a live take, a remix, a sped-up
   * re-upload — and must not inherit it. The tolerance is the one LRCLIB
   * matches its own durations on.
   *
   * The player reports a runtime a beat after the title, so '' arrives first.
   * A single record under the key is unambiguous and worth using right away;
   * more than one is not, and the panel re-searches once the duration lands.
   */
  function pinRecordFor(records, duration) {
    var list = Array.isArray(records) ? records : [];
    var seconds = Math.round(Number(duration));

    if (!isFinite(seconds) || seconds <= 0) {
      return list.length === 1 ? list[0] : null;
    }
    for (var i = 0; i < list.length; i++) {
      if (Math.abs(Number(list[i].dur) - seconds) <= PIN_DURATION_TOLERANCE) {
        return list[i];
      }
    }
    return null;
  }

  /*
   * Newest first, so eviction is a truncation. A record at the same runtime is
   * replaced rather than added: re-pinning a song already pinned is the common
   * case and must not fill the list with near-duplicates. A record arriving
   * without a runtime replaces nothing, because there is no way to tell which
   * of the existing ones it supersedes.
   */
  function pinRecordsWith(records, record) {
    var list = Array.isArray(records) ? records : [];
    var seconds = Math.round(Number(record && record.dur));
    var known = isFinite(seconds) && seconds > 0;

    var kept = list.filter(function (existing) {
      if (!known) return true;
      return Math.abs(Number(existing.dur) - seconds) > PIN_DURATION_TOLERANCE;
    });
    return [record].concat(kept).slice(0, PIN_MAX_RECORDS);
  }

  /* -------------------------------------------------------------- offsets */

  var OFFSET_STEP = 0.25;
  var OFFSET_STEP_LARGE = 1;
  /*
   * A minute, because the case that needs the room is not a mistimed lyric file
   * but a padded upload — a label bumper, a spoken intro, applause before a
   * live take. The words are right and the whole file is simply late. Beyond a
   * minute it really is the wrong recording, and the fix is a different match
   * rather than a bigger number.
   */
  var OFFSET_LIMIT = 60;

  /*
   * One definition of which way an offset points, because the two call sites
   * push opposite ways and getting it backwards fails silently. A positive
   * offset delays the words: the line written at T lights when the song reaches
   * T+off, so the lookup runs against at-off, and clicking that line has to
   * send the player to T+off rather than T.
   */
  function shiftedPosition(at, off) {
    return Number(at) - (Number(off) || 0);
  }

  function shiftedSeek(time, off) {
    return Math.max(0, Number(time) + (Number(off) || 0));
  }

  function clampOffset(off) {
    var value = Number(off);
    if (!isFinite(value)) return 0;

    var snapped = Math.round(value / OFFSET_STEP) * OFFSET_STEP;
    var limited = Math.max(-OFFSET_LIMIT, Math.min(OFFSET_LIMIT, snapped));
    // Quarters are exact in binary; dividing and multiplying by one is not.
    return Math.round(limited * 100) / 100;
  }

  // Signed, and trimmed of the zeros a fixed number of decimals would add:
  // '0s', '+0.25s', '−1.5s'.
  function formatOffset(off) {
    var value = clampOffset(off);
    if (!value) return '0s';
    return (value < 0 ? '−' : '+') + Math.abs(value) + 's';
  }

  function getSettings() {
    return new Promise(function (resolve) {
      if (!root.chrome || !chrome.storage || !chrome.storage.sync) {
        resolve(Object.assign({}, DEFAULTS));
        return;
      }
      // A page that outlived its extension still has chrome.storage.sync on it;
      // calling it is what throws. Fall back to the defaults rather than
      // leaving every caller awaiting a promise that will never settle.
      try {
        chrome.storage.sync.get(DEFAULTS, function (stored) {
          void chrome.runtime.lastError;
          resolve(Object.assign({}, DEFAULTS, stored || {}));
        });
      } catch (e) {
        resolve(Object.assign({}, DEFAULTS));
      }
    });
  }

  function saveSettings(patch) {
    return new Promise(function (resolve) {
      chrome.storage.sync.set(patch, resolve);
    });
  }

  function describeSong(song) {
    if (!song || !song.title) return '';
    var artist = cleanArtist(song.artist);
    return artist ? cleanTitle(song.title) + ' — ' + artist : cleanTitle(song.title);
  }

  root.YTML = {
    DEFAULTS: DEFAULTS,
    PROVIDERS: PROVIDERS,
    collapse: collapse,
    cleanTitle: cleanTitle,
    cleanArtist: cleanArtist,
    extractSource: extractSource,
    splitTitleCredits: splitTitleCredits,
    creditedSource: creditedSource,
    isNoiseByline: isNoiseByline,
    scriptPair: scriptPair,
    durationParam: durationParam,
    buildQuery: buildQuery,
    providerUrl: providerUrl,
    isLabelArtist: isLabelArtist,
    titleOverlap: titleOverlap,
    looksUnreliable: looksUnreliable,
    itunesTerm: itunesTerm,
    itunesSeconds: itunesSeconds,
    scoreItunesCandidate: scoreItunesCandidate,
    pickItunesMatch: pickItunesMatch,
    applyItunesMatch: applyItunesMatch,
    htmlToText: htmlToText,
    slugify: slugify,
    parseLyricsMint: parseLyricsMint,
    lyricsMintPageTitle: lyricsMintPageTitle,
    lyricsMintPaths: lyricsMintPaths,
    lyricsMintAgreement: lyricsMintAgreement,
    normalizeSong: normalizeSong,
    lrclibQueries: lrclibQueries,
    scoreLrclibResult: scoreLrclibResult,
    plainLyricsOf: plainLyricsOf,
    syncedLyricsOf: syncedLyricsOf,
    parseLrc: parseLrc,
    activeLineIndex: activeLineIndex,
    rankLrclibResults: rankLrclibResults,
    songKey: songKey,
    PIN_PREFIX: PIN_PREFIX,
    PIN_MAX_RECORDS: PIN_MAX_RECORDS,
    PIN_DURATION_TOLERANCE: PIN_DURATION_TOLERANCE,
    pinKey: pinKey,
    pinRecordFor: pinRecordFor,
    pinRecordsWith: pinRecordsWith,
    OFFSET_STEP: OFFSET_STEP,
    OFFSET_STEP_LARGE: OFFSET_STEP_LARGE,
    OFFSET_LIMIT: OFFSET_LIMIT,
    shiftedPosition: shiftedPosition,
    shiftedSeek: shiftedSeek,
    clampOffset: clampOffset,
    formatOffset: formatOffset,
    getSettings: getSettings,
    saveSettings: saveSettings,
    describeSong: describeSong
  };
})(typeof self !== 'undefined' ? self : this);
