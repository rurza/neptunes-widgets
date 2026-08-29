(function() {
    'use strict';

    const widget = document.getElementById('widget');
    const artworkContainer = document.getElementById('artworkContainer');
    const artwork = document.getElementById('artwork');
    const noArtwork = document.getElementById('noArtwork');
    const title = document.getElementById('title');
    const artist = document.getElementById('artist');
    const live = document.getElementById('live');
    const playBtn = document.getElementById('playBtn');
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');

    // Sent truthily only — omitted entirely for an ordinary track — so a missing value must
    // read as false, same as isAdvertisement. NepTunes' bridge refuses next()/previous() on a
    // live stream centrally, so prev/next are hidden here rather than merely greyed.
    function isLiveStream(track) {
        return !!(track && track.isLiveStream);
    }

    let currentArtworkURL = null;
    let artworkTransitionTimeout = null;
    let currentIconColor = null;
    let currentTheme = 'dark';

    function iconColor() {
        return getComputedStyle(document.body).getPropertyValue('--text-primary').trim() || '#ffffff';
    }

    async function loadIcons() {
        const color = iconColor();
        if (currentIconColor === color) return;
        currentIconColor = color;
        const icons = document.querySelectorAll('img.sf-icon[data-symbol]');
        await Promise.all([...icons].map(async (img) => {
            const name = img.dataset.symbol;
            const size = parseInt(img.dataset.size, 10) || 18;
            try {
                const url = await window.NepTunes.symbol(name, { size, color });
                if (url) img.src = url;
            } catch (e) {
                console.warn('Failed to load SF Symbol:', name, e);
            }
        }));
    }

    function applySettings(settings) {
        if (!settings) return;

        if (settings.showArtwork === false) {
            artworkContainer.classList.add('hidden');
        } else {
            artworkContainer.classList.remove('hidden');
        }

        if (settings.opacity !== undefined) {
            const opacity = settings.opacity;
            document.documentElement.style.setProperty('--bg-color',
                document.body.classList.contains('light')
                    ? `rgba(255, 255, 255, ${opacity})`
                    : `rgba(30, 30, 30, ${opacity})`
            );
        }

        // Theme: dark (default) | light | auto. 'auto' follows the desktop appearance
        // through a prefers-color-scheme rule in styles.css, so the panel re-themes
        // itself on a system switch; only the icons need JS (see onThemeChange).
        currentTheme = settings.theme || 'dark';
        document.body.classList.remove('light', 'auto');
        if (currentTheme === 'light') {
            document.body.classList.add('light');
        } else if (currentTheme === 'auto') {
            document.body.classList.add('auto');
        }

        loadIcons();
    }

    // The desktop switched between light and dark. Only 'auto' resolves against it — an
    // explicit dark/light choice already renders correctly. Unlike every other bundle this
    // one has no sfsymbols.js to re-tint centrally, so re-run its own loader: the icons are
    // PNGs rasterised natively with the tint baked in and cannot follow CSS. loadIcons()
    // no-ops when the resolved --text-primary is unchanged.
    function onThemeChange() {
        if (currentTheme !== 'auto') return;
        loadIcons();
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
        if (!state) {
            widget.classList.add('stopped');
            title.textContent = 'Not Playing';
            artist.textContent = '—';
            live.hidden = true;
            playBtn.classList.remove('playing', 'live');
            updateArtwork(null);
            prevBtn.disabled = false;
            nextBtn.disabled = false;
            prevBtn.hidden = false;
            nextBtn.hidden = false;
            return;
        }

        var isLive = false;
        if (state.track) {
            var isAd = !!state.track.isAdvertisement;
            isLive = isLiveStream(state.track);
            title.textContent = isAd ? 'Advertisement' : (state.track.title || 'Unknown Title');
            artist.textContent = isAd ? '' : (state.track.artist || 'Unknown Artist');
            live.hidden = !isLive;
            widget.classList.remove('stopped');

            // Greyed out during a Spotify ad — Spotify refuses to skip one.
            // `isAdvertisement` is only ever sent when true, so a missing value here
            // correctly reads as "not an ad". The native bridge already refuses next()/
            // previous() regardless; this just keeps the button from inviting a tap that
            // silently does nothing.
            const adPlaying = !!state.track.isAdvertisement;
            prevBtn.disabled = adPlaying;
            nextBtn.disabled = adPlaying;

            // A live stream's skip refusal is permanent (unlike an ad's), so hide rather
            // than grey — a visible button could only mislead, since the bridge refuses
            // the tap anyway.
            prevBtn.hidden = isLive;
            nextBtn.hidden = isLive;
        } else {
            title.textContent = 'Not Playing';
            artist.textContent = '—';
            live.hidden = true;
            widget.classList.add('stopped');
            // Nothing playing must not block transport — pressing next may start playback.
            prevBtn.disabled = false;
            nextBtn.disabled = false;
            prevBtn.hidden = false;
            nextBtn.hidden = false;
        }

        if (state.playerState === 2) {
            playBtn.classList.add('playing');
        } else {
            playBtn.classList.remove('playing');
        }
        playBtn.classList.toggle('live', isLive);

        const artworkURL = window.NepTunes.getArtworkDataURL();
        updateArtwork(artworkURL);
    }

    function updateArtwork(url) {
        if (url !== currentArtworkURL) {
            if (artworkTransitionTimeout) {
                clearTimeout(artworkTransitionTimeout);
                artworkTransitionTimeout = null;
            }
            if (url) {
                if (currentArtworkURL) {
                    artwork.classList.remove('visible');
                    artworkTransitionTimeout = setTimeout(() => {
                        artwork.src = url;
                        artwork.classList.add('visible');
                        noArtwork.classList.add('hidden');
                        artworkTransitionTimeout = null;
                    }, 300);
                } else {
                    artwork.src = url;
                    artwork.classList.add('visible');
                    noArtwork.classList.add('hidden');
                }
            } else {
                artwork.classList.remove('visible');
                noArtwork.classList.remove('hidden');
            }
            currentArtworkURL = url;
        }
    }

    function setupControls() {
        playBtn.addEventListener('click', () => window.NepTunes.playPause());
        prevBtn.addEventListener('click', () => window.NepTunes.previous());
        nextBtn.addEventListener('click', () => window.NepTunes.next());
    }

    async function init() {
        if (!window.NepTunes) {
            console.error('NepTunes API not available');
            return;
        }

        setupControls();
        applySettings(window.NepTunes.settings);
        await loadIcons();
        updateUI(window.NepTunes.state);

        window.NepTunes.on('statechange', (state) => updateUI(state));
        window.NepTunes.on('settingschange', (settings) => applySettings(settings));
        window.NepTunes.on('themechange', onThemeChange);

        console.log('Now Playing widget initialized');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
