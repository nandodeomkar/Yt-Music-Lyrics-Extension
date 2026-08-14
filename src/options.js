(function () {
  'use strict';

  var YTML = self.YTML;
  var Translit = self.YTMLTranslit;

  var SELECTS = ['provider', 'fallbackProvider'];
  var TEXTS = ['querySuffix'];
  var CHECKS = [
    'includeAlbum', 'romanizeQuery', 'openInBackground',
    'autoFallback', 'syncedLyrics', 'showPlayerButton', 'autoRomanize'
  ];

  /*
   * Deliberately not in CHECKS: these cannot be saved without first asking for
   * a host permission, and the answer may be no. Each entry is
   * settings key -> the origin ticking it grants.
   */
  var OPTIONAL = [
    {
      key: 'resolveSong',
      origin: 'https://itunes.apple.com/*',
      on: 'Allowed to contact itunes.apple.com. Only uploads are looked up.',
      off: 'Not allowed. Songs are identified from the video title alone.'
    },
    {
      key: 'useLyricsMint',
      origin: 'https://lyricsmint.com/*',
      on: 'Allowed to contact lyricsmint.com after LRCLIB comes back empty.',
      off: 'Not allowed. LRCLIB is the only source of lyrics.'
    }
  ];

  var savedEl = document.getElementById('saved');
  var savedTimer = null;

  function flashSaved() {
    savedEl.hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(function () { savedEl.hidden = true; }, 1200);
  }

  // The built-in panels can only ever be a starting point: when they find
  // nothing they hand off to the fallback, so the fallback has to be a site.
  var BUILT_IN = ['sidebar', 'panel'];

  function fillProviderSelect(select, includeBuiltIn) {
    YTML.PROVIDERS.forEach(function (p) {
      if (!includeBuiltIn && BUILT_IN.indexOf(p.id) >= 0) return;
      var opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      select.appendChild(opt);
    });
  }

  function hintFor(id) {
    var p = YTML.PROVIDERS.filter(function (x) { return x.id === id; })[0];
    return p ? p.hint : '';
  }

  function updateHints() {
    document.getElementById('providerHint').textContent =
      hintFor(document.getElementById('provider').value);
    document.getElementById('fallbackHint').textContent =
      hintFor(document.getElementById('fallbackProvider').value);
  }

  function save() {
    var patch = {};
    SELECTS.concat(TEXTS).forEach(function (id) {
      patch[id] = document.getElementById(id).value;
    });
    CHECKS.forEach(function (id) {
      patch[id] = document.getElementById(id).checked;
    });
    if (!patch.querySuffix.trim()) patch.querySuffix = '';
    YTML.saveSettings(patch).then(flashSaved);
    updateHints();
  }

  /* --------------------------------------------- optional permissions */

  function granted(origin) {
    return new Promise(function (resolve) {
      if (!chrome.permissions || !chrome.permissions.contains) {
        resolve(false);
        return;
      }
      chrome.permissions.contains({ origins: [origin] }, function (has) {
        void chrome.runtime.lastError;
        resolve(!!has);
      });
    });
  }

  function paintOptional(entry, on) {
    document.getElementById(entry.key).checked = on;
    document.getElementById(entry.key + 'Hint').textContent = on ? entry.on : entry.off;
  }

  /*
   * chrome.permissions.request() needs the click that triggered it, so it is
   * called straight out of the change event — nothing may be awaited first,
   * the same rule that governs opening the side panel. The checkbox only
   * sticks if Chrome actually granted the origin.
   */
  // Reloading the extension orphans any Settings page left open: chrome.* calls
  // start failing, the tick-box springs back, and nothing says why.
  var STALE = 'This Settings page is older than the installed extension — ' +
              'close this tab and open Settings again.';

  function contextAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function wireOptional(entry) {
    var box = document.getElementById(entry.key);
    var hint = document.getElementById(entry.key + 'Hint');

    function refuse(message) {
      box.checked = false;
      hint.textContent = message;
    }

    function store(on) {
      var patch = {};
      patch[entry.key] = on;
      paintOptional(entry, on);
      YTML.saveSettings(patch).then(flashSaved);
    }

    box.addEventListener('change', function () {
      if (!contextAlive()) {
        refuse(STALE);
        return;
      }

      if (!box.checked) {
        try {
          chrome.permissions.remove({ origins: [entry.origin] }, function () {
            void chrome.runtime.lastError;
            store(false);
          });
        } catch (e) {
          refuse(STALE);
        }
        return;
      }

      try {
        chrome.permissions.request({ origins: [entry.origin] }, function (ok) {
          var error = chrome.runtime.lastError;
          if (error) {
            refuse('Chrome refused the request: ' + error.message + ' ' + STALE);
            return;
          }
          if (!ok) {
            refuse('Permission declined, so this stays off. If no prompt appeared at ' +
                   'all, reload the extension and reopen Settings.');
            return;
          }
          store(true);
        });
      } catch (e) {
        refuse(STALE);
      }
    });
  }

  function wire() {
    SELECTS.concat(TEXTS).concat(CHECKS).forEach(function (id) {
      var node = document.getElementById(id);
      node.addEventListener('change', save);
      if (node.type === 'text') node.addEventListener('input', debounce(save, 400));
    });

    var testIn = document.getElementById('testIn');
    var testOut = document.getElementById('testOut');
    testIn.addEventListener('input', function () {
      testOut.textContent = Translit.romanize(testIn.value);
    });
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  fillProviderSelect(document.getElementById('provider'), true);
  fillProviderSelect(document.getElementById('fallbackProvider'), false);

  YTML.getSettings().then(function (settings) {
    SELECTS.concat(TEXTS).forEach(function (id) {
      document.getElementById(id).value = settings[id];
    });
    CHECKS.forEach(function (id) {
      document.getElementById(id).checked = !!settings[id];
    });
    updateHints();
    wire();
    OPTIONAL.forEach(wireOptional);

    // A permission can be revoked from chrome://extensions without this page
    // ever hearing about it, so every stored setting is reconciled against the
    // real grant rather than trusted.
    return Promise.all(OPTIONAL.map(function (entry) {
      return granted(entry.origin).then(function (has) {
        var on = !!settings[entry.key] && has;
        paintOptional(entry, on);
        if (on === !!settings[entry.key]) return null;
        var patch = {};
        patch[entry.key] = on;
        return YTML.saveSettings(patch);
      });
    }));
  });
})();
