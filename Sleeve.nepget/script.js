/**
 * Sleeve — a floating album cover with the track set beside it, straight on the
 * wallpaper. Info only: cover + title / album / artist. No playback controls.
 *
 * The single accent is pulled from the now-playing artwork and, when the cover
 * is vivid enough, tints the title (via NTKit's contrast-safe --accent-ink);
 * greyscale covers keep a clean white title.
 */
(function () {
    'use strict';

    // ---- DOM ----
    var root    = document.documentElement;
    var widget  = document.getElementById('widget');
    var info    = document.getElementById('info');
    var art     = document.getElementById('art');
    var noArt   = document.getElementById('noArt');
    var titleEl = document.getElementById('title');
    var albumEl = document.getElementById('album');
    var artistEl = document.getElementById('artist');

    // ---- State ----
    var settings = {};
    var lastArtworkURL = null;   // cache so accent only re-extracts on change
    var currentArtSrc = null;    // what <img> currently shows (avoid reloads/flicker)

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

    function curDark() {
        return NTKit.panelIsDark(settings.theme);
    }

    // --------------------------------------------------------------- Accent ----

    // Is this accent colour saturated/bright enough to tint the title with,
    // rather than dulling a white title to grey on a greyscale cover?
    function isVivid(rgb) {
        var mx = Math.max(rgb[0], rgb[1], rgb[2]);
        var mn = Math.min(rgb[0], rgb[1], rgb[2]);
        var sat = mx === 0 ? 0 : (mx - mn) / mx;
        return sat >= 0.35 && mx >= 60;
    }

    function applyNeutral() {
        NTKit.applyAccent(root, {
            accent: [124, 124, 132], on: [255, 255, 255], muted: [150, 150, 156]
        }, curDark());
        info.classList.remove('tinted');
    }

    // Re-extract the accent only when the artwork data URL actually changes.
    function updateAccent(url) {
        if (url === lastArtworkURL) return;
        lastArtworkURL = url;

        if (!url) {
            applyNeutral();
            return;
        }
        NTKit.accent(url).then(function (palette) {
            // Guard against a race: only apply if this art is still current.
            if (window.NepTunes.getArtworkDataURL() !== url) return;
            NTKit.applyAccent(root, palette, curDark());
            info.classList.toggle('tinted', isVivid(palette.accent));
        });
    }

    // -------------------------------------------------------------- Artwork ----

    function updateArtwork(url) {
        if (url === currentArtSrc) return;
        currentArtSrc = url;
        if (url) {
            art.src = url;
            art.classList.add('visible');
            noArt.classList.add('hidden');
        } else {
            art.classList.remove('visible');
            art.removeAttribute('src');
            noArt.classList.remove('hidden');
        }
    }

    // ---------------------------------------------------------------- Text ----

    function setLine(el, value) {
        el.textContent = value || '';
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

    function onState(state) {
        applyDirection(state);
        var track = state && state.track;

        if (!track) {
            // Stopped / no track.
            widget.classList.add('stopped');
            setLine(titleEl, 'Not Playing');
            setLine(albumEl, '');
            setLine(artistEl, '');
        } else {
            widget.classList.remove('stopped');
            var isAd = !!track.isAdvertisement;
            setLine(titleEl, isAd ? 'Advertisement' : (track.title || 'Unknown Title'));
            setLine(albumEl, isAd ? '' : (track.album || ''));
            setLine(artistEl, isAd ? '' : (track.artist || 'Unknown Artist'));
        }

        // Artwork is only re-sent when it changes — always pull it here.
        var url = window.NepTunes.getArtworkDataURL();
        updateArtwork(url);
        updateAccent(url);
    }

    function onSettings(s) {
        settings = s || {};
        resolveTheme(settings.theme);
        document.documentElement.classList.toggle('no-text-shadow', settings.textShadow === false);
        // Theme may have flipped — re-derive the contrast-safe accent ink.
        lastArtworkURL = null;
        updateAccent(window.NepTunes.getArtworkDataURL());

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
        lastArtworkURL = null; // force the contrast-safe accent ink to be re-derived
        updateAccent(window.NepTunes.getArtworkDataURL());
    }

    // --------------------------------------------------------------- Init ----

    function init() {
        if (!window.NepTunes) return;
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
