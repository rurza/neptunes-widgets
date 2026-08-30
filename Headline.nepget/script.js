// Headline — flagship big-type now-playing player.
// Title auto-fit to its box, hairline progress, and a single accent
// pulled from the album art (or a fixed color).

(function () {
    'use strict';

    /* ===== live radio, decided above anything that touches the DOM =====

       Exported and then returned from, the way CDCase.nepget/script.js does it, so these
       can be pinned without a browser. An Apple Music station is a `URL track` with no
       duration: it cannot be skipped, it has no position to read, and stopping it is what
       pausing it means. */

    // Prev/next are HIDDEN, not greyed, during a live stream. An ad is greyed because the
    // queue behind it is still there to reach; a station has no next track at all, so a
    // dimmed button would invite a press that can never do anything. `isLiveStream` is
    // only ever sent when true, so a missing value correctly reads as false.
    function transportHidden(track) {
        return !!(track && track.isLiveStream);
    }

    // Which glyph the play button wears. Playing a station shows a stop square rather than
    // a pause bar: resuming rejoins the stream live instead of picking up where it left
    // off. The verb sent is still playPause() — see PlaybackAffordances.
    function transportGlyph(playerState, isLiveStream) {
        if (playerState !== 2) return 'play';
        return isLiveStream ? 'stop' : 'pause';
    }

    // Whether there is a position and duration worth drawing at all.
    function hasTimeline(track) {
        return !(track && track.isLiveStream);
    }

    const PURE = {
        transportHidden: transportHidden,
        transportGlyph: transportGlyph,
        hasTimeline: hasTimeline
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = PURE;
    if (typeof window === 'undefined') return;

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
    const liveBadge = document.getElementById('liveBadge');

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
        playBtn.classList.remove('playing', 'live');
        root.classList.remove('live');
        liveBadge.hidden = true;
        prevBtn.hidden = false;
        nextBtn.hidden = false;
        playBtn.setAttribute('aria-label', 'Play');
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

        // Live radio: no skipping, a stop square instead of a pause bar, LIVE in with the
        // transport, and no timeline at all — the bar and the elapsed label are hidden in
        // CSS off `.widget.live`.
        const live = transportHidden(track);
        root.classList.toggle('live', live);
        playBtn.classList.toggle('live', live);
        liveBadge.hidden = !live;
        prevBtn.hidden = live;
        nextBtn.hidden = live;
        const verb = transportGlyph(state.playerState, live);
        playBtn.setAttribute('aria-label', verb === 'stop' ? 'Stop' : (verb === 'pause' ? 'Pause' : 'Play'));

        // Rebuild the interpolated clock on every statechange.
        curDuration = Number(track.duration) || 0;
        clockFn = NTKit.clock({
            position: state.playerPosition,
            duration: curDuration,
            playing: isPlaying,
            timestamp: state.timestamp
        });

        // Drive the rAF loop only while playing; otherwise render once. A station has no
        // timeline to animate, so the loop would burn a frame a second painting a bar that
        // CSS is hiding anyway.
        if (!hasTimeline(track)) {
            stopLoop();
            barFill.style.width = '0%';
            elapsedEl.textContent = NTKit.formatTime(0);
        } else if (isPlaying) {
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
