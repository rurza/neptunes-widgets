import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const NTKit = require('./neptunes-kit.js');

test('formatTime', () => {
  assert.equal(NTKit.formatTime(0), '0:00');
  assert.equal(NTKit.formatTime(84), '1:24');
  assert.equal(NTKit.formatTime(605), '10:05');
  assert.equal(NTKit.formatTime(-5), '0:00');
  assert.equal(NTKit.formatTime(NaN), '0:00');
});

// The locale is passed explicitly here. Left implicit these would assert the *test
// machine's* default locale, which is how the suite would pass in CI and fail on a
// Polish desktop ('48 213', with a narrow no-break space).
test('formatCount', () => {
  assert.equal(NTKit.formatCount(48213, 'en-US'), '48,213');
  assert.equal(NTKit.formatCount(0, 'en-US'), '0');
  assert.equal(NTKit.formatCount(-3, 'en-US'), '0');
  assert.equal(NTKit.formatCount('1234', 'en-US'), '1,234');
});

test('formatCount follows the host locale rather than pinning en-US', () => {
  assert.equal(NTKit.formatCount(48213, 'de-DE'), '48.213');
  // ar-SA uses Eastern Arabic-Indic digits — the case a hard-coded 'en-US' got wrong.
  assert.equal(NTKit.formatCount(48213, 'ar-SA'), '٤٨٬٢١٣');
});

// The host publishes state.locale from Locale.current. Passing an ICU identifier
// ("ar_SA") rather than a BCP-47 tag ("ar-SA") makes toLocaleString throw RangeError,
// and formatCount runs on every state push — a throw would take the widget down.
test('formatCount degrades to the default on a malformed tag', () => {
  assert.throws(() => (48213).toLocaleString('ar_SA'), RangeError);
  assert.equal(NTKit.formatCount(48213, 'ar_SA'), (48213).toLocaleString());
  assert.equal(NTKit.formatCount(48213, 'not a tag at all'), (48213).toLocaleString());
});

// The kit is required into node by this very file, where `window` does not exist.
// Reading it unguarded threw ReferenceError and broke the whole suite.
test('formatCount works with no window present', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(NTKit.formatCount(1234, 'en-US'), '1,234');
});

test('relativeTime', () => {
  const now = Date.parse('2026-06-26T12:00:00Z');
  assert.equal(NTKit.relativeTime(new Date(now - 10_000), now), 'now');
  assert.equal(NTKit.relativeTime(new Date(now - 3 * 60_000), now), '3m');
  assert.equal(NTKit.relativeTime(new Date(now - 2 * 3_600_000), now), '2h');
  assert.equal(NTKit.relativeTime(new Date(now - 26 * 3_600_000), now), 'yesterday');
  assert.equal(NTKit.relativeTime(new Date(now - 4 * 86_400_000), now), '4d');
  // unix seconds accepted
  assert.equal(NTKit.relativeTime((now - 3 * 60_000) / 1000, now), '3m');
});

test('clock interpolates while playing and clamps', () => {
  let t = 1000; const nowFn = () => t;
  const getPos = NTKit.clock(
    { position: 10, duration: 100, playing: true, timestampMs: 1000 },
    nowFn
  );
  assert.equal(getPos(), 10);
  t = 6000; // +5s
  assert.equal(Math.round(getPos()), 15);
  t = 999999; // far future
  assert.equal(getPos(), 100); // clamped to duration
});

test('clock frozen when paused', () => {
  let t = 1000; const nowFn = () => t;
  const getPos = NTKit.clock(
    { position: 30, duration: 100, playing: false, timestampMs: 1000 },
    nowFn
  );
  t = 9000;
  assert.equal(getPos(), 30);
});

test('paletteFromPixels picks a saturated swatch with readable on-color', () => {
  // 4 px: white, black, vivid red, vivid red -> accent should be red-ish
  const px = [255, 255, 255, 255, 0, 0, 0, 255, 220, 30, 30, 255, 220, 30, 30, 255];
  const p = NTKit.paletteFromPixels(px);
  assert.ok(p.accent[0] > 150 && p.accent[1] < 90 && p.accent[2] < 90, JSON.stringify(p.accent));
  // red is dark-ish -> white text on it
  assert.deepEqual(NTKit.onColor(p.accent), [255, 255, 255]);
});

test('onColor flips on bright accent', () => {
  assert.deepEqual(NTKit.onColor([250, 240, 120]), [0, 0, 0]);
  assert.deepEqual(NTKit.onColor([20, 20, 40]), [255, 255, 255]);
});

function contrast(a, b) {
  const la = NTKit.luminance(a), lb = NTKit.luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

test('legibleAccent clears 4.5:1 on a dark panel', () => {
  const panel = [12, 12, 14];
  for (const c of [[40, 30, 30], [20, 20, 60], [10, 80, 40], [200, 40, 40]]) {
    const out = NTKit.legibleAccent(c, true);
    assert.ok(contrast(out, panel) >= 4.5, `${JSON.stringify(c)} -> ${JSON.stringify(out)} = ${contrast(out, panel).toFixed(2)}`);
  }
});

test('legibleAccent clears 4.5:1 on a light panel (incl. high-luminance yellow)', () => {
  const panel = [251, 251, 252];
  for (const c of [[250, 240, 120], [120, 200, 255], [255, 180, 60], [200, 40, 40]]) {
    const out = NTKit.legibleAccent(c, false);
    assert.ok(contrast(out, panel) >= 4.5, `${JSON.stringify(c)} -> ${JSON.stringify(out)} = ${contrast(out, panel).toFixed(2)}`);
  }
});

test('legibleAccent preserves the hue family', () => {
  const red = NTKit.legibleAccent([200, 40, 40], true);
  assert.ok(red[0] > red[1] && red[0] > red[2], JSON.stringify(red));
});

test('panelIsDark respects explicit themes', () => {
  assert.equal(NTKit.panelIsDark('dark'), true);
  assert.equal(NTKit.panelIsDark('light'), false);
});

test('displayInfo collapses ads and handles edge cases', () => {
  assert.deepEqual(NTKit.displayInfo({}), { title: 'Not Playing', artist: '' });
  assert.deepEqual(NTKit.displayInfo({ track: null }), { title: 'Not Playing', artist: '' });
  assert.deepEqual(
    NTKit.displayInfo({ track: { title: 'Time', artist: 'Pink Floyd' } }),
    { title: 'Time', artist: 'Pink Floyd' }
  );
  assert.deepEqual(
    NTKit.displayInfo({ track: { title: 'Summer Sale', artist: 'Some Brand', isAdvertisement: true } }),
    { title: 'Advertisement', artist: '' }
  );
  assert.deepEqual(
    NTKit.displayInfo({ track: { title: '', artist: '' } }),
    { title: 'Unknown Title', artist: '' }
  );
});
