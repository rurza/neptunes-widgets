(function() {
    'use strict';

    // DOM Elements
    const widget = document.getElementById('widget');
    const bgArtwork = document.getElementById('bgArtwork');
    const artwork = document.getElementById('artwork');
    const noArtwork = document.getElementById('noArtwork');
    const title = document.getElementById('title');
    const artist = document.getElementById('artist');

    let currentArtworkURL = null;
    let artworkTransitionTimeout = null;

    const progressContainer = document.getElementById('progressContainer');
    const progressFill = document.getElementById('progressFill');
    const currentTime = document.getElementById('currentTime');
    const duration = document.getElementById('duration');
    const playBtn = document.getElementById('playBtn');
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    const shuffleBtn = document.getElementById('shuffleBtn');
    const repeatBtn = document.getElementById('repeatBtn');
    const volumeControl = document.getElementById('volumeControl');
    const muteBtn = document.getElementById('muteBtn');
    const volumeSlider = document.getElementById('volumeSlider');
    const loveBtn = document.getElementById('loveBtn');

    // Format time in m:ss
    function formatTime(seconds) {
        if (!seconds || seconds < 0) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    // Apply settings
    function applySettings(settings) {
        if (!settings) return;

        // Theme: dark (default) | light | auto. 'auto' follows the desktop appearance
        // through a prefers-color-scheme rule in styles.css, so a system light/dark
        // switch re-themes the panel on its own, with no JS involved.
        document.body.classList.remove('light', 'auto');
        if (settings.theme === 'light') {
            document.body.classList.add('light');
        } else if (settings.theme === 'auto') {
            document.body.classList.add('auto');
        }

        if (settings.showVolume === false) {
            volumeControl.classList.add('hidden');
        } else {
            volumeControl.classList.remove('hidden');
        }

        if (settings.showShuffleRepeat === false) {
            shuffleBtn.classList.add('shuffle-repeat-hidden');
            repeatBtn.classList.add('shuffle-repeat-hidden');
        } else {
            shuffleBtn.classList.remove('shuffle-repeat-hidden');
            repeatBtn.classList.remove('shuffle-repeat-hidden');
        }

        // Reload icons last — the theme class above must land first, since
        // sfsymbols.js reads the icon color synchronously from computed style.
        if (window.SFSymbols) SFSymbols.reload();
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

    // Update UI with player state
    function updateUI(state) {
        applyDirection(state);
        if (!state || !state.track) {
            widget.classList.add('stopped');
            title.textContent = 'Not Playing';
            artist.textContent = '';
            playBtn.classList.remove('playing');
            artwork.classList.remove('visible');
            bgArtwork.classList.remove('visible');
            currentArtworkURL = null;
            progressFill.style.width = '0%';
            currentTime.textContent = '0:00';
            duration.textContent = '0:00';
            loveBtn.classList.remove('loved');
            shuffleBtn.classList.remove('active');
            repeatBtn.classList.remove('active', 'repeat-one');
            // Nothing playing must not block transport — pressing next may start playback.
            prevBtn.disabled = false;
            nextBtn.disabled = false;
            return;
        }

        widget.classList.remove('stopped');

        // Track info
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

        // Artwork
        const artworkURL = window.NepTunes.getArtworkDataURL();
        if (artworkURL !== currentArtworkURL) {
            if (artworkTransitionTimeout) {
                clearTimeout(artworkTransitionTimeout);
                artworkTransitionTimeout = null;
            }
            if (artworkURL) {
                if (currentArtworkURL) {
                    // Fade out, then change and fade in
                    artwork.classList.remove('visible');
                    bgArtwork.classList.remove('visible');
                    artworkTransitionTimeout = setTimeout(() => {
                        artwork.src = artworkURL;
                        artwork.classList.add('visible');
                        bgArtwork.style.backgroundImage = `url(${artworkURL})`;
                        bgArtwork.classList.add('visible');
                        artworkTransitionTimeout = null;
                    }, 300);
                } else {
                    // No previous artwork, just set and fade in
                    artwork.src = artworkURL;
                    artwork.classList.add('visible');
                    bgArtwork.style.backgroundImage = `url(${artworkURL})`;
                    bgArtwork.classList.add('visible');
                }
            } else {
                artwork.classList.remove('visible');
                bgArtwork.classList.remove('visible');
            }
            currentArtworkURL = artworkURL;
        }

        // Play state
        if (state.playerState === 2) {
            playBtn.classList.add('playing');
        } else {
            playBtn.classList.remove('playing');
        }

        // Progress
        if (state.track.duration && state.playerPosition !== undefined) {
            const progress = (state.playerPosition / state.track.duration) * 100;
            progressFill.style.width = `${Math.min(100, progress)}%`;
            currentTime.textContent = formatTime(state.playerPosition);
            duration.textContent = formatTime(state.track.duration);
        } else {
            progressFill.style.width = '0%';
            currentTime.textContent = '0:00';
            duration.textContent = '0:00';
        }

        // Volume
        if (state.volume !== undefined) {
            volumeSlider.value = state.volume;
        }
        if (state.isMuted) {
            muteBtn.classList.add('muted');
        } else {
            muteBtn.classList.remove('muted');
        }

        // Shuffle
        if (state.shuffleEnabled) {
            shuffleBtn.classList.add('active');
        } else {
            shuffleBtn.classList.remove('active');
        }

        // Repeat
        repeatBtn.classList.remove('active', 'repeat-one');
        if (state.repeatMode === 1) { // all
            repeatBtn.classList.add('active');
        } else if (state.repeatMode === 2) { // one
            repeatBtn.classList.add('active', 'repeat-one');
        }

        // Love - check capability before showing
        const caps = state.capabilities || {};
        if (!caps.canLove) {
            loveBtn.classList.add('hidden');
        } else {
            loveBtn.classList.remove('hidden');
            if (state.isLoved || state.track.isLoved) {
                loveBtn.classList.add('loved');
            } else {
                loveBtn.classList.remove('loved');
            }
        }
    }

    // Setup event listeners
    function setupControls() {
        playBtn.addEventListener('click', () => {
            window.NepTunes.playPause();
        });

        prevBtn.addEventListener('click', () => {
            window.NepTunes.previous();
        });

        nextBtn.addEventListener('click', () => {
            window.NepTunes.next();
        });

        shuffleBtn.addEventListener('click', () => {
            window.NepTunes.toggleShuffle();
        });

        repeatBtn.addEventListener('click', () => {
            window.NepTunes.toggleRepeat();
        });

        muteBtn.addEventListener('click', () => {
            window.NepTunes.toggleMute();
        });

        volumeSlider.addEventListener('input', (e) => {
            window.NepTunes.setVolume(parseInt(e.target.value, 10));
        });

        loveBtn.addEventListener('click', () => {
            if (window.NepTunes.capabilities?.canLove) {
                window.NepTunes.toggleLove();
            }
        });
    }

    // Initialize
    function init() {
        if (!window.NepTunes) {
            console.error('NepTunes API not available');
            return;
        }

        setupControls();
        applySettings(window.NepTunes.settings);
        updateUI(window.NepTunes.state);

        if (window.SFSymbols) SFSymbols.load();
        window.NepTunes.on('statechange', updateUI);
        window.NepTunes.on('settingschange', applySettings);

        console.log('Full Player widget initialized');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
