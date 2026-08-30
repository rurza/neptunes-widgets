/*
 * UMD, matching Minimal.nepget/script.js: exports to Node so _dev/vinyl.test.mjs can
 * unit-test the RPM table, and self-starts in the WebView. DOM lookups live in init(),
 * not at module scope — there is no `document` in Node.
 */
(function (factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else api.start();
})(function () {
    'use strict';

    let vinyl = null;
    let artwork = null;
    let leftSide = null;
    let rightSide = null;
    let bottomSide = null;
    let trackInfoTemplate = null;
    let controlsTemplate = null;

    let trackInfo = null;
    let titleEl = null;
    let artistEl = null;
    let controls = null;
    let playBtn = null;
    let prevBtn = null;
    let nextBtn = null;
    let liveBadge = null; // lives inside .controls now — only exists while it does,
                          // which is the whole point: LIVE is transport state, gated
                          // on controlsPosition exactly like play/prev/next are.

    let currentArtworkURL = null;
    let artworkTransitionTimeout = null;
    let currentRotation = 0;
    let isSpinning = false;
    let isPlaying = false;
    let lastTimestamp = null;
    let animationId = null;

    // Milliseconds per revolution, keyed by the `spinRpm` option values in manifest.json.
    // Each is 60000/rpm rounded: 33 is 33⅓, so it is 1800 exactly — do not derive these
    // by parsing the key, or "33" would come out 1818 and the record would lie about its
    // own speed. _dev/vinyl.test.mjs pins the pairing to the picker's labels.
    const RPM_PERIOD_MS = { '16': 3750, '33': 1800, '45': 1333, '78': 769 };
    const DEFAULT_PERIOD_MS = 1800; // 33⅓ RPM — an LP, and what the picker defaults to

    let spinDuration = DEFAULT_PERIOD_MS;

    let currentLabelPosition = 'off';
    let currentControlsPosition = 'off';
    let currentTextColor = 'white';
    let currentTextShadow = true;
    let currentControlsBackground = true;

    const VINYL_SIZE = 136;
    const PADDING = 48; // for shadow
    const GAP = 12;
    const CONTROLS_WIDTH = 84; // 24+2+32+2+24
    const TRACK_INFO_WIDTH = 160;
    const BOTTOM_HEIGHT = 40;

    function calculateAndSetSize(labelPos, controlsPos) {
        let width = VINYL_SIZE + PADDING * 2;
        let height = VINYL_SIZE + PADDING * 2;

        const hasLeft = labelPos === 'left' || controlsPos === 'left';
        const hasRight = labelPos === 'right' || controlsPos === 'right';
        const hasBottom = labelPos === 'bottom' || controlsPos === 'bottom';

        if (hasLeft) {
            width += Math.max(
                labelPos === 'left' ? TRACK_INFO_WIDTH : 0,
                controlsPos === 'left' ? CONTROLS_WIDTH : 0
            ) + GAP;
        }
        if (hasRight) {
            width += Math.max(
                labelPos === 'right' ? TRACK_INFO_WIDTH : 0,
                controlsPos === 'right' ? CONTROLS_WIDTH : 0
            ) + GAP;
        }
        if (hasBottom) {
            height += BOTTOM_HEIGHT + GAP;
        }

        window.NepTunes.setSize(width, height);
    }

    function getContainer(position) {
        switch (position) {
            case 'left': return leftSide;
            case 'right': return rightSide;
            case 'bottom': return bottomSide;
            default: return null;
        }
    }

    function placeElement(element, position, elementType) {
        if (!element) return;

        element.remove();

        if (position === 'off') return;

        const container = getContainer(position);
        if (!container) return;

        if (elementType === 'trackInfo') {
            container.insertBefore(element, container.firstChild);
        } else {
            container.appendChild(element);
        }
    }

    function createTrackInfo() {
        if (trackInfo) {
            trackInfo.remove();
        }

        const clone = trackInfoTemplate.content.cloneNode(true);
        trackInfo = clone.querySelector('.track-info');
        titleEl = clone.querySelector('.title');
        artistEl = clone.querySelector('.artist');

        applyTextStyles();

        return trackInfo;
    }

    // Resolve the text-color setting to a concrete color. 'system' follows the desktop
    // appearance — white text over a dark desktop, black over a light one — and is
    // re-resolved on every apply, so an automatic light/dark switch lands here too.
    function textIsWhite() {
        if (currentTextColor !== 'system') return currentTextColor === 'white';
        return !(window.matchMedia &&
                 window.matchMedia('(prefers-color-scheme: light)').matches);
    }

    function applyTextStyles() {
        var white = textIsWhite();

        // Apply to track info
        if (trackInfo) {
            trackInfo.classList.remove('text-white', 'text-black', 'shadow');

            if (white) {
                trackInfo.classList.add('text-white');
            } else {
                trackInfo.classList.add('text-black');
            }

            if (currentTextShadow) {
                trackInfo.classList.add('shadow');
            }
        }

        // Apply to controls
        if (controls) {
            controls.classList.remove('color-white', 'color-black', 'no-background');

            if (white) {
                controls.classList.add('color-white');
            } else {
                controls.classList.add('color-black');
            }

            if (!currentControlsBackground) {
                controls.classList.add('no-background');
            }
        }
    }

    function createControls() {
        if (controls) {
            controls.remove();
        }

        const clone = controlsTemplate.content.cloneNode(true);
        controls = clone.querySelector('.controls');
        playBtn = clone.querySelector('#playBtn');
        prevBtn = clone.querySelector('#prevBtn');
        nextBtn = clone.querySelector('#nextBtn');
        liveBadge = clone.querySelector('#liveBadge');

        // Click handlers for actions
        playBtn.addEventListener('click', () => window.NepTunes.playPause());
        prevBtn.addEventListener('click', () => window.NepTunes.previous());
        nextBtn.addEventListener('click', () => window.NepTunes.next());

        // Pressed state handlers (CSS :active unreliable in WebKit)
        [playBtn, prevBtn, nextBtn].forEach(btn => {
            btn.addEventListener('mousedown', () => btn.classList.add('pressed'));
            btn.addEventListener('mouseup', () => btn.classList.remove('pressed'));
            btn.addEventListener('mouseleave', () => btn.classList.remove('pressed'));
        });

        if (isPlaying) {
            playBtn.classList.add('playing');
        } else {
            playBtn.classList.remove('playing');
        }

        return controls;
    }

    /*
     * Whether prev/next should be HIDDEN right now — a live stream, not an ad.
     * `track.isLiveStream` is only ever sent when true (omitted for an ordinary track), so
     * a missing value must read as "not live" rather than throw or misreport. `track` may
     * be undefined (nothing playing), which must NOT hide the buttons — pressing next may
     * start playback. The bridge already refuses next()/previous() during a live stream
     * centrally (WidgetTransportGuard); hiding here just keeps the row from offering a
     * button that can only mislead. prevBtn/nextBtn may not exist at all when controls
     * aren't shown — callers must guard that themselves, this only answers the flag.
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

    /*
     * Whether the LIVE indicator should be visible. It is transport state, not track
     * info, so it depends on the controls existing at all (controlsPosition !== 'off')
     * in addition to the stream actually being live — matching what createControls()/
     * the controlsPosition==='off' branch of applySettings already enforce by tearing
     * `liveBadge` down to null. Pure and exported so _dev/vinyl.test.mjs can pin the
     * contract without a DOM.
     */
    function liveBadgeVisible(controlsPosition, isLive) {
        return controlsPosition !== 'off' && !!isLive;
    }

    // Pure: the period one revolution should take, for whatever the host pushed.
    // Anything unrecognised — absent key, empty string, a number from a hand-edited
    // settings.json — lands on 33⅓ rather than stopping the record.
    function spinDurationFor(settings) {
        if (!settings) return DEFAULT_PERIOD_MS;
        return RPM_PERIOD_MS[String(settings.spinRpm)] || DEFAULT_PERIOD_MS;
    }

    function applySettings(settings) {
        if (!settings) return;

        spinDuration = spinDurationFor(settings);

        const labelPosition = settings.labelPosition || 'off';
        const controlsPosition = settings.controlsPosition || 'off';
        const textColor = settings.textColor || 'white';
        const textShadow = settings.textShadow !== false;
        const controlsBackground = settings.controlsBackground !== false;

        currentTextColor = textColor;
        currentTextShadow = textShadow;
        currentControlsBackground = controlsBackground;

        // Process label position
        if (labelPosition !== 'off') {
            const needsCreate = !trackInfo;
            if (needsCreate) {
                createTrackInfo();
            }
            if (needsCreate || labelPosition !== currentLabelPosition) {
                placeElement(trackInfo, labelPosition, 'trackInfo');
            }
        } else if (trackInfo) {
            trackInfo.remove();
            trackInfo = null;
            titleEl = null;
            artistEl = null;
        }
        currentLabelPosition = labelPosition;

        // Process controls position
        if (controlsPosition !== 'off') {
            const needsCreate = !controls;
            if (needsCreate) {
                createControls();
            }
            if (needsCreate || controlsPosition !== currentControlsPosition) {
                placeElement(controls, controlsPosition, 'controls');
            }
        } else if (controls) {
            controls.remove();
            controls = null;
            playBtn = null;
            prevBtn = null;
            nextBtn = null;
            liveBadge = null;
        }
        currentControlsPosition = controlsPosition;

        // Apply styles after both track info and controls are created
        applyTextStyles();

        calculateAndSetSize(labelPosition, controlsPosition);

        // Update UI to populate track info with current state
        updateUI(window.NepTunes.state);

        // Reload icons last — color-affecting classes above must land first,
        // since sfsymbols.js reads the icon color synchronously from computed style.
        if (window.SFSymbols) SFSymbols.reload();
    }

    function spin(timestamp) {
        if (!isSpinning) return;

        if (lastTimestamp === null) {
            lastTimestamp = timestamp;
        }

        const delta = timestamp - lastTimestamp;
        lastTimestamp = timestamp;

        const rotationPerMs = 360 / spinDuration;
        currentRotation = (currentRotation + delta * rotationPerMs) % 360;

        vinyl.style.transform = `rotate(${currentRotation}deg)`;
        animationId = requestAnimationFrame(spin);
    }

    function startSpinning() {
        if (isSpinning) return;
        isSpinning = true;
        lastTimestamp = null;
        animationId = requestAnimationFrame(spin);
    }

    function stopSpinning() {
        isSpinning = false;
        if (animationId) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }
        lastTimestamp = null;
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

    function updateUI(state) {
        applyDirection(state);
        if (!state || !state.track) {
            stopSpinning();
            artwork.classList.remove('visible');
            if (titleEl) titleEl.textContent = '';
            if (artistEl) artistEl.textContent = '';
            if (liveBadge) liveBadge.hidden = true;
            isPlaying = false;
            if (playBtn) playBtn.classList.remove('playing', 'live');
            // Nothing playing must not block transport — pressing next may start playback.
            if (prevBtn) { prevBtn.disabled = false; prevBtn.hidden = false; }
            if (nextBtn) { nextBtn.disabled = false; nextBtn.hidden = false; }
            return;
        }

        var isAd = !!state.track.isAdvertisement;
        var isLive = !!state.track.isLiveStream;
        if (titleEl) titleEl.textContent = isAd ? 'Advertisement' : (state.track.title || '');
        if (artistEl) artistEl.textContent = isAd ? '' : (state.track.artist || '');
        if (liveBadge) liveBadge.hidden = !liveBadgeVisible(currentControlsPosition, isLive);

        // Greyed out during a Spotify ad — Spotify refuses to skip one.
        // `isAdvertisement` is only ever sent when true, so a missing value here
        // correctly reads as "not an ad". The native bridge already refuses next()/
        // previous() regardless; this just keeps the button from inviting a tap that
        // silently does nothing. prevBtn/nextBtn may be null when controls aren't shown.
        const adPlaying = !!state.track.isAdvertisement;
        if (prevBtn) prevBtn.disabled = adPlaying;
        if (nextBtn) nextBtn.disabled = adPlaying;

        // Hidden, not greyed, during a live stream — see transportHidden.
        const hidden = transportHidden(state.track);
        if (prevBtn) prevBtn.hidden = hidden;
        if (nextBtn) nextBtn.hidden = hidden;

        isPlaying = state.playerState === 2;
        if (playBtn) {
            if (isPlaying) {
                playBtn.classList.add('playing');
            } else {
                playBtn.classList.remove('playing');
            }
            playBtn.classList.toggle('live', isLive);
            var glyph = transportGlyph(state.playerState, isLive);
            playBtn.setAttribute('aria-label',
                glyph === 'stop' ? 'Stop' : (glyph === 'pause' ? 'Pause' : 'Play'));
        }

        if (isPlaying) {
            startSpinning();
        } else {
            stopSpinning();
        }

        const artworkURL = window.NepTunes.getArtworkDataURL();
        if (artworkURL !== currentArtworkURL) {
            if (artworkTransitionTimeout) {
                clearTimeout(artworkTransitionTimeout);
                artworkTransitionTimeout = null;
            }
            if (artworkURL) {
                if (currentArtworkURL) {
                    artwork.classList.remove('visible');
                    artworkTransitionTimeout = setTimeout(() => {
                        artwork.src = artworkURL;
                        artwork.classList.add('visible');
                        artworkTransitionTimeout = null;
                    }, 300);
                } else {
                    artwork.src = artworkURL;
                    artwork.classList.add('visible');
                }
            } else {
                artwork.classList.remove('visible');
            }
            currentArtworkURL = artworkURL;
        }
    }

    function init() {
        console.log('Vinyl: init called');

        vinyl = document.getElementById('vinyl');
        artwork = document.getElementById('artwork');
        // liveBadge is looked up in createControls() — it lives inside the controls
        // template now, so it only exists while controlsPosition !== 'off'.
        leftSide = document.getElementById('leftSide');
        rightSide = document.getElementById('rightSide');
        bottomSide = document.getElementById('bottomSide');
        trackInfoTemplate = document.getElementById('trackInfoTemplate');
        controlsTemplate = document.getElementById('controlsTemplate');

        if (!window.NepTunes) {
            console.error('NepTunes API not available');
            return;
        }

        // Register listeners - these will catch updates from native
        window.NepTunes.on('statechange', updateUI);
        window.NepTunes.on('settingschange', applySettings);
        // The desktop switched between light and dark. Only 'system' resolves against it;
        // an explicit white/black choice is the user's and must survive the flip untouched.
        window.NepTunes.on('themechange', function () {
            if (currentTextColor === 'system') applyTextStyles();
        });

        // Apply current values (may already be available from didFinish push)
        applySettings(window.NepTunes.settings);
        updateUI(window.NepTunes.state);

        // Signal to native that we're ready (triggers another push, harmless if duplicate)
        if (window.SFSymbols) SFSymbols.load();
        if (window.NepTunes._signalReady) {
            window.NepTunes._signalReady();
        }
    }

    function start() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    return {
        spinDurationFor: spinDurationFor,
        transportHidden: transportHidden,
        transportGlyph: transportGlyph,
        liveBadgeVisible: liveBadgeVisible,
        start: start
    };
});
