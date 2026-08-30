(function() {
    'use strict';

    /* ===== live radio, decided above anything that touches the DOM =====

       Exported and then returned from, the way CDCase.nepget/script.js does it, so these
       can be pinned without a browser. An Apple Music station is a `URL track` with no
       duration. Measured against a live Music.app: `next track`, `previous track`,
       `set shuffle enabled` and `set song repeat` are all accepted and all silently
       ignored, and `player position` never leaves 0. Only play/stop and volume do
       anything. */

    // Everything a station ignores is HIDDEN, not greyed. An ad is greyed because the
    // queue behind it is still there to shuffle and reach; a station has no queue at all.
    // `isLiveStream` is only ever sent when true, so a missing value reads as false.
    function transportHidden(track) {
        return !!(track && track.isLiveStream);
    }

    // Which glyph the play button wears. Playing a station shows a stop square rather than
    // a pause bar: resuming rejoins the stream live instead of picking up where it left
    // off. The verb sent is still playPause() — see PlaybackAffordances.
    function transportGlyph(playerState, isLiveStream) {
        if (playerState !== 2) return 'play';
        return isLiveStream ? 'stop' : 'pause';
    }

    // Whether there is a position and duration worth drawing at all.
    function hasTimeline(track) {
        return !(track && track.isLiveStream);
    }

    const PURE = {
        transportHidden: transportHidden,
        transportGlyph: transportGlyph,
        hasTimeline: hasTimeline
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = PURE;
    if (typeof window === 'undefined') return;

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
    const liveBadge = document.getElementById('liveBadge');

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
            widget.classList.remove('live');
            title.textContent = 'Not Playing';
            artist.textContent = '';
            playBtn.classList.remove('playing', 'live');
            playBtn.title = 'Play/Pause';
            liveBadge.hidden = true;
            prevBtn.hidden = false;
            nextBtn.hidden = false;
            shuffleBtn.hidden = false;
            repeatBtn.hidden = false;
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

        // Hidden, not greyed, during a live stream — see transportHidden. Shuffle and
        // repeat go with them: Music.app accepts both on a station and acts on neither.
        const live = transportHidden(state.track);
        widget.classList.toggle('live', live);
        liveBadge.hidden = !live;
        prevBtn.hidden = live;
        nextBtn.hidden = live;
        shuffleBtn.hidden = live;
        repeatBtn.hidden = live;

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
        playBtn.classList.toggle('live', live);
        const verb = transportGlyph(state.playerState, live);
        playBtn.title = verb === 'stop' ? 'Stop' : 'Play/Pause';

        // Progress. A station has none — the row is emptied here and hidden in CSS off
        // `.widget.live`, so the panel keeps the layout an ordinary track gives it.
        if (!hasTimeline(state.track)) {
            progressFill.style.width = '0%';
            currentTime.textContent = '0:00';
            duration.textContent = '0:00';
        } else if (state.track.duration && state.playerPosition !== undefined) {
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
