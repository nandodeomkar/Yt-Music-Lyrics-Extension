(function () {
  'use strict';

  var YTML = self.YTML;

  var el = {
    title: document.getElementById('title'),
    artist: document.getElementById('artist'),
    primary: document.getElementById('primary'),
    providers: document.getElementById('providers'),
    romanize: document.getElementById('romanize'),
    options: document.getElementById('options'),
    hint: document.getElementById('hint')
  };

  var settings = Object.assign({}, YTML.DEFAULTS);
  var song = null;
  var musicTabId = null;
  // Resolved during init so the click handler can call sidePanel.open()
  // without awaiting anything first — see openSidePanel below.
  var windowId = null;

  function ask(message) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(message, function (response) {
        void chrome.runtime.lastError;
        resolve(response || null);
      });
    });
  }

  /*
   * chrome.sidePanel.open() only works inside a user gesture. A click that
   * has to travel to the service worker does not reliably carry one, but the
   * popup's own click always does — so open the panel here and leave the
   * worker as the fallback path.
   */
  function openSidePanel() {
    if (!chrome.sidePanel || !chrome.sidePanel.open || windowId == null) {
      return Promise.resolve(false);
    }
    return chrome.sidePanel.open({ windowId: windowId })
      .then(function () { return true; })
      .catch(function () { return false; });
  }

  function open(providerId) {
    if (providerId !== 'sidebar') {
      chrome.runtime.sendMessage({ type: 'open-lyrics', song: song, provider: providerId });
      window.close();
      return;
    }

    openSidePanel().then(function (opened) {
      if (opened) {
        // Warm the worker's cache so the panel paints with lyrics in hand.
        if (song) chrome.runtime.sendMessage({ type: 'fetch-lyrics', song: song });
      } else {
        chrome.runtime.sendMessage({ type: 'open-lyrics', song: song, provider: 'sidebar' });
      }
      window.close();
    });
  }

  function renderProviders() {
    el.providers.textContent = '';
    YTML.PROVIDERS.forEach(function (p) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = p.label;
      btn.title = p.hint;
      // The side panel is worth opening even before a song is detected: it
      // picks one up on its own as soon as YouTube Music starts.
      btn.disabled = !song && p.id !== 'sidebar';
      btn.addEventListener('click', function () { open(p.id); });
      el.providers.appendChild(btn);
    });
  }

  async function init() {
    settings = await YTML.getSettings();

    try {
      var win = await chrome.windows.getCurrent();
      windowId = win && win.id != null ? win.id : null;
    } catch (e) {
      windowId = null;
    }

    var primaryProvider = YTML.PROVIDERS.filter(function (p) {
      return p.id === settings.provider;
    })[0];
    el.primary.textContent = 'Open lyrics' + (primaryProvider ? ' — ' + primaryProvider.label : '');

    var result = await ask({ type: 'get-current-song' });
    song = result && result.song ? result.song : null;
    musicTabId = result && result.tab ? result.tab.id : null;

    if (song) {
      el.title.textContent = YTML.cleanTitle(song.title);
      el.artist.textContent = [YTML.cleanArtist(song.artist), song.album].filter(Boolean).join(' • ');
      el.primary.disabled = false;
      el.romanize.disabled = !musicTabId;
    } else {
      el.title.textContent = 'Nothing detected';
      el.artist.textContent = 'Open music.youtube.com and start a song.';
      el.primary.disabled = settings.provider !== 'sidebar';
    }

    renderProviders();
  }

  el.primary.addEventListener('click', function () { open(settings.provider); });

  el.romanize.addEventListener('click', function () {
    if (!musicTabId) return;
    chrome.tabs.sendMessage(musicTabId, { type: 'toggle-romanize' }, function (res) {
      void chrome.runtime.lastError;
      if (res) {
        el.romanize.textContent = res.romanized ? 'Restore Devanagari' : 'Romanize page lyrics';
      }
    });
  });

  el.options.addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  init();
})();
