// Strip — ultra-thin now-playing ticker for NepTunes.
// Long titles scroll (seamless marquee); a thin accent line tracks progress.
(function () {
    'use strict';

    /* ===== live radio, decided above anything that touches the DOM =====

       Exported and then returned from, the way CDCase.nepget/script.js does it, so
       _dev/strip.test.mjs can pin these without a browser. An Apple Music station is a
       `URL track` with no duration: it cannot be skipped, it has no position to read,
       and stopping it is what pausing it means. */

    // Prev/next are HIDDEN, not greyed, during a live stream. An ad is greyed because the
    // queue behind it is still there to reach; a station has no next track at all, so a
    // dimmed button would be inviting a press that can never do anything. `isLiveStream`
    // is only ever sent when true, so a missing value correctly reads as false.
    function transportHidden(track) {
        return !!(track && track.isLiveStream);
    }

    // Which glyph the play button wears. Playing a station shows a stop square rather than
    // a pause bar: resuming rejoins the stream live instead of picking up where it left
    // off, so "pause" would be a lie. The verb sent is still playPause() — see
    // PlaybackAffordances.stopsInsteadOfPauses.
    function transportGlyph(playerState, isLiveStream) {
        if (playerState !== 2) return 'play';
        return isLiveStream ? 'stop' : 'pause';
    }

    // Whether there is a position and duration worth drawing. False only for a live
    // stream, whose `player position` never leaves 0 — so the readout would sit at 0:00
    // and the progress line at zero width for the whole station.
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

    const widget = document.getElementById('widget');
    const strip = document.getElementById('strip');
    const glyph = document.getElementById('glyph');
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    const labelWrap = document.getElementById('labelWrap');
    const label = document.getElementById('label');
    const timeEl = document.getElementById('time');
    const underline = document.getElementById('underline');

    // Must mirror the ::after padding-left in styles.css (the marquee gap).
    const MARQUEE_GAP = 48;

    let settings = {};
    let lastArtworkURL = null;     // cache so accent is re-extracted only on change
    let getPos = () => 0;          // NTKit.clock interpolator, rebuilt every state
    let duration = 0;
    let isPlaying = false;
    let rafId = null;

    // ---- Accent ----------------------------------------------------------

    function hexToRgb(hex) {
        const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
        return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 55, 95];
    }

    function curDark() {
        return NTKit.panelIsDark(settings.theme);
    }

    function applyFixedAccent() {
        const rgb = hexToRgb(settings.fixedColor || '#FF375F');
        NTKit.applyAccent(widget, { accent: rgb, on: NTKit.onColor(rgb), muted: rgb }, curDark());
    }

    // Pull the now-playing artwork and derive the accent (only when it changed).
    function refreshAccent() {
        if (settings.accentSource === 'fixed') {
            lastArtworkURL = null;
            applyFixedAccent();
            return;
        }
        const url = window.NepTunes.getArtworkDataURL();
        if (url === lastArtworkURL) return;
        lastArtworkURL = url;
        if (!url) {
            NTKit.applyAccent(widget, { accent: [124, 124, 132], on: [255, 255, 255], muted: [150, 150, 156] }, curDark());
            return;
        }
        NTKit.accent(url).then((palette) => {
            // Ignore if artwork changed again mid-flight.
            if (url === lastArtworkURL) NTKit.applyAccent(widget, palette, curDark());
        });
    }

    // ---- Label / marquee -------------------------------------------------

    function setLabel(text, scrollable) {
        label.textContent = text;
        label.dataset.text = text; // fed to ::after for the seamless second copy
        // Drop marquee first so we measure the single-copy width (no ::after).
        label.classList.remove('marquee');
        requestAnimationFrame(() => {
            if (scrollable && label.scrollWidth > labelWrap.clientWidth + 1) {
                // Translate by exactly one copy + gap so the loop is seamless.
                label.style.setProperty('--scroll-w', (label.scrollWidth + MARQUEE_GAP) + 'px');
                label.classList.add('marquee');
            }
        });
    }

    // ---- Progress loop ---------------------------------------------------

    function tick() {
        const pos = getPos();
        const pct = duration > 0 ? Math.min(100, (pos / duration) * 100) : 0;
        underline.style.width = pct + '%';
        timeEl.textContent = NTKit.formatTime(pos);
        rafId = requestAnimationFrame(tick);
    }

    function startLoop() {
        if (rafId == null) rafId = requestAnimationFrame(tick);
    }

    function stopLoop() {
        if (rafId != null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
    }

    // ---- State -----------------------------------------------------------

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
        const track = state && state.track;

        if (!track) {
            // Empty: neutral, no progress, no scroll.
            widget.classList.add('empty');
            widget.classList.remove('playing', 'live');
            timeEl.classList.remove('live');
            glyph.setAttribute('aria-label', 'Play');
            prevBtn.hidden = false;
            nextBtn.hidden = false;
            setLabel('Nothing playing', false);
            duration = 0;
            isPlaying = false;
            getPos = () => 0;
            stopLoop();
            underline.style.width = '0%';
            timeEl.textContent = NTKit.formatTime(0);
            refreshAccent();
            // Nothing playing must not block transport — pressing next may start playback.
            prevBtn.disabled = false;
            nextBtn.disabled = false;
            return;
        }

        widget.classList.remove('empty');

        // Greyed out during a Spotify ad — Spotify refuses to skip one. `isAdvertisement`
        // is only ever sent when true (omitted for a real track), so a missing value here
        // correctly reads as "not an ad". The native bridge already refuses next()/
        // previous() during an ad regardless; this just keeps the button from inviting a
        // tap that silently does nothing.
        const adPlaying = !!track.isAdvertisement;
        prevBtn.disabled = adPlaying;
        nextBtn.disabled = adPlaying;

        // Hidden, not greyed, during a live stream — see transportHidden.
        const live = transportHidden(track);
        prevBtn.hidden = live;
        nextBtn.hidden = live;
        widget.classList.toggle('live', live);

        // "Artist — Title" (fall back gracefully when a field is missing).
        if (adPlaying) {
            setLabel('Advertisement', true);
        } else {
            const artist = track.artist || '';
            const title = track.title || 'Unknown';
            setLabel(artist ? artist + ' — ' + title : title, true);
        }

        // playerState: 1 stopped / 2 playing / 3 paused
        isPlaying = state.playerState === 2;
        widget.classList.toggle('playing', isPlaying);

        // The glyph itself is swapped in CSS off `.playing`/`.live`; VoiceOver needs the
        // same three-way decision spelled out, and it is the only place the stop state has
        // a name.
        const verb = transportGlyph(state.playerState, live);
        glyph.setAttribute('aria-label', verb === 'stop' ? 'Stop' : (verb === 'pause' ? 'Pause' : 'Play'));

        duration = Number(track.duration) || 0;

        // A station has no clock to run: the readout carries LIVE instead, and the
        // progress line is hidden in CSS off `.widget.live`.
        timeEl.classList.toggle('live', live);
        if (live) {
            stopLoop();
            timeEl.textContent = 'LIVE';
            underline.style.width = '0%';
            getPos = () => 0;
            refreshAccent();
            return;
        }

        // Rebuild the interpolated clock on every state change.
        getPos = NTKit.clock({
            position: state.playerPosition || 0,
            duration: duration,
            playing: isPlaying,
            timestamp: state.timestamp
        });

        refreshAccent();

        // Run the rAF only while playing; otherwise paint one static frame.
        if (isPlaying) {
            startLoop();
        } else {
            stopLoop();
            const pos = getPos();
            underline.style.width = (duration > 0 ? Math.min(100, (pos / duration) * 100) : 0) + '%';
            timeEl.textContent = NTKit.formatTime(pos);
        }
    }

    function onSettings(s) {
        settings = s || {};

        // Resize to the configured width (height fixed at 44).
        window.NepTunes.setSize(settings.width === 'wide' ? 640 : 420, 44);

        // Theme class on the root element.
        const root = document.documentElement;
        root.classList.remove('theme-auto', 'theme-dark', 'theme-light');
        root.classList.add('theme-' + (settings.theme || 'auto'));

        // Accent source may have flipped — force a recompute.
        lastArtworkURL = null;
        refreshAccent();

        // Reload icons last — the theme class above must land first, since
        // sfsymbols.js reads the icon color synchronously from computed style.
        if (window.SFSymbols) SFSymbols.reload();
    }

    // The desktop switched between light and dark. Only 'auto' resolves against the
    // system — an explicit dark/light choice already renders correctly. The panel itself
    // flips in CSS (.theme-auto + a prefers-color-scheme query) and icons re-tint centrally
    // from sfsymbols.js; only the JS-derived accent ink has to be re-picked here.
    function onThemeChange() {
        if ((settings.theme || 'auto') !== 'auto') return;
        lastArtworkURL = null;
        refreshAccent();
    }

    // ---- Controls --------------------------------------------------------

    function setupControls() {
        glyph.addEventListener('click', (e) => {
            e.stopPropagation();
            window.NepTunes.playPause();
        });
        prevBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.NepTunes.previous();
        });
        nextBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.NepTunes.next();
        });
        // Clicking the strip background (not a button) toggles playback.
        strip.addEventListener('click', () => {
            if (!widget.classList.contains('empty')) window.NepTunes.playPause();
        });
    }

    // ---- Init ------------------------------------------------------------

    function init() {
        if (!window.NepTunes) return;
        setupControls();
        if (window.SFSymbols) SFSymbols.load();
        NepTunes.on('statechange', onState);
        NepTunes.on('settingschange', onSettings);
        NepTunes.on('themechange', onThemeChange);
        onSettings(NepTunes.settings);
        onState(NepTunes.state);
        if (NepTunes._signalReady) NepTunes._signalReady();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
