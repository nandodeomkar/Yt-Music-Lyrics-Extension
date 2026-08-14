/*
 * Plain-node test runner for the pure logic (no browser APIs involved).
 *   node test/run-tests.js
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

function load(file, sandbox) {
  const code = fs.readFileSync(path.join(SRC, file), 'utf8');
  new Function('self', code)(sandbox);
  return sandbox;
}

const sandbox = {};
load('translit.js', sandbox);
load('common.js', sandbox);

const { romanize } = sandbox.YTMLTranslit;
const YTML = sandbox.YTML;

let passed = 0;
let failed = 0;

function check(label, got, expected) {
  if (got === expected) {
    passed++;
  } else {
    failed++;
    console.log(`FAIL  ${label}\n        got:      ${got}\n        expected: ${expected}`);
  }
}

function group(name) {
  console.log(`\n--- ${name} ---`);
}

/* ------------------------------------------------------------ translit */

group('transliteration');

const TRANSLIT_CASES = [
  ['दिल', 'dil'],
  ['धड़कन', 'dhadkan'],
  ['नमकीन', 'namkeen'],
  ['कमल', 'kamal'],
  ['प्यार', 'pyaar'],
  ['मित्र', 'mitra'],
  ['ज़िंदगी', 'zindagi'],
  ['रंग', 'rang'],
  ['कंपनी', 'kampani'],
  ['हिंदी', 'hindi'],
  ['ज्ञान', 'gyaan'],
  ['सलमान', 'salmaan'],
  ['बरसात', 'barsaat'],
  ['मैं', 'main'],
  ['हूँ', 'hoon'],
  ['क्या', 'kyaa'],
  ['चाँद', 'chaand'],
  ['सुबह', 'subah'],
  ['आँखों', 'aankhon'],
  ['मोहब्बत', 'mohabbat'],
  ['मतलब', 'matlab'],
  ['सरकार', 'sarkaar'],
  ['बचपन', 'bachpan'],
  ['तमन्ना', 'tamannaa'],
  ['बेवफ़ा', 'bevafaa'],
  ['नहीं', 'nahin'],
  ['कभी', 'kabhi'],
  ['और', 'aur'],
  ['एक', 'ek'],
  ['है', 'hai'],
  ['हैं', 'hain'],
  ['तेरे बिना', 'tere binaa'],
  ['रास्ता', 'raastaa'],
  ['करना', 'karnaa'],
  ['मुसकुराहट', 'muskuraahat'],
  ['तसवीर', 'tasveer'],
  ['जगह', 'jagah'],
  ['बहुत', 'bahut'],
  ['समझ', 'samajh'],
  ['आवाज़', 'aavaaz'],
  ['में', 'mein'],
  ['ख़्वाब', 'khvaab'],
  ['इश्क़', 'ishq'],
  ['दुनिया', 'duniyaa'],
  ['पहचान', 'pahchaan'],
  ['बादशाह', 'baadshaah'],
  ['दोस्त', 'dost'],
  ['शब्द', 'shabd'],
  ['सत्य', 'satya'],
  ['वक़्त', 'vaqt'],
  ['आदमी', 'aadmi'],
  ['बादल', 'baadal'],
  ['शानदार', 'shaandaar'],
  ['साजन', 'saajan'],
  ['बेसहारा', 'besahaaraa'],
  ['चाहत', 'chaahat'],
  ['जानवर', 'jaanvar'],
  ['मंत्र', 'mantra'],
  ['१२३ अंक', '123 ank'],
  ['Tera Ban Jaunga (तेरा)', 'Tera Ban Jaunga (teraa)'],
  ['no devanagari here', 'no devanagari here'],
];

for (const [input, expected] of TRANSLIT_CASES) {
  check(input, romanize(input), expected);
}

/* --------------------------------------------------------- title clean */

group('title cleanup');

check('official video',
  YTML.cleanTitle('Kesariya (Official Video)'), 'Kesariya');
check('lyrical suffix',
  YTML.cleanTitle('Tum Hi Ho | Official Lyrical Video'), 'Tum Hi Ho');
check('from movie',
  YTML.cleanTitle('Kesariya (From "Brahmastra")'), 'Kesariya');
check('full video song',
  YTML.cleanTitle('Channa Mereya - Full Video Song'), 'Channa Mereya');
check('plain title untouched',
  YTML.cleanTitle('Apna Bana Le'), 'Apna Bana Le');
check('source extracted',
  YTML.extractSource('Kesariya (From "Brahmastra")'), 'Brahmastra');

/* ------------------------------------------------------- credit rolls */

const CREDITS = 'Odhani Odh Ke Nachu Lyrical Video Song | Tere Naam | Udit N |Alka Y | Sameer |Salman Khan,Bhoomika C';

check('a credit roll keeps only the song',
  YTML.cleanTitle(CREDITS), 'Odhani Odh Ke Nachu');
check('the film comes out of the credits',
  YTML.creditedSource(CREDITS), 'Tere Naam');
check('the credits are split off whole',
  YTML.splitTitleCredits(CREDITS).credits.length, 5);
check('a title without pipes has no credits',
  YTML.splitTitleCredits('Apna Bana Le').credits.length, 0);
check('a two-part title still yields a film',
  YTML.creditedSource('Kesariya | Brahmastra'), 'Brahmastra');
check('trailing format words go',
  YTML.cleanTitle('Tum Hi Ho Full Video HD'), 'Tum Hi Ho');
check('a real trailing Song survives',
  YTML.cleanTitle('Swan Song'), 'Swan Song');
check('a trailing Song goes when it follows a format word',
  YTML.cleanTitle('Odhani Odh Ke Nachu Lyrical Song'), 'Odhani Odh Ke Nachu');
check('the credited film reaches the normalized song',
  YTML.normalizeSong({ title: CREDITS }, YTML.DEFAULTS).source, 'Tere Naam');
check('an explicit From still wins over the credits',
  YTML.normalizeSong({ title: 'Kesariya (From "Brahmastra") | Something Else' }, YTML.DEFAULTS).source,
  'Brahmastra');

check('primary artist only',
  YTML.cleanArtist('Arijit Singh, Pritam & Amitabh Bhattacharya'), 'Arijit Singh');
check('feat stripped',
  YTML.cleanArtist('Badshah feat. Aastha Gill'), 'Badshah');

check('byline noise: views', YTML.isNoiseByline('1.2M views'), true);
check('byline noise: year', YTML.isNoiseByline('2013'), true);
check('byline real artist', YTML.isNoiseByline('Arijit Singh'), false);

/* ------------------------------------------------------------ provider */

group('provider urls');

const song = {
  title: 'Kesariya (From "Brahmastra")',
  artist: 'Arijit Singh, Pritam',
  album: 'Brahmastra'
};
const settings = Object.assign({}, YTML.DEFAULTS);

check('query built',
  YTML.buildQuery(song, settings), 'Kesariya Arijit Singh');
check('query with album',
  YTML.buildQuery(song, Object.assign({}, settings, { includeAlbum: true })),
  'Kesariya Arijit Singh Brahmastra');
check('devanagari title romanized for search',
  YTML.buildQuery({ title: 'केसरिया', artist: 'अरिजीत सिंह' }, settings),
  'kesariyaa arijeet singh');

check('google url',
  YTML.providerUrl('google', song, settings),
  'https://www.google.com/search?q=Kesariya%20Arijit%20Singh%20lyrics%20english');
check('genius url',
  YTML.providerUrl('genius', song, settings),
  'https://genius.com/search?q=Kesariya%20Arijit%20Singh');
check('unknown provider falls back to google',
  YTML.providerUrl('nope', song, settings).startsWith('https://www.google.com/search?q='),
  true);
check('panel url carries the song',
  YTML.providerUrl('panel', song, settings),
  'lyrics.html?title=Kesariya&artist=Arijit+Singh&album=Brahmastra');
check('panel url keeps the raw title and source when present',
  YTML.providerUrl('panel', Object.assign({ source: 'Brahmastra', rawTitle: 'Kesariya (Official)' }, song), settings),
  'lyrics.html?title=Kesariya&artist=Arijit+Singh&album=Brahmastra&source=Brahmastra&raw=Kesariya+%28Official%29');

check('sidebar resolves to the same panel page as the tab',
  YTML.providerUrl('sidebar', song, settings),
  YTML.providerUrl('panel', song, settings));

/* ---------------------------------------------------------- resolution */

group('song resolution');

check('a label in the artist slot is spotted',
  YTML.isLabelArtist('T-Series'), true);
check('so is a records company',
  YTML.isLabelArtist('Zee Music Company'), true);
check('a real singer is not a label',
  YTML.isLabelArtist('Arijit Singh'), false);

check('overlap is full when every word survives',
  YTML.titleOverlap('Odhani Odh Ke Nachu', 'Odhani Odh Ke Nachu'), 1);
check('extra words in the catalogue title do not count against it',
  YTML.titleOverlap('Odhani', 'Odhani Odh Ke Nachu'), 1);
check('a missing word costs half of a two-word title',
  YTML.titleOverlap('Odhani Nachu', 'Odhani'), 0.5);
check('nothing in common is zero',
  YTML.titleOverlap('Kesariya', 'Tum Hi Ho'), 0);
check('overlap survives punctuation and case',
  YTML.titleOverlap('Tum Hi Ho!', 'tum hi ho'), 1);

const upload = YTML.normalizeSong({ title: CREDITS, artist: 'T-Series', duration: 409 }, YTML.DEFAULTS);

check('a credit-roll upload is worth resolving',
  YTML.looksUnreliable(upload), true);
check('a label artist alone is worth resolving',
  YTML.looksUnreliable(YTML.normalizeSong({ title: 'Kesariya', artist: 'T-Series' }, YTML.DEFAULTS)), true);
check('a missing artist is worth resolving',
  YTML.looksUnreliable(YTML.normalizeSong({ title: 'Kesariya' }, YTML.DEFAULTS)), true);
check('a clean catalogue entry is left alone',
  YTML.looksUnreliable(YTML.normalizeSong({ title: 'Kesariya', artist: 'Arijit Singh' }, YTML.DEFAULTS)), false);
check('a From suffix does not make an entry suspicious',
  YTML.looksUnreliable(YTML.normalizeSong(
    { title: 'Kesariya (From "Brahmastra")', artist: 'Arijit Singh' }, YTML.DEFAULTS)), false);

check('the search term drops the label and keeps the film',
  YTML.itunesTerm(upload), 'Odhani Odh Ke Nachu Tere Naam');
check('the search term keeps a real artist',
  YTML.itunesTerm(YTML.normalizeSong({ title: 'Kesariya', artist: 'Arijit Singh' }, YTML.DEFAULTS)),
  'Kesariya Arijit Singh');
check('the search term does not repeat itself',
  YTML.itunesTerm({ title: 'Tere Naam', artist: '', source: 'Tere Naam' }), 'Tere Naam');

const RIGHT = { trackName: 'Odhani Odh Ke Nachu', artistName: 'Udit Narayan',
                collectionName: 'Tere Naam', trackTimeMillis: 410000 };
const REMIX = { trackName: 'Odhani Odh Ke Nachu (Remix)', artistName: 'DJ Someone',
                collectionName: 'Party Hits', trackTimeMillis: 232000 };
const OTHER = { trackName: 'Tumse Milna', artistName: 'Udit Narayan',
                collectionName: 'Tere Naam', trackTimeMillis: 405000 };

check('the runtime picks the original over the remix',
  YTML.scoreItunesCandidate(RIGHT, upload) > YTML.scoreItunesCandidate(REMIX, upload), true);
check('the right track is chosen from a mixed list',
  YTML.pickItunesMatch([REMIX, OTHER, RIGHT], upload).title, 'Odhani Odh Ke Nachu');
check('the match carries the catalogue artist',
  YTML.pickItunesMatch([REMIX, OTHER, RIGHT], upload).artist, 'Udit Narayan');
check('the match carries the catalogue runtime in seconds',
  YTML.pickItunesMatch([REMIX, OTHER, RIGHT], upload).duration, 410);

check('a wrong-title candidate is refused outright',
  YTML.pickItunesMatch([OTHER], upload), null);
check('a remix alone is refused rather than accepted as the song',
  YTML.pickItunesMatch([REMIX], upload), null);
check('an empty catalogue answer resolves to nothing',
  YTML.pickItunesMatch([], upload), null);
check('a non-array answer resolves to nothing',
  YTML.pickItunesMatch(null, upload), null);

const noRuntime = YTML.normalizeSong({ title: CREDITS, artist: 'T-Series' }, YTML.DEFAULTS);
check('without a runtime to check against, a good title is not enough',
  YTML.pickItunesMatch([RIGHT], noRuntime), null);

const applied = YTML.applyItunesMatch(upload, YTML.pickItunesMatch([RIGHT], upload));
check('the resolved title replaces the upload title', applied.title, 'Odhani Odh Ke Nachu');
check('the resolved artist replaces the label', applied.artist, 'Udit Narayan');
check('the resolved runtime wins over the video runtime', applied.duration, 410);
check('the resolution is recorded', applied.resolvedBy, 'itunes');
check('applying nothing changes nothing', YTML.applyItunesMatch(upload, null), upload);

check('a resolved song queries LRCLIB under its real name',
  YTML.lrclibQueries(YTML.normalizeSong(applied, YTML.DEFAULTS))[0].path,
  'get?track_name=Odhani%20Odh%20Ke%20Nachu&artist_name=Udit%20Narayan' +
  '&album_name=Tere%20Naam&duration=410');

/* ---------------------------------------------------------- lyricsmint */

group('lyricsmint');

const LM = fs.readFileSync(path.join(__dirname, 'fixtures', 'lyricsmint.html'), 'utf8');
const parsed = YTML.parseLyricsMint(LM);

check('the Hinglish lyrics come out',
  parsed.romanized.split('\n')[0], "Baby that's the flow");
check('the Devanagari lyrics come out separately',
  /[ऀ-ॿ]/.test(parsed.devanagari), true);
check('the two scripts do not bleed into each other',
  /[ऀ-ॿ]/.test(parsed.romanized), false);
check('stanzas are separated by a blank line',
  parsed.romanized.indexOf('\n\n') > 0, true);
check('no stanza keeps an empty line inside it',
  /\n[ \t]*\n[ \t]*\n/.test(parsed.romanized), false);
check('markup never survives into the words',
  /[<>]/.test(parsed.romanized + parsed.devanagari), false);

// The live page keeps its share and print controls in divs and buttons rather
// than paragraphs, so this guard is defensive — which is exactly why it needs
// a test of its own rather than riding on the fixture.
const FURNISHED = '<section id="lyrics">' +
  '<p data-action="click->share-button#share">Print<svg><path d="M0 0"/></svg></p>' +
  '<p>Real words here</p>' +
  '</section>';
check('share and print furniture is dropped',
  YTML.parseLyricsMint(FURNISHED).romanized, 'Real words here');
check('a path element is never mistaken for a paragraph',
  YTML.parseLyricsMint('<section id="lyrics"><p>Words<svg><path d="M1 2"/></svg></p></section>').romanized,
  '');

check('a page with no lyrics section parses to nothing',
  YTML.parseLyricsMint('<html><body><p>hello</p></body></html>').romanized, '');
check('rubbish input parses to nothing',
  YTML.parseLyricsMint(null).romanized, '');

check('the page title is recovered for verification',
  YTML.lyricsMintPageTitle(LM).indexOf('ODHANI') >= 0, true);
check('the word LYRICS is stripped from the page title',
  /\bLYRICS\b/.test(YTML.lyricsMintPageTitle(LM)), false);
const LM_TITLE = YTML.lyricsMintPageTitle(LM);

check('the page title agrees with the song we asked for',
  YTML.lyricsMintAgreement({ title: 'Odhani' }, LM_TITLE) >= 0.6, true);
check('the page title disagrees with an unrelated song',
  YTML.lyricsMintAgreement({ title: 'Kesariya' }, LM_TITLE) >= 0.6, false);
// The bug this exists to prevent: the trimmed slug finds the page, then the
// untrimmed title fails it for missing a word the page never claimed to have.
check('a title trimmed to find the page is not then failed by its own trailing word',
  YTML.lyricsMintAgreement({ title: 'Odhani Song' }, LM_TITLE) >= 0.6, true);
check('trimming does not let an unrelated song through',
  YTML.lyricsMintAgreement({ title: 'Kesariya Song' }, LM_TITLE) >= 0.6, false);

check('entities are decoded', YTML.htmlToText('Tere&nbsp;Naam &amp; more'), 'Tere Naam & more');
check('numeric entities are decoded', YTML.htmlToText('caf&#233;'), 'café');
check('breaks become newlines', YTML.htmlToText('one<br>two'), 'one\ntwo');

check('slug from a plain title', YTML.slugify('Odhani Odh Ke Nachu'), 'odhani-odh-ke-nachu');
check('slug drops punctuation', YTML.slugify("Tum Hi Ho!"), 'tum-hi-ho');
check('slug drops apostrophes without leaving a gap',
  YTML.slugify("Rockin' Rolla"), 'rockin-rolla');
check('slug of Devanagari is empty', YTML.slugify('केसरिया'), '');

const lmSong = YTML.normalizeSong(
  { title: 'Odhani', artist: 'Darshan Raval', source: 'Made in China' }, YTML.DEFAULTS);

check('the film is tried before the artist',
  YTML.lyricsMintPaths(lmSong)[0], 'made-in-china/odhani');
check('the artist is tried as a fallback owner',
  YTML.lyricsMintPaths(lmSong).indexOf('darshan-raval/odhani') > 0, true);
check('no title means no paths at all',
  YTML.lyricsMintPaths({ title: '', source: 'Made in China' }).length, 0);
check('paths are not repeated when film and album agree',
  YTML.lyricsMintPaths({ title: 'Odhani', source: 'Made in China', album: 'Made in China' }).length, 1);

const trailing = YTML.lyricsMintPaths({ title: 'Odhani Song', source: 'Made in China' });
check('the title as read is tried first',
  trailing[0], 'made-in-china/odhani-song');
check('a trailing Song is tried trimmed as well',
  trailing.indexOf('made-in-china/odhani') > 0, true);
check('a title with nothing to trim yields one path per owner',
  YTML.lyricsMintPaths({ title: 'Odhani', source: 'Made in China', artist: 'Darshan Raval' }).length, 2);
check('the number of guesses is capped',
  YTML.lyricsMintPaths({
    title: 'Some Long Song', source: 'A', album: 'B', artist: 'C'
  }).length <= 4, true);

/* -------------------------------------------------------------- lrclib */

group('lrclib lookup');

const normalized = YTML.normalizeSong(song, settings);
check('normalized title', normalized.title, 'Kesariya');
check('normalized artist', normalized.artist, 'Arijit Singh');
check('normalized keeps the movie as a source', normalized.source, 'Brahmastra');
check('normalized romanizes when asked',
  YTML.normalizeSong({ title: 'केसरिया', artist: 'अरिजीत सिंह' }, settings).title,
  'kesariyaa');
check('normalized leaves Devanagari alone when told not to',
  YTML.normalizeSong({ title: 'केसरिया' }, Object.assign({}, settings, { romanizeQuery: false })).title,
  'केसरिया');

/* --------------------------------------------------- the other script */

check('romanized title keeps the Devanagari as its alternate',
  YTML.normalizeSong({ title: 'केसरिया' }, settings).altTitle, 'केसरिया');
check('unromanized title keeps the romanization as its alternate',
  YTML.normalizeSong({ title: 'केसरिया' }, Object.assign({}, settings, { romanizeQuery: false })).altTitle,
  'kesariyaa');
check('a Latin title has no alternate script',
  YTML.normalizeSong({ title: 'Kesariya' }, settings).altTitle, '');
check('the artist gets an alternate too',
  YTML.normalizeSong({ title: 'केसरिया', artist: 'अरिजीत सिंह' }, settings).altArtist, 'अरिजीत सिंह');
check('a title romanized upstream recovers its script from the raw title',
  YTML.normalizeSong({ title: 'kesariyaa', rawTitle: 'केसरिया' }, settings).altTitle, 'केसरिया');

check('duration kept as whole seconds',
  YTML.normalizeSong({ title: 'Kesariya', duration: 268.4 }, settings).duration, '268');
check('a missing duration normalizes to nothing',
  YTML.normalizeSong({ title: 'Kesariya' }, settings).duration, '');
check('a live stream duration is discarded',
  YTML.durationParam({ duration: Infinity }), '');
check('a zero duration is discarded', YTML.durationParam({ duration: 0 }), '');

/* -------------------------------------------------------- query ladder */

const paths = YTML.lrclibQueries(normalized).map((q) => q.path);

check('structured title+artist+album query first',
  paths[0], 'search?track_name=Kesariya&artist_name=Arijit%20Singh&album_name=Brahmastra');
check('title+artist without the album second',
  paths[1], 'search?track_name=Kesariya&artist_name=Arijit%20Singh');
check('free text after the structured queries',
  paths.indexOf('search?q=Kesariya%20Arijit%20Singh') > 1, true);
check('the film name gets its own free-text query',
  paths.indexOf('search?q=Kesariya%20Brahmastra') > 0, true);
check('title-only query last',
  paths[paths.length - 1], 'search?track_name=Kesariya');
check('no exact lookup without a duration',
  paths.some((p) => p.startsWith('get?')), false);
check('no title means no queries at all',
  YTML.lrclibQueries({ title: '', artist: 'Arijit Singh' }).length, 0);
check('every query is unique',
  new Set(paths).size, paths.length);

const timed = YTML.lrclibQueries(
  YTML.normalizeSong(Object.assign({ duration: 268 }, song), settings));
const timedPaths = timed.map((q) => q.path);

check('the exact lookup leads once a duration is known',
  timedPaths[0],
  'get?track_name=Kesariya&artist_name=Arijit%20Singh&album_name=Brahmastra&duration=268');
check('exact lookup without the album comes next',
  timedPaths[1], 'get?track_name=Kesariya&artist_name=Arijit%20Singh&duration=268');
check('only the exact lookups are flagged single',
  timed.filter((q) => q.single).every((q) => q.path.startsWith('get?')), true);
check('every exact lookup is flagged single',
  timed.every((q) => q.single === q.path.startsWith('get?')), true);

const devanagari = YTML.lrclibQueries(
  YTML.normalizeSong({ title: 'केसरिया', artist: 'अरिजीत सिंह' }, settings)).map((q) => q.path);

check('the Devanagari spelling is retried after the romanized one',
  devanagari.indexOf('search?track_name=' + encodeURIComponent('केसरिया') +
                     '&artist_name=' + encodeURIComponent('अरिजीत सिंह')) > 0,
  true);
check('the romanized spelling still leads',
  devanagari[0], 'search?track_name=kesariyaa&artist_name=arijeet%20singh');

check('plain lyrics used as-is',
  YTML.plainLyricsOf({ plainLyrics: 'line one\nline two' }), 'line one\nline two');
check('lrc timestamps stripped',
  YTML.plainLyricsOf({ syncedLyrics: '[00:12.34] line one\n[00:15.00] line two' }),
  'line one\nline two');
check('repeated timestamps on one line stripped',
  YTML.plainLyricsOf({ syncedLyrics: '[00:12.34][01:40.00] chorus' }), 'chorus');
check('blank lrc lines dropped',
  YTML.plainLyricsOf({ syncedLyrics: '[00:12.34] one\n[00:14.00] \n[00:16.00] two' }),
  'one\ntwo');
check('plain lyrics win over synced',
  YTML.plainLyricsOf({ plainLyrics: 'plain', syncedLyrics: '[00:01.00] synced' }), 'plain');
check('instrumental entry has no text', YTML.plainLyricsOf({ instrumental: true }), '');

const exact = { trackName: 'Kesariya', artistName: 'Arijit Singh', plainLyrics: 'a' };
const partial = { trackName: 'Kesariya (Reprise)', artistName: 'Arijit Singh', plainLyrics: 'b' };
const wrong = { trackName: 'Something Else', artistName: 'Someone', plainLyrics: 'c' };
const instrumental = { trackName: 'Kesariya', artistName: 'Arijit Singh', instrumental: true };

check('exact match outscores partial',
  YTML.scoreLrclibResult(exact, normalized) > YTML.scoreLrclibResult(partial, normalized), true);
check('partial match outscores an unrelated track',
  YTML.scoreLrclibResult(partial, normalized) > YTML.scoreLrclibResult(wrong, normalized), true);
check('instrumental scores below the same track with lyrics',
  YTML.scoreLrclibResult(instrumental, normalized) < YTML.scoreLrclibResult(exact, normalized), true);
check('an instrumental entry never survives ranking',
  YTML.rankLrclibResults([instrumental], normalized).length, 0);

const timedSong = YTML.normalizeSong(Object.assign({ duration: 268 }, song), settings);
const sameLength = { trackName: 'Kesariya', artistName: 'Arijit Singh', duration: 267, plainLyrics: 'a' };
const wrongLength = { trackName: 'Kesariya', artistName: 'Arijit Singh', duration: 400, plainLyrics: 'a' };

check('a matching length outscores a wildly different one',
  YTML.scoreLrclibResult(sameLength, timedSong) > YTML.scoreLrclibResult(wrongLength, timedSong), true);
check('length only counts when both sides report one',
  YTML.scoreLrclibResult(sameLength, normalized), YTML.scoreLrclibResult(wrongLength, normalized));
check('a duration-matched cover beats an exact title with the wrong length',
  YTML.rankLrclibResults([wrongLength, sameLength], timedSong)[0].item.duration, 267);

const ranked = YTML.rankLrclibResults([wrong, partial, exact], normalized);
check('best match ranks first', ranked[0].item.trackName, 'Kesariya');
check('every ranked entry carries its text', ranked.length, 3);
check('entries without lyrics are dropped',
  YTML.rankLrclibResults([{ trackName: 'Kesariya', artistName: 'Arijit Singh' }], normalized).length, 0);
check('a non-array response ranks as nothing',
  YTML.rankLrclibResults(null, normalized).length, 0);

/* ------------------------------------------------------- synced lyrics */

group('synced lyrics');

const LRC = [
  '[ti:Kesariya]',
  '[ar:Arijit Singh]',
  '[00:12.34]first line',
  '[00:15.00]',
  '[00:18.50]second line',
  '[00:22.10][01:04.00]the chorus',
].join('\n');

const lrc = YTML.parseLrc(LRC);

check('metadata tags are not lyrics', lrc.length, 5);
check('the first line is timed', lrc[0].time, 12.34);
check('and carries its words', lrc[0].text, 'first line');
check('a timed blank keeps its place', lrc[1].text, '');
check('centiseconds are read as a fraction of a second', lrc[2].time, 18.5);
check('a repeated line becomes one entry per timestamp',
  lrc.filter((l) => l.text === 'the chorus').length, 2);
check('entries come out in playing order',
  lrc.every((line, i) => i === 0 || lrc[i - 1].time <= line.time), true);
check('the second showing of the chorus is where it was written',
  lrc[lrc.length - 1].time, 64);

check('minutes past ten still parse',
  YTML.parseLrc('[10:05.00]late')[0].time, 605);
check('milliseconds parse as well as centiseconds',
  YTML.parseLrc('[00:01.500]x')[0].time, 1.5);
check('a colon before the fraction is the same as a dot',
  YTML.parseLrc('[00:12:34]x')[0].time, 12.34);
check('a timestamp with no fraction is a whole second',
  YTML.parseLrc('[02:03]x')[0].time, 123);
check('word timings never reach the screen',
  YTML.parseLrc('[00:01.00]<00:01.00>one <00:01.50>two')[0].text, 'one two');

check('a positive offset shows the words sooner',
  YTML.parseLrc('[offset:+500]\n[00:10.00]x')[0].time, 9.5);
check('a negative offset holds them back',
  YTML.parseLrc('[offset:-500]\n[00:10.00]x')[0].time, 10.5);
check('an offset never pushes a line before the song starts',
  YTML.parseLrc('[offset:+5000]\n[00:01.00]x')[0].time, 0);

check('plain text is not an LRC file', YTML.parseLrc('just words\nmore words').length, 0);
check('timestamps with no words at all are an instrumental',
  YTML.parseLrc('[00:01.00]\n[00:04.00]').length, 0);
check('nothing parses to nothing', YTML.parseLrc('').length, 0);
check('rubbish parses to nothing', YTML.parseLrc(null).length, 0);
check('an unparseable line does not take the file with it',
  YTML.parseLrc('[not a time]nope\n[00:03.00]yes').length, 1);
check('carriage returns are not part of the words',
  YTML.parseLrc('[00:01.00]one\r\n[00:02.00]two')[0].text, 'one');
// collapse() strips a leading dash and a trailing comma, which would quietly
// rewrite the words of a song rather than tidy up a title.
check('a line keeps its own punctuation',
  YTML.parseLrc('[00:01.00]- and then she said,')[0].text, '- and then she said,');

check('before the first line nothing is lit', YTML.activeLineIndex(lrc, 0), -1);
check('the first line lights up exactly on its timestamp',
  YTML.activeLineIndex(lrc, 12.34), 0);
check('and stays lit until the next one', YTML.activeLineIndex(lrc, 14.99), 0);
check('the gap takes over from the line before it',
  YTML.activeLineIndex(lrc, 16), 1);
check('the last line stays lit to the end of the song',
  YTML.activeLineIndex(lrc, 9999), lrc.length - 1);
check('an unknown position lights nothing',
  YTML.activeLineIndex(lrc, NaN), -1);
check('an empty file lights nothing', YTML.activeLineIndex([], 10), -1);

check('an lrc file is recognised as timed',
  YTML.syncedLyricsOf({ syncedLyrics: '[00:01.00]x' }), '[00:01.00]x');
check('plain text in the synced field is not timed',
  YTML.syncedLyricsOf({ syncedLyrics: 'no timestamps here' }), '');
check('an instrumental entry is never timed',
  YTML.syncedLyricsOf({ instrumental: true, syncedLyrics: '[00:01.00]x' }), '');
check('a missing field is not timed', YTML.syncedLyricsOf({}), '');

const timedEntry = { trackName: 'Kesariya', artistName: 'Arijit Singh',
                     plainLyrics: 'a', syncedLyrics: '[00:01.00]a' };
const untimedEntry = { trackName: 'Kesariya', artistName: 'Arijit Singh', plainLyrics: 'a' };

check('a ranked entry carries its timings',
  YTML.rankLrclibResults([timedEntry], normalized)[0].synced, '[00:01.00]a');
check('an entry with no timings carries none',
  YTML.rankLrclibResults([untimedEntry], normalized)[0].synced, '');
check('a timed entry outranks the same track without timings',
  YTML.scoreLrclibResult(timedEntry, normalized) >
  YTML.scoreLrclibResult(untimedEntry, normalized), true);
check('the plain text of a timed entry is still the plain text',
  YTML.rankLrclibResults([timedEntry], normalized)[0].text, 'a');

/*
 * What a pinned entry can turn into. The worker fetches one entry by id and
 * hands it straight to the ranker, so whatever the ranker drops is what makes a
 * pin fall through to the ladder — with no 404 involved, and so not "stale".
 */
const instrumentalEntry = { trackName: 'Kesariya', artistName: 'Arijit Singh',
                            instrumental: true, plainLyrics: '', syncedLyrics: '' };
const syncedOnlyEntry = { trackName: 'Kesariya', artistName: 'Arijit Singh',
                          syncedLyrics: '[00:01.00]a\n[00:05.00]b' };

check('an instrumental entry ranks to nothing',
  YTML.rankLrclibResults([instrumentalEntry], normalized).length, 0);
// The ranker drops entries with no plain text, so a pinned entry that only ever
// had timings would be lost if plainLyricsOf could not derive one.
check('a timings-only entry survives the ranker',
  YTML.rankLrclibResults([syncedOnlyEntry], normalized).length, 1);
check('its plain text is derived from the timings',
  YTML.rankLrclibResults([syncedOnlyEntry], normalized)[0].text, 'a\nb');
check('and it keeps the timings themselves',
  YTML.rankLrclibResults([syncedOnlyEntry], normalized)[0].synced,
  '[00:01.00]a\n[00:05.00]b');

check('song key ignores punctuation and case',
  YTML.songKey({ title: 'Kesariya!', artist: 'Arijit  Singh' }),
  YTML.songKey({ title: 'kesariya', artist: 'ArijitSingh' }));
check('song key separates different artists',
  YTML.songKey({ title: 'Kesariya', artist: 'Arijit Singh' }) ===
  YTML.songKey({ title: 'Kesariya', artist: 'Pritam' }), false);

/* ------------------------------------------------------------ pin keys */

group('pin keys');

const ROMAN_ON = { romanizeQuery: true };
const ROMAN_OFF = { romanizeQuery: false };

const devanagariA = { title: 'तेरे बिना ज़िंदगी', artist: 'लता मंगेशकर' };
const devanagariB = { title: 'कभी कभी मेरे दिल में', artist: 'मुकेश' };

function pinKeyOf(song, settings) {
  return YTML.pinKey(YTML.normalizeSong(song, settings));
}

// songKey collapses both of these to '|', which is survivable in a cache that
// skips that key and fatal in a table that outlives the session.
check('song key still collapses Devanagari, as it always has',
  YTML.songKey(YTML.normalizeSong(devanagariA, ROMAN_OFF)), '|');
check('pin key does not collapse Devanagari',
  pinKeyOf(devanagariA, ROMAN_OFF) === '|', false);
check('pin key separates two Devanagari songs',
  pinKeyOf(devanagariA, ROMAN_OFF) === pinKeyOf(devanagariB, ROMAN_OFF), false);

// Toggling the setting must not orphan a pin, so the key romanizes either way.
check('pin key ignores romanizeQuery',
  pinKeyOf(devanagariA, ROMAN_OFF), pinKeyOf(devanagariA, ROMAN_ON));

check('pin key ignores punctuation and case',
  pinKeyOf({ title: 'Kesariya!', artist: 'Arijit  Singh' }, ROMAN_ON),
  pinKeyOf({ title: 'kesariya', artist: 'ArijitSingh' }, ROMAN_ON));

// The same recording, uploaded twice, titled by whoever uploaded it.
check('two uploads of one song share a pin key',
  pinKeyOf({
    title: 'Odhani Odh Ke Nachu Lyrical Video Song | Tere Naam | Udit N |Alka Y',
    artist: 'Alka Yagnik'
  }, ROMAN_ON),
  pinKeyOf({ title: 'Odhani Odh Ke Nachu', artist: 'Alka Yagnik' }, ROMAN_ON));

/* --------------------------------------------------------- pin records */

group('pin records');

const recordAt = (dur, id) => ({ dur: dur, id: id, off: 0, at: 1 });
const idOf = (record) => (record ? record.id : null);

const oneRecord = [recordAt(278, 11)];
const threeRecords = [recordAt(278, 11), recordAt(200, 22), recordAt(320, 33)];

check('a runtime two seconds out still matches',
  idOf(YTML.pinRecordFor(oneRecord, 276)), 11);
check('a runtime twelve seconds out does not',
  idOf(YTML.pinRecordFor(oneRecord, 290)), null);
check('the right cut is picked out of several',
  idOf(YTML.pinRecordFor(threeRecords, 321)), 33);

// The player reports a title before it reports a runtime.
check('no runtime uses a lone record',
  idOf(YTML.pinRecordFor(oneRecord, '')), 11);
check('no runtime refuses to guess between several',
  idOf(YTML.pinRecordFor(threeRecords, '')), null);
check('no records, no match',
  idOf(YTML.pinRecordFor([], 278)), null);

check('a new record goes to the front',
  YTML.pinRecordsWith(oneRecord, recordAt(200, 22))[0].id, 22);
check('re-pinning the same cut replaces it',
  YTML.pinRecordsWith(oneRecord, recordAt(279, 99)).length, 1);
check('re-pinning the same cut keeps the new id',
  YTML.pinRecordsWith(oneRecord, recordAt(279, 99))[0].id, 99);
check('a different cut is added alongside',
  YTML.pinRecordsWith(oneRecord, recordAt(200, 22)).length, 2);

const fiveDeep = [recordAt(100, 1), recordAt(200, 2), recordAt(300, 3), recordAt(400, 4)]
  .reduce((list, record) => YTML.pinRecordsWith(list, record), []);
check('the list caps at four',
  YTML.pinRecordsWith(fiveDeep, recordAt(500, 5)).length, YTML.PIN_MAX_RECORDS);
check('the cap evicts the oldest',
  YTML.pinRecordsWith(fiveDeep, recordAt(500, 5)).some((r) => r.id === 1), false);

// Nothing to supersede, so nothing is dropped.
check('a record with no runtime replaces nothing',
  YTML.pinRecordsWith(oneRecord, recordAt('', 44)).length, 2);

/* ------------------------------------------------------------- offsets */

group('offsets');

const timedLines = YTML.parseLrc('[00:10.00]one\n[00:20.00]two\n[00:30.00]three');

const lineAt = (at, off) =>
  YTML.activeLineIndex(timedLines, YTML.shiftedPosition(at, off));

check('with no offset the line that has started is lit', lineAt(20, 0), 1);
// Positive delays the words, so at 20s the second line has not arrived yet.
check('a positive offset holds the previous line', lineAt(20, 0.5), 0);
check('a negative offset brings the next one early', lineAt(20, -0.5), 1);
check('an offset larger than the position lights nothing', lineAt(1, 5), -1);

check('seeking adds the offset back on', YTML.shiftedSeek(20, 0.5), 20.5);
check('seeking never goes negative', YTML.shiftedSeek(1, -5), 0);

check('offsets snap to a quarter', YTML.clampOffset(0.3), 0.25);
check('offsets stay exact after snapping', YTML.clampOffset(0.25 * 3), 0.75);
check('offsets clamp high', YTML.clampOffset(99), YTML.OFFSET_LIMIT);
check('offsets clamp low', YTML.clampOffset(-99), -YTML.OFFSET_LIMIT);
check('a nonsense offset is no offset', YTML.clampOffset('abc'), 0);

check('zero reads plainly', YTML.formatOffset(0), '0s');
check('a positive offset is signed', YTML.formatOffset(0.25), '+0.25s');
check('a negative offset is signed', YTML.formatOffset(-1.5), '−1.5s');
check('whole seconds keep no decimals', YTML.formatOffset(2), '+2s');

/* ---------------------------------------------------------------- done */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
