import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Vinyl = require('../Vinyl.nepget/script.js');

const manifest = JSON.parse(readFileSync(new URL('../Vinyl.nepget/manifest.json', import.meta.url)));
const spinRpm = manifest.settings.schema.find((s) => s.id === 'spinRpm');

// The point of the picker is that the label the user reads ("33⅓ RPM") is the speed
// the record actually turns at. These pin that: period_ms = 60000 / rpm, so a wrong
// table entry is a failing test rather than a record that quietly lies about itself.
const EXPECTED_MS = { 16: 3750, 33: 1800, 45: 1333, 78: 769 };

test('every offered RPM turns the record at that RPM', () => {
    for (const option of spinRpm.options) {
        const ms = Vinyl.spinDurationFor({ spinRpm: option.value });
        const rpm = 60000 / ms;
        assert.ok(
            Math.abs(rpm - Number(option.value === '33' ? 33.3333 : option.value)) < 0.1,
            `${option.label} spins at ${rpm.toFixed(2)} RPM (${ms} ms/rev)`
        );
    }
});

test('the table is exactly the rounded real periods', () => {
    for (const [rpm, ms] of Object.entries(EXPECTED_MS)) {
        assert.equal(Vinyl.spinDurationFor({ spinRpm: String(rpm) }), ms);
    }
});

test('33⅓ is the default, and is what an absent or unknown setting falls back to', () => {
    assert.equal(spinRpm.default, '33');
    assert.equal(Vinyl.spinDurationFor({}), 1800);
    assert.equal(Vinyl.spinDurationFor({ spinRpm: '' }), 1800);
    assert.equal(Vinyl.spinDurationFor({ spinRpm: 'nonsense' }), 1800);
    assert.equal(Vinyl.spinDurationFor(null), 1800);
});

test('the host sends the option value as a string, but a number must not break it', () => {
    // WidgetSettingValue round-trips whatever is on disk; a hand-edited settings.json
    // holding 45 rather than "45" should still give 45 RPM, not silently reset to 33⅓.
    assert.equal(Vinyl.spinDurationFor({ spinRpm: 45 }), 1333);
});

test('the picker offers only real turntable speeds, 33⅓ among them', () => {
    assert.deepEqual(spinRpm.options.map((o) => o.value), ['16', '33', '45', '78']);
    assert.equal(spinRpm.type, 'select');
    assert.ok(spinRpm.options.some((o) => o.label.includes('33⅓')));
});

// transportHidden HIDES prev/next during a live stream, rather than greying them like the
// ad path does. The bridge already refuses the action centrally (WidgetTransportGuard);
// this only keeps the row from offering a button that can only mislead.
test('transportHidden is true for a live stream', () => {
    assert.equal(Vinyl.transportHidden({ title: 'Morning Show', artist: 'Radio One', isLiveStream: true }), true);
});

test('transportHidden is false for an ordinary track', () => {
    assert.equal(Vinyl.transportHidden({ title: 'Time', artist: 'Pink Floyd' }), false);
});

// isLiveStream is omitted entirely (not `false`) for an ordinary track — only ever sent
// when true — so a missing value here must not read as live.
test('transportHidden treats a missing isLiveStream as not hidden', () => {
    assert.equal(Vinyl.transportHidden({ title: 'Time', artist: 'Pink Floyd', isLiveStream: undefined }), false);
});

test('transportHidden is false with nothing playing', () => {
    assert.equal(Vinyl.transportHidden(undefined), false);
    assert.equal(Vinyl.transportHidden(null), false);
});

// transportGlyph — which of the three play-button glyphs applies.
// playerState: 1 = stopped, 2 = playing, 3 = paused.
test('transportGlyph is play whenever playerState is not 2, live or not', () => {
    assert.equal(Vinyl.transportGlyph(1, false), 'play');
    assert.equal(Vinyl.transportGlyph(3, false), 'play');
    assert.equal(Vinyl.transportGlyph(1, true), 'play');
    assert.equal(Vinyl.transportGlyph(3, true), 'play');
    assert.equal(Vinyl.transportGlyph(undefined, false), 'play');
});

test('transportGlyph is pause while playing an ordinary track', () => {
    assert.equal(Vinyl.transportGlyph(2, false), 'pause');
});

test('transportGlyph is stop while playing a live stream — resuming restarts it, it does not resume', () => {
    assert.equal(Vinyl.transportGlyph(2, true), 'stop');
});

// liveBadgeVisible — LIVE is transport state, so it must never show without the
// controls it lives inside, regardless of whether the stream itself is live.
test('liveBadgeVisible is false whenever controlsPosition is off, live or not', () => {
    assert.equal(Vinyl.liveBadgeVisible('off', true), false);
    assert.equal(Vinyl.liveBadgeVisible('off', false), false);
});

test('liveBadgeVisible is false with controls shown but not a live stream', () => {
    assert.equal(Vinyl.liveBadgeVisible('left', false), false);
    assert.equal(Vinyl.liveBadgeVisible('right', false), false);
    assert.equal(Vinyl.liveBadgeVisible('bottom', false), false);
});

test('liveBadgeVisible is true only with controls shown AND a live stream', () => {
    assert.equal(Vinyl.liveBadgeVisible('left', true), true);
    assert.equal(Vinyl.liveBadgeVisible('right', true), true);
    assert.equal(Vinyl.liveBadgeVisible('bottom', true), true);
});
