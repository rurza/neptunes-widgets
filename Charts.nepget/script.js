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

        const lf = window.NepTunes && window.NepTunes.lastFm;
        if (wantsThumbnail(item, showThumbnails, lf)) {
            const img = document.createElement('img');
            img.className = 'thumb';   // the --thumb-bg square holds the slot while it loads
            img.alt = '';
            row.appendChild(img);
            loadThumbnail(lf, item.imageURL).then((src) => {
                if (src) img.src = src;
                else img.style.display = 'none';
            });
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

    // ---- Last.fm passthrough ------------------------------------------------
    // On an app with NepTunes.lastFm.call the chart is Last.fm's own JSON. The rows below were
    // written against what the narrow getTop*() methods return — NepTunesKit's LastFmAlbum /
    // LastFmArtist / LastFmTrack, encoded by the app with absent fields omitted — so these adapt
    // the raw body to exactly that. LastFmWidgetAdapterParityTests holds them to the Swift decoders.
    function asArray(value) { return Array.isArray(value) ? value : (value ? [value] : []); }
    function str(value) { return typeof value === 'string' ? value : ''; }
    function nonEmpty(value) { return typeof value === 'string' && value.length > 0 ? value : undefined; }
    function toInt(value) {
        if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
        return typeof value === 'string' && /^[+-]?\d+$/.test(value) ? parseInt(value, 10) : undefined;
    }
    function put(object, key, value) { if (value !== undefined) object[key] = value; return object; }
    // NepTunesKit's largestImage(): the first image of each size, largest first, if it is non-empty.
    function largestImage(images) {
        const list = asArray(images);
        for (const size of ['extralarge', 'large', 'medium', 'small']) {
            const image = list.find((candidate) => candidate && candidate.size === size);
            if (image) { const url = nonEmpty(image['#text']); if (url) return url; }
        }
        return undefined;
    }
    function common(raw, item) {
        put(item, 'url', nonEmpty(raw.url));
        put(item, 'playcount', toInt(raw.playcount));
        put(item, 'imageURL', largestImage(raw.image));
        return item;
    }
    function adaptTopAlbums(raw) {
        return asArray(raw && raw.topalbums && raw.topalbums.album)
            .map((a) => common(a, { name: str(a.name), artist: str(a.artist && a.artist.name) }));
    }
    function adaptTopArtists(raw) {
        return asArray(raw && raw.topartists && raw.topartists.artist)
            .map((a) => common(a, { name: str(a.name) }));
    }
    function adaptTopTracks(raw) {
        return asArray(raw && raw.toptracks && raw.toptracks.track)
            .map((t) => common(t, { name: str(t.name), artist: str(t.artist && t.artist.name) }));
    }

    const CHART_METHODS = {
        albums: ['user.getTopAlbums', adaptTopAlbums],
        artists: ['user.getTopArtists', adaptTopArtists],
        tracks: ['user.getTopTracks', adaptTopTracks],
    };

    function fetchChart(lf, kind, chartPeriod, rows) {
        if (typeof lf.call === 'function') {
            const [method, adapt] = CHART_METHODS[kind] || CHART_METHODS.albums;
            return lf.call(method, { period: chartPeriod, limit: String(rows) }).then(adapt);
        }
        if (kind === 'artists') return lf.getTopArtists(chartPeriod, rows);
        if (kind === 'tracks') return lf.getTopTracks(chartPeriod, rows);
        return lf.getTopAlbums(chartPeriod, rows);
    }

    // ---- Thumbnails ------------------------------------------------------------
    // A widget has no network: a remote <img> is blocked by the egress rules, which is why these
    // never rendered. The app fetches Last.fm's images and hands back a data URL; an older app
    // cannot, and gets today's behaviour — no thumbnail.
    const LASTFM_PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';
    const THUMB_CACHE_LIMIT = 50;
    const thumbCache = new Map();   // image URL -> Promise<data URL | null>

    function wantsThumbnail(item, show, lf) {
        return !!(show && item && item.imageURL && lf && typeof lf.image === 'function'
            && item.imageURL.indexOf(LASTFM_PLACEHOLDER) === -1);
    }

    function loadThumbnail(lf, url) {
        if (thumbCache.has(url)) return thumbCache.get(url);
        const pending = Promise.resolve(lf.image(url)).then(
            (dataURL) => (typeof dataURL === 'string' && dataURL.indexOf('data:image/') === 0 ? dataURL : null),
            () => null
        ).then((dataURL) => {
            if (!dataURL) thumbCache.delete(url);   // a failure is retried on the next refresh
            return dataURL;
        });
        thumbCache.set(url, pending);
        if (thumbCache.size > THUMB_CACHE_LIMIT) thumbCache.delete(thumbCache.keys().next().value);
        return pending;
    }

    // ---- Loading ----------------------------------------------------------
    // The passthrough says why a load failed. Only a signed-out account replaces the chart;
    // a rate limit or network blip leaves the one on screen for the next refresh. The narrow
    // methods carry no code, so an older app keeps today's behaviour.
    function keepsChartOnFailure(error, onScreen) {
        return !!(error && error.code && error.code !== 'notSignedIn' && onScreen);
    }

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

        fetchChart(lf, chart, period, limit).then((items) => {
            if (token !== requestToken) return; // stale — a newer load superseded us
            renderRows(items);
        }).catch((error) => {
            if (token !== requestToken) return;
            if (keepsChartOnFailure(error, statusEl.hidden && listEl.childElementCount > 0)) return;
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

    return { start: start, accentKey: accentKey, adaptTopAlbums: adaptTopAlbums, adaptTopArtists: adaptTopArtists, adaptTopTracks: adaptTopTracks, fetchChart: fetchChart, keepsChartOnFailure: keepsChartOnFailure, wantsThumbnail: wantsThumbnail, loadThumbnail: loadThumbnail };
});
