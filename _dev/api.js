window.NepTunes = {
    // Current state (updated via pushState)
    state: null,
    settings: null,

    // Event listeners
    _listeners: {},

    // Request ids are `<kind>_<document>_<n>`. This helper outlives a page reload, so a
    // late answer for the previous document's `lfm_1` must not settle this one's.
    _documentToken: (function() {
        var token = '';
        while (token.length < 8) token += Math.floor(Math.random() * 36).toString(36);
        return token;
    })(),

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

    // The current album's motion artwork loop, for a <video src>, or null. Given only to a
    // widget declaring "supportsMotionArtwork" with the "artwork" permission, while the
    // user has not turned "Animated cover" off, once the app has the loop on disk.
    getMotionArtworkURL: function() {
        return this.state?.track?.motionArtworkURL || null;
    },

    // Last.fm API (requires "lastfm" permission)
    lastFm: {
        _nextId: 1,
        _pending: {},

        _request: function(method, params) {
            return new Promise(function(resolve, reject) {
                var id = 'lfm_' + NepTunes._documentToken + '_' + (NepTunes.lastFm._nextId++);
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

    // Listening history (requires the "listeningHistory" permission). Rejects with an
    // Error whose `code` is unavailable | invalidQuery | timeout | permissionDenied.
    history: {
    _nextId: 1,
    // Ids are `hist_<document>_<n>`. The helper outlives a reload, so a late answer for
    // the previous document's `hist_1` must not settle this document's.
    _idPrefix: (function() {
        var token = '';
        while (token.length < 8) token += Math.floor(Math.random() * 36).toString(36);
        return 'hist_' + token + '_';
    })(),
    _pending: {},
    _timeoutMs: 15000,

    _error: function(code, message) {
        var error = new Error(message || code);
        error.code = code;
        return error;
    },

    // An invalid Date is sent as "Invalid Date", which the app refuses as invalidQuery in
    // every position. Not null: an optional `before` of null means "no cursor", and a bad
    // cursor would silently answer the newest page again. Not toISOString(), which throws
    // a RangeError out of the call.
    _iso: function(value) {
        if (!(value instanceof Date)) return value;
        return isNaN(value.getTime()) ? String(value) : value.toISOString();
    },

    _request: function(kind, args) {
        var history = NepTunes.history;
        return new Promise(function(resolve, reject) {
            var id = history._idPrefix + (history._nextId++);
            history._pending[id] = { resolve: resolve, reject: reject };
            var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.neptunes;
            if (!handler) {
                delete history._pending[id];
                reject(history._error('unavailable', 'The NepTunes bridge is unavailable'));
                return;
            }
            try {
                handler.postMessage({
                    type: 'historyQuery',
                    kind: kind,
                    requestId: id,
                    args: args
                });
            } catch (e) {
                // A DataCloneError: an argument (a function, a DOM node) cannot be sent.
                delete history._pending[id];
                reject(history._error('invalidQuery', 'Arguments must be strings, numbers or Dates'));
                return;
            }
            setTimeout(function() {
                var pending = history._pending[id];
                if (!pending) return;
                delete history._pending[id];
                pending.reject(history._error('timeout', 'Listening history request timed out'));
            }, history._timeoutMs);
        });
    },

    _resolve: function(requestId, data, code, message) {
        var pending = this._pending[requestId];
        if (!pending) return;
        delete this._pending[requestId];
        if (code) pending.reject(this._error(code, message));
        else pending.resolve(data);
    },

    info: function() {
        return NepTunes.history._request('info', {});
    },

    query: function(options) {
        var o = options || {};
        var history = NepTunes.history;
        var args = { from: history._iso(o.from), to: history._iso(o.to), groupBy: o.groupBy };
        if (o.sort !== undefined) args.sort = o.sort;
        if (o.limit !== undefined) args.limit = o.limit;
        return history._request('query', args);
    },

    recent: function(options) {
        var o = options || {};
        var history = NepTunes.history;
        var args = {};
        if (o.limit !== undefined) args.limit = o.limit;
        if (o.before !== undefined && o.before !== null) args.before = history._iso(o.before);
        return history._request('recent', args);
    }
},

    _symbolNextId: 1,
    _symbolPending: {},

    symbol: function(name, opts) {
        opts = opts || {};
        return new Promise(function(resolve, reject) {
            var id = 'sym_' + NepTunes._documentToken + '_' + (NepTunes._symbolNextId++);
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

// Generic read-only Last.fm passthrough and image proxy (NepTunes.lastFm.call / .image).
// Lives in NepTunesKit so a package test runs it in a real WKWebView.
(function (lastFm) {
    if (!lastFm) { return; }
    // Ids are `<prefix><document>_<n>`. The helper outlives a reload, so a late answer
    // for the previous document's `lfc_1` must not settle this document's.
    var documentToken = '';
    while (documentToken.length < 8) { documentToken += Math.floor(Math.random() * 36).toString(36); }
    var nextId = 1;
    var pending = {};

    function passthroughError(code, message) {
        var error = new Error(message || code);
        error.code = code;
        return error;
    }

    // Last.fm params are strings. Numbers and booleans are converted, as `extended: true`
    // means "1"; anything else is dropped.
    function stringParams(params) {
        var out = {};
        if (!params || typeof params !== 'object' || Array.isArray(params)) { return out; }
        Object.keys(params).forEach(function (key) {
            var value = params[key];
            if (typeof value === 'string') { out[key] = value; }
            else if (typeof value === 'number' && isFinite(value)) { out[key] = String(value); }
            else if (typeof value === 'boolean') { out[key] = value ? '1' : '0'; }
        });
        return out;
    }

    function send(type, prefix, message) {
        return new Promise(function (resolve, reject) {
            var id = prefix + documentToken + '_' + (nextId++);
            pending[id] = { resolve: resolve, reject: reject };
            message.type = type;
            message.requestId = id;
            try {
                window.webkit.messageHandlers.neptunes.postMessage(message);
            } catch (e) {
                delete pending[id];
                reject(passthroughError('network', 'The NepTunes bridge is unavailable'));
                return;
            }
            // Backstop. The helper settles every request, with `timeout`/`network` when the
            // app doesn't answer, but its queue (up to 5 s) plus the send and receive
            // windows can outlast this, so a slow request can end here first.
            setTimeout(function () {
                if (pending[id]) {
                    delete pending[id];
                    reject(passthroughError('timeout', 'Last.fm request timed out'));
                }
            }, lastFm._passthroughTimeoutMs);
        });
    }

    lastFm._passthroughTimeoutMs = 15000;

    lastFm.call = function (method, params) {
        if (typeof method !== 'string' || method.length === 0) {
            return Promise.reject(passthroughError('methodNotAllowed', 'method must be a non-empty string'));
        }
        return send('lastFmCall', 'lfc_', { method: method, params: stringParams(params) });
    };

    lastFm.image = function (url) {
        if (typeof url !== 'string' || url.length === 0) {
            return Promise.reject(passthroughError('urlNotAllowed', 'url must be a non-empty string'));
        }
        return send('lastFmImage', 'lfi_', { url: url });
    };

    lastFm._settlePassthrough = function (requestId, ok, payload, code, message, parseJSON) {
        var entry = pending[requestId];
        if (!entry) { return; }
        delete pending[requestId];
        if (!ok) { entry.reject(passthroughError(code || 'network', message)); return; }
        if (!parseJSON) { entry.resolve(payload); return; }
        var value;
        try { value = JSON.parse(payload); }
        catch (e) { entry.reject(passthroughError('network', 'Last.fm sent a response that is not JSON')); return; }
        entry.resolve(value);
    };
})(window.NepTunes && window.NepTunes.lastFm);

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