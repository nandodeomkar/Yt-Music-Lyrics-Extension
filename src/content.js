/*
 * Runs on music.youtube.com.
 *  - Detects the current track through several independent strategies, so a
 *    YouTube Music layout change cannot take detection out entirely.
 *  - Adds a "Lyrics" button to the player bar (click = default provider,
 *    Shift+click = fallback provider).
 *  - Romanizes the built-in lyrics panel when it shows Devanagari.
 */
(function () {
  'use strict';

  var YTML = self.YTML;
  var Translit = self.YTMLTranslit;

  var settings = Object.assign({}, YTML.DEFAULTS);
  var romanized = false;
  var originals = new WeakMap();
  var lastSongKey = '';
  var lastSong = null;

  /* --------------------------------------------------- context lifetime */

  /*
   * Reloading the extension leaves this script running in a page that no
   * longer has an extension behind it. Every chrome.* call then throws or
   * rejects, and the two-second tick turns that into a stream of "Extension
   * context invalidated" errors — while the buttons sit in the player bar
   * looking alive and doing nothing when clicked.
   *
   * So the orphan shuts itself down: timers stopped, observer disconnected,
   * buttons removed. Reloading the page brings back a live copy.
   */
  var tickTimer = null;
  var observer = null;
  var shuttingDown = false;

  function contextAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function shutDown() {
    if (shuttingDown) return;
    shuttingDown = true;

    if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null; }
    if (observer) { observer.disconnect(); observer = null; }

    syncUntil = 0;
    unwatchVideo();
    removeWraps();
    console.log('[ytml] this page outlived its extension — buttons removed. ' +
                'Reload music.youtube.com to get a live copy.');
  }

  /*
   * Always with a callback: a callback-less sendMessage returns a promise, and
   * a promise rejected by a dead context is an unhandled rejection no
   * try/catch around the call can reach.
   */
  function sendQuietly(message, onReply) {
    if (!contextAlive()) {
      shutDown();
      if (onReply) onReply(null);
      return;
    }
    try {
      chrome.runtime.sendMessage(message, function (response) {
        void chrome.runtime.lastError;
        if (onReply) onReply(response || null);
      });
    } catch (e) {
      shutDown();
      if (onReply) onReply(null);
    }
  }

  /* ------------------------------------------------------------- helpers */

  function clean(text) {
    return YTML.collapse(text);
  }

  function textOf(el) {
    if (!el) return '';
    var attr = el.getAttribute && (el.getAttribute('title') || el.getAttribute('aria-label'));
    return clean(attr || el.textContent);
  }

  function firstText(selectors, root) {
    root = root || document;
    for (var i = 0; i < selectors.length; i++) {
      var node = null;
      try { node = root.querySelector(selectors[i]); } catch (e) { continue; }
      var text = textOf(node);
      if (text) return text;
    }
    return '';
  }

  /*
   * Shadow-piercing search. YouTube normally runs with shady DOM, where plain
   * querySelector is enough, but a build that uses real shadow roots would
   * hide the player bar completely. This walks open shadow roots as a
   * fallback; it is only called when the cheap selectors come up empty, and
   * the host it finds is cached.
   */
  var deepCache = {};

  function deepQuery(selector) {
    var cached = deepCache[selector];
    if (cached && cached.isConnected) return cached;

    var queue = [document];
    var budget = 6000;

    while (queue.length && budget > 0) {
      var root = queue.shift();
      var hit = null;
      try { hit = root.querySelector(selector); } catch (e) { /* ignore */ }
      if (hit) {
        deepCache[selector] = hit;
        return hit;
      }
      var all = [];
      try { all = root.querySelectorAll('*'); } catch (e) { /* ignore */ }
      for (var i = 0; i < all.length && budget > 0; i++, budget--) {
        if (all[i].shadowRoot) queue.push(all[i].shadowRoot);
      }
    }
    return null;
  }

  function splitByline(text) {
    return String(text || '')
      .split(/\s*[•·|]\s*/)
      .map(clean)
      .filter(function (part) { return part && !YTML.isNoiseByline(part); });
  }

  function bylineFrom(root) {
    if (!root) return { artist: '', album: '' };

    var byline = null;
    var selectors = [
      '.byline.ytmusic-player-bar',
      'yt-formatted-string.byline',
      '.subtitle .byline',
      '.byline',
      '.subtitle',
      '.second-line',
      '.secondary-text'
    ];
    for (var i = 0; i < selectors.length && !byline; i++) {
      try { byline = root.querySelector(selectors[i]); } catch (e) { /* ignore */ }
    }
    if (!byline) return { artist: '', album: '' };

    var parts = Array.prototype.map.call(byline.querySelectorAll('a'), function (a) {
      return clean(a.textContent);
    }).filter(Boolean).filter(function (p) { return !YTML.isNoiseByline(p); });

    if (!parts.length) parts = splitByline(textOf(byline));

    return { artist: parts[0] || '', album: parts[1] || '' };
  }

  /* ---------------------------------------------------------- strategies */

  var TITLE_SELECTORS = [
    '.title.ytmusic-player-bar',
    'yt-formatted-string.title',
    '.content-info-wrapper .title',
    '.content-info-wrapper yt-formatted-string',
    '.middle-controls .title',
    '[class*="title"]'
  ];

  function playerBarRoot(allowDeep) {
    var bar = document.querySelector('ytmusic-player-bar') ||
              document.querySelector('ytmusic-app-layout ytmusic-player-bar') ||
              document.querySelector('[class*="player-bar"]');
    if (bar) return bar;
    return allowDeep ? deepQuery('ytmusic-player-bar') : null;
  }

  function fromPlayerBar(allowDeep) {
    var bar = playerBarRoot(allowDeep);
    if (!bar) return null;
    var title = firstText(TITLE_SELECTORS, bar);
    if (!title) return null;
    var by = bylineFrom(bar);
    return { title: title, artist: by.artist, album: by.album };
  }

  // The expanded "now playing" screen.
  function fromPlayerPage() {
    var page = document.querySelector('ytmusic-player-page') || deepQuery('ytmusic-player-page');
    if (!page) return null;
    var title = firstText([
      '.title.ytmusic-player-page',
      '.content-info-wrapper .title',
      'yt-formatted-string.title'
    ], page);
    if (!title) return null;
    var by = bylineFrom(page);
    return { title: title, artist: by.artist, album: by.album };
  }

  // The highlighted row in the queue is the track that is playing.
  function fromQueue() {
    var item = document.querySelector('ytmusic-player-queue-item[selected]') ||
               document.querySelector('ytmusic-player-queue-item[play-button-state="playing"]') ||
               document.querySelector('ytmusic-player-queue-item[play-button-state="paused"]');
    if (!item) return null;
    var title = firstText(['.song-title', '.title', 'yt-formatted-string'], item);
    if (!title) return null;
    var by = bylineFrom(item);
    if (!by.artist) {
      var parts = splitByline(firstText(['.byline', '.subtitle'], item));
      by.artist = parts[0] || '';
      by.album = parts[1] || '';
    }
    return { title: title, artist: by.artist, album: by.album };
  }

  function fromMediaSession() {
    try {
      var meta = navigator.mediaSession && navigator.mediaSession.metadata;
      if (!meta) return null;
      var title = clean(meta.title);
      if (!title) return null;
      return {
        title: title,
        artist: clean(meta.artist).replace(/\s*-\s*Topic$/i, ''),
        album: clean(meta.album)
      };
    } catch (e) {
      return null;
    }
  }

  // "Song — Artist - YouTube Music" and friends.
  function fromDocumentTitle() {
    var raw = clean(document.title)
      .replace(/\s*[-–—|]\s*YouTube Music\s*$/i, '')
      .replace(/\s*YouTube Music\s*$/i, '')
      .replace(/^\(\d+\)\s*/, '');
    if (!raw || /^youtube music$/i.test(raw)) return null;

    var parts = raw.split(/\s+[-–—]\s+/).map(clean).filter(Boolean);
    if (!parts.length) return null;
    return { title: parts[0], artist: parts[1] || '', album: '' };
  }

  /* --------------------------------------------------- MAIN world bridge */

  var bridgeSeq = 0;
  var bridgePending = {};

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.type !== 'ytml-page-response') return;
    var resolve = bridgePending[msg.nonce];
    if (!resolve) return;
    delete bridgePending[msg.nonce];
    resolve(msg);
  });

  // `request` carries an action for the page world; omitting it asks for the
  // metadata read the bridge has always answered.
  function askPage(request) {
    return new Promise(function (resolve) {
      var nonce = 'ytml-' + (++bridgeSeq) + '-' + bridgeSeq;
      var done = false;

      bridgePending[nonce] = function (msg) {
        if (done) return;
        done = true;
        resolve(msg);
      };

      setTimeout(function () {
        if (done) return;
        done = true;
        delete bridgePending[nonce];
        resolve(null);
      }, 500);

      try {
        window.postMessage(
          Object.assign({ type: 'ytml-page-request', nonce: nonce }, request || {}),
          location.origin
        );
      } catch (e) {
        // resolved by the timeout above
      }
    });
  }

  function normalizeBridge(part) {
    if (!part || !clean(part.title)) return null;
    return {
      title: clean(part.title),
      artist: clean(part.artist),
      album: clean(part.album),
      videoId: clean(part.videoId),
      duration: seconds(part.duration)
    };
  }

  /* ------------------------------------------------------------ duration */

  function seconds(value) {
    var n = Math.round(Number(value));
    return isFinite(n) && n > 0 ? n : 0;
  }

  /*
   * LRCLIB's exact lookup needs a track length. The <video> element lives in
   * the page's own DOM, which the isolated world can read even though the
   * player's JS API is out of reach, so this works without the bridge and
   * without waiting for it.
   */
  function durationFromVideo() {
    var videos = document.querySelectorAll('#movie_player video, video');
    for (var i = 0; i < videos.length; i++) {
      var found = seconds(videos[i].duration);
      if (found) return found;
    }
    return 0;
  }

  /* ------------------------------------------------------------ position */

  /*
   * Synced lyrics need to know where in the song we are, and the same <video>
   * element is where that lives too.
   *
   * The panel is handed a clock rather than a stream. timeupdate fires four
   * times a second and every message from here wakes the service worker, so
   * sending each one would spend a wake-up on a number the panel can work out
   * for itself: it gets one sample a second while the track plays, plus one
   * the instant something happens a clock cannot predict — a play, a pause, a
   * seek, a speed change — and interpolates between them.
   *
   * And only while somebody is listening. The panel renews a lease that
   * expires on its own, so a closed panel costs nothing and a panel the
   * browser destroyed without warning cannot leave this running.
   */
  var SYNC_LEASE = 12000;
  var SYNC_BEAT = 1000;
  var VIDEO_EVENTS = ['timeupdate', 'play', 'pause', 'seeked', 'ratechange', 'ended'];

  var syncUntil = 0;
  var watchedVideo = null;
  var lastBeat = 0;

  function currentVideo() {
    var video = document.querySelector('#movie_player video') ||
                document.querySelector('video');
    return video && video.isConnected ? video : null;
  }

  function unwatchVideo() {
    if (!watchedVideo) return;
    VIDEO_EVENTS.forEach(function (name) {
      watchedVideo.removeEventListener(name, onVideoEvent);
    });
    watchedVideo = null;
  }

  // YouTube Music reuses one <video> across the whole queue, but a layout
  // change that swaps it must not take the position with it.
  function watchVideo() {
    var video = currentVideo();
    if (!video || video === watchedVideo) return;
    unwatchVideo();
    watchedVideo = video;
    VIDEO_EVENTS.forEach(function (name) {
      video.addEventListener(name, onVideoEvent);
    });
  }

  function onVideoEvent(event) {
    // Everything except the metronome is news the panel cannot guess.
    publishPosition(event.type !== 'timeupdate');
  }

  function publishPosition(force) {
    if (Date.now() > syncUntil) return;

    var video = (watchedVideo && watchedVideo.isConnected) ? watchedVideo : currentVideo();
    if (!video) return;

    var at = Date.now();
    var time = Number(video.currentTime);
    if (!isFinite(time)) return;
    if (!force && at - lastBeat < SYNC_BEAT) return;
    lastBeat = at;

    sendQuietly({
      type: 'player-position',
      // Carried so a lyrics tab pinned to one song can tell whether the
      // position it is hearing about is even its own song's.
      song: lastSong,
      position: {
        time: time,
        at: at,
        paused: !!video.paused,
        rate: Number(video.playbackRate) || 1,
        duration: seconds(video.duration)
      }
    });
  }

  /*
   * Clicking a lyric line lands here. The player's own seekTo() is tried
   * first — it keeps the progress bar and the buffering in step — and writing
   * currentTime is the fallback for a page where the bridge never loaded.
   */
  async function seekTo(time) {
    var target = Number(time);
    if (!isFinite(target) || target < 0) return false;

    var answer = await askPage({ action: 'seek', time: target });
    if (answer && answer.seeked) {
      publishPosition(true);
      return true;
    }

    var video = (watchedVideo && watchedVideo.isConnected) ? watchedVideo : currentVideo();
    if (!video) return false;
    try {
      var end = Number(video.duration);
      video.currentTime = isFinite(end) && end > 0 ? Math.min(target, end) : target;
    } catch (e) {
      return false;
    }
    publishPosition(true);
    return true;
  }

  /* ------------------------------------------------------------- detect */

  // Ordered best-first. Earlier entries win on title; later ones fill in any
  // field the winner left blank.
  async function collectCandidates() {
    var page = await askPage();

    return [
      { name: 'player-bar', song: fromPlayerBar(false) },
      { name: 'media-session', song: fromMediaSession() },
      { name: 'page-media-session', song: page ? normalizeBridge(page.mediaSession) : null },
      { name: 'page-player-api', song: page ? normalizeBridge(page.playerApi) : null },
      { name: 'player-page', song: fromPlayerPage() },
      { name: 'queue', song: fromQueue() },
      { name: 'player-bar-deep', song: fromPlayerBar(true) },
      { name: 'document-title', song: fromDocumentTitle() }
    ];
  }

  function mergeCandidates(candidates) {
    var winner = null;
    var detectedBy = '';

    for (var i = 0; i < candidates.length; i++) {
      var song = candidates[i].song;
      if (!song || !song.title) continue;
      if (!winner) {
        winner = Object.assign({}, song);
        detectedBy = candidates[i].name;
        continue;
      }
      if (!winner.artist && song.artist) winner.artist = song.artist;
      if (!winner.album && song.album) winner.album = song.album;
      if (!winner.videoId && song.videoId) winner.videoId = song.videoId;
      if (!winner.duration && song.duration) winner.duration = song.duration;
    }

    if (!winner) return null;

    winner.rawTitle = winner.title;
    winner.source = YTML.extractSource(winner.title) || winner.album || '';
    winner.duration = winner.duration || durationFromVideo();
    winner.detectedBy = detectedBy;
    winner.url = location.href;
    return winner;
  }

  async function detectSong() {
    lastSong = mergeCandidates(await collectCandidates());
    return lastSong;
  }

  /* --------------------------------------------------------------- open */

  async function openLyrics(useFallback) {
    var song = await detectSong();
    var provider = useFallback ? settings.fallbackProvider : settings.provider;

    return new Promise(function (resolve) {
      sendQuietly({ type: 'open-lyrics', song: song, provider: provider }, function (response) {
        // The one place a user can see nothing happen and have no idea why,
        // so say it out loud on the page's own console.
        console.log('[ytml] open-lyrics', {
          provider: provider,
          song: song && song.title,
          detectedBy: song && song.detectedBy,
          openedIn: response && response.where,
          orphaned: !contextAlive()
        });
        resolve(response);
      });
    });
  }

  /* ----------------------------------------------------------- romanize */

  // The lyrics shelf is the safe target. #tab-renderer also holds the queue
  // and related tabs, so only fall back to it when the Lyrics tab is the one
  // on screen — otherwise romanizing would rewrite queue song titles too.
  function lyricsTabSelected() {
    var tabs = document.querySelectorAll('ytmusic-player-page tp-yt-paper-tab, tp-yt-paper-tab');
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].getAttribute('aria-selected') === 'true' &&
          /lyric/i.test(tabs[i].textContent || '')) {
        return true;
      }
    }
    return false;
  }

  function lyricsContainers() {
    var found = Array.prototype.slice.call(
      document.querySelectorAll('ytmusic-description-shelf-renderer')
    );
    if (found.length) return found;

    if (lyricsTabSelected()) {
      var tab = document.querySelector('ytmusic-player-page #tab-renderer');
      if (tab) return [tab];
    }
    return [];
  }

  function walkTextNodes(rootNode, fn) {
    var walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        var tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || parent.closest('.ytml-btn')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) fn(node);
  }

  function applyRomanization() {
    var changed = 0;
    lyricsContainers().forEach(function (container) {
      walkTextNodes(container, function (node) {
        if (originals.has(node)) return;
        if (!Translit.hasDevanagari(node.nodeValue)) return;
        originals.set(node, node.nodeValue);
        node.nodeValue = Translit.romanize(node.nodeValue);
        changed++;
      });
    });
    return changed;
  }

  function restoreRomanization() {
    lyricsContainers().forEach(function (container) {
      walkTextNodes(container, function (node) {
        if (!originals.has(node)) return;
        node.nodeValue = originals.get(node);
        originals.delete(node);
      });
    });
  }

  function setRomanized(on) {
    romanized = on;
    if (on) applyRomanization(); else restoreRomanization();
    updateButton();
    return romanized;
  }

  function toggleRomanize() {
    return setRomanized(!romanized);
  }

  function pageHasDevanagariLyrics() {
    return lyricsContainers().some(function (c) {
      return Translit.hasDevanagari(c.textContent || '');
    });
  }

  /* ----------------------------------------------------------- ui parts */

  var button = null;
  var romanizeButton = null;

  /*
   * The player bar toggles the expanded now-playing view on any click that
   * reaches it, so a button living inside it has to swallow the event
   * outright — and on pointerdown/mousedown too, because that is where
   * YouTube Music actually binds the toggle. Without this the button works
   * but the page visibly expands and collapses underneath it.
   */
  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  function makeButton(label, title, handler) {
    var btn = document.createElement('button');
    btn.className = 'ytml-btn';
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title;

    ['pointerdown', 'mousedown', 'mouseup', 'dblclick'].forEach(function (name) {
      btn.addEventListener(name, swallow);
    });
    btn.addEventListener('click', function (e) {
      swallow(e);
      handler(e);
    });
    return btn;
  }

  function updateButton() {
    if (romanizeButton) {
      romanizeButton.textContent = romanized ? 'हिं' : 'अ→a';
      romanizeButton.title = romanized
        ? 'Show the original Devanagari lyrics (Alt+R)'
        : 'Romanize the lyrics shown on this page (Alt+R)';
      romanizeButton.classList.toggle('ytml-btn--on', romanized);
    }
  }

  /*
   * Missing buttons used to be indistinguishable from a broken extension:
   * switched off in Settings, no player bar yet, and orphaned script all look
   * identical from the outside. Said once per reason, not once per tick.
   */
  var mountNote = '';

  function noteOnce(reason) {
    if (mountNote === reason) return;
    mountNote = reason;
    console.log('[ytml] ' + reason);
  }

  function removeWraps() {
    Array.prototype.forEach.call(document.querySelectorAll('.ytml-wrap'), function (node) {
      if (node.parentNode) node.parentNode.removeChild(node);
    });
    button = romanizeButton = null;
  }

  function mountButtons() {
    if (!settings.showPlayerButton) {
      // The buttons live inside a wrapper, so removing them one by one used to
      // leave an empty div behind in the player bar.
      removeWraps();
      noteOnce('player-bar buttons are switched off in Settings');
      return;
    }
    if (button && button.isConnected) return;

    var bar = playerBarRoot(true);
    var host = null;
    if (bar) {
      host = bar.querySelector('.right-controls') ||
             bar.querySelector('.middle-controls') ||
             bar.querySelector('[class*="right-controls"]');
    }
    if (!host) {
      noteOnce(bar
        ? 'player bar found but none of the control rows matched — buttons cannot mount'
        : 'no player bar on the page yet — waiting');
      return;
    }

    var wrap = document.createElement('div');
    wrap.className = 'ytml-wrap';
    wrap.addEventListener('click', function (e) { e.stopPropagation(); });

    button = makeButton('Lyrics', 'Open lyrics for this song (Alt+L, Shift+click for the fallback site)', function (e) {
      var shift = e.shiftKey;
      button.textContent = '…';
      openLyrics(shift).catch(function () { return null; }).then(function () {
        if (button) button.textContent = 'Lyrics';
      });
    });
    romanizeButton = makeButton('अ→a', '', function () { toggleRomanize(); });

    wrap.appendChild(button);
    wrap.appendChild(romanizeButton);
    host.insertBefore(wrap, host.firstChild);
    updateButton();
    noteOnce('player-bar buttons mounted');
  }

  /* ---------------------------------------------------------- lifecycle */

  function onSongChanged(song) {
    romanized = false;
    originals = new WeakMap();
    updateButton();

    // The side panel listens for this so it can re-search without polling.
    // Nothing is expected back; the service worker is always a listener, so
    // this never lands on an empty channel.
    sendQuietly({ type: 'song-changed', song: song || null });
  }

  async function tick() {
    if (!contextAlive()) {
      shutDown();
      return;
    }
    mountButtons();
    if (Date.now() <= syncUntil) watchVideo();

    var song = await detectSong();
    // The duration lands a moment after the title does, and it is what unlocks
    // LRCLIB's exact lookup, so its arrival counts as a change worth one extra
    // broadcast rather than something to wait a whole track for.
    var key = song ? song.title + '|' + song.artist + '|' + (song.duration ? 'd' : '') : '';
    if (key !== lastSongKey) {
      lastSongKey = key;
      onSongChanged(song);
    }

    if (settings.autoRomanize && !romanized && pageHasDevanagariLyrics()) {
      setRomanized(true);
    } else if (romanized) {
      applyRomanization(); // catch newly streamed-in lyric lines
    }
  }

  /*
   * tick() is async and runs from three separate timers, so anything it throws
   * becomes an unhandled rejection with no call site left to catch it. The
   * guard at the top of tick is not enough on its own: detectSong awaits the
   * page bridge for up to half a second, and an extension reload inside that
   * window makes every line after the await throw — which is exactly how a
   * bare "Extension context invalidated" reached the page console instead of
   * the orderly shutdown that was supposed to handle it.
   *
   * Nothing schedules tick directly any more.
   */
  function onTickFailed(error) {
    if (!contextAlive()) {
      shutDown();
      return;
    }
    noteOnce('a detection pass failed and was skipped: ' + (error && error.message));
  }

  function safeTick() {
    var running = null;
    try {
      running = tick();
    } catch (e) {
      onTickFailed(e);
      return;
    }
    if (running && typeof running.catch === 'function') running.catch(onTickFailed);
  }

  function start() {
    var debounce = null;
    observer = new MutationObserver(function () {
      clearTimeout(debounce);
      debounce = setTimeout(safeTick, 300);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('yt-navigate-finish', function () { setTimeout(safeTick, 500); });
    tickTimer = setInterval(safeTick, 2000);
    safeTick();
  }

  /* ---------------------------------------------------------- messaging */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;

    if (msg.type === 'get-song') {
      detectSong().then(function (song) {
        sendResponse({
          song: song,
          romanized: romanized,
          hasDevanagari: pageHasDevanagariLyrics()
        });
      }).catch(function () {
        // Answer anyway: a silent channel makes the caller wait for a timeout.
        sendResponse({ song: null, romanized: romanized, hasDevanagari: false });
      });
      return true;
    }

    if (msg.type === 'diagnose') {
      collectCandidates().then(function (candidates) {
        sendResponse({
          url: location.href,
          documentTitle: document.title,
          playerBarFound: !!playerBarRoot(true),
          lyricsContainers: lyricsContainers().length,
          candidates: candidates.map(function (c) {
            return {
              name: c.name,
              title: c.song ? c.song.title : '',
              artist: c.song ? c.song.artist : '',
              album: c.song ? c.song.album : ''
            };
          }),
          merged: mergeCandidates(candidates)
        });
      }).catch(function (e) {
        sendResponse({ error: String((e && e.message) || e) });
      });
      return true;
    }

    if (msg.type === 'toggle-romanize') {
      sendResponse({ romanized: toggleRomanize() });
      return;
    }

    /*
     * The panel's lease. Answering ok:false is how it learns that the song it
     * is following has no player behind it any more — a tab that navigated
     * away, a page that never had a <video> — so it can stop pretending to
     * know where the song is.
     */
    if (msg.type === 'sync-watch') {
      syncUntil = Date.now() + SYNC_LEASE;
      watchVideo();
      publishPosition(true);
      sendResponse({ ok: !!watchedVideo });
      return;
    }

    if (msg.type === 'seek-to') {
      seekTo(msg.time).then(function (ok) {
        sendResponse({ ok: ok });
      }).catch(function () {
        sendResponse({ ok: false });
      });
      return true;
    }

    if (msg.type === 'open-lyrics-here') {
      openLyrics(!!msg.fallback).catch(function () { /* reported by openLyrics */ });
      return;
    }
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'sync') return;
    Object.keys(changes).forEach(function (k) { settings[k] = changes[k].newValue; });
    mountButtons();
  });

  // If storage is already gone the extension went away before this script
  // finished booting: there is nothing to start and nothing to report.
  YTML.getSettings().then(function (s) {
    settings = s;
    start();
  }).catch(function () {
    shutDown();
  });
})();
