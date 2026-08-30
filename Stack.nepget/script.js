/**
 * Stack — a centered album cover with transport controls, title and artist
 * stacked below it, floating on the wallpaper.
 *
 * The single accent is pulled from the album art and used to fill the
 * play/pause button (with a legibility-safe glyph colour). Title, artist and
 * the prev/next glyphs are white-on-wallpaper with a text-/drop-shadow.
 */
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

    var PURE = { transportHidden: transportHidden, transportGlyph: transportGlyph };
    if (typeof module !== 'undefined' && module.exports) module.exports = PURE;
    if (typeof window === 'undefined') return;

    // ---- DOM ----
    var widget    = document.getElementById('widget');
    var artwork   = document.getElementById('artwork');
    var noArtwork = document.getElementById('noArtwork');
    var title     = document.getElementById('title');
    var artist    = document.getElementById('artist');
    var controls  = document.getElementById('controls');
    var playBtn   = document.getElementById('playBtn');
    var prevBtn   = document.getElementById('prevBtn');
    var nextBtn   = document.getElementById('nextBtn');
    var liveBadge = document.getElementById('liveBadge');
    var root      = document.documentElement;

    var prefersReducedMotion =
        window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ---- State ----
    var settings = {};
    var lastAccentURL = null;    // cache so the accent only re-extracts on change
    var currentArtURL = null;    // currently displayed cover image
    var artTimeout = null;       // crossfade handle

    // --------------------------------------------------------------- Theme ----

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

    function curDark() {
        return NTKit.panelIsDark(settings.theme);
    }

    // -------------------------------------------------------------- Accent ----

    function applyNeutralAccent() {
        NTKit.applyAccent(root, {
            accent: [124, 124, 132],
            on: [255, 255, 255],
            muted: [150, 150, 156]
        }, curDark());
    }

    // Re-extract the accent only when the artwork data URL actually changes.
    function updateAccent(force) {
        var url = window.NepTunes.getArtworkDataURL();
        if (!url) {
            lastAccentURL = null;
            applyNeutralAccent();
            return;
        }
        if (!force && url === lastAccentURL) return;
        lastAccentURL = url;
        NTKit.accent(url).then(function (palette) {
            // Guard against a race: only apply if this is still the current art.
            if (window.NepTunes.getArtworkDataURL() === url) {
                NTKit.applyAccent(root, palette, curDark());
            }
        });
    }

    // ------------------------------------------------------------- Artwork ----

    function updateArtwork(url) {
        if (url === currentArtURL) return;
        if (artTimeout) { clearTimeout(artTimeout); artTimeout = null; }

        if (url) {
            if (currentArtURL && !prefersReducedMotion) {
                // Fade out, swap, fade back in.
                artwork.classList.remove('visible');
                artTimeout = setTimeout(function () {
                    artwork.src = url;
                    artwork.classList.add('visible');
                    noArtwork.classList.add('hidden');
                    artTimeout = null;
                }, 260);
            } else {
                artwork.src = url;
                artwork.classList.add('visible');
                noArtwork.classList.add('hidden');
            }
        } else {
            artwork.classList.remove('visible');
            noArtwork.classList.remove('hidden');
        }
        currentArtURL = url;
    }

    // -------------------------------------------------------------- State ----

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
            widget.classList.add('stopped');
            widget.classList.remove('playing', 'live');
            title.textContent = 'Not Playing';
            artist.textContent = '';
            updateArtwork(null);   // shows the no-artwork placeholder
            updateAccent();        // null art -> neutral accent
            // Nothing playing must not block transport — pressing next may start playback.
            prevBtn.disabled = false;
            nextBtn.disabled = false;
            prevBtn.hidden = false;
            nextBtn.hidden = false;
            liveBadge.hidden = true;
            return;
        }

        widget.classList.remove('stopped');
        var track = state.track;
        var isAd = !!track.isAdvertisement;
        title.textContent = isAd ? 'Advertisement' : (track.title || 'Unknown Title');
        artist.textContent = isAd ? '' : (track.artist || '');

        // Greyed out during a Spotify ad — Spotify refuses to skip one.
        // `isAdvertisement` is only ever sent when true, so a missing value here
        // correctly reads as "not an ad". The native bridge already refuses next()/
        // previous() regardless; this just keeps the button from inviting a tap that
        // silently does nothing.
        var adPlaying = !!track.isAdvertisement;
        prevBtn.disabled = adPlaying;
        nextBtn.disabled = adPlaying;

        // Hidden, not greyed, during a live stream — see transportHidden. LIVE takes the
        // space they leave, hung off the right of a play button that stays dead centre. It
        // sits inside the controls row, so the "On hover" setting fades it with the
        // transport it labels.
        var isLive = transportHidden(track);
        prevBtn.hidden = isLive;
        nextBtn.hidden = isLive;
        liveBadge.hidden = !isLive;
        widget.classList.toggle('live', isLive);

        // The glyph is the button's only content, so the label has to follow the glyph.
        var glyph = transportGlyph(state.playerState, isLive);
        playBtn.setAttribute('aria-label', glyph === 'stop' ? 'Stop' : (glyph === 'pause' ? 'Pause' : 'Play'));

        // playerState: 1 = stopped, 2 = playing, 3 = paused
        if (state.playerState === 2) {
            widget.classList.add('playing');
        } else {
            widget.classList.remove('playing');
        }

        // Always read the artwork inside the state handler — it's only re-sent
        // when it changes, so state.track.artworkData can be stale.
        updateArtwork(window.NepTunes.getArtworkDataURL());
        updateAccent();
    }

    // ------------------------------------------------------------ Settings ----

    function onSettings(s) {
        settings = s || {};

        resolveTheme(settings.theme);
        document.documentElement.classList.toggle('no-text-shadow', settings.textShadow === false);

        // Controls: default Always; "hover" reveals only on hover / active.
        controls.classList.toggle('controls-always', settings.controls !== 'hover');

        // Theme may have flipped — re-apply the accent for the new panel.
        updateAccent(true);

        // Reload icons last — the theme class above must land first, since
        // sfsymbols.js reads the icon color synchronously from computed style.
        if (window.SFSymbols) SFSymbols.reload();
    }

    // The desktop switched between light and dark. Only 'auto' resolves against the
    // system — an explicit dark/light choice already renders correctly. Icons re-tint
    // centrally from sfsymbols.js, so there's no SFSymbols call here.
    function onThemeChange() {
        if ((settings.theme || 'auto') !== 'auto') return;
        resolveTheme(settings.theme);
        updateAccent(true); // force: --accent-ink must be re-picked for the new panel
    }

    // ------------------------------------------------------------ Controls ----

    function wireControls() {
        prevBtn.addEventListener('click', function () { window.NepTunes.previous(); });
        playBtn.addEventListener('click', function () { window.NepTunes.playPause(); });
        nextBtn.addEventListener('click', function () { window.NepTunes.next(); });
    }

    // --------------------------------------------------------------- Init ----

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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
