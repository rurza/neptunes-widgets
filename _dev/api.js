window.NepTunes = {
    // Current state (updated via pushState)
    state: null,
    settings: null,

    // Event listeners
    _listeners: {},

    // Register event listener
    on: function(event, callback) {
        if (!this._listeners[event]) {
            this._listeners[event] = [];
        }
        this._listeners[event].push(callback);
    },

    // Remove event listener
    off: function(event, callback) {
        if (this._listeners[event]) {
            this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
        }
    },

    // Emit event (called from native)
    _emit: function(event, data) {
        if (this._listeners[event]) {
            this._listeners[event].forEach(cb => {
                try { cb(data); } catch(e) { console.error('NepTunes event handler error:', e); }
            });
        }
    },

    // Get current state
    getState: function() {
        return Promise.resolve(this.state);
    },

    // Get widget settings
    getSettings: function() {
        return Promise.resolve(this.settings);
    },

    // Perform action
    performAction: function(action) {
        window.webkit.messageHandlers.neptunes.postMessage({
            type: 'action',
            action: action
        });
    },

    // Set volume (0-100)
    setVolume: function(volume) {
        window.webkit.messageHandlers.neptunes.postMessage({
            type: 'setVolume',
            value: volume
        });
    },

    // Set rating (0-100)
    setRating: function(rating) {
        window.webkit.messageHandlers.neptunes.postMessage({
            type: 'setRating',
            value: rating
        });
    },

    // Convenience methods
    playPause: function() { this.performAction('playPause'); },
    next: function() { this.performAction('nextTrack'); },
    previous: function() { this.performAction('previousTrack'); },
    increaseVolume: function() { this.performAction('increaseVolume'); },
    decreaseVolume: function() { this.performAction('decreaseVolume'); },
    toggleMute: function() { this.performAction('toggleMute'); },
    toggleLove: function() { this.performAction('toggleLove'); },
    toggleDislike: function() { this.performAction('toggleDislike'); },
    increaseRating: function() { this.performAction('increaseRating'); },
    decreaseRating: function() { this.performAction('decreaseRating'); },
    removeRating: function() { this.performAction('removeRating'); },
    toggleShuffle: function() { this.performAction('toggleShuffle'); },
    toggleRepeat: function() { this.performAction('toggleRepeat'); },
    activatePlayer: function() { this.performAction('activatePlayer'); },
    switchPlayer: function() { this.performAction('switchPlayer'); },

    // Request window resize
    setSize: function(width, height) {
        window.webkit.messageHandlers.neptunes.postMessage({
            type: 'setSize',
            width: width,
            height: height
        });
    },

    // Capabilities helper
    get capabilities() {
        return this.state?.capabilities || {
            canLove: false,
            canDislike: false,
            canRate: false,
            canAddToLibrary: false,
            hasThreeStateRepeat: false
        };
    },

    // Track info helpers
    get track() { return this.state?.track || null; },
    get isPlaying() { return this.state?.playerState === 2; },
    get isPaused() { return this.state?.playerState === 3; },
    get isStopped() { return this.state?.playerState === 1; },
    get volume() { return this.state?.volume || 0; },
    get isMuted() { return this.state?.isMuted || false; },
    get playerType() { return this.state?.playerType || null; },

    // Artwork as data URL
    getArtworkDataURL: function() {
        if (!this.state?.track?.artworkData) return null;
        // artworkData is base64 encoded when passed to JS
        return 'data:image/jpeg;base64,' + this.state.track.artworkData;
    },

    // Last.fm API (requires "lastfm" permission)
    lastFm: {
        _nextId: 1,
        _pending: {},

        _request: function(method, params) {
            return new Promise(function(resolve, reject) {
                var id = 'lfm_' + (NepTunes.lastFm._nextId++);
                NepTunes.lastFm._pending[id] = { resolve: resolve, reject: reject };
                window.webkit.messageHandlers.neptunes.postMessage({
                    type: 'lastFmQuery',
                    method: method,
                    requestId: id,
                    params: params || {}
                });
                // Timeout after 15s
                setTimeout(function() {
                    if (NepTunes.lastFm._pending[id]) {
                        NepTunes.lastFm._pending[id].reject(new Error('Last.fm request timed out'));
                        delete NepTunes.lastFm._pending[id];
                    }
                }, 15000);
            });
        },

        _resolve: function(requestId, success, data, error) {
            var pending = this._pending[requestId];
            if (!pending) return;
            delete this._pending[requestId];
            if (success) {
                pending.resolve(data);
            } else {
                pending.reject(new Error(error || 'Last.fm request failed'));
            }
        },

        getUserInfo: function() {
            return NepTunes.lastFm._request('getUserInfo');
        },
        getTopAlbums: function(period, limit) {
            return NepTunes.lastFm._request('getTopAlbums', { period: period || 'overall', limit: String(limit || 10) });
        },
        getTopArtists: function(period, limit) {
            return NepTunes.lastFm._request('getTopArtists', { period: period || 'overall', limit: String(limit || 10) });
        },
        getTopTracks: function(period, limit) {
            return NepTunes.lastFm._request('getTopTracks', { period: period || 'overall', limit: String(limit || 10) });
        },
        getRecentTracks: function(limit) {
            return NepTunes.lastFm._request('getRecentTracks', { limit: String(limit || 20) });
        },
        getTrackInfo: function(track, artist) {
            return NepTunes.lastFm._request('getTrackInfo', { track: track, artist: artist });
        },
        getArtistInfo: function(artist) {
            return NepTunes.lastFm._request('getArtistInfo', { artist: artist });
        },
        loveTrack: function(track, artist) {
            return NepTunes.lastFm._request('loveTrack', { track: track, artist: artist });
        },
        unloveTrack: function(track, artist) {
            return NepTunes.lastFm._request('unloveTrack', { track: track, artist: artist });
        }
    },

    _symbolNextId: 1,
    _symbolPending: {},

    symbol: function(name, opts) {
        opts = opts || {};
        return new Promise(function(resolve, reject) {
            var id = 'sym_' + (NepTunes._symbolNextId++);
            NepTunes._symbolPending[id] = { resolve: resolve, reject: reject };
            window.webkit.messageHandlers.neptunes.postMessage({
                type: 'symbol',
                requestId: id,
                name: name,
                size: opts.size || 24,
                weight: opts.weight || 'regular',
                color: opts.color || '#ffffff',
                // Real backing scale so the native rasteriser emits a PNG that maps 1:1 to
                // device pixels. A hardcoded 2x softened every icon on any display whose
                // backing scale isn't exactly 2 (scaled "More Space" framebuffers, non-2x
                // panels), worse the bigger the glyph.
                dpr: window.devicePixelRatio || 2
            });
            setTimeout(function() {
                if (NepTunes._symbolPending[id]) {
                    NepTunes._symbolPending[id].reject(new Error('Symbol request timed out'));
                    delete NepTunes._symbolPending[id];
                }
            }, 5000);
        });
    },

    _resolveSymbol: function(requestId, success, dataURL) {
        var pending = this._symbolPending[requestId];
        if (!pending) return;
        delete this._symbolPending[requestId];
        if (success && dataURL) {
            pending.resolve(dataURL);
        } else {
            pending.reject(new Error('SF Symbol not found'));
        }
    }
};

// Re-broadcast automatic system light/dark switches as a `themechange` event, so a
// widget can re-run its theming the same way it does for `settingschange`. WebKit
// updates the media query on its own, which is enough for anything decided purely in
// CSS -- but NOT for values JS computes once and writes to the DOM (theme classes,
// artwork-derived accent ink, natively rasterised SF Symbols). Those widgets went
// stale on a flip because nothing told them to recompute. Emitting centrally here
// means every widget gets the signal, rather than each bundle having to remember its
// own matchMedia listener.
(function() {
    if (!window.matchMedia) return;
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var fire = function(e) { window.NepTunes._emit('themechange', { dark: !!e.matches }); };
    if (mq.addEventListener) mq.addEventListener('change', fire);
    else if (mq.addListener) mq.addListener(fire); // pre-Safari 14 fallback
})();

// Disable context menu
document.addEventListener('contextmenu', e => e.preventDefault());

// Window dragging using absolute positioning (not deltas).
// This handles cross-display movement correctly by always positioning
// the window relative to the current mouse position.
(function() {
    let isDragging = false;
    let offsetX = 0, offsetY = 0;
    // A drag ends with a synthetic click that must NOT reach the widget — otherwise a
    // whole-body click-to-toggle (e.g. Strip) fires playPause every time you move the
    // window. Track pointer travel so only a real drag swallows the click; a stationary
    // tap still passes through.
    let didMove = false;
    let downX = 0, downY = 0;
    let suppressClick = false;
    const DRAG_CLICK_THRESHOLD = 4; // px of travel that turns a tap into a drag

    const interactiveTags = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'];
    const interactiveClasses = ['control-btn', 'icon-btn', 'rating-btn', 'header-btn', 'slider', 'resize-handle'];

    function isInteractive(el) {
        while (el && el !== document.body) {
            if (interactiveTags.includes(el.tagName)) return true;
            if (interactiveClasses.some(c => el.classList?.contains(c))) return true;
            el = el.parentElement;
        }
        return false;
    }

    // Use capture phase to ensure we see ALL events before any element can stop propagation.
    // This is the primary handler for drag detection.
    document.addEventListener('mousedown', function(e) {
        console.log('[DRAG-CAPTURE] mousedown captured on:', e.target.tagName, e.target.className, 'eventPhase:', e.eventPhase);
        if (isInteractive(e.target)) {
            console.log('[DRAG-CAPTURE] target is interactive, skipping drag');
            return;
        }
        isDragging = true;
        didMove = false;
        downX = e.screenX;
        downY = e.screenY;
        console.log('[DRAG-CAPTURE] starting drag');
        // Store offset from mouse to window origin (will be calculated in Swift)
        window.webkit.messageHandlers.neptunes.postMessage({
            type: 'dragStart',
            screenX: e.screenX,
            screenY: e.screenY
        });
    }, true); // true = capture phase

    document.addEventListener('mousemove', function(e) {
        if (!isDragging) return;
        if (!didMove && Math.hypot(e.screenX - downX, e.screenY - downY) > DRAG_CLICK_THRESHOLD) {
            didMove = true;
        }
        // Send absolute screen position - Swift calculates window position
        window.webkit.messageHandlers.neptunes.postMessage({
            type: 'dragMove',
            screenX: e.screenX,
            screenY: e.screenY
        });
    }, true); // capture phase for consistency

    document.addEventListener('mouseup', function(e) {
        if (isDragging) {
            console.log('[DRAG-CAPTURE] ending drag');
            isDragging = false;
            window.webkit.messageHandlers.neptunes.postMessage({ type: 'dragEnd' });
            // Only a real drag (pointer actually travelled) should eat the synthetic
            // click WebKit fires next; a stationary tap must still reach the widget.
            if (didMove) {
                suppressClick = true;
                setTimeout(function() { suppressClick = false; }, 0); // clear if no click follows
            }
        }
    }, true); // capture phase

    // Swallow the one synthetic click that follows a real drag. Capture phase runs before
    // any widget's own (bubble-phase) click handler, so the drag never leaks into a toggle.
    document.addEventListener('click', function(e) {
        if (suppressClick) {
            suppressClick = false;
            e.stopPropagation();
            e.preventDefault();
        }
    }, true);

    // Also add window-level listeners as a fallback for edge cases
    window.addEventListener('mousedown', function(e) {
        console.log('[DRAG-WINDOW] window mousedown:', e.target.tagName);
    }, true);
})();

// Log that API is ready
console.log('NepTunes API initialized');
// Also notify native side that script initialized (helps diagnose issues)
window.webkit.messageHandlers.neptunes.postMessage({ type: 'scriptInitialized' });

// Monitor for iframes being added, which can capture mouse events
const iframeObserver = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
        mutation.addedNodes.forEach(function(node) {
            if (node.tagName === 'IFRAME') {
                console.warn('[NepTunes] Iframe detected - mouse events inside iframes will not trigger widget dragging');
            }
        });
    });
});
iframeObserver.observe(document.documentElement, { childList: true, subtree: true });

// Check for existing iframes
document.addEventListener('DOMContentLoaded', function() {
    const iframes = document.querySelectorAll('iframe');
    if (iframes.length > 0) {
        console.warn('[NepTunes] Found ' + iframes.length + ' iframe(s) - mouse events inside iframes will not trigger widget dragging');
    }
});

// Signal to native that widget is ready to receive data
window.NepTunes._signalReady = function() {
    window.webkit.messageHandlers.neptunes.postMessage({ type: 'widgetReady' });
};