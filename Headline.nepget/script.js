// Headline — flagship big-type now-playing player.
// Title auto-fit to its box, hairline progress, and a single accent
// pulled from the album art (or a fixed color).

(function () {
    'use strict';

    // ---- DOM ----
    const root = document.getElementById('widget');
    const titleEl = document.getElementById('title');
    const subtitleEl = document.getElementById('subtitle');
    const barFill = document.getElementById('barFill');
    const elapsedEl = document.getElementById('elapsed');
    const controls = document.getElementById('controls');
    const prevBtn = document.getElementById('prevBtn');
    const playBtn = document.getElementById('playBtn');
    const nextBtn = document.getElementById('nextBtn');
    const loveBtn = document.getElementById('loveBtn');

    const prefersReducedMotion =
        window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ---- State ----
    let settings = {};
    let lastArtworkURL = null;   // cache so we only re-extract accent on real change
    let lastTrackKey = null;     // title+artist, to detect track changes
    let clockFn = null;          // NTKit.clock(), rebuilt on every statechange
    let curDuration = 0;
    let isPlaying = false;
    let rafId = null;

    // ---- Accent ----
    function hexToRgb(hex) {
        let h = String(hex || '').replace('#', '').trim();
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        const n = parseInt(h, 16);
        if (!isFinite(n)) return [124, 124, 132];
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function curDark() {
        return NTKit.panelIsDark(settings.theme);
    }

    function applyFixedAccent(hex) {
        const accent = hexToRgb(hex);
        const on = NTKit.onColor(accent);
        const muted = accent.map((v) => Math.round(v * 0.5 + 55));
        NTKit.applyAccent(root, { accent: accent, on: on, muted: muted }, curDark());
    }

    function applyNeutralAccent() {
        NTKit.applyAccent(root, {
            accent: [124, 124, 132],
            on: [255, 255, 255],
            muted: [150, 150, 156]
        }, curDark());
    }

    // Re-extract / re-apply accent. Only touches album art when it changed.
    function refreshAccent(force) {
        if (settings.accentSource === 'fixed') {
            lastArtworkURL = null; // so switching back to album re-extracts
            applyFixedAccent(settings.fixedColor);
            return;
        }
        const url = window.NepTunes.getArtworkDataURL();
        if (!url) {
            lastArtworkURL = null;
            applyNeutralAccent();
            return;
        }
        if (!force && url === lastArtworkURL) return;
        lastArtworkURL = url;
        NTKit.accent(url).then((p) => {
            // Guard against a race: only apply if this is still the current art.
            if (window.NepTunes.getArtworkDataURL() === url) {
                NTKit.applyAccent(root, p, curDark());
            }
        });
    }

    // ---- Title crossfade on track change ----
    function setTrackText(title, subtitle, changed) {
        const write = () => {
            titleEl.textContent = title;
            subtitleEl.textContent = subtitle;
            NTKit.fitText(titleEl, { min: 26, max: 64 });
            if (changed && !prefersReducedMotion) {
                titleEl.style.opacity = '1';
                subtitleEl.style.opacity = '1';
            }
        };

        if (changed && !prefersReducedMotion) {
            // Fade out, swap, fade back in.
            titleEl.style.opacity = '0';
            subtitleEl.style.opacity = '0';
            setTimeout(write, 180);
        } else {
            write();
        }
    }

    // ---- Progress rendering ----
    function renderProgress() {
        const pos = clockFn ? clockFn() : 0;
        const pct = curDuration > 0 ? Math.min(100, (pos / curDuration) * 100) : 0;
        barFill.style.width = pct + '%';
        elapsedEl.textContent = NTKit.formatTime(pos);
    }

    function loop() {
        renderProgress();
        rafId = requestAnimationFrame(loop);
    }

    function startLoop() {
        if (rafId == null) rafId = requestAnimationFrame(loop);
    }

    function stopLoop() {
        if (rafId != null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
    }

    // ---- Empty state ----
    function showEmpty() {
        stopLoop();
        root.classList.add('stopped');
        setTrackText('Not Playing', '', lastTrackKey !== null);
        lastTrackKey = null;
        clockFn = null;
        curDuration = 0;
        isPlaying = false;
        barFill.style.width = '0%';
        elapsedEl.textContent = '0:00';
        playBtn.classList.remove('playing');
        loveBtn.classList.add('hidden');
        loveBtn.classList.remove('loved');
        lastArtworkURL = null;
        if (settings.accentSource === 'fixed') applyFixedAccent(settings.fixedColor);
        else applyNeutralAccent();
    }

    // ---- State handling ----
    // Mirror for a right-to-left host language. Applied on state rather than at startup:
    // window.NepTunes.state is null until the host's first push, which happens in
    // webView(_:didFinish:) — after DOMContentLoaded, where init() runs. Reading it at
    // startup throws TypeError every time.
    function applyDirection(state) {
        if (state && state.layoutDirection) {
            document.documentElement.dir = state.layoutDirection;
        }
    }

    function onState(state) {
        applyDirection(state);
        if (!state || !state.track) {
            showEmpty();
            return;
        }

        root.classList.remove('stopped');
        const track = state.track;

        // Detect track change via title + artist.
        const key = (track.title || '') + ' ' + (track.artist || '');
        const changed = key !== lastTrackKey;
        lastTrackKey = key;

        // Title + "artist · album".
        const isAd = !!track.isAdvertisement;
        const title = isAd ? 'Advertisement' : (track.title || 'Unknown Title');
        const parts = [];
        if (!isAd && track.artist) parts.push(track.artist);
        if (!isAd && track.album) parts.push(track.album);
        setTrackText(title, parts.join('  ·  '), changed);

        // Accent: re-extract on track change (or always for fixed).
        refreshAccent(changed);

        // Play state + glyph.
        isPlaying = state.playerState === 2;
        playBtn.classList.toggle('playing', isPlaying);

        // Rebuild the interpolated clock on every statechange.
        curDuration = Number(track.duration) || 0;
        clockFn = NTKit.clock({
            position: state.playerPosition,
            duration: curDuration,
            playing: isPlaying,
            timestamp: state.timestamp
        });

        // Drive the rAF loop only while playing; otherwise render once.
        if (isPlaying) {
            startLoop();
        } else {
            stopLoop();
            renderProgress();
        }

        // Love: only when supported.
        const caps = state.capabilities || window.NepTunes.capabilities || {};
        if (caps.canLove) {
            loveBtn.classList.remove('hidden');
            const loved = state.isLoved || track.isLoved;
            loveBtn.classList.toggle('loved', !!loved);
        } else {
            loveBtn.classList.add('hidden');
        }
    }

    // ---- Settings handling ----
    function onSettings(s) {
        settings = s || {};

        // Theme: auto / dark / light as a class on the root element.
        root.classList.remove('auto', 'dark', 'light');
        const theme = settings.theme || 'auto';
        root.classList.add(theme);

        // Controls visibility: always vs hover.
        controls.classList.toggle('controls-always', settings.controls === 'always');

        // Accent source may have changed; re-apply.
        refreshAccent(true);

        // Title metrics can shift with theme; re-fit.
        NTKit.fitText(titleEl, { min: 26, max: 64 });

        // Reload icons last — the theme class above must land first, since
        // sfsymbols.js reads the icon color synchronously from computed style.
        if (window.SFSymbols) SFSymbols.reload();
    }

    // The desktop switched between light and dark. Only 'auto' resolves against the
    // system — an explicit dark/light choice already renders correctly. The panel itself
    // flips in CSS (.auto + a prefers-color-scheme query) and icons re-tint centrally from
    // sfsymbols.js; only the JS-derived accent ink has to be re-picked here.
    function onThemeChange() {
        if ((settings.theme || 'auto') !== 'auto') return;
        refreshAccent(true);
        NTKit.fitText(titleEl, { min: 26, max: 64 });
    }

    // ---- Controls ----
    function wireControls() {
        prevBtn.addEventListener('click', () => window.NepTunes.previous());
        playBtn.addEventListener('click', () => window.NepTunes.playPause());
        nextBtn.addEventListener('click', () => window.NepTunes.next());
        loveBtn.addEventListener('click', () => {
            const caps = window.NepTunes.capabilities || {};
            if (caps.canLove) window.NepTunes.toggleLove();
        });
    }

    // Re-fit the title if the window is resized.
    window.addEventListener('resize', () => {
        NTKit.fitText(titleEl, { min: 26, max: 64 });
    });

    // ---- Init (exact pattern) ----
    function init() {
        if (!window.NepTunes) return;
        wireControls();
        NepTunes.on('statechange', onState);
        NepTunes.on('settingschange', onSettings);
        NepTunes.on('themechange', onThemeChange);
        onSettings(NepTunes.settings);
        onState(NepTunes.state);
        if (window.SFSymbols) SFSymbols.load();
        if (NepTunes._signalReady) NepTunes._signalReady();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
