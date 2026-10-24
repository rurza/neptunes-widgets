/**
 * Scrobbles — lifetime scrobble counter + a live recent-tracks feed.
 *
 * Pulls Last.fm user info (lifetime playcount) and recent tracks, animates the
 * counter up to the new total, and renders a compact feed. The single accent
 * is extracted from the now-playing artwork (or a fixed color) and tints the
 * counter number and the now-playing row.
 */
(function (factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else api.start();
})(function () {
    'use strict';

    // ---- DOM ----
    // Looked up in init(), not here: Node has no document, and _dev/scrobbles.test.mjs
    // requires this file to cover the accent cache. Same shape as Vinyl and Minimal.
    var widget  = null;
    var counter = null;
    var countEl = null;
    var feed    = null;
    var status  = null;
    var root    = null;

    var SIGNED_OUT_MSG = 'Sign in to Last.fm in NepTunes settings to see your scrobbles.';
    // NepTunes 4.1.1+ says when Last.fm has accepted a scrobble (the `scrobble` event), so
    // the feed refreshes then. The slow refresh catches what the event never reports:
    // scrobbles from another device, and hosts before 4.1.1.
    var REFRESH_MS = 5 * 60 * 1000;
    var RETRY_MS = 30000;       // first retry after a failed load: the old polling cadence
    var TRACK_DEBOUNCE_MS = 5000; // a new scrobble lands shortly after a track change

    // Read in init() for the same reason as the DOM handles above.
    var prefersReducedMotion = false;

    // ---- State ----
    var settings = {};
    var refresher = null;          // built in init()
    var trackDebounce = null;      // debounce for track-change-triggered refresh
    var displayedCount = 0;        // number currently shown in #count
    var countRaf = null;           // count-up animation handle
    // Accent caching. The key is everything the painted accent depends on, so the widget
    // repaints exactly when one of them moves.
    //
    // This used to be the artwork URL on its own, and null meant two different things:
    // "nothing is playing, so there is no cover" and "settings changed, re-extract". With
    // the player paused, switching Accent from a fixed colour back to album art compared
    // null to null, took the early return, and left the fixed colour painted on the card
    // until a cover happened to turn up. The sentinel is an object so it can never be
    // equal to a key, which is always a string.
    var ACCENT_UNSET = {};
    var lastAccentKey = ACCENT_UNSET;
    var lastTrackKey = null;       // detect now-playing track changes

    // ---------------------------------------------------------------- Theme ----

    function resolveTheme(theme) {
        root.classList.remove('theme-dark', 'theme-light');
        var resolved = theme;
        if (theme === 'auto' || !theme) {
            var dark = !window.matchMedia ||
                window.matchMedia('(prefers-color-scheme: dark)').matches;
            resolved = dark ? 'dark' : 'light';
        }
        root.classList.add(resolved === 'light' ? 'theme-light' : 'theme-dark');
    }

    // --------------------------------------------------------------- Accent ----

    // The manifest's default, and what an unreadable fixedColor falls back to.
    var DEFAULT_FIXED_RGB = [255, 55, 95];

    function curDark() {
        return NTKit.panelIsDark(settings.theme);
    }

    // Cache identity for the accent currently on the card. Pure, and exported, because
    // the case that broke has no artwork URL to key on: see _dev/scrobbles.test.mjs.
    function accentKey(source, url, color, dark) {
        var panel = dark ? 'dark' : 'light';
        return source === 'fixed'
            ? 'fixed|' + panel + '|' + color
            : 'album|' + panel + '|' + (url || '');
    }

    function updateAccent() {
        var source = settings.accentSource === 'fixed' ? 'fixed' : 'album';
        var dark = curDark();
        var url = source === 'fixed' ? null : window.NepTunes.getArtworkDataURL();
        var key = accentKey(source, url, settings.fixedColor, dark);
        if (key === lastAccentKey) return;
        lastAccentKey = key;

        if (source === 'fixed') {
            var rgb = NTKit.hexToRgb(settings.fixedColor) || DEFAULT_FIXED_RGB;
            NTKit.applyAccent(root, NTKit.fixedPalette(rgb, dark), dark);
            return;
        }

        // NTKit.accent resolves a neutral palette for a missing or undecodable cover
        // rather than rejecting, so the no-artwork case needs no branch of its own.
        NTKit.accent(url).then(function (palette) {
            if (lastAccentKey !== key) return;   // settings moved on while it decoded
            NTKit.applyAccent(root, palette, dark);
        });
    }

    // ----------------------------------------------------------- Counter UI ----

    function setCount(n) {
        displayedCount = n;
        countEl.textContent = NTKit.formatCount(n);
    }

    // Animate #count from the currently shown value up to `target` (~800ms).
    function animateCount(target) {
        if (countRaf) {
            cancelAnimationFrame(countRaf);
            countRaf = null;
        }
        if (prefersReducedMotion || target === displayedCount) {
            setCount(target);
            return;
        }
        var from = displayedCount;
        var delta = target - from;
        var start = null;
        var DURATION = 800;

        function step(ts) {
            if (start === null) start = ts;
            var t = Math.min(1, (ts - start) / DURATION);
            // easeOutCubic for a settled landing
            var eased = 1 - Math.pow(1 - t, 3);
            setCount(Math.round(from + delta * eased));
            if (t < 1) {
                countRaf = requestAnimationFrame(step);
            } else {
                setCount(target);
                countRaf = null;
            }
        }
        countRaf = requestAnimationFrame(step);
    }

    // -------------------------------------------------------------- Feed UI ----

    function renderFeed(tracks) {
        feed.textContent = '';
        var limit = parseInt(settings.count, 10) || 8;

        tracks.slice(0, limit).forEach(function (t) {
            var row = document.createElement('div');
            row.className = 'row' + (t.isNowPlaying ? ' now' : '');

            // Now-playing marker (or a spacer to keep alignment).
            var marker = document.createElement('span');
            marker.className = t.isNowPlaying ? 'dot' : 'dot-spacer';
            row.appendChild(marker);

            var text = document.createElement('div');
            text.className = 'row-text';

            var name = document.createElement('div');
            name.className = 'name';
            name.textContent = t.name || 'Unknown';
            if (t.isLoved) {
                var heart = document.createElement('span');
                heart.className = 'heart';
                var heartIcon = document.createElement('img');
                heartIcon.className = 'sf-icon';
                heartIcon.dataset.symbol = 'heart.fill';
                heartIcon.dataset.size = '12';
                heart.appendChild(heartIcon);
                name.appendChild(heart);
            }

            var sub = document.createElement('div');
            sub.className = 'sub';
            sub.textContent = t.artist || '';

            text.appendChild(name);
            text.appendChild(sub);

            var when = document.createElement('span');
            when.className = 'when';
            when.textContent = t.isNowPlaying ? 'now' : NTKit.relativeTime(t.date);

            row.appendChild(text);
            row.appendChild(when);
            feed.appendChild(row);
        });
    }

    // ---- Last.fm passthrough -----------------------------------------------------
    // On an app with NepTunes.lastFm.call the widget gets Last.fm's own JSON. The feed was
    // written against what the narrow methods return — NepTunesKit's LastFmUserInfo and
    // LastFmRecentTrack, encoded by the app: absent fields omitted, dates ISO 8601 without
    // fractions. These produce exactly that; LastFmWidgetAdapterParityTests holds them to it.
    function asArray(v) { return Array.isArray(v) ? v : (v ? [v] : []); }
    function nonEmpty(v) { return typeof v === 'string' && v.length > 0 ? v : undefined; }
    function toInt(v) {
        if (typeof v === 'number') return Number.isInteger(v) ? v : undefined;
        return typeof v === 'string' && /^[+-]?\d+$/.test(v) ? parseInt(v, 10) : undefined;
    }
    function put(obj, key, value) { if (value !== undefined) obj[key] = value; return obj; }
    function isoSeconds(seconds) { return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
    function largestImage(images) {
        var list = asArray(images), sizes = ['extralarge', 'large', 'medium', 'small'];
        for (var i = 0; i < sizes.length; i++) {
            for (var j = 0; j < list.length; j++) {
                if (list[j] && list[j].size === sizes[i]) {
                    var url = nonEmpty(list[j]['#text']);
                    if (url) return url;
                    break;   // NepTunesKit looks at the first image of each size only
                }
            }
        }
        return undefined;
    }

    function adaptUserInfo(raw) {
        var u = (raw && raw.user) || {};
        var info = { name: typeof u.name === 'string' ? u.name : '', playcount: toInt(u.playcount) || 0 };
        put(info, 'realName', nonEmpty(u.realname));
        put(info, 'url', nonEmpty(u.url));
        put(info, 'imageURL', largestImage(u.image));
        put(info, 'country', nonEmpty(u.country));
        put(info, 'artistCount', toInt(u.artist_count));
        put(info, 'trackCount', toInt(u.track_count));
        put(info, 'albumCount', toInt(u.album_count));
        var registered = u.registered ? toInt(u.registered.unixtime) : undefined;
        put(info, 'registeredDate', registered === undefined ? undefined : isoSeconds(registered));
        return info;
    }

    function artistName(artist) {
        if (!artist) return '';
        if (typeof artist.name === 'string') return artist.name;
        return typeof artist['#text'] === 'string' ? artist['#text'] : '';
    }

    function adaptRecentTracks(raw) {
        var body = (raw && raw.recenttracks) || {};
        return asArray(body.track).map(function (t) {
            var track = {
                name: typeof t.name === 'string' ? t.name : '',
                artist: artistName(t.artist),
                isNowPlaying: !!(t['@attr'] && t['@attr'].nowplaying === 'true'),
                isLoved: t.loved === '1'
            };
            put(track, 'album', t.album && typeof t.album['#text'] === 'string' ? t.album['#text'] : undefined);
            put(track, 'url', nonEmpty(t.url));
            put(track, 'imageURL', largestImage(t.image));
            var uts = t.date ? toInt(t.date.uts) : undefined;
            put(track, 'date', uts === undefined ? undefined : isoSeconds(uts));
            return track;
        });
    }

    function fetchStats(lfm, limit) {
        if (typeof lfm.call === 'function') {
            return Promise.all([
                lfm.call('user.getInfo').then(adaptUserInfo),
                lfm.call('user.getRecentTracks', { limit: String(limit), extended: '1' }).then(adaptRecentTracks)
            ]);
        }
        return Promise.all([lfm.getUserInfo(), lfm.getRecentTracks(limit)]);
    }

    // ------------------------------------------------------------- Last.fm ----

    function showError() {
        widget.classList.add('errored');
        status.hidden = false;
        status.textContent = SIGNED_OUT_MSG;
    }

    function clearError() {
        widget.classList.remove('errored');
        status.hidden = true;
    }

    // The passthrough says why a load failed. Only a signed-out account replaces the feed;
    // a rate limit or network blip leaves the one on screen for the next refresh. The narrow
    // methods carry no code, so an older app keeps today's behaviour.
    function keepsFeedOnFailure(error, onScreen) {
        return !!(error && error.code && error.code !== 'notSignedIn' && onScreen);
    }

    /*
     * Runs `load` and keeps only the newest call's answer. A refresh started just before a
     * scrobble can answer after the one the scrobble started, with the older numbers; it is
     * dropped rather than painted over the newer feed. A failure is retried after `retryMs`,
     * doubling with each failure in a row up to the slow refresh, unless something else
     * refreshes first. Signed out is not retried: signing in is picked up by the refresh after
     * a track change, a settings change or the slow refresh. Pure apart from the timers, which
     * _dev/lastfm-refresh.test.mjs hands in.
     */
    function makeRefresher(opts) {
        var timers = opts.timers || {
            setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
            clearTimeout: function (id) { clearTimeout(id); },
            setInterval: function (fn, ms) { return setInterval(fn, ms); }
        };
        var latest = 0;
        var retry = null;
        var failures = 0;              // failed loads in a row, for the back-off

        function refresh() {
            var seq = ++latest;
            if (retry !== null) { timers.clearTimeout(retry); retry = null; }
            return Promise.resolve()
                .then(opts.load)
                .then(function (result) {
                    if (seq !== latest) return;
                    opts.apply(result);
                    failures = 0;
                })
                .catch(function (error) {
                    if (seq !== latest) return;
                    opts.fail(error);
                    if (error && error.code === 'notSignedIn') return;
                    var delay = Math.min(opts.retryMs * Math.pow(2, failures), REFRESH_MS);
                    failures++;
                    retry = timers.setTimeout(refresh, delay);
                });
        }

        function start() {
            timers.setInterval(refresh, REFRESH_MS);
        }

        return { refresh: refresh, start: start };
    }

    // Fetch user info + recent tracks.
    function fetchCurrentStats() {
        var limit = parseInt(settings.count, 10) || 8;
        return fetchStats(window.NepTunes.lastFm, limit);
    }

    function showStats(res) {
        clearError();
        var info = res[0] || {};
        var tracks = res[1] || [];
        animateCount(Number(info.playcount) || 0);
        renderFeed(tracks);
    }

    function showFailure(error) {
        if (keepsFeedOnFailure(error, status.hidden && feed.childElementCount > 0)) return;
        showError();
    }

    function loadStats() {
        if (!refresher || !window.NepTunes || !window.NepTunes.lastFm) return;
        refresher.refresh();
    }

    // ------------------------------------------------------------- Events ----

    // Mirror for a right-to-left host language. Applied on state rather than at startup:
    // window.NepTunes.state is null until the host's first push, which happens in
    // webView(_:didFinish:) — after DOMContentLoaded, where init() runs. Reading it at
    // startup throws TypeError every time.
    function applyDirection(state) {
        if (state && state.layoutDirection) {
            document.documentElement.dir = state.layoutDirection;
        }
    }

    function onSettings(s) {
        settings = s || {};

        resolveTheme(settings.theme);

        // Counter visibility.
        if (settings.showCounter === false) {
            counter.classList.add('hidden');
        } else {
            counter.classList.remove('hidden');
        }

        // A flipped theme, a new fixed colour or a switch of accent source all move the
        // accent key, so updateAccent() repaints on its own.
        updateAccent();
        loadStats(); // re-fetch (feed row count / fixed color may have changed)
    }

    // The desktop switched between light and dark. Only 'auto' resolves against the
    // system — an explicit dark/light choice already renders correctly. Icons re-tint
    // centrally from sfsymbols.js, so there's no SFSymbols call here.
    function onThemeChange() {
        if ((settings.theme || 'auto') !== 'auto') return;
        resolveTheme(settings.theme);
        updateAccent();
    }

    function onState() {
        // Mirror for a right-to-left host language. Applied on state rather than at
        // startup: window.NepTunes.state is null until the host's first push, which
        // happens in webView(_:didFinish:) — after DOMContentLoaded, where init() runs.
        // Reading it at startup throws TypeError every time. This handler takes no
        // parameter of its own (it reads window.NepTunes.state below like the rest of
        // the function), so applyDirection reads the same source.
        applyDirection(window.NepTunes.state);

        // Accent always tracks the now-playing artwork (or fixed color).
        updateAccent();

        // When the now-playing track changes, a fresh scrobble lands shortly
        // after — refresh, debounced so rapid skips don't spam Last.fm.
        var state = window.NepTunes.state;
        var track = state && state.track;
        var key = track ? (track.title + '' + track.artist) : null;
        if (key !== lastTrackKey) {
            lastTrackKey = key;
            if (key) {
                if (trackDebounce) clearTimeout(trackDebounce);
                trackDebounce = setTimeout(loadStats, TRACK_DEBOUNCE_MS);
            }
        }
    }

    // --------------------------------------------------------------- Init ----

    function init() {
        widget  = document.getElementById('widget');
        counter = document.getElementById('counter');
        countEl = document.getElementById('count');
        feed    = document.getElementById('feed');
        status  = document.getElementById('status');
        root    = document.documentElement;
        prefersReducedMotion =
            window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        if (!window.NepTunes) return;
        refresher = makeRefresher({ load: fetchCurrentStats, apply: showStats, fail: showFailure, retryMs: RETRY_MS });
        NepTunes.on('statechange', onState);
        NepTunes.on('settingschange', onSettings);
        NepTunes.on('themechange', onThemeChange);
        // A host before 4.1.1 keeps this listener and never calls it; the slow refresh
        // below covers that host.
        NepTunes.on('scrobble', loadStats);
        onSettings(NepTunes.settings);
        onState(NepTunes.state);
        if (NepTunes.lastFm) refresher.start();
        if (window.SFSymbols) SFSymbols.load();
        if (NepTunes._signalReady) NepTunes._signalReady();
    }

    function start() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    return { start: start, accentKey: accentKey, adaptUserInfo: adaptUserInfo, adaptRecentTracks: adaptRecentTracks, fetchStats: fetchStats, keepsFeedOnFailure: keepsFeedOnFailure, makeRefresher: makeRefresher };
});
