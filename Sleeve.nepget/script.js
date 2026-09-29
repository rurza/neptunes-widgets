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

    /*
     * Motion artwork — the pure half, kept above every DOM lookup so `require`ing this file in
     * Node gets these and stops (see _dev/sleeve.test.mjs).
     *
     * NepTunes 4.1 hands a widget that declares "supportsMotionArtwork" the album's animated cover
     * as track.motionArtworkURL: a local URL for a <video src>, and nothing more (fetch() of it
     * fails). It is absent on older apps, with the user's "Animated cover" off, for an album with
     * no loop, until the loop has downloaded (a few seconds after the track change, via another
     * statechange), under Reduce Motion or Low Power, and without Pro. Every one of those, and
     * any failure, leaves the static cover — which is always underneath, and which the accent
     * keeps coming from.
     */

    // What the cover should be doing: which loop, for which album, and whether it plays. A loop
    // is shown only for a track that is playing or paused — not when stopped, not for an ad, and
    // never under prefers-reduced-motion. Paused keeps the loop (and its current frame) without
    // playing it.
    function motionState(state, reducedMotion) {
        var off = { src: null, album: null, play: false };
        var track = state && state.track;
        if (!track || track.isAdvertisement || reducedMotion) return off;
        var src = typeof track.motionArtworkURL === 'string' ? track.motionArtworkURL : '';
        var playerState = state.playerState;
        if (!src || (playerState !== 2 && playerState !== 3)) return off;
        return { src: src, album: track.album || '', play: playerState === 2 };
    }

    // A little longer than the 0.35 s opacity crossfade, so a video is let go only once it has
    // faded out.
    var MOTION_FADE_MS = 400;

    /*
     * The <video>s over the static cover. Each loop gets its own element: an outgoing one fades
     * out and is then released (src removed + load(), so WebKit drops the decoder and the file)
     * while its successor loads underneath it. A video is revealed only once a frame is actually
     * on screen — requestVideoFrameCallback, or playback advancing past 0 with data in hand —
     * never on "loaded", which can still paint black. A hidden widget window loads no media at
     * all until it is shown, so until then it simply stays on the static art.
     *
     *   opts.container    element the videos go into (the rounded, clipped cover)
     *   opts.createVideo  () => a new <video>
     *   opts.later        (fn, ms) => schedule fn (setTimeout)
     */
    function createMotionLayer(opts) {
        var current = null;     // { el, key, revealed, dead }
        var failedKey = null;   // the loop that errored, not retried until the loop changes
        var wantPlay = false;

        function playIfWanted(entry) {
            if (entry !== current || !wantPlay || !entry.el.paused) return;
            var result = entry.el.play();
            // A refused play() just leaves the static art up: nothing is revealed without a frame.
            if (result && typeof result.catch === 'function') result.catch(function () {});
        }

        function reveal(entry) {
            if (entry.dead || entry.revealed || entry.el.readyState < 2) return;
            entry.revealed = true;
            entry.el.classList.add('visible');
        }

        function release(entry) {
            entry.dead = true;
            var el = entry.el;
            el.classList.remove('visible');
            if (!el.paused) el.pause();
            opts.later(function () {
                el.removeAttribute('src');
                el.load();
                if (el.parentNode) el.parentNode.removeChild(el);
            }, MOTION_FADE_MS);
        }

        function start(src, key) {
            var el = opts.createVideo();
            var entry = { el: el, key: key, revealed: false, dead: false };
            el.muted = true;
            el.defaultMuted = true;
            el.loop = true;
            el.playsInline = true;
            el.setAttribute('muted', '');
            el.setAttribute('loop', '');
            el.setAttribute('playsinline', '');
            el.setAttribute('disablepictureinpicture', '');
            el.setAttribute('preload', 'auto');
            el.setAttribute('aria-hidden', 'true');
            el.classList.add('motion');

            el.addEventListener('loadeddata', function () { playIfWanted(entry); });
            el.addEventListener('canplay', function () { playIfWanted(entry); });
            el.addEventListener('timeupdate', function () {
                if (el.currentTime > 0) reveal(entry);
            });
            if (typeof el.requestVideoFrameCallback === 'function') {
                el.requestVideoFrameCallback(function () { reveal(entry); });
            }
            el.addEventListener('error', function () {
                if (entry !== current) return;
                failedKey = entry.key;
                current = null;
                release(entry);
            });

            el.setAttribute('src', src);
            opts.container.appendChild(el);
            return entry;
        }

        function update(m) {
            wantPlay = !!m.play;
            var key = m.src ? m.src + '\n' + m.album : null;
            if (key !== failedKey) failedKey = null;
            if (key === failedKey) key = null;
            if (key !== (current && current.key)) {
                if (current) release(current);
                current = key ? start(m.src, key) : null;
            }
            if (!current) return;
            if (wantPlay) playIfWanted(current);
            else if (!current.el.paused) current.el.pause();
        }

        return { update: update };
    }

    var PURE = { motionState: motionState, createMotionLayer: createMotionLayer };
    if (typeof module !== 'undefined' && module.exports) module.exports = PURE;
    if (typeof window === 'undefined') return;

    // ---- DOM ----
    var root    = document.documentElement;
    var widget  = document.getElementById('widget');
    var info    = document.getElementById('info');
    var cover   = document.getElementById('cover');
    var art     = document.getElementById('art');
    var noArt   = document.getElementById('noArt');
    var titleEl = document.getElementById('title');
    var albumEl = document.getElementById('album');
    var artistEl = document.getElementById('artist');
    var emptyOpen = document.getElementById('emptyOpen');

    // ---- State ----
    var settings = {};
    var lastArtworkURL = null;   // cache so accent only re-extracts on change
    var currentArtSrc = null;    // what <img> currently shows (avoid reloads/flicker)
    var lastState = null;        // re-evaluated when prefers-reduced-motion flips
    var reducedMotionQuery = window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var motion = createMotionLayer({
        container: cover,
        createVideo: function () { return document.createElement('video'); },
        later: function (fn, ms) { setTimeout(fn, ms); }
    });

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

    // ------------------------------------------------------- Motion artwork ----

    function updateMotion() {
        var reduced = !!(reducedMotionQuery && reducedMotionQuery.matches);
        motion.update(motionState(lastState, reduced));
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
            // No track — "Nothing playing". With no player running the host sends no track,
            // no playerType and playerState 0 (not 1); a player stopped at the end of its
            // queue WITH its last track still shows that track (the branch below).
            widget.classList.add('stopped');
            setLine(titleEl, 'Nothing playing');
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

        lastState = state;
        updateMotion();
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
        // Brings the running player forward; with none running, launches the preferred player if one is set, otherwise the last-used one.
        emptyOpen.addEventListener('click', function () {
            if (typeof window.NepTunes.activatePlayer === 'function') window.NepTunes.activatePlayer();
        });
        if (window.SFSymbols) SFSymbols.load();
        NepTunes.on('statechange', onState);
        NepTunes.on('settingschange', onSettings);
        NepTunes.on('themechange', onThemeChange);
        if (reducedMotionQuery) {
            if (reducedMotionQuery.addEventListener) reducedMotionQuery.addEventListener('change', updateMotion);
            else if (reducedMotionQuery.addListener) reducedMotionQuery.addListener(updateMotion);
        }
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
