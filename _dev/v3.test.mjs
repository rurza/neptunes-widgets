import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const V3 = require('../V3.nepget/script.js');

// V3 is a 1:1 web port of the NepTunes 3 "V1" theme. These pin the ported
// arithmetic and glyph tables, not the CSS — every number here was read out of
// the Swift originals rather than invented:
//
//   ../NepTunes 3/Themes/V1/Views/ThemeWindow.swift   scrollWheel: the axis test
//                                                     and `delta /= 1.5`
//   ../NepTunes 3/Themes/V1/ThemeController.swift     userDidChangeVolumeWithDelta:
//                                                     the 0…100 clamp
//   ../NepTunes 3/Themes/V1/Views/HoverView.swift     symbolNameForVolume,
//                                                     symbolNameForRepeatMode
//   ../NepTunes 3/Themes/V1/Views/ArtworkView.swift   .frame(maxHeight:) three-state
//
// Contract: docs/superpowers/specs/2026-08-11-v3-widget-design.md.
//
// Two JS-specific quirks are pinned deliberately, both verified with `node -e`
// rather than reasoned about:
//   * `Math.round(-0.5)` and `Math.round(-0.4)` are BOTH `-0`, not `0`, and
//     node:assert/strict compares with Object.is — so `-0` and `0` are different
//     expectations here. Checked: `node -e 'console.log(Object.is(Math.round(-0.5), -0))'`
//     prints true. Do not "fix" this by hand-rolling a Swift-style rounding;
//     the contract says pin what JS actually does.
//   * `Math.max(0, -0)` is `+0`, so clampVolume can never leak a `-0` out even
//     though Math.round produces one. Checked the same way.

// ---------------------------------------------------------------------------
// Exported surface
// ---------------------------------------------------------------------------

test('script.js exports exactly the contract surface, all callable', () => {
  for (const name of [
    'volumeStep', 'clampVolume', 'speakerSymbol', 'repeatSymbol', 'repeatIsOn',
    'isLiveStream', 'wheelAxis', 'swipeDecision', 'infoBarState', 'start',
  ]) {
    assert.equal(typeof V3[name], 'function', `V3.${name} is missing or not a function`);
  }
});

// ---------------------------------------------------------------------------
// speakerSymbol — ports SecondaryControls.symbolNameForVolume.
//
// Swift matched the FIRST of the overlapping `case` ranges, so every shared
// endpoint belongs to the LOWER band: `case 1...25` claims 25 before
// `case 25...50` ever sees it, `case 25...50` claims 50, and so on. That is the
// whole reason this table is worth pinning — a naive `v <= 25 ? … : v < 50 ? …`
// port drifts by exactly one band at three volumes.
// ---------------------------------------------------------------------------

test('speakerSymbol: 0 is the only value that gets the slash', () => {
  assert.equal(V3.speakerSymbol(0), 'speaker.slash');
});

test('speakerSymbol: band speaker, both edges (1 and 25)', () => {
  assert.equal(V3.speakerSymbol(1), 'speaker');
  assert.equal(V3.speakerSymbol(25), 'speaker');
});

test('speakerSymbol: band speaker, interior', () => {
  assert.equal(V3.speakerSymbol(13), 'speaker');
});

test('speakerSymbol: band wave.1, both edges (just over 25, and 50)', () => {
  assert.equal(V3.speakerSymbol(26), 'speaker.wave.1');
  assert.equal(V3.speakerSymbol(50), 'speaker.wave.1');
});

test('speakerSymbol: band wave.1 starts immediately above 25, not at it', () => {
  assert.equal(V3.speakerSymbol(25.5), 'speaker.wave.1');
});

test('speakerSymbol: band wave.2, both edges (just over 50, and 75)', () => {
  assert.equal(V3.speakerSymbol(51), 'speaker.wave.2');
  assert.equal(V3.speakerSymbol(75), 'speaker.wave.2');
});

test('speakerSymbol: band wave.2 starts immediately above 50, not at it', () => {
  assert.equal(V3.speakerSymbol(50.5), 'speaker.wave.2');
});

test('speakerSymbol: band wave.3, both edges (just over 75, and 100)', () => {
  assert.equal(V3.speakerSymbol(76), 'speaker.wave.3');
  assert.equal(V3.speakerSymbol(100), 'speaker.wave.3');
});

test('speakerSymbol: band wave.3 starts immediately above 75, not at it', () => {
  assert.equal(V3.speakerSymbol(75.5), 'speaker.wave.3');
});

// The three low-landing boundaries, called out on their own so a drift here
// names itself instead of hiding inside a band test.
test('speakerSymbol: 25 lands LOW, on speaker, not wave.1', () => {
  assert.equal(V3.speakerSymbol(25), 'speaker');
});

test('speakerSymbol: 50 lands LOW, on wave.1, not wave.2', () => {
  assert.equal(V3.speakerSymbol(50), 'speaker.wave.1');
});

test('speakerSymbol: 75 lands LOW, on wave.2, not wave.3', () => {
  assert.equal(V3.speakerSymbol(75), 'speaker.wave.2');
});

// 0 < v < 1 matched no Swift range and fell through to `default`, so it reads
// as plain `speaker` rather than `speaker.slash`. Match that exactly.
test('speakerSymbol: a fraction between 0 and 1 falls through to speaker, not the slash', () => {
  assert.equal(V3.speakerSymbol(0.5), 'speaker');
  assert.equal(V3.speakerSymbol(0.999), 'speaker');
});

test('speakerSymbol: a negative volume falls through to speaker', () => {
  assert.equal(V3.speakerSymbol(-1), 'speaker');
  assert.equal(V3.speakerSymbol(-100), 'speaker');
});

test('speakerSymbol: above 100 falls through to speaker, it does not saturate at wave.3', () => {
  assert.equal(V3.speakerSymbol(101), 'speaker');
  assert.equal(V3.speakerSymbol(100.5), 'speaker');
});

test('speakerSymbol: NaN falls through to speaker', () => {
  assert.equal(V3.speakerSymbol(NaN), 'speaker');
});

test('speakerSymbol: the infinities fall through to speaker', () => {
  assert.equal(V3.speakerSymbol(Infinity), 'speaker');
  assert.equal(V3.speakerSymbol(-Infinity), 'speaker');
});

// The host publishes `state.volume` as a number, but a missing state reads as
// undefined and a hand-built settings object can smuggle a string in. None of
// those may pick a band by coercion.
test('speakerSymbol: a numeric string is a non-number and falls through to speaker', () => {
  assert.equal(V3.speakerSymbol('50'), 'speaker');
  assert.equal(V3.speakerSymbol('0'), 'speaker');
});

test('speakerSymbol: undefined and null fall through to speaker', () => {
  assert.equal(V3.speakerSymbol(undefined), 'speaker');
  assert.equal(V3.speakerSymbol(null), 'speaker');
});

test('speakerSymbol: an object falls through to speaker', () => {
  assert.equal(V3.speakerSymbol({}), 'speaker');
});

// ---------------------------------------------------------------------------
// volumeStep — ports V1Window.scrollWheel's `delta /= 1.5; Int(round(delta))`,
// plus a carried remainder V1 did not have (AppKit delivered much coarser
// scrollingDeltaY values than a DOM wheel event does).
//
// signed = inverted ? rawDeltaY : -rawDeltaY
// next   = accum + signed / 1.5
// step   = Math.round(next);  accum' = next - step
//
// Note the sign convention reads backwards from the Swift and is correct:
// AppKit's `scrollingDeltaY` and the DOM's `deltaY` have OPPOSITE signs, so
// Swift's `inverted ? -scrollingDeltaY : scrollingDeltaY` becomes
// `inverted ? deltaY : -deltaY` here.
// ---------------------------------------------------------------------------

test('volumeStep returns both a step and a carried accum', () => {
  const r = V3.volumeStep(3, true, 0);
  assert.ok(Object.prototype.hasOwnProperty.call(r, 'step'), 'result has no `step`');
  assert.ok(Object.prototype.hasOwnProperty.call(r, 'accum'), 'result has no `accum`');
});

test('volumeStep divides by 1.5, not by 1', () => {
  // 3 / 1.5 === 2, exactly. A missing divisor would give 3.
  const r = V3.volumeStep(3, true, 0);
  assert.equal(r.step, 2);
  assert.equal(r.accum, 0);
});

test('volumeStep divides by 1.5 for a larger delta too', () => {
  const r = V3.volumeStep(150, true, 0);
  assert.equal(r.step, 100);
  assert.equal(r.accum, 0);
});

test('volumeStep with inverted=true keeps the DOM deltaY sign (fingers away is louder)', () => {
  assert.equal(V3.volumeStep(1.5, true, 0).step, 1);
  assert.equal(V3.volumeStep(-1.5, true, 0).step, -1);
});

test('volumeStep with inverted=false flips the sign', () => {
  assert.equal(V3.volumeStep(1.5, false, 0).step, -1);
  assert.equal(V3.volumeStep(-1.5, false, 0).step, 1);
});

test('volumeStep: inverted flips the sign of the same delta, nothing else', () => {
  const on = V3.volumeStep(6, true, 0);
  const off = V3.volumeStep(6, false, 0);
  assert.equal(on.step, 4);
  assert.equal(off.step, -4);
});

test('volumeStep leaves an exactly-zero delta alone', () => {
  const on = V3.volumeStep(0, true, 0);
  assert.equal(on.step, 0);
  assert.equal(on.accum, 0);
  const off = V3.volumeStep(0, false, 0);
  assert.equal(off.step, 0);
  assert.equal(off.accum, 0);
});

test('volumeStep adds the incoming accum before rounding', () => {
  // 0.4 + 0.3/1.5 lands at 0.6 -> rounds up to 1, where 0.3/1.5 alone rounds to 0.
  const r = V3.volumeStep(0.3, true, 0.4);
  assert.equal(r.step, 1);
  assert.ok(Math.abs(r.accum - -0.4) < 1e-12, `accum was ${r.accum}, expected ~-0.4`);
});

test('volumeStep returns the exact fractional remainder, not a truncation', () => {
  // 2.25 / 1.5 === 1.5 exactly; Math.round(1.5) === 2, so the remainder is -0.5.
  const r = V3.volumeStep(2.25, true, 0);
  assert.equal(r.step, 2);
  assert.equal(r.accum, -0.5);
});

test('volumeStep rounds .5 up, matching Math.round and not Swift-style away-from-zero', () => {
  // Positive: 0.75 / 1.5 === 0.5 exactly. Math.round(0.5) === 1. Verified with
  // `node -e 'console.log(Math.round(0.5))'`.
  const r = V3.volumeStep(0.75, true, 0);
  assert.equal(r.step, 1);
  assert.equal(r.accum, -0.5);
});

test('volumeStep rounds -1.5 to -1, matching Math.round (Swift rounds it to -2)', () => {
  // -2.25 / 1.5 === -1.5 exactly. Verified: `node -e 'console.log(Math.round(-1.5))'`
  // prints -1, whereas Swift's `round(-1.5)` is -2. The contract says pin JS.
  const r = V3.volumeStep(-2.25, true, 0);
  assert.equal(r.step, -1);
  assert.equal(r.accum, -0.5);
});

test('volumeStep yields -0, not 0, when Math.round(-0.5) is the answer', () => {
  // 0.75 with inverted=false -> signed -0.75 -> next -0.5. Verified with
  // `node -e 'console.log(Object.is(Math.round(-0.5), -0))'` -> true.
  // node:assert/strict compares with Object.is, so `-0` is the required literal.
  const r = V3.volumeStep(0.75, false, 0);
  assert.ok(Object.is(r.step, -0), `step was ${r.step}, expected -0`);
  assert.equal(r.accum, -0.5);
});

test('volumeStep yields -0 for any small negative next, not just exactly -0.5', () => {
  // 0.6 with inverted=false -> next ~= -0.4. `node -e 'console.log(Object.is(Math.round(-0.4), -0))'`
  // prints true.
  const r = V3.volumeStep(0.6, false, 0);
  assert.ok(Object.is(r.step, -0), `step was ${r.step}, expected -0`);
  assert.ok(Math.abs(r.accum - -0.4) < 1e-12, `accum was ${r.accum}, expected ~-0.4`);
});

// The carried remainder is the whole point of the accum: V1's `Int(round(delta))`
// threw away everything under half a unit, which on a DOM wheel event means a
// slow trackpad drag never moves the volume at all. Feeding a sequence is the
// only way to see it — a single call cannot distinguish "carried" from "dropped".

test('volumeStep: a delta too small to round on its own still steps on the next event', () => {
  const first = V3.volumeStep(0.5, true, 0);
  assert.equal(first.step, 0, 'a single 0.5 delta must not move the volume yet');
  assert.ok(first.accum > 0, `the remainder must be carried, got accum ${first.accum}`);

  const second = V3.volumeStep(0.5, true, first.accum);
  assert.equal(second.step, 1, 'the carried remainder must produce a step on the second event');
});

// The sign of a ZERO step mid-sequence is float noise, not a rule: 0.5/1.5 is not
// representable, so the carried remainder lands a hair either side of 0 and
// Math.round hands back +0 or -0 accordingly. Normalise it away here (`-0 === 0`,
// so this map only flattens the sign) — the -0 contract is pinned above, on the
// single calls where it is genuinely the specified answer.
const unsignZero = (steps) => steps.map((s) => (s === 0 ? 0 : s));

test('volumeStep: six 0.5 deltas produce exactly the two steps the arithmetic owes', () => {
  // 6 * 0.5 = 3 raw; 3 / 1.5 = 2. Nothing may be lost to rounding along the way.
  const steps = [];
  let accum = 0;
  for (let i = 0; i < 6; i += 1) {
    const r = V3.volumeStep(0.5, true, accum);
    accum = r.accum;
    steps.push(r.step);
  }
  assert.deepEqual(unsignZero(steps), [0, 1, 0, 0, 1, 0]);
  assert.equal(steps.reduce((a, b) => a + b, 0), 2);
  assert.ok(Math.abs(accum) < 1e-12, `residual accum drifted to ${accum}`);
});

test('volumeStep: a very slow scroll accumulates instead of rounding away forever', () => {
  // 0.1 / 1.5 is ~0.0667 — it would round to 0 on every single event without a
  // carry. Seven events still owe nothing; the eighth crosses 0.5 and steps.
  let accum = 0;
  let total = 0;
  for (let i = 0; i < 7; i += 1) {
    const r = V3.volumeStep(0.1, true, accum);
    accum = r.accum;
    total += r.step;
  }
  assert.equal(total, 0, 'seven 0.1 deltas have not yet earned a step');

  const eighth = V3.volumeStep(0.1, true, accum);
  assert.equal(eighth.step, 1, 'the eighth 0.1 delta must finally step');
});

test('volumeStep: three 1.0 deltas produce two steps, matching 3 / 1.5', () => {
  const steps = [];
  let accum = 0;
  for (let i = 0; i < 3; i += 1) {
    const r = V3.volumeStep(1, true, accum);
    accum = r.accum;
    steps.push(r.step);
  }
  assert.deepEqual(unsignZero(steps), [1, 0, 1]);
});

test('volumeStep: a NaN delta is inert and resets the accum', () => {
  const r = V3.volumeStep(NaN, true, 0.4);
  assert.equal(r.step, 0);
  assert.equal(r.accum, 0);
});

test('volumeStep: an infinite delta is inert and resets the accum', () => {
  const up = V3.volumeStep(Infinity, true, 0.4);
  assert.equal(up.step, 0);
  assert.equal(up.accum, 0);
  const down = V3.volumeStep(-Infinity, true, 0.4);
  assert.equal(down.step, 0);
  assert.equal(down.accum, 0);
});

test('volumeStep: a NaN accum is inert, so a poisoned accum cannot wedge the widget', () => {
  const r = V3.volumeStep(3, true, NaN);
  assert.equal(r.step, 0);
  assert.equal(r.accum, 0);
});

test('volumeStep: an infinite accum is inert', () => {
  const r = V3.volumeStep(3, true, Infinity);
  assert.equal(r.step, 0);
  assert.equal(r.accum, 0);
});

// ---------------------------------------------------------------------------
// clampVolume — ports ThemeController.userDidChangeVolumeWithDelta's
// `if newVolume > 100 { 100 } else if newVolume < 0 { 0 }`, with the rounding
// the Swift got for free from `Int`.
// ---------------------------------------------------------------------------

test('clampVolume passes an in-range integer straight through', () => {
  assert.equal(V3.clampVolume(50), 50);
  assert.equal(V3.clampVolume(1), 1);
  assert.equal(V3.clampVolume(99), 99);
});

test('clampVolume keeps both endpoints of the legal range', () => {
  assert.equal(V3.clampVolume(0), 0);
  assert.equal(V3.clampVolume(100), 100);
});

test('clampVolume clamps above 100', () => {
  assert.equal(V3.clampVolume(101), 100);
  assert.equal(V3.clampVolume(1000), 100);
});

test('clampVolume clamps below 0', () => {
  assert.equal(V3.clampVolume(-1), 0);
  assert.equal(V3.clampVolume(-1000), 0);
});

test('clampVolume clamps the value that rounds past 100', () => {
  // Math.round(100.5) === 101, which must then be clamped back down.
  assert.equal(V3.clampVolume(100.5), 100);
  assert.equal(V3.clampVolume(100.4), 100);
});

test('clampVolume rounds rather than truncates', () => {
  assert.equal(V3.clampVolume(49.5), 50);
  assert.equal(V3.clampVolume(49.4), 49);
  assert.equal(V3.clampVolume(0.5), 1);
  assert.equal(V3.clampVolume(0.4), 0);
});

test('clampVolume never returns -0, even where Math.round would', () => {
  // Math.round(-0.4) is -0; Math.max(0, -0) is +0. Verified with
  // `node -e 'console.log(Object.is(Math.max(0, -0), 0))'` -> true.
  // node:assert/strict would fail a -0 against 0, which is exactly the point.
  assert.ok(Object.is(V3.clampVolume(-0.4), 0), 'clampVolume(-0.4) leaked a -0');
  assert.ok(Object.is(V3.clampVolume(-0.5), 0), 'clampVolume(-0.5) leaked a -0');
});

test('clampVolume returns an integer for any fractional input', () => {
  for (const v of [0.1, 12.7, 49.5, 87.31, 99.9]) {
    assert.equal(Number.isInteger(V3.clampVolume(v)), true, `clampVolume(${v}) was not an integer`);
  }
});

test('clampVolume treats NaN as 0', () => {
  assert.equal(V3.clampVolume(NaN), 0);
});

test('clampVolume treats the infinities as 0, it does not saturate them', () => {
  assert.equal(V3.clampVolume(Infinity), 0);
  assert.equal(V3.clampVolume(-Infinity), 0);
});

test('clampVolume treats a missing volume as 0', () => {
  assert.equal(V3.clampVolume(undefined), 0);
  assert.equal(V3.clampVolume(null), 0);
});

// ---------------------------------------------------------------------------
// repeatSymbol / repeatIsOn — host repeat modes are 1 = all, 2 = one, 3 = off,
// matching NepTunes 3's `MusicRepeatMode(rawValue:)`.
//
// symbolNameForRepeatMode was `case .one: "repeat.1"; default: "repeat"`.
// ---------------------------------------------------------------------------

test('repeatSymbol: mode 2 (one) is the only mode that gets repeat.1', () => {
  assert.equal(V3.repeatSymbol(2), 'repeat.1');
});

test('repeatSymbol: mode 1 (all) is the plain repeat glyph', () => {
  assert.equal(V3.repeatSymbol(1), 'repeat');
});

test('repeatSymbol: mode 3 (off) is the plain repeat glyph', () => {
  assert.equal(V3.repeatSymbol(3), 'repeat');
});

test('repeatSymbol: an unknown mode falls back to the plain repeat glyph', () => {
  assert.equal(V3.repeatSymbol(0), 'repeat');
  assert.equal(V3.repeatSymbol(4), 'repeat');
});

test('repeatSymbol: a missing mode falls back to the plain repeat glyph', () => {
  assert.equal(V3.repeatSymbol(undefined), 'repeat');
  assert.equal(V3.repeatSymbol(null), 'repeat');
  assert.equal(V3.repeatSymbol(NaN), 'repeat');
});

test('repeatSymbol matches the mode strictly, so "2" is not repeat.1', () => {
  assert.equal(V3.repeatSymbol('2'), 'repeat');
});

test('repeatIsOn: mode 1 (all) is on', () => {
  assert.equal(V3.repeatIsOn(1), true);
});

test('repeatIsOn: mode 2 (one) is on', () => {
  assert.equal(V3.repeatIsOn(2), true);
});

test('repeatIsOn: mode 3 (off) is off', () => {
  assert.equal(V3.repeatIsOn(3), false);
});

// V1's test was `app.state?.repeatMode != .off`, and in Swift a nil optional is
// `!= .off`, so no-state read as ON and lit the glyph. That is a bug, not a
// behaviour worth porting; the contract specifies `mode === 1 || mode === 2`.
test('repeatIsOn: a missing mode is off, not on', () => {
  assert.equal(V3.repeatIsOn(undefined), false);
  assert.equal(V3.repeatIsOn(null), false);
});

test('repeatIsOn: an unknown mode is off', () => {
  assert.equal(V3.repeatIsOn(0), false);
  assert.equal(V3.repeatIsOn(4), false);
  assert.equal(V3.repeatIsOn(NaN), false);
});

test('repeatIsOn matches the mode strictly, so "1" is not on', () => {
  assert.equal(V3.repeatIsOn('1'), false);
});

test('repeatIsOn returns a boolean, not a truthy value', () => {
  assert.equal(typeof V3.repeatIsOn(1), 'boolean');
  assert.equal(typeof V3.repeatIsOn(3), 'boolean');
  assert.equal(typeof V3.repeatIsOn(undefined), 'boolean');
});

// ---------------------------------------------------------------------------
// wheelAxis — ports `if abs(event.scrollingDeltaX) <= abs(event.scrollingDeltaY)`.
// The `<=` matters: a perfectly diagonal gesture is VOLUME, not a track swipe.
// ---------------------------------------------------------------------------

test('wheelAxis: a pure vertical wheel is vertical', () => {
  assert.equal(V3.wheelAxis(0, 5), 'vertical');
  assert.equal(V3.wheelAxis(0, -5), 'vertical');
});

test('wheelAxis: a pure horizontal wheel is horizontal', () => {
  assert.equal(V3.wheelAxis(5, 0), 'horizontal');
  assert.equal(V3.wheelAxis(-5, 0), 'horizontal');
});

test('wheelAxis: an exact diagonal ties to vertical, matching Swift <=', () => {
  assert.equal(V3.wheelAxis(5, 5), 'vertical');
  assert.equal(V3.wheelAxis(-5, 5), 'vertical');
  assert.equal(V3.wheelAxis(5, -5), 'vertical');
  assert.equal(V3.wheelAxis(-5, -5), 'vertical');
});

test('wheelAxis: vertical-dominant is vertical whatever the signs', () => {
  assert.equal(V3.wheelAxis(4, 5), 'vertical');
  assert.equal(V3.wheelAxis(-4, 5), 'vertical');
  assert.equal(V3.wheelAxis(4, -5), 'vertical');
  assert.equal(V3.wheelAxis(-4, -5), 'vertical');
});

test('wheelAxis: horizontal-dominant is horizontal whatever the signs', () => {
  assert.equal(V3.wheelAxis(6, 5), 'horizontal');
  assert.equal(V3.wheelAxis(-6, 5), 'horizontal');
  assert.equal(V3.wheelAxis(6, -5), 'horizontal');
  assert.equal(V3.wheelAxis(-6, -5), 'horizontal');
});

test('wheelAxis: one unit of difference is enough to flip to horizontal', () => {
  assert.equal(V3.wheelAxis(5.0001, 5), 'horizontal');
});

// A 0,0 wheel event is real — it arrives at the end of a momentum stream. It
// must not be read as a horizontal swipe, or every scroll ends in a track skip.
test('wheelAxis: a 0,0 event is vertical, never a swipe', () => {
  assert.equal(V3.wheelAxis(0, 0), 'vertical');
});

test('wheelAxis: a non-finite deltaX counts as 0', () => {
  assert.equal(V3.wheelAxis(NaN, 5), 'vertical');
  assert.equal(V3.wheelAxis(Infinity, 5), 'vertical');
  assert.equal(V3.wheelAxis(-Infinity, 5), 'vertical');
});

test('wheelAxis: a non-finite deltaY counts as 0, so a real deltaX wins', () => {
  assert.equal(V3.wheelAxis(5, NaN), 'horizontal');
  assert.equal(V3.wheelAxis(5, Infinity), 'horizontal');
});

test('wheelAxis: both non-finite degenerates to the 0,0 case', () => {
  assert.equal(V3.wheelAxis(NaN, NaN), 'vertical');
  assert.equal(V3.wheelAxis(undefined, undefined), 'vertical');
  assert.equal(V3.wheelAxis(null, null), 'vertical');
});

// ---------------------------------------------------------------------------
// swipeDecision — replaces NSEvent.trackSwipeEvent's ±1 dampened threshold.
// V1 fired `next` for `amount > 0`; the accumulated DOM deltaX keeps the same
// convention, so fingers-left (positive deltaX) is next.
// ---------------------------------------------------------------------------

test('swipeDecision: past the positive threshold is next', () => {
  assert.equal(V3.swipeDecision(60, 50), 'next');
});

test('swipeDecision: past the negative threshold is previous', () => {
  assert.equal(V3.swipeDecision(-60, 50), 'previous');
});

test('swipeDecision: exactly at the positive threshold fires', () => {
  assert.equal(V3.swipeDecision(50, 50), 'next');
});

test('swipeDecision: exactly at the negative threshold fires', () => {
  assert.equal(V3.swipeDecision(-50, 50), 'previous');
});

test('swipeDecision: one unit short of the threshold does not fire', () => {
  assert.equal(V3.swipeDecision(49.9999, 50), null);
  assert.equal(V3.swipeDecision(-49.9999, 50), null);
});

test('swipeDecision: a resting accumulator does not fire', () => {
  assert.equal(V3.swipeDecision(0, 50), null);
});

test('swipeDecision: a small drift in either direction does not fire', () => {
  assert.equal(V3.swipeDecision(3, 50), null);
  assert.equal(V3.swipeDecision(-3, 50), null);
});

test('swipeDecision honours the threshold it is handed, not a baked-in one', () => {
  assert.equal(V3.swipeDecision(5, 4), 'next');
  assert.equal(V3.swipeDecision(5, 6), null);
});

// Degenerate but reachable if a threshold setting ever lands at 0: both
// comparisons are true at once, and the contract lists `next` first.
test('swipeDecision: a 0 accumulator against a 0 threshold resolves to next', () => {
  assert.equal(V3.swipeDecision(0, 0), 'next');
});

test('swipeDecision: a non-finite accumulator never fires', () => {
  assert.equal(V3.swipeDecision(NaN, 50), null);
  assert.equal(V3.swipeDecision(Infinity, 50), null);
  assert.equal(V3.swipeDecision(-Infinity, 50), null);
});

// Deliberately NOT pinned: what a non-finite *threshold* does. The contract's
// "Non-finite -> null" sits in a sentence whose subject is accumX, and where it
// means both parameters it says so (compare volumeStep: "Non-finite `rawDeltaY`
// or `accum`"). Two readings are defensible — abort to null, or fall back to the
// module's own default threshold — and the caller always passes a finite constant,
// so the branch is unreachable in the shipped widget. Settle it in the contract
// before pinning it here.

test('swipeDecision returns null, not undefined, when nothing fires', () => {
  assert.equal(V3.swipeDecision(0, 50), null);
  assert.notEqual(V3.swipeDecision(0, 50), undefined);
});

// ---------------------------------------------------------------------------
// infoBarState — ports ArtworkView's
// `.frame(maxHeight: showFullInfo ? .infinity : (simpleMode ? 0 : 28))`.
// `hideLabel` is V1's `simpleMode`; `revealing` is its `showFullInfo`.
// ---------------------------------------------------------------------------

test('infoBarState: the default is the 28px bar', () => {
  assert.equal(V3.infoBarState(false, false), 'bar');
});

test('infoBarState: hideLabel alone collapses the bar to nothing', () => {
  assert.equal(V3.infoBarState(true, false), 'hidden');
});

test('infoBarState: a reveal grows the bar to full', () => {
  assert.equal(V3.infoBarState(false, true), 'full');
});

// The nested ternary put showFullInfo outermost, so the reveal overrode
// simpleMode entirely — a track change shows the title even with labels hidden.
test('infoBarState: a reveal beats hideLabel', () => {
  assert.equal(V3.infoBarState(true, true), 'full');
});

test('infoBarState: undefined settings read as the plain bar', () => {
  assert.equal(V3.infoBarState(undefined, undefined), 'bar');
});

test('infoBarState: null settings read as the plain bar', () => {
  assert.equal(V3.infoBarState(null, null), 'bar');
});

test('infoBarState: an undefined revealing flag does not swallow hideLabel', () => {
  assert.equal(V3.infoBarState(true, undefined), 'hidden');
});

test('infoBarState: a reveal with an undefined hideLabel is still full', () => {
  assert.equal(V3.infoBarState(undefined, true), 'full');
});

test('infoBarState returns only the three contract states', () => {
  const seen = new Set();
  for (const hide of [true, false]) {
    for (const reveal of [true, false]) {
      seen.add(V3.infoBarState(hide, reveal));
    }
  }
  assert.deepEqual([...seen].sort(), ['bar', 'full', 'hidden']);
});
