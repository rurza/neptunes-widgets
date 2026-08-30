/**
 * Kitchen Sink Widget - Complete API Demo
 * Demonstrates ALL NepTunes Widget API capabilities
 */
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

    // Progress tracking
    let progressInterval = null;
    let lastKnownPosition = 0;
    let lastUpdateTime = 0;
    let trackDuration = 0;
    let isPlaying = false;

    // Volume slider debouncing
    let volumeDebounceTimer = null;
    let isAdjustingVolume = false;

    // Artwork tracking
    let currentArtworkURL = null;
    let artworkTransitionTimeout = null;

    // DOM Elements
    const widget = document.getElementById('widget');
    const playerBadge = document.getElementById('playerBadge');
    const playerName = document.getElementById('playerName');
    const switchPlayerBtn = document.getElementById('switchPlayerBtn');
    const activatePlayerBtn = document.getElementById('activatePlayerBtn');
    const artwork = document.getElementById('artwork');
    const title = document.getElementById('title');
    const artist = document.getElementById('artist');
    const album = document.getElementById('album');
    const currentTime = document.getElementById('currentTime');
    const duration = document.getElementById('duration');
    const progressFill = document.getElementById('progressFill');
    const liveBadge = document.getElementById('liveBadge');
    const playBtn = document.getElementById('playBtn');
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    const shuffleBtn = document.getElementById('shuffleBtn');
    const repeatBtn = document.getElementById('repeatBtn');
    const volDownBtn = document.getElementById('volDownBtn');
    const volUpBtn = document.getElementById('volUpBtn');
    const muteBtn = document.getElementById('muteBtn');
    const volumeSlider = document.getElementById('volumeSlider');
    const volumeValue = document.getElementById('volumeValue');
    const loveBtn = document.getElementById('loveBtn');
    const dislikeBtn = document.getElementById('dislikeBtn');
    const ratingDownBtn = document.getElementById('ratingDownBtn');
    const ratingUpBtn = document.getElementById('ratingUpBtn');
    const ratingClearBtn = document.getElementById('ratingClearBtn');
    const stars = document.getElementById('stars');
    const starRating = document.getElementById('starRating');
    const debugPanel = document.getElementById('debugPanel');
    const debugOutput = document.getElementById('debugOutput');

    // Format time
    function formatTime(seconds) {
        if (!seconds || seconds < 0) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    // Progress tracking functions
    function startProgressTracking() {
        stopProgressTracking();
        progressInterval = setInterval(updateProgress, 500);
    }

    function stopProgressTracking() {
        if (progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
        }
    }

    function updateProgress() {
        if (!isPlaying || trackDuration <= 0) return;

        const now = Date.now();
        const elapsed = (now - lastUpdateTime) / 1000;
        const currentPosition = Math.min(lastKnownPosition + elapsed, trackDuration);

        const progress = (currentPosition / trackDuration) * 100;
        progressFill.style.width = `${Math.min(100, progress)}%`;
        currentTime.textContent = formatTime(currentPosition);
    }

    // Update star display
    function updateStars(rating) {
        if (rating === null || rating === undefined) {
            stars.textContent = '☆☆☆☆☆';
            return;
        }
        // Rating is 0-100, convert to 0-5 stars
        const starCount = Math.round(rating / 20);
        stars.textContent = '★'.repeat(starCount) + '☆'.repeat(5 - starCount);
    }

    // Apply settings
    function applySettings(settings) {
        if (!settings) return;

        if (settings.showDebug) {
            debugPanel.classList.add('visible');
        } else {
            debugPanel.classList.remove('visible');
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

    // Update UI with state
    // Put the transport back the way an ordinary track leaves it. Two branches of
    // updateUI reach the empty state, and both have to undo everything a station hid.
    function clearLive() {
        widget.classList.remove('live');
        playBtn.classList.remove('live');
        playBtn.title = 'Play/Pause';
        liveBadge.hidden = true;
        prevBtn.hidden = false;
        nextBtn.hidden = false;
        shuffleBtn.hidden = false;
        repeatBtn.hidden = false;
    }

    function updateUI(state) {
        applyDirection(state);
        // Debug output
        if (debugPanel.classList.contains('visible')) {
            debugOutput.textContent = JSON.stringify(state, null, 2);
        }

        if (!state) {
            widget.classList.add('stopped');
            clearLive();
            title.textContent = 'Not Playing';
            artist.textContent = '';
            album.textContent = '';
            playerName.textContent = 'No Player';
            // Nothing playing must not block transport — pressing next may start playback.
            prevBtn.disabled = false;
            nextBtn.disabled = false;
            return;
        }

        // Player info
        if (state.playerType) {
            playerName.textContent = state.playerType === 'appleMusic' ? 'Apple Music' : 'Spotify';
        }

        // Track info
        if (!state.track) {
            widget.classList.add('stopped');
            clearLive();
            title.textContent = 'Not Playing';
            artist.textContent = '';
            album.textContent = '';
            playBtn.classList.remove('playing');
            artwork.classList.remove('visible');
            prevBtn.disabled = false;
            nextBtn.disabled = false;
            return;
        }

        widget.classList.remove('stopped');
        var isAd = !!state.track.isAdvertisement;
        title.textContent = isAd ? 'Advertisement' : (state.track.title || 'Unknown Title');
        artist.textContent = isAd ? '' : (state.track.artist || '');
        album.textContent = isAd ? '' : (state.track.album || '');

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
                    artworkTransitionTimeout = setTimeout(() => {
                        artwork.src = artworkURL;
                        artwork.classList.add('visible');
                        artworkTransitionTimeout = null;
                    }, 300);
                } else {
                    // No previous artwork, just set and fade in
                    artwork.src = artworkURL;
                    artwork.classList.add('visible');
                }
            } else {
                artwork.classList.remove('visible');
            }
            currentArtworkURL = artworkURL;
        }

        // Play state: 1=stopped, 2=playing, 3=paused
        isPlaying = state.playerState === 2;
        if (isPlaying) {
            playBtn.classList.add('playing');
        } else {
            playBtn.classList.remove('playing');
        }
        playBtn.classList.toggle('live', live);
        playBtn.title = transportGlyph(state.playerState, live) === 'stop' ? 'Stop' : 'Play/Pause';

        // Progress - store values for local tracking
        trackDuration = state.track.duration || 0;
        lastKnownPosition = state.playerPosition || 0;
        lastUpdateTime = Date.now();

        if (!hasTimeline(state.track)) {
            // A station has no clock to run. The row is hidden in CSS off `.widget.live`;
            // zeroing it here keeps it from flashing a stale bar on the way back to an
            // ordinary track.
            progressFill.style.width = '0%';
            currentTime.textContent = '0:00';
            duration.textContent = '0:00';
        } else if (trackDuration > 0) {
            const progress = (lastKnownPosition / trackDuration) * 100;
            progressFill.style.width = `${Math.min(100, progress)}%`;
            currentTime.textContent = formatTime(lastKnownPosition);
            duration.textContent = formatTime(trackDuration);
        } else {
            progressFill.style.width = '0%';
            currentTime.textContent = '0:00';
            duration.textContent = '0:00';
        }

        // Start/stop progress tracking based on play state
        if (isPlaying && trackDuration > 0) {
            startProgressTracking();
        } else {
            stopProgressTracking();
        }

        // Volume - don't update slider while user is adjusting it
        if (state.volume !== undefined && !isAdjustingVolume) {
            volumeSlider.value = state.volume;
            volumeValue.textContent = `${state.volume}%`;
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

        // Repeat: 0=off, 1=all, 2=one
        repeatBtn.classList.remove('active', 'repeat-one');
        if (state.repeatMode === 1) {
            repeatBtn.classList.add('active');
        } else if (state.repeatMode === 2) {
            repeatBtn.classList.add('active', 'repeat-one');
        }

        // Capabilities - hide controls when not available
        const caps = state.capabilities || {};

        // Love button - hide if not supported
        if (caps.canLove) {
            loveBtn.style.display = '';
            if (state.isLoved || state.track.isLoved) {
                loveBtn.classList.add('active');
            } else {
                loveBtn.classList.remove('active');
            }
        } else {
            loveBtn.style.display = 'none';
        }

        // Dislike button - hide if not supported
        if (caps.canDislike) {
            dislikeBtn.style.display = '';
            if (state.isDisliked) {
                dislikeBtn.classList.add('active');
            } else {
                dislikeBtn.classList.remove('active');
            }
        } else {
            dislikeBtn.style.display = 'none';
        }

        // Rating - hide if not supported
        if (caps.canRate) {
            starRating.style.display = 'flex';
            updateStars(state.rating);
        } else {
            starRating.style.display = 'none';
        }
    }

    // Setup event listeners
    function setupControls() {
        // Playback
        playBtn.addEventListener('click', () => window.NepTunes.playPause());
        prevBtn.addEventListener('click', () => window.NepTunes.previous());
        nextBtn.addEventListener('click', () => window.NepTunes.next());

        // Shuffle/Repeat
        shuffleBtn.addEventListener('click', () => window.NepTunes.toggleShuffle());
        repeatBtn.addEventListener('click', () => window.NepTunes.toggleRepeat());

        // Volume
        volDownBtn.addEventListener('click', () => window.NepTunes.decreaseVolume());
        volUpBtn.addEventListener('click', () => window.NepTunes.increaseVolume());
        muteBtn.addEventListener('click', () => window.NepTunes.toggleMute());

        // Volume slider with debouncing
        volumeSlider.addEventListener('mousedown', () => {
            isAdjustingVolume = true;
        });
        volumeSlider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value, 10);
            volumeValue.textContent = `${value}%`;

            // Debounce the actual volume change
            clearTimeout(volumeDebounceTimer);
            volumeDebounceTimer = setTimeout(() => {
                window.NepTunes.setVolume(value);
            }, 50);
        });
        volumeSlider.addEventListener('mouseup', () => {
            setTimeout(() => { isAdjustingVolume = false; }, 200);
        });
        volumeSlider.addEventListener('mouseleave', () => {
            if (isAdjustingVolume) {
                setTimeout(() => { isAdjustingVolume = false; }, 200);
            }
        });

        // Love/Dislike - check capability before calling
        loveBtn.addEventListener('click', () => {
            if (window.NepTunes.capabilities?.canLove) {
                window.NepTunes.toggleLove();
            }
        });
        dislikeBtn.addEventListener('click', () => {
            if (window.NepTunes.capabilities?.canDislike) {
                window.NepTunes.toggleDislike();
            }
        });

        // Rating - check capability before calling
        ratingDownBtn.addEventListener('click', () => {
            if (window.NepTunes.capabilities?.canRate) {
                window.NepTunes.decreaseRating();
            }
        });
        ratingUpBtn.addEventListener('click', () => {
            if (window.NepTunes.capabilities?.canRate) {
                window.NepTunes.increaseRating();
            }
        });
        ratingClearBtn.addEventListener('click', () => {
            if (window.NepTunes.capabilities?.canRate) {
                window.NepTunes.removeRating();
            }
        });

        // Player activation
        switchPlayerBtn.addEventListener('click', () => window.NepTunes.switchPlayer());
        activatePlayerBtn.addEventListener('click', () => window.NepTunes.activatePlayer());
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
        if (window.SFSymbols) SFSymbols.reload();
        window.NepTunes.on('settingschange', applySettings);

        console.log('Kitchen Sink widget initialized');
        console.log('Available API:', Object.keys(window.NepTunes));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
