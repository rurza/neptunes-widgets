/*
 * UMD, matching _dev/neptunes-kit.js: exports to Node so _dev/minimal.test.mjs
 * can unit-test the geometry, and self-starts in the WebView. The factory keeps
 * everything off `window` — nothing here is a global.
 */
(function (factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else api.start();
})(function () {
    'use strict';

    let widget, title, artist, album, liveBadge, controls, playBtn, prevBtn, nextBtn;

    const WIDTH = 280;
    const HEIGHT_LABELS = 100;  // title + artist + album, no controls
    const ALBUM_LINE = 19;      // 16px line + 3px .labels gap. Each label line is
                                // 16px: WebKit floors the 16.8px computed
                                // line-height. Measured, not derived.
    const CONTROLS_ROW = 34;    // .widget gap + controls row, as originally tuned.
                                // The CSS actually costs 35 (15px gap + 20px row);
                                // the 1px predates this and is left alone, since
                                // correcting it would move every existing
                                // controls-on widget.

    let showAlbum = true;       // Declared, not implicit: 'use strict' makes a bare
    let showControls = false;   // assignment a ReferenceError. Initial values match
    let lastHeight = null;      // the manifest defaults.
    let isLive = false;         // last-seen live-stream flag — see updateUI. Read by
                                 // applySettings so toggling showControls alone (no
                                 // accompanying state push) still gets liveBadge right.

    /*
     * The only place the widget's height is decided. Pure — takes its inputs as
     * arguments rather than reading the module's state — so _dev/minimal.test.mjs
     * can pin all four combinations.
     */
    function targetHeight(showAlbum, showControls) {
        return HEIGHT_LABELS
            - (showAlbum ? 0 : ALBUM_LINE)
            + (showControls ? CONTROLS_ROW : 0);
    }

    /*
     * Whether prev/next should be greyed out right now. `track.isAdvertisement` is only
     * ever sent when true (omitted entirely for a real track), so this must read a missing
     * value as "not an ad" rather than throw or misreport. `track` itself may be undefined
     * (nothing playing), which must NOT disable the buttons — pressing next may start
     * playback. NepTunes' own bridge already refuses next()/previous() during an ad
     * regardless of this; disabling here is purely so the button doesn't invite a tap that
     * silently does nothing.
     */
    function transportDisabled(track) {
        return !!(track && track.isAdvertisement);
    }

    /*
     * Whether prev/next should be HIDDEN right now — a live stream, not an ad. Same
     * missing-reads-as-false contract as transportDisabled: `track.isLiveStream` is only
     * ever sent when true, and `track` itself may be undefined. Hidden rather than greyed:
     * the bridge already refuses next()/previous() during a live stream centrally (see
     * WidgetTransportGuard), and there is no "later" state a live stream returns to skip
     * back into, so an inert-looking button here would only invite a tap that means nothing.
     */
    function transportHidden(track) {
        return !!(track && track.isLiveStream);
    }

    /*
     * Which of the three play-button glyphs applies. `playerState` 2 is playing; the host
     * never sends duration/position for a live stream, so "paused" reads the same as any
     * other paused track — only the PLAYING glyph differs, because resuming a live stream
     * restarts it rather than resuming where it left off.
     */
    function transportGlyph(playerState, isLiveStream) {
        if (playerState !== 2) return 'play';
        return isLiveStream ? 'stop' : 'pause';
    }

    /*
     * Whether the LIVE indicator should be hidden. It is transport state, not track info —
     * it appears only where and when the controls themselves do, so it is gated on
     * `showControls` exactly like the controls row, in addition to `isLive` itself. Pure,
     * so _dev/minimal.test.mjs can pin "controls off => never shown" without a DOM.
     */
    function liveBadgeHidden(showControls, isLive) {
        return !(showControls && isLive);
    }

    function applySettings(settings) {
        settings = settings || {};

        // Alignment
        widget.classList.remove('align-center', 'align-right');
        if (settings.alignment === 'center') {
            widget.classList.add('align-center');
        } else if (settings.alignment === 'right') {
            widget.classList.add('align-right');
        }

        // Text color: white (default) | black | system
        document.body.classList.remove('light', 'system');
        if (settings.textColor === 'black') {
            document.body.classList.add('light');
        } else if (settings.textColor === 'system') {
            document.body.classList.add('system');
        }

        // Shadow opacity (only affects white text — see styles.css)
        const shadowOpacity = (settings.shadowOpacity ?? 10) / 100;
        document.documentElement.style.setProperty('--shadow-opacity', shadowOpacity);

        // Optional album line. `!== false` so a host that hasn't merged the
        // schema default yet still shows it — the manifest default is on.
        // No CSS needed: .album sets no `display`, so the UA [hidden] rule wins.
        showAlbum = settings.showAlbum !== false;
        album.hidden = !showAlbum;

        // Optional playback controls
        showControls = settings.showControls === true;
        controls.hidden = !showControls;

        // LIVE is transport state — it appears only where and when the transport
        // itself does. .controls[hidden] already hides it as a DOM descendant, but a
        // widget host could in principle toggle visibility without display:none
        // ever applying, so gate it explicitly too rather than rely on inheritance.
        liveBadge.hidden = liveBadgeHidden(showControls, isLive);

        // Must follow both assignments above — resize() reads them.
        resize();

        // Reload icons last — the color-affecting classes above must land first,
        // since sfsymbols.js reads the icon color synchronously from computed style.
        if (window.SFSymbols) SFSymbols.reload();
    }

    function resize() {
        const height = targetHeight(showAlbum, showControls);
        // Only resize when the height actually changes — otherwise a settings change
        // (e.g. dragging the shadow slider) would re-issue an identical window resize.
        if (height === lastHeight) return;
        lastHeight = height;
        // The preview/mock harness may not provide setSize — guard it.
        if (typeof window.NepTunes.setSize === 'function') {
            window.NepTunes.setSize(WIDTH, height);
        }
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
            widget.classList.add('stopped');
            title.textContent = 'Not Playing';
            artist.textContent = '';
            album.textContent = '';
            isLive = false;
            liveBadge.hidden = true;
            playBtn.classList.remove('playing', 'live');
            playBtn.setAttribute('aria-label', 'Play');
            prevBtn.hidden = false;
            nextBtn.hidden = false;
            prevBtn.disabled = false;
            nextBtn.disabled = false;
            return;
        }

        widget.classList.remove('stopped');
        var isAd = !!state.track.isAdvertisement;
        isLive = !!state.track.isLiveStream;
        title.textContent = isAd ? 'Advertisement' : (state.track.title || 'Unknown Title');
        artist.textContent = isAd ? '' : (state.track.artist || '');
        // Only the text — visibility belongs to applySettings.
        album.textContent = isAd ? '' : (state.track.album || '');
        // LIVE is transport state, shown only alongside the transport — see the
        // matching gate in applySettings.
        liveBadge.hidden = liveBadgeHidden(showControls, isLive);

        // playerState: 1 = stopped, 2 = playing, 3 = paused
        const isPlaying = state.playerState === 2;
        const glyph = transportGlyph(state.playerState, isLive);
        playBtn.classList.toggle('playing', isPlaying);
        playBtn.classList.toggle('live', isLive);
        playBtn.setAttribute('aria-label', glyph === 'stop' ? 'Stop' : (glyph === 'pause' ? 'Pause' : 'Play'));

        // Greyed out during a Spotify ad — Spotify refuses to skip one. The native bridge
        // already refuses the action either way; this just keeps the button from inviting
        // a tap that silently does nothing.
        const disabled = transportDisabled(state.track);
        prevBtn.disabled = disabled;
        nextBtn.disabled = disabled;

        // Hidden, not greyed, during a live stream — see transportHidden.
        const hidden = transportHidden(state.track);
        prevBtn.hidden = hidden;
        nextBtn.hidden = hidden;
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
    }

    function init() {
        if (!window.NepTunes) {
            console.error('NepTunes API not available');
            return;
        }

        // Looked up here rather than at module scope so this file can be
        // required in Node, where there is no document.
        widget = document.getElementById('widget');
        title = document.getElementById('title');
        artist = document.getElementById('artist');
        album = document.getElementById('album');
        liveBadge = document.getElementById('liveBadge');
        controls = document.getElementById('controls');
        playBtn = document.getElementById('playBtn');
        prevBtn = document.getElementById('prevBtn');
        nextBtn = document.getElementById('nextBtn');

        setupControls();
        applySettings(window.NepTunes.settings);
        updateUI(window.NepTunes.state);

        if (window.SFSymbols) SFSymbols.load();
        window.NepTunes.on('statechange', updateUI);
        window.NepTunes.on('settingschange', applySettings);
    }

    function start() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    return {
        targetHeight: targetHeight,
        transportDisabled: transportDisabled,
        transportHidden: transportHidden,
        transportGlyph: transportGlyph,
        liveBadgeHidden: liveBadgeHidden,
        start: start
    };
});
