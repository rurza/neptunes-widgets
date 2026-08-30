(function() {
    'use strict';

    /*
     * The live-stream half, kept above every DOM lookup so `require`ing this file in Node
     * gets the pure functions and stops — see _dev/live-stream.test.mjs.
     */

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

    const widget = document.getElementById('widget');
    const artworkBg = document.getElementById('artworkBg');
    // The frosted strip behind the controls is a blurred copy of the cover, not a
    // backdrop-filter (styles.css explains why), so it has to be driven in lockstep with
    // .artwork-bg: same image, same fade, or the frost lags the art it is a copy of.
    const controlsFrost = document.getElementById('controlsFrost');
    const coverLayers = [artworkBg, controlsFrost].filter(Boolean);

    // Which cover swap is current. A decode is asynchronous, so a fast track change can land a
    // second request while the first is still decoding; without this the older image could
    // finish last and win.
    let coverToken = 0;

    /* Blur the cover ONCE, into an image, rather than leaving a live `filter` in the tree.

       A CSS `filter` is re-evaluated as part of compositing, so anything painted over it that
       gets its own layer (which `.info` and `.controls` do, since they must sit above the
       frost) is composited separately against it. That left visible rectangular seams at
       exactly those elements' bounds: a lighter, sharper block around the title and around a
       pressed button.

       The blur is written out longhand below rather than handed to the platform, because both
       of the ways of asking the platform for it are broken here:

         - `ctx.filter = 'blur(Npx)'` assigns and reads back verbatim, so the obvious feature
           test says it is supported, and `drawImage` then ignores it completely. Measured, not
           assumed: the mean gradient of the output is identical to the unfiltered draw, to two
           decimals, at radius 4, 8, 16 and 32.
         - Blurring by downscaling the cover to a thumbnail and letting `background-size` stretch
           it back up is what this used to do, and it is not a blur. Bilinear interpolation
           between samples that far apart is piecewise linear, so it creases along the sample
           grid, and exporting the thumbnail as JPEG added 8x8 blocking on top of that. Both
           read as SQUARES in the finished bar, which is the artifact this replaces.

       Three box passes approximate a Gaussian closely enough that nothing is left to facet, and
       at this size the whole thing costs single-digit milliseconds, once per track. */

    // The frost is rendered at this size and stretched over the card by `background-size: cover`.
    // It only has to carry what survives the blur, so it is deliberately small.
    const FROST_SIZE = 256;
    // Blur radius per box pass, in pixels of that image. The blur knob: higher is blurrier.
    const FROST_BLUR = 5;

    // One separable box pass, single channel, with the window clamped at the edges so the
    // picture is extended rather than faded out. A blur that samples past the edge would leave
    // a transparent fringe, and a transparent fringe here shows the sharp cover underneath.
    function boxH(src, dst, w, h, r) {
        const iarr = 1 / (r + r + 1);
        for (let i = 0; i < h; i++) {
            let ti = i * w, li = ti, ri = ti + r;
            const fv = src[ti], lv = src[ti + w - 1];
            let val = (r + 1) * fv;
            for (let j = 0; j < r; j++) val += src[ti + j];
            for (let j = 0; j <= r; j++) { val += src[ri++] - fv; dst[ti++] = Math.round(val * iarr); }
            for (let j = r + 1; j < w - r; j++) { val += src[ri++] - src[li++]; dst[ti++] = Math.round(val * iarr); }
            for (let j = w - r; j < w; j++) { val += lv - src[li++]; dst[ti++] = Math.round(val * iarr); }
        }
    }

    function boxV(src, dst, w, h, r) {
        const iarr = 1 / (r + r + 1);
        for (let i = 0; i < w; i++) {
            let ti = i, li = ti, ri = ti + r * w;
            const fv = src[ti], lv = src[ti + w * (h - 1)];
            let val = (r + 1) * fv;
            for (let j = 0; j < r; j++) val += src[ti + j * w];
            for (let j = 0; j <= r; j++) { val += src[ri] - fv; dst[ti] = Math.round(val * iarr); ri += w; ti += w; }
            for (let j = r + 1; j < h - r; j++) { val += src[ri] - src[li]; dst[ti] = Math.round(val * iarr); li += w; ri += w; ti += w; }
            for (let j = h - r; j < h; j++) { val += lv - src[li]; dst[ti] = Math.round(val * iarr); li += w; ti += w; }
        }
    }

    /// Blur `pixels` in place. Alpha is left alone: the cover is opaque and the tint is painted
    /// over all of it, so every pixel here is already fully opaque.
    function blurInPlace(pixels, radius) {
        const w = pixels.width, h = pixels.height, px = pixels.data, n = w * h;
        if (radius < 1 || n === 0) return pixels;
        const a = new Uint16Array(n), b = new Uint16Array(n);
        for (let c = 0; c < 3; c++) {
            for (let i = 0; i < n; i++) a[i] = px[i * 4 + c];
            boxH(a, b, w, h, radius); boxV(b, a, w, h, radius);
            boxH(a, b, w, h, radius); boxV(b, a, w, h, radius);
            boxH(a, b, w, h, radius); boxV(b, a, w, h, radius);
            for (let i = 0; i < n; i++) px[i * 4 + c] = a[i];
        }
        return pixels;
    }

    /// The overlay colour for the current theme, read from CSS so the palette lives in one
    /// place. Canvas takes a CSS colour string directly, so no parsing is needed.
    function frostOverlay() {
        const value = getComputedStyle(document.documentElement)
            .getPropertyValue('--frost-overlay').trim();
        return value || 'rgba(0, 0, 0, 0.42)';
    }

    function blurredCover(img) {
        const w = img.naturalWidth || FROST_SIZE;
        const h = img.naturalHeight || FROST_SIZE;
        const scale = FROST_SIZE / Math.max(w, h);

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        // The tint goes in BEFORE the blur, and before the controls are drawn over it, which is
        // what keeps the glyphs legible on a pale cover. As a CSS layer on top it was doing the
        // same arithmetic, but it could not survive the frost becoming an image, and baking it
        // in means the bar and the frost cannot drift apart.
        ctx.fillStyle = frostOverlay();
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
        ctx.putImageData(blurInPlace(pixels, FROST_BLUR), 0, 0);

        // PNG, not JPEG. This is a smooth field stretched to several times its own size, which
        // is exactly the content 8x8 block artifacts are most visible in.
        return canvas.toDataURL('image/png');
    }

    // Decode first, then set the sharp cover and its blurred copy together.
    //
    // Both layers have to change on the same frame or the picture visibly changes before the
    // frost does. Decoding first also means `blurredCover` has real pixels to work from.
    function setCoverImage(url, onApplied) {
        const token = ++coverToken;
        const img = new Image();

        const apply = function () {
            if (token !== coverToken) return;   // superseded by a newer track
            let frostURL = url;
            try {
                frostURL = blurredCover(img);
            } catch (e) {
                // A tainted or undecodable canvas must not cost the widget its frost; the
                // unblurred cover under the tint is a worse frost, not a broken widget.
            }
            artworkBg.style.backgroundImage = 'url(' + url + ')';
            if (controlsFrost) controlsFrost.style.backgroundImage = 'url(' + frostURL + ')';
            if (onApplied) onApplied();
        };

        img.src = url;
        // `decode()` resolves once the image is ready to paint; `onload` only promises the bytes
        // arrived. Fall back for older WebKit, and apply on failure rather than stranding the
        // widget on a stale cover.
        if (img.decode) {
            img.decode().then(apply, apply);
        } else {
            img.onload = apply;
            img.onerror = apply;
        }
    }

    function setCoverVisible(visible) {
        coverLayers.forEach(function (el) { el.classList.toggle('visible', visible); });
    }

    const noArtwork = document.getElementById('noArtwork');
    const title = document.getElementById('title');
    const artist = document.getElementById('artist');
    const prevBtn = document.getElementById('prevBtn');
    const playPauseBtn = document.getElementById('playPauseBtn');
    const nextBtn = document.getElementById('nextBtn');
    const liveBadge = document.getElementById('liveBadge');

    let currentArtworkURL = null;
    let settings = {};
    let artworkTransitionTimeout = null;

    // Mirror for a right-to-left host language. Applied on state rather than at startup:
    // window.NepTunes.state is null until the host's first push, which happens in
    // webView(_:didFinish:) — after DOMContentLoaded, where init() runs. Reading it at
    // startup throws TypeError every time.
    function applyDirection(state) {
        if (state && state.layoutDirection) {
            document.documentElement.dir = state.layoutDirection;
        }
    }

    function updateUI(state) {
        applyDirection(state);
        if (!state || !state.track) {
            widget.classList.remove('playing', 'live');
            title.textContent = 'Not Playing';
            artist.textContent = '';
            setCoverVisible(false);
            noArtwork.classList.remove('hidden');
            // Nothing playing must not block transport — pressing next may start playback.
            prevBtn.disabled = false;
            nextBtn.disabled = false;
            prevBtn.hidden = false;
            nextBtn.hidden = false;
            liveBadge.hidden = true;
            return;
        }

        var isAd = !!state.track.isAdvertisement;
        title.textContent = isAd ? 'Advertisement' : (state.track.title || 'Unknown Title');
        artist.textContent = isAd ? '' : (state.track.artist || '');

        // Greyed out during a Spotify ad — Spotify refuses to skip one.
        // `isAdvertisement` is only ever sent when true, so a missing value here
        // correctly reads as "not an ad". The native bridge already refuses next()/
        // previous() regardless; this just keeps the button from inviting a tap that
        // silently does nothing.
        const adPlaying = !!state.track.isAdvertisement;
        prevBtn.disabled = adPlaying;
        nextBtn.disabled = adPlaying;

        // Hidden, not greyed, during a live stream — see transportHidden. LIVE takes the
        // space they leave, off to the right of a play button that stays dead centre.
        const isLive = transportHidden(state.track);
        prevBtn.hidden = isLive;
        nextBtn.hidden = isLive;
        liveBadge.hidden = !isLive;
        widget.classList.toggle('live', isLive);

        if (state.playerState === 2) {
            widget.classList.add('playing');
        } else {
            widget.classList.remove('playing');
        }

        // The glyph is the button's only content — its <img> carries an empty alt so the
        // icon is not announced twice — so the label has to follow the glyph.
        const glyph = transportGlyph(state.playerState, isLive);
        playPauseBtn.setAttribute('aria-label', glyph === 'stop' ? 'Stop' : (glyph === 'pause' ? 'Pause' : 'Play'));

        const artworkURL = window.NepTunes.getArtworkDataURL();
        if (artworkURL !== currentArtworkURL) {
            if (artworkTransitionTimeout) {
                clearTimeout(artworkTransitionTimeout);
                artworkTransitionTimeout = null;
            }
            if (artworkURL) {
                if (currentArtworkURL) {
                    // Fade out, then change and fade in
                    setCoverVisible(false);
                    artworkTransitionTimeout = setTimeout(() => {
                        setCoverImage(artworkURL, function () {
                            setCoverVisible(true);
                            noArtwork.classList.add('hidden');
                        });
                        artworkTransitionTimeout = null;
                    }, 300);
                } else {
                    // No previous artwork, just set and fade in
                    setCoverImage(artworkURL, function () {
                        setCoverVisible(true);
                        noArtwork.classList.add('hidden');
                    });
                }
            } else {
                setCoverVisible(false);
                noArtwork.classList.remove('hidden');
            }
            currentArtworkURL = artworkURL;
        }
    }

    /* Theme.

       `auto` resolves against the desktop appearance, which CSS handles on its own through the
       `prefers-color-scheme` query on `.theme-auto`. Two things do not follow for free: the
       SF Symbols, whose tint is baked into the PNG at load time (sfsymbols.js re-rasterises
       them on `themechange` itself), and the frost, which has the overlay colour composited
       into it and therefore has to be rebuilt from the cover whenever that colour changes. */
    function applyTheme() {
        const root = document.documentElement;
        root.classList.remove('theme-auto', 'theme-dark', 'theme-light');
        root.classList.add('theme-' + (settings.theme || 'auto'));
        rebuildFrost();
        // Last: sfsymbols.js reads the icon colour synchronously off computed style, so the
        // class above has to have landed first.
        if (window.SFSymbols) SFSymbols.reload();
    }

    /// Re-derive the frost from the cover already on screen, without touching the sharp layer
    /// or re-running the fade. Used when the overlay colour changes under a static track.
    function rebuildFrost() {
        if (!currentArtworkURL || !controlsFrost) return;
        const url = currentArtworkURL;
        const img = new Image();
        const apply = function () {
            if (url !== currentArtworkURL) return;   // track changed while we were decoding
            try {
                controlsFrost.style.backgroundImage = 'url(' + blurredCover(img) + ')';
            } catch (e) { /* keep whatever frost is already there */ }
        };
        img.src = url;
        if (img.decode) { img.decode().then(apply, apply); } else { img.onload = apply; }
    }

    function setupResize() {
        const resizeHandle = document.getElementById('resizeHandle');
        let isResizing = false;
        let startX = 0, startY = 0;

        resizeHandle.addEventListener('mousedown', (e) => {
            isResizing = true;
            startX = e.screenX;
            startY = e.screenY;
            e.preventDefault();
            e.stopPropagation();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const deltaX = e.screenX - startX;
            const deltaY = e.screenY - startY;
            startX = e.screenX;
            startY = e.screenY;
            // Average both deltas to maintain 1:1 aspect ratio
            const delta = (deltaX + deltaY) / 2;
            window.webkit.messageHandlers.neptunes.postMessage({
                type: 'resizeMove',
                deltaX: delta,
                deltaY: delta
            });
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                window.webkit.messageHandlers.neptunes.postMessage({ type: 'resizeEnd' });
            }
        });
    }

    function init() {
        if (!window.NepTunes) {
            console.error('NepTunes API not available');
            return;
        }

        // Theme before anything paints, so the first frost is built with the right overlay and
        // the icons rasterise in the right ink.
        settings = window.NepTunes.settings || {};
        applyTheme();

        updateUI(window.NepTunes.state);
        if (window.SFSymbols) SFSymbols.load();
        window.NepTunes.on('statechange', updateUI);

        window.NepTunes.on('settingschange', function (next) {
            settings = next || {};
            applyTheme();
        });

        // The desktop flipped light/dark. Only `auto` follows it; an explicit choice already
        // renders correctly and must not be overridden. CSS re-resolves the palette on its own
        // and sfsymbols.js re-tints the glyphs itself, so the only thing left to redo here is
        // the frost, which has the old overlay colour baked into its pixels.
        window.NepTunes.on('themechange', function () {
            if ((settings.theme || 'auto') !== 'auto') return;
            rebuildFrost();
        });

        prevBtn.addEventListener('click', () => {
            window.NepTunes.previous();
        });

        playPauseBtn.addEventListener('click', () => {
            window.NepTunes.playPause();
        });

        nextBtn.addEventListener('click', () => {
            window.NepTunes.next();
        });

        setupResize();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
