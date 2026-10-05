/*
 * V3 — a 1:1 web port of the NepTunes 3 "V1" theme.
 *
 * UMD, matching Minimal.nepget/script.js: the factory's pure functions are
 * `require`-able from Node (SampleWidgets/_dev/v3.test.mjs pins them), and the
 * bundle self-starts inside the WebView. Every DOM lookup happens in init() —
 * there is no `document` when this file is required from Node.
 *
 * Ported behaviour, with its NepTunes 3 source:
 *   Themes/V1/Views/ThemeWindow.swift  — scrollWheel (axis test, /1.5, swipe), double-click
 *   Themes/V1/ThemeController.swift    — volume clamp, the two preference gates
 *   Themes/V1/InfoController.swift     — the 4 s track-change reveal
 *   Themes/V1/Views/HoverView.swift    — glyph states, the volume popover
 *   Themes/V1/Views/ArtworkView.swift  — when the reveal is triggered
 */
(function (factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else api.start();
})(function () {
    'use strict';

    // ------------------------------------------------------------- constants --

    var REVEAL_MS = 4000;          // InfoController's Timer.publish(every: 4)
    var SWIPE_THRESHOLD = 50;      // accumulated deltaX px before a swipe fires
    var SWIPE_QUIET_MS = 500;      // wheel silence that re-arms the swipe
    var WHEEL_SETTLE_MS = 350;     // wheel silence before the host's volume is authoritative again
    var VOLUME_THROTTLE_MS = 100;  // slider -> setVolume rate limit
    var ARTWORK_FADE_MS = 220;
    // A little longer than the motion video's 0.22 s opacity fade (styles.css `.motion`, the same
    // fade as ARTWORK_FADE_MS), so an outgoing <video> is let go only once it is fully faded out.
    var MOTION_FADE_MS = 300;
    var TRANSPARENT_PX =
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    // ---------------------------------------------------------------- pure ----
    // Nothing below this line until init() touches the DOM or `window`.

    /*
     * One wheel event's worth of volume change. Ports V1Window.scrollWheel's
     * `delta /= 1.5; Int(round(delta))`, plus a carried remainder so a slow scroll
     * is not rounded away to nothing on every event.
     *
     * `inverted` is WheelEvent.webkitDirectionInvertedFromDevice. With natural
     * scrolling ON — the macOS default — fingers-away gives a positive DOM deltaY
     * and V1 made fingers-away mean louder; with it OFF the DOM sign flips, so the
     * delta is negated. A missing value must be read as `true` by the caller.
     *
     * Rounding is deliberately plain Math.round, including its -0 at -0.5: the
     * carried remainder makes the exact tie behaviour unobservable, and hand-rolling
     * Swift's rounding here would only invent a second thing to get wrong.
     */
    function volumeStep(rawDeltaY, inverted, accum) {
        if (!Number.isFinite(rawDeltaY) || !Number.isFinite(accum)) {
            return { step: 0, accum: 0 };
        }
        var signed = inverted ? rawDeltaY : -rawDeltaY;
        var next = accum + signed / 1.5;
        var step = Math.round(next);
        return { step: step, accum: next - step };
    }

    // ThemeController.userDidChangeVolumeWithDelta's 0...100 pin.
    function clampVolume(v) {
        if (!Number.isFinite(v)) return 0;
        return Math.max(0, Math.min(100, Math.round(v)));
    }

    /*
     * SecondaryControls.symbolNameForVolume. Swift matched the FIRST of its
     * overlapping ranges, so every boundary belongs to the quieter symbol: 25 is
     * `speaker`, 50 is wave.1, 75 is wave.2. 0 < v < 1 matched no range at all and
     * fell through to `default` — reproduced here rather than tidied up.
     */
    function speakerSymbol(volume) {
        if (!Number.isFinite(volume)) return 'speaker';
        if (volume === 0) return 'speaker.slash';
        if (volume >= 1 && volume <= 25) return 'speaker';
        if (volume > 25 && volume <= 50) return 'speaker.wave.1';
        if (volume > 50 && volume <= 75) return 'speaker.wave.2';
        if (volume > 75 && volume <= 100) return 'speaker.wave.3';
        return 'speaker';
    }

    // Host repeat modes: 1 = all, 2 = one, 3 = off.
    function repeatSymbol(mode) {
        return mode === 2 ? 'repeat.1' : 'repeat';
    }

    /*
     * Whether prev/next should be HIDDEN right now — a live stream, not an ad.
     * `track.isLiveStream` is only ever sent when true (omitted for an ordinary track),
     * so a missing value must read as "not live" rather than throw or misreport. `track`
     * itself may be undefined (nothing playing), which must NOT hide the buttons — pressing
     * next may start playback. The bridge already refuses next()/previous() during a live
     * stream centrally (WidgetTransportGuard); hiding here just keeps the row from
     * offering a button that can only mislead.
     */
    function transportHidden(track) {
        return !!(track && track.isLiveStream);
    }

    /*
     * Which of the three play-button glyphs applies. playerState 2 is playing; a live
     * stream only differs while playing, because resuming one restarts it rather than
     * resuming where it left off — there is no "paused, will continue from here" state.
     */
    function transportGlyph(playerState, isLiveStream) {
        if (playerState !== 2) return 'play';
        return isLiveStream ? 'stop' : 'pause';
    }

    function repeatIsOn(mode) {
        return mode === 1 || mode === 2;
    }

    /*
     * Whether the LIVE indicator should be hidden. It lives inside the hover panel now,
     * next to the play/stop button, rather than beside the track title — so its own
     * `hidden` attribute only ever needs to track the stream itself; the panel's
     * `html.nt-hover` opacity gate (styles.css) is what makes it appear and disappear
     * with the rest of the transport on hover. Pure and exported so _dev/v3.test.mjs can
     * pin the contract without a DOM.
     */
    function liveBadgeHidden(isLive) {
        return !isLive;
    }

    // V1Window.scrollWheel's `abs(scrollingDeltaX) <= abs(scrollingDeltaY)`, so a
    // dead-still 0,0 event counts as vertical exactly as it did in AppKit.
    function wheelAxis(deltaX, deltaY) {
        var x = Number.isFinite(deltaX) ? Math.abs(deltaX) : 0;
        var y = Number.isFinite(deltaY) ? Math.abs(deltaY) : 0;
        return x <= y ? 'vertical' : 'horizontal';
    }

    /*
     * Positive accumulated deltaX (fingers travelling left) is next, matching V1's
     * `amount > 0` branch. Exactly at the threshold fires.
     */
    function swipeDecision(accumX, threshold) {
        if (!Number.isFinite(accumX)) return null;
        var t = Number.isFinite(threshold) ? threshold : SWIPE_THRESHOLD;
        if (accumX >= t) return 'next';
        if (accumX <= -t) return 'previous';
        return null;
    }

    /*
     * ArtworkView's `showFullInfo ? .infinity : (simpleMode ? 0 : 28)`.
     * The reveal wins over the hide preference.
     */
    function infoBarState(hideLabel, revealing) {
        if (revealing) return 'full';
        if (hideLabel) return 'hidden';
        return 'bar';
    }

    /*
     * The "Nothing playing" state is simply no track. With no player running the host sends
     * no track, no playerType and playerState 0 (not 1); a player stopped at the end of its
     * queue WITH its last track still shows that track.
     */
    function isEmpty(state) {
        return !(state && state.track);
    }

    /*
     * Motion artwork (NepTunes 4.1). A widget declaring "supportsMotionArtwork" gets the album's
     * animated cover as track.motionArtworkURL: a local URL for a <video src>, and nothing more
     * (fetch() of it fails). It is absent on older apps, with the user's "Animated cover" off, for
     * an album with no loop, until the loop has downloaded (a few seconds after the track change,
     * via another statechange), under Reduce Motion or Low Power, without Pro, after an explicit
     * Stop and during an ad. Every one of those, and any failure, leaves the static cover — which
     * is always underneath, and which the frost keeps being made from.
     *
     * This half is a copy of Sleeve.nepget's (the reference implementation, pinned by
     * _dev/sleeve.test.mjs); duplicated like the frost block below, because a bundle is a
     * self-contained folder. Keep the two in step by hand.
     *
     * What the cover should be doing: which loop, for which album, and whether it plays. A loop is
     * shown only for a track that is playing or paused — not when stopped (the end of the queue
     * can keep the last track AND its URL, so this keys off playerState, never off the URL being
     * there), not for an ad, and never under prefers-reduced-motion. Paused keeps the loop and its
     * current frame without playing it.
     */
    function motionState(state, reducedMotion) {
        var off = { src: null, album: null, play: false };
        var track = state && state.track;
        if (!track || track.isAdvertisement || reducedMotion) return off;
        var src = typeof track.motionArtworkURL === 'string' ? track.motionArtworkURL : '';
        var playerState = state.playerState;
        if (!src || (playerState !== 2 && playerState !== 3)) return off;
        return { src: src, album: track.album || '', play: playerState === 2 };
    }

    /*
     * The <video>s over the static cover. Each loop gets its own element, keyed by URL and album:
     * the next track on the same album carries the same URL and keeps playing untouched, while an
     * album change retires the old loop at once — so the old album's video fades out as the new
     * cover arrives rather than playing over it. An outgoing video fades out and is then released
     * (src removed + load(), so WebKit drops the decoder and the file) while its successor loads.
     * A video is revealed only once a frame is actually on screen — requestVideoFrameCallback, or
     * playback advancing past 0 with data in hand — never on "loaded", which can still paint
     * black. A hidden widget window loads no media at all until it is shown, so until then it
     * simply stays on the static art.
     *
     *   opts.container    element the videos go into (#motionLayer, inside the clipped card)
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

    /*
     * Swaps the rasterised SF Symbol in an <img> so that src and data-shown always name the same
     * glyph: the speaker states are shifted in CSS by data-shown (styles.css), and a shift applied
     * to the wrong glyph puts it 8pt off. SFSymbols.setSrc cannot promise that — it swallows
     * failures and writes whichever answer arrives last — so this asks the bridge directly:
     *
     *  - data-symbol changes at once, because SFSymbols.reload() re-fetches it on a theme flip;
     *  - only the newest request per control may land, and only with a non-empty URL, after the
     *    image has decoded (so the old glyph never paints a frame at the new offset), and then src
     *    and data-shown change together;
     *  - a failed newest request keeps the old glyph and puts data-symbol back to it (a reload then
     *    fetches what is shown), and forgets the wish, so the next state push asks again.
     *
     * opts: symbol(name, {size, color}) -> Promise<url>, color(img) -> tint, decode(url) ->
     * Promise, current: { key: name } as index.html starts.
     */
    function createSymbolSwapper(opts) {
        var symbol = opts.symbol;
        var color = opts.color;
        var decode = opts.decode || function () { return Promise.resolve(); };
        var current = opts.current;
        var latest = {};

        function set(img, key, name) {
            if (!img || current[key] === name) return;
            current[key] = name;
            img.dataset.symbol = name;
            var token = latest[key] = (latest[key] || 0) + 1;
            function fresh() { return latest[key] === token; }
            function fail() {
                if (!fresh()) return;
                current[key] = img.dataset.shown;
                img.dataset.symbol = img.dataset.shown;
            }
            var request;
            try {
                request = Promise.resolve(symbol(name, { size: +img.dataset.size, color: color(img) }));
            } catch (e) {
                request = Promise.reject(e);
            }
            request.then(function (url) {
                if (!fresh()) return;
                if (!url) { fail(); return; }
                return decode(url).then(function () {
                    if (!fresh()) return;
                    img.src = url;
                    img.dataset.shown = name;
                });
            }).catch(fail);
        }

        return { set: set };
    }

    function decodeImage(url) {
        if (typeof Image === 'undefined') return Promise.resolve();
        var probe = new Image();
        probe.src = url;
        return typeof probe.decode === 'function' ? probe.decode() : Promise.resolve();
    }

    // ----------------------------------------------------------------- DOM ----

    var widget, cover, nocover, infoBar, titleEl, artistEl, liveBadge;
    var infoFrost, hoverFrost, popoverFrost;
    var motion = null;             // createMotionLayer over #motionLayer, made in init()
    var reducedMotionQuery = null; // matchMedia('(prefers-reduced-motion: reduce)'), or null
    var shuffleBtn, repeatBtn, repeatIcon, loveBtn, loveIcon, volumeBtn, volumeIcon;
    var prevBtn, playBtn, nextBtn, volumePopover, volumeSlider, resizeHandle, emptyOpen;

    // Settings, defaulted exactly like the manifest schema.
    var hideLabel = false;
    var showInfoOnTrackChange = true;
    var scrollToChangeVolume = true;
    var doubleClickActivatesPlayer = true;

    var lastState = null;
    var lastTrackId = null;
    var lastArtworkURL;         // undefined, not null: the first pass must run even with
                                // no artwork, so #cover gets a real (transparent) src
                                // instead of whatever the markup shipped with
    var revealing = false;
    var revealTimer = null;

    var wheelAccum = 0;         // carried volume remainder
    /*
     * Optimistic volume target for the duration of a scroll gesture, and the timer that
     * retires it once the wheel goes quiet.
     *
     * Basing every event on the last PUSHED state.volume — which is what V1 did, because
     * AppKit -> AppleScript was one hop — throws most of a trackpad gesture on the floor
     * here. A flick delivers ~60 events/second while the answer has to come back through
     * AppleScript, the main app, XPC and a state push. Every event in that window
     * computes the same `pushed + step`, and all but the first are dropped as duplicates,
     * so the gesture advances one step per round trip instead of accumulating.
     *
     * So the base is our own last target while the gesture is live, and reverts to the
     * host's value once it has had WHEEL_SETTLE_MS of quiet to catch up. That keeps the
     * host authoritative — a volume changed elsewhere still wins — without making the
     * scroll feel like it is ignoring you.
     */
    var wheelTarget = null;
    var wheelSettleTimer = null;
    var swipeAccumX = 0;
    var swipeLocked = false;
    var swipeQuietTimer = null;

    var sliderActive = false;   // pointer is down on the volume slider
    var volumeSentAt = 0;
    var volumeTimer = null;
    var volumePending = null;

    // data-symbol as it stands in index.html, so the first state push only re-rasterises
    // a glyph that actually changed.
    var currentSymbols = { repeat: 'repeat', love: 'heart', volume: 'speaker.wave.2' };

    var symbolSwapper = null;

    /* Swap a control's glyph — see createSymbolSwapper. */
    function setSymbol(img, key, name) {
        if (!symbolSwapper) {
            symbolSwapper = createSymbolSwapper({
                symbol: function (n, o) { return window.NepTunes.symbol(n, o); },
                color: function (el) { return window.SFSymbols ? SFSymbols.getColor(el) : '#ffffff'; },
                decode: decodeImage,
                current: currentSymbols
            });
        }
        symbolSwapper.set(img, key, name);
    }

    // ------------------------------------------------------------- settings --

    function applySettings(settings) {
        settings = settings || {};
        // `!== false` so a host that has not merged the schema defaults still gets them.
        hideLabel = settings.hideLabel === true;
        showInfoOnTrackChange = settings.showInfoOnTrackChange !== false;
        scrollToChangeVolume = settings.scrollToChangeVolume !== false;
        doubleClickActivatesPlayer = settings.doubleClickActivatesPlayer !== false;
        applyInfoBar();
    }

    // ------------------------------------------------------- info bar/reveal --

    function applyInfoBar() {
        var state = infoBarState(hideLabel, revealing);
        infoBar.classList.toggle('collapsed', state === 'hidden');
        infoBar.classList.toggle('full', state === 'full');
    }

    /*
     * InfoController.showInfo: cancel any pending timer, show, hide again 4 s later.
     * Restarting rather than stacking is the point — two quick track changes must give
     * one 4 s window measured from the second, not two overlapping ones.
     */
    function showInfo() {
        if (revealTimer) clearTimeout(revealTimer);
        revealing = true;
        applyInfoBar();
        revealTimer = setTimeout(function () {
            revealTimer = null;
            revealing = false;
            applyInfoBar();
        }, REVEAL_MS);
    }

    /*
     * Identity, not object identity: the host rebuilds `track` on every push, so
     * comparing references would fire the reveal several times a second. V1 compared
     * AnyTrack by value.
     */
    function trackIdentity(track) {
        if (!track) return null;
        // JSON, not a NUL-joined string. A literal NUL byte in the source makes `file`
        // report the whole script as binary and makes grep skip it silently. A plain
        // space would let ("A B", "C") collide with ("A", "B C"); JSON.stringify is
        // unambiguous without smuggling a control character into a source file.
        return JSON.stringify([track.title || '', track.artist || '', track.album || '']);
    }

    // ----------------------------------------------------------------- frost --
    /* The frost behind `.info-bar` and `.hover` is a blurred, tinted copy of the cover
       rather than a `backdrop-filter` (styles.css says why), so it is built here, once
       per track, and set as a plain background image on both panels.

       This block is a copy of Artwork.nepget's, which is where the blur was measured and
       tuned, and is duplicated for the same reason `sfsymbols.js` is duplicated: a bundle
       is a self-contained folder and there is no shared runtime to put it in. Keep the two
       in step by hand, or move both to a shared file.

       Two ways of asking the platform for the blur were tried and neither works. Setting
       `ctx.filter = 'blur(Npx)'` assigns and reads back verbatim, so the obvious feature
       test says it is supported, then `drawImage` ignores it entirely: the mean gradient of
       the output is identical to the unfiltered draw at radius 4, 8, 16 and 32. And blurring
       by downscaling the cover to a thumbnail, then letting `background-size` stretch it
       back, is not a blur at all — bilinear interpolation between samples that far apart is
       piecewise linear, so it creases along the sample grid, and a JPEG export adds 8x8
       blocking on top. Both read as SQUARES in the finished panel. */

    // The frost is rendered at this size and stretched over the card by `background-size: cover`.
    // It only has to carry what survives the blur, so it is deliberately small.
    const FROST_SIZE = 256;
    // Blur radius per box pass, in pixels of that image. The blur knob: higher is blurrier.
    //
    // 35 reproduces the `--material-blur: blur(22px)` this replaced. The frost is exported at
    // FROST_SIZE and scaled to the card by `background-size: cover`, so a radius here is worth
    // `r * card / FROST_SIZE` on screen: at the 160pt default card that is 35 * 160/256 = 22.
    // Note this scales with the card where the CSS filter did not — resized to the 460pt
    // maximum the frost stays proportionally the same wash rather than getting sharper, which
    // is the better behaviour of the two and the reason not to chase an exact match at every
    // size by re-exporting on resize.
    const FROST_BLUR = 35;

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
            .getPropertyValue('--material').trim();
        return value || 'rgba(0, 0, 0, 0.58)';
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

    /// Paint `dataURL` behind the frosted panels and the volume popover, or clear them when
    /// there is no cover so they fall back to their flat backgrounds over the no-cover field.
    function setFrost(dataURL) {
        [infoFrost, hoverFrost, popoverFrost].forEach(function (el) {
            if (!el) return;
            el.style.backgroundImage = dataURL ? 'url(' + dataURL + ')' : '';
        });
    }

    /// The frost for `img`, or null if the canvas refuses — a panel with no frost is a
    /// flatter panel, not a broken widget.
    function frostFor(img) {
        try {
            return blurredCover(img);
        } catch (e) {
            return null;
        }
    }

    // --------------------------------------------------------------- artwork --

    function applyArtwork() {
        var url = null;
        if (typeof window.NepTunes.getArtworkDataURL === 'function') {
            url = window.NepTunes.getArtworkDataURL();
        }
        // artworkData is omitted from a push when it has not changed, so the previous
        // value is what tells us whether anything actually moved.
        if (url === lastArtworkURL) return;
        lastArtworkURL = url;

        if (!url) {
            cover.src = TRANSPARENT_PX;
            nocover.classList.remove('hidden');
            setFrost(null);
            return;
        }

        // Decode first, then swap: assigning src directly blanks the element until the new
        // bytes land, which reads as a flash between tracks. The fade is driven from here
        // rather than from a class, because the DOM contract gives #cover no state class
        // and inventing one would need CSS this bundle's markup agent never wrote.
        var pre = new Image();
        pre.onload = function () {
            if (lastArtworkURL !== url) return;  // a newer track won the race
            cover.src = url;
            // From the image that was just decoded, on the same turn the cover is swapped:
            // the frost is a copy of the picture and must never lag behind it.
            setFrost(frostFor(pre));
            nocover.classList.add('hidden');
            if (typeof cover.animate === 'function') {
                try {
                    cover.animate([{ opacity: 0 }, { opacity: 1 }],
                                  { duration: ARTWORK_FADE_MS, easing: 'ease-out' });
                } catch (e) { /* WAAPI is a nicety, never a requirement */ }
            }
        };
        pre.onerror = function () {
            if (lastArtworkURL !== url) return;
            cover.src = TRANSPARENT_PX;
            nocover.classList.remove('hidden');
            setFrost(null);
        };
        pre.src = url;
    }

    // -------------------------------------------------------- motion artwork --

    // Re-evaluated on every state push and whenever prefers-reduced-motion flips.
    function updateMotion() {
        if (!motion) return;
        var reduced = !!(reducedMotionQuery && reducedMotionQuery.matches);
        motion.update(motionState(lastState, reduced));
    }

    // ------------------------------------------------------------------ state --

    // Mirror for a right-to-left host language. Read off state, not at startup:
    // window.NepTunes.state is null until the host's first push, which lands after
    // DOMContentLoaded.
    function applyDirection(state) {
        if (state && state.layoutDirection) {
            document.documentElement.dir = state.layoutDirection;
        }
    }

    function updateUI(state) {
        lastState = state || null;
        applyDirection(state);

        var track = state && state.track;
        var isAd = !!(track && track.isAdvertisement);
        var isLive = !!(track && track.isLiveStream);

        widget.classList.toggle('empty', isEmpty(state));
        if (!track) {
            titleEl.textContent = 'Nothing playing';
            artistEl.textContent = '';
            // Nothing to set the volume of from here; don't leave the popover hanging open.
            volumePopover.classList.remove('open');
        } else {
            // Never show the advertiser's own copy.
            titleEl.textContent = isAd ? 'Advertisement' : (track.title || 'Unknown Title');
            artistEl.textContent = isAd ? '' : (track.artist || '');
        }
        liveBadge.hidden = liveBadgeHidden(isLive);

        // Spotify refuses to skip an ad and the bridge drops the call anyway; disabling
        // just stops the button inviting a tap that does nothing. No track is NOT an ad —
        // pressing next may start playback.
        prevBtn.disabled = isAd;
        nextBtn.disabled = isAd;

        // Hidden, not greyed, during a live stream — see transportHidden.
        prevBtn.hidden = transportHidden(track);
        nextBtn.hidden = transportHidden(track);

        var playerState = state && state.playerState;
        var glyph = transportGlyph(playerState, isLive);
        widget.classList.toggle('playing', playerState === 2);
        widget.classList.toggle('live', isLive);
        playBtn.setAttribute('aria-label',
            glyph === 'stop' ? 'Stop' : (glyph === 'pause' ? 'Pause' : 'Play'));

        // Shuffle / repeat.
        shuffleBtn.classList.toggle('on', !!(state && state.shuffleEnabled));
        var mode = state ? state.repeatMode : undefined;
        repeatBtn.classList.toggle('on', repeatIsOn(mode));
        setSymbol(repeatIcon, 'repeat', repeatSymbol(mode));

        // Third secondary slot: V1 gave Apple Music the heart and Spotify the speaker.
        // Expressed here as the capability it actually stood for.
        var caps = (state && state.capabilities) || {};
        var canLove = !!caps.canLove;
        loveBtn.classList.toggle('hidden', !canLove);
        volumeBtn.classList.toggle('hidden', canLove);
        if (canLove && volumePopover.classList.contains('open')) {
            volumePopover.classList.remove('open');
        }

        var loved = !!(state && (state.isLoved || (track && track.isLoved)));
        loveBtn.classList.toggle('on', canLove && loved);
        setSymbol(loveIcon, 'love', loved ? 'heart.fill' : 'heart');

        // Volume. Driven from the push, never from the assumption that our own
        // setVolume() landed — a widget without the volumeControl permission has its
        // calls dropped silently.
        if (state && Number.isFinite(state.volume)) {
            if (!sliderActive) volumeSlider.value = String(clampVolume(state.volume));
            setSymbol(volumeIcon, 'volume', speakerSymbol(state.volume));
        }

        applyArtwork();
        // Straight after the cover, on the same push: an album change retires the old loop here,
        // as the new cover starts decoding, so the two go together.
        updateMotion();

        // The reveal, last, so the strip animates over settled text.
        var id = trackIdentity(track);
        if (id !== lastTrackId) {
            lastTrackId = id;
            if (id !== null && showInfoOnTrackChange) showInfo();
        }
    }

    // ---------------------------------------------------------------- volume --

    function sendVolume(v) {
        volumeSentAt = Date.now();
        if (typeof window.NepTunes.setVolume === 'function') window.NepTunes.setVolume(v);
    }

    // Throttled push while dragging: live, but without one AppleScript round trip per
    // pixel of slider travel.
    function throttleVolume(v) {
        var wait = VOLUME_THROTTLE_MS - (Date.now() - volumeSentAt);
        if (wait <= 0) {
            volumePending = null;
            sendVolume(v);
            return;
        }
        volumePending = v;
        if (volumeTimer) return;
        volumeTimer = setTimeout(function () {
            volumeTimer = null;
            if (volumePending === null) return;
            var pending = volumePending;
            volumePending = null;
            sendVolume(pending);
        }, wait);
    }

    // Release commits unconditionally, so the throttle can never swallow the value the
    // user actually let go on.
    function commitVolume(v) {
        if (volumeTimer) {
            clearTimeout(volumeTimer);
            volumeTimer = null;
        }
        volumePending = null;
        sendVolume(v);
    }

    // ----------------------------------------------------------------- wheel --

    function onWheel(e) {
        // Nothing here scrolls; without this the page rubber-bands under the gesture.
        e.preventDefault();
        if (wheelAxis(e.deltaX, e.deltaY) === 'vertical') verticalWheel(e);
        else horizontalWheel(e);
    }

    /* Hand authority for the volume back to the host immediately. */
    function releaseWheelTarget() {
        if (wheelSettleTimer) {
            clearTimeout(wheelSettleTimer);
            wheelSettleTimer = null;
        }
        wheelTarget = null;
    }

    function verticalWheel(e) {
        // ThemeController gated the whole path on the preference, not just the effect.
        if (!scrollToChangeVolume) {
            wheelAccum = 0;
            releaseWheelTarget();
            return;
        }
        var inverted = e.webkitDirectionInvertedFromDevice;
        if (inverted === undefined || inverted === null) inverted = true;  // natural scrolling
        var result = volumeStep(e.deltaY, !!inverted, wheelAccum);
        wheelAccum = result.accum;
        if (!result.step) return;

        // V1 bailed when it had no state volume to add to, and so do we — there is no
        // relative "louder" call to fall back on.
        if (wheelTarget === null && (!lastState || !Number.isFinite(lastState.volume))) return;

        var base = wheelTarget === null ? clampVolume(lastState.volume) : wheelTarget;
        var next = clampVolume(base + result.step);

        // Hold the target even when it did not move, so a gesture that runs into 0 or 100
        // does not fall back to the host's value and start climbing again mid-flick.
        wheelTarget = next;
        if (wheelSettleTimer) clearTimeout(wheelSettleTimer);
        wheelSettleTimer = setTimeout(function () {
            wheelSettleTimer = null;
            wheelTarget = null;
        }, WHEEL_SETTLE_MS);

        if (next === base) return;          // already pinned at 0 or 100
        commitVolume(next);
    }

    function horizontalWheel(e) {
        // Re-armed by silence, not by the event that fired the swipe: a trackpad flick
        // keeps delivering momentum deltas long after the gesture is over, and each one
        // would otherwise skip another track.
        if (swipeQuietTimer) clearTimeout(swipeQuietTimer);
        swipeQuietTimer = setTimeout(function () {
            swipeQuietTimer = null;
            swipeAccumX = 0;
            swipeLocked = false;
        }, SWIPE_QUIET_MS);

        if (swipeLocked || !Number.isFinite(e.deltaX)) return;
        swipeAccumX += e.deltaX;
        var decision = swipeDecision(swipeAccumX, SWIPE_THRESHOLD);
        if (!decision) return;
        swipeLocked = true;
        swipeAccumX = 0;
        if (decision === 'next') window.NepTunes.next();
        else window.NepTunes.previous();
    }

    // -------------------------------------------------------------- gestures --

    function onDoubleClick(e) {
        if (!doubleClickActivatesPlayer) return;
        // Double-tapping next must not also raise the player.
        if (e.target && e.target.closest && e.target.closest('button, input, .slider')) return;
        if (typeof window.NepTunes.activatePlayer === 'function') window.NepTunes.activatePlayer();
    }

    function setupResize() {
        if (!resizeHandle) return;
        var isResizing = false;
        var startX = 0, startY = 0;

        function post(message) {
            if (window.webkit && window.webkit.messageHandlers &&
                window.webkit.messageHandlers.neptunes) {
                window.webkit.messageHandlers.neptunes.postMessage(message);
            }
        }

        resizeHandle.addEventListener('mousedown', function (e) {
            isResizing = true;
            startX = e.screenX;
            startY = e.screenY;
            e.preventDefault();
            e.stopPropagation();
        });

        document.addEventListener('mousemove', function (e) {
            if (!isResizing) return;
            var deltaX = e.screenX - startX;
            var deltaY = e.screenY - startY;
            startX = e.screenX;
            startY = e.screenY;
            // Average both deltas: the cover is square and stays square.
            var delta = (deltaX + deltaY) / 2;
            post({ type: 'resizeMove', deltaX: delta, deltaY: delta });
        });

        document.addEventListener('mouseup', function () {
            if (!isResizing) return;
            isResizing = false;
            post({ type: 'resizeEnd' });
        });
    }

    function setupControls() {
        prevBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            window.NepTunes.previous();
        });
        playBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            window.NepTunes.playPause();
        });
        nextBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            window.NepTunes.next();
        });
        shuffleBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            window.NepTunes.toggleShuffle();
        });
        repeatBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            window.NepTunes.toggleRepeat();
        });
        loveBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (lastState && lastState.capabilities && lastState.capabilities.canLove) {
                window.NepTunes.toggleLove();
            }
        });
        volumeBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            volumePopover.classList.toggle('open');
        });
        // Brings the running player forward; with none running, launches the preferred player if one is set, otherwise the last-used one.
        emptyOpen.addEventListener('click', function (e) {
            e.stopPropagation();
            if (typeof window.NepTunes.activatePlayer === 'function') window.NepTunes.activatePlayer();
        });

        volumeSlider.addEventListener('pointerdown', function () {
            sliderActive = true;
            // The slider is now the source of truth for volume; drop any target a
            // just-finished scroll gesture is still holding, or the next wheel event
            // would resume from where the scroll left off rather than from the thumb.
            releaseWheelTarget();
        });
        document.addEventListener('pointerup', function () { sliderActive = false; });
        volumeSlider.addEventListener('input', function (e) {
            throttleVolume(clampVolume(parseInt(e.target.value, 10)));
        });
        volumeSlider.addEventListener('change', function (e) {
            sliderActive = false;
            releaseWheelTarget();
            commitVolume(clampVolume(parseInt(e.target.value, 10)));
        });

        // Click anywhere else dismisses the popover, the way V1's NSPopover did. Capture
        // phase, because every control above stops propagation — in the bubble phase a
        // click on shuffle or next would never reach this and would leave the panel open.
        document.addEventListener('click', function (e) {
            if (!volumePopover.classList.contains('open')) return;
            if (volumePopover.contains(e.target) || volumeBtn.contains(e.target)) return;
            volumePopover.classList.remove('open');
        }, true);
    }

    // ------------------------------------------------------------------ boot --

    function init() {
        if (!window.NepTunes) {
            console.error('NepTunes API not available');
            return;
        }

        // Looked up here rather than at module scope so this file can be required in
        // Node, where there is no document.
        widget = document.getElementById('widget');
        cover = document.getElementById('cover');
        nocover = document.getElementById('nocover');
        infoFrost = document.getElementById('infoFrost');
        hoverFrost = document.getElementById('hoverFrost');
        popoverFrost = document.getElementById('popoverFrost');
        infoBar = document.getElementById('infoBar');
        titleEl = document.getElementById('title');
        artistEl = document.getElementById('artist');
        liveBadge = document.getElementById('liveBadge');
        shuffleBtn = document.getElementById('shuffleBtn');
        repeatBtn = document.getElementById('repeatBtn');
        repeatIcon = document.getElementById('repeatIcon');
        loveBtn = document.getElementById('loveBtn');
        loveIcon = document.getElementById('loveIcon');
        volumeBtn = document.getElementById('volumeBtn');
        volumeIcon = document.getElementById('volumeIcon');
        prevBtn = document.getElementById('prevBtn');
        playBtn = document.getElementById('playBtn');
        nextBtn = document.getElementById('nextBtn');
        volumePopover = document.getElementById('volumePopover');
        volumeSlider = document.getElementById('volumeSlider');
        resizeHandle = document.getElementById('resizeHandle');
        emptyOpen = document.getElementById('emptyOpen');

        var motionLayer = document.getElementById('motionLayer');
        if (motionLayer) {
            motion = createMotionLayer({
                container: motionLayer,
                createVideo: function () { return document.createElement('video'); },
                later: function (fn, ms) { setTimeout(fn, ms); }
            });
        }
        reducedMotionQuery = window.matchMedia
            ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
        if (reducedMotionQuery) {
            if (reducedMotionQuery.addEventListener) reducedMotionQuery.addEventListener('change', updateMotion);
            else if (reducedMotionQuery.addListener) reducedMotionQuery.addListener(updateMotion);
        }

        setupControls();
        setupResize();
        widget.addEventListener('wheel', onWheel, { passive: false });
        // The popover floats outside the card (a child of body, not of #widget), so a wheel over it
        // no longer bubbles to the card. It gets the same handler, which keeps scroll-to-volume
        // and the rubber-band guard working over it exactly as before. Being a sibling of the
        // card, it never fires twice.
        volumePopover.addEventListener('wheel', onWheel, { passive: false });
        widget.addEventListener('dblclick', onDoubleClick);

        applySettings(window.NepTunes.settings);
        updateUI(window.NepTunes.state);

        if (window.SFSymbols) SFSymbols.load();
        window.NepTunes.on('statechange', updateUI);
        window.NepTunes.on('settingschange', applySettings);
        // Symbols are PNGs the native side rasterises with the tint baked in, so they do
        // not follow a system light/dark flip on their own. V3 is dark-only and nothing
        // else here reacts, but the glyphs still have to be re-fetched.
        window.NepTunes.on('themechange', function () {
            if (window.SFSymbols) SFSymbols.reload();
        });

        if (typeof window.NepTunes._signalReady === 'function') window.NepTunes._signalReady();
    }

    function start() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    return {
        volumeStep: volumeStep,
        clampVolume: clampVolume,
        speakerSymbol: speakerSymbol,
        repeatSymbol: repeatSymbol,
        repeatIsOn: repeatIsOn,
        wheelAxis: wheelAxis,
        swipeDecision: swipeDecision,
        infoBarState: infoBarState,
        transportHidden: transportHidden,
        transportGlyph: transportGlyph,
        liveBadgeHidden: liveBadgeHidden,
        isEmpty: isEmpty,
        motionState: motionState,
        createMotionLayer: createMotionLayer,
        createSymbolSwapper: createSymbolSwapper,
        start: start
    };
});
