import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// NepTunesKitTests/ScrobbleActivityTests.swift runs against an explicit Warsaw calendar. The
// port runs in the process's local zone, as the widget does in the host, so the zone is pinned
// here instead — before any Date is built (Node re-reads TZ on assignment). The cases below are
// that suite's cases, with its dates.
process.env.TZ = 'Europe/Warsaw';

const require = createRequire(import.meta.url);
globalThis.NTKit = require('../Activity.nepget/neptunes-kit.js');
const Activity = require('../Activity.nepget/script.js');

const MONDAY = 1;
const SATURDAY = 6;
const SUNDAY = 7;
const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const NOW = at(2026, 9, 21, 12);   // a Monday
const find = (activity, key) => activity.days.find((day) => day.key === key);

// ---- Model ----------------------------------------------------------------

test('six full weeks plus the current one, oldest first, ending on today', () => {
  const a = Activity.fromScrobbleDates([], NOW, MONDAY, true);
  assert.equal(a.days.length, 43);
  assert.equal(a.days[0].key, '2026-08-10');
  assert.equal(a.days.at(-1).key, '2026-09-21');
  assert.ok(a.days.every((d) => d.count === 0 && d.level === 0));
  assert.equal(Activity.totalCount(a), 0);
});

test('the window opens on the first weekday, so Sunday-first weeks start a day earlier', () => {
  const a = Activity.fromScrobbleDates([], NOW, SUNDAY, true);
  assert.equal(a.days.length, 44);
  assert.equal(a.days[0].key, '2026-08-09');
  assert.equal(Activity.dayKey(Activity.windowStart(NOW, SUNDAY)), '2026-08-09');
});

test('Saturday-first weeks, the other override the setting offers, open two days back', () => {
  const a = Activity.fromScrobbleDates([], NOW, SATURDAY, true);
  assert.equal(a.days.length, 45);
  assert.equal(a.days[0].key, '2026-08-08');
});

test('on the last day of the week the window is seven full weeks', () => {
  const a = Activity.fromScrobbleDates([], at(2026, 9, 27, 12), MONDAY, true);
  assert.equal(a.days.length, 49);
  assert.equal(a.days[0].key, '2026-08-10');
});

test('scrobbles are bucketed by the local day, not UTC', () => {
  const lateUTC = new Date(Date.UTC(2026, 8, 20, 23, 30));   // 01:30 on the 21st in Warsaw
  const a = Activity.fromScrobbleDates([lateUTC, at(2026, 9, 20, 9)], NOW, MONDAY, true);
  assert.equal(a.days.at(-1).count, 1);
  assert.equal(find(a, '2026-09-20').count, 1);
  assert.equal(Activity.totalCount(a), 2);
});

test('dates outside the window are ignored', () => {
  const a = Activity.fromScrobbleDates([at(2026, 8, 9, 23), at(2026, 9, 22)], NOW, MONDAY, true);
  assert.equal(Activity.totalCount(a), 0);
});

test("levels come from the user's own distribution: four distinct days over four levels", () => {
  const dates = [];
  for (const [offset, count] of [[0, 40], [1, 30], [2, 20], [3, 10]]) {
    for (let i = 0; i < count; i++) dates.push(at(2026, 9, 21 - offset, 12));
  }
  const a = Activity.fromScrobbleDates(dates, NOW, MONDAY, true);
  assert.deepEqual(a.days.slice(-4).map((d) => d.level), [1, 2, 3, 4]);
  assert.equal(a.days.at(-5).level, 0);
});

test('the same amount every day lights the whole grid, not a pale one', () => {
  const dates = Array.from({ length: 43 }, (_, i) => at(2026, 9, 21 - i, 12));
  const a = Activity.fromScrobbleDates(dates, NOW, MONDAY, true);
  assert.ok(a.days.every((d) => d.level === Activity.MAX_LEVEL));
});

test('when the fetch was capped, days at and before the oldest scrobble seen are unknown', () => {
  const dates = [at(2026, 9, 10, 8), at(2026, 9, 15, 8), at(2026, 9, 21, 8)];
  const a = Activity.fromScrobbleDates(dates, NOW, MONDAY, false);
  assert.equal(find(a, '2026-09-10').count, null);
  assert.equal(a.days[0].count, null);
  assert.equal(find(a, '2026-09-11').count, 0);
  assert.equal(a.days.at(-1).count, 1);
  assert.equal(a.isComplete, false);
});

test('a capped fetch that saw nothing leaves every day unknown', () => {
  const a = Activity.fromScrobbleDates([], NOW, MONDAY, false);
  assert.ok(a.days.every((d) => d.count === null && d.level === 0));
});

test('level() is the Swift ramp: ceil(share × 4), clamped, 0 for silence', () => {
  assert.equal(Activity.level(0, [1, 2, 3]), 0);
  assert.equal(Activity.level(5, []), 0);
  assert.equal(Activity.level(1, [1, 2, 3]), 2);     // 1/3 × 4 = 1.33 → 2
  assert.equal(Activity.level(3, [1, 2, 3]), 4);
  assert.equal(Activity.level(1, [1, 1, 1, 9]), 3);  // 3/4 × 4 = 3
});

test('history day totals: days before the first recorded play are unknown, not silent', () => {
  const rows = [
    { date: '2026-09-20', plays: 4, seconds: 900 },
    { date: '2026-09-21', plays: 2, seconds: 400 },
    { date: '2026-01-01', plays: 99, seconds: 1 },         // outside the window
  ];
  const since = new Date(Date.UTC(2026, 8, 15, 18));        // 20:00 on the 15th in Warsaw
  const a = Activity.fromDayCounts(rows, NOW, MONDAY, since);
  assert.equal(find(a, '2026-09-14').count, null);
  assert.equal(find(a, '2026-09-15').count, 0);
  assert.equal(find(a, '2026-09-20').count, 4);
  assert.deepEqual([find(a, '2026-09-20').level, find(a, '2026-09-21').level], [4, 2]);
  assert.equal(Activity.totalCount(a), 6);
  assert.equal(a.isComplete, false);
});

test('history older than the window leaves every day known', () => {
  const a = Activity.fromDayCounts([], NOW, MONDAY, at(2025, 1, 1));
  assert.ok(a.days.every((d) => d.count === 0));
  assert.equal(a.isComplete, true);
});

test("history that began during the window's first day leaves that day known", () => {
  const a = Activity.fromDayCounts([], NOW, MONDAY, at(2026, 8, 10, 10));
  assert.equal(a.days.filter((d) => d.count === null).length, 0);
  assert.equal(a.isComplete, true);
});

test('calendar arithmetic survives a DST change inside the window', () => {
  const a = Activity.fromScrobbleDates([], at(2026, 11, 8, 12), SUNDAY, true);   // Warsaw fell back on 25 Oct
  assert.equal(a.days.length, 43);
  assert.equal(new Set(a.days.map((d) => d.key)).size, 43);
  assert.ok(a.days.every((d) => d.date.getHours() === 0));
});

// ---- First day of the week ------------------------------------------------
// firstWeekday(settingValue, state): ISO 1 = Monday … 7 = Sunday. The widget's own
// `firstWeekday` select wins; otherwise the host's state.firstWeekday (NepTunes 4.1+);
// otherwise the locale's week data; otherwise Monday. The function is the copyable one in
// Docs/WidgetDevelopment.md → "First day of the week"; NTKit does not carry it.

test('firstWeekday honours an explicit override whatever the host says', () => {
  const state = { firstWeekday: 3, locale: 'en-US' };
  assert.equal(Activity.firstWeekday('monday', state), 1);
  assert.equal(Activity.firstWeekday('saturday', state), 6);
  assert.equal(Activity.firstWeekday('sunday', state), 7);
});

test('firstWeekday follows the host for system, unset or unknown settings', () => {
  assert.equal(Activity.firstWeekday('system', { firstWeekday: 7 }), 7);
  assert.equal(Activity.firstWeekday(undefined, { firstWeekday: 1 }), 1);
  assert.equal(Activity.firstWeekday('fortnightly', { firstWeekday: 6 }), 6);
  // Only the options' own keys count as overrides, never inherited ones.
  assert.equal(Activity.firstWeekday('toString', { firstWeekday: 6 }), 6);
});

test('firstWeekday ignores a host value that is not an ISO weekday', () => {
  for (const bad of [0, 8, 1.5, '1', null]) {
    assert.equal(Activity.firstWeekday('system', { firstWeekday: bad }), 1, `host value ${bad}`);
  }
});

test('firstWeekday falls back to Monday with nothing to go on', () => {
  assert.equal(Activity.firstWeekday('system', null), 1);
  assert.equal(Activity.firstWeekday('system', {}), 1);
  // An ICU identifier makes Intl.Locale throw; that must not take the widget down.
  assert.equal(Activity.firstWeekday('system', { locale: 'ar_SA' }), 1);
});

const hasWeekInfo = (() => {
  try {
    const l = new Intl.Locale('en-US');
    return !!(typeof l.getWeekInfo === 'function' ? l.getWeekInfo() : l.weekInfo);
  } catch { return false; }
})();

test('firstWeekday reads the locale when an older host sends no firstWeekday', { skip: !hasWeekInfo }, () => {
  assert.equal(Activity.firstWeekday('system', { locale: 'en-US' }), 7);
  assert.equal(Activity.firstWeekday('system', { locale: 'pl-PL' }), 1);
});

// ---- Loading --------------------------------------------------------------
// ScrobbleActivityLoaderTests' cases, against the raw Last.fm body the passthrough returns.

function lastFmError(code) { const error = new Error(code); error.code = code; return error; }
const scrobble = (date, name = 't', artist = 'a') => ({ name, artist: { '#text': artist }, date: { uts: String(Math.floor(date / 1000)), '#text': '' } });
// Every track a distinct scrobble: the loader counts a repeated one once.
const recentPage = (page, totalPages, dates, extra = []) => ({
  recenttracks: {
    track: [...extra, ...dates.map((date, i) => scrobble(date, `t${page}-${i}`))],
    '@attr': { page: String(page), totalPages: String(totalPages), total: String(totalPages * 200), perPage: '200', user: 'u' },
  },
});

test('a single page covers everything, asked for with the window and the page size', async () => {
  const requests = [];
  const a = await Activity.loadLastFmActivity({
    now: NOW, firstWeekday: MONDAY,
    call: async (method, params) => { requests.push({ method, params }); return recentPage(1, 1, [NOW]); },
  });
  assert.deepEqual(requests, [{
    method: 'user.getRecentTracks',
    params: { from: String(at(2026, 8, 10) / 1000), to: String(NOW / 1000), page: '1', limit: '200' },
  }]);
  assert.ok(a.isComplete);
  assert.equal(Activity.totalCount(a), 1);
});

test('every further page is fetched, three at a time, and all of them count', async () => {
  const requested = [];
  let inFlight = 0;
  let peak = 0;
  const a = await Activity.loadLastFmActivity({
    now: NOW, firstWeekday: MONDAY,
    call: async (method, params) => {
      requested.push(Number(params.page));
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return recentPage(Number(params.page), 5, [NOW]);
    },
  });
  assert.deepEqual(requested.sort((x, y) => x - y), [1, 2, 3, 4, 5]);
  assert.equal(peak, 3);
  assert.equal(Activity.totalCount(a), 5);
  assert.ok(a.isComplete);
});

// A day's exact total, as user.getRecentTracks reports it for a one-day window asked for with
// limit=1: `@attr.total` is the count; the one track (and any now-playing entry) is not.
const nowPlayingTrack = { name: 'live', artist: { '#text': 'a' }, '@attr': { nowplaying: 'true' } };
const dayTotalBody = (total, fromSeconds) => ({
  recenttracks: {
    track: total > 0 ? [nowPlayingTrack, scrobble(new Date(fromSeconds * 1000 + 3600000))] : [nowPlayingTrack],
    '@attr': { page: '1', totalPages: String(total), total: String(total), perPage: '1', user: 'u' },
  },
});
const isDayRequest = (params) => params.limit === '1';

/**
 * An account past the page cap: 20 pages of 200, of which the newest 15 are fetched. Page p
 * holds one scrobble at noon on 22 − p September, so the fetched pages reach back to noon on
 * 7 September; each day's true total is `dayTotal(date)`.
 */
function overCapAccount({ dayTotal = (d) => d.getDate() % 4, onDay, onPage, delay = 0 } = {}) {
  const log = { pages: [], days: [], inFlight: 0, peak: 0 };
  const call = async (method, params) => {
    log.inFlight++; log.peak = Math.max(log.peak, log.inFlight);
    try {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (isDayRequest(params)) {
        log.days.push(params);
        const from = new Date(Number(params.from) * 1000);
        if (onDay) await onDay(from);
        return dayTotalBody(dayTotal(from), Number(params.from));
      }
      const page = Number(params.page);
      log.pages.push(page);
      if (onPage) onPage(page);
      return recentPage(page, 20, [at(2026, 9, 22 - page, 12)]);
    } finally {
      log.inFlight--;
    }
  };
  return { call, log };
}

test('past the page cap no more than the cap of pages is fetched', async () => {
  const { call, log } = overCapAccount();
  await Activity.loadLastFmActivity({ now: NOW, firstWeekday: MONDAY, call });
  assert.equal(log.pages.length, 15);
  assert.equal(Math.max(...log.pages), 15);
});

test('past the page cap every older day is counted exactly from its own day total', async () => {
  const { call, log } = overCapAccount({ delay: 2 });
  const a = await Activity.loadLastFmActivity({ now: NOW, firstWeekday: MONDAY, call });
  // 10 August (the window's first day) through 7 September, the oldest fetched day, inclusive.
  assert.equal(log.days.length, 29);
  assert.ok(a.days.every((d) => d.count !== null), 'no day is unknown');
  assert.equal(a.isComplete, true);
  assert.equal(find(a, '2026-08-10').count, 10 % 4);
  assert.equal(find(a, '2026-09-06').count, 6 % 4);
  // The oldest fetched day was only partly fetched: its day total replaces the page's one scrobble.
  assert.equal(find(a, '2026-09-07').count, 7 % 4);
  // Days the pages covered in full keep the pages' count.
  assert.equal(find(a, '2026-09-08').count, 1);
  assert.equal(find(a, '2026-09-21').count, 1);
  assert.ok(log.peak <= Activity.MAX_CONCURRENT_PAGES, `peak ${log.peak} requests in flight`);
});

test('a day total is asked for with that local day as the window, one track per page', async () => {
  const { call, log } = overCapAccount();
  await Activity.loadLastFmActivity({ now: NOW, firstWeekday: MONDAY, call });
  const first = log.days.find((p) => p.from === String(at(2026, 8, 10) / 1000));
  assert.deepEqual(first, { from: String(at(2026, 8, 10) / 1000), to: String(at(2026, 8, 11) / 1000 - 1), page: '1', limit: '1' });
  const last = log.days.find((p) => p.from === String(at(2026, 9, 7) / 1000));
  assert.deepEqual(last, { from: String(at(2026, 9, 7) / 1000), to: String(at(2026, 9, 8) / 1000 - 1), page: '1', limit: '1' });
});

test('day totals follow the calendar across a DST change', async () => {
  // Warsaw leaves summer time on 25 October 2026, a 25-hour day. Monday 2 November's window
  // opens on 21 September; the pages reach back only to 30 October.
  const now = at(2026, 11, 2, 12);
  const days = [];
  const a = await Activity.loadLastFmActivity({
    now, firstWeekday: MONDAY,
    call: async (method, params) => {
      if (isDayRequest(params)) { days.push(params); return dayTotalBody(2, Number(params.from)); }
      const page = Number(params.page);
      return recentPage(page, 20, [at(2026, 11, 2, 12 - Math.min(page, 11)), ...(page === 15 ? [at(2026, 10, 30, 12)] : [])]);
    },
  });
  const dstDay = days.find((p) => p.from === String(at(2026, 10, 25) / 1000));
  assert.equal(Number(dstDay.to) - Number(dstDay.from), 25 * 3600 - 1);
  assert.equal(dstDay.to, String(at(2026, 10, 26) / 1000 - 1));
  assert.equal(days.length, 40);   // 21 September through 30 October
  assert.ok(a.days.every((d) => d.count !== null));
  assert.equal(find(a, '2026-10-25').count, 2);
});

test('an account within the page cap asks for no day totals', async () => {
  const requests = [];
  await Activity.loadLastFmActivity({
    now: NOW, firstWeekday: MONDAY,
    call: async (method, params) => { requests.push(params); return recentPage(Number(params.page), 15, [at(2026, 9, 10, 12)]); },
  });
  assert.equal(requests.length, 15);
  assert.ok(requests.every((p) => p.limit === '200'));
});

test('a day total that fails fails the load, rather than leaving that day unknown', async () => {
  const { call } = overCapAccount({
    onDay: (from) => { if (from.getDate() === 20) throw lastFmError('rateLimited'); },
  });
  await assert.rejects(Activity.loadLastFmActivity({ now: NOW, firstWeekday: MONDAY, call, retryDelays: [] }), { code: 'rateLimited' });
});

test('a day total without @attr.total fails the load rather than counting the day as its tracks', async () => {
  for (const attr of [undefined, { page: '1', totalPages: '1' }, { page: '1', totalPages: '1', total: 'lots' }]) {
    const { call } = overCapAccount();
    const failing = async (method, params) => {
      if (isDayRequest(params)) {
        const body = { recenttracks: { track: [scrobble(new Date(Number(params.from) * 1000))] } };
        if (attr) body.recenttracks['@attr'] = attr;
        return body;
      }
      return call(method, params);
    };
    await assert.rejects(Activity.loadLastFmActivity({ now: NOW, firstWeekday: MONDAY, call: failing }),
      (error) => typeof error.code === 'string');
  }
});

test('a load superseded while its pages were out asks for no day totals', async () => {
  let current = true;
  const { call, log } = overCapAccount({ onPage: (page) => { if (page === 15) current = false; } });
  await assert.rejects(Activity.loadLastFmActivity({ now: NOW, firstWeekday: MONDAY, call, isCurrent: () => current }),
    { code: 'superseded' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(log.days.length, 0);
});

test('a load superseded during its day totals asks for no more of them', async () => {
  let current = true;
  const { call, log } = overCapAccount({
    delay: 5,
    onDay: (from) => { if (from.getDate() === 10 && from.getMonth() === 7) current = false; },
  });
  await assert.rejects(Activity.loadLastFmActivity({ now: NOW, firstWeekday: MONDAY, call, isCurrent: () => current }),
    { code: 'superseded' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(log.days.length <= Activity.MAX_CONCURRENT_PAGES, `${log.days.length} day totals asked for`);
});

test('a scrobble landing mid-load shifts the pages, and the one repeated at a page boundary counts once', async () => {
  const boundary = at(2026, 9, 20, 9);
  const a = await Activity.loadLastFmActivity({
    now: NOW, firstWeekday: MONDAY,
    call: async (method, params) => ({
      recenttracks: {
        // Page 1 ended with `boundary`; a new scrobble then pushed it onto page 2 as well.
        track: params.page === '1'
          ? [scrobble(NOW, 'a', 'x'), scrobble(boundary, 'b', 'x')]
          : [scrobble(boundary, 'b', 'x'), scrobble(new Date(boundary - 60000), 'c', 'x')],
        '@attr': { page: params.page, totalPages: '2', total: '4' },
      },
    }),
  });
  assert.equal(Activity.totalCount(a), 3);
  assert.equal(find(a, '2026-09-20').count, 2);
});

test('different tracks scrobbled in the same second are different scrobbles', async () => {
  const a = await Activity.loadLastFmActivity({
    now: NOW, firstWeekday: MONDAY,
    call: async () => ({
      recenttracks: {
        track: [scrobble(NOW, 'a', 'x'), scrobble(NOW, 'b', 'x'), scrobble(NOW, 'a', 'y'),
          { name: 'a', artist: { name: 'z' }, date: { uts: String(Math.floor(NOW / 1000)) } }],
        '@attr': { page: '1', totalPages: '1', total: '4' },
      },
    }),
  });
  assert.equal(Activity.totalCount(a), 4);
});

test('the now-playing entry has no date and is not a scrobble', async () => {
  const nowPlaying = { name: 'live', artist: { '#text': 'a' }, '@attr': { nowplaying: 'true' } };
  const a = await Activity.loadLastFmActivity({
    now: NOW, firstWeekday: MONDAY,
    call: async () => recentPage(1, 1, [NOW], [nowPlaying]),
  });
  assert.equal(Activity.totalCount(a), 1);
});

test('a page holding one scrobble arrives as an object, not an array, and still counts', async () => {
  const a = await Activity.loadLastFmActivity({
    now: NOW, firstWeekday: MONDAY,
    call: async () => ({ recenttracks: { track: scrobble(NOW), '@attr': { page: '1', totalPages: '1', total: '1' } } }),
  });
  assert.equal(Activity.totalCount(a), 1);
});

test('a page that fails fails the load', async () => {
  await assert.rejects(Activity.loadLastFmActivity({
    now: NOW, firstWeekday: MONDAY, retryDelays: [],
    call: async (method, params) => (params.page === '1' ? recentPage(1, 3, [NOW]) : Promise.reject(lastFmError('network'))),
  }), { code: 'network' });
});

test('once a page has failed no further pages are asked for', async () => {
  const requested = [];
  await assert.rejects(Activity.loadLastFmActivity({
    now: NOW, firstWeekday: MONDAY, retryDelays: [],
    call: async (method, params) => {
      const page = Number(params.page);
      requested.push(page);
      if (page === 1) return recentPage(1, 15, [NOW]);
      if (page === 2) throw lastFmError('rateLimited');
      await new Promise((resolve) => setTimeout(resolve, 10));
      return recentPage(page, 15, [NOW]);
    },
  }), { code: 'rateLimited' });
  await new Promise((resolve) => setTimeout(resolve, 100));   // let the other workers settle
  assert.deepEqual(requested.sort((x, y) => x - y), [1, 2, 3, 4]);
});

test('a load that has been superseded asks for no further pages', async () => {
  const requested = [];
  let current = true;
  await assert.rejects(Activity.loadLastFmActivity({
    now: NOW, firstWeekday: MONDAY,
    isCurrent: () => current,
    call: async (method, params) => {
      const page = Number(params.page);
      requested.push(page);
      if (page === 1) return recentPage(1, 15, [NOW]);
      // A newer load starts while pages 2–4 are out, just as page 2 answers.
      await new Promise((resolve) => setTimeout(resolve, page === 2 ? 5 : 10));
      if (page === 2) current = false;
      return recentPage(page, 15, [NOW]);
    },
  }), { code: 'superseded' });
  await new Promise((resolve) => setTimeout(resolve, 100));   // let the other workers settle
  assert.deepEqual(requested.sort((x, y) => x - y), [1, 2, 3, 4]);
});

// ---- Retrying a request ----------------------------------------------------
// A request that fails for a passing reason is asked again, twice at most, after about a
// second and then about three: one flaky page would otherwise throw away the other fourteen.

const noWait = (waits = []) => (ms) => { waits.push(ms); return Promise.resolve(); };

test('the default backoff is about a second, then about three', () => {
  assert.deepEqual(Activity.RETRY_DELAYS_MS, [1000, 3000]);
});

test('a page that fails for a passing reason is asked again and the load succeeds', async () => {
  for (const code of ['network', 'timeout', 'rateLimited', 'lastFm:8', 'lastFm:11', 'lastFm:16', 'lastFm:29']) {
    const requested = [];
    const waits = [];
    let failures = 0;
    const a = await Activity.loadLastFmActivity({
      now: NOW, firstWeekday: MONDAY, wait: noWait(waits),
      call: async (method, params) => {
        requested.push(Number(params.page));
        if (params.page === '2' && failures++ === 0) throw lastFmError(code);
        return recentPage(Number(params.page), 3, [NOW]);
      },
    });
    assert.equal(Activity.totalCount(a), 3, code);
    assert.deepEqual(requested.sort((x, y) => x - y), [1, 2, 2, 3], code);
    assert.deepEqual(waits, [1000], code);
  }
});

test('a request is tried three times in all, waiting a second and then three, before the load fails', async () => {
  const waits = [];
  let requests = 0;
  await assert.rejects(Activity.loadLastFmActivity({
    now: NOW, firstWeekday: MONDAY, wait: noWait(waits),
    call: async () => { requests++; throw lastFmError('timeout'); },
  }), { code: 'timeout' });
  assert.equal(requests, 3);
  assert.deepEqual(waits, [1000, 3000]);
});

test('a failure that asking again cannot fix is not retried', async () => {
  for (const code of ['notSignedIn', 'permissionDenied', 'methodNotAllowed', 'superseded', 'lastFm:6', 'tooLarge', 'badResponse']) {
    let requests = 0;
    await assert.rejects(Activity.loadLastFmActivity({
      now: NOW, firstWeekday: MONDAY, wait: noWait(),
      call: async () => { requests++; throw lastFmError(code); },
    }), { code });
    assert.equal(requests, 1, code);
  }
});

test('a day total that fails for a passing reason is asked again', async () => {
  const failedOnce = new Set();
  const { call, log } = overCapAccount({
    onDay: (from) => {
      if (from.getDate() === 20 && !failedOnce.has(20)) { failedOnce.add(20); throw lastFmError('lastFm:29'); }
    },
  });
  const a = await Activity.loadLastFmActivity({ now: NOW, firstWeekday: MONDAY, call, wait: noWait() });
  assert.equal(log.days.length, 30);   // 29 days, one of them asked for twice
  assert.equal(find(a, '2026-08-20').count, 20 % 4);
});

test('a load superseded while it waits to retry asks for nothing more', async () => {
  let current = true;
  let requests = 0;
  await assert.rejects(Activity.loadLastFmActivity({
    now: NOW, firstWeekday: MONDAY, isCurrent: () => current,
    wait: () => { current = false; return Promise.resolve(); },
    call: async () => { requests++; throw lastFmError('network'); },
  }), { code: 'superseded' });
  assert.equal(requests, 1);
});

// ---- Refreshing from memory ---------------------------------------------------
// A completed past day's count does not change, so a refresh on the same day, over the same
// window, asks Last.fm for today's total alone and takes every earlier day from the last load.

const LATER = at(2026, 9, 21, 18, 30);   // the same Monday as NOW, later on

function recordingAccount(log = []) {
  return {
    log,
    call: async (method, params) => {
      log.push(params);
      if (isDayRequest(params)) return dayTotalBody(7, Number(params.from));
      return recentPage(1, 1, [at(2026, 9, 14, 12), at(2026, 9, 14, 13), at(2026, 8, 10, 9), NOW]);
    },
  };
}

test('a full load remembers every completed day before today, and not today', async () => {
  const { call } = recordingAccount();
  const { activity, memo } = await Activity.refreshLastFmActivity({ now: NOW, firstWeekday: MONDAY, user: 'rj', call, memo: null });
  assert.equal(Activity.totalCount(activity), 4);
  assert.equal(memo.date, '2026-09-21');
  assert.equal(memo.windowStart, '2026-08-10');
  assert.equal(memo.firstWeekday, MONDAY);
  assert.equal(Object.keys(memo.counts).length, 42);   // 10 August through 20 September
  assert.equal(memo.counts['2026-09-14'], 2);
  assert.equal(memo.counts['2026-08-10'], 1);
  assert.equal(memo.counts['2026-09-15'], 0);
  assert.ok(!('2026-09-21' in memo.counts));
  assert.equal(memo.user, 'rj');
});

test('a refresh with every past day remembered asks for exactly one thing: today', async () => {
  const first = await Activity.refreshLastFmActivity({ now: NOW, firstWeekday: MONDAY, user: 'rj', call: recordingAccount().call, memo: null });
  const { call, log } = recordingAccount();
  const { activity, memo } = await Activity.refreshLastFmActivity({ now: LATER, firstWeekday: MONDAY, user: 'rj', call, memo: first.memo });
  assert.deepEqual(log, [{ from: String(at(2026, 9, 21) / 1000), to: String(Math.floor(LATER / 1000)), page: '1', limit: '1' }]);
  assert.equal(find(activity, '2026-09-21').count, 7);
  assert.equal(find(activity, '2026-09-14').count, 2);
  assert.equal(find(activity, '2026-08-10').count, 1);
  assert.ok(activity.isComplete);
  assert.ok(activity.days.every((d) => d.count !== null));
  assert.deepEqual(memo, first.memo);
});

test('the first refresh of a new day loads everything again', async () => {
  const first = await Activity.refreshLastFmActivity({ now: NOW, firstWeekday: MONDAY, user: 'rj', call: recordingAccount().call, memo: null });
  const { call, log } = recordingAccount();
  const tomorrow = at(2026, 9, 22, 0, 5);
  const { memo } = await Activity.refreshLastFmActivity({ now: tomorrow, firstWeekday: MONDAY, user: 'rj', call, memo: first.memo });
  assert.equal(log[0].limit, '200');
  assert.equal(memo.date, '2026-09-22');
});

test('a different window loads everything again', async () => {
  const first = await Activity.refreshLastFmActivity({ now: NOW, firstWeekday: MONDAY, user: 'rj', call: recordingAccount().call, memo: null });
  const { call, log } = recordingAccount();
  const { memo } = await Activity.refreshLastFmActivity({ now: LATER, firstWeekday: SUNDAY, user: 'rj', call, memo: first.memo });
  assert.equal(log[0].limit, '200');
  assert.equal(log[0].from, String(at(2026, 8, 9) / 1000));   // Sunday-first opens a day earlier
  assert.equal(memo.firstWeekday, SUNDAY);
});

test('a memory missing any past day of the window loads everything again', async () => {
  const first = await Activity.refreshLastFmActivity({ now: NOW, firstWeekday: MONDAY, user: 'rj', call: recordingAccount().call, memo: null });
  const counts = { ...first.memo.counts };
  delete counts['2026-09-01'];
  const { call, log } = recordingAccount();
  await Activity.refreshLastFmActivity({ now: LATER, firstWeekday: MONDAY, user: 'rj', call, memo: { ...first.memo, counts } });
  assert.equal(log[0].limit, '200');
});

test("today's total is retried like any other request, and a failure fails the refresh", async () => {
  const first = await Activity.refreshLastFmActivity({ now: NOW, firstWeekday: MONDAY, user: 'rj', call: recordingAccount().call, memo: null });
  let requests = 0;
  await assert.rejects(Activity.refreshLastFmActivity({
    now: LATER, firstWeekday: MONDAY, user: 'rj', memo: first.memo, wait: noWait(),
    call: async () => { requests++; throw lastFmError('network'); },
  }), { code: 'network' });
  assert.equal(requests, 3);
});

// Past days are keyed by local day: in another time zone the same keys cover other instants.
function inTimeZone(zone, body) {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  try { return body(); } finally { process.env.TZ = saved; }
}

test('a memory filled in another time zone loads everything again', async () => {
  const first = await Activity.refreshLastFmActivity({ now: NOW, firstWeekday: MONDAY, user: 'rj', call: recordingAccount().call, memo: null });
  assert.equal(Activity.memoCovers(first.memo, LATER, MONDAY, 'rj'), true);
  // Noon and half past six in Warsaw are still 21 September in London: only the zone differs.
  assert.equal(inTimeZone('Europe/London', () => Activity.memoCovers(first.memo, LATER, MONDAY, 'rj')), false);
  const { call, log } = recordingAccount();
  const saved = process.env.TZ;
  process.env.TZ = 'Europe/London';
  try {
    const { memo } = await Activity.refreshLastFmActivity({ now: LATER, firstWeekday: MONDAY, user: 'rj', call, memo: first.memo });
    assert.equal(log[0].limit, '200');
    assert.equal(Activity.memoCovers(memo, LATER, MONDAY, 'rj'), true);
  } finally {
    process.env.TZ = saved;
  }
});

/** A Last.fm double signed in as `account.name`, logging every request but the probe. */
function signedInAs(account, log = [], probes = []) {
  return {
    lastFm: {
      call: async (method, params) => {
        if (method === 'user.getInfo') { probes.push(account.name); return account.name === undefined ? { user: {} } : { user: { name: account.name } }; }
        log.push(params);
        return isDayRequest(params) ? dayTotalBody(2, Number(params.from)) : recentPage(1, 1, [NOW]);
      },
    },
  };
}

test('loadActivity hands back the memory from Last.fm and refreshes from it', async () => {
  const log = [];
  const nt = signedInAs({ name: 'rj' }, log);
  const first = await Activity.loadActivity({ setting: 'lastfm', nt, now: NOW, firstWeekday: MONDAY, memo: null });
  assert.ok(first.memo);
  assert.equal(first.memo.user, 'rj');
  log.length = 0;
  const next = await Activity.loadActivity({ setting: 'lastfm', nt, now: LATER, firstWeekday: MONDAY, memo: first.memo });
  assert.equal(log.length, 1);
  assert.equal(log[0].limit, '1');
  assert.equal(next.kind, 'grid');
  assert.equal(find(next.activity, '2026-09-21').count, 2);

  const plays = await Activity.loadActivity({ setting: 'history', nt: withHistory({}), now: NOW, firstWeekday: MONDAY, memo: first.memo });
  assert.equal(plays.memo, undefined);
});

// ---- The memory belongs to one Last.fm account ------------------------------------
// Switching accounts must not show the previous account's past days until midnight.

test('a memory filled for another account loads everything again', async () => {
  const first = await Activity.refreshLastFmActivity({ now: NOW, firstWeekday: MONDAY, user: 'rj', call: recordingAccount().call, memo: null });
  const { call, log } = recordingAccount();
  const { memo } = await Activity.refreshLastFmActivity({ now: LATER, firstWeekday: MONDAY, user: 'someone-else', call, memo: first.memo });
  assert.equal(log[0].limit, '200');
  assert.equal(memo.user, 'someone-else');
});

test('without a known account the memory is never used', async () => {
  const first = await Activity.refreshLastFmActivity({ now: NOW, firstWeekday: MONDAY, user: 'rj', call: recordingAccount().call, memo: null });
  const { call, log } = recordingAccount();
  await Activity.refreshLastFmActivity({ now: LATER, firstWeekday: MONDAY, user: null, call, memo: first.memo });
  assert.equal(log[0].limit, '200');
  assert.equal(Activity.memoCovers(first.memo, LATER, MONDAY, undefined), false);
  assert.equal(Activity.memoCovers(first.memo, LATER, MONDAY, 'rj'), true);
});

for (const setting of ['lastfm', 'auto']) {
  test(`${setting}: switching Last.fm accounts forces a full load`, async () => {
    const account = { name: 'rj' };
    const log = [];
    const nt = withHistory(signedInAs(account, log));
    const first = await Activity.loadActivity({ setting, nt, now: NOW, firstWeekday: MONDAY, memo: null });
    account.name = 'someone-else';
    log.length = 0;
    const next = await Activity.loadActivity({ setting, nt, now: LATER, firstWeekday: MONDAY, memo: first.memo });
    assert.equal(log[0].limit, '200');
    assert.equal(next.memo.user, 'someone-else');
  });

  test(`${setting}: the same account refreshes with one request, after a single probe`, async () => {
    const log = [], probes = [];
    const nt = withHistory(signedInAs({ name: 'rj' }, log, probes));
    const first = await Activity.loadActivity({ setting, nt, now: NOW, firstWeekday: MONDAY, memo: null });
    log.length = 0; probes.length = 0;
    await Activity.loadActivity({ setting, nt, now: LATER, firstWeekday: MONDAY, memo: first.memo });
    assert.deepEqual(log.map((p) => p.limit), ['1']);
    assert.deepEqual(probes, ['rj']);
  });

  test(`${setting}: an account whose name cannot be read loads everything`, async () => {
    const account = { name: 'rj' };
    const log = [];
    const nt = withHistory(signedInAs(account, log));
    const first = await Activity.loadActivity({ setting, nt, now: NOW, firstWeekday: MONDAY, memo: null });
    account.name = undefined;
    log.length = 0;
    const next = await Activity.loadActivity({ setting, nt, now: LATER, firstWeekday: MONDAY, memo: first.memo });
    assert.equal(log[0].limit, '200');
    assert.equal(next.memo, first.memo);
  });
}

test('an explicit Last.fm source whose account probe fails still loads, just in full', async () => {
  const log = [];
  const nt = { lastFm: { call: async (method, params) => {
    if (method === 'user.getInfo') throw lastFmError('rateLimited');
    log.push(params);
    return isDayRequest(params) ? dayTotalBody(2, Number(params.from)) : recentPage(1, 1, [NOW]);
  } } };
  const first = await Activity.refreshLastFmActivity({ now: NOW, firstWeekday: MONDAY, user: 'rj', call: recordingAccount().call, memo: null });
  const result = await Activity.loadActivity({ setting: 'lastfm', nt, now: LATER, firstWeekday: MONDAY, memo: first.memo });
  assert.equal(result.kind, 'grid');
  assert.equal(log[0].limit, '200');
  // Not used for this load, but not forgotten either: the next probe that reads 'rj' refreshes from it.
  assert.equal(result.memo, first.memo);
});

test('a load that fails keeps the memory; one that settles hands over its own', async () => {
  const first = await Activity.refreshLastFmActivity({ now: NOW, firstWeekday: MONDAY, user: 'rj', call: recordingAccount().call, memo: null });
  assert.equal(Activity.memoAfterLoad(first.memo, undefined), first.memo);
  const next = { kind: 'grid', unit: 'scrobbles', memo: { ...first.memo } };
  assert.equal(Activity.memoAfterLoad(first.memo, next), next.memo);
  assert.equal(Activity.memoAfterLoad(first.memo, { kind: 'grid', unit: 'plays' }), null);
  assert.equal(Activity.memoAfterLoad(null, undefined), null);
});

const historyDouble = (since, rows, queries = []) => ({
  info: async () => ({ since, plays: since ? 900 : 0 }),
  query: async (q) => { queries.push(q); return { rows }; },
});

test('history is asked for day totals over the whole window, today included', async () => {
  const queries = [];
  const a = await Activity.loadHistoryActivity({
    history: historyDouble('2025-01-01T00:00:00Z', [{ date: '2026-09-21', plays: 3, seconds: 600 }], queries),
    now: NOW, firstWeekday: MONDAY,
  });
  assert.deepEqual(queries, [{ from: at(2026, 8, 10).toISOString(), to: at(2026, 9, 22).toISOString(), groupBy: 'day' }]);
  assert.equal(a.days.at(-1).count, 3);
});

test('no recorded play at all is the empty state, not a silent grid', async () => {
  const queries = [];
  const a = await Activity.loadHistoryActivity({ history: historyDouble(null, [], queries), now: NOW, firstWeekday: MONDAY });
  assert.equal(a, null);
  assert.deepEqual(queries, []);
});

const signedIn = { lastFm: { call: async () => ({ user: { name: 'u' } }) } };
const signedOut = { lastFm: { call: async () => Promise.reject(lastFmError('notSignedIn')) } };
const lastFmDenied = { lastFm: { call: async () => Promise.reject(lastFmError('permissionDenied')) } };
const withHistory = (nt) => ({ ...nt, history: historyDouble('2025-01-01T00:00:00Z', []) });

test('automatic prefers Last.fm when an account is signed in', async () => {
  assert.equal(await Activity.resolveSource('auto', withHistory(signedIn)), 'lastfm');
});

test('automatic falls back to NepTunes history when Last.fm is signed out', async () => {
  assert.equal(await Activity.resolveSource('auto', withHistory(signedOut)), 'history');
  assert.equal(await Activity.resolveSource('auto', signedOut), 'notSignedIn');
});

test('automatic uses history on an app that has no passthrough', async () => {
  assert.equal(await Activity.resolveSource('auto', withHistory({ lastFm: {} })), 'history');
  assert.equal(await Activity.resolveSource('auto', { lastFm: {} }), 'tooOld');
});

test('automatic treats a Last.fm permission refusal as no passthrough', async () => {
  assert.equal(await Activity.resolveSource('auto', withHistory(lastFmDenied)), 'history');
  assert.equal(await Activity.resolveSource('auto', lastFmDenied), 'tooOld');
});

test('an explicit source whose API is missing is an app that is too old', async () => {
  assert.equal(await Activity.resolveSource('lastfm', { lastFm: { getUserInfo() {} } }), 'tooOld');
  assert.equal(await Activity.resolveSource('history', signedIn), 'tooOld');
  assert.equal(await Activity.resolveSource('lastfm', signedIn), 'lastfm');
});

test('a transient probe failure is an error, not a guess at the source', async () => {
  const flaky = withHistory({ lastFm: { call: async () => Promise.reject(lastFmError('network')) } });
  await assert.rejects(Activity.resolveSource('auto', flaky), { code: 'network' });
});

test('loadActivity names the unit by source and maps sign-out to its state', async () => {
  const lastFm = { lastFm: { call: async (m) => (m === 'user.getInfo' ? { user: {} } : recentPage(1, 1, [NOW])) } };
  const grid = await Activity.loadActivity({ setting: 'lastfm', nt: lastFm, now: NOW, firstWeekday: MONDAY });
  assert.equal(grid.kind, 'grid');
  assert.equal(grid.unit, 'scrobbles');

  const plays = await Activity.loadActivity({ setting: 'history', nt: withHistory({}), now: NOW, firstWeekday: MONDAY });
  assert.equal(plays.unit, 'plays');

  assert.deepEqual(await Activity.loadActivity({ setting: 'lastfm', nt: signedOut, now: NOW, firstWeekday: MONDAY }), { kind: 'notSignedIn' });
  assert.deepEqual(await Activity.loadActivity({ setting: 'history', nt: { history: historyDouble(null, []) }, now: NOW, firstWeekday: MONDAY }), { kind: 'empty' });
  assert.deepEqual(await Activity.loadActivity({ setting: 'history', nt: {}, now: NOW, firstWeekday: MONDAY }), { kind: 'tooOld' });
});

test('an explicit source the app refuses permission for is the too-old state', async () => {
  assert.deepEqual(await Activity.loadActivity({ setting: 'lastfm', nt: lastFmDenied, now: NOW, firstWeekday: MONDAY }), { kind: 'tooOld' });
  const historyDenied = { history: { info: async () => Promise.reject(lastFmError('permissionDenied')), query: async () => ({ rows: [] }) } };
  assert.deepEqual(await Activity.loadActivity({ setting: 'history', nt: historyDenied, now: NOW, firstWeekday: MONDAY }), { kind: 'tooOld' });
});

test('a history that cannot be read fails the load rather than claiming an old app', async () => {
  const broken = { history: { info: async () => Promise.reject(lastFmError('unavailable')), query: async () => ({ rows: [] }) } };
  await assert.rejects(Activity.loadActivity({ setting: 'history', nt: broken, now: NOW, firstWeekday: MONDAY }), { code: 'unavailable' });
});

test('automatic falls back to history when Last.fm signs out between the probe and the pages', async () => {
  let signedInForProbe = true;
  const flipping = {
    lastFm: {
      call: async (method) => {
        if (method === 'user.getInfo' && signedInForProbe) { signedInForProbe = false; return { user: {} }; }
        throw lastFmError('notSignedIn');
      },
    },
    history: historyDouble('2025-01-01T00:00:00Z', [{ date: '2026-09-21', plays: 3, seconds: 0 }]),
  };
  const result = await Activity.loadActivity({ setting: 'auto', nt: flipping, now: NOW, firstWeekday: MONDAY });
  assert.equal(result.kind, 'grid');
  assert.equal(result.unit, 'plays');
  assert.equal(result.activity.days.at(-1).count, 3);
});

test('a load superseded during the automatic probe never asks for a page', async () => {
  const methods = [];
  let current = true;
  const nt = withHistory({ lastFm: { call: async (method) => { methods.push(method); current = false; return { user: {} }; } } });
  await assert.rejects(
    Activity.loadActivity({ setting: 'auto', nt, now: NOW, firstWeekday: MONDAY, isCurrent: () => current }),
    { code: 'superseded' });
  assert.deepEqual(methods, ['user.getInfo']);
});

test('an explicit Last.fm source that is signed out says so, even with history there', async () => {
  assert.deepEqual(await Activity.loadActivity({ setting: 'lastfm', nt: withHistory(signedOut), now: NOW, firstWeekday: MONDAY }), { kind: 'notSignedIn' });
});

test('each non-grid result maps to its message', () => {
  assert.equal(Activity.statusKey({ kind: 'notSignedIn' }), 'signIn');
  assert.equal(Activity.statusKey({ kind: 'empty' }), 'nothingYet');
  assert.equal(Activity.statusKey({ kind: 'error' }), 'loadFailed');
  assert.equal(Activity.statusKey({ kind: 'tooOld' }), 'tooOld');
  assert.equal(Activity.statusKey({ kind: 'grid' }), null);
  assert.equal(Activity.statusKey(null), null);
});

// ---- Strings ----------------------------------------------------------------

const KEYS = ['noData', 'signIn', 'nothingYet', 'loadFailed', 'tooOld', 'loading'];

test('the widget speaks every app language', () => {
  assert.deepEqual([...Activity.LANGUAGES].sort(),
    ['ar', 'ca', 'de', 'en', 'es', 'fr', 'it', 'ja', 'nl', 'pl', 'pt-BR', 'ru', 'uk', 'zh-Hans']);
  for (const lang of Activity.LANGUAGES) {
    const s = Activity.STRINGS[lang];
    for (const key of KEYS) assert.ok(typeof s[key] === 'string' && s[key].length > 0, `${lang}.${key}`);
    for (const unit of ['scrobbles', 'plays']) assert.match(s.totals[unit], /\{n\}/, `${lang}.totals.${unit}`);
  }
});

test('every plural category the language has is written out', () => {
  for (const lang of Activity.LANGUAGES) {
    const categories = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
    for (const unit of ['scrobbles', 'plays']) {
      for (const category of categories) {
        assert.ok(Activity.STRINGS[lang][unit][category], `${lang}.${unit}.${category}`);
      }
      for (const [category, form] of Object.entries(Activity.STRINGS[lang][unit])) {
        // Arabic names one and two with the noun alone (سكروبل واحد, سكروبلان), as it is written.
        if (lang === 'ar' && (category === 'one' || category === 'two')) continue;
        assert.match(form, /\{n\}/, `${lang}.${unit}.${category}`);
      }
    }
  }
});

test('counts pick the plural form and format the number for the host locale', () => {
  assert.equal(Activity.countText('plays', 1, 'en', 'en-US'), '1 play');
  assert.equal(Activity.countText('scrobbles', 1234, 'en', 'en-US'), '1,234 scrobbles');
  assert.equal(Activity.countText('scrobbles', 1234, 'de', 'de-DE'), '1.234 Scrobbles');
  // The app's own Polish singular is "scrobble" ("Twój pierwszy scrobble"); the genitive plural "scrobbli".
  assert.equal(Activity.countText('scrobbles', 1, 'pl', 'pl-PL'), '1 scrobble');
  assert.equal(Activity.countText('scrobbles', 3, 'pl', 'pl-PL'), '3 scrobble');
  assert.equal(Activity.countText('scrobbles', 5, 'pl', 'pl-PL'), '5 scrobbli');
  assert.equal(Activity.countText('scrobbles', 22, 'pl', 'pl-PL'), '22 scrobble');
  assert.equal(Activity.countText('scrobbles', 21, 'ru', 'ru-RU'), '21 скроббл');
  assert.equal(Activity.countText('scrobbles', 11, 'ru', 'ru-RU'), '11 скробблов');
  assert.equal(Activity.countText('scrobbles', 2, 'ar', 'ar-SA'), 'سكروبلان');
  assert.equal(Activity.countText('scrobbles', 3, 'ar', 'ar-SA'), '٣ سكروبلات');
  assert.equal(Activity.countText('scrobbles', 0, 'fr', 'fr-FR'), '0 scrobble');
  assert.equal(Activity.countText('plays', 5, 'ja', 'ja-JP'), '5 回再生');
});

test('an explicit zero form wins for 0, as a stringsdict zero does', () => {
  // CLDR files Portuguese 0 under "one", but Brazilian Portuguese counts zero in the plural.
  assert.equal(Activity.countText('plays', 0, 'pt-BR', 'pt-BR'), '0 reproduções');
  assert.equal(Activity.countText('plays', 1, 'pt-BR', 'pt-BR'), '1 reprodução');
});

test('a malformed host locale degrades to plain digits instead of throwing', () => {
  assert.equal(Activity.countText('plays', 3, 'en', 'ar_SA'), '3 plays');
});

test('the host language picks the table, falling back sensibly', () => {
  assert.equal(Activity.pickLanguage('pt-BR'), 'pt-BR');
  assert.equal(Activity.pickLanguage('pt'), 'pt-BR');
  assert.equal(Activity.pickLanguage('zh-Hans'), 'zh-Hans');
  assert.equal(Activity.pickLanguage('de-AT'), 'de');
  assert.equal(Activity.pickLanguage('xx'), 'en');
  assert.equal(Activity.pickLanguage(undefined), 'en');
});

test('dates read as day and abbreviated month, the onboarding callout format', () => {
  assert.equal(Activity.formatDay(at(2026, 9, 21), 'en-US'), 'Sep 21');
  assert.equal(Activity.summaryText('plays', 1234, 'en', 'en-US'), 'Plays in the last 7 weeks: 1,234');
});

// ---- Geometry & settings ------------------------------------------------------
// These pin the arithmetic. That WebKit draws it there is ActivityWidgetPageTests' job.

test('the default window: a 140pt card at the 20/16 gutter, 12pt cells 4pt apart', () => {
  const l = Activity.layout(180, 180, 'card');
  assert.deepEqual(l.card, { x: 20, y: 16, side: 140 });
  assert.deepEqual(l.grid, { x: 36, y: 32, side: 108 });
  assert.equal(l.cell, 12);
  assert.equal(l.gap, 4);
  assert.equal(l.radius, 3.5);   // the onboarding's 3 of 11, at this size
});

test('the smallest and largest windows keep the onboarding proportions', () => {
  const small = Activity.layout(120, 120, 'card');
  assert.deepEqual([small.cell, small.gap, small.grid.x, small.grid.y], [7, 2, 29, 25]);
  const large = Activity.layout(400, 400, 'card');
  assert.deepEqual([large.cell, large.gap, large.grid.x, large.grid.y], [33, 9, 57, 53]);
});

test('a window stretched off square still draws a square card, centred', () => {
  assert.deepEqual(Activity.layout(240, 180, 'card').card, { x: 50, y: 16, side: 140 });
});

test('the bare grid needs no shadow gutter and no card padding', () => {
  const l = Activity.layout(180, 180, 'none');
  assert.deepEqual(l.card, { x: 6, y: 6, side: 168 });
  assert.deepEqual([l.cell, l.gap, l.grid.x], [19, 5, 8]);
});

test('weeks run across and weekdays down; right-to-left mirrors the weeks', () => {
  const l = Activity.layout(180, 180, 'card');
  assert.deepEqual(Activity.cellRect(l, 0, 0, false), { x: 36, y: 32, w: 12, h: 12 });
  assert.deepEqual(Activity.cellRect(l, 1, 3, false), { x: 52, y: 80, w: 12, h: 12 });
  assert.deepEqual(Activity.cellRect(l, 0, 0, true), { x: 132, y: 32, w: 12, h: 12 });
});

test('the hit test gives each gap half to either neighbour, and nothing off the grid', () => {
  const l = Activity.layout(180, 180, 'card');
  assert.deepEqual(Activity.hitTest(l, 42, 38, false), { column: 0, row: 0 });
  assert.deepEqual(Activity.hitTest(l, 49, 38, false), { column: 0, row: 0 });   // gap 48…52, left half
  assert.deepEqual(Activity.hitTest(l, 51, 38, false), { column: 1, row: 0 });   // right half
  assert.deepEqual(Activity.hitTest(l, 35, 38, false), { column: 0, row: 0 });   // half a gap outside
  assert.equal(Activity.hitTest(l, 33, 38, false), null);
  assert.equal(Activity.hitTest(l, 146, 38, false), null);
  assert.deepEqual(Activity.hitTest(l, 138, 38, true), { column: 0, row: 0 });
  assert.equal(Activity.hitTest(l, NaN, 38, false), null);
});

test('the callout sits above a day, below one in the top two rows, 5pt away', () => {
  const bounds = Activity.calloutBounds(180, 180);
  const cell = { x: 84, y: 96, w: 12, h: 12 };
  assert.deepEqual(Activity.calloutOrigin(cell, { w: 60, h: 30 }, 4, bounds), { x: 60, y: 61, above: true });
  assert.deepEqual(Activity.calloutOrigin(cell, { w: 60, h: 30 }, 1, bounds), { x: 60, y: 113, above: false });
});

test('the callout is clamped inside the window on every side', () => {
  const bounds = Activity.calloutBounds(120, 120);
  assert.deepEqual(Activity.calloutOrigin({ x: 29, y: 43, w: 7, h: 7 }, { w: 70, h: 38 }, 2, bounds), { x: 2, y: 2, above: true });
  assert.equal(Activity.calloutOrigin({ x: 83, y: 70, w: 7, h: 7 }, { w: 70, h: 38 }, 5, bounds).x, 48);
  // Below the cell it would run past the bottom (37 + 100 > 118), so it rises until it fits.
  assert.equal(Activity.calloutOrigin({ x: 83, y: 25, w: 7, h: 7 }, { w: 70, h: 100 }, 0, bounds).y, 18);
  // Taller than the window: the top edge wins, so the count line stays readable.
  assert.equal(Activity.calloutOrigin({ x: 83, y: 25, w: 7, h: 7 }, { w: 70, h: 130 }, 0, bounds).y, 2);
});

test('the grid is always 49 slots: the window, then the rest of this week empty', () => {
  const pending = Activity.gridCells(null, NOW, MONDAY);
  assert.equal(pending.length, 49);
  assert.equal(pending.filter((c) => c.kind === 'pending').length, 43);
  assert.ok(pending.slice(43).every((c) => c.kind === 'outside'));
  const days = Activity.gridCells(Activity.fromScrobbleDates([], NOW, MONDAY, true), NOW, MONDAY);
  assert.equal(days.filter((c) => c.kind === 'day').length, 43);
});

test('each slot paints as the onboarding does', () => {
  assert.equal(Activity.cellClass({ kind: 'outside' }), 'outside');
  assert.equal(Activity.cellClass({ kind: 'pending' }), 'pending');
  assert.equal(Activity.cellClass({ kind: 'day', day: { count: null, level: 0 } }), 'unknown');
  assert.equal(Activity.cellClass({ kind: 'day', day: { count: 0, level: 0 } }), 'level-0');
  assert.equal(Activity.cellClass({ kind: 'day', day: { count: 9, level: 3 } }), 'level-3');
});

test('Reduce Motion swaps the travelling sweep for a pulse in place', () => {
  assert.equal(Activity.loadingMotion(false), 'sweep');
  assert.equal(Activity.loadingMotion(true), 'pulse');
});

test('the midnight refresh lands a second into the new day, DST included', () => {
  assert.equal(Activity.msUntilNextMidnight(new Date(2026, 8, 21, 23, 59, 30)), 31000);
  assert.equal(Activity.msUntilNextMidnight(new Date(2026, 9, 25, 0, 30)), 24.5 * 3600e3 + 1000);  // 25 Oct is 25 h long
});

test('settings fall back to the manifest defaults for anything missing or unknown', () => {
  assert.deepEqual(Activity.normalizeSettings(null), Activity.DEFAULT_SETTINGS);
  const picked = { source: 'history', accentSource: 'fixed', fixedColor: '#FF375F', theme: 'light', firstWeekday: 'sunday', background: 'none' };
  assert.deepEqual(Activity.normalizeSettings(picked), picked);
  assert.deepEqual(Activity.normalizeSettings({ source: 'spotify', accentSource: 'wallpaper', fixedColor: 'FF375G', firstWeekday: 'friday' }),
    Activity.DEFAULT_SETTINGS);
  assert.deepEqual(Activity.accentRgb('#FF375F'), [255, 55, 95]);
  assert.deepEqual(Activity.accentRgb('nope'), [91, 146, 234]);
});

test('a colour is only ever a #RRGGBB hex, so nothing else reaches the CSS', () => {
  for (const fixedColor of ['#abc', 'FF375F', '#FF375F; background: red', 'rgb(1, 2, 3)', '#FF375F ', 'red', 0xFF375F]) {
    assert.equal(Activity.normalizeSettings({ fixedColor }).fixedColor, Activity.DEFAULT_SETTINGS.fixedColor, String(fixedColor));
  }
  assert.equal(Activity.normalizeSettings({ fixedColor: '#ff375f' }).fixedColor, '#ff375f');
  assert.deepEqual(Activity.accentRgb('#abc'), [91, 146, 234]);
});

test('Spanish failure wording follows the app\'s "No se pudo …" register', () => {
  assert.equal(Activity.STRINGS.es.loadFailed, 'No se pudo cargar tu actividad');
});

test('the default settings are the manifest defaults', () => {
  const manifest = JSON.parse(readFileSync(new URL('../Activity.nepget/manifest.json', import.meta.url), 'utf8'));
  const defaults = Object.fromEntries(manifest.settings.schema.map((s) => [s.id, s.default]));
  assert.deepEqual(Activity.DEFAULT_SETTINGS, defaults);
  for (const s of manifest.settings.schema.filter((s) => s.options)) {
    for (const { value } of s.options) {
      assert.equal(Activity.normalizeSettings({ [s.id]: value })[s.id], value, `${s.id}=${value}`);
    }
  }
});

// ---- Cell palette ------------------------------------------------------------

// With `background: none` the card is transparent, so a translucent cell composites over the
// wallpaper instead of the panel: on an orange desktop the blue levels came out muddy and
// washed out. Every cell is therefore opaque — the accent (or primary) pre-mixed with the
// panel colour at the proportion the old alpha gave on the card — and reads the same in both
// modes. Only the loading shimmer (`::after`, transient) may stay translucent.
test('every cell fill is opaque: the card look, pre-mixed with the panel colour', () => {
  const css = readFileSync(new URL('../Activity.nepget/styles.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const fills = {};
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = selector.trim();
    if (!/^\.cell\.[\w-]+$/.test(sel)) continue;
    const bg = body.match(/background(?:-color)?\s*:\s*([^;]+);/);
    if (bg) fills[sel] = bg[1].trim().replace(/\s+/g, ' ');
  }
  const mixed = {
    '.cell.pending': ['primary', 6], '.cell.unknown': ['primary', 4], '.cell.level-0': ['primary', 9],
    '.cell.level-1': ['accent', 30], '.cell.level-2': ['accent', 50], '.cell.level-3': ['accent', 75],
  };
  for (const [sel, [ink, pct]] of Object.entries(mixed)) {
    assert.equal(fills[sel], `color-mix(in srgb, rgb(var(--${ink}-rgb)) ${pct}%, var(--panel))`, sel);
  }
  assert.equal(fills['.cell.level-4'], 'rgb(var(--accent-rgb))');
  for (const [sel, value] of Object.entries(fills)) {
    assert.doesNotMatch(value, /rgba\(|transparent|\/\s*[\d.]/, `${sel} must be opaque`);
  }
  // …which only holds while the panel colour the cells mix into is itself opaque, in every theme.
  const panels = [...css.matchAll(/--panel\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(panels.length >= 3, 'dark, light and auto-light panels');
  for (const panel of panels) assert.match(panel, /^#[0-9a-f]{6}$/i, `--panel ${panel} must be opaque`);
});

// ---- Accent ---------------------------------------------------------------------
// The grid is tinted by the playing album's cover unless the user picks a colour, the way
// Scrobbles, Charts, Headline and Strip do it — same setting ids, labels and options, so the
// Settings pane reads the same for every widget.

const manifest = () => JSON.parse(readFileSync(new URL('../Activity.nepget/manifest.json', import.meta.url), 'utf8'));
const scrobblesManifest = () => JSON.parse(readFileSync(new URL('../Scrobbles.nepget/manifest.json', import.meta.url), 'utf8'));
const field = (m, id) => m.settings.schema.find((s) => s.id === id);

test('the accent settings are the other widgets\' own: album art by default, or a fixed colour', () => {
  const m = manifest(), other = scrobblesManifest();
  assert.deepEqual(field(m, 'accentSource'), field(other, 'accentSource'));
  const { default: fixedDefault, ...fixed } = field(m, 'fixedColor');
  const { default: _, ...otherFixed } = field(other, 'fixedColor');
  assert.deepEqual(fixed, otherFixed);
  // The grid keeps its own blue for the fixed colour: the onboarding grid's, and what it showed before.
  assert.equal(fixedDefault, '#5B92EA');
  assert.equal(field(m, 'color'), undefined, 'the old single colour setting is gone');
  const ids = m.settings.schema.map((s) => s.id);
  assert.equal(ids.indexOf('fixedColor'), ids.indexOf('accentSource') + 1, 'the colour follows the choice it belongs to');
});

test('reading the cover needs the artwork permission', () => {
  assert.deepEqual([...manifest().permissions].sort(), ['artwork', 'lastFm', 'listeningHistory']);
});

test('the card shape shipped in 1.1.0; the resize grip ships as 1.2.0', () => {
  assert.equal(manifest().version, '1.2.0');
  assert.equal(manifest().card, true);
});

const COVER = 'data:image/jpeg;base64,COVER-A';
const album = (over = {}) => Activity.normalizeSettings({ accentSource: 'album', fixedColor: '#FF375F', ...over });
const fixed = (over = {}) => Activity.normalizeSettings({ accentSource: 'fixed', fixedColor: '#FF375F', ...over });

test('a fixed colour paints the pick, cover or not', () => {
  assert.deepEqual(Activity.accentTarget(fixed(), COVER, true).rgb, [255, 55, 95]);
  assert.deepEqual(Activity.accentTarget(fixed(), null, false).rgb, [255, 55, 95]);
  assert.equal(Activity.accentTarget(fixed(), COVER, true).url, undefined, 'nothing to decode');
});

test('album art decodes the playing cover', () => {
  const target = Activity.accentTarget(album(), COVER, true);
  assert.equal(target.url, COVER);
  assert.equal(target.rgb, undefined);
});

// NepTunes' own accent, NepTunesUI's AppAccent.swift: Display P3 (91, 146, 234) on a light
// appearance, (60, 120, 217) on a dark one. The grid's ramp is sRGB, so the widget carries both
// converted — the page cannot read the app's colour, and has no API for it.
const p3ToSrgb = (p3) => {
  const dec = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const enc = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  const [r, g, b] = p3.map(dec);
  const lin = [1.2249401 * r - 0.2249404 * g, -0.0420569 * r + 1.0420571 * g, -0.0196376 * r - 0.0786361 * g + 1.0982735 * b];
  return lin.map((v) => Math.round(enc(v)));
};
const APP_ACCENT = { light: p3ToSrgb([91, 146, 234]), dark: p3ToSrgb([60, 120, 217]) };

test('the app accent is AppAccent.swift\'s two Display P3 values, in sRGB', () => {
  assert.deepEqual(APP_ACCENT, { light: [71, 148, 241], dark: [30, 122, 224] });
  assert.deepEqual(Activity.appAccent(false), APP_ACCENT.light);
  assert.deepEqual(Activity.appAccent(true), APP_ACCENT.dark);
});

test('with nothing playing, or a track without a cover, album art falls back to the app accent', () => {
  // Activity stays on screen with nothing playing (alwaysVisible), so this is its idle look:
  // NepTunes' own blue for the panel it sits on — not the fixed colour, which is Fixed's alone.
  assert.deepEqual(Activity.accentTarget(album(), null, true).rgb, APP_ACCENT.dark);
  assert.deepEqual(Activity.accentTarget(album(), null, false).rgb, APP_ACCENT.light);
  assert.deepEqual(Activity.accentTarget(Activity.normalizeSettings(null), null, true).rgb, APP_ACCENT.dark);
  assert.deepEqual(Activity.accentTarget(Activity.normalizeSettings(null), null, false).rgb, APP_ACCENT.light);
});

test('the app accent is painted as the app paints it, not moved like a cover\'s colour', () => {
  assert.notDeepEqual(Activity.albumAccent(APP_ACCENT.dark, true), APP_ACCENT.dark, 'legibleAccent would have moved it');
  assert.deepEqual(Activity.accentTarget(album(), null, true).rgb, APP_ACCENT.dark);
});

test('until the first cover has decoded, the grid shows the app accent', () => {
  // On first load there is no earlier tint to keep while the cover decodes.
  assert.deepEqual(Activity.accentTarget(album(), COVER, true).pending, APP_ACCENT.dark);
  assert.deepEqual(Activity.accentTarget(album(), COVER, false).pending, APP_ACCENT.light);
});

test('the fixed colour stays exactly the user\'s pick, on either panel', () => {
  assert.deepEqual(Activity.accentTarget(fixed(), null, true).rgb, [255, 55, 95]);
  assert.deepEqual(Activity.accentTarget(fixed(), null, false).rgb, [255, 55, 95]);
  assert.deepEqual(Activity.accentTarget(fixed({ fixedColor: '#5B92EA' }), null, true).rgb, [91, 146, 234]);
  assert.equal(Activity.DEFAULT_SETTINGS.fixedColor, '#5B92EA');
});

// The key is the cache identity for "which accent is on the grid right now": the page repaints
// exactly when it moves. statechange fires on every position tick, so a repeat must not move it.
const key = (settings, url, dark) => Activity.accentTarget(settings, url, dark).key;

test('a repeat of the same state does not repaint', () => {
  assert.equal(key(album(), COVER, true), key(album(), COVER, true));
  assert.equal(key(album(), null, true), key(album(), null, true));
  assert.equal(key(fixed(), COVER, true), key(fixed(), COVER, true));
});

test('a new cover, a lost cover or a new colour repaints', () => {
  assert.notEqual(key(album(), COVER, true), key(album(), 'data:image/jpeg;base64,COVER-B', true));
  assert.notEqual(key(album(), COVER, true), key(album(), null, true));
  assert.notEqual(key(fixed(), null, true), key(fixed({ fixedColor: '#30D158' }), null, true));
  // With nothing playing, album art shows the app accent: the fixed colour is not on the grid.
  assert.equal(key(album(), null, true), key(album({ fixedColor: '#30D158' }), null, true));
});

test('switching between album art and a fixed colour repaints whenever a cover is playing', () => {
  assert.notEqual(key(album(), COVER, true), key(fixed(), COVER, true));
  // With nothing playing one paints the app accent and the other the fixed colour.
  assert.notEqual(key(album(), null, true), key(fixed(), null, true));
  assert.notEqual(key(album(), null, false), key(fixed({ fixedColor: '#5B92EA' }), null, false));
});

test('a theme flip re-derives the album colour, switches the app accent, and leaves a picked colour alone', () => {
  assert.notEqual(key(album(), COVER, true), key(album(), COVER, false));
  assert.equal(key(fixed(), COVER, true), key(fixed(), COVER, false));
  assert.equal(key(fixed(), null, true), key(fixed(), null, false));
  // Idle, the grid moves between the app accent's dark and light variants.
  assert.notEqual(key(album(), null, true), key(album(), null, false));
  assert.deepEqual(Activity.accentTarget(album(), null, false).rgb, APP_ACCENT.light);
});

// A cover's dominant colour can sit right on the panel — navy on the dark card, pale yellow on
// the light one — and then the whole ramp vanishes into it. The album colour is moved, hue kept,
// until the brightest level reads against the panel; every level above "none" then stands off the
// panel further than the one below it. Background "None" mixes into the same panel colour, so
// this holds there too.
const css = () => readFileSync(new URL('../Activity.nepget/styles.css', import.meta.url), 'utf8');
const panelOf = (block) => NTKit.hexToRgb(css().match(new RegExp(block + '\\s*\\{[^}]*--panel:\\s*(#[0-9a-fA-F]{6})'))[1]);
const PANELS = { dark: { panel: () => panelOf(':root'), primary: [255, 255, 255] },
                 light: { panel: () => panelOf('html\\.theme-light'), primary: [0, 0, 0] } };
const mix = (a, b, pct) => a.map((v, i) => Math.round(v * pct / 100 + b[i] * (1 - pct / 100)));
const contrast = (a, b) => {
  const la = NTKit.luminance(a), lb = NTKit.luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const hue = (rgb) => {
  const [r, g, b] = rgb.map((v) => v / 255), mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const COVERS = {
  navy: [27, 31, 58], forest: [10, 42, 18], oxblood: [122, 16, 32], coral: [226, 96, 63],
  sky: [91, 146, 234], butter: [247, 226, 122], lemon: [255, 214, 10], grey: [128, 128, 128],
};

test('an album colour gives a readable ramp on both panels', () => {
  for (const [theme, { panel, primary }] of Object.entries(PANELS)) {
    const p = panel(), none = mix(primary, p, 9);   // .cell.level-0
    for (const [name, rgb] of Object.entries(COVERS)) {
      const accent = Activity.albumAccent(rgb, theme === 'dark');
      const ramp = [none, mix(accent, p, 30), mix(accent, p, 50), mix(accent, p, 75), accent];
      const against = ramp.map((c) => contrast(c, p));
      assert.ok(against[4] >= 4.5, `${name} on ${theme}: the busiest day ${accent} is ${against[4].toFixed(2)}:1`);
      for (let i = 1; i < ramp.length; i++) {
        assert.ok(against[i] > against[i - 1], `${name} on ${theme}: level ${i} stands off the panel less than level ${i - 1}`);
      }
    }
  }
});

test('an album colour keeps its hue', () => {
  for (const dark of [true, false]) {
    for (const [name, rgb] of Object.entries(COVERS)) {
      if (name === 'grey') continue;
      const moved = Math.abs(hue(Activity.albumAccent(rgb, dark)) - hue(rgb));
      assert.ok(Math.min(moved, 360 - moved) <= 6, `${name} ${dark ? 'dark' : 'light'} moved ${moved.toFixed(1)}°`);
    }
  }
});
