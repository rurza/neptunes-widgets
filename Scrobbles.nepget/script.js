/**
 * Scrobbles — lifetime scrobble counter + a live recent-tracks feed.
 *
 * Pulls Last.fm user info (lifetime playcount) and recent tracks, animates the
 * counter up to the new total, and renders a compact feed. The single accent
 * is extracted from the now-playing artwork (or a fixed color) and tints the
 * counter number and the now-playing row.
 */
(function () {
    'use strict';

    // ---- DOM ----
    var widget  = document.getElementById('widget');
    var counter = document.getElementById('counter');
    var countEl = document.getElementById('count');
    var feed    = document.getElementById('feed');
    var status  = document.getElementById('status');
    var root    = document.documentElement;

    var SIGNED_OUT_MSG = 'Sign in to Last.fm in NepTunes settings to see your scrobbles.';
    var REFRESH_MS = 30000;     // periodic refresh cadence
    var TRACK_DEBOUNCE_MS = 5000; // a new scrobble lands shortly after a track change

    var prefersReducedMotion =
        window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ---- State ----
    var settings = {};
    var inFlight = false;          // guard: never overlap Last.fm requests
    var refreshTimer = null;       // periodic interval
    var trackDebounce = null;      // debounce for track-change-triggered refresh
    var displayedCount = 0;        // number currently shown in #count
    var countRaf = null;           // count-up animation handle
    var lastArtworkURL = null;     // cache so accent only re-extracts on change
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

    function hexToRgb(hex) {
        if (typeof hex !== 'string') return null;
        var m = hex.replace('#', '');
        if (m.length === 3) m = m[0] + m[0] + m[1] + m[1] + m[2] + m[2];
        if (m.length !== 6) return null;
        var n = parseInt(m, 16);
        if (isNaN(n)) return null;
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    // Build the {accent,on,muted} palette object NTKit.applyAccent expects.
    function paletteFromRgb(rgb) {
        return {
            accent: rgb,
            on: NTKit.onColor(rgb),
            muted: rgb.map(function (v) { return Math.round(v * 0.5 + 55); })
        };
    }

    function curDark() {
        return NTKit.panelIsDark(settings.theme);
    }

    function applyFixedAccent() {
        var rgb = hexToRgb(settings.fixedColor) || [255, 55, 95];
        NTKit.applyAccent(root, paletteFromRgb(rgb), curDark());
        lastArtworkURL = null; // so switching back to album re-extracts
    }

    // Re-extract the accent only when the artwork data URL actually changes.
    function updateAccent() {
        if (settings.accentSource === 'fixed') {
            applyFixedAccent();
            return;
        }
        var url = window.NepTunes.getArtworkDataURL();
        if (url === lastArtworkURL) return;
        lastArtworkURL = url;

        if (!url) {
            NTKit.applyAccent(root, paletteFromRgb([124, 124, 132]), curDark());
            return;
        }
        NTKit.accent(url).then(function (palette) {
            // Ignore if the source flipped to fixed while we were extracting.
            if (settings.accentSource === 'fixed') return;
            NTKit.applyAccent(root, palette, curDark());
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

    // Fetch user info + recent tracks. Guarded against overlap.
    function loadStats() {
        if (inFlight || !window.NepTunes || !window.NepTunes.lastFm) return;
        inFlight = true;

        var limit = parseInt(settings.count, 10) || 8;
        var lfm = window.NepTunes.lastFm;

        Promise.all([lfm.getUserInfo(), lfm.getRecentTracks(limit)])
            .then(function (res) {
                clearError();
                var info = res[0] || {};
                var tracks = res[1] || [];
                animateCount(Number(info.playcount) || 0);
                renderFeed(tracks);
            })
            .catch(function () {
                // Promise rejects when the user is signed out of Last.fm.
                showError();
            })
            .finally(function () {
                inFlight = false;
            });
    }

    // Periodic refresh on a fixed cadence.
    function startRefreshTimer() {
        stopRefreshTimer();
        refreshTimer = setInterval(loadStats, REFRESH_MS);
    }
    function stopRefreshTimer() {
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
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

        // Theme may have flipped — re-apply so --accent-ink matches the panel.
        lastArtworkURL = null;
        updateAccent();
        loadStats(); // re-fetch (feed row count / fixed color may have changed)
    }

    // The desktop switched between light and dark. Only 'auto' resolves against the
    // system — an explicit dark/light choice already renders correctly. Icons re-tint
    // centrally from sfsymbols.js, so there's no SFSymbols call here.
    function onThemeChange() {
        if ((settings.theme || 'auto') !== 'auto') return;
        resolveTheme(settings.theme);
        lastArtworkURL = null; // force --accent-ink to be re-picked for the new panel
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
        if (!window.NepTunes) return;
        NepTunes.on('statechange', onState);
        NepTunes.on('settingschange', onSettings);
        NepTunes.on('themechange', onThemeChange);
        onSettings(NepTunes.settings);
        onState(NepTunes.state);
        startRefreshTimer();
        if (window.SFSymbols) SFSymbols.load();
        if (NepTunes._signalReady) NepTunes._signalReady();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
