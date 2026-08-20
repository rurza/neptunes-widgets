import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Scrobbles = require('../Scrobbles.nepget/script.js');

// `accentKey` is the cache identity for "which accent is on screen right now". Everything
// that should repaint the accent has to change it, and everything that should not must
// leave it alone: the widget re-applies exactly when the key moves.
//
// It exists because the cache used to be the artwork URL by itself, and null did double
// duty as both "no artwork is playing" and "the cache was just cleared".

test('switching a fixed colour back to album art repaints, even with nothing playing', () => {
    // The reported bug. Pause the player (getArtworkDataURL() is null), set Accent to
    // "Fixed color", then set it back to "From album art". Under a URL-only cache both
    // states keyed on null, so the switch read as "nothing changed" and the fixed colour
    // stayed on the widget until artwork happened to appear.
    assert.notEqual(Scrobbles.accentKey('album', null, '#FF375F', true),
                    Scrobbles.accentKey('fixed', null, '#FF375F', true));
});

test('a repeat of the same state does not repaint', () => {
    // statechange fires on every position tick, play/pause, volume and mute. Re-deriving
    // the palette there costs a legibleAccent search plus four custom-property writes on
    // the card, several times a minute, for a colour that did not move.
    assert.equal(Scrobbles.accentKey('fixed', null, '#FF375F', true),
                 Scrobbles.accentKey('fixed', null, '#FF375F', true));
    assert.equal(Scrobbles.accentKey('album', 'data:image/png;base64,AAA', '#FF375F', true),
                 Scrobbles.accentKey('album', 'data:image/png;base64,AAA', '#FF375F', true));
});

test('a theme flip repaints in both modes', () => {
    // --accent-ink is picked against the panel, so the same colour on a light panel is a
    // different ink. Nothing else in the key changes when the system flips.
    for (const source of ['album', 'fixed']) {
        assert.notEqual(Scrobbles.accentKey(source, 'data:x', '#FF375F', true),
                        Scrobbles.accentKey(source, 'data:x', '#FF375F', false));
    }
});

test('a new colour or a new cover repaints', () => {
    assert.notEqual(Scrobbles.accentKey('fixed', null, '#FF375F', true),
                    Scrobbles.accentKey('fixed', null, '#30D158', true));
    assert.notEqual(Scrobbles.accentKey('album', 'data:cover-a', '#FF375F', true),
                    Scrobbles.accentKey('album', 'data:cover-b', '#FF375F', true));
});

test('losing the cover repaints, so the accent falls back to neutral', () => {
    // Playing -> stopped. The album branch resolves NEUTRAL for a null URL, but only if
    // it is reached: the key has to move for that to happen.
    assert.notEqual(Scrobbles.accentKey('album', 'data:cover-a', '#FF375F', true),
                    Scrobbles.accentKey('album', null, '#FF375F', true));
});
