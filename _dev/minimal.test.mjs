import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Minimal = require('../Minimal.nepget/script.js');

// These pin the arithmetic, not the CSS. The link between the constants and the
// rendered layout is only ever established by measuring in a real WKWebView —
// each label line is 16px (WebKit floors the 16.8px computed line-height), so
// the album line costs 16 + 3 (the .labels gap) = 19. Re-measure if the CSS
// changes; that is how the 34-vs-35 controls drift went unnoticed.
// See Docs/superpowers/specs/2026-07-15-minimal-widget-hide-album-design.md.

test('targetHeight covers the 2x2 of album x controls', () => {
  assert.equal(Minimal.targetHeight(true, false), 100);
  assert.equal(Minimal.targetHeight(true, true), 134);
  assert.equal(Minimal.targetHeight(false, false), 81);
  assert.equal(Minimal.targetHeight(false, true), 115);
});

test('hiding the album costs one line plus its gap, with or without controls', () => {
  assert.equal(Minimal.targetHeight(true, false) - Minimal.targetHeight(false, false), 19);
  assert.equal(Minimal.targetHeight(true, true) - Minimal.targetHeight(false, true), 19);
});

test('all four heights are distinct, so resize()s lastHeight guard cannot alias', () => {
  const heights = [[true, false], [true, true], [false, false], [false, true]]
    .map(([album, controls]) => Minimal.targetHeight(album, controls));
  assert.equal(new Set(heights).size, 4);
});

test('every height clears minSize.height, which setSize clamps to silently', () => {
  const minHeight = 80; // manifest.json minSize.height
  for (const album of [true, false]) {
    for (const controls of [true, false]) {
      assert.ok(
        Minimal.targetHeight(album, controls) >= minHeight,
        `targetHeight(${album}, ${controls}) would be silently clamped`
      );
    }
  }
});

// transportDisabled greys out prev/next during a Spotify ad. The native bridge already
// refuses next()/previous() either way; this only keeps the button from inviting a tap
// that silently does nothing.
test('transportDisabled is true for an advertisement', () => {
  assert.equal(Minimal.transportDisabled({ title: 'Summer Sale', artist: 'Some Brand', isAdvertisement: true }), true);
});

test('transportDisabled is false for an ordinary track', () => {
  assert.equal(Minimal.transportDisabled({ title: 'Time', artist: 'Pink Floyd' }), false);
});

// isAdvertisement is omitted entirely (not `false`) on a real track — the flag is only
// ever sent when true — so this must not misread `undefined` as blocking.
test('transportDisabled treats a missing isAdvertisement as not blocked', () => {
  assert.equal(Minimal.transportDisabled({ title: 'Time', artist: 'Pink Floyd', isAdvertisement: undefined }), false);
});

test('transportDisabled is false with nothing playing', () => {
  assert.equal(Minimal.transportDisabled(undefined), false);
  assert.equal(Minimal.transportDisabled(null), false);
});
