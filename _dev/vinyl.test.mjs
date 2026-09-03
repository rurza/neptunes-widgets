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

// ---------------------------------------------------------------------------------------
// Size. The window is not the record: it is the record, plus a fixed 48px shadow gutter,
// plus whichever side panels are switched on. `windowSizeFor` is that conversion, and
// `discSizeFor` is the picker's half of it. Both directions are pinned here because the
// picker is the only thing that moves the size — a wrong number is a record the user asked
// for and did not get, or a window the panels no longer fit inside.

const html = readFileSync(new URL('../Vinyl.nepget/index.html', import.meta.url), 'utf8');
const POSITIONS = ['off', 'left', 'right', 'bottom'];

// Every (labelPosition, controlsPosition) pair the two pickers can produce — 16 of them.
function everyLayout() {
    const layouts = [];
    for (const label of POSITIONS) {
        for (const controls of POSITIONS) layouts.push([label, controls]);
    }
    return layouts;
}

test('a bare record is the disc plus its shadow gutter, both axes', () => {
    assert.deepEqual(Vinyl.windowSizeFor(136, 'off', 'off'), { width: 232, height: 232 });
});

test('each panel adds its own width, and only on the side it is on', () => {
    const bare = Vinyl.windowSizeFor(136, 'off', 'off');

    // Track info is 160 wide, controls 84, each with a 12px gap to the disc.
    assert.equal(Vinyl.windowSizeFor(136, 'left', 'off').width, bare.width + 172);
    assert.equal(Vinyl.windowSizeFor(136, 'off', 'right').width, bare.width + 96);

    // Stacked on one side they share it: the wider of the two sets the column.
    assert.equal(Vinyl.windowSizeFor(136, 'left', 'left').width, bare.width + 172);
    // Opposite sides each pay their own way.
    assert.equal(Vinyl.windowSizeFor(136, 'left', 'right').width, bare.width + 172 + 96);

    // A side panel never changes the height, and the bottom row never the width.
    assert.equal(Vinyl.windowSizeFor(136, 'left', 'right').height, bare.height);
    assert.equal(Vinyl.windowSizeFor(136, 'bottom', 'off').width, bare.width);
    assert.equal(Vinyl.windowSizeFor(136, 'bottom', 'bottom').height, bare.height + 52);
});

test('the gutter is fixed, so growing the disc grows the window 1:1', () => {
    // The drop shadow's blur does not scale with the record, so the padding must not either
    // — a gutter that grew with the disc would leave a fat transparent margin at the large
    // end and clip the shadow at the small end.
    for (const [label, controls] of everyLayout()) {
        const small = Vinyl.windowSizeFor(100, label, controls);
        const large = Vinyl.windowSizeFor(300, label, controls);
        assert.equal(large.width - small.width, 200, `${label}/${controls} width`);
        assert.equal(large.height - small.height, 200, `${label}/${controls} height`);
    }
});

test('every size the picker offers is a size the widget actually draws', () => {
    // The same contract as the RPM table above: the label a user reads has to be the thing
    // they get. An option with no entry in DISC_SIZES would silently fall back to the
    // default, so the picker would offer five sizes and hand out one.
    const picker = manifest.settings.schema.find((s) => s.id === 'discSize');
    const seen = new Set();
    for (const option of picker.options) {
        const disc = Vinyl.discSizeFor({ discSize: option.value });
        assert.equal(String(disc), option.value,
            `"${option.label}" (${option.value}) resolves to ${disc}`);
        assert.ok(!seen.has(disc), `two options both give ${disc}px`);
        seen.add(disc);
    }
});

test('the picker default is the size Vinyl has always been', () => {
    const picker = manifest.settings.schema.find((s) => s.id === 'discSize');
    assert.equal(picker.default, '136');
    assert.deepEqual(
        Vinyl.windowSizeFor(Vinyl.discSizeFor({ discSize: picker.default }), 'off', 'off'),
        { width: manifest.defaultSize.width, height: manifest.defaultSize.height }
    );
});

test('anything the table does not know falls back rather than collapsing', () => {
    // A hand-edited settings.json, a value left over from an older picker, no value at all.
    // None of them may produce a zero-width record or a NaN window.
    for (const bad of [{}, null, undefined, { discSize: '' }, { discSize: 'huge' },
                       { discSize: '0' }, { discSize: '-40' }]) {
        assert.equal(Vinyl.discSizeFor(bad), 136, `${JSON.stringify(bad)}`);
    }
});

test('the declared bounds admit every size in every layout', () => {
    // The trap: the window bounds are declared once, but the window size depends on which
    // panels are on. Bounds sized for the bare record silently cap the biggest size the
    // moment a user switches the track info on — the picker still offers it, the window
    // just stops growing. WidgetJSBridge resolves every setSize against these.
    const { minSize, maxSize } = manifest;
    assert.ok(maxSize, 'without maxSize the only ceiling is the display');

    const picker = manifest.settings.schema.find((s) => s.id === 'discSize');
    const offered = picker.options.map((o) => Vinyl.discSizeFor({ discSize: o.value }));

    const smallest = Vinyl.windowSizeFor(Math.min(...offered), 'off', 'off');
    assert.ok(minSize.width <= smallest.width && minSize.height <= smallest.height,
        `minSize ${minSize.width}x${minSize.height} floors Small (${smallest.width}x${smallest.height})`);

    for (const [label, controls] of everyLayout()) {
        const largest = Vinyl.windowSizeFor(Math.max(...offered), label, controls);
        assert.ok(maxSize.width >= largest.width,
            `maxSize.width ${maxSize.width} caps ${label}/${controls} at ${largest.width}`);
        assert.ok(maxSize.height >= largest.height,
            `maxSize.height ${maxSize.height} caps ${label}/${controls} at ${largest.height}`);
    }
});

test('the size is a setting, so the window is not draggable-resizable', () => {
    // A bundle shipping a drag handle while declaring resizable:false draws a grab target
    // that cannot move the window — the contradiction WidgetResizableTests guards. Vinyl
    // resizes through its picker only, and "resizable": true was what made dragging the
    // window add empty gutter without ever growing the record.
    assert.equal(manifest.resizable, false);
    assert.ok(!html.includes('resize-handle'), 'ships a resize handle it cannot honour');
});
