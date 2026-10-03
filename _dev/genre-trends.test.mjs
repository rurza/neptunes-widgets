import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

process.env.TZ = 'Europe/Warsaw';

const require = createRequire(import.meta.url);
globalThis.NTKit = require('../GenreTrends.nepget/neptunes-kit.js');
globalThis.NTHistory = require('../GenreTrends.nepget/history-stats.js');
const Trends = require('../GenreTrends.nepget/script.js');

const at = (y, m, d, h = 0, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s);
const NOW = at(2026, 10, 2, 12);   // Friday 2 October 2026
const keyOf = (d) => NTHistory.dayKey(d);
const days7 = () => Trends.rangeDays('7d', NOW);
const g = (genre, plays) => ({ genre, plays, seconds: plays * 200 });

// ---- Days and timeline ------------------------------------------------------------

test('a range is its days, oldest first, ending today', () => {
  assert.deepEqual(days7().map(keyOf), ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  assert.equal(Trends.rangeDays('30d', NOW).length, 30);
  assert.equal(keyOf(Trends.rangeDays('30d', NOW)[0]), '2026-09-03');
  assert.throws(() => Trends.rangeDays('all', NOW), /unknown range/);
});

test('days without rows are zero, not missing', () => {
  const t = Trends.buildTimeline(days7(), { '2026-09-28': [g('Pop', 3)] }, at(2025, 1, 1));
  assert.deepEqual(t.genres, ['Pop']);
  assert.deepEqual(t.days.map((d) => d.values.Pop || 0), [0, 0, 3, 0, 0, 0, 0]);
  assert.ok(t.days.every((d) => d.known));
});

test('days before history began are unknown, take no values and no part in the ranking', () => {
  const rows = { '2026-09-27': [g('Jazz', 50)], '2026-09-30': [g('Pop', 2)] };
  const t = Trends.buildTimeline(days7(), rows, at(2026, 9, 29));
  assert.deepEqual(t.days.map((d) => d.known), [false, false, false, true, true, true, true]);
  assert.deepEqual(t.genres, ['Pop'], 'rows for a day before since are ignored');
  assert.deepEqual(t.days[1].values, {});
});

test('a play with several genres counts in each, so values can add up to more than the plays', () => {
  // One play tagged Rock and Indie: history.query reports it under both.
  const t = Trends.buildTimeline(days7(), { '2026-10-02': [g('Rock', 1), g('Indie', 1)] }, at(2025, 1, 1));
  assert.equal(t.days[6].total, 2);
  assert.deepEqual(t.days[6].values, { Rock: 1, Indie: 1 });
});

test('the top five genres by plays over the range, ties by name; the rest are summed into Other', () => {
  const rows = {
    '2026-09-26': [g('a', 9), g('B', 8), g('c', 7), g('d', 6)],
    '2026-09-27': [g('e', 5), g('f', 4), g('h', 3), g('i', 2), g('g', 3)],
    '2026-09-28': [g('b', 8)],
  };
  const t = Trends.buildTimeline(days7(), rows, at(2025, 1, 1));
  assert.deepEqual(t.genres, ['a', 'B', 'b', 'c', 'd']);
  assert.equal(t.hasOther, true);
  assert.deepEqual(t.days.map((d) => d.other), [0, 17, 0, 0, 0, 0, 0], 'e, f, g, h and i on 27 September');
  assert.equal(t.days[0].total, 30, 'a top-five day stacks only its genres');
  assert.equal(t.days[1].total, 17, 'Other adds to the stack');
});

test('a day whose plays are all outside the top five shows the Other band, not a pinch', () => {
  const top = ['a', 'b', 'c', 'd', 'e'].map((name) => g(name, 10));
  const t = chartOf({ '2026-09-26': top, '2026-09-27': [g('h', 3), g('i', 1)] });
  assert.equal(t.days[1].other, 4);
  assert.equal(t.days[1].total, 4);
  const s = Trends.stackLayout(t, CHART, false);
  assert.equal(s.layers.length, 6, 'five genres and Other');
  assert.ok(s.layers.slice(0, 5).every((layer) => layer[1].top === layer[1].bottom), 'the top five are absent that day');
  const other = s.layers[5][1];
  assert.ok(other.bottom - other.top > 0, 'Other has height that day');
  assert.equal(s.top, 52, 'busiest day 50: lines at 20 and 40, the top 4% over it');
  assert.deepEqual(Trends.hitTest(s, CHART, 30, 78), { day: 1, genre: 5 }, 'the pointer finds Other, on the bottom edge');
  assert.deepEqual(Trends.hitTest(s, CHART, 30, 50), { day: 1, genre: -1 }, 'above that day\'s short stack is nothing');
});

test('Other is left out when the genres outside the top five have no plays in the range', () => {
  const t = chartOf({ '2026-09-26': [g('a', 3), g('b', 2)] });
  assert.equal(t.hasOther, false);
  assert.equal(Trends.stackLayout(t, CHART, false).layers.length, 2);
  assert.deepEqual(Trends.bands(t, 'en').map((b) => b.name), ['a', 'b']);
});

test('Other sits at the bottom of the stack, last, grey, named in the host language', () => {
  const rows = { '2026-09-26': ['a', 'b', 'c', 'd', 'e', 'f'].map((name, i) => g(name, 10 - i)) };
  const t = chartOf(rows);
  const s = Trends.stackLayout(t, CHART, false);
  assert.equal(s.layers[5][0].bottom, 80, 'Other ends at the bottom edge on the busiest day');
  assert.deepEqual(Trends.bands(t, 'pl').map((b) => [b.name, b.slot, b.other]), [
    ['a', 'genre-0', false], ['b', 'genre-1', false], ['c', 'genre-2', false], ['d', 'genre-3', false],
    ['e', 'genre-4', false], ['Inne', 'genre-other', true]]);
  assert.equal(Trends.bandValue(t, t.days[0], 5), 5);
  assert.equal(Trends.bandValue(t, t.days[0], 0), 10);
});

test('a real genre named Other keeps its own colour, and its name is quoted so it never reads as the grey band', () => {
  const rows = { '2026-09-26': ['other', 'Pop', 'c', 'd', 'e', 'f'].map((name, i) => g(name, 10 - i)) };
  const t = chartOf(rows);
  assert.deepEqual(Trends.bands(t, 'en').map((b) => [b.name, b.slot, b.other]).filter((b, i) => i === 0 || i === 1 || i === 5), [
    ['“other”', 'genre-0', false], ['Pop', 'genre-1', false], ['Other', 'genre-other', true]]);
  // The catch-all's own word in the host language, and English, in any case; quoted the host language's way.
  const pl = chartOf({ '2026-09-26': [g('INNE', 3), g(' Other ', 2), g('Inner', 1)] });
  assert.deepEqual(Trends.bands(pl, 'pl').map((b) => b.name), ['„INNE”', '„Other”', 'Inner']);
  assert.deepEqual(Trends.bands(pl, 'de').map((b) => b.name), ['INNE', '„Other“', 'Inner']);
  assert.equal(Trends.bands(chartOf({ '2026-09-26': [g('Autres', 1)] }), 'fr')[0].name, '«\u00a0Autres\u00a0»');
  assert.equal(Trends.bands(chartOf({ '2026-09-26': [g('その他', 1)] }), 'ja')[0].name, '「その他」');
  for (const [lang, s] of Object.entries(Trends.STRINGS)) assert.match(s.quoted, /^.+\{name\}.+$/, lang);
});

test('a genre spread over days outranks one big day only by its total', () => {
  const rows = { '2026-09-26': [g('Spike', 10)], '2026-09-27': [g('Steady', 4)], '2026-09-28': [g('Steady', 4)], '2026-09-29': [g('Steady', 4)] };
  assert.deepEqual(Trends.buildTimeline(days7(), rows, at(2025, 1, 1)).genres, ['Steady', 'Spike']);
});

test('blank genre names and zero or junk counts are left out', () => {
  const t = Trends.buildTimeline(days7(), { '2026-10-02': [g('', 4), g('  ', 2), { genre: 'Pop', plays: 'x' }, null, g(' Folk ', 1)] }, at(2025, 1, 1));
  assert.deepEqual(t.genres, ['Folk']);
});

test('colour slots follow the rank, so the chart and the legend agree', () => {
  assert.deepEqual([0, 1, 4].map(Trends.colorSlot), ['genre-0', 'genre-1', 'genre-4']);
  assert.equal(Trends.TOP_GENRES, 5);
});

test('the palette is macOS\'s current system colours, top band first, Other grey, in every theme block', () => {
  const css = readFileSync(new URL('../GenreTrends.nepget/styles.css', import.meta.url), 'utf8');
  // blue, green, indigo, pink, orange, then systemGray for Other: NSColor.system* in sRGB, as
  // this Mac (Darwin 27) reports them under Dark Aqua and Aqua.
  const dark = ['#0091FF', '#30D158', '#6D7CFF', '#FF375F', '#FF9230', '#98989D'];
  const light = ['#0088FF', '#34C759', '#6155F5', '#FF2D55', '#FF8D28', '#8E8E93'];
  const block = (selector) => css.match(new RegExp(selector.replace(/[.()]/g, '\\$&') + '\\s*\\{([^}]*)\\}'))[1];
  const slots = (body) => [...body.matchAll(/--genre-(\d|other):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => m[2].toUpperCase());
  assert.deepEqual(slots(block(':root')), dark);
  assert.deepEqual(slots(block('html.theme-light')), light);
  const auto = css.match(/@media \(prefers-color-scheme: light\)\s*\{\s*html\.theme-auto\s*\{([^}]*)\}/);
  assert.ok(auto, 'the automatic theme has a light block');
  assert.deepEqual(slots(auto[1]), light);
  assert.doesNotMatch(css, /genre-[5-9]/, 'no rules for slots that no longer exist');
});

test('bands are opaque; only a hover dims the others', () => {
  const css = readFileSync(new URL('../GenreTrends.nepget/styles.css', import.meta.url), 'utf8');
  const rule = (selector) => (css.match(new RegExp('(?:^|\\n)' + selector.replace(/[.]/g, '\\.') + '\\s*\\{([^}]*)\\}')) || [])[1] || '';
  assert.match(rule('.band'), /fill-opacity:\s*1;/);
  assert.match(rule('.band.dimmed'), /fill-opacity:\s*0\.\d+;/);
});

// ---- Stack layout -----------------------------------------------------------------

const CHART = { x: 10, y: 20, w: 120, h: 60 };   // step 20 for 7 days; bottom edge y 80

function chartOf(rowsByKey, since = at(2025, 1, 1)) { return Trends.buildTimeline(days7(), rowsByKey, since); }

test('bands stack up from the bottom edge against the chart\'s top', () => {
  // A top of 4 plays over a 60 px chart: 15 px a play.
  const t = chartOf({ '2026-09-26': [g('Pop', 2), g('Rock', 2)], '2026-09-27': [g('Pop', 1)] });
  const s = Trends.stackLayout(t, CHART, false, 4);
  assert.equal(s.bottom, 80);
  assert.equal(s.top, 4);
  assert.equal(s.scale, 15);
  assert.deepEqual(s.xs, [10, 30, 50, 70, 90, 110, 130]);
  const [pop, rock] = s.layers;
  assert.deepEqual(pop[0], { day: 0, x: 10, top: 20, bottom: 50 });
  assert.deepEqual(rock[0], { day: 0, x: 10, top: 50, bottom: 80 });
  assert.deepEqual(pop[1], { day: 1, x: 30, top: 65, bottom: 80 }, 'a one-play day sits on the bottom edge');
  assert.equal(rock[1].top, rock[1].bottom, 'a genre absent that day is a zero-height band');
  assert.deepEqual(pop[2], { day: 2, x: 50, top: 80, bottom: 80 }, 'a silent day lies flat on the bottom edge');
});

test('without a given top the stack uses its busiest day\'s scale, the peak just short of the top edge', () => {
  const t = chartOf({ '2026-09-26': [g('Pop', 2), g('Rock', 2)], '2026-09-27': [g('Pop', 1)] });
  const s = Trends.stackLayout(t, CHART, false);
  assert.equal(s.top, Trends.niceScale(4).top);
  assert.ok(Math.abs(s.top - 4.16) < 1e-9, `${s.top}`);
  assert.ok(s.layers[0][0].top > CHART.y, 'the busiest day does not touch the top edge');
});

test('each day\'s stack stands on the bottom edge and is its total times the scale tall', () => {
  const rows = {
    '2026-09-26': [g('a', 30), g('b', 12), g('c', 5), g('d', 3), g('e', 1), g('f', 1)],
    '2026-09-27': [g('a', 7), g('c', 9), g('f', 4)],
    '2026-09-29': [g('b', 52)],
  };
  const t = chartOf(rows);
  const s = Trends.stackLayout(t, CHART, false);
  assert.deepEqual(Trends.niceScale(52).ticks, [20, 40]);
  t.days.forEach((d, i) => {
    const column = s.layers.map((layer) => layer.find((p) => p.day === i));
    const height = column.reduce((sum, p) => sum + (p.bottom - p.top), 0);
    assert.ok(Math.abs(height - d.total * s.scale) < 0.05, `day ${i}: ${height} for ${d.total}`);
    assert.equal(column[column.length - 1].bottom, 80, `day ${i} ends at the bottom edge`);
    for (let b = 1; b < column.length; b++) assert.equal(column[b].top, column[b - 1].bottom, `day ${i}: bands touch`);
  });
});

// ---- Plays-per-day scale ------------------------------------------------------------

const near = (a, b) => Math.abs(a - b) < 1e-9;

test('the scale: round 1-2-5 lines at or under the busiest day, the top just over it', () => {
  // [busiest, labelled lines, top]: the step is the smallest of 1, 2, 5, 10, … that fits at
  // most three whole steps under the busiest day; with two or three of them the top is the
  // busiest day plus 4%.
  const cases = [
    [2, [1, 2], 2.08], [3, [1, 2, 3], 3.12], [4, [2, 4], 4.16], [7, [2, 4, 6], 7.28], [11, [5, 10], 11.44],
    [30, [10, 20, 30], 31.2], [52, [20, 40], 54.08], [64, [20, 40, 60], 66.56], [101, [50, 100], 105.04],
    [610, [200, 400, 600], 634.4], [1500, [500, 1000, 1500], 1560], [2001, [1000, 2000], 2081.04],
    [1000, [500, 1000], 1040], [12000, [5000, 10000], 12480],
  ];
  for (const [busiest, ticks, top] of cases) {
    const s = Trends.niceScale(busiest);
    assert.deepEqual(s.ticks, ticks, `busiest ${busiest}`);
    assert.ok(near(s.top, top), `busiest ${busiest}: top ${s.top}, want ${top}`);
    assert.equal(s.step, ticks[0]);
  }
});

test('a busiest day under one step and a half keeps the top on a round line', () => {
  // One whole step under the busiest day would be one line: the top goes up to the next.
  const cases = [[0, [1, 2]], [1, [1, 2]], [8, [5, 10]], [9, [5, 10]], [80, [50, 100]], [99, [50, 100]],
    [930, [500, 1000]]];
  for (const [busiest, ticks] of cases) {
    const s = Trends.niceScale(busiest);
    assert.deepEqual(s.ticks, ticks, `busiest ${busiest}`);
    assert.equal(s.top, ticks[ticks.length - 1], `busiest ${busiest}: the top is the top line`);
  }
});

test('with room for two lines only, at most two whole steps go under the busiest day', () => {
  const cases = [[52, [20, 40], 54.08], [30, [20, 40], 40], [930, [500, 1000], 1000], [1500, [1000, 2000], 2000],
    [12000, [5000, 10000], 12480]];
  for (const [busiest, ticks, top] of cases) {
    const s = Trends.niceScale(busiest, 2);
    assert.deepEqual(s.ticks, ticks, `busiest ${busiest}`);
    assert.ok(near(s.top, top), `busiest ${busiest}: top ${s.top}, want ${top}`);
  }
});

test('at every magnitude: two or three labelled 1-2-5 lines, none over the top, the busiest day at least 80% of it', () => {
  for (let busiest = 2; busiest <= 250000; busiest++) {
    const s = Trends.niceScale(busiest);
    const where = `busiest ${busiest}: ${s.ticks} / ${s.top}`;
    assert.ok(s.ticks.length >= 2 && s.ticks.length <= 3, where);
    assert.ok(s.ticks.every((v) => v <= s.top + 1e-9), where);
    assert.ok(s.top >= busiest, where);
    assert.ok(busiest / s.top >= 0.8 - 1e-9, where);
    const mantissa = s.step / Math.pow(10, Math.floor(Math.log10(s.step)));
    assert.ok([1, 2, 5].includes(Math.round(mantissa)), where);
    assert.deepEqual(s.ticks, s.ticks.map((_, i) => s.step * (i + 1)), where);
  }
  // Two lines: still two labelled lines on a 1-2-5 step, under the top.
  for (let busiest = 2; busiest <= 250000; busiest = Math.ceil(busiest * 1.03)) {
    const s = Trends.niceScale(busiest, 2);
    assert.equal(s.ticks.length, 2, `${busiest}: ${s.ticks}`);
    assert.ok(s.top >= busiest && s.ticks[1] <= s.top + 1e-9, `${busiest}: ${s.ticks} / ${s.top}`);
  }
});

test('three lines when the chart is tall enough to keep their labels apart, else two', () => {
  assert.equal(Trends.tickLines(93, 11), 3);
  assert.equal(Trends.tickLines(39, 11), 3, '13 px apart: the 11 px line and a pixel either side');
  assert.equal(Trends.tickLines(38, 11), 2);
  assert.equal(Trends.tickLines(0, 11), 2);
});

test('tick labels are the locale\'s numbers, grouped, in its own digits', () => {
  assert.equal(Trends.formatTick(1000, 'en-US', false), '1,000');
  assert.equal(Trends.formatTick(1500, 'de-DE', false), '1.500');
  assert.equal(Trends.formatTick(1500, 'pl-PL', false), '1500', 'Polish groups from five digits');
  assert.equal(Trends.formatTick(15000, 'pl-PL', false), '15 000');
  assert.equal(Trends.formatTick(1000, 'ar-SA', false), '١٬٠٠٠');
  assert.equal(Trends.formatTick(60, 'ar-SA', false), '٦٠');
  assert.equal(Trends.formatTick(60, 'ar_SA', false), '60', 'a malformed tag degrades, never throws');
});

test('the compact form is the locale\'s own short notation', () => {
  assert.equal(Trends.formatTick(1500, 'en-US', true), '1.5K');
  assert.equal(Trends.formatTick(15000, 'en-US', true), '15K');
  assert.equal(Trends.formatTick(1500, 'pl-PL', true), '1,5 tys.');
  assert.equal(Trends.formatTick(500, 'en-US', true), '500');
  assert.equal(Trends.formatTick(1500000, 'de-DE', true), '1,5 Mio.');
});

test('the compact form is used only when the full numbers would widen the gutter past its share, and it is narrower', () => {
  // The gutter may take 12% of the chart's width: 26.16 px of a 218 px chart (the smallest window).
  assert.equal(Trends.maxGutter(218), 26.16);
  assert.equal(Trends.useCompact(24, 15, 218), false, '"1,500" fits');
  assert.equal(Trends.useCompact(30, 15, 218), true, '"15,000" does not, "15K" does');
  assert.equal(Trends.useCompact(30, 34, 218), false, 'a compact form no narrower is no help ("1 tys." for "1000")');
  assert.equal(Trends.useCompact(30, 30, 218), false);
});

test('the axis: a caption line on top, the gutter on the leading edge, the plot in the rest', () => {
  const chart = { x: 31, y: 27, w: 218, h: 93 };
  const ltr = Trends.axisLayout(chart, 20, 11, false);
  // caption line 11, half the top tick label 6, a pixel between: the top line 18 below the chart's top.
  assert.deepEqual(ltr.plot, { x: 51, y: 45, w: 198, h: 75 });
  assert.deepEqual(ltr.caption, { x: 31, y: 27, align: 'left' });
  assert.equal(ltr.labelEdge, 47, 'labels end 4 px before the plot');
  assert.equal(ltr.align, 'right');
  const rtl = Trends.axisLayout(chart, 20, 11, true);
  assert.deepEqual(rtl.plot, { x: 31, y: 45, w: 198, h: 75 });
  assert.deepEqual(rtl.caption, { x: 249, y: 27, align: 'right' });
  assert.equal(rtl.labelEdge, 233, 'right to left, labels start 4 px after the plot');
  assert.equal(rtl.align, 'left');
});

test('each line sits at its value against the plot\'s top', () => {
  const plot = { x: 51, y: 45, w: 198, h: 75 };
  assert.deepEqual(Trends.tickPositions({ ticks: [20, 40, 60], top: 60 }, plot), [{ value: 20, y: 95 }, { value: 40, y: 70 }, { value: 60, y: 45 }]);
  assert.deepEqual(Trends.tickPositions(Trends.niceScale(930), plot), [{ value: 500, y: 82.5 }, { value: 1000, y: 45 }], 'top on the 1000 line');
  // 1500: lines 500/1000/1500 under a top of 1560, so the 1500 line sits 2.88 px under the plot's top.
  assert.deepEqual(Trends.tickPositions(Trends.niceScale(1500), plot).map((p) => p.y), [95.96, 71.92, 47.88]);
  // The stack drawn in the same plot meets the lines: a 40-play day's top is the 40 line.
  const t = chartOf({ '2026-09-26': [g('Pop', 40)], '2026-09-27': [g('Pop', 60)] });
  assert.equal(Trends.stackLayout(t, plot, false, 60).layers[0][0].top, 70);
  const scale = Trends.niceScale(1500);
  const big = chartOf({ '2026-09-26': [g('Pop', 1000)], '2026-09-27': [g('Pop', 1500)] });
  const s = Trends.stackLayout(big, plot, false, scale.top);
  assert.equal(s.layers[0][0].top, Trends.tickPositions(scale, plot)[1].y, 'a 1000-play day meets the 1000 line');
});

test('the unit caption exists in every app language, translated', () => {
  for (const [lang, s] of Object.entries(Trends.STRINGS)) assert.ok(s.perDay && s.perDay.trim(), `${lang}.perDay`);
  assert.equal(Trends.STRINGS.en.perDay, 'Plays per day');
  assert.equal(Trends.STRINGS.pl.perDay, 'Odtworzenia dziennie');
  assert.equal(new Set(Object.values(Trends.STRINGS).map((s) => s.perDay)).size, Object.keys(Trends.STRINGS).length, 'no language copies another');
});

test('a silent range draws no bands', () => {
  const t = chartOf({});
  assert.deepEqual(Trends.stackLayout(t, CHART, false).layers, []);
});

test('unknown days get no points, and the no-data strip runs up to the first known day', () => {
  const t = chartOf({ '2026-09-30': [g('Pop', 2)] }, at(2026, 9, 29, 15));
  const s = Trends.stackLayout(t, CHART, false);
  assert.deepEqual(s.layers[0].map((p) => p.day), [3, 4, 5, 6]);
  assert.deepEqual(s.noData, { x: 10, w: 60 });
});

test('with every day known there is no no-data strip', () => {
  assert.equal(Trends.stackLayout(chartOf({ '2026-09-30': [g('Pop', 2)] }), CHART, false).noData, null);
});

test('history that began today still draws a band, half a day wide', () => {
  const t = chartOf({ '2026-10-02': [g('Pop', 2)] }, at(2026, 10, 2, 9));
  const s = Trends.stackLayout(t, CHART, false);
  assert.deepEqual(s.layers[0].map((p) => p.x), [120, 130]);
  assert.deepEqual(s.noData, { x: 10, w: 120 });
});

test('right to left, the days run from the right and the no-data strip sits on the right', () => {
  const t = chartOf({ '2026-09-30': [g('Pop', 2)] }, at(2026, 9, 29));
  const s = Trends.stackLayout(t, CHART, true);
  assert.deepEqual(s.xs, [130, 110, 90, 70, 50, 30, 10]);
  assert.deepEqual(s.noData, { x: 70, w: 60 });
});

test('a band path runs along the top edge and back along the bottom', () => {
  assert.equal(Trends.layerPath([{ x: 10, top: 20, bottom: 50 }, { x: 30, top: 42.5, bottom: 57.5 }]),
    'M10,20L30,42.5L30,57.5L10,50Z');
  assert.equal(Trends.layerPath([]), '');
});

test('the hit test finds the nearest day and the band under the pointer on it', () => {
  const t = chartOf({ '2026-09-26': [g('Pop', 2), g('Rock', 2)], '2026-09-27': [g('Pop', 1)] });
  const s = Trends.stackLayout(t, CHART, false);
  assert.deepEqual(Trends.hitTest(s, CHART, 12, 30), { day: 0, genre: 0 });
  assert.deepEqual(Trends.hitTest(s, CHART, 8, 70), { day: 0, genre: 1 });
  assert.deepEqual(Trends.hitTest(s, CHART, 21, 30), { day: 1, genre: -1 }, 'nearer day 1, above its band');
  assert.deepEqual(Trends.hitTest(s, CHART, 31, 70), { day: 1, genre: 0 }, 'day 1 is one play on the bottom edge');
  assert.deepEqual(Trends.hitTest(s, CHART, 31, 50), { day: 1, genre: -1 });
  assert.equal(Trends.hitTest(s, CHART, 30, 10), null, 'above the chart');
  assert.equal(Trends.hitTest(s, CHART, -5, 50), null, 'more than half a day left of the first');
  assert.equal(Trends.hitTest(s, CHART, NaN, 50), null);
});

test('the callout sits above the pointer, below it near the top, clamped inside the window', () => {
  const bounds = { x: 2, y: 2, w: 316, h: 196 };
  assert.deepEqual(Trends.calloutOrigin({ x: 100, y: 120 }, { w: 80, h: 40 }, bounds), { x: 60, y: 72, above: true });
  assert.deepEqual(Trends.calloutOrigin({ x: 100, y: 30 }, { w: 80, h: 40 }, bounds), { x: 60, y: 38, above: false });
  assert.deepEqual(Trends.calloutOrigin({ x: 5, y: 120 }, { w: 80, h: 40 }, bounds), { x: 2, y: 72, above: true });
  assert.deepEqual(Trends.calloutOrigin({ x: 315, y: 120 }, { w: 80, h: 40 }, bounds), { x: 238, y: 72, above: true });
});

// ---- Labels on the bands ---------------------------------------------------------

const flat = [{ x: 0, top: 10, bottom: 40 }, { x: 100, top: 10, bottom: 40 }];
const LABEL = { width: 40, minWidth: 40, height: 14, padX: 2, padY: 2 };

test('a label fits a band thick and long enough, centred in it', () => {
  assert.deepEqual(Trends.placeLabel(flat, LABEL), { x: 50, y: 25, width: 40, truncated: false });
});

test('a band thinner than the line plus its padding gets no label', () => {
  const thin = [{ x: 0, top: 10, bottom: 27 }, { x: 100, top: 10, bottom: 27 }];
  assert.equal(Trends.placeLabel(thin, LABEL), null, '17 < 14 + 2 × 2');
  const enough = [{ x: 0, top: 10, bottom: 28 }, { x: 100, top: 10, bottom: 28 }];
  assert.ok(Trends.placeLabel(enough, LABEL));
});

test('a band too short for the label gets none, or a cut-short one when cutting is allowed', () => {
  const short = [{ x: 0, top: 10, bottom: 40 }, { x: 30, top: 10, bottom: 40 }];
  assert.equal(Trends.placeLabel(short, LABEL), null);
  const cut = Trends.placeLabel(short, { ...LABEL, minWidth: 12 });
  assert.equal(cut.truncated, true);
  assert.ok(cut.width >= 12 && cut.width <= 26, `cut to the band less its padding: ${cut.width}`);
  assert.equal(cut.x, 15);
});

test('the band must be thick under the label\'s full width, not just at its centre', () => {
  // A peak 60 thick in the middle, nothing at either end: thick enough at the centre, but
  // 9.6 thick where a label 80 wide would start.
  const peak = [{ x: 0, top: 30, bottom: 30 }, { x: 50, top: 0, bottom: 60 }, { x: 100, top: 30, bottom: 30 }];
  assert.equal(Trends.placeLabel(peak, { ...LABEL, width: 80, minWidth: 80 }), null);
  const small = Trends.placeLabel(peak, { ...LABEL, width: 20, minWidth: 20 });
  assert.equal(small.x, 50, 'a narrow label sits on the peak');
  assert.equal(small.y, 30);
});

test('the label goes where the band leaves it the most room', () => {
  // Nothing on the left, a plateau 40 thick from x 60 on.
  const ramp = [{ x: 0, top: 20, bottom: 20 }, { x: 60, top: 0, bottom: 40 }, { x: 100, top: 0, bottom: 40 }];
  const p = Trends.placeLabel(ramp, { ...LABEL, width: 30, minWidth: 30 });
  assert.ok(p.x >= 77 && p.x <= 83, `on the plateau: ${p.x}`);
  assert.equal(p.y, 20);
  // A sloping band: the label box must clear the top edge's highest point and the bottom
  // edge's lowest point under it.
  const slope = [{ x: 0, top: 0, bottom: 30 }, { x: 100, top: 20, bottom: 50 }];
  const q = Trends.placeLabel(slope, { ...LABEL, width: 80, minWidth: 80 });
  assert.equal(q, null, 'thickness 30 everywhere, but under an 84 wide box the edges move 16.8, leaving 13.2 < 18');
  const r = Trends.placeLabel(slope, { ...LABEL, width: 20, minWidth: 20 });
  assert.ok(r, 'under a 24 wide box they move 4.8, leaving 25.2');
});

test('right to left, labels mirror with the bands', () => {
  const rows = { '2026-09-26': [g('Pop', 1)], '2026-09-30': [g('Pop', 9)], '2026-10-02': [g('Pop', 4)], '2026-09-28': [g('Rock', 2)] };
  const t = chartOf(rows);
  const opts = { width: 20, minWidth: 20, height: 8, padX: 1, padY: 1 };
  const ltr = Trends.placeLabel(Trends.stackLayout(t, CHART, false).layers[0], opts);
  const rtl = Trends.placeLabel(Trends.stackLayout(t, CHART, true).layers[0], { ...opts, rtl: true });
  assert.ok(ltr && rtl);
  assert.equal(rtl.x, 2 * CHART.x + CHART.w - ltr.x);
  assert.equal(rtl.y, ltr.y);
});

test('label ink is white or near-black, whichever reads better on the band colour', () => {
  assert.equal(Trends.labelInk([255, 255, 255]), 'dark');
  assert.equal(Trends.labelInk([0, 0, 0]), 'light');
  assert.equal(Trends.labelInk([97, 85, 245]), 'light', 'light-panel indigo is dark enough for white');
  assert.equal(Trends.labelInk([255, 146, 48]), 'dark', 'orange is too bright for white');
  assert.ok(Trends.contrastRatio([255, 255, 255], [0, 0, 0]) > 20.9);
  assert.equal(Trends.labelInk(Trends.parseRgb('rgb(97, 85, 245)')), 'light');
  assert.equal(Trends.parseRgb('nonsense'), null);
  assert.equal(Trends.labelInk(null), 'dark');
});

test('the legend lists only the bands that got no label', () => {
  assert.deepEqual(Trends.legendBands([{ x: 1 }, null, { x: 2 }, null]), [1, 3]);
  assert.deepEqual(Trends.legendBands([{ x: 1 }, { x: 2 }]), []);
});

// ---- Loading ----------------------------------------------------------------------

function fakeHistory({ since = '2025-01-01T00:00:00Z', byDay = {}, none = 0, fail = null, failOn = null } = {}) {
  const calls = [];
  let inFlight = 0, maxInFlight = 0;
  return {
    calls,
    get maxInFlight() { return maxInFlight; },
    history: {
      info() { calls.push({ info: true }); return Promise.resolve({ since, plays: since ? 100 : 0 }); },
      query(q) {
        calls.push(q);
        if (q.groupBy === 'none') return Promise.resolve({ rows: [{ plays: none, seconds: 0 }] });
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) => setTimeout(resolve, 1)).then(() => {
          inFlight--;
          const key = NTHistory.dayKey(new Date(q.from));
          if (fail && (!failOn || failOn === key)) throw Object.assign(new Error(fail), { code: fail });
          return { rows: byDay[key] || [] };
        });
      },
    },
  };
}
const dayCalls = (f) => f.calls.filter((c) => c.groupBy === 'genre');

test('one genre query per day, a local day each, at most two at a time', async () => {
  const f = fakeHistory({ byDay: { '2026-10-01': [g('Pop', 3)] } });
  const memo = Trends.freshMemo(NOW);
  const r = await Trends.loadTrends({ nt: { history: f.history }, now: NOW, range: '7d', memo });
  assert.equal(r.kind, 'chart');
  assert.equal(dayCalls(f).length, 7);
  assert.deepEqual(dayCalls(f)[0], { from: at(2026, 9, 26).toISOString(), to: at(2026, 9, 27).toISOString(), groupBy: 'genre', limit: 1000 });
  assert.ok(f.maxInFlight <= Trends.MAX_CONCURRENT_DAYS);
});

test('finished days are remembered; a refresh asks for today alone', async () => {
  const f = fakeHistory({ byDay: { '2026-10-01': [g('Pop', 3)] } });
  const memo = Trends.freshMemo(NOW);
  await Trends.loadTrends({ nt: { history: f.history }, now: NOW, range: '7d', memo });
  f.calls.length = 0;
  const r = await Trends.loadTrends({ nt: { history: f.history }, now: NOW, range: '7d', memo });
  assert.deepEqual(dayCalls(f).map((c) => NTHistory.dayKey(new Date(c.from))), ['2026-10-02']);
  assert.equal(r.timeline.days[5].values.Pop, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(memo.rows, '2026-10-02'), false, 'today is never remembered');
});

test('the memory serves both ranges: 30 days after 7 asks only for the 23 days it lacks, plus today', async () => {
  const f = fakeHistory();
  const memo = Trends.freshMemo(NOW);
  await Trends.loadTrends({ nt: { history: f.history }, now: NOW, range: '7d', memo });
  f.calls.length = 0;
  await Trends.loadTrends({ nt: { history: f.history }, now: NOW, range: '30d', memo });
  assert.equal(dayCalls(f).length, 24);
});

test('days before history began are not asked for', async () => {
  const f = fakeHistory({ since: '2026-09-30T10:00:00Z', byDay: { '2026-09-30': [g('Pop', 1)] } });
  await Trends.loadTrends({ nt: { history: f.history }, now: NOW, range: '7d', memo: Trends.freshMemo(NOW) });
  assert.deepEqual(dayCalls(f).map((c) => NTHistory.dayKey(new Date(c.from))), ['2026-09-30', '2026-10-01', '2026-10-02']);
});

test('a failed day fails the load but keeps the days that landed', async () => {
  const f = fakeHistory({ fail: 'timeout', failOn: '2026-09-29' });
  const memo = Trends.freshMemo(NOW);
  await assert.rejects(Trends.loadTrends({ nt: { history: f.history }, now: NOW, range: '7d', memo }), (e) => e.code === 'timeout');
  assert.ok(Object.keys(memo.rows).includes('2026-09-26'));
  assert.ok(!Object.keys(memo.rows).includes('2026-09-29'));
});

test('a superseded load asks for no further days', async () => {
  const f = fakeHistory();
  let current = true;
  const load = Trends.loadTrends({ nt: { history: f.history }, now: NOW, range: '30d', memo: Trends.freshMemo(NOW), isCurrent: () => current });
  current = false;
  await assert.rejects(load, (e) => e.code === 'superseded');
  assert.ok(dayCalls(f).length <= Trends.MAX_CONCURRENT_DAYS);
});

test('a memory from another time zone or another day is not used', () => {
  const memo = { timeZone: 'Elsewhere|0', day: '2026-10-02', rows: { '2026-10-01': [] } };
  assert.deepEqual(Trends.memoFor(memo, NOW).rows, {});
  const today = Trends.freshMemo(NOW);
  today.rows['2026-10-01'] = [];
  assert.equal(Trends.memoFor(today, at(2026, 10, 2, 23, 59)), today, 'later the same day it is kept');
  assert.deepEqual(Trends.memoFor(today, at(2026, 10, 3, 0, 0, 1)).rows, {}, 'the next day it is dropped');
});

/** Timers that only run when the test says so. */
function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { const id = next++; pending.set(id, { fn, ms, kind: 'timeout' }); return id; },
    clearTimeout(id) { if (pending.get(id)?.kind === 'timeout') pending.delete(id); },
    setInterval(fn, ms) { const id = next++; pending.set(id, { fn, ms, kind: 'interval' }); return id; },
    clearInterval(id) { if (pending.get(id)?.kind === 'interval') pending.delete(id); },
    fire(ms) {
      const due = [...pending.entries()].filter(([, t]) => t.ms === ms);
      due.forEach(([id, t]) => { if (t.kind === 'timeout') pending.delete(id); });
      due.forEach(([, t]) => t.fn());
      return due.length;
    },
  };
}

test('past days are asked again at each midnight reload, and only today on the ten-minute refresh', async () => {
  // The host fills genres in late and writes a play when it ends, so a finished day can still
  // change after it was first asked for: the page's own load, on the page's own schedule.
  const byDay = { '2026-10-01': [g('Pop', 3)] };
  const f = fakeHistory({ byDay });
  const timers = fakeTimers();
  let clock = NOW, settles = 0;
  let c = null;
  c = NTHistory.loadController({
    contentKind: 'chart', initialRange: '7d', canLoad: () => true, range: () => '7d', now: () => clock,
    load: Trends.trendsLoader(() => ({ history: f.history })),
    render() { if (c && c.phase === 'ready') settles++; },
    refreshMs: Trends.REFRESH_MS, retryMs: Trends.RETRY_MS, settingsReloadMs: Trends.SETTINGS_RELOAD_MS, timers,
  });
  async function settled(run) {
    const before = settles;
    run();
    for (let i = 0; i < 500 && settles === before; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.ok(settles > before, 'the load settled');
  }
  const asked = () => dayCalls(f).map((q) => NTHistory.dayKey(new Date(q.from)));
  await settled(() => c.reload(true));
  c.startSchedule();
  const midnight = NTHistory.msUntilNextMidnight(NOW);

  f.calls.length = 0;
  clock = at(2026, 10, 2, 23, 50);
  await settled(() => timers.fire(Trends.REFRESH_MS));
  assert.deepEqual(asked(), ['2026-10-02'], 'an ordinary refresh asks for today alone');

  byDay['2026-10-01'] = [g('Pop', 3), g('Jazz', 2)];   // enriched after it was remembered
  f.calls.length = 0;
  clock = at(2026, 10, 3, 0, 0, 1);
  await settled(() => timers.fire(midnight));
  assert.deepEqual(asked(), ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'],
    'the midnight reload asks for the whole range again');
  assert.equal(c.result.timeline.days[4].values.Jazz, 2);

  f.calls.length = 0;
  clock = at(2026, 10, 3, 0, 10);
  await settled(() => timers.fire(Trends.REFRESH_MS));
  assert.deepEqual(asked(), ['2026-10-03'], 'and the next refresh is back to today alone');
});

test('nothing recorded is its own state, and asks for no days', async () => {
  const f = fakeHistory({ since: null });
  assert.deepEqual(await Trends.loadTrends({ nt: { history: f.history }, now: NOW, range: '7d', memo: Trends.freshMemo(NOW) }), { kind: 'notRecording' });
  assert.equal(dayCalls(f).length, 0);
});

test('no genre anywhere asks one total: none played is no plays, plays without genres is no genres', async () => {
  const silent = fakeHistory({ none: 0 });
  assert.equal((await Trends.loadTrends({ nt: { history: silent.history }, now: NOW, range: '7d', memo: Trends.freshMemo(NOW) })).kind, 'noPlays');
  const untagged = fakeHistory({ none: 12 });
  assert.equal((await Trends.loadTrends({ nt: { history: untagged.history }, now: NOW, range: '7d', memo: Trends.freshMemo(NOW) })).kind, 'noGenres');
  assert.deepEqual(untagged.calls.find((c) => c.groupBy === 'none'), { from: at(2026, 9, 26).toISOString(), to: at(2026, 10, 3).toISOString(), groupBy: 'none' });
});

test('an app without the history API is too old', async () => {
  assert.deepEqual(await Trends.loadTrends({ nt: {}, now: NOW, range: '7d', memo: Trends.freshMemo(NOW) }), { kind: 'tooOld' });
});

test('history errors reach the page with their code', async () => {
  for (const code of ['permissionDenied', 'unavailable', 'invalidQuery', 'timeout']) {
    const f = fakeHistory({ fail: code });
    await assert.rejects(Trends.loadTrends({ nt: { history: f.history }, now: NOW, range: '7d', memo: Trends.freshMemo(NOW) }), (e) => e.code === code);
  }
});

// ---- Strings, layout, manifest ------------------------------------------------------

test('the chart\'s own words exist in every app language', () => {
  assert.deepEqual(Object.keys(Trends.STRINGS).sort(), [...NTHistory.LANGUAGES].sort());
  for (const [lang, s] of Object.entries(Trends.STRINGS)) {
    for (const key of ['loading', 'noGenres', 'summary', 'other']) assert.ok(s[key], `${lang}.${key}`);
    assert.match(s.summary, /\{list\}/);
  }
  assert.equal(Trends.statusText({ kind: 'noGenres' }, '7d', 'en'), 'No genre information for these days');
  assert.equal(Trends.statusText({ kind: 'noPlays' }, '30d', 'en'), 'No plays in the last 30 days');
  assert.equal(Trends.summaryText(['Pop', 'Rock', 'Jazz'], 'en', 'en-US'), 'Top genres: Pop, Rock, and Jazz');
  assert.equal(Trends.STRINGS.en.other, 'Other');
  assert.equal(Trends.STRINGS.pl.other, 'Inne');
  assert.equal(Trends.STRINGS.de.other, 'Andere');
  assert.equal(new Set(Object.values(Trends.STRINGS).map((s) => s.other)).size > 10, true, 'translated, not copied');
});

test('the default window: the card fills the gutter and the chart sits above the footer', () => {
  const l = Trends.layout(340, 220, 'card', 30);
  assert.deepEqual(l.card, { x: 20, y: 16, w: 300, h: 180 });
  assert.equal(l.pad, 13);
  assert.deepEqual(l.chart, { x: 33, y: 29, w: 274, h: 118 });
  assert.deepEqual(l.footer, { x: 33, y: 153, w: 274, h: 30 });
  assert.ok(l.chart.y + l.chart.h <= l.footer.y);
});

test('the bare chart needs no gutter and no padding', () => {
  const l = Trends.layout(340, 220, 'none', 30);
  assert.deepEqual(l.card, { x: 6, y: 6, w: 328, h: 208 });
  assert.equal(l.pad, 0);
});

const manifest = () => JSON.parse(readFileSync(new URL('../GenreTrends.nepget/manifest.json', import.meta.url), 'utf8'));

test('the default settings are the manifest defaults, and every option survives normalising', () => {
  const m = manifest();
  assert.deepEqual(Trends.DEFAULT_SETTINGS, Object.fromEntries(m.settings.schema.map((s) => [s.id, s.default])));
  for (const s of m.settings.schema.filter((s) => s.options)) {
    for (const { value } of s.options) assert.equal(Trends.normalizeSettings({ [s.id]: value })[s.id], value, `${s.id}=${value}`);
  }
});

test('no colour setting: the palette is fixed, and theme and background are the Listening Clock\'s', () => {
  const ids = manifest().settings.schema.map((s) => s.id);
  assert.deepEqual(ids, ['range', 'theme', 'background']);
  assert.deepEqual(Object.keys(Trends.DEFAULT_SETTINGS).sort(), ['background', 'range', 'theme']);
  const clock = JSON.parse(readFileSync(new URL('../ListeningClock.nepget/manifest.json', import.meta.url), 'utf8'));
  for (const id of ['theme', 'background']) {
    assert.deepEqual(manifest().settings.schema.find((s) => s.id === id), clock.settings.schema.find((s) => s.id === id), id);
  }
  const source = readFileSync(new URL('../GenreTrends.nepget/script.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /accent/i, 'no accent code left');
});

test('the hover guide is the label ink, never a band\'s blue', () => {
  const css = readFileSync(new URL('../GenreTrends.nepget/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.guide\s*\{[^}]*stroke:\s*var\(--ink\);/);
  assert.doesNotMatch(css, /accent/i);
});

test('the range is 7 or 30 days, 7 by default', () => {
  const range = manifest().settings.schema.find((s) => s.id === 'range');
  assert.deepEqual(range.options.map((o) => o.value), ['7d', '30d']);
  assert.equal(range.default, '7d');
});

test('local history only, on screen with nothing playing, hover-aware, NepTunes 4.1', () => {
  const m = manifest();
  assert.deepEqual(m.permissions, ['listeningHistory']);
  assert.equal(m.alwaysVisible, true);
  assert.equal(m.pointerTracking, true);
  assert.equal(m.resizable, true);
  assert.equal(m.minNepTunesVersion, '4.1.0');
  assert.deepEqual(m.defaultSize, { width: 340, height: 220 });
  assert.deepEqual(m.minSize, { width: 280, height: 190 });
});
