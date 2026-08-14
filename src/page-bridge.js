/*
 * Runs in the page's MAIN world (see manifest content_scripts "world").
 *
 * The isolated content script can read the DOM but not the YouTube player's
 * JS API, which is the most reliable source of the current track. This script
 * lives in the page world, reads that API plus the media session, and answers
 * postMessage requests from the content script.
 *
 * If the browser is too old to support "world", this file simply ends up in
 * the isolated world instead: the player API is then invisible, the reply
 * comes back with whatever the media session gives, and nothing breaks.
 */
(function () {
  'use strict';

  var REQUEST = 'ytml-page-request';
  var RESPONSE = 'ytml-page-response';

  function clean(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  function stripTopic(name) {
    return clean(name).replace(/\s*-\s*Topic$/i, '');
  }

  // #movie_player is normally in the light DOM, but look through open shadow
  // roots too in case a future layout moves it.
  function findPlayer() {
    var direct = document.getElementById('movie_player');
    if (direct) return direct;

    var stack = [document];
    var seen = 0;
    while (stack.length && seen < 4000) {
      var node = stack.shift();
      var hit = null;
      try {
        hit = node.querySelector('#movie_player, .html5-video-player, ytmusic-player');
      } catch (e) { /* ignore */ }
      if (hit && typeof hit.getVideoData === 'function') return hit;
      if (hit && !stack.length) stack.push(hit);

      var all = [];
      try { all = node.querySelectorAll('*'); } catch (e) { /* ignore */ }
      for (var i = 0; i < all.length && seen < 4000; i++, seen++) {
        if (all[i].shadowRoot) stack.push(all[i].shadowRoot);
      }
    }
    return direct;
  }

  // Whole seconds, 0 for anything the player cannot pin down — a live stream
  // reports Infinity and a track whose metadata has not landed reports NaN.
  function seconds(value) {
    var n = Math.round(Number(value));
    return isFinite(n) && n > 0 ? n : 0;
  }

  function fromPlayerApi() {
    var player = findPlayer();
    if (!player) return null;

    var out = { title: '', artist: '', album: '', videoId: '', duration: 0 };

    try {
      var data = typeof player.getVideoData === 'function' ? player.getVideoData() : null;
      if (data) {
        out.title = clean(data.title);
        out.artist = stripTopic(data.author);
        out.videoId = clean(data.video_id);
      }
    } catch (e) { /* ignore */ }

    try {
      out.duration = typeof player.getDuration === 'function' ? seconds(player.getDuration()) : 0;
    } catch (e) { /* ignore */ }

    try {
      var response = typeof player.getPlayerResponse === 'function' ? player.getPlayerResponse() : null;
      var details = response && response.videoDetails;
      if (details) {
        out.title = out.title || clean(details.title);
        out.artist = out.artist || stripTopic(details.author);
        out.videoId = out.videoId || clean(details.videoId);
        out.duration = out.duration || seconds(details.lengthSeconds);
      }
    } catch (e) { /* ignore */ }

    return (out.title || out.artist) ? out : null;
  }

  function fromMediaSession() {
    try {
      var meta = navigator.mediaSession && navigator.mediaSession.metadata;
      if (!meta) return null;
      var out = {
        title: clean(meta.title),
        artist: stripTopic(meta.artist),
        album: clean(meta.album),
        videoId: ''
      };
      return (out.title || out.artist) ? out : null;
    } catch (e) {
      return null;
    }
  }

  /*
   * Clicking a synced lyric line jumps the player. Setting video.currentTime
   * from the isolated world does move it, but seekTo() is what YouTube's own
   * controls call: it keeps the player's internal position, its progress bar
   * and its buffering in step, which a bare currentTime write can leave behind.
   * The content script falls back to the video element if this answers false.
   */
  function seekTo(time) {
    var seconds = Number(time);
    if (!isFinite(seconds) || seconds < 0) return false;

    var player = findPlayer();
    if (!player || typeof player.seekTo !== 'function') return false;
    try {
      player.seekTo(seconds, true);
      return true;
    } catch (e) {
      return false;
    }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.type !== REQUEST || typeof msg.nonce !== 'string') return;

    // No action means the original read request, which is all this used to do.
    if (msg.action === 'seek') {
      window.postMessage({
        type: RESPONSE,
        nonce: msg.nonce,
        seeked: seekTo(msg.time)
      }, location.origin);
      return;
    }

    window.postMessage({
      type: RESPONSE,
      nonce: msg.nonce,
      playerApi: fromPlayerApi(),
      mediaSession: fromMediaSession()
    }, location.origin);
  });
})();
