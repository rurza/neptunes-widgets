(function() {
    'use strict';

    const widget = document.getElementById('widget');
    const artworkBg = document.getElementById('artworkBg');
    const noArtwork = document.getElementById('noArtwork');
    const title = document.getElementById('title');
    const artist = document.getElementById('artist');
    const prevBtn = document.getElementById('prevBtn');
    const playPauseBtn = document.getElementById('playPauseBtn');
    const nextBtn = document.getElementById('nextBtn');

    let currentArtworkURL = null;
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
            widget.classList.remove('playing');
            title.textContent = 'Not Playing';
            artist.textContent = '';
            artworkBg.classList.remove('visible');
            noArtwork.classList.remove('hidden');
            // Nothing playing must not block transport — pressing next may start playback.
            prevBtn.disabled = false;
            nextBtn.disabled = false;
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

        if (state.playerState === 2) {
            widget.classList.add('playing');
        } else {
            widget.classList.remove('playing');
        }

        const artworkURL = window.NepTunes.getArtworkDataURL();
        if (artworkURL !== currentArtworkURL) {
            if (artworkTransitionTimeout) {
                clearTimeout(artworkTransitionTimeout);
                artworkTransitionTimeout = null;
            }
            if (artworkURL) {
                if (currentArtworkURL) {
                    // Fade out, then change and fade in
                    artworkBg.classList.remove('visible');
                    artworkTransitionTimeout = setTimeout(() => {
                        artworkBg.style.backgroundImage = `url(${artworkURL})`;
                        artworkBg.classList.add('visible');
                        noArtwork.classList.add('hidden');
                        artworkTransitionTimeout = null;
                    }, 300);
                } else {
                    // No previous artwork, just set and fade in
                    artworkBg.style.backgroundImage = `url(${artworkURL})`;
                    artworkBg.classList.add('visible');
                    noArtwork.classList.add('hidden');
                }
            } else {
                artworkBg.classList.remove('visible');
                noArtwork.classList.remove('hidden');
            }
            currentArtworkURL = artworkURL;
        }
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

        updateUI(window.NepTunes.state);
        if (window.SFSymbols) SFSymbols.load();
        window.NepTunes.on('statechange', updateUI);

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
