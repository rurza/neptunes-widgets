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

// isLiveStream drives the LIVE corner badge and the stop-glyph/hidden-transport treatment
// for an Apple Music radio stream. Sent truthily only (omitted entirely for an ordinary
// track), mirroring isAdvertisement.
test('isLiveStream is true for a live radio stream', () => {
    assert.equal(Vinyl.isLiveStream({ title: 'brand new chanel$', artist: 'Slayyyter', isLiveStream: true }), true);
});

test('isLiveStream is false for an ordinary track', () => {
    assert.equal(Vinyl.isLiveStream({ title: 'Time', artist: 'Pink Floyd' }), false);
});

test('isLiveStream treats a missing value as not live', () => {
    assert.equal(Vinyl.isLiveStream({ title: 'Time', artist: 'Pink Floyd', isLiveStream: undefined }), false);
});

test('isLiveStream is false with nothing playing', () => {
    assert.equal(Vinyl.isLiveStream(undefined), false);
    assert.equal(Vinyl.isLiveStream(null), false);
});
