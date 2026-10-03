import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

process.env.TZ = 'Europe/Warsaw';

const require = createRequire(import.meta.url);
globalThis.NTKit = require('../ListeningClock.nepget/neptunes-kit.js');
globalThis.NTHistory = require('../ListeningClock.nepget/history-stats.js');
const Clock = require('../ListeningClock.nepget/script.js');

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const NOW = at(2026, 10, 2, 12);
const hours = (pairs) => pairs.map(([hour, plays, seconds = plays * 200]) => ({ hour, plays, seconds }));
const zeros = () => Array(24).fill(0);

// ---- Hour buckets ---------------------------------------------------------------

test('no rows is 24 silent hours', () => {
  const b = Clock.hourBuckets([]);
  assert.deepEqual(b.plays, zeros());
  assert.deepEqual(b.seconds, zeros());
  assert.equal(Clock.totalPlays(b), 0);
  assert.deepEqual(Clock.hourBuckets(undefined).plays, zeros());
});

test('sparse rows land in their hours and every missing hour is zero', () => {
  const b = Clock.hourBuckets(hours([[0, 2], [13, 5], [23, 1]]));
  assert.equal(b.plays[0], 2);
  assert.equal(b.plays[13], 5);
  assert.equal(b.plays[23], 1);
  assert.equal(b.plays.filter((n) => n > 0).length, 3);
  assert.equal(b.seconds[13], 1000);
  assert.equal(Clock.totalPlays(b), 8);
});

test('rows outside 0…23, without an hour, or with junk counts are ignored or read as zero', () => {
  const b = Clock.hourBuckets([{ hour: 24, plays: 9 }, { hour: -1, plays: 9 }, { hour: 1.5, plays: 9 },
    { plays: 9 }, null, { hour: 4, plays: 'x', seconds: -5 }, { hour: 4, plays: 3, seconds: 60 }]);
  assert.equal(Clock.totalPlays(b), 3);
  assert.equal(b.seconds[4], 60);
});

test('a repeated hour adds up rather than overwriting', () => {
  assert.equal(Clock.hourBuckets(hours([[7, 2], [7, 3]])).plays[7], 5);
});

// ---- Bars -------------------------------------------------------------------------

test('a silent hour has no bar; the busiest reaches the outer edge', () => {
  const plays = zeros(); plays[21] = 10; plays[9] = 5;
  assert.equal(Clock.barShare(plays, 3), 0);
  assert.equal(Clock.barShare(plays, 21), 1);
  assert.ok(Math.abs(Clock.barShare(plays, 9) - (8 / 45 + (37 / 45) * 0.5)) < 1e-12);
});

test('a single play beside a busy hour keeps the minimum bar, so it stays visible', () => {
  const plays = zeros(); plays[2] = 1; plays[20] = 1000;
  assert.ok(Clock.barShare(plays, 2) > 8 / 45);
  assert.ok(Clock.barShare(plays, 2) < 8 / 45 + 0.001);
});

test('a single listening hour is a full bar and the only one', () => {
  const plays = zeros(); plays[17] = 4;
  assert.deepEqual(plays.map((_, h) => Clock.barShare(plays, h) > 0 ? h : null).filter((h) => h !== null), [17]);
  assert.equal(Clock.barShare(plays, 17), 1);
});

test('every hour equal is every bar full', () => {
  const plays = Array(24).fill(3);
  assert.ok(plays.every((_, h) => Clock.barShare(plays, h) === 1));
});

test('the peak is the busiest hour, the earliest of a tie, and -1 for silence', () => {
  const plays = zeros(); plays[8] = 6; plays[22] = 6; plays[15] = 2;
  assert.equal(Clock.peakHour(plays), 8);
  assert.equal(Clock.peakHour(zeros()), -1);
});

test('day runs from 6:00 up to 18:00', () => {
  assert.deepEqual([5, 6, 17, 18].map(Clock.isDaytime), [false, true, true, false]);
});

// ---- Geometry ---------------------------------------------------------------------

test('the clock\'s proportions: inner 35/80, disc 30/80, marks 95/80, minimum bar 8/45, 2° gaps', () => {
  assert.equal(Clock.INNER_RATIO, 35 / 80);
  assert.equal(Clock.CENTER_RATIO, 30 / 80);
  assert.equal(Clock.LABEL_RATIO, 95 / 80);
  assert.equal(Clock.MIN_BAR_SHARE, 8 / 45);
  assert.equal(Clock.GAP_DEGREES, 2);
  assert.deepEqual(Clock.LABEL_HOURS, [0, 6, 12, 18]);
});

test('midnight starts at the top and the hours run clockwise, a degree short of each boundary', () => {
  assert.deepEqual(Clock.segmentAngles(0), { start: -89, end: -76 });
  assert.deepEqual(Clock.segmentAngles(6), { start: 1, end: 14 });
  assert.deepEqual(Clock.segmentAngles(23), { start: 256, end: 269 });
  assert.equal(Clock.labelAngle(0), -90);
  assert.equal(Clock.labelAngle(6), 0);
  assert.equal(Clock.labelAngle(12), 90);
});

test('a segment is an annulus slice: out along the start edge, round, back in, round home', () => {
  assert.equal(Clock.segmentPath(100, 100, 35, 80, 0),
    'M100.61,65.01L101.4,20.01A80,80 0 0 1 119.35,22.38L108.47,66.04A35,35 0 0 0 100.61,65.01Z');
  assert.equal(Clock.segmentPath(100, 100, 35, 80, 6),
    'M134.99,100.61L179.99,101.4A80,80 0 0 1 177.62,119.35L133.96,108.47A35,35 0 0 0 134.99,100.61Z');
});

const L = { cx: 100, cy: 100, center: 30, labelRadius: 95 };

test('the hour under the pointer goes by angle: top, right, bottom, left', () => {
  assert.equal(Clock.hourAt(L, 101, 40), 0);
  assert.equal(Clock.hourAt(L, 160, 101), 6);
  assert.equal(Clock.hourAt(L, 99, 160), 12);
  assert.equal(Clock.hourAt(L, 40, 99), 18);
  assert.equal(Clock.hourAt(L, 99, 40), 23, 'just left of midnight is the last hour');
});

test('a gap between two hours is split between them', () => {
  const at = (degrees) => {
    const a = (degrees - 90) * Math.PI / 180;
    return Clock.hourAt(L, 100 + 60 * Math.cos(a), 100 + 60 * Math.sin(a));
  };
  assert.equal(at(14.6), 0);
  assert.equal(at(15.4), 1);
});

test('nothing is hovered over the centre disc, beyond the marks, or for a bad point', () => {
  assert.equal(Clock.hourAt(L, 100, 80), null);
  assert.equal(Clock.hourAt(L, 100, 4), null);
  assert.equal(Clock.hourAt(L, NaN, 50), null);
  assert.equal(Clock.hourAt(L, 100, 70), 0, 'the bars start at 35/80 but the gap above the disc already counts');
});

test('the default window: a 200pt card at the 20/16 gutter, a 69pt ring with three centre lines', () => {
  const l = Clock.layout(240, 240, 'card');
  assert.deepEqual(l.card, { x: 20, y: 16, side: 200 });
  assert.equal(l.cx, 120);
  assert.equal(l.cy, 116);
  assert.equal(l.outer, 69);
  assert.equal(l.inner, 69 * 35 / 80);
  assert.equal(l.center, 69 * 30 / 80);
  assert.equal(l.labelRadius, 69 * 95 / 80);
  assert.equal(l.labelSize, 12);
  assert.deepEqual(l.centerBox, { w: 51, h: 39 });
  assert.equal(l.centerLineCount, 3);
  assert.equal(l.captionWidth, 78);
});

test('the smallest window keeps two centre lines; the largest grows everything', () => {
  const small = Clock.layout(200, 200, 'card');
  assert.deepEqual(small.card, { x: 20, y: 16, side: 160 });
  assert.equal(small.outer, 55);
  assert.equal(small.centerLineCount, 2);
  assert.deepEqual(small.centerBox, { w: 41, h: 31 });
  const large = Clock.layout(480, 480, 'card');
  assert.equal(large.outer, 160);
  assert.equal(large.centerFont, 22);
});

test('the bare clock needs no shadow gutter and no card padding', () => {
  const l = Clock.layout(240, 240, 'none');
  assert.deepEqual(l.card, { x: 6, y: 6, side: 228 });
  assert.equal(l.outer, 89);
});

test('a window stretched off square still draws a round clock, centred', () => {
  const l = Clock.layout(300, 240, 'card');
  assert.deepEqual(l.card, { x: 50, y: 16, side: 200 });
  assert.equal(l.cx, 150);
});

test('the marks and their labels stay inside the card at every size', () => {
  for (const side of [200, 240, 320, 480]) {
    const l = Clock.layout(side, side, 'card');
    assert.ok(l.labelRadius + l.labelSize * 0.6 <= l.card.side / 2, `${side}pt`);
  }
});

// ---- Centre -----------------------------------------------------------------------

const BUCKETS = Clock.hourBuckets(hours([[9, 3, 600], [21, 12, 2 * 3600 + 15 * 60], [22, 1, 200]]));

test('idle, the centre names the peak hour and its plays', () => {
  assert.deepEqual(Clock.centerLines(BUCKETS, -1, 3, 'en', 'en-GB'), [
    { text: 'Peak', strong: false }, { text: '21:00', strong: true, compact: '21' }, { text: '12 plays', strong: false, compact: '12' },
  ]);
});

test('over an hour, the centre shows that hour, its plays and its listening time', () => {
  assert.deepEqual(Clock.centerLines(BUCKETS, 21, 3, 'en', 'en-US').map((l) => l.text).slice(1), ['12 plays', '2 hr 15 min']);
  assert.deepEqual(Clock.centerLines(BUCKETS, 3, 3, 'en', 'en-US').map((l) => l.text).slice(1), ['0 plays', '0 min'], 'a silent hour says so');
});

test('with room for two lines the last one is left out', () => {
  assert.equal(Clock.centerLines(BUCKETS, 21, 2, 'en', 'en-GB').length, 2);
  assert.equal(Clock.centerLines(BUCKETS, -1, 2, 'en', 'en-GB')[1].text, '21:00');
});

test('the clock\'s own words exist in every app language', () => {
  assert.deepEqual(Object.keys(Clock.STRINGS).sort(), [...NTHistory.LANGUAGES].sort());
  for (const [lang, s] of Object.entries(Clock.STRINGS)) {
    for (const key of ['peak', 'loading', 'summary']) assert.ok(s[key], `${lang}.${key}`);
    assert.match(s.summary, /\{hour\}/, `${lang}.summary`);
  }
});

// ---- Loading ----------------------------------------------------------------------

function fakeHistory({ since = '2025-01-01T00:00:00Z', rows = hours([[21, 4]]), fail = null } = {}) {
  const calls = [];
  return {
    calls,
    history: {
      info() { calls.push(['info']); return Promise.resolve({ since, plays: since ? 100 : 0 }); },
      query(q) {
        calls.push(['query', q]);
        if (fail) return Promise.reject(Object.assign(new Error(fail), { code: fail }));
        return Promise.resolve({ rows });
      },
    },
  };
}

test('one hour query over the range, from the first day\'s midnight to tomorrow\'s', async () => {
  const f = fakeHistory();
  const r = await Clock.loadClock({ nt: { history: f.history }, now: NOW, range: '7d' });
  assert.equal(r.kind, 'clock');
  assert.equal(r.buckets.plays[21], 4);
  assert.deepEqual(f.calls[1], ['query', { from: at(2026, 9, 26).toISOString(), to: at(2026, 10, 3).toISOString(), groupBy: 'hour' }]);
});

test('all time asks from the day the first play was recorded', async () => {
  const f = fakeHistory({ since: '2026-03-14T09:30:00Z' });
  await Clock.loadClock({ nt: { history: f.history }, now: NOW, range: 'all' });
  assert.equal(f.calls[1][1].from, at(2026, 3, 14).toISOString());
});

test('history shorter than the range still draws, and says it is partial', async () => {
  const f = fakeHistory({ since: '2026-09-28T08:00:00Z' });
  const r = await Clock.loadClock({ nt: { history: f.history }, now: NOW, range: '30d' });
  assert.equal(r.kind, 'clock');
  assert.equal(r.window.partial, true);
});

test('nothing recorded is its own state, and asks for no hours', async () => {
  const f = fakeHistory({ since: null });
  assert.deepEqual(await Clock.loadClock({ nt: { history: f.history }, now: NOW, range: '30d' }), { kind: 'notRecording' });
  assert.equal(f.calls.length, 1);
});

test('a range without a single play is the no-plays state, not an empty ring', async () => {
  const f = fakeHistory({ rows: [] });
  assert.equal((await Clock.loadClock({ nt: { history: f.history }, now: NOW, range: '7d' })).kind, 'noPlays');
});

test('an app without the history API is too old', async () => {
  assert.deepEqual(await Clock.loadClock({ nt: {}, now: NOW, range: '7d' }), { kind: 'tooOld' });
});

test('history errors reach the page with their code', async () => {
  for (const code of ['permissionDenied', 'unavailable', 'invalidQuery', 'timeout']) {
    const f = fakeHistory({ fail: code });
    await assert.rejects(Clock.loadClock({ nt: { history: f.history }, now: NOW, range: '7d' }), (e) => e.code === code);
  }
});

// ---- Colours --------------------------------------------------------------------

test('night bars are the accent see-through, never mixed with black, and none of the old stone greys are left', () => {
  const css = readFileSync(new URL('../ListeningClock.nepget/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.bar\.night\s*\{\s*fill:\s*rgba\(var\(--accent-rgb\),\s*var\(--night-alpha\)\);\s*\}/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /black/, 'outside comments');
  for (const stone of ['#292524', '#44403c', '#0c0a09', '#78716c', '#d6d3d1', '#a8a29e', '#57534e']) {
    assert.equal(css.toLowerCase().includes(stone), false, stone);
  }
});

// ---- Manifest & settings ----------------------------------------------------------

const manifest = () => JSON.parse(readFileSync(new URL('../ListeningClock.nepget/manifest.json', import.meta.url), 'utf8'));
const field = (m, id) => m.settings.schema.find((s) => s.id === id);

test('the default settings are the manifest defaults, and every option survives normalising', () => {
  const m = manifest();
  assert.deepEqual(Clock.DEFAULT_SETTINGS, Object.fromEntries(m.settings.schema.map((s) => [s.id, s.default])));
  for (const s of m.settings.schema.filter((s) => s.options)) {
    for (const { value } of s.options) assert.equal(Clock.normalizeSettings({ [s.id]: value })[s.id], value, `${s.id}=${value}`);
  }
});

test('the range is 7 days, 30 days or all time, 30 days by default', () => {
  const range = field(manifest(), 'range');
  assert.deepEqual(range.options.map((o) => o.value), ['7d', '30d', 'all']);
  assert.equal(range.default, '30d');
});

test('the accent is the system blue by default, or the album art\'s, or a fixed pick', () => {
  const accent = field(manifest(), 'accentSource');
  assert.deepEqual(accent.options.map((o) => o.value), ['system', 'album', 'fixed']);
  assert.equal(accent.default, 'system');
  assert.equal(Clock.normalizeSettings({ accentSource: 'bogus' }).accentSource, 'system');
});

test('the fixed colour is Activity\'s, and the theme the other stats widgets\' own', () => {
  const other = (name) => JSON.parse(readFileSync(new URL(`../${name}.nepget/manifest.json`, import.meta.url), 'utf8'));
  assert.deepEqual(field(manifest(), 'fixedColor'), field(other('Activity'), 'fixedColor'));
  assert.deepEqual(field(manifest(), 'theme'), field(other('Scrobbles'), 'theme'));
});

test('local history only, on screen with nothing playing, hover-aware, NepTunes 4.1', () => {
  const m = manifest();
  assert.deepEqual([...m.permissions].sort(), ['artwork', 'listeningHistory']);
  assert.equal(m.alwaysVisible, true);
  assert.equal(m.pointerTracking, true);
  assert.equal(m.resizable, true);
  assert.equal(m.minNepTunesVersion, '4.1.0');
  assert.deepEqual(m.defaultSize, { width: 240, height: 240 });
  assert.deepEqual(m.minSize, { width: 200, height: 200 });
});
