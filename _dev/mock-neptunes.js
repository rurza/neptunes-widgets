/*
 * Dev-only mock of the window.NepTunes bridge for iterating widgets in a browser.
 * Not shipped inside any .nepget bundle.
 *
 * installNepTunesMock(win, opts) installs window.NepTunes on `win` and returns a
 * controller { nextTrack, togglePlay, stop, quitPlayer, setSignedOut, setSettings,
 * emitThemeChange, state }.
 *   opts.onSetSize(width, height)  — called when the widget requests a resize.
 *   opts.signedOut                 — start in the signed-out (Last.fm) state.
 *   opts.track                     — stage a specific {title, artist, album, duration}
 *                                    ahead of the built-in rotation, so a caller that
 *                                    needs a *particular* track (preview shots) does
 *                                    not have to reach in and patch state afterwards.
 *   opts.artwork                   — data URL used as that track's cover, instead of
 *                                    the generated gradient.
 *   opts.playerState               — 2 playing (default) or 3 paused; 1 starts stopped at the
 *                                    end of the queue (last track kept), 0 starts with no
 *                                    player running at all (see quitPlayer).
 *   opts.onActivatePlayer(launched) — called on every activatePlayer(); `launched` is true
 *                                    when no player was running and the mock started one.
 *   opts.latency                   — ms before every new-API promise settles (default 150;
 *                                    tests pass 0).
 *   opts.firstWeekday              — 1…7, ISO (1 = Monday). Default: the browser locale's
 *                                    week info.
 *   opts.historyDays               — how many days of listening history exist (default 21).
 *   opts.permissions               — the manifest's permissions. Given, lastFm.call/image
 *                                    without `lastFm` and history without `listeningHistory`
 *                                    reject with permissionDenied, as the app does. Omitted,
 *                                    nothing is gated.
 *   opts.supportsMotionArtwork     — the manifest's `supportsMotionArtwork`. Only then (and with
 *                                    the `artwork` permission, when permissions are given) does
 *                                    the track carry `motionArtworkURL`.
 *   opts.motionArtwork             — the user's "Animated cover" choice for the widget (default
 *                                    true, as in the app). Controller: setMotionArtwork(bool).
 *   opts.motionArtworkURL          — the loop to hand out instead of _dev/motion-artwork-sample.mp4,
 *                                    a 4 s 320×320 H.264 gradient generated with ffmpeg's lavfi
 *                                    (no third-party footage). The app hands out a
 *                                    neptunes-media:// URL for the album's real loop instead.
 * Controller also: setFirstWeekday(n), setHistoryUnavailable(bool), pointerMove(x, y),
 * pointerLeave(), setMotionArtwork(bool), activations (how many times the widget called
 * activatePlayer()).
 *
 * Two different "nothing playing" states, because the host sends two:
 *   stop()       — the player is running but stopped at the end of its queue. playerState 1,
 *                  playerType set, and the last track is still in the state (as Apple Music
 *                  leaves it); stop({ clearTrack: true }) drops the track too.
 *   quitPlayer() — no player running. playerState 0 (unknown — NOT 1), and both `track` and
 *                  `playerType` are absent, so NepTunes.track and NepTunes.playerType are null.
 *                  A widget's "Nothing playing" empty state is for this. activatePlayer() then
 *                  "launches" the last-used player: it comes back paused on its last track.
 *
 * isWidgetVisible(manifest, state, showSetting) — whether the host would have the widget on
 * screen: while a player has a track playing or paused, or always when the widget's effective
 * Show setting is Always (see effectiveAlwaysVisible). offersShowSetting(manifest) — whether the
 * app offers the Show picker for it at all.
 *
 * Symbols: set win.__NEPTUNES_SYMBOL_CACHE__ before loading this file to supply the
 * sfsymbols-cache.json contents directly. A page built with setContent() has no base
 * URL to resolve the cache against, and silently falling back to the hand-drawn SVGs
 * below would ship look-alike glyphs — which is exactly what that cache exists to stop.
 */
(function (global) {
  'use strict';

  var TRACKS = [
    { title: 'Honey', artist: 'Robyn', album: 'Honey', duration: 230, color: '#E0392B' },
    { title: 'The Less I Know the Better', artist: 'Tame Impala', album: 'Currents', duration: 216, color: '#2D6CDF' },
    { title: 'Blue', artist: 'Joni Mitchell', album: 'Blue', duration: 184, color: '#1DB954' },
    { title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', duration: 330, color: '#F2C744' }
  ];

  function coverDataURL(track) {
    if (!track.color || typeof document === 'undefined') return null;   // a staged track brings its own artwork; Node has no canvas
    var c = document.createElement('canvas');
    c.width = c.height = 300;
    var ctx = c.getContext('2d');
    var g = ctx.createLinearGradient(0, 0, 300, 300);
    g.addColorStop(0, track.color);
    g.addColorStop(1, shade(track.color, -40));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 300, 300);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '700 34px -apple-system, system-ui, sans-serif';
    ctx.fillText(track.album.slice(0, 12), 22, 270);
    return c.toDataURL('image/jpeg', 0.9);
  }

  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = clamp((n >> 16) + amt), gg = clamp(((n >> 8) & 255) + amt), b = clamp((n & 255) + amt);
    return 'rgb(' + r + ',' + gg + ',' + b + ')';
  }
  function clamp(v) { return Math.max(0, Math.min(255, v)); }

  /*
   * SF Symbols stand-ins. The native bridge rasterises real symbols through AppKit;
   * nothing outside the app can. Without a `symbol()` here, sfsymbols.js throws on
   * `window.NepTunes.symbol` being undefined, swallows it in its own try/catch, and
   * EVERY icon in EVERY widget silently stays blank in the harness — which reads as
   * "my widget is broken" rather than "the mock is thin". These are rough 24x24
   * look-alikes: good enough to check layout, sizing, tint and state swaps, not a
   * substitute for looking at the real thing.
   */
  var SYMBOL_SHAPES = {
    'play.fill': '<polygon points="7,4 20,12 7,20"/>',
    'pause.fill': '<rect x="6.5" y="4.5" width="4" height="15" rx="1.2"/><rect x="13.5" y="4.5" width="4" height="15" rx="1.2"/>',
    'backward.end.fill': '<rect x="4" y="5" width="3" height="14" rx="1.2"/><polygon points="20,5 20,19 8.5,12"/>',
    'forward.end.fill': '<rect x="17" y="5" width="3" height="14" rx="1.2"/><polygon points="4,5 4,19 15.5,12"/>',
    'shuffle': '<path d="M3 7h4l10 10h3M3 17h4l10-10h3" fill="none" stroke="CLR" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><polygon points="18.5,3.5 22.5,7 18.5,10.5"/><polygon points="18.5,13.5 22.5,17 18.5,20.5"/>',
    'repeat': '<path d="M6.5 8h10a3 3 0 0 1 3 3v1M17.5 16h-10a3 3 0 0 1-3-3v-1" fill="none" stroke="CLR" stroke-width="2" stroke-linecap="round"/><polygon points="15,4.5 19,8 15,11.5"/><polygon points="9,12.5 5,16 9,19.5"/>',
    'heart': '<path d="M12 20.2C12 20.2 4 15 4 9.4A4.4 4.4 0 0 1 12 6.9a4.4 4.4 0 0 1 8 2.5c0 5.6-8 10.8-8 10.8z" fill="none" stroke="CLR" stroke-width="2" stroke-linejoin="round"/>',
    'heart.fill': '<path d="M12 20.2C12 20.2 4 15 4 9.4A4.4 4.4 0 0 1 12 6.9a4.4 4.4 0 0 1 8 2.5c0 5.6-8 10.8-8 10.8z"/>',
    'speaker': '<polygon points="3,9 6.5,9 11,4.8 11,19.2 6.5,15 3,15"/>',
    'speaker.slash': '<polygon points="3,9 6.5,9 11,4.8 11,19.2 6.5,15 3,15"/><line x1="14" y1="8" x2="21" y2="16" stroke="CLR" stroke-width="2" stroke-linecap="round"/>',
    'music.note': '<path d="M9.4 17.5V6.2l9-1.9v10.4" fill="none" stroke="CLR" stroke-width="2" stroke-linejoin="round"/><ellipse cx="6.6" cy="17.6" rx="3.3" ry="2.7"/><ellipse cx="15.6" cy="14.7" rx="3.3" ry="2.7"/>'
  };

  // speaker.wave.1/2/3 differ only in how many arcs trail the cone.
  (function () {
    var cone = SYMBOL_SHAPES['speaker'];
    var arcs = [
      '<path d="M13.6 9.6a3.6 3.6 0 0 1 0 4.8" fill="none" stroke="CLR" stroke-width="1.9" stroke-linecap="round"/>',
      '<path d="M16.4 7.4a7.2 7.2 0 0 1 0 9.2" fill="none" stroke="CLR" stroke-width="1.9" stroke-linecap="round"/>',
      '<path d="M19.2 5.2a10.8 10.8 0 0 1 0 13.6" fill="none" stroke="CLR" stroke-width="1.9" stroke-linecap="round"/>'
    ];
    for (var n = 1; n <= 3; n++) SYMBOL_SHAPES['speaker.wave.' + n] = cone + arcs.slice(0, n).join('');
  })();

  // repeat.1 is `repeat` with a numeral dropped in the middle.
  SYMBOL_SHAPES['repeat.1'] = SYMBOL_SHAPES['repeat'] +
    '<text x="12" y="15.2" font-size="9" font-weight="600" text-anchor="middle" fill="CLR"' +
    ' font-family="-apple-system, system-ui, sans-serif">1</text>';

  function svgFallback(name, size, color) {
    // Unknown names get a dot rather than nothing, so a typo'd data-symbol is visible
    // as "wrong glyph" instead of masquerading as "icons don't work in the harness".
    var shape = SYMBOL_SHAPES[name] || '<circle cx="12" cy="12" r="5"/>';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' +
      (size * 2) + '" height="' + (size * 2) + '" fill="' + color + '">' +
      shape.split('CLR').join(color) + '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /*
   * Real SF Symbols, rendered ahead of time by _dev/make-symbol-cache.swift into
   * _dev/sfsymbols-cache.json. Nothing in a browser can rasterise SF Symbols, and the
   * hand-drawn SVGs above — while better than blank icons — are close enough to be
   * misleading: they made V3's control rows look wrong when the widget was fine.
   *
   * The cache holds one WHITE, square, aspect-fit template per symbol; the tint is applied
   * here with a `source-atop` fill over a blackened glyph, which is what renderSFSymbol does
   * natively (its template draws black).
   */
  var SCRIPT_URL = typeof document !== 'undefined' && document.currentScript && document.currentScript.src;
  var SYMBOL_CACHE_URL = SCRIPT_URL ? SCRIPT_URL.replace(/[^/]*$/, 'sfsymbols-cache.json') : 'sfsymbols-cache.json';
  // Next to this script, like the symbol cache: the widget's page has its own base URL.
  var MOTION_SAMPLE_URL = SCRIPT_URL ? SCRIPT_URL.replace(/[^/]*$/, 'motion-artwork-sample.mp4') : 'motion-artwork-sample.mp4';
  var symbolCachePromise = null;

  function symbolCache() {
    if (!symbolCachePromise) {
      // Pre-seeded by the caller (preview shots) — no fetch, no silent SVG fallback.
      if (global.__NEPTUNES_SYMBOL_CACHE__) {
        symbolCachePromise = Promise.resolve(global.__NEPTUNES_SYMBOL_CACHE__);
        return symbolCachePromise;
      }
      symbolCachePromise = fetch(SYMBOL_CACHE_URL)
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });   // file:// or not generated yet -> SVGs
    }
    return symbolCachePromise;
  }

  function tintTemplate(templateURL, size, color) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var px = Math.max(1, Math.round(size * 2));   // retina, like the native PNG
        var canvas = document.createElement('canvas');
        canvas.width = px;
        canvas.height = px;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, px, px);
        ctx.globalCompositeOperation = 'source-atop';
        // Natively the template draws BLACK and the tint is filled source-atop over it, so a
        // translucent tint does not make a translucent glyph: rgba(255,255,255,.4) comes out
        // an opaque 40% grey (SFSymbolRasterizer, measured). Blacken first to match, or the
        // harness shows a white note where the app draws a dark one.
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, px, px);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, px, px);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = function () { resolve(null); };
      img.src = templateURL;
    });
  }

  function mockSymbol(name, options) {
    options = options || {};
    var size = options.size || 18;
    var color = options.color || '#ffffff';
    return symbolCache().then(function (cache) {
      var template = cache && cache[name];
      if (!template) return svgFallback(name, size, color);
      return tintTemplate(template, size, color).then(function (url) {
        return url || svgFallback(name, size, color);
      });
    });
  }

  /* ---- Shared mock data and plumbing for the request/response APIs below. */
  var MOCK_ARTISTS = ['Robyn', 'Tame Impala', 'Joni Mitchell', 'Massive Attack', 'Caribou', 'Aphex Twin', 'Burial', 'Four Tet', 'SBTRKT', 'Bonobo'];
  var MOCK_ALBUMS = ['Honey', 'Currents', 'Blue', 'Mezzanine', 'Swim', 'Drukqs', 'Untrue', 'Rounds', 'SBTRKT', 'Black Sands'];
  var MOCK_TRACKS = ['Honey', 'Borderline', 'A Case of You', 'Teardrop', 'Odessa', 'Avril 14th', 'Archangel', 'Angel Echoes', 'Wildfire', 'Kiara'];
  var MOCK_USER = 'neptunesfan';
  var MOCK_GENRES = ['Pop', 'Electronic', 'Indie', 'Folk', 'Trip-Hop', 'Ambient'];
  var DAY_MS = 86400000;

  function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function localDateKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function clampInt(v, dflt, lo, hi) { var n = parseInt(v, 10); return isNaN(n) ? dflt : Math.max(lo, Math.min(hi, n)); }
  function nextMidnight(midnight) { var d = new Date(midnight); d.setDate(d.getDate() + 1); return d; }

  function bridgeError(code, message) { var e = new Error(message || code); e.code = code; return e; }
  /** Settles like the bridge does: asynchronously, after `latency` ms, rejecting what `work` throws. */
  function later(latency, work) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () { try { resolve(work()); } catch (e) { reject(e); } }, latency);
    });
  }
  /** The manifest gate. `null` permissions (no manifest to read) lets everything through. */
  function requirePermission(env, permission) {
    var granted = env.permissions;
    if (granted && granted.indexOf(permission) < 0)
      throw bridgeError('permissionDenied', 'This widget\'s manifest doesn\'t declare the `' + permission + '` permission.');
  }

  /* ---- Last.fm passthrough: the app's rules (LastFmPassthroughPolicy, LastFmImagePolicy and
     WidgetLastFmPassthroughScript), reproduced so the mock refuses what the app refuses. */
  var LASTFM_READ_PACKAGES = ['user', 'library', 'album', 'artist', 'track', 'tag', 'chart', 'geo'];
  var LASTFM_STRIPPED_PARAMS = ['api_key', 'api_sig', 'sk', 'format', 'callback', 'method'];
  var LASTFM_MAX_PARAMS = 20, LASTFM_MAX_KEY = 32, LASTFM_MAX_VALUE = 1024;
  var LASTFM_IMAGE_HOSTS = ['lastfm.freetls.fastly.net', 'lastfm-img2.akamaized.net'];
  var LASTFM_IMAGE_MAX_URL = 2048;

  /** `<package>.<verb>`: a listed package, and a verb of ASCII letters that starts with `get`. */
  function lastFmMethodAllowed(method) {
    var m = /^([a-z]+)\.(get[A-Za-z]+)$/.exec(typeof method === 'string' ? method : '');
    return !!m && LASTFM_READ_PACKAGES.indexOf(m[1]) >= 0;
  }

  /** What reaches Last.fm: strings (numbers and booleans converted, as the bridge does), keys
      that look like Last.fm parameter names, no credential or transport keys, bounded values,
      and at most 20 of them, by key. */
  function lastFmParams(params) {
    var out = {};
    if (!params || typeof params !== 'object' || Array.isArray(params)) return out;
    Object.keys(params).sort().forEach(function (key) {
      var value = params[key];
      if (typeof value === 'number' && isFinite(value)) value = String(value);
      else if (typeof value === 'boolean') value = value ? '1' : '0';
      if (typeof value !== 'string' || value.length > LASTFM_MAX_VALUE) return;
      if (key.length > LASTFM_MAX_KEY || !/^[a-z][a-z0-9_]*$/.test(key)) return;
      if (LASTFM_STRIPPED_PARAMS.indexOf(key) >= 0) return;
      if (Object.keys(out).length < LASTFM_MAX_PARAMS) out[key] = value;
    });
    return out;
  }

  /** https on Last.fm's image hosts only: no credentials, no port but 443, a bounded length. */
  function lastFmImageAllowed(url) {
    if (typeof url !== 'string' || !url || url.length > LASTFM_IMAGE_MAX_URL) return false;
    var parsed;
    try { parsed = new URL(url); } catch (e) { return false; }
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password &&
      (parsed.port === '' || parsed.port === '443') &&
      LASTFM_IMAGE_HOSTS.indexOf(parsed.hostname.toLowerCase()) >= 0;
  }
  function lastFmImages(seed) {
    var id = hash(seed).toString(16);
    return [['small', '34s'], ['medium', '64s'], ['large', '174s'], ['extralarge', '300x300']].map(function (s) {
      return { size: s[0], '#text': 'https://lastfm.freetls.fastly.net/i/u/' + s[1] + '/' + id + '.png' };
    });
  }
  /** Stands in for the fetched image: a flat colour per URL, so different covers look different. */
  function placeholderImage(seed) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="hsl(' +
      (hash(seed) % 360) + ',55%,45%)"/></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /** Plays on one local day, deterministic per date so a reload paints the same grid. */
  function playsOnDay(midnight, salt) {
    var h = hash(localDateKey(midnight) + salt);
    return h % 6 === 0 ? 0 : 1 + (h % 45);
  }

  /** The instants of `n` plays spread over one local day, 08:00 to 23:00. */
  function playTimes(midnight, n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(midnight.getTime() + 8 * 3600000 + Math.floor(i * 15 * 3600000 / n));
    return out;
  }

  /** Every mock scrobble in [fromMs, toMs), newest first. */
  function scrobblesBetween(fromMs, toMs) {
    var out = [];
    var day = new Date(toMs); day.setHours(0, 0, 0, 0);
    for (; nextMidnight(day).getTime() > fromMs; day.setDate(day.getDate() - 1)) {
      var times = playTimes(day, playsOnDay(day, 'lfm'));
      for (var i = times.length - 1; i >= 0; i--) {
        if (times[i] < fromMs || times[i] >= toMs) continue;
        var k = hash(localDateKey(day) + i);
        out.push({ at: times[i], title: MOCK_TRACKS[k % MOCK_TRACKS.length],
                   artist: MOCK_ARTISTS[(k >>> 3) % MOCK_ARTISTS.length], album: MOCK_ALBUMS[(k >>> 6) % MOCK_ALBUMS.length] });
      }
    }
    return out;
  }

  function recentTracksBody(params, env) {
    var now = Date.now();
    var limit = clampInt(params.limit, 50, 1, 200);
    var page = clampInt(params.page, 1, 1, 1e6);
    var toMs = params.to ? Math.min(Number(params.to) * 1000, now) : now;
    var fromMs = Math.max(params.from ? Number(params.from) * 1000 : 0, now - 400 * DAY_MS);
    var all = scrobblesBetween(fromMs, toMs);
    var track = all.slice((page - 1) * limit, page * limit).map(function (s) {
      return { artist: { mbid: '', '#text': s.artist }, name: s.title, album: { mbid: '', '#text': s.album },
               image: lastFmImages(s.album), url: '',
               date: { uts: String(Math.floor(s.at / 1000)), '#text': new Date(s.at).toUTCString() } };
    });
    var playing = env.nowPlaying();
    if (page === 1 && playing) {
      track.unshift({ artist: { mbid: '', '#text': playing.artist }, name: playing.title,
                      album: { mbid: '', '#text': playing.album }, image: lastFmImages(playing.album),
                      url: '', '@attr': { nowplaying: 'true' } });
    }
    return { recenttracks: { track: track, '@attr': {
      user: params.user || MOCK_USER, page: String(page), perPage: String(limit),
      totalPages: String(Math.max(1, Math.ceil(all.length / limit))), total: String(all.length) } } };
  }

  function topBody(kind, params) {
    var limit = clampInt(params.limit, 50, 1, 1000);
    var list = kind === 'albums' ? MOCK_ALBUMS : kind === 'artists' ? MOCK_ARTISTS : MOCK_TRACKS;
    var items = list.slice(0, limit).map(function (name, i) {
      var item = { name: name, playcount: String(540 - i * 41), url: '', image: lastFmImages(name), '@attr': { rank: String(i + 1) } };
      if (kind !== 'artists') item.artist = { name: MOCK_ARTISTS[i % MOCK_ARTISTS.length], mbid: '', url: '' };
      return item;
    });
    var inner = { '@attr': { user: params.user || MOCK_USER, page: '1', perPage: String(limit), totalPages: '1', total: String(items.length) } };
    inner[kind.slice(0, -1)] = items;
    var body = {}; body['top' + kind] = inner;
    return body;
  }

  /** The reads the mock can answer, in Last.fm's own JSON shape (numbers as strings). */
  var LASTFM_MOCK_METHODS = {
    'user.getInfo': function (p) {
      var name = p.user || MOCK_USER;
      return { user: { name: name, realname: 'Nep Tunes', playcount: '48213', artist_count: '1872',
                       track_count: '14021', album_count: '3344', country: 'Poland',
                       registered: { unixtime: '1239494400', '#text': 1239494400 },
                       image: lastFmImages(name), url: 'https://www.last.fm/user/' + name } };
    },
    'user.getRecentTracks': recentTracksBody,
    'user.getTopAlbums': function (p) { return topBody('albums', p); },
    'user.getTopArtists': function (p) { return topBody('artists', p); },
    'user.getTopTracks': function (p) { return topBody('tracks', p); }
  };

  /* ---- Listening history: the §3 contract (WidgetHistoryBridge + HistoryQueries) over
     deterministic plays. */
  var HISTORY_GROUPS = ['day', 'hour', 'weekday', 'artist', 'album', 'track', 'genre', 'none'];
  var HISTORY_TIME_GROUPS = ['day', 'hour', 'weekday'];
  var HISTORY_SORTS = ['plays', 'seconds', 'key'];
  var HISTORY_ENTITY_LIMIT = 50, HISTORY_MAX_LIMIT = 1000;
  var HISTORY_RECENT_LIMIT = 50, HISTORY_RECENT_MAX = 200;

  /** A Date goes over the bridge as toISOString(), an invalid one as "Invalid Date". */
  function isoArgument(value) {
    if (!(value instanceof Date)) return value;
    return isNaN(value.getTime()) ? String(value) : value.toISOString();
  }
  /** HistoryJSON.date(from:): an ISO 8601 instant with a zone, fractional seconds optional. A
      bare date, or anything else, is NaN. */
  function parseInstant(value) {
    var m = typeof value === 'string' &&
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
    if (!m) return NaN;
    var zone = m[3] === 'Z' ? 'Z' : m[3].slice(0, 3) + ':' + m[3].slice(-2);
    return Date.parse(m[1] + (m[2] ? m[2].slice(0, 4) : '') + zone);
  }
  /** `undefined` and `null` both mean "not given", as the bridge reads them. */
  function given(value) { return value !== undefined && value !== null; }
  /** A whole number ≥ 1 (not a boolean), as WidgetHistoryBridge.positiveInteger accepts. */
  function positiveInteger(value) {
    return typeof value === 'number' && isFinite(value) && value >= 1 && value === Math.round(value) && value <= 2147483647;
  }

  /** Recorded plays, oldest first. Recording "began" `days` days ago, with a play that day. */
  function recordedPlays(days) {
    var out = [], now = Date.now();
    var day = new Date(now); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - (days - 1));
    for (var d = 0; d < days; d++, day.setDate(day.getDate() + 1)) {
      var times = playTimes(day, d === 0 ? Math.max(1, playsOnDay(day, 'nt')) : playsOnDay(day, 'nt'));
      for (var i = 0; i < times.length && times[i] <= now; i++) {
        var k = hash(localDateKey(day) + '#' + i);
        var artist = MOCK_ARTISTS[k % MOCK_ARTISTS.length];
        var duration = 150 + (k % 240);
        var listened = k % 7 !== 0;
        out.push({ at: times[i], title: MOCK_TRACKS[(k >>> 4) % MOCK_TRACKS.length], artist: artist,
                   album: MOCK_ALBUMS[(k >>> 8) % MOCK_ALBUMS.length], genre: MOCK_GENRES[hash(artist) % MOCK_GENRES.length],
                   duration: duration, seconds: listened ? duration : Math.round(duration * 0.2),
                   listened: listened, skipped: !listened, player: k % 3 === 0 ? 'spotify' : 'appleMusic' });
      }
    }
    return out;
  }

  /** The keys a row of this grouping owns (HistoryTotalsRow's encoding). */
  function historyRowKey(groupBy, p) {
    var d = new Date(p.at);   // the browser's zone stands in for "where the play happened"
    switch (groupBy) {
      case 'day': return { date: localDateKey(d) };
      case 'hour': return { hour: d.getHours() };
      case 'weekday': return { weekday: d.getDay() || 7 };   // ISO: 1 = Monday … 7 = Sunday
      case 'artist': return { artist: p.artist };
      case 'album': return { album: p.album, artist: p.artist };
      case 'track': return { title: p.title, artist: p.artist, album: p.album };
      case 'genre': return { genre: p.genre };
      default: return {};
    }
  }

  /** HistoryQueries' key order: the time bucket ascending, names case-insensitively. */
  function compareHistoryKeys(groupBy, a, b) {
    function text(x, y) { x = String(x).toLowerCase(); y = String(y).toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
    switch (groupBy) {
      case 'day': return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
      case 'hour': return a.hour - b.hour;
      case 'weekday': return a.weekday - b.weekday;
      case 'artist': return text(a.artist, b.artist);
      case 'album': return text(a.album, b.album) || text(a.artist, b.artist);
      case 'track': return text(a.title, b.title) || text(a.artist, b.artist);
      case 'genre': return text(a.genre, b.genre);
      default: return 0;
    }
  }

  function makeHistory(env) {
    var cache = null;
    function all() { return cache || (cache = recordedPlays(env.historyDays)); }
    function open() {
      requirePermission(env, 'listeningHistory');
      if (env.historyUnavailable()) throw bridgeError('unavailable', 'Listening history is turned off');
    }
    function invalid(message) { return bridgeError('invalidQuery', message); }

    return {
      info: function () {
        return later(env.latency, function () {
          open();
          var p = all();
          return { since: p.length ? new Date(p[0].at).toISOString() : null,
                   plays: p.filter(function (x) { return x.listened; }).length };
        });
      },
      query: function (options) {
        var q = options || {};
        var args = { from: isoArgument(q.from), to: isoArgument(q.to), groupBy: q.groupBy, sort: q.sort, limit: q.limit };
        return later(env.latency, function () {
          open();
          var from = parseInstant(args.from), to = parseInstant(args.to);
          if (isNaN(from)) throw invalid('from must be an ISO 8601 instant');
          if (isNaN(to)) throw invalid('to must be an ISO 8601 instant');
          if (!(to > from)) throw invalid('to must be later than from');
          if (HISTORY_GROUPS.indexOf(args.groupBy) < 0) throw invalid('groupBy must be one of: ' + HISTORY_GROUPS.join(', '));
          if (given(args.sort) && HISTORY_SORTS.indexOf(args.sort) < 0) throw invalid('sort must be one of: ' + HISTORY_SORTS.join(', '));
          if (given(args.limit) && !positiveInteger(args.limit)) throw invalid('limit must be a positive whole number');

          var groups = {}, rows = [];
          all().forEach(function (p) {
            if (p.at < from || p.at >= to) return;
            var row = historyRowKey(args.groupBy, p), id = JSON.stringify(row);
            if (!groups[id]) { row.plays = 0; row.seconds = 0; groups[id] = row; rows.push(row); }
            if (p.listened) groups[id].plays += 1;
            groups[id].seconds += p.seconds;
          });
          // A bucket with no plays is absent; the overall total is always exactly one row.
          if (args.groupBy === 'none' && !rows.length) rows = [{ plays: 0, seconds: 0 }];
          var isTime = HISTORY_TIME_GROUPS.indexOf(args.groupBy) >= 0;
          var sort = given(args.sort) ? args.sort : (isTime ? 'key' : 'plays');
          var other = sort === 'plays' ? 'seconds' : 'plays';
          rows.sort(function (a, b) {
            if (sort !== 'key') return (b[sort] - a[sort]) || (b[other] - a[other]) || compareHistoryKeys(args.groupBy, a, b);
            return compareHistoryKeys(args.groupBy, a, b);
          });
          // Time buckets and the overall total are never cut; entity groups are ranked and cut.
          if (!isTime && args.groupBy !== 'none')
            rows = rows.slice(0, Math.min(given(args.limit) ? args.limit : HISTORY_ENTITY_LIMIT, HISTORY_MAX_LIMIT));
          return { rows: rows };
        });
      },
      recent: function (options) {
        var q = options || {};
        var args = { limit: q.limit, before: given(q.before) ? isoArgument(q.before) : undefined };
        return later(env.latency, function () {
          open();
          if (given(args.limit) && !positiveInteger(args.limit)) throw invalid('limit must be a positive whole number');
          var before = given(args.before) ? parseInstant(args.before) : Infinity;
          if (isNaN(before)) throw invalid('before must be an ISO 8601 instant');
          var limit = Math.min(given(args.limit) ? args.limit : HISTORY_RECENT_LIMIT, HISTORY_RECENT_MAX);
          var p = all(), out = [];
          for (var i = p.length - 1; i >= 0 && out.length < limit; i--) {
            if (p[i].at >= before) continue;
            out.push({ startedAt: new Date(p[i].at).toISOString(), title: p[i].title, artist: p[i].artist,
                       album: p[i].album, seconds: p[i].seconds, duration: p[i].duration,
                       player: p[i].player, listened: p[i].listened, skipped: p[i].skipped });
          }
          return { plays: out };
        });
      }
    };
  }

  /* ---- Pointer: coalesced and de-duplicated exactly like WidgetPointerCoalescer — whole CSS
     pixels, a move only when the pixel changed, at most 30 a second with a trailing flush of the
     parked move, and a pointerleave that is never delayed. */
  function makePointer(emit) {
    var INTERVAL = 1000 / 30;
    var last = null, lastAt = -Infinity, pending = null, timer = null;
    function send(p, at) {
      last = p; lastAt = at; pending = null;
      if (timer) { clearTimeout(timer); timer = null; }
      emit('pointermove', { x: p.x, y: p.y });
    }
    return {
      move: function (x, y) {
        var p = { x: Math.floor(x), y: Math.floor(y) }, at = Date.now();
        if (last && last.x === p.x && last.y === p.y) { pending = null; return; }
        if (at - lastAt < INTERVAL) {
          pending = p;
          if (!timer) timer = setTimeout(function () { timer = null; if (pending) send(pending, Date.now()); }, lastAt + INTERVAL - at);
          return;
        }
        send(p, at);
      },
      leave: function () {
        pending = null;
        if (timer) { clearTimeout(timer); timer = null; }
        if (last) { last = null; emit('pointerleave'); }
      }
    };
  }

  /** The browser locale's first day of the week, ISO-numbered; Monday when it can't say. */
  function systemFirstWeekday() {
    try {
      var loc = new Intl.Locale((typeof navigator !== 'undefined' && navigator.language) || 'en-US');
      var info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
      if (info && info.firstDay >= 1 && info.firstDay <= 7) return info.firstDay;   // already ISO
    } catch (e) { /* older engines: fall through */ }
    return 1;
  }

  function installNepTunesMock(win, opts) {
    opts = opts || {};
    var listeners = { statechange: [], settingschange: [], themechange: [] };
    var idx = 0;
    var playing = opts.playerState !== 3 && opts.playerState !== 1 && opts.playerState !== 0;
    // Stopped at the end of the queue: the player still runs, and (unless `stopClearsTrack`)
    // still reports its last track.
    var stopped = opts.playerState === 1;
    var stopClearsTrack = false;
    // No player running: the host omits `track` and `playerType` altogether and sends
    // playerState 0. Only a widget whose Show setting is Always is on screen to see this.
    var playerRunning = opts.playerState !== 0;
    var activations = 0;
    var loved = false;
    var volume = 70;
    var muted = false;
    var shuffle = false;
    // Host repeat modes are 1 = all, 2 = one, 3 = off. This used to publish 0, which is
    // not a mode the bridge ever sends, so a widget mapping the real values saw nothing.
    var repeatMode = 3;
    var signedOut = !!opts.signedOut;
    var firstWeekday = opts.firstWeekday || systemFirstWeekday();
    var historyUnavailable = false;
    var motionArtworkOn = opts.motionArtwork !== false;
    var motionArtworkURL = opts.motionArtworkURL || MOTION_SAMPLE_URL;
    var env = {
      latency: opts.latency == null ? 150 : opts.latency,
      historyDays: opts.historyDays == null ? 21 : opts.historyDays,
      permissions: Array.isArray(opts.permissions) ? opts.permissions : null,
      signedOut: function () { return signedOut; },
      historyUnavailable: function () { return historyUnavailable; },
      nowPlaying: function () { return playerRunning && playing && !stopped ? tracks[idx] : null; }
    };
    // A staged track leads the rotation, so `next`/`previous` still work behind it.
    var tracks = opts.track ? [opts.track].concat(TRACKS) : TRACKS;
    var covers = tracks.map(function (t, i) {
      return (i === 0 && opts.artwork) ? opts.artwork : coverDataURL(t);
    });

    function hasTrack() { return playerRunning && !(stopped && stopClearsTrack); }

    // WidgetMotionArtwork.wantsMotionArtwork: the manifest declares support, the artwork permission
    // is granted (ungated when the mock was given no permissions), and the user has not turned it off.
    function wantsMotionArtwork() {
      return opts.supportsMotionArtwork === true && motionArtworkOn &&
        (!env.permissions || env.permissions.indexOf('artwork') >= 0);
    }

    function buildState() {
      if (!playerRunning) {
        return {
          playerState: 0,
          playerPosition: 0,
          timestamp: new Date().toISOString(),
          volume: volume, isMuted: muted, shuffleEnabled: shuffle,
          firstWeekday: firstWeekday,
          capabilities: { canLove: false, canDislike: false, canRate: false, canAddToLibrary: false, hasThreeStateRepeat: false }
        };
      }
      if (stopped && stopClearsTrack) {
        return {
          playerState: 1,
          playerType: 'appleMusic',
          playerPosition: 0,
          timestamp: new Date().toISOString(),
          volume: volume, isMuted: muted, shuffleEnabled: shuffle,
          firstWeekday: firstWeekday,
          capabilities: { canLove: false, canDislike: false, canRate: false, canAddToLibrary: false, hasThreeStateRepeat: false }
        };
      }
      var t = tracks[idx];
      var track = { title: t.title, artist: t.artist, album: t.album, albumArtist: t.artist, duration: t.duration, isLoved: loved };
      // As the host: only while the widget wants motion artwork, and absent (not null) otherwise.
      if (wantsMotionArtwork()) track.motionArtworkURL = motionArtworkURL;
      return {
        track: track,
        playerState: stopped ? 1 : (playing ? 2 : 3),
        playerPosition: 0,
        timestamp: new Date().toISOString(),
        volume: volume, isMuted: muted, shuffleEnabled: shuffle, repeatMode: repeatMode,
        rating: 0, isLoved: loved, isDisliked: false,
        playerType: 'appleMusic',
        firstWeekday: firstWeekday,
        capabilities: { canLove: true, canDislike: true, canRate: true, canAddToLibrary: false, hasThreeStateRepeat: true }
      };
    }

    var NepTunes = {
      state: buildState(),
      settings: opts.settings || {},
      get track() { return (this.state && this.state.track) || null; },
      get isPlaying() { return this.state.playerState === 2; },
      get isPaused() { return this.state.playerState === 3; },
      get isStopped() { return this.state.playerState === 1; },
      get volume() { return this.state.volume; },
      get isMuted() { return this.state.isMuted; },
      // `|| null`, as the bridge's getter: with no player the key is absent, the getter null.
      get playerType() { return (this.state && this.state.playerType) || null; },
      get capabilities() { return this.state.capabilities; },
      getArtworkDataURL: function () { return hasTrack() ? covers[idx] : null; },
      // As the bridge: read off the state, so it changes exactly when a statechange says so.
      getMotionArtworkURL: function () { return (this.state && this.state.track && this.state.track.motionArtworkURL) || null; },
      on: function (evt, cb) { (listeners[evt] || (listeners[evt] = [])).push(cb); },
      off: function (evt, cb) { var a = listeners[evt] || []; var i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); },
      _emit: function (evt, data) { (listeners[evt] || []).forEach(function (cb) { try { cb(data); } catch (e) { console.error(e); } }); },
      _signalReady: function () {},
      setSize: function (w, h) { if (opts.onSetSize) opts.onSetSize(w, h); },
      // With no player running there is nothing to send transport to; activatePlayer() is
      // how a widget brings one up.
      playPause: function () {
        if (!playerRunning) return;
        if (stopped) { stopped = false; playing = true; } else playing = !playing;
        refresh();
      },
      next: function () { ctl.nextTrack(); },
      previous: function () {
        if (!playerRunning) return;
        stopped = false; idx = (idx + tracks.length - 1) % tracks.length; refresh();
      },
      // Stateful, so a widget that renders volume/shuffle/repeat can actually be driven
      // here. These were no-ops, which made any such control look dead in the harness.
      setVolume: function (v) { volume = Math.max(0, Math.min(100, Math.round(v))); refresh(); },
      increaseVolume: function () { NepTunes.setVolume(volume + 5); },
      decreaseVolume: function () { NepTunes.setVolume(volume - 5); },
      toggleMute: function () { muted = !muted; refresh(); },
      toggleLove: function () { loved = !loved; refresh(); },
      toggleDislike: function () {}, increaseRating: function () {}, decreaseRating: function () {},
      removeRating: function () {}, setRating: function () {},
      toggleShuffle: function () { shuffle = !shuffle; refresh(); },
      // off -> all -> one -> off, the cycle the real players walk.
      toggleRepeat: function () { repeatMode = repeatMode === 3 ? 1 : (repeatMode === 1 ? 2 : 3); refresh(); },
      // Brings the running player forward — or, with none running, launches the last-used one,
      // which comes up paused on its last track (the app's order: current player, last active,
      // preferred, Apple Music).
      activatePlayer: function () {
        activations++;
        var launched = !playerRunning;
        if (launched) {
          playerRunning = true; stopped = false; stopClearsTrack = false; playing = false;
        }
        if (typeof console !== 'undefined') {
          console.log('[mock] activatePlayer() — ' + (launched ? 'launched Apple Music (paused)' : 'brought the player forward'));
        }
        if (opts.onActivatePlayer) opts.onActivatePlayer(launched);
        if (launched) refresh();
      },
      switchPlayer: function () {},
      symbol: mockSymbol,
      lastFm: makeLastFm(env),
      history: makeHistory(env)
    };

    function refresh() {
      NepTunes.state = buildState();
      NepTunes._emit('statechange', NepTunes.state);
    }

    var pointer = makePointer(function (evt, data) { NepTunes._emit(evt, data); });

    // Mirror the native bridge, which re-broadcasts automatic system light/dark switches
    // as `themechange`. Without this the harness can't reproduce the one thing widgets
    // most often get wrong about theming — reacting to a flip they didn't ask for.
    if (win.matchMedia) {
      var mq = win.matchMedia('(prefers-color-scheme: dark)');
      var fire = function (e) { NepTunes._emit('themechange', { dark: !!e.matches }); };
      if (mq.addEventListener) mq.addEventListener('change', fire);
      else if (mq.addListener) mq.addListener(fire);
    }

    var ctl = {
      get state() { return NepTunes.state; },
      get activations() { return activations; },
      nextTrack: function () {
        if (!playerRunning) return;
        stopped = false; idx = (idx + 1) % tracks.length; refresh();
      },
      togglePlay: function () { NepTunes.playPause(); },
      // The player stopped at the end of its queue. It keeps running and, unless
      // `clearTrack`, keeps reporting the last track. Play/next/previous start playback again.
      stop: function (o) {
        playerRunning = true; stopped = true; playing = false;
        stopClearsTrack = !!(o && o.clearTrack);
        refresh();
      },
      // No player running at all: playerState 0, no track, no playerType.
      quitPlayer: function () {
        playerRunning = false; stopped = false; stopClearsTrack = false; playing = false;
        refresh();
      },
      setSignedOut: function (v) { signedOut = !!v; },
      setSettings: function (s) { NepTunes.settings = s; NepTunes._emit('settingschange', s); },
      // Force a themechange without touching the real system appearance.
      emitThemeChange: function (dark) { NepTunes._emit('themechange', { dark: !!dark }); },
      setFirstWeekday: function (n) { firstWeekday = n; refresh(); },
      setHistoryUnavailable: function (v) { historyUnavailable = !!v; },
      // The user flipping "Animated cover" in the widget's settings: the host re-pushes state.
      setMotionArtwork: function (on) { motionArtworkOn = !!on; refresh(); },
      // The host reports the pointer only to a widget with "pointerTracking": true; the harness
      // decides that from the manifest and forwards the iframe's own mousemove here.
      pointerMove: function (x, y) { pointer.move(x, y); },
      pointerLeave: function () { pointer.leave(); }
    };

    win.NepTunes = NepTunes;
    return ctl;
  }

  function makeLastFm(env) {
    function guard(data) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          if (env.signedOut()) reject(new Error('Not signed in to Last.fm'));
          else resolve(data);
        }, 180);
      });
    }
    var artists = MOCK_ARTISTS, albums = MOCK_ALBUMS, tracks = MOCK_TRACKS;
    return {
      // The general passthrough. The narrow methods below are unchanged, as in the app.
      call: function (method, params) {
        var clean = lastFmParams(params);
        return later(env.latency, function () {
          requirePermission(env, 'lastFm');
          if (!lastFmMethodAllowed(method)) throw bridgeError('methodNotAllowed', String(method) + ' isn\'t a read-only Last.fm method');
          if ((method.indexOf('user.') === 0 || method.indexOf('library.') === 0) && !clean.user && env.signedOut())
            throw bridgeError('notSignedIn', 'This method needs a Last.fm user: pass `user`, or sign in to Last.fm in NepTunes.');
          var build = LASTFM_MOCK_METHODS[method];
          if (!build) throw bridgeError('lastFm:3', 'The dev mock does not model ' + method + ' — add it to _dev/mock-neptunes.js');
          return build(clean, env);
        });
      },
      image: function (url) {
        return later(env.latency, function () {
          requirePermission(env, 'lastFm');
          if (!lastFmImageAllowed(url)) throw bridgeError('urlNotAllowed', 'Only https images on Last.fm\'s image hosts can be loaded.');
          return placeholderImage(url);
        });
      },
      getUserInfo: function () {
        return guard({ name: 'neptunesfan', realName: 'Nep Tunes', country: 'PL', playcount: 48213, artistCount: 1872, trackCount: 14021, albumCount: 3344, registeredDate: '2009-04-12T00:00:00Z' });
      },
      getTopAlbums: function (period, limit) {
        return guard(albums.slice(0, +limit || 10).map(function (n, i) { return { name: n, artist: artists[i % artists.length], playcount: 320 - i * 27, imageURL: null }; }));
      },
      getTopArtists: function (period, limit) {
        return guard(artists.slice(0, +limit || 10).map(function (n, i) { return { name: n, playcount: 540 - i * 41, match: 1 - i * 0.05, imageURL: null }; }));
      },
      getTopTracks: function (period, limit) {
        return guard(tracks.slice(0, +limit || 10).map(function (n, i) { return { name: n, artist: artists[i % artists.length], playcount: 210 - i * 18, imageURL: null }; }));
      },
      getRecentTracks: function (limit) {
        var now = Date.now();
        return guard(tracks.slice(0, +limit || 20).map(function (n, i) {
          return { name: n, artist: artists[i % artists.length], album: albums[i % albums.length], imageURL: null, date: i === 0 ? null : Math.floor((now - i * 9 * 60000) / 1000), isNowPlaying: i === 0, isLoved: i % 4 === 0 };
        }));
      },
      getArtistInfo: function (artist) {
        return guard({ name: artist, listeners: 1284322, playcount: 49281733, userPlaycount: 412, tags: ['electronic', 'pop', 'dance'], bio: 'A widely acclaimed artist.', similar: [] });
      },
      getTrackInfo: function (track, artist) {
        return guard({ name: track, artist: artist, listeners: community(track), playcount: 9281733, userPlaycount: 42, userLoved: false, tags: ['electronic'], wiki: null });
      },
      loveTrack: function () { return guard({ success: true }); },
      unloveTrack: function () { return guard({ success: true }); }
    };
  }
  function community(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return 100000 + (h % 900000); }

  // The app offers a widget the "Show" picker (While music is playing / Always) only when its
  // manifest says it handles nothing playing: "alwaysVisible" (default Always) or
  // "supportsNoPlayback" (default While music is playing).
  function offersShowSetting(manifest) {
    return !!(manifest && (manifest.alwaysVisible === true || manifest.supportsNoPlayback === true));
  }

  // The widget's effective Show setting, as a boolean "Always". `showSetting` is the user's
  // override — 'always' | 'playback' — or absent. A widget without the picker is never Always,
  // whatever an override says (an update may have dropped its support).
  function effectiveAlwaysVisible(manifest, showSetting) {
    if (!offersShowSetting(manifest)) return false;
    if (showSetting === 'always' || showSetting === 'playback') return showSetting === 'always';
    return manifest.alwaysVisible === true;
  }

  // The app offers a widget the "Animated cover" switch only when its manifest declares
  // "supportsMotionArtwork": true AND it has the `artwork` permission (WidgetManifest.offersMotionArtwork).
  function offersMotionArtwork(manifest) {
    return !!(manifest && manifest.supportsMotionArtwork === true &&
              Array.isArray(manifest.permissions) && manifest.permissions.indexOf('artwork') >= 0);
  }

  // Playback that puts a widget up: a player, a track in it, and playing or paused. Stopped at
  // the end of the queue (1, with the last track still there) and unknown (0) are not
  // (WidgetPlaybackVisibility.hasPlayback in NepTunesKit).
  function hasPlayback(state) {
    return !!(state && state.track && state.playerType &&
              (state.playerState === 2 || state.playerState === 3));
  }

  // The host keeps a widget on screen while there is playback, and always when its effective
  // Show setting is Always.
  function isWidgetVisible(manifest, state, showSetting) {
    return effectiveAlwaysVisible(manifest, showSetting) || hasPlayback(state);
  }

  global.installNepTunesMock = installNepTunesMock;
  global.isWidgetVisible = isWidgetVisible;
  global.offersShowSetting = offersShowSetting;
  global.effectiveAlwaysVisible = effectiveAlwaysVisible;
  global.offersMotionArtwork = offersMotionArtwork;
  if (typeof module === 'object' && module.exports) {
    module.exports = {
      installNepTunesMock: installNepTunesMock,
      isWidgetVisible: isWidgetVisible,
      offersShowSetting: offersShowSetting,
      effectiveAlwaysVisible: effectiveAlwaysVisible,
      offersMotionArtwork: offersMotionArtwork
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
