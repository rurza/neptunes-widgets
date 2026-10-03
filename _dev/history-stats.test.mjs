import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, existsSync } from 'node:fs';

// Local calendar days, as the widgets run them in the host: the zone is pinned before any Date
// is built (Node re-reads TZ on assignment). Warsaw has a DST change on 25 October 2026.
process.env.TZ = 'Europe/Warsaw';

const require = createRequire(import.meta.url);
const H = require('./history-stats.js');
const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const NOW = at(2026, 10, 2, 12);   // Friday 2 October 2026, noon

// ---- Ranges -------------------------------------------------------------------

test('a 7-day range is today and the six days before it, half-open at tomorrow', () => {
  const w = H.rangeWindow('7d', NOW, at(2025, 1, 1));
  assert.equal(H.dayKey(w.from), '2026-09-26');
  assert.equal(w.to.getTime(), at(2026, 10, 3).getTime());
  assert.equal(w.partial, false);
});

test('a 30-day range opens 29 days back', () => {
  assert.equal(H.dayKey(H.rangeWindow('30d', NOW, at(2025, 1, 1)).from), '2026-09-03');
});

test('all time runs from the day of the first recorded play, and is never partial', () => {
  const w = H.rangeWindow('all', NOW, at(2026, 4, 17, 22, 40));
  assert.equal(H.dayKey(w.from), '2026-04-17');
  assert.equal(w.partial, false);
});

test('history that began inside the range makes it partial, from the day it began', () => {
  const w = H.rangeWindow('30d', NOW, at(2026, 9, 20, 18));
  assert.equal(w.partial, true);
  assert.equal(H.dayKey(w.sinceDay), '2026-09-20');
  assert.equal(H.dayKey(w.from), '2026-09-03', 'the range itself is unchanged; the widget greys the days before');
});

test('history that began on the range\'s first day is not partial', () => {
  assert.equal(H.rangeWindow('7d', NOW, at(2026, 9, 26, 23, 59)).partial, false);
});

test('nothing recorded means nothing to ask for', () => {
  assert.equal(H.rangeWindow('7d', NOW, null), null);
});

test('a since ahead of the clock asks for today alone', () => {
  const w = H.rangeWindow('all', NOW, at(2026, 10, 5));
  assert.equal(H.dayKey(w.from), '2026-10-02');
});

test('an unknown range is a programming error, not a silent default', () => {
  assert.throws(() => H.rangeWindow('90d', NOW, at(2025, 1, 1)), /unknown range/);
});

test('ranges follow the calendar across a DST change', () => {
  const w = H.rangeWindow('7d', at(2026, 10, 28, 9), at(2025, 1, 1));
  assert.equal(H.dayKey(w.from), '2026-10-22');
  assert.equal(w.from.getHours(), 0);
  assert.equal(H.msUntilNextMidnight(at(2026, 10, 24, 23)), 3600 * 1000 + 1000);
  assert.equal(H.msUntilNextMidnight(at(2026, 10, 25, 0, 30)), 24.5 * 3600 * 1000 + 1000, 'the 25-hour day');
});

test('since is read from info(), and anything unreadable is nothing recorded', () => {
  assert.equal(H.parseSince({ since: '2026-09-01T10:00:00Z', plays: 3 }).toISOString(), '2026-09-01T10:00:00.000Z');
  assert.equal(H.parseSince({ since: null, plays: 0 }), null);
  assert.equal(H.parseSince({ since: 'nonsense' }), null);
  assert.equal(H.parseSince(null), null);
});

// ---- Errors -------------------------------------------------------------------

test('each history error code maps to what the widget shows and whether it retries', () => {
  const err = (code) => Object.assign(new Error(code), { code });
  assert.deepEqual(H.failure(err('permissionDenied')), { kind: 'tooOld', retry: false });
  assert.deepEqual(H.failure(err('invalidQuery')), { kind: 'error', retry: false });
  assert.deepEqual(H.failure(err('unavailable')), { kind: 'error', retry: true });
  assert.deepEqual(H.failure(err('timeout')), { kind: 'error', retry: true });
  assert.deepEqual(H.failure(new Error('no code')), { kind: 'error', retry: true });
});

test('history is there only when both info and query are functions', () => {
  assert.equal(H.hasHistory({ history: { info() {}, query() {} } }), true);
  assert.equal(H.hasHistory({ history: { info() {} } }), false);
  assert.equal(H.hasHistory({}), false);
  assert.equal(H.hasHistory(undefined), false);
});

// ---- Strings ------------------------------------------------------------------

const KEYS = ['notRecording', 'loadFailed', 'tooOld', 'noData', 'since'];

test('the shared strings speak every app language', () => {
  assert.deepEqual([...H.LANGUAGES].sort(),
    ['ar', 'ca', 'de', 'en', 'es', 'fr', 'it', 'ja', 'nl', 'pl', 'pt-BR', 'ru', 'uk', 'zh-Hans']);
  for (const lang of H.LANGUAGES) {
    const s = H.STRINGS[lang];
    for (const key of KEYS) assert.ok(typeof s[key] === 'string' && s[key].length > 0, `${lang}.${key}`);
    for (const range of ['7d', '30d', 'all']) {
      assert.ok(s.noPlays[range], `${lang}.noPlays.${range}`);
      assert.ok(s.range[range], `${lang}.range.${range}`);
    }
    assert.match(s.since, /\{date\}/, `${lang}.since`);
  }
});

test('every plural category the language has is written out for plays', () => {
  for (const lang of H.LANGUAGES) {
    const categories = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
    for (const category of categories) assert.ok(H.STRINGS[lang].plays[category], `${lang}.plays.${category}`);
  }
});

test('the wording Activity already uses is the same here', () => {
  const activity = require('../Activity.nepget/script.js');
  for (const lang of H.LANGUAGES) {
    assert.deepEqual(H.STRINGS[lang].plays, activity.STRINGS[lang].plays, `${lang}.plays`);
    assert.equal(H.STRINGS[lang].tooOld, activity.STRINGS[lang].tooOld, `${lang}.tooOld`);
    assert.equal(H.STRINGS[lang].noData, activity.STRINGS[lang].noData, `${lang}.noData`);
    assert.equal(H.STRINGS[lang].noPlays.all, activity.STRINGS[lang].nothingYet, `${lang}.noPlays.all`);
  }
});

test('plays pick the plural form and the host locale\'s digits', () => {
  assert.equal(H.playsText(1, 'en', 'en-US'), '1 play');
  assert.equal(H.playsText(1234, 'en', 'en-US'), '1,234 plays');
  assert.equal(H.playsText(0, 'pt-BR', 'pt-BR'), '0 reproduções');
  assert.equal(H.playsText(5, 'pl', 'pl-PL'), '5 odtworzeń');
  assert.equal(H.playsText(3, 'ar', 'ar-SA'), '٣ مرات تشغيل');
  assert.equal(H.playsText(3, 'en', 'ar_SA'), '3 plays', 'a malformed locale degrades to plain digits');
});

test('hours read as the locale writes a time', () => {
  assert.equal(H.formatHour(21, 'en-GB'), '21:00');
  assert.equal(H.formatHour(21, 'de-DE'), '21:00');
  assert.match(H.formatHour(21, 'en-US'), /^9:00\sPM$/);
});

test('where the full time does not fit, an hour drops its minutes', () => {
  assert.match(H.formatHourCompact(0, 'en-US'), /^12\sAM$/);
  assert.equal(H.formatHourCompact(21, 'de-DE'), '21 Uhr');
});

test('the clock marks are two digits in the locale\'s own numerals', () => {
  assert.equal(H.formatTwoDigits(6, 'en-US'), '06');
  assert.equal(H.formatTwoDigits(0, 'en-US'), '00');
  assert.equal(H.formatTwoDigits(18, 'ar-SA'), '١٨');
});

test('listening time is rounded to the minute', () => {
  assert.equal(H.formatDuration(0, 'en-US'), '0 min');
  assert.equal(H.formatDuration(45 * 60 + 20, 'en-US'), '45 min');
  assert.equal(H.formatDuration(3 * 3600, 'en-US'), '3 hr');
  assert.equal(H.formatDuration(2 * 3600 + 15 * 60, 'en-US'), '2 hr 15 min');
  assert.equal(H.formatDuration(5000, 'ja-JP'), '1 時間 23 分', 'units come from the locale, not English');
});

test('where the words do not fit, listening time is hours and minutes', () => {
  assert.equal(H.formatDurationCompact(77 * 60, 'de-DE'), '1:17');
  assert.equal(H.formatDurationCompact(45 * 60, 'en-US'), '0:45');
  assert.equal(H.formatDurationCompact(0, 'en-US'), '0:00');
});

test('the range caption names the range, or the day history began when it began inside it', () => {
  assert.equal(H.rangeCaption('30d', H.rangeWindow('30d', NOW, at(2025, 1, 1)), 'en', 'en-US'), 'Last 30 days');
  assert.equal(H.rangeCaption('all', H.rangeWindow('all', NOW, at(2025, 1, 1)), 'en', 'en-US'), 'All time');
  assert.equal(H.rangeCaption('30d', H.rangeWindow('30d', NOW, at(2026, 9, 20)), 'en', 'en-US'), 'Since Sep 20');
  assert.equal(H.rangeCaption('7d', null, 'de', 'de-DE'), 'Letzte 7 Tage');
});

test('each settled state without a chart has its line, per range where it matters', () => {
  assert.equal(H.statusText({ kind: 'notRecording' }, '7d', 'en'), H.STRINGS.en.notRecording);
  assert.equal(H.statusText({ kind: 'noPlays' }, '7d', 'en'), 'No plays in the last 7 days');
  assert.equal(H.statusText({ kind: 'noPlays' }, 'all', 'en'), 'Nothing played yet');
  assert.equal(H.statusText({ kind: 'error' }, '7d', 'en'), 'Couldn’t load your listening history');
  assert.equal(H.statusText({ kind: 'tooOld' }, '7d', 'en'), 'Update NepTunes to use this widget');
  assert.equal(H.statusText({ kind: 'clock' }, '7d', 'en'), null);
  assert.equal(H.statusText(null, '7d', 'en'), null);
});

test('the host language picks the table, falling back sensibly', () => {
  assert.equal(H.pickLanguage('pt'), 'pt-BR');
  assert.equal(H.pickLanguage('zh-Hant'), 'zh-Hans');
  assert.equal(H.pickLanguage('de-AT'), 'de');
  assert.equal(H.pickLanguage('xx'), 'en');
  assert.equal(H.pickLanguage(undefined), 'en');
});

// ---- Settings & accent ----------------------------------------------------------

test('settings fall back to their defaults, and a colour is only ever #RRGGBB', () => {
  const defaults = { range: '7d', fixedColor: '#FF375F' };
  const allowed = { range: ['7d', '30d'] };
  assert.deepEqual(H.normalizeSettings({ range: '30d', fixedColor: '#30D158' }, defaults, allowed), { range: '30d', fixedColor: '#30D158' });
  assert.deepEqual(H.normalizeSettings({ range: '90d', fixedColor: 'red' }, defaults, allowed), defaults);
  assert.deepEqual(H.normalizeSettings(null, defaults, allowed), defaults);
});

test('the accent is Activity\'s: a fixed pick, the playing cover, or the app accent with nothing playing', () => {
  const fixed = { accentSource: 'fixed', fixedColor: '#30D158' };
  const album = { accentSource: 'album', fixedColor: '#30D158' };
  assert.deepEqual(H.accentTarget(fixed, 'data:x', true).rgb, [48, 209, 88]);
  assert.equal(H.accentTarget(album, 'data:x', true).url, 'data:x');
  assert.deepEqual(H.accentTarget(album, 'data:x', false).pending, [71, 148, 241]);
  assert.deepEqual(H.accentTarget(album, null, true).rgb, [30, 122, 224]);
  assert.notEqual(H.accentTarget(album, null, true).key, H.accentTarget(album, null, false).key);
  assert.equal(H.accentTarget(fixed, null, true).key, H.accentTarget(fixed, null, false).key);
});

test('the system accent is macOS\'s current systemBlue for the panel\'s appearance, cover or not', () => {
  const system = { accentSource: 'system', fixedColor: '#30D158' };
  assert.deepEqual(H.systemBlue(true), [0, 145, 255], '#0091FF in dark');
  assert.deepEqual(H.systemBlue(false), [0, 136, 255], '#0088FF in light');
  assert.deepEqual(H.accentTarget(system, 'data:x', true).rgb, [0, 145, 255]);
  assert.deepEqual(H.accentTarget(system, null, false).rgb, [0, 136, 255]);
  assert.equal(H.accentTarget(system, 'data:x', true).url, undefined, 'the system blue decodes no cover');
  assert.notEqual(H.accentTarget(system, null, true).key, H.accentTarget(system, null, false).key);
  assert.notEqual(H.accentTarget(system, null, true).key, H.accentTarget({ accentSource: 'album' }, null, true).key);
});

// ---- Page plumbing ----------------------------------------------------------------
// What both page controllers run the same way: the accent repaint, the load / retry / calm
// refresh policy, the refresh schedule, the settings debounce and the host hookup.

function fakeKit({ dark = true } = {}) {
  const decoded = [];
  return {
    decoded,
    panelIsDark: () => dark,
    accent(url) { decoded.push(url); return Promise.resolve({ accent: [10, 20, 30] }); },
    legibleAccent: (rgb, isDark) => rgb.concat(isDark ? 'dark' : 'light'),
  };
}
const fixedSettings = { accentSource: 'fixed', fixedColor: '#30D158', theme: 'auto' };
const albumSettings = { accentSource: 'album', fixedColor: '#30D158', theme: 'auto' };
const host = (url) => ({ getArtworkDataURL: () => url });

test('the accent paints once per change of source, colour, cover or polarity', () => {
  const painted = [];
  const kit = fakeKit();
  const accent = H.accentPainter((rgb) => painted.push(rgb), kit);
  accent.update(fixedSettings, host(null));
  accent.update(fixedSettings, host(null));
  assert.deepEqual(painted, [[48, 209, 88]], 'an unchanged fixed colour is not painted again');
  accent.update({ ...fixedSettings, fixedColor: '#FF0000' }, host(null));
  assert.deepEqual(painted.at(-1), [255, 0, 0]);
  assert.deepEqual(kit.decoded, [], 'a fixed colour decodes no cover');
});

test('a cover paints the app accent first only on the very first paint, then its decoded colour', async () => {
  const painted = [];
  const kit = fakeKit();
  const accent = H.accentPainter((rgb) => painted.push(rgb), kit);
  await accent.update(albumSettings, host('data:one'));
  assert.deepEqual(painted, [[30, 122, 224], [10, 20, 30, 'dark']]);
  await accent.update(albumSettings, host('data:two'));
  assert.deepEqual(painted.slice(2), [[10, 20, 30, 'dark']], 'a later cover keeps the old tint until it is decoded');
  assert.deepEqual(kit.decoded, ['data:one', 'data:two']);
});

test('a cover decoded after the settings moved on is not painted', async () => {
  const painted = [];
  const accent = H.accentPainter((rgb) => painted.push(rgb), fakeKit());
  const decoding = accent.update(albumSettings, host('data:one'));
  accent.update(fixedSettings, host('data:one'));
  await decoding;
  assert.deepEqual(painted, [[30, 122, 224], [48, 209, 88]]);
});

test('a desktop theme flip repaints only an automatic theme', () => {
  const painted = [];
  let dark = true;
  const kit = { ...fakeKit(), panelIsDark: () => dark };
  const accent = H.accentPainter((rgb) => painted.push(rgb), kit);
  accent.update(albumSettings, host(null));
  dark = false;
  accent.themeChanged({ ...albumSettings, theme: 'dark' }, host(null));
  assert.equal(painted.length, 1, 'an explicit theme does not move');
  accent.themeChanged(albumSettings, host(null));
  assert.deepEqual(painted, [[30, 122, 224], [71, 148, 241]]);
});

test('a desktop theme flip moves the system blue to the other appearance\'s', () => {
  const painted = [];
  let dark = true;
  const kit = { ...fakeKit(), panelIsDark: () => dark };
  const accent = H.accentPainter((rgb) => painted.push(rgb), kit);
  const system = { accentSource: 'system', fixedColor: '#30D158', theme: 'auto' };
  accent.update(system, host('data:one'));
  dark = false;
  accent.themeChanged(system, host('data:one'));
  assert.deepEqual(painted, [[0, 145, 255], [0, 136, 255]]);
  assert.deepEqual(kit.decoded, []);
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
    has: (ms) => [...pending.values()].some((t) => t.ms === ms),
    count: (ms) => [...pending.values()].filter((t) => t.ms === ms).length,
    fire(ms) {
      const due = [...pending.entries()].filter(([, t]) => t.ms === ms);
      due.forEach(([id, t]) => { if (t.kind === 'timeout') pending.delete(id); });
      due.forEach(([, t]) => t.fn());
      return due.length;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const codeError = (code) => Object.assign(new Error(String(code)), code ? { code } : {});

/** A load controller over a scripted `load`: each call waits in `loads` until the test settles it. */
function controller({ canLoad = true, range = '7d' } = {}) {
  const timers = fakeTimers();
  const loads = [];
  const page = { renders: 0, loadings: 0, canLoad, range };
  const c = H.loadController({
    contentKind: 'chart',
    initialRange: '7d',
    canLoad: () => page.canLoad,
    range: () => page.range,
    now: () => NOW,
    load(range, now, isCurrent) {
      return new Promise((resolve, reject) => loads.push({ range, now, isCurrent, resolve, reject }));
    },
    onLoading() { page.loadings++; },
    render() { page.renders++; },
    refreshMs: 600000, retryMs: 60000, settingsReloadMs: 400,
    timers,
  });
  return { c, timers, loads, page };
}

test('a load shows loading first, then settles ready on what it found', async () => {
  const { c, loads, page } = controller();
  assert.deepEqual([c.phase, c.result, c.resultRange], ['loading', null, '7d']);
  c.reload(true);
  assert.equal(page.loadings, 1);
  assert.equal(loads.length, 1);
  assert.equal(loads[0].range, '7d');
  assert.equal(loads[0].now, NOW);
  assert.equal(loads[0].isCurrent(), true);
  loads[0].resolve({ kind: 'chart' });
  await settle();
  assert.equal(c.phase, 'ready');
  assert.deepEqual(c.result, { kind: 'chart' });
  assert.equal(c.resultRange, '7d');
});

test('nothing loads before the page can: state and settings both arrived', () => {
  const { c, loads, page } = controller({ canLoad: false });
  c.reload(true);
  assert.equal(loads.length, 0);
  assert.equal(page.renders, 0);
});

test('a refresh over a drawn chart does not go back to loading', async () => {
  const { c, loads, page } = controller();
  c.reload(true);
  loads[0].resolve({ kind: 'chart' });
  await settle();
  c.reload(false);
  assert.equal(page.loadings, 1);
  assert.equal(c.phase, 'ready');
  assert.equal(loads.length, 2);
});

test('a superseded load is ignored, and knows it is no longer current', async () => {
  const { c, loads } = controller();
  c.reload(true);
  c.reload(true);
  assert.equal(loads[0].isCurrent(), false);
  loads[0].resolve({ kind: 'noPlays' });
  loads[1].resolve({ kind: 'chart' });
  await settle();
  assert.deepEqual(c.result, { kind: 'chart' });
});

test('a superseded failure neither shows nor retries', async () => {
  const { c, loads, timers } = controller();
  c.reload(true);
  c.reload(true);
  loads[0].reject(codeError('unavailable'));
  await settle();
  assert.equal(c.phase, 'loading');
  assert.equal(timers.has(60000), false);
});

test('a failed refresh keeps the chart; a failed first load says so; too old says so whatever shows', async () => {
  const { c, loads, timers } = controller();
  c.reload(true);
  loads[0].reject(codeError('unavailable'));
  await settle();
  assert.deepEqual([c.phase, c.result], ['ready', { kind: 'error' }]);
  c.reload(false);
  loads[1].resolve({ kind: 'chart' });
  await settle();
  c.reload(false);
  loads[2].reject(codeError('timeout'));
  await settle();
  assert.deepEqual(c.result, { kind: 'chart' }, 'calm: the chart stays');
  assert.equal(timers.count(60000), 1);
  c.reload(false);
  assert.equal(timers.count(60000), 0, 'a new load clears the pending retry');
  loads[3].reject(codeError('permissionDenied'));
  await settle();
  assert.deepEqual(c.result, { kind: 'tooOld' });
});

test('passing failures retry a minute later; a refused permission or a bad query does not', async () => {
  for (const [code, retries] of [['unavailable', true], ['timeout', true], [undefined, true], ['invalidQuery', false], ['permissionDenied', false]]) {
    const { c, loads, timers } = controller();
    c.reload(true);
    loads[0].reject(codeError(code));
    await settle();
    assert.equal(timers.has(60000), retries, String(code));
    if (retries) {
      timers.fire(60000);
      assert.equal(loads.length, 2, `${code}: the retry loads again`);
    }
  }
});

test('a range change goes back to loading at once and loads once the changes settle', async () => {
  const { c, loads, page, timers } = controller();
  c.settingsChanged(true, false);
  loads[0].resolve({ kind: 'chart' });
  await settle();
  page.range = '30d';
  c.settingsChanged(false, true);
  assert.equal(c.phase, 'loading');
  assert.equal(loads[0].isCurrent(), false);
  c.settingsChanged(false, true);
  assert.equal(timers.count(400), 1, 'a run of changes keeps one pending load');
  assert.equal(loads.length, 1);
  timers.fire(400);
  assert.equal(loads.length, 2);
  assert.equal(loads[1].range, '30d');
});

test('other settings only repaint; the first settings start the first load; without state they only render', () => {
  const waiting = controller({ canLoad: false });
  waiting.c.settingsChanged(true, false);
  assert.deepEqual([waiting.loads.length, waiting.page.renders], [0, 1]);
  const { c, loads, page } = controller();
  c.settingsChanged(true, false);
  assert.equal(loads.length, 1);
  const renders = page.renders;
  c.settingsChanged(false, false);
  assert.equal(loads.length, 1);
  assert.equal(page.renders, renders + 1);
});

test('the first state starts the first load once settings are in; later state renders only when its text moved', () => {
  const { c, loads, page } = controller();
  c.stateChanged(true, false);
  assert.equal(loads.length, 1);
  const renders = page.renders;
  c.stateChanged(false, false);
  assert.equal(page.renders, renders, 'statechange fires on every position tick');
  c.stateChanged(false, true);
  assert.equal(page.renders, renders + 1);
  const early = controller({ canLoad: false });
  early.c.stateChanged(true, false);
  assert.deepEqual([early.loads.length, early.page.renders], [0, 1]);
});

test('the schedule refreshes every ten minutes and at each local midnight', async () => {
  const { c, loads, timers } = controller();
  c.reload(true);
  loads[0].resolve({ kind: 'chart' });
  await settle();
  c.startSchedule();
  const midnight = H.msUntilNextMidnight(NOW);
  assert.equal(timers.count(600000), 1);
  assert.equal(timers.count(midnight), 1);
  timers.fire(600000);
  assert.equal(loads.length, 2);
  timers.fire(midnight);
  assert.equal(loads.length, 3);
  assert.equal(timers.count(midnight), 1, 'the next midnight is scheduled');
  assert.equal(timers.count(600000), 1);
});

test('the host hookup listens, then replays settings and state, then starts, then signals ready', () => {
  const order = [];
  const nt = {
    settings: { range: '7d' }, state: { language: 'en' },
    on(event) { order.push('on:' + event); },
    _signalReady() { order.push('ready'); },
  };
  const connected = H.connectHost(nt, {
    settingschange: (s) => order.push('settings:' + s.range),
    statechange: (s) => order.push('state:' + s.language),
    themechange() {}, pointermove() {}, pointerleave() {},
    beforeReplay: () => order.push('resize'),
    started: () => order.push('started'),
  });
  assert.equal(connected, true);
  assert.deepEqual(order, ['on:settingschange', 'on:statechange', 'on:themechange', 'on:pointermove', 'on:pointerleave',
    'resize', 'settings:7d', 'state:en', 'started', 'ready']);
  assert.equal(H.connectHost(undefined, {}), false, 'no host, nothing to hook');
});

// ---- Vendoring ------------------------------------------------------------------

test('every bundle that vendors history-stats.js carries this exact master', () => {
  const master = readFileSync(new URL('./history-stats.js', import.meta.url));
  const root = new URL('../', import.meta.url);
  const copies = readdirSync(root)
    .filter((name) => name.endsWith('.nepget'))
    .filter((name) => existsSync(new URL(`${name}/history-stats.js`, root)));
  assert.deepEqual(copies.sort(), ['GenreTrends.nepget', 'ListeningClock.nepget']);
  for (const name of copies) {
    assert.ok(readFileSync(new URL(`${name}/history-stats.js`, root)).equals(master), `${name}: stale history-stats.js — re-copy the master, then re-sign`);
  }
});

test('the stats bundles point at no other app\'s sources: SampleWidgets is mirrored to a public repo', () => {
  const root = new URL('../', import.meta.url);
  for (const name of ['GenreTrends.nepget', 'ListeningClock.nepget']) {
    for (const file of readdirSync(new URL(`${name}/`, root)).filter((f) => /\.(js|css|html|json)$/.test(f))) {
      assert.doesNotMatch(readFileSync(new URL(`${name}/${file}`, root), 'utf8'), /winyl/i, `${name}/${file}`);
    }
  }
});
