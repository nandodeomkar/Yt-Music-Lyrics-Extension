/*
 * The lyrics panel. One script, two hosts:
 *
 *   sidepanel.html  (data-mode="live")    follows whatever YouTube Music is
 *                                         playing and re-searches on change
 *   lyrics.html     (data-mode="static")  a fixed song passed in the URL
 *
 * Neither one talks to LRCLIB directly — the service worker owns that, so a
 * side panel the browser tore down and rebuilt gets its lyrics back instantly
 * from the worker's cache.
 */
(function () {
  'use strict';

  var YTML = self.YTML;
  var Translit = self.YTMLTranslit;

  var LIVE = document.body.getAttribute('data-mode') === 'live';

  var params = new URLSearchParams(location.search);

  var el = {
    title: document.getElementById('songTitle'),
    meta: document.getElementById('songMeta'),
    status: document.getElementById('status'),
    lyrics: document.getElementById('lyrics'),
    syncBtn: document.getElementById('syncBtn'),
    pinBtn: document.getElementById('pinBtn'),
    offsetBar: document.getElementById('offsetBar'),
    offsetValue: document.getElementById('offsetValue'),
    offsetNext: document.getElementById('offsetNext'),
    offsetDown: document.getElementById('offsetDown'),
    offsetUp: document.getElementById('offsetUp'),
    romanizeBtn: document.getElementById('romanizeBtn'),
    copyBtn: document.getElementById('copyBtn'),
    smaller: document.getElementById('smallerBtn'),
    bigger: document.getElementById('biggerBtn'),
    alternates: document.getElementById('alternates'),
    alternateList: document.getElementById('alternateList'),
    fallbackList: document.getElementById('fallbackList'),
    notice: document.getElementById('notice'),
    sourceNote: document.getElementById('sourceNote'),
    openTab: document.getElementById('openTabBtn')
  };

  var settings = Object.assign({}, YTML.DEFAULTS);
  var song = null;
  var songKey = '';
  var originalLyrics = '';
  var romanized = false;
  // Remembers a manual toggle so it survives the next song, which is what a
  // Hindi listener wants; autoRomanize seeds it.
  var stickyRomanize = null;
  var fontSize = 17;
  var redirectTimer = null;
  var searchToken = 0;

  /* ----------------------------------------------------------------- pins */

  // The song as the worker resolved it — what a pin is filed under. Not the
  // same object as `song`, which is whatever the player bar happened to say.
  var resolved = null;
  var selected = null;        // the entry on screen
  var pin = null;             // the saved record for this song, or null
  var offset = 0;
  var pinFlashTimer = null;
  // A pinned lookup only ever fetched one entry, so the rest have to be asked
  // for separately before "Other matches" can show anything.
  var alternatesLoaded = false;

  /* ---------------------------------------------------------------- sync */

  /*
   * Following the song is a clock, not a stream. The content script sends a
   * position about once a second and whenever something unpredictable happens;
   * between those, the time is read off the local one. Nothing is polled and
   * the YouTube Music tab is woken once every few seconds to renew a lease
   * rather than continuously.
   */
  var HIGHLIGHT_MS = 120;    // how often the lit line is recomputed
  var LEASE_MS = 5000;       // the content script's lease is longer than this
  var STALE_MS = 15000;      // a playing clock nobody has confirmed for this long
  var FOLLOW_PAUSE = 6000;   // hands off the scrollbar for this long after a nudge

  var lrcLines = [];
  var lineNodes = [];
  var activeIndex = -1;
  var syncOn = false;
  // Same idea as stickyRomanize: turning the highlight off for one song should
  // not be undone by the next one starting.
  var stickySync = null;
  var clock = null;
  var highlightTimer = null;
  var leaseTimer = null;
  var scrolledAt = 0;

  /* ------------------------------------------------------------ messaging */

  function ask(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          void chrome.runtime.lastError;
          resolve(response || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /* ------------------------------------------------------------- helpers */

  function setStatus(text) {
    el.status.textContent = text;
    el.status.hidden = !text;
  }

  function clearNotice() {
    clearInterval(redirectTimer);
    redirectTimer = null;
    el.notice.hidden = true;
    el.notice.textContent = '';
  }

  function showNotice(text, actionLabel, onAction) {
    el.notice.textContent = '';
    var span = document.createElement('span');
    span.textContent = text;
    el.notice.appendChild(span);
    if (actionLabel) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = actionLabel;
      btn.addEventListener('click', onAction);
      el.notice.appendChild(btn);
    }
    el.notice.hidden = false;
  }

  function chipLink(label, url, title) {
    var a = document.createElement('a');
    a.className = 'chip';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = label;
    if (title) a.title = title;
    return a;
  }

  function providerLabel(id) {
    var p = YTML.PROVIDERS.filter(function (x) { return x.id === id; })[0];
    return p ? p.label : id;
  }

  // Lyrics no longer only come from LRCLIB, so the credit line has to ask.
  function sourceLabel(entry) {
    var item = (entry && entry.item) || {};
    if (item.provider === 'lyricsmint') return 'LyricsMint';
    return item.id ? 'LRCLIB #' + item.id : '';
  }

  /* --------------------------------------------------------- pin + offset */

  /*
   * Only an LRCLIB entry can be pinned: a pin is an id the worker re-fetches
   * next time, and a LyricsMint result has no id to re-fetch. Those pages are
   * found by guessing a URL from the song, so they will be found again anyway.
   */
  function pinnableId(entry) {
    var id = entry && entry.item && entry.item.id;
    return typeof id === 'number' && isFinite(id) ? id : null;
  }

  function pinAppliesTo(entry) {
    return !!pin && pinnableId(entry) === pin.id;
  }

  /*
   * 'dirty' covers both ways the screen can disagree with what was saved —
   * a different match picked, or the same one nudged — because the button does
   * the same thing in either case: overwrite.
   */
  function pinState() {
    if (!selected || pinnableId(selected) === null) return 'hidden';
    if (!pin) return 'none';
    if (!pinAppliesTo(selected)) return 'dirty';
    return offset === pin.off ? 'saved' : 'dirty';
  }

  var PIN_LABELS = {
    none: ['Pin', 'Remember this match for this song'],
    saved: ['Pinned', 'Saved — press to forget it'],
    dirty: ['Update', 'Save this match and offset instead']
  };

  function paintPin() {
    if (pinFlashTimer !== null) return;    // a message is showing; leave it

    var state = pinState();
    el.pinBtn.hidden = state === 'hidden';
    el.pinBtn.classList.toggle('on', state === 'saved');
    el.pinBtn.classList.toggle('pin--dirty', state === 'dirty');
    if (state === 'hidden') return;

    el.pinBtn.textContent = PIN_LABELS[state][0];
    el.pinBtn.title = PIN_LABELS[state][1];
  }

  function flashPin(text) {
    clearTimeout(pinFlashTimer);
    el.pinBtn.hidden = false;
    el.pinBtn.textContent = text;
    pinFlashTimer = setTimeout(function () {
      pinFlashTimer = null;
      paintPin();
    }, 1600);
  }

  function paintOffset() {
    var on = syncing();
    el.offsetBar.hidden = !on;
    if (!on) return;

    el.offsetValue.textContent = YTML.formatOffset(offset);
    el.offsetValue.classList.toggle('is-set', offset !== 0);
    refreshLineTitles();
  }

  /*
   * Seconds until the next line is due, which is the one number that responds
   * to every press. Which line is lit cannot do that job: lines run seconds
   * apart, so a quarter-second nudge usually leaves the same one lit and looks
   * like nothing happened. This moves by exactly the step, every time.
   *
   * It is also what you are actually matching — when the voice starts the next
   * line, this should be passing zero.
   */
  function paintCountdown(at, shifted, index) {
    if (!el.offsetNext) return;

    if (at === null) {
      el.offsetNext.textContent = 'no position';
      return;
    }

    var next = lrcLines[index + 1];
    if (!next) {
      el.offsetNext.textContent = 'last line';
      return;
    }

    var due = next.time - shifted;
    el.offsetNext.textContent = 'next in ' + (due < 0 ? '0.0' : due.toFixed(1)) + 's';
  }

  // Each line advertises where clicking it lands, which the offset moves.
  function refreshLineTitles() {
    lineNodes.forEach(function (node, index) {
      if (!lrcLines[index] || !lrcLines[index].text) return;
      node.title = 'Jump to ' + timeLabel(YTML.shiftedSeek(lrcLines[index].time, offset));
    });
  }

  /*
   * Nudging repaints the readout and the highlight but not the lines: the click
   * handlers read `offset` when they fire rather than closing over it, so
   * rebuilding them would cost a scroll position for nothing.
   */
  function nudgeOffset(delta) {
    var next = YTML.clampOffset(offset + delta);
    if (next === offset) return;
    offset = next;
    // A deliberate adjustment is a request to see the line it affects.
    scrolledAt = 0;
    paintOffset();
    paintPin();
    highlight(true);
  }

  /*
   * Holding a button runs it. A padded upload can be a minute out, which is
   * 240 quarter-second presses, so the offset has to be reachable by holding
   * rather than only by clicking.
   *
   * `repeated` swallows the click that arrives when the finger comes up, so a
   * hold does not get one extra nudge on release. It is cleared at the start of
   * the next press rather than on release, because a pointer that leaves the
   * button never produces that click at all.
   */
  var REPEAT_AFTER = 450;
  var REPEAT_EVERY = 90;

  var repeatDelay = null;
  var repeatTimer = null;
  var repeated = false;

  function stopRepeat() {
    clearTimeout(repeatDelay);
    clearInterval(repeatTimer);
    repeatDelay = null;
    repeatTimer = null;
  }

  function startRepeat(sign) {
    stopRepeat();
    repeated = false;
    repeatDelay = setTimeout(function () {
      repeated = true;
      repeatTimer = setInterval(function () {
        nudgeOffset(sign * YTML.OFFSET_STEP_LARGE);
      }, REPEAT_EVERY);
    }, REPEAT_AFTER);
  }

  function wireOffsetButton(button, sign) {
    // Click, not pointerdown, so Enter and Space still work on the button.
    button.addEventListener('click', function (e) {
      if (repeated) return;
      nudgeOffset(sign * (e.shiftKey ? YTML.OFFSET_STEP_LARGE : YTML.OFFSET_STEP));
    });
    button.addEventListener('pointerdown', function () { startRepeat(sign); });
  }

  function savePin() {
    var id = pinnableId(selected);

    /*
     * These two used to return silently, which is indistinguishable from a
     * button that is not wired up at all. Both are states the user can reach —
     * a result with no LRCLIB id, or a panel that never got a resolved song
     * back from the worker — so both have to say so.
     */
    if (id === null) {
      flashPin('No id');
      return;
    }
    if (!resolved) {
      flashPin('No song');
      return;
    }

    var saving = offset;
    ask({ type: 'pin-song', resolved: resolved, id: id, off: saving }).then(function (res) {
      if (!res || !res.ok) {
        flashPin('Couldn’t save');
        return;
      }
      pin = { id: id, off: saving };
      paintPin();
    });
  }

  /*
   * The saved entry 404'd, so what is on screen is the ranker's pick rather
   * than the one that was chosen. Worth saying: a song that has been in sync
   * for months quietly drifting is otherwise unexplainable from the panel.
   *
   * The record is deliberately still in storage at this point — the worker does
   * not delete on a 404, because LRCLIB coming back is more likely than the
   * user wanting their choice thrown away. This is where they get to decide.
   */
  function showStaleNotice() {
    showNotice(
      'The match you pinned is gone from LRCLIB. Showing the best match instead.',
      'Forget it',
      function () {
        clearNotice();
        unpinCurrent();
      }
    );
  }

  function unpinCurrent() {
    if (!resolved) {
      flashPin('No song');
      return;
    }
    ask({ type: 'unpin-song', resolved: resolved }).then(function (res) {
      if (!res || !res.ok) {
        flashPin('Couldn’t save');
        return;
      }
      pin = null;
      paintPin();
    });
  }

  /*
   * The other view pinned or unpinned this song. Only the button moves: the
   * offset on screen is what this user is in the middle of judging, and having
   * it jump underneath them would be worse than showing it as unsaved.
   */
  function adoptPinChange(changes) {
    if (!resolved) return;
    var key = YTML.PIN_PREFIX + YTML.pinKey(resolved);
    if (!Object.prototype.hasOwnProperty.call(changes, key)) return;

    var records = changes[key].newValue;
    pin = YTML.pinRecordFor(Array.isArray(records) ? records : [], resolved.duration);
    paintPin();
  }

  /* -------------------------------------------------------------- render */

  function renderFallbacks() {
    el.fallbackList.textContent = '';
    YTML.PROVIDERS.forEach(function (p) {
      // 'sidebar' is where we already are and 'panel' is this same page.
      if (p.id === 'panel' || p.id === 'sidebar') return;
      el.fallbackList.appendChild(
        chipLink(p.label, YTML.providerUrl(p.id, song, settings), p.hint)
      );
    });
  }

  function renderSongHeader() {
    if (!song || !song.title) {
      el.title.textContent = LIVE ? 'Nothing playing' : 'Unknown song';
      el.meta.textContent = LIVE
        ? 'Start a song on music.youtube.com.'
        : '';
      return;
    }
    el.title.textContent = YTML.cleanTitle(song.title);
    el.meta.textContent = [YTML.cleanArtist(song.artist), song.album]
      .filter(Boolean).join(' • ');
    if (!LIVE) document.title = YTML.cleanTitle(song.title) + ' — lyrics';
  }

  // What the user is looking at, in one string: the plain lyrics in whichever
  // script is on screen. The synced view is the same words line by line, so
  // this is what Copy hands over either way.
  function shownText() {
    return romanized ? Translit.romanize(originalLyrics) : originalLyrics;
  }

  function syncing() {
    return syncOn && lrcLines.length > 0;
  }

  function renderPlain() {
    el.lyrics.classList.remove('lyrics--synced', 'can-seek');
    el.lyrics.textContent = shownText();
    lineNodes = [];
    activeIndex = -1;
  }

  /*
   * One node per timed line, in playing order. A timed line with no words is
   * the gap between two stanzas: it keeps its place so the highlight has
   * somewhere to be during the interlude, and it is not clickable because
   * there is nothing there to click.
   */
  function renderSynced() {
    el.lyrics.textContent = '';
    el.lyrics.classList.add('lyrics--synced');
    activeIndex = -1;

    lineNodes = lrcLines.map(function (line) {
      var node = document.createElement('div');
      var words = romanized ? Translit.romanize(line.text) : line.text;

      if (words) {
        node.className = 'line';
        node.textContent = words;
        // The offset is read when the click happens, not captured here, so
        // nudging it does not mean rebuilding every line.
        node.title = 'Jump to ' + timeLabel(YTML.shiftedSeek(line.time, offset));
        node.addEventListener('click', function () {
          seekTo(YTML.shiftedSeek(line.time, offset));
        });
      } else {
        node.className = 'line line--gap';
      }
      el.lyrics.appendChild(node);
      return node;
    });
  }

  function paint() {
    if (syncing()) renderSynced(); else renderPlain();

    el.lyrics.hidden = false;
    el.copyBtn.hidden = false;
    el.romanizeBtn.hidden = !Translit.hasDevanagari(originalLyrics);
    el.romanizeBtn.textContent = romanized ? 'Devanagari' : 'Romanize';
    el.romanizeBtn.classList.toggle('on', romanized);
    el.syncBtn.hidden = !lrcLines.length;
    el.syncBtn.classList.toggle('on', syncing());
    paintPin();
    paintOffset();
    setStatus('');

    updateLease();
    highlight(true);
  }

  function setRomanized(on) {
    romanized = on;
    paint();
  }

  /*
   * A ranked entry becomes what is on screen. LRCLIB stores the timed version
   * next to the plain one for a good share of its catalogue; when this entry
   * has one that parses, the song can be followed rather than read.
   */
  function renderEntry(entry) {
    selected = entry;
    originalLyrics = (entry && entry.text) || '';
    lrcLines = YTML.parseLrc(entry && entry.synced);

    // An offset was measured against one entry, so switching to another starts
    // from nothing rather than inheriting a correction for a different file.
    offset = pinAppliesTo(entry) ? pin.off : 0;

    var wantRoman = stickyRomanize === null ? settings.autoRomanize : stickyRomanize;
    romanized = !!wantRoman && Translit.hasDevanagari(originalLyrics);

    var wantSync = stickySync === null ? settings.syncedLyrics : stickySync;
    syncOn = !!wantSync;

    scrolledAt = 0;
    paint();
  }

  function clearLyrics() {
    clearNotice();
    originalLyrics = '';
    romanized = false;
    selected = null;
    offset = 0;
    clearTimeout(pinFlashTimer);
    pinFlashTimer = null;
    el.pinBtn.hidden = true;
    el.offsetBar.hidden = true;
    lrcLines = [];
    lineNodes = [];
    activeIndex = -1;
    el.lyrics.textContent = '';
    el.lyrics.classList.remove('lyrics--synced');
    el.lyrics.hidden = true;
    el.copyBtn.hidden = true;
    el.romanizeBtn.hidden = true;
    el.syncBtn.hidden = true;
    el.alternates.hidden = true;
    el.alternateList.textContent = '';
    el.sourceNote.textContent = '';
    updateLease();
  }

  /*
   * A pinned song reached the panel through one request for one entry, so
   * there is nothing to list until the full ladder has been asked for. The
   * offer to go and do that stands in for the list.
   */
  function renderShowMore() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Show other matches';
    btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = 'Searching…';
      loadAlternates();
    });
    el.alternateList.appendChild(btn);
    el.alternates.hidden = false;
  }

  function loadAlternates() {
    var token = searchToken;
    ask({ type: 'fetch-alternates', song: song }).then(function (result) {
      if (token !== searchToken) return;      // the song changed under us
      alternatesLoaded = true;

      // What is on screen stays at the head of the list, and stays selected.
      var id = pinnableId(selected);
      var rest = ((result && result.results) || []).filter(function (entry) {
        return pinnableId(entry) !== id;
      });
      renderAlternates(selected ? [selected].concat(rest) : rest);
    });
  }

  function renderAlternates(list) {
    el.alternateList.textContent = '';

    if (list.length < 2) {
      if (selected && !alternatesLoaded) renderShowMore();
      return;
    }

    list.slice(0, 8).forEach(function (entry, index) {
      var btn = document.createElement('button');
      btn.type = 'button';
      // Which of the alternates can be followed is worth knowing before
      // clicking one — the best-scoring match is not always the timed one.
      btn.textContent = (entry.synced ? '◍ ' : '') +
                        (entry.item.trackName || entry.item.name || 'Unknown') +
                        ' — ' + (entry.item.artistName || '?');
      if (entry.synced) btn.title = 'Has synced lyrics';
      btn.addEventListener('click', function () {
        Array.prototype.forEach.call(el.alternateList.children, function (node) {
          node.classList.remove('on');
        });
        btn.classList.add('on');
        renderEntry(entry);
        el.sourceNote.textContent = sourceLabel(entry);
      });
      if (index === 0) btn.classList.add('on');
      el.alternateList.appendChild(btn);
    });
    el.alternates.hidden = false;
  }

  /* ------------------------------------------------------ following along */

  function timeLabel(seconds) {
    var whole = Math.max(0, Math.floor(Number(seconds) || 0));
    var mins = Math.floor(whole / 60);
    var secs = whole % 60;
    return mins + ':' + (secs < 10 ? '0' : '') + secs;
  }

  /*
   * Where the song is now, read off the last sample and the local clock. A
   * paused sample never goes stale — it is still true, however long ago it
   * arrived — but a playing one does: once nothing has confirmed it for a
   * quarter of a minute the tab is gone or the panel was asleep, and a made-up
   * position is worse than none.
   */
  function positionNow() {
    if (!clock) return null;
    if (clock.paused) return clock.time;

    var elapsed = Date.now() - clock.at;
    if (elapsed > STALE_MS) return null;
    return clock.time + (elapsed / 1000) * (clock.rate || 1);
  }

  /*
   * How far through the lit line the song has got, 0 to 1, written to the node
   * for the CSS to draw as a filling underline.
   *
   * This exists because the highlight alone cannot show an offset working. A
   * line lasts several seconds, so a quarter-second nudge changes which line is
   * lit about one press in twelve; the other eleven look like nothing happened.
   * The fill moves on every press, and reaches the end of the line exactly when
   * the next one starts — which is the thing being tuned.
   */
  var LAST_LINE_SPAN = 4;   // nothing follows it to measure against

  function paintLineProgress(index, shifted) {
    var node = lineNodes[index];
    var line = lrcLines[index];
    if (!node || !line) return;

    var next = lrcLines[index + 1];
    var span = next ? next.time - line.time : LAST_LINE_SPAN;
    var progress = span > 0 ? (shifted - line.time) / span : 0;

    node.style.setProperty(
      '--line-progress',
      Math.min(1, Math.max(0, progress)).toFixed(3)
    );
  }

  function highlight(force) {
    if (!syncing()) return;

    var at = positionNow();
    // Whether a line is worth clicking is whether we know where the song is.
    el.lyrics.classList.toggle('can-seek', at !== null);
    if (at === null) {
      paintCountdown(null, null, activeIndex);
      return;
    }

    var shifted = YTML.shiftedPosition(at, offset);
    var index = YTML.activeLineIndex(lrcLines, shifted);

    // Before the early return below, because this is the part that has to move
    // on every tick — and the part that makes a quarter-second nudge visible.
    paintLineProgress(index, shifted);
    paintCountdown(at, shifted, index);

    if (index === activeIndex && !force) return;

    if (lineNodes[activeIndex]) lineNodes[activeIndex].classList.remove('is-current');
    activeIndex = index;

    var node = lineNodes[index];
    if (!node) return;
    // A gap has no words to light up, but it is still the place to scroll to.
    if (lrcLines[index].text) node.classList.add('is-current');
    scrollToLine(node);
  }

  /*
   * Auto-scrolling fights anyone reading ahead, so a nudge of the scrollbar
   * hands control back for a few seconds. The signals watched are the ones a
   * person makes — a smooth scroll of our own fires scroll events by the
   * dozen, which is exactly why they are not one of them.
   */
  function scrollToLine(node) {
    if (Date.now() - scrolledAt < FOLLOW_PAUSE) return;
    var smooth = !window.matchMedia ||
                 !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    try {
      node.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
    } catch (e) {
      node.scrollIntoView();
    }
  }

  /*
   * Only ever the song on screen. A clock exists at all because a position
   * arrived that belongs to this song — so no clock means a lyrics tab pinned
   * to one track cannot reach round and seek whatever else is playing.
   */
  function seekTo(time) {
    if (!syncing() || positionNow() === null) return;
    // Clicking a line is a request to follow it, so whatever scrolling was
    // going on to find it stops counting.
    scrolledAt = 0;

    ask({ type: 'seek-to', time: time }).then(function (res) {
      if (!res || !res.ok) return;
      // The player will report the new position in a moment; moving the local
      // clock now means the line lights up on the click rather than after it.
      clock = {
        time: time,
        at: Date.now(),
        paused: clock ? clock.paused : false,
        rate: clock ? clock.rate : 1
      };
      highlight(true);
    });
  }

  /*
   * The content script only publishes a position while a lease is live, and
   * the lease expires by itself — so a panel the browser destroys without
   * warning cannot leave the YouTube Music tab talking to nobody.
   */
  function updateLease() {
    var wanted = syncing();

    if (!wanted) {
      if (leaseTimer !== null) { clearInterval(leaseTimer); leaseTimer = null; }
      if (highlightTimer !== null) { clearInterval(highlightTimer); highlightTimer = null; }
      clock = null;
      return;
    }

    if (highlightTimer === null) {
      highlightTimer = setInterval(function () { highlight(false); }, HIGHLIGHT_MS);
    }
    if (leaseTimer === null) {
      leaseTimer = setInterval(renewLease, LEASE_MS);
    }
    renewLease();
  }

  function renewLease() {
    ask({ type: 'sync-watch' }).then(function (res) {
      // No tab, or a tab with no player: stop claiming to know where the song
      // is rather than letting the last position run on forever.
      if (!res || !res.ok) clock = null;
    });
  }

  function acceptPosition(msg) {
    var sample = msg && msg.position;
    if (!sample || !isFinite(Number(sample.time))) return;
    if (!positionIsOurs(msg.song)) return;

    clock = {
      time: Number(sample.time),
      at: Number(sample.at) || Date.now(),
      paused: !!sample.paused,
      rate: Number(sample.rate) || 1
    };
    highlight(false);
  }

  /*
   * The live panel follows whatever is playing, so every position is its own.
   * A lyrics tab is pinned to one song and has to check: the same cleanup runs
   * on both sides, so a title that reached this page through the URL and the
   * one the player bar is showing come out identical when they are the same
   * song. When they are not, the tab simply does not follow along.
   */
  function positionIsOurs(playing) {
    if (LIVE) return true;
    if (!song || !song.title || !playing || !playing.title) return false;
    return YTML.songKey(YTML.normalizeSong(song, settings)) ===
           YTML.songKey(YTML.normalizeSong(playing, settings));
  }

  /* ------------------------------------------------------------ no result */

  function fallbackUrl() {
    return YTML.providerUrl(settings.fallbackProvider, song, settings);
  }

  /*
   * A tab can simply navigate itself to the fallback site. The side panel
   * cannot — it only ever loads extension pages — so there it becomes a
   * button that opens a tab, and nothing happens without a click.
   */
  function handleNoResults() {
    if (LIVE) {
      setStatus('No lyrics on LRCLIB for this track.');
      showNotice('Nothing on LRCLIB.', 'Open on ' + providerLabel(settings.fallbackProvider), function () {
        window.open(fallbackUrl(), '_blank', 'noreferrer');
      });
      return;
    }

    if (!settings.autoFallback) {
      setStatus('No lyrics found on LRCLIB. Pick a site below.');
      return;
    }

    var url = fallbackUrl();
    var label = providerLabel(settings.fallbackProvider);
    var seconds = 4;

    function tick() {
      if (seconds <= 0) {
        clearInterval(redirectTimer);
        location.replace(url);
        return;
      }
      showNotice('No lyrics on LRCLIB. Redirecting to ' + label + ' in ' + seconds + 's…', 'Stay here', function () {
        clearNotice();
        setStatus('No lyrics found on LRCLIB. Pick a site below.');
      });
      seconds--;
    }

    tick();
    redirectTimer = setInterval(tick, 1000);
  }

  /* -------------------------------------------------------------- search */

  async function runSearch() {
    var token = ++searchToken;

    if (!song || !song.title) {
      clearLyrics();
      setStatus(LIVE ? 'Waiting for a song…' : '');
      renderFallbacks();
      return;
    }

    clearLyrics();
    setStatus('Searching LRCLIB…');
    renderFallbacks();

    var result = await ask({ type: 'fetch-lyrics', song: song });
    if (token !== searchToken) return;    // the song changed under us

    resolved = (result && result.song) || null;
    pin = (result && result.pin) || null;
    // A pin answers with the one entry it names; everything else came off the
    // ladder and is already the whole list.
    alternatesLoaded = !pin;

    var results = (result && result.results) || [];
    if (!results.length) {
      handleNoResults();
      return;
    }

    renderEntry(results[0]);
    el.sourceNote.textContent = sourceLabel(results[0]);
    renderAlternates(results);

    // Only once there is something on screen to explain. With no results at
    // all, handleNoResults above has already offered the fallback provider,
    // which is the more useful thing to be looking at.
    if (result && result.pinStale) showStaleNotice();
  }

  /* ----------------------------------------------------------- live mode */

  function adoptSong(next) {
    // Duration is part of the key here because it arrives a beat after the
    // title and widens the search when it does — see lrclibQueries.
    var normalized = YTML.normalizeSong(next, settings);
    var key = YTML.songKey(normalized) + '|' + normalized.duration;
    if (next && next.title && key === songKey) return false;
    if (!next && !song) return false;

    song = next;
    songKey = next && next.title ? key : '';
    renderSongHeader();
    return true;
  }

  async function refreshFromPlayer() {
    var result = await ask({ type: 'get-current-song' });
    if (adoptSong(result && result.song ? result.song : null)) await runSearch();
  }

  function watchPlayer() {
    // The content script only broadcasts while its tab is alive; poll slowly
    // so closing and reopening YouTube Music still settles the panel.
    setInterval(refreshFromPlayer, 5000);
  }

  /*
   * Both modes listen. A song change only means something to the live panel,
   * but a position matters to a pinned tab too — it just has to check the
   * position is its own song's first.
   */
  function watchMessages() {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || !msg.type) return;

      if (msg.type === 'player-position') {
        acceptPosition(msg);
        return;
      }
      if (msg.type === 'song-changed' && LIVE) {
        if (adoptSong(msg.song || null)) runSearch();
      }
    });
  }

  /* ----------------------------------------------------------------- ui */

  function applyFontSize() {
    document.documentElement.style.setProperty('--lyrics-size', fontSize + 'px');
    try { localStorage.setItem('ytml-font', String(fontSize)); } catch (e) { /* ignore */ }
  }

  function wireUi() {
    el.romanizeBtn.addEventListener('click', function () {
      stickyRomanize = !romanized;
      setRomanized(stickyRomanize);
    });

    el.syncBtn.addEventListener('click', function () {
      stickySync = !syncing();
      syncOn = stickySync;
      // Turning it back on is also a request to be followed again, whatever
      // the scrollbar was doing before.
      scrolledAt = 0;
      paint();
    });

    el.pinBtn.addEventListener('click', function () {
      if (pinState() === 'saved') unpinCurrent(); else savePin();
    });

    wireOffsetButton(el.offsetDown, -1);
    wireOffsetButton(el.offsetUp, 1);
    // On the window, so a finger that slides off the button still stops it.
    ['pointerup', 'pointercancel'].forEach(function (name) {
      window.addEventListener(name, stopRepeat);
    });
    el.offsetValue.addEventListener('click', function () {
      nudgeOffset(-offset);
    });

    el.copyBtn.addEventListener('click', function () {
      navigator.clipboard.writeText(shownText()).then(function () {
        el.copyBtn.textContent = 'Copied';
        setTimeout(function () { el.copyBtn.textContent = 'Copy'; }, 1200);
      });
    });

    /*
     * Reading ahead has to win over following along. These are the events a
     * person makes; the scroll event is not among them, because our own smooth
     * scroll fires it by the dozen and would switch the following off every
     * time it moved.
     */
    ['wheel', 'touchmove'].forEach(function (name) {
      window.addEventListener(name, function () { scrolledAt = Date.now(); }, { passive: true });
    });

    // Dragging the scrollbar produces neither of those, and it is the one
    // gesture here that is only ever about scrolling — as long as pressing a
    // button is not mistaken for it.
    window.addEventListener('mousedown', function (e) {
      var target = e.target;
      if (target && target.closest && target.closest('button, a, .line')) return;
      scrolledAt = Date.now();
    }, { passive: true });
    window.addEventListener('keydown', function (e) {
      if (/^(?:Arrow|Page)/.test(e.key) || e.key === 'Home' || e.key === 'End' || e.key === ' ') {
        scrolledAt = Date.now();
      }
    });

    el.smaller.addEventListener('click', function () {
      fontSize = Math.max(12, fontSize - 1);
      applyFontSize();
    });
    el.bigger.addEventListener('click', function () {
      fontSize = Math.min(34, fontSize + 1);
      applyFontSize();
    });

    if (el.openTab) {
      el.openTab.addEventListener('click', function () {
        chrome.tabs.create({ url: YTML.providerUrl('panel', song, settings) });
      });
    }

    document.getElementById('optionsLink').addEventListener('click', function (e) {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  }

  /* ---------------------------------------------------------------- run */

  async function init() {
    settings = await YTML.getSettings();

    try {
      var saved = parseInt(localStorage.getItem('ytml-font') || '', 10);
      if (saved) fontSize = saved;
    } catch (e) { /* ignore */ }
    applyFontSize();
    wireUi();

    chrome.storage.onChanged.addListener(function (changes, area) {
      // Pins are local; the settings below are synced. Different areas, and
      // the local one only ever concerns the button.
      if (area === 'local') {
        adoptPinChange(changes);
        return;
      }
      if (area !== 'sync') return;
      Object.keys(changes).forEach(function (k) { settings[k] = changes[k].newValue; });
      renderFallbacks();

      // Switching the setting is only allowed to move a song the user has not
      // already decided about with the panel's own button.
      if (changes.syncedLyrics && stickySync === null && originalLyrics) {
        syncOn = !!settings.syncedLyrics;
        paint();
      }
    });

    watchMessages();

    if (LIVE) {
      watchPlayer();
      await refreshFromPlayer();
      if (!song) {
        renderSongHeader();
        setStatus('Waiting for a song…');
        renderFallbacks();
      }
      return;
    }

    if (params.get('error') === 'nosong') {
      document.title = 'No song detected';
      el.title.textContent = 'No song detected';
      el.meta.textContent = 'Open music.youtube.com, start a track, then try again.';
      setStatus('YouTube Music was not playing anything this extension could read.');
      renderFallbacks();
      return;
    }

    song = {
      title: params.get('title') || '',
      rawTitle: params.get('raw') || params.get('title') || '',
      artist: params.get('artist') || '',
      album: params.get('album') || '',
      source: params.get('source') || '',
      duration: params.get('dur') || ''
    };
    renderSongHeader();
    await runSearch();
  }

  init();
})();
