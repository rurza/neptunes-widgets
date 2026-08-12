/*
 * Dev-only mock of the window.NepTunes bridge for iterating widgets in a browser.
 * Not shipped inside any .nepget bundle.
 *
 * installNepTunesMock(win, opts) installs window.NepTunes on `win` and returns a
 * controller { nextTrack, togglePlay, setSignedOut, state }.
 *   opts.onSetSize(width, height)  — called when the widget requests a resize.
 *   opts.signedOut                 — start in the signed-out (Last.fm) state.
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
   * here with a `source-atop` fill, which is what renderSFSymbol does natively.
   */
  var SYMBOL_CACHE_URL = (function () {
    var s = document.currentScript && document.currentScript.src;
    return s ? s.replace(/[^/]*$/, 'sfsymbols-cache.json') : 'sfsymbols-cache.json';
  })();
  var symbolCachePromise = null;

  function symbolCache() {
    if (!symbolCachePromise) {
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

  function installNepTunesMock(win, opts) {
    opts = opts || {};
    var listeners = { statechange: [], settingschange: [], themechange: [] };
    var idx = 0;
    var playing = true;
    var loved = false;
    var volume = 70;
    var muted = false;
    var shuffle = false;
    // Host repeat modes are 1 = all, 2 = one, 3 = off. This used to publish 0, which is
    // not a mode the bridge ever sends, so a widget mapping the real values saw nothing.
    var repeatMode = 3;
    var signedOut = !!opts.signedOut;
    var covers = TRACKS.map(coverDataURL);

    function buildState() {
      var t = TRACKS[idx];
      return {
        track: { title: t.title, artist: t.artist, album: t.album, albumArtist: t.artist, duration: t.duration, isLoved: loved },
        playerState: playing ? 2 : 3,
        playerPosition: 0,
        timestamp: new Date().toISOString(),
        volume: volume, isMuted: muted, shuffleEnabled: shuffle, repeatMode: repeatMode,
        rating: 0, isLoved: loved, isDisliked: false,
        playerType: 'appleMusic',
        capabilities: { canLove: true, canDislike: true, canRate: true, canAddToLibrary: false, hasThreeStateRepeat: true }
      };
    }

    var NepTunes = {
      state: buildState(),
      settings: opts.settings || {},
      get track() { return this.state && this.state.track; },
      get isPlaying() { return this.state.playerState === 2; },
      get isPaused() { return this.state.playerState === 3; },
      get isStopped() { return this.state.playerState === 1; },
      get volume() { return this.state.volume; },
      get isMuted() { return this.state.isMuted; },
      get playerType() { return this.state.playerType; },
      get capabilities() { return this.state.capabilities; },
      getArtworkDataURL: function () { return covers[idx]; },
      on: function (evt, cb) { (listeners[evt] || (listeners[evt] = [])).push(cb); },
      off: function (evt, cb) { var a = listeners[evt] || []; var i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); },
      _emit: function (evt, data) { (listeners[evt] || []).forEach(function (cb) { try { cb(data); } catch (e) { console.error(e); } }); },
      _signalReady: function () {},
      setSize: function (w, h) { if (opts.onSetSize) opts.onSetSize(w, h); },
      playPause: function () { playing = !playing; refresh(); },
      next: function () { ctl.nextTrack(); },
      previous: function () { idx = (idx + TRACKS.length - 1) % TRACKS.length; refresh(); },
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
      activatePlayer: function () {}, switchPlayer: function () {},
      symbol: mockSymbol,
      lastFm: makeLastFm(function () { return signedOut; })
    };

    function refresh() {
      NepTunes.state = buildState();
      NepTunes._emit('statechange', NepTunes.state);
    }

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
      nextTrack: function () { idx = (idx + 1) % TRACKS.length; refresh(); },
      togglePlay: function () { NepTunes.playPause(); },
      setSignedOut: function (v) { signedOut = !!v; },
      setSettings: function (s) { NepTunes.settings = s; NepTunes._emit('settingschange', s); },
      // Force a themechange without touching the real system appearance.
      emitThemeChange: function (dark) { NepTunes._emit('themechange', { dark: !!dark }); }
    };

    win.NepTunes = NepTunes;
    return ctl;
  }

  function makeLastFm(isSignedOut) {
    function guard(data) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          if (isSignedOut()) reject(new Error('Not signed in to Last.fm'));
          else resolve(data);
        }, 180);
      });
    }
    var artists = ['Robyn', 'Tame Impala', 'Joni Mitchell', 'Massive Attack', 'Caribou', 'Aphex Twin', 'Burial', 'Four Tet', 'SBTRKT', 'Bonobo'];
    var albums = ['Honey', 'Currents', 'Blue', 'Mezzanine', 'Swim', 'Drukqs', 'Untrue', 'Rounds', 'SBTRKT', 'Black Sands'];
    var tracks = ['Honey', 'Borderline', 'A Case of You', 'Teardrop', 'Odessa', 'Avril 14th', 'Archangel', 'Angel Echoes', 'Wildfire', 'Kiara'];
    return {
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

  global.installNepTunesMock = installNepTunesMock;
})(window);
