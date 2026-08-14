/*
 * Devanagari -> Hinglish (Latin) transliteration.
 *
 * This is a phonetic/practical romanizer, not strict IAST: it aims for what a
 * Hindi speaker would actually type ("dhadkan", "namkeen", "pyaar"), which
 * means it also has to guess at schwa deletion. The heuristics are documented
 * inline and cover the common Bollywood-lyrics cases.
 *
 * Exposed as globalThis.YTMLTranslit = { romanize, hasDevanagari }.
 */
(function (root) {
  'use strict';

  var VIRAMA = '्';
  var NUKTA = '़';
  var ANUSVARA = 'ं';
  var CHANDRABINDU = 'ँ';
  var VISARGA = 'ः';
  var AVAGRAHA = 'ऽ';
  var ZWNJ = '‌';
  var ZWJ = '‍';

  var CONSONANTS = {
    'क': 'k',  'ख': 'kh', 'ग': 'g',  'घ': 'gh', 'ङ': 'n',
    'च': 'ch', 'छ': 'chh','ज': 'j',  'झ': 'jh', 'ञ': 'n',
    'ट': 't',  'ठ': 'th', 'ड': 'd',  'ढ': 'dh', 'ण': 'n',
    'त': 't',  'थ': 'th', 'द': 'd',  'ध': 'dh', 'न': 'n',
    'ऩ': 'n',
    'प': 'p',  'फ': 'ph', 'ब': 'b',  'भ': 'bh', 'म': 'm',
    'य': 'y',  'र': 'r',  'ऱ': 'r',  'ल': 'l',  'ळ': 'l',
    'ऴ': 'l',  'व': 'v',
    'श': 'sh', 'ष': 'sh', 'स': 's',  'ह': 'h'
  };

  // Consonant + nukta. Written the way people actually type them in Hinglish.
  var NUKTA_CONSONANTS = {
    'क': 'q',  // क़
    'ख': 'kh', // ख़
    'ग': 'gh', // ग़  (ghazal)
    'ज': 'z',  // ज़
    'ड': 'd',  // ड़  (bada, thoda)
    'ढ': 'dh', // ढ़
    'फ': 'f',  // फ़
    'य': 'y',  // य़
    'र': 'r',  // ऱ
    'न': 'n'   // ऩ
  };

  var MATRAS = {
    'ऺ': 'e',  'ऻ': 'aa',
    'ा': 'aa', 'ि': 'i',  'ी': 'ee', 'ु': 'u',  'ू': 'oo',
    'ृ': 'ri', 'ॄ': 'ri', 'ॅ': 'e',  'ॆ': 'e',  'े': 'e',
    'ै': 'ai', 'ॉ': 'o',  'ॊ': 'o',  'ो': 'o',  'ौ': 'au',
    'ॎ': 'e',  'ॏ': 'aw', 'ॕ': 'e',  'ॖ': 'u',  'ॗ': 'oo',
    'ॢ': 'li', 'ॣ': 'li'
  };

  var VOWELS = {
    'ऄ': 'a',  'अ': 'a',  'आ': 'aa', 'इ': 'i',  'ई': 'ee',
    'उ': 'u',  'ऊ': 'oo', 'ऋ': 'ri', 'ऌ': 'li', 'ऍ': 'e',
    'ऎ': 'e',  'ए': 'e',  'ऐ': 'ai', 'ऑ': 'o',  'ऒ': 'o',
    'ओ': 'o',  'औ': 'au', 'ॠ': 'ri', 'ॡ': 'li', 'ॲ': 'a',
    'ॳ': 'au', 'ॴ': 'au', 'ॵ': 'o',  'ॶ': 'ai', 'ॷ': 'ue'
  };

  var DIGITS = {
    '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
    '५': '5', '६': '6', '७': '7', '८': '8', '९': '9'
  };

  // Clusters whose pronunciation is not the sum of their parts.
  var CLUSTERS = [
    ['ज' + VIRAMA + 'ञ', 'gy'], // ज्ञ -> gy (gyaan)
    ['श' + VIRAMA + 'र', 'shr'] // श्र -> shr
  ];

  function isDevanagariChar(ch) {
    var c = ch.charCodeAt(0);
    return (c >= 0x0900 && c <= 0x097F) || c === 0x200C || c === 0x200D;
  }

  function hasDevanagari(text) {
    return /[ऀ-ॿ]/.test(String(text || ''));
  }

  function makeUnit(cons, vowel, schwa) {
    return { c: cons, v: vowel, schwa: !!schwa, nasal: '', tail: '', lit: null };
  }

  function makeLiteral(text) {
    return { c: '', v: '', schwa: false, nasal: '', tail: '', lit: text };
  }

  // Parses one run of Devanagari (i.e. one word) into syllable units.
  function parseRun(run) {
    var units = [];
    var i = 0;

    function attachSigns(unit) {
      while (run[i] === ANUSVARA || run[i] === CHANDRABINDU) {
        unit.nasal = 'n';
        i++;
      }
      if (run[i] === VISARGA) {
        unit.tail += 'h';
        i++;
      }
    }

    function attachVowel(unit) {
      if (run[i] === VIRAMA) {
        unit.v = '';
        unit.schwa = false;
        i++;
        return;
      }
      if (MATRAS[run[i]] !== undefined) {
        unit.v = MATRAS[run[i]];
        unit.schwa = false;
        i++;
      }
    }

    outer: while (i < run.length) {
      var ch = run[i];

      if (ch === ZWNJ || ch === ZWJ) { i++; continue; }

      for (var k = 0; k < CLUSTERS.length; k++) {
        var seq = CLUSTERS[k][0];
        if (run.substr(i, seq.length) === seq) {
          var cu = makeUnit(CLUSTERS[k][1], 'a', true);
          i += seq.length;
          attachVowel(cu);
          attachSigns(cu);
          units.push(cu);
          continue outer;
        }
      }

      if (CONSONANTS[ch] !== undefined) {
        var cons = CONSONANTS[ch];
        i++;
        if (run[i] === NUKTA) {
          cons = NUKTA_CONSONANTS[ch] || cons;
          i++;
        }
        var unit = makeUnit(cons, 'a', true);
        attachVowel(unit);
        attachSigns(unit);
        units.push(unit);
        continue;
      }

      if (VOWELS[ch] !== undefined) {
        var vu = makeUnit('', VOWELS[ch], false);
        i++;
        if (run[i] === NUKTA) { i++; }
        attachSigns(vu);
        units.push(vu);
        continue;
      }

      if (DIGITS[ch] !== undefined) { units.push(makeLiteral(DIGITS[ch])); i++; continue; }
      if (ch === 'ॐ') { units.push(makeLiteral('om')); i++; continue; }
      if (ch === AVAGRAHA) { i++; continue; }
      if (ch === '।' || ch === '॥') { units.push(makeLiteral('.')); i++; continue; }
      if (ch === '॰' || ch === 'ॱ') { units.push(makeLiteral('.')); i++; continue; }

      // Stray combining sign with nothing to attach to.
      if (ch === ANUSVARA || ch === CHANDRABINDU) {
        var lastReal = lastSyllable(units);
        if (lastReal) { lastReal.nasal = 'n'; } else { units.push(makeLiteral('n')); }
        i++;
        continue;
      }
      if (ch === VISARGA) {
        var lr = lastSyllable(units);
        if (lr) { lr.tail += 'h'; } else { units.push(makeLiteral('h')); }
        i++;
        continue;
      }
      if (ch === VIRAMA || ch === NUKTA) { i++; continue; }

      units.push(makeLiteral(ch));
      i++;
    }

    return units;
  }

  function lastSyllable(units) {
    for (var i = units.length - 1; i >= 0; i--) {
      if (units[i].lit === null) return units[i];
    }
    return null;
  }

  /*
   * Schwa deletion. Hindi drops the inherent "a" in places Sanskrit keeps it.
   *
   *  - Word-final:  दिल  -> "dil", not "dila".
   *    Kept after a conjunct ending in a liquid/glide, where Hindi really does
   *    pronounce it: मित्र -> "mitra", सत्य -> "satya". Other final clusters
   *    still drop it: इश्क़ -> "ishq", दोस्त -> "dost", शब्द -> "shabd".
   *  - Second syllable: धड़कन -> "dhadkan", नमकीन -> "namkeen", करना ->
   *    "karnaa". Applied to 4+ syllable words, and to 3-syllable words only
   *    when the word still ends in a real vowel — so करना loses its schwa but
   *    कमल stays "kamal". Also guarded on a short first vowel so बेवफ़ा stays
   *    "bevafaa" rather than collapsing to an unreadable "bevfaa". When in
   *    doubt this keeps the schwa: an extra vowel still reads fine, a missing
   *    one does not.
   */
  // First-syllable vowels light enough to allow the medial deletion below.
  // "e"/"o"/"ai"/"au" are excluded because they front a lot of Persian loans
  // (बेवफ़ा, बेसहारा) where the schwa is very much pronounced.
  var LIGHT_FIRST_VOWELS = { 'a': 1, 'i': 1, 'u': 1, 'aa': 1 };
  var FINAL_SCHWA_AFTER_CONJUNCT = /^[rlyv]/;

  function applySchwaDeletion(units) {
    var idx = [];
    for (var i = 0; i < units.length; i++) {
      if (units[i].lit === null) idx.push(i);
    }
    if (idx.length < 2) return;

    var last = units[idx[idx.length - 1]];
    var beforeLast = units[idx[idx.length - 2]];
    var keepAfterConjunct = beforeLast.v === '' && FINAL_SCHWA_AFTER_CONJUNCT.test(last.c);
    if (last.schwa && last.c && !last.nasal && !last.tail && !keepAfterConjunct) {
      last.v = '';
      last.schwa = false;
    }

    if (idx.length >= 4 || (idx.length === 3 && last.v !== '')) {
      var first = units[idx[0]];
      var second = units[idx[1]];
      var third = units[idx[2]];
      // The first syllable must be light: a nasalised one (ज़िंदगी, कंपनी) is
      // heavy and keeps the following schwa.
      if (second.schwa && second.c && !second.nasal && !second.tail &&
          LIGHT_FIRST_VOWELS[first.v] === 1 && !first.nasal && !first.tail &&
          third.c && third.v !== '') {
        second.v = '';
        second.schwa = false;
      }
    }
  }

  function lastSyllableIndex(units) {
    for (var i = units.length - 1; i >= 0; i--) {
      if (units[i].lit === null) return i;
    }
    return -1;
  }

  function joinUnits(units) {
    var out = '';
    // Word-final "ee" is written "i" in practice: कभी -> kabhi, नहीं -> nahin.
    var finalIndex = lastSyllableIndex(units);
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (u.lit !== null) { out += u.lit; continue; }
      var vowel = (i === finalIndex && u.v === 'ee') ? 'i' : u.v;
      // Nasalised "e" is spelt "ei" in practice: में -> mein, बहनें -> bahnein.
      if (u.nasal && vowel === 'e') vowel = 'ei';
      out += u.c + vowel;
      if (u.nasal) {
        var next = units[i + 1];
        var nextCons = (next && next.lit === null) ? next.c : '';
        out += /^[pbm]/.test(nextCons) ? 'm' : 'n';
      }
      out += u.tail;
    }
    return out;
  }

  // Whole words the rules get wrong and that turn up often enough to matter.
  // Add to this rather than bending the heuristics for one-off cases.
  var EXCEPTIONS = {
    'सिंह': 'singh',
    'रोशनी': 'roshni'
  };

  function romanizeRun(run) {
    var exact = EXCEPTIONS[run.normalize('NFC')];
    if (exact !== undefined) return exact;

    var units = parseRun(run.normalize('NFD'));
    applySchwaDeletion(units);
    return joinUnits(units);
  }

  function romanize(text) {
    var src = String(text == null ? '' : text);
    if (!hasDevanagari(src)) return src;

    var out = '';
    var i = 0;
    while (i < src.length) {
      if (!isDevanagariChar(src[i])) {
        out += src[i];
        i++;
        continue;
      }
      var j = i;
      while (j < src.length && isDevanagariChar(src[j])) j++;
      out += romanizeRun(src.slice(i, j));
      i = j;
    }
    return out;
  }

  root.YTMLTranslit = { romanize: romanize, hasDevanagari: hasDevanagari };
})(typeof self !== 'undefined' ? self : this);
