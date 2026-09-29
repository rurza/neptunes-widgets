import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// NepTunes 4.1 lets a user keep a music widget on screen with nothing playing ("Show: Always"),
// but only for a widget whose manifest says it draws its own "Nothing playing" state. Every
// first-party music widget does, and each one's empty state opens the music player. These pin
// the parts of that contract a browser is not needed for.

const MUSIC = ['Artwork', 'CDCase', 'FullPlayer', 'Glass', 'Headline', 'Minimal',
               'NowPlaying', 'Sleeve', 'Stack', 'Strip', 'V3', 'Vinyl'];
const STATS = ['Activity', 'Charts', 'Scrobbles'];

const read = (widget, file) => readFileSync(new URL(`../${widget}.nepget/${file}`, import.meta.url), 'utf8');
const manifest = (widget) => JSON.parse(read(widget, 'manifest.json'));

for (const w of MUSIC) {
  test(`${w}: the manifest offers "Always" and may open the player`, () => {
    const m = manifest(w);
    assert.equal(m.supportsNoPlayback, true, 'supportsNoPlayback');
    assert.notEqual(m.alwaysVisible, true, 'a music widget defaults to "While music is playing"');
    assert.ok(m.permissions.includes('playerActivation'), 'activatePlayer() needs playerActivation');
    // Older apps ignore supportsNoPlayback and keep the widget playback-only, which it still
    // handles — so it must stay installable there.
    assert.equal(m.minNepTunesVersion, undefined, 'no minNepTunesVersion');
  });

  test(`${w}: the empty state's click target is a labelled <button> that calls activatePlayer`, () => {
    const html = read(w, 'index.html');
    // A <button>, so the host's drag script (WidgetJSBridge isInteractive) never starts a
    // window drag on it and swallows the click.
    const tag = html.match(/<button\b[^>]*data-action="activate-player"[^>]*>/s);
    assert.ok(tag, 'a <button data-action="activate-player">');
    assert.match(tag[0], /aria-label="[^"]+"/, 'with an accessible label');
    assert.match(read(w, 'script.js'), /\.activatePlayer\(\)/, 'script.js calls activatePlayer()');
  });
}

for (const w of STATS) {
  test(`${w}: a stats widget is Always by default and needs NepTunes 4.1`, () => {
    const m = manifest(w);
    assert.equal(m.alwaysVisible, true);
    assert.equal(m.minNepTunesVersion, '4.1.0');
  });
}

// With no player running the host sends playerState 0 — not 1 — and neither `track` nor
// `playerType`. A stopped player can still carry its last track, and that is not empty.
const NO_PLAYER = { playerState: 0, volume: 50 };
const STOPPED_EMPTY = { playerState: 1, playerType: 'appleMusic' };
const STOPPED_WITH_TRACK = { playerState: 1, playerType: 'appleMusic', track: { title: 'T', artist: 'A' } };
const PAUSED = { playerState: 3, playerType: 'spotify', track: { title: 'T', artist: 'A' } };
// Some local files and a radio stream before its metadata lands have no title. Music is playing.
const UNTITLED = { playerState: 2, playerType: 'spotify', track: { artist: 'A', album: 'L' } };

for (const w of ['Artwork', 'CDCase', 'FullPlayer', 'Glass', 'Headline', 'Minimal', 'NowPlaying', 'Stack',
                 'Strip', 'V3', 'Vinyl']) {
  test(`${w}: isEmpty is "no track", whatever playerState says`, () => {
    const { isEmpty } = require(`../${w}.nepget/script.js`);
    assert.equal(isEmpty(null), true, 'before the first push');
    assert.equal(isEmpty(undefined), true);
    assert.equal(isEmpty(NO_PLAYER), true, 'no player: playerState 0');
    assert.equal(isEmpty(STOPPED_EMPTY), true, 'stopped with nothing loaded');
    assert.equal(isEmpty(STOPPED_WITH_TRACK), false, 'stopped WITH a track keeps showing it');
    assert.equal(isEmpty(PAUSED), false);
    assert.equal(isEmpty(UNTITLED), false, 'a track without a title is still a track');
  });
}
