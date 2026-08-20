/**
 * Charts — your Last.fm top albums / artists / tracks as a numbered
 * typographic chart. The lone accent (extracted from the now-playing
 * artwork) tints the rank numerals and the header rule.
 */
(function (factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else api.start();
})(function () {
    'use strict';

    // DOM. Looked up in init(), not here: Node has no document, and _dev/charts.test.mjs
    // requires this file to cover the accent cache. Same shape as Vinyl and Minimal.
    let root = null;
    let chartTitle = null;
    let periodLabel = null;
    let listEl = null;
    let statusEl = null;

    // Settings (with sane defaults matching the manifest)
     let chart = 'albums';    // albums | artists | tracks
     let period = '7day';
     let limit = 8;
     let showThumbnails = false;
     let accentSource = 'album'; // album | fixed
     let fixedColor = '#FF375F';

    // Last.fm request coordination
    let inFlight = false;      // a request is currently running
    let requestToken = 0;      // bumps each load; stale responses are dropped
    let refreshTimer = null;   // 60s periodic refresh
    let trackDebounce = null;  // debounce for now-playing-driven refresh

    // Accent caching. The key is everything the painted accent depends on, so the widget
    // repaints exactly when one of them moves.
    //
    // This used to be the artwork URL on its own, and null meant two different things:
    // "nothing is playing, so there is no cover" and "settings changed, re-extract". With
    // the player paused, switching Accent from a fixed colour back to album art compared
    // null to null, took the early return, and left the fixed colour painted on the card
    // until a cover happened to turn up. The sentinel is an object so it can never be
    // equal to a key, which is always a string.
    const ACCENT_UNSET = {};
    let lastAccentKey = ACCENT_UNSET;
    let currentTheme = 'auto'; // resolved panel polarity for legible accent ink

    const PERIOD_LABELS = {
        '7day': '7 DAYS',
        '1month': '1 MONTH',
        '3month': '3 MONTHS',
        '6month': '6 MONTHS',
        '12month': '12 MONTHS',
        'overall': 'ALL TIME'
    };
    const CHART_LABELS = {
        albums: 'TOP ALBUMS',
        artists: 'TOP ARTISTS',
        tracks: 'TOP TRACKS'
    };

    // ---- Status helpers ---------------------------------------------------
    function showStatus(text) {
        statusEl.textContent = text;
        statusEl.hidden = false;
        listEl.style.display = 'none';
    }
    function hideStatus() {
        statusEl.hidden = true;
        listEl.style.display = '';
    }

    // ---- Theme ------------------------------------------------------------
    function applyTheme(theme) {
        root.classList.remove('theme-auto', 'theme-dark', 'theme-light');
        root.classList.add('theme-' + (theme || 'auto'));
    }

    // ---- Settings ---------------------------------------------------------
    function onSettings(settings) {
        settings = settings || {};
        chart = settings.chart || 'albums';
        period = settings.period || '7day';
        limit = parseInt(settings.limit, 10) || 8;
        showThumbnails = !!settings.showThumbnails;
        accentSource = settings.accentSource || 'album';
        fixedColor = settings.fixedColor || '#FF375F';

        currentTheme = settings.theme || 'auto';
        applyTheme(currentTheme);

        chartTitle.textContent = CHART_LABELS[chart] || 'TOP';
        periodLabel.textContent = PERIOD_LABELS[period] || '';

        // A flipped theme, a new fixed colour or a switch of accent source all move the
        // accent key, so updateAccent() repaints on its own.
        updateAccent();

        loadChart();
    }

    // ---- Rendering --------------------------------------------------------
    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    // Build one chart row. `item` shape depends on the chart kind.
    function makeRow(item, index) {
        const row = document.createElement('div');
        row.className = 'row';

        const rank = document.createElement('span');
        rank.className = 'rank';
        rank.textContent = pad2(index + 1);
        row.appendChild(rank);

        // Optional thumbnail — Last.fm imageURL is a REMOTE url, used ONLY
        // as a plain <img src> (never canvas / never NTKit.accent).
        if (showThumbnails && item.imageURL) {
            const img = document.createElement('img');
            img.className = 'thumb';
            img.loading = 'lazy';
            img.alt = '';
            img.src = item.imageURL;
            img.addEventListener('error', () => { img.style.display = 'none'; });
            row.appendChild(img);
        }

        const meta = document.createElement('div');
        meta.className = 'meta';

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = item.name || '';
        meta.appendChild(name);

        // Albums and tracks carry an artist line; artists do not.
        if (chart !== 'artists' && item.artist) {
            const by = document.createElement('span');
            by.className = 'by';
            by.textContent = item.artist;
            meta.appendChild(by);
        }
        row.appendChild(meta);

        const count = document.createElement('span');
        count.className = 'count';
        const plays = Number(item.playcount) || 0;
        count.textContent = NTKit.formatCount(plays) + ' plays';
        row.appendChild(count);

        return row;
    }

    function renderRows(items) {
        if (!items || items.length === 0) {
            showStatus('No data for this period yet.');
            return;
        }
        hideStatus();
        const frag = document.createDocumentFragment();
        items.slice(0, limit).forEach((item, i) => frag.appendChild(makeRow(item, i)));
        listEl.replaceChildren(frag);
    }

    // ---- Loading ----------------------------------------------------------
    function loadChart() {
        const lf = window.NepTunes && window.NepTunes.lastFm;
        if (!lf) {
            showStatus('Sign in to Last.fm in NepTunes settings to see your charts.');
            return;
        }
        // In-flight guard: never overlap requests.
        if (inFlight) return;

        const token = ++requestToken;
        inFlight = true;

        let promise;
        if (chart === 'artists') promise = lf.getTopArtists(period, limit);
        else if (chart === 'tracks') promise = lf.getTopTracks(period, limit);
        else promise = lf.getTopAlbums(period, limit);

        promise.then((items) => {
            if (token !== requestToken) return; // stale — a newer load superseded us
            renderRows(items);
        }).catch(() => {
            if (token !== requestToken) return;
            // Rejection means signed out (or transient failure). Don't spam console.
            showStatus('Sign in to Last.fm in NepTunes settings to see your charts.');
        }).finally(() => {
            if (token === requestToken) inFlight = false;
        });
    }

    // ---- Accent (now-playing tint) ----------------------------------------

    // The manifest's default, and what an unreadable fixedColor falls back to.
    const DEFAULT_FIXED_RGB = [255, 55, 95];

    // Cache identity for the accent currently on the card. Pure, and exported, because
    // the case that broke has no artwork URL to key on: see _dev/charts.test.mjs.
    function accentKey(source, url, color, dark) {
        const panel = dark ? 'dark' : 'light';
        return source === 'fixed'
            ? 'fixed|' + panel + '|' + color
            : 'album|' + panel + '|' + (url || '');
    }

    function updateAccent() {
        const dark = NTKit.panelIsDark(currentTheme);
        const url = accentSource === 'fixed' ? null : window.NepTunes.getArtworkDataURL();
        const key = accentKey(accentSource, url, fixedColor, dark);
        if (key === lastAccentKey) return;
        lastAccentKey = key;

        if (accentSource === 'fixed') {
            const rgb = NTKit.hexToRgb(fixedColor) || DEFAULT_FIXED_RGB;
            NTKit.applyAccent(root, NTKit.fixedPalette(rgb, dark), dark);
            return;
        }

        // Never block the chart load on accent extraction. NTKit.accent resolves a neutral
        // palette for a missing or undecodable cover rather than rejecting, so the only
        // thing a .catch here could swallow is a real throw from applyAccent.
        NTKit.accent(url).then((palette) => {
            if (lastAccentKey !== key) return;   // settings moved on while it decoded
            NTKit.applyAccent(root, palette, dark);
        });
    }

    // Identify the now-playing track so we only refetch on a real song change
    // (statechange also fires for play/pause and volume, which can't move a chart).
    let lastTrackKey = null;
    function trackKey(state) {
        const t = state && state.track;
        return t ? (t.title || '') + '|' + (t.artist || '') : '';
    }

    // Mirror for a right-to-left host language. Applied on state rather than at startup:
    // window.NepTunes.state is null until the host's first push, which happens in
    // webView(_:didFinish:) — after DOMContentLoaded, where init() runs. Reading it at
    // startup throws TypeError every time.
    function applyDirection(state) {
        if (state && state.layoutDirection) {
            document.documentElement.dir = state.layoutDirection;
        }
    }

    // ---- State changes ----------------------------------------------------
    function onState(state) {
        applyDirection(state);
        if (!state) return;
        updateAccent();

        const key = trackKey(state);
        if (key === lastTrackKey) return;
        lastTrackKey = key;

        // Refresh charts when the now-playing track changes, debounced so a
        // rapid skip-through doesn't spam Last.fm (>= 5s between refreshes).
        if (trackDebounce) clearTimeout(trackDebounce);
        trackDebounce = setTimeout(loadChart, 5000);
    }

    // ---- Periodic refresh -------------------------------------------------
    function startRefreshTimer() {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(loadChart, 60000);
    }

    // The desktop switched between light and dark. Only 'auto' resolves against the
    // system — an explicit dark/light choice already renders correctly. The panel itself
    // flips in CSS (.theme-auto + a prefers-color-scheme query); only the JS-derived
    // accent ink has to be re-picked here. No chart refetch: the data hasn't changed.
    function onThemeChange() {
        if (currentTheme !== 'auto') return;
        updateAccent();
    }

    // ---- Init -------------------------------------------------------------
    function init() {
        root = document.getElementById('widget');
        chartTitle = document.getElementById('chartTitle');
        periodLabel = document.getElementById('periodLabel');
        listEl = document.getElementById('list');
        statusEl = document.getElementById('status');

        if (!window.NepTunes) return;
        NepTunes.on('statechange', onState);
        NepTunes.on('settingschange', onSettings);
        NepTunes.on('themechange', onThemeChange);
        onSettings(NepTunes.settings);
        onState(NepTunes.state);
        startRefreshTimer();
        if (NepTunes._signalReady) NepTunes._signalReady();
    }

    function start() {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
        else init();
    }

    return { start: start, accentKey: accentKey };
});
