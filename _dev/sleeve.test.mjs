import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Sleeve shows the album's motion artwork (NepTunes 4.1) as a muted, looping <video> laid over
// the static cover. script.js exports its pure half and returns before touching the DOM, so the
// decisions — when there is a loop to show, when it plays, when a <video> is loaded, revealed and
// let go — are pinned here without a browser. What it looks like is checked in the harness.

const Sleeve = require('../Sleeve.nepget/script.js');
const { motionState, createMotionLayer } = Sleeve;

const read = (file) => readFileSync(new URL(`../Sleeve.nepget/${file}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

const LOOP = 'neptunes-media://motion/0123456789abcdef0123456789abcdef.mp4';
const OTHER = 'neptunes-media://motion/fedcba9876543210fedcba9876543210.mp4';
const track = (extra) => Object.assign({ title: 'T', artist: 'A', album: 'L', motionArtworkURL: LOOP }, extra);
const PLAYING = { playerState: 2, playerType: 'appleMusic', track: track() };
const PAUSED = { playerState: 3, playerType: 'appleMusic', track: track() };
const OFF = { src: null, album: null, play: false };

// ---------------------------------------------------------------- manifest ----

test('the manifest declares motion artwork, with the artwork permission it rides on', () => {
  assert.equal(manifest.supportsMotionArtwork, true);
  assert.ok(manifest.permissions.includes('artwork'));
});

test('the signed 4.1 release requires NepTunes 4.1.0 and is version 1.1.1', () => {
  assert.equal(manifest.minNepTunesVersion, '4.1.0');
  assert.equal(manifest.version, '1.1.1');
});

// ------------------------------------------------------------- motionState ----

test('a playing track with a loop plays it', () => {
  assert.deepEqual(motionState(PLAYING, false), { src: LOOP, album: 'L', play: true });
});

test('a paused track keeps its loop loaded but not playing (the frame stays)', () => {
  assert.deepEqual(motionState(PAUSED, false), { src: LOOP, album: 'L', play: false });
});

test('no loop — an older app, support off, not downloaded yet, not Pro — is no video', () => {
  assert.deepEqual(motionState({ playerState: 2, track: track({ motionArtworkURL: undefined }) }, false), OFF);
  assert.deepEqual(motionState({ playerState: 2, track: track({ motionArtworkURL: null }) }, false), OFF);
  assert.deepEqual(motionState({ playerState: 2, track: track({ motionArtworkURL: '' }) }, false), OFF);
});

test('prefers-reduced-motion means no video at all', () => {
  assert.deepEqual(motionState(PLAYING, true), OFF);
  assert.deepEqual(motionState(PAUSED, true), OFF);
});

test('nothing playing, stopped, or no player: no video', () => {
  assert.deepEqual(motionState(null, false), OFF);
  assert.deepEqual(motionState(undefined, false), OFF);
  assert.deepEqual(motionState({ playerState: 0, volume: 50 }, false), OFF);
  assert.deepEqual(motionState({ playerState: 1, playerType: 'appleMusic' }, false), OFF);
  assert.deepEqual(motionState({ playerState: 1, playerType: 'appleMusic', track: track() }, false), OFF,
    'stopped at the end of the queue with the last track kept');
});

test('an advertisement never shows a loop', () => {
  assert.deepEqual(motionState({ playerState: 2, track: track({ isAdvertisement: true }) }, false), OFF);
});

test('a track without an album still keys its loop', () => {
  assert.deepEqual(motionState({ playerState: 2, track: track({ album: undefined }) }, false),
    { src: LOOP, album: '', play: true });
});

// ----------------------------------------------------------- motion layer ----

// Just enough of HTMLVideoElement for the layer: attributes, events, play/pause, the readiness
// the reveal waits on, and requestVideoFrameCallback when `withFrameCallback`.
function fakeVideo({ withFrameCallback = true } = {}) {
  const listeners = {};
  const classes = new Set();
  const v = {
    attrs: {}, paused: true, readyState: 0, currentTime: 0, loads: 0, plays: 0, pauses: 0,
    frameCallbacks: [], parentNode: null, playResult: undefined,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    setAttribute(k, val) { this.attrs[k] = String(val); },
    removeAttribute(k) { delete this.attrs[k]; },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    emit(type) { (listeners[type] || []).forEach((fn) => fn({ type })); },
    load() { this.loads++; },
    play() { this.plays++; this.paused = false; return this.playResult; },
    pause() { this.pauses++; this.paused = true; },
    get visible() { return classes.has('visible'); },
    // Media data arrived and a frame was presented.
    becomeReady() { this.readyState = 4; this.emit('loadeddata'); this.emit('canplay'); },
    presentFrame() {
      this.currentTime += 0.033;
      const cbs = this.frameCallbacks; this.frameCallbacks = [];
      cbs.forEach((fn) => fn(0, {}));
      this.emit('timeupdate');
    },
  };
  if (withFrameCallback) v.requestVideoFrameCallback = function (fn) { this.frameCallbacks.push(fn); return 1; };
  return v;
}

function harness(opts = {}) {
  const made = [];
  const timers = [];
  const container = {
    children: [],
    appendChild(el) { this.children.push(el); el.parentNode = this; },
    removeChild(el) { this.children = this.children.filter((c) => c !== el); el.parentNode = null; },
  };
  const layer = createMotionLayer({
    container,
    createVideo: () => { const v = fakeVideo(opts); made.push(v); return v; },
    later: (fn) => { timers.push(fn); },
  });
  const flush = () => { while (timers.length) timers.shift()(); };
  return { layer, made, container, flush };
}

const RELEASED = (v) => v.getAttribute('src') === null && v.loads >= 1 && v.parentNode === null;

test('a loop is loaded muted, looping and inline, and only revealed once a frame is on screen', () => {
  const { layer, made, container } = harness();
  layer.update({ src: LOOP, album: 'L', play: true });
  assert.equal(made.length, 1);
  const v = made[0];
  assert.equal(v.getAttribute('src'), LOOP);
  assert.equal(v.muted, true);
  assert.equal(v.loop, true);
  assert.notEqual(v.getAttribute('muted'), null);
  assert.notEqual(v.getAttribute('loop'), null);
  assert.notEqual(v.getAttribute('playsinline'), null);
  assert.deepEqual(container.children, [v]);
  assert.equal(v.visible, false, 'nothing to show yet: never a black or empty frame');
  v.becomeReady();
  assert.equal(v.paused, false, 'playing');
  assert.equal(v.visible, false, 'ready is not yet a frame on screen');
  v.presentFrame();
  assert.equal(v.visible, true);
});

test('without requestVideoFrameCallback, playback actually advancing reveals it', () => {
  const { layer, made } = harness({ withFrameCallback: false });
  layer.update({ src: LOOP, album: 'L', play: true });
  const v = made[0];
  v.emit('timeupdate');
  assert.equal(v.visible, false, 'a timeupdate at 0 with no data is not a frame');
  v.becomeReady();
  v.presentFrame();
  assert.equal(v.visible, true);
});

test('the same loop again (the next track on the album) keeps playing without a reload', () => {
  const { layer, made } = harness();
  layer.update({ src: LOOP, album: 'L', play: true });
  const v = made[0];
  v.becomeReady(); v.presentFrame();
  const plays = v.plays;
  layer.update({ src: LOOP, album: 'L', play: true });
  layer.update({ src: LOOP, album: 'L', play: true });
  assert.equal(made.length, 1, 'no second <video>');
  assert.equal(v.loads, 0, 'not reloaded');
  assert.equal(v.plays, plays, 'play() is not called again on a video that is playing');
  assert.equal(v.visible, true);
});

test('pause keeps the frame on screen; play resumes the same video', () => {
  const { layer, made } = harness();
  layer.update({ src: LOOP, album: 'L', play: true });
  const v = made[0];
  v.becomeReady(); v.presentFrame();
  layer.update({ src: LOOP, album: 'L', play: false });
  assert.equal(v.paused, true);
  assert.equal(v.visible, true, 'the paused frame stays');
  assert.equal(v.getAttribute('src'), LOOP);
  layer.update({ src: LOOP, album: 'L', play: true });
  assert.equal(v.paused, false);
  assert.equal(made.length, 1);
});

test('loaded while paused, it does not play, and is not revealed before it has a frame', () => {
  const { layer, made } = harness();
  layer.update({ src: LOOP, album: 'L', play: false });
  const v = made[0];
  v.readyState = 4; v.emit('loadeddata'); v.emit('canplay');
  assert.equal(v.plays, 0);
  assert.equal(v.visible, false);
  layer.update({ src: LOOP, album: 'L', play: true });
  assert.equal(v.paused, false);
  v.presentFrame();
  assert.equal(v.visible, true);
});

test('the URL going away fades back to the static art, then releases the video', () => {
  const { layer, made, flush } = harness();
  layer.update({ src: LOOP, album: 'L', play: true });
  const v = made[0];
  v.becomeReady(); v.presentFrame();
  layer.update({ src: null, album: null, play: false });
  assert.equal(v.visible, false, 'fading out');
  assert.equal(v.paused, true);
  assert.equal(v.getAttribute('src'), LOOP, 'kept until the fade is over');
  flush();
  assert.ok(RELEASED(v), 'src removed, load() called, element gone');
});

test('an album change swaps to a fresh video even when the URL is the same', () => {
  const { layer, made, container, flush } = harness();
  layer.update({ src: LOOP, album: 'L', play: true });
  const a = made[0];
  a.becomeReady(); a.presentFrame();
  layer.update({ src: LOOP, album: 'Other album', play: true });
  assert.equal(made.length, 2);
  const b = made[1];
  assert.equal(a.visible, false);
  assert.equal(b.visible, false, 'the new one waits for its own frame');
  flush();
  assert.ok(RELEASED(a));
  assert.deepEqual(container.children, [b]);
  b.becomeReady(); b.presentFrame();
  assert.equal(b.visible, true);
});

test('a new URL swaps the video', () => {
  const { layer, made, flush } = harness();
  layer.update({ src: LOOP, album: 'L', play: true });
  layer.update({ src: OTHER, album: 'L', play: true });
  assert.equal(made.length, 2);
  assert.equal(made[1].getAttribute('src'), OTHER);
  flush();
  assert.ok(RELEASED(made[0]));
});

test('a released video that reports a frame late is never revealed', () => {
  const { layer, made } = harness();
  layer.update({ src: LOOP, album: 'L', play: true });
  const v = made[0];
  layer.update({ src: null, album: null, play: false });
  v.becomeReady(); v.presentFrame();
  assert.equal(v.visible, false);
});

test('an error falls back to the static art, and the same loop is not retried in a loop', () => {
  const { layer, made, flush } = harness();
  layer.update({ src: LOOP, album: 'L', play: true });
  const v = made[0];
  v.becomeReady(); v.presentFrame();
  v.emit('error');
  assert.equal(v.visible, false);
  flush();
  assert.ok(RELEASED(v));
  layer.update({ src: LOOP, album: 'L', play: true });
  assert.equal(made.length, 1, 'the failed loop is not reloaded on every statechange');
  // Once it goes away and comes back (a later album change, a new download), it is tried again.
  layer.update({ src: null, album: null, play: false });
  layer.update({ src: LOOP, album: 'L', play: true });
  assert.equal(made.length, 2);
});

test('a rejected play() leaves the static art up', async () => {
  const { layer, made } = harness();
  layer.update({ src: LOOP, album: 'L', play: false });
  const v = made[0];
  v.playResult = Promise.reject(new Error('NotAllowedError'));
  layer.update({ src: LOOP, album: 'L', play: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(v.visible, false);
});

test('an error on a video already let go does not disturb the current one', () => {
  const { layer, made } = harness();
  layer.update({ src: LOOP, album: 'L', play: true });
  layer.update({ src: OTHER, album: 'L', play: true });
  made[0].emit('error');
  const b = made[1];
  b.becomeReady(); b.presentFrame();
  assert.equal(b.visible, true);
});

// ------------------------------------------------------------- page wiring ----

test('the cover stays the only shadowed element, and the video is clipped by it', () => {
  const css = read('styles.css');
  const motion = css.match(/\.motion\s*\{([^}]*)\}/);
  assert.ok(motion, 'a .motion rule');
  assert.match(motion[1], /position:\s*absolute/);
  assert.match(motion[1], /object-fit:\s*cover/);
  assert.match(motion[1], /opacity:\s*0/);
  assert.match(motion[1], /transition:\s*opacity 0\.35s/, 'the same crossfade as the static art');
  assert.doesNotMatch(motion[1], /box-shadow/);
  assert.match(css, /\.motion\.visible\s*\{[^}]*opacity:\s*1/);
});

test('the page watches prefers-reduced-motion and reads the loop from the track', () => {
  const js = read('script.js');
  assert.match(js, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
  assert.match(js, /motionArtworkURL/);
  assert.match(js, /getElementById\('cover'\)/, 'the videos live inside the rounded cover');
});
