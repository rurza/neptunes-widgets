// Glass — full-bleed album cover with a frosted-glass now-playing panel.
// Cover fills the widget; a blurred panel over the lower portion carries the
// title, artist and prev / play-pause / next controls. Accent (play-button
// fill) is pulled from the album art.

(function () {
    'use strict';

    // ---- The live-stream half ----
    // Kept above every DOM lookup so `require`ing this file in Node gets the pure functions
    // and stops there — see _dev/live-stream.test.mjs.

    /*
     * Whether prev/next should be HIDDEN right now — a live stream, not an ad. `isLiveStream`
     * is only ever sent when true, and `track` itself may be missing. Hidden rather than
     * greyed: the bridge already refuses next()/previous() during a stream centrally, and a
     * broadcast has no earlier point to skip back into, so an inert-looking button would only
     * invite a tap that means nothing.
     */
    function transportHidden(track) {
        return !!(track && track.isLiveStream);
    }

    /*
     * Which of the three play-button glyphs applies. `playerState` 2 is playing; only that
     * state differs for a stream, because stopping a broadcast is not pausing it — pressing
     * play again restarts the stream rather than resuming it.
     */
    function transportGlyph(playerState, isLiveStream) {
        if (playerState !== 2) return 'play';
        return isLiveStream ? 'stop' : 'pause';
    }

    const PURE = { transportHidden: transportHidden, transportGlyph: transportGlyph };
    if (typeof module !== 'undefined' && module.exports) module.exports = PURE;
    if (typeof window === 'undefined') return;

    // ---- DOM ----
    const widget = document.getElementById('widget');
    const artworkImg = document.getElementById('artwork');
    const noArtwork = document.getElementById('noArtwork');
    const titleEl = document.getElementById('title');
    const artistEl = document.getElementById('artist');
    const panel = document.getElementById('panel');
    const prevBtn = document.getElementById('prevBtn');
    const playBtn = document.getElementById('playBtn');
    const nextBtn = document.getElementById('nextBtn');
    const liveBadge = document.getElementById('liveBadge');

    const NEUTRAL = { accent: [124, 124, 132], on: [255, 255, 255], muted: [150, 150, 156] };

    // ---- State ----
    let settings = {};
    let currentArtworkURL = null;   // what the <img> currently shows (crossfade)
    let artworkTimeout = null;
    let lastAccentURL = null;       // last art we extracted an accent from

    // ---- Theme ----
    // resolveTheme(): auto -> system, else the chosen theme. Sets
    // theme-dark/theme-light on <html>. Returns whether the panel is dark.
    function resolveTheme() {
        const t = settings.theme || 'auto';
        let dark;
        if (t === 'light') dark = false;
        else if (t === 'dark') dark = true;
        else dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.classList.toggle('theme-dark', dark);
        document.documentElement.classList.toggle('theme-light', !dark);
        return dark;
    }

    // ---- Accent ----
    // Re-extract / re-apply the album accent. Only touches the art when it
    // changed (or when forced, e.g. after a theme flip so --on is re-picked).
    function refreshAccent(force) {
        const url = window.NepTunes.getArtworkDataURL();
        if (!url) {
            lastAccentURL = null;
            NTKit.applyAccent(widget, NEUTRAL, NTKit.panelIsDark(settings.theme));
            return;
        }
        if (!force && url === lastAccentURL) return;
        lastAccentURL = url;
        NTKit.accent(url).then(function (p) {
            // Guard a race: only apply if this is still the current art.
            if (window.NepTunes.getArtworkDataURL() === url) {
                NTKit.applyAccent(widget, p, NTKit.panelIsDark(settings.theme));
            }
        });
    }

    // ---- Artwork (crossfade on change) ----
    function updateArtwork(url) {
        if (url === currentArtworkURL) return;
        if (artworkTimeout) {
            clearTimeout(artworkTimeout);
            artworkTimeout = null;
        }
        if (url) {
            if (currentArtworkURL) {
                // Fade out, swap, fade back in.
                artworkImg.classList.remove('visible');
                artworkTimeout = setTimeout(function () {
                    artworkImg.src = url;
                    artworkImg.classList.add('visible');
                    noArtwork.classList.add('hidden');
                    artworkTimeout = null;
                }, 260);
            } else {
                artworkImg.src = url;
                artworkImg.classList.add('visible');
                noArtwork.classList.add('hidden');
            }
        } else {
            artworkImg.classList.remove('visible');
            noArtwork.classList.remove('hidden');
        }
        currentArtworkURL = url;
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

    // ---- State handling ----
    function onState(state) {
        applyDirection(state);
        if (!state || !state.track) {
            widget.classList.add('stopped');
            widget.classList.remove('playing', 'live');
            titleEl.textContent = 'Not Playing';
            artistEl.textContent = '';
            updateArtwork(null);
            refreshAccent(false); // no art -> neutral accent
            // Nothing playing must not block transport — pressing next may start playback.
            prevBtn.disabled = false;
            nextBtn.disabled = false;
            prevBtn.hidden = false;
            nextBtn.hidden = false;
            liveBadge.hidden = true;
            return;
        }

        widget.classList.remove('stopped');
        const track = state.track;

        var isAd = !!track.isAdvertisement;
        titleEl.textContent = isAd ? 'Advertisement' : (track.title || 'Unknown Title');
        artistEl.textContent = isAd ? '' : (track.artist || '');

        // playerState: 1 stopped, 2 playing, 3 paused.
        widget.classList.toggle('playing', state.playerState === 2);

        // Greyed out during a Spotify ad — Spotify refuses to skip one. `isAdvertisement`
        // is only ever sent when true, so a missing value here correctly reads as "not an
        // ad". The native bridge already refuses next()/previous() regardless; this just
        // keeps the button from inviting a tap that silently does nothing.
        const adPlaying = !!track.isAdvertisement;
        prevBtn.disabled = adPlaying;
        nextBtn.disabled = adPlaying;

        // Hidden, not greyed, during a live stream — see transportHidden. LIVE takes the
        // space they leave, at the right end of a row whose play button stays dead centre.
        // It rides the panel's own visibility: in "On hover" the whole sheet waits for the
        // pointer, and the badge is transport state, so it belongs with the transport.
        const isLive = transportHidden(track);
        prevBtn.hidden = isLive;
        nextBtn.hidden = isLive;
        liveBadge.hidden = !isLive;
        widget.classList.toggle('live', isLive);

        // The glyph is the button's only content, so the label has to follow the glyph.
        const glyph = transportGlyph(state.playerState, isLive);
        playBtn.setAttribute('aria-label', glyph === 'stop' ? 'Stop' : (glyph === 'pause' ? 'Pause' : 'Play'));

        // Artwork is only re-sent when it CHANGES, so always pull it here.
        const url = window.NepTunes.getArtworkDataURL();
        updateArtwork(url);
        refreshAccent(false);
    }

    // ---- Settings handling ----
    function onSettings(s) {
        settings = s || {};
        resolveTheme();
        document.documentElement.classList.toggle('no-text-shadow', settings.textShadow === false);
        // Default = the sheet is always there; hover mode drops .panel-always and the whole
        // frosted panel — title, artist and transport with it — waits for the pointer.
        panel.classList.toggle('panel-always', (settings.controls || 'always') !== 'hover');
        // Theme may have flipped -> re-apply accent so --on stays legible.
        refreshAccent(true);

        // Reload icons last — the theme class above must land first, since
        // sfsymbols.js reads the icon color synchronously from computed style.
        if (window.SFSymbols) SFSymbols.reload();
    }

    // ---- Controls ----
    function wireControls() {
        prevBtn.addEventListener('click', function () { window.NepTunes.previous(); });
        playBtn.addEventListener('click', function () { window.NepTunes.playPause(); });
        nextBtn.addEventListener('click', function () { window.NepTunes.next(); });
    }

    // The desktop switched between light and dark. Only 'auto' resolves against the
    // system — an explicit dark/light choice already renders correctly. Icons re-tint
    // centrally from sfsymbols.js, so there's no SFSymbols call here.
    function onThemeChange() {
        if ((settings.theme || 'auto') !== 'auto') return;
        resolveTheme();
        refreshAccent(true); // force: --on must be re-picked for the new panel
    }

    // ---- Init (exact pattern) ----
    function init() {
        if (!window.NepTunes) return;
        wireControls();
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
