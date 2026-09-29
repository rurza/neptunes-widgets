/**
 * Listening Activity — seven weeks of listening as a 7×7 grid of days, weekdays down and
 * weeks across, each day lit by how it ranks among the user's own days. The desktop twin of
 * the onboarding grid (NepTunesUI/Onboarding/ScrobbleActivityGrid.swift); the model is a port
 * of NepTunesKit/Models/ScrobbleActivity.swift, pinned to it by _dev/activity.test.mjs and
 * ActivityWidgetModelParityTests.
 */
(function (factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else api.start();
})(function () {
    'use strict';

    // ---- Model --------------------------------------------------------------
    // A port of ScrobbleActivity (NepTunesKit/Models/ScrobbleActivity.swift). Days are local
    // calendar days; the window is six full weeks before the current one plus the current
    // week up to today, opening on the chosen first weekday (ISO: 1 = Monday … 7 = Sunday).

    var WEEK_COUNT = 7;
    var ROWS = 7;
    var MAX_LEVEL = 4;

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    function startOfDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }

    // Through the Date constructor, never `+ 86400000`: a DST day is 23 or 25 hours long.
    function addDays(date, n) { return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n); }

    function isoWeekday(date) { return ((date.getDay() + 6) % 7) + 1; }

    function dayKey(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    /** The first day of the window: the first weekday, WEEK_COUNT − 1 weeks before this week's. */
    function windowStart(now, firstWeekday) {
        var today = startOfDay(now);
        var intoWeek = (isoWeekday(today) - firstWeekday + 7) % 7;
        return addDays(today, -intoWeek - (WEEK_COUNT - 1) * 7);
    }

    /** Every day from windowStart through today, oldest first (43…49 of them). */
    function windowDays(now, firstWeekday) {
        var today = startOfDay(now);
        var days = [];
        for (var day = windowStart(now, firstWeekday); day <= today; day = addDays(day, 1)) days.push(day);
        return days;
    }

    /** The share of active days this count matches or beats, mapped onto 1…MAX_LEVEL. */
    function level(count, sortedActiveCounts) {
        if (!(count > 0) || sortedActiveCounts.length === 0) return 0;
        var atOrBelow = 0;
        for (var i = 0; i < sortedActiveCounts.length; i++) {
            if (sortedActiveCounts[i] <= count) atOrBelow++;
        }
        var fraction = atOrBelow / sortedActiveCounts.length;
        return Math.min(MAX_LEVEL, Math.max(1, Math.ceil(fraction * MAX_LEVEL)));
    }

    /** Days at or before `unknownThroughKey` are unknown (count null) and left out of the ranking. */
    function buildActivity(dayStarts, counts, unknownThroughKey, isComplete) {
        function isUnknown(key) { return unknownThroughKey !== null && key <= unknownThroughKey; }
        var active = [];
        dayStarts.forEach(function (day) {
            var key = dayKey(day);
            if (!isUnknown(key) && counts[key] > 0) active.push(counts[key]);
        });
        active.sort(function (a, b) { return a - b; });
        var days = dayStarts.map(function (day) {
            var key = dayKey(day);
            if (isUnknown(key)) return { date: day, key: key, count: null, level: 0 };
            var count = counts[key] || 0;
            return { date: day, key: key, count: count, level: level(count, active) };
        });
        return { days: days, isComplete: isComplete };
    }

    /** Scrobble instants inside the window, counted per local day key. */
    function countsByDay(dates, now, firstWeekday) {
        var start = windowStart(now, firstWeekday);
        var counts = {};
        dates.forEach(function (date) {
            if (date >= start && date <= now) {
                var key = dayKey(date);
                counts[key] = (counts[key] || 0) + 1;
            }
        });
        return counts;
    }

    /**
     * ScrobbleActivity.make(scrobbleDates:dayTotals:): the scrobbles bucketed as above, with
     * `dayTotals` (day key → exact count) replacing whatever they counted for those days.
     * Every day is known, so the grid is complete.
     */
    function fromScrobbleDatesAndDayTotals(dates, dayTotals, now, firstWeekday) {
        var counts = countsByDay(dates, now, firstWeekday);
        Object.keys(dayTotals).forEach(function (key) { counts[key] = dayTotals[key]; });
        return buildActivity(windowDays(now, firstWeekday), counts, null, true);
    }

    /**
     * ScrobbleActivity.make: buckets scrobble instants into the window's days. With
     * `coversAll` false the day of the oldest instant seen, and every day before it, is
     * unknown — pages arrive newest first, so that day is only partly fetched.
     */
    function fromScrobbleDates(dates, now, firstWeekday, coversAll) {
        var counts = countsByDay(dates, now, firstWeekday);
        var unknownThrough = null;
        if (!coversAll) {
            var oldest = dates.reduce(function (min, d) { return d < min ? d : min; }, dates.length ? dates[0] : now);
            unknownThrough = dayKey(oldest);
        }
        return buildActivity(windowDays(now, firstWeekday), counts, unknownThrough, !!coversAll);
    }

    /**
     * Listening history's per-day totals ({date: 'YYYY-MM-DD', plays}). Days before the local
     * day of `since` — the first recorded play — are unknown: NepTunes was not listening yet.
     */
    function fromDayCounts(rows, now, firstWeekday, since) {
        var counts = {};
        rows.forEach(function (row) {
            if (row && typeof row.date === 'string') counts[row.date] = (counts[row.date] || 0) + (Number(row.plays) || 0);
        });
        var start = windowStart(now, firstWeekday);
        var unknownThrough = since ? dayKey(addDays(startOfDay(since), -1)) : null;
        return buildActivity(windowDays(now, firstWeekday), counts, unknownThrough, !since || startOfDay(since) <= start);
    }

    function totalCount(activity) {
        return activity.days.reduce(function (sum, day) { return sum + (day.count || 0); }, 0);
    }

    /**
     * The ISO weekday (1 = Monday … 7 = Sunday) the grid's weeks open on. `settingValue` is the
     * widget's `firstWeekday` select: an explicit day wins; anything else follows the host's
     * state.firstWeekday (NepTunes 4.1+), then the week data of state.locale where the engine
     * has it, then Monday. The copyable function from Docs/WidgetDevelopment.md → "First day
     * of the week", kept here rather than in NTKit so the shared kit stays byte-identical.
     */
    function firstWeekday(settingValue, state) {
        var explicit = { monday: 1, sunday: 7, saturday: 6 };
        if (Object.prototype.hasOwnProperty.call(explicit, settingValue)) return explicit[settingValue];
        var fromHost = state && state.firstWeekday;
        if (Number.isInteger(fromHost) && fromHost >= 1 && fromHost <= 7) return fromHost;
        try {
            var locale = new Intl.Locale(state.locale);
            var week = typeof locale.getWeekInfo === 'function' ? locale.getWeekInfo() : locale.weekInfo;
            if (week && Number.isInteger(week.firstDay) && week.firstDay >= 1 && week.firstDay <= 7) return week.firstDay;
        } catch (e) {}
        return 1;
    }

    // ---- Loading ------------------------------------------------------------
    // Mirrors ScrobbleActivityLoader: page 1 says how many pages the window holds, the rest
    // are fetched MAX_CONCURRENT_PAGES at a time, up to MAX_PAGES. Pages arrive newest first,
    // so a listener past MAX_PAGES has the oldest fetched day only partly counted and the days
    // before it not at all: each of those days is then asked for its exact total instead — one
    // limit=1 request per day, reading `@attr.total` — so the grid still has no unknown days.

    var PAGE_SIZE = 200;
    var MAX_PAGES = 15;
    var MAX_CONCURRENT_PAGES = 3;

    // A request that fails for a passing reason is asked again, twice at most, after these
    // waits: one flaky page out of fifteen would otherwise throw the other fourteen away.
    var RETRY_DELAYS_MS = [1000, 3000];
    // Failures asking again can fix. Last.fm's 8 (operation failed), 11 (service offline),
    // 16 (temporarily unavailable) and 29 (rate limit) say "try later"; anything else — signed
    // out, refused, a malformed answer, a superseded load — would fail the same way again.
    var TRANSIENT_CODES = ['network', 'timeout', 'rateLimited', 'lastFm:8', 'lastFm:11', 'lastFm:16', 'lastFm:29'];

    function isTransient(error) { return !!error && TRANSIENT_CODES.indexOf(error.code) !== -1; }

    function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

    /**
     * `attempt()`, asked again after each of `delays` while it fails transiently. A superseded
     * load stops at once: before every attempt, and after every wait.
     */
    function withRetry(attempt, delays, wait, isCurrent) {
        var retries = 0;
        function run() {
            if (!isCurrent()) return Promise.reject(supersededError());
            return Promise.resolve().then(attempt).catch(function (error) {
                if (!isTransient(error) || retries >= delays.length) throw error;
                return Promise.resolve(wait(delays[retries++])).then(run);
            });
        }
        return run();
    }

    function asArray(value) { return Array.isArray(value) ? value : (value ? [value] : []); }

    function toInt(value) {
        var n = parseInt(value, 10);
        return isFinite(n) ? n : null;
    }

    /** A raw user.getRecentTracks body → its tracks and the pagination the loader plans from. */
    function recentTracksPage(raw) {
        var body = (raw && raw.recenttracks) || {};
        var attr = body['@attr'] || {};
        var tracks = asArray(body.track);
        var page = toInt(attr.page), totalPages = toInt(attr.totalPages), total = toInt(attr.total);
        return {
            tracks: tracks,
            page: page === null ? 1 : page,
            totalPages: totalPages === null ? 1 : totalPages,
            total: total === null ? tracks.length : total
        };
    }

    /**
     * A day total's `@attr.total`, strictly. A page may fall back to counting its tracks, but a
     * limit=1 day total without a total would count the day as 0 or 1 scrobbles and pass for
     * exact: it rejects instead, like any other failed request.
     */
    function dayTotal(raw) {
        var attr = raw && raw.recenttracks && raw.recenttracks['@attr'];
        var total = attr ? attr.total : undefined;
        if ((typeof total === 'string' && /^\d+$/.test(total)) || (typeof total === 'number' && total >= 0 && total % 1 === 0)) {
            return Number(total);
        }
        var error = new Error('The day total has no @attr.total');
        error.code = 'badResponse';
        throw error;
    }

    function artistName(track) {
        var artist = track.artist;
        if (typeof artist === 'string') return artist;
        return (artist && (artist['#text'] || artist.name)) || '';
    }

    /**
     * Collects scrobbles into `seen` (key → instant), each counted once. The pages all run up
     * to `now`, so a scrobble landing mid-load shifts every later page by one and repeats the
     * track at a boundary; two tracks in the same second are still two scrobbles. The
     * now-playing entry has no date and is not a scrobble yet.
     */
    function collectScrobbles(page, seen) {
        page.tracks.forEach(function (track) {
            if (!track || (track['@attr'] && track['@attr'].nowplaying === 'true')) return;
            var uts = track.date ? toInt(track.date.uts) : null;
            if (uts === null) return;
            seen[uts + '\u0000' + artistName(track) + '\u0000' + (track.name || '')] = new Date(uts * 1000);
        });
        return seen;
    }

    function scrobbleDates(seen) {
        return Object.keys(seen).map(function (key) { return seen[key]; });
    }

    /**
     * Runs `task(item)` over `items` with at most `limit` in flight. The first failure fails the
     * run, and no further task starts after it — the other workers stop rather than spend the
     * shared Last.fm budget on results nobody will use.
     */
    function runBounded(items, limit, task) {
        var next = 0, failed = false;
        function worker() {
            if (failed || next >= items.length) return Promise.resolve();
            return Promise.resolve(task(items[next++])).then(worker, function (error) {
                failed = true;
                throw error;
            });
        }
        var workers = [];
        for (var i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
        return Promise.all(workers);
    }

    function unixSeconds(date) { return String(Math.floor(date.getTime() / 1000)); }

    /** What a load rejects with once a newer one has replaced it. Nothing shows it. */
    function supersededError() {
        var error = new Error('superseded');
        error.code = 'superseded';
        return error;
    }

    /**
     * One request, retried while it fails transiently (`opts.retryDelays`, default
     * RETRY_DELAYS_MS; `opts.wait` for tests). A superseded load asks for nothing more: its
     * requests would only spend the shared Last.fm budget on a grid nobody will see.
     */
    function requester(opts) {
        var isCurrent = opts.isCurrent || function () { return true; };
        var delays = opts.retryDelays || RETRY_DELAYS_MS;
        var wait = opts.wait || sleep;
        return function (params, parse) {
            return withRetry(function () {
                return Promise.resolve(opts.call('user.getRecentTracks', params)).then(parse);
            }, delays, wait, isCurrent);
        };
    }

    /**
     * One local day's exact scrobble count: `@attr.total` of that day's window, from its
     * start to `end` (default: the day's last second). The track (and any now-playing entry
     * beside it) is ignored. Day bounds go through the calendar, so a 23- or 25-hour DST day
     * is asked for whole.
     */
    function fetchDayTotal(request, day, end) {
        return request({
            from: unixSeconds(day),
            to: end ? unixSeconds(end) : String(Math.floor(addDays(day, 1).getTime() / 1000) - 1),
            page: '1', limit: '1'
        }, dayTotal);
    }

    function loadLastFmActivity(opts) {
        var now = opts.now, firstWeekday = opts.firstWeekday;
        var maxPages = opts.maxPages || MAX_PAGES;
        var maxConcurrent = opts.maxConcurrentPages || MAX_CONCURRENT_PAGES;
        var isCurrent = opts.isCurrent || function () { return true; };
        var request = requester(opts);
        var from = unixSeconds(windowStart(now, firstWeekday));
        var to = unixSeconds(now);
        function fetchPage(page) {
            return request({ from: from, to: to, page: String(page), limit: String(PAGE_SIZE) }, recentTracksPage);
        }
        return fetchPage(1).then(function (first) {
            var seen = collectScrobbles(first, {});
            var pagesToFetch = Math.min(Math.max(first.totalPages, 1), maxPages);
            var pages = [];
            for (var p = 2; p <= pagesToFetch; p++) pages.push(p);
            // One failed page (a superseded load's included) fails the load.
            return runBounded(pages, maxConcurrent, function (page) {
                return fetchPage(page).then(function (result) { collectScrobbles(result, seen); });
            }).then(function () {
                var dates = scrobbleDates(seen);
                if (first.totalPages <= maxPages) return fromScrobbleDates(dates, now, firstWeekday, true);
                return backfillDayTotals(dates);
            });
        });

        // The pages stopped short of the window's start: count the oldest fetched day (only
        // partly fetched) and every day before it from their own day totals. A failed day
        // total fails the whole load, exactly as a failed page does — the widget then keeps
        // what it showed and retries — because a grid with that day left unknown would bring
        // back, silently, the gap this backfill exists to close.
        function backfillDayTotals(dates) {
            if (!isCurrent()) return Promise.reject(supersededError());
            var oldest = dates.reduce(function (min, d) { return d < min ? d : min; }, now);
            var through = startOfDay(oldest);
            var days = windowDays(now, firstWeekday).filter(function (day) { return day <= through; });
            var totals = {};
            return runBounded(days, maxConcurrent, function (day) {
                return fetchDayTotal(request, day).then(function (total) { totals[dayKey(day)] = total; });
            }).then(function () {
                return fromScrobbleDatesAndDayTotals(dates, totals, now, firstWeekday);
            });
        }
    }

    // ---- Refreshing from memory ---------------------------------------------------
    // Every day before today in a grid the loader returns is exact, and a finished day's count
    // does not change. So the grid remembers them (a memo: the local date and window it was
    // filled for, and the counts), and a refresh on the same day over the same window asks
    // Last.fm for today's total alone — one request instead of up to fifteen pages and 49 day
    // totals. A new local day loads everything again, which also picks up scrobbles an offline
    // device sent late for earlier days, once a day. The memo belongs to the Last.fm account and
    // the time zone it was filled for: another account, one whose name could not be read, or
    // another zone loads everything.

    /**
     * The time zone the local day keys were cut in: its name where the engine has one, and the
     * UTC offset at the start of `now`'s day either way. The same keys in another zone cover
     * other instants, so a memo filled in one zone is no use in another.
     */
    function timeZoneKey(now) {
        var zone = '';
        try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
        return zone + '|' + (-startOfDay(now).getTimezoneOffset());
    }

    /** The completed days of a loaded grid, remembered for `now`'s date, window and zone, and `user`. */
    function memoFromActivity(activity, now, firstWeekday, user) {
        var todayKey = dayKey(now);
        var counts = {};
        activity.days.forEach(function (day) {
            if (day.key < todayKey && day.count !== null) counts[day.key] = day.count;
        });
        return {
            user: user || null,
            date: todayKey,
            timeZone: timeZoneKey(now),
            windowStart: dayKey(windowStart(now, firstWeekday)),
            firstWeekday: firstWeekday,
            counts: counts
        };
    }

    /** Whether `memo` holds every day before today of `now`'s window, filled today, in this zone, for `user`. */
    function memoCovers(memo, now, firstWeekday, user) {
        if (!memo || !memo.counts) return false;
        if (!user || memo.user !== user) return false;
        if (memo.date !== dayKey(now) || memo.firstWeekday !== firstWeekday) return false;
        if (memo.timeZone !== timeZoneKey(now)) return false;
        if (memo.windowStart !== dayKey(windowStart(now, firstWeekday))) return false;
        var todayKey = dayKey(now);
        return windowDays(now, firstWeekday).every(function (day) {
            var key = dayKey(day);
            return key === todayKey || typeof memo.counts[key] === 'number';
        });
    }

    /**
     * The Last.fm grid, and the memo to refresh it from next time. With a memo that covers
     * `now` for the signed-in account `opts.user`, only today's total is asked for (from
     * midnight to now); otherwise everything is loaded, as loadLastFmActivity does. Without a
     * known account (its name could not be read) the memo is neither used nor replaced: it
     * still belongs to the account it was filled for.
     */
    function refreshLastFmActivity(opts) {
        var now = opts.now, firstWeekday = opts.firstWeekday, memo = opts.memo, user = opts.user;
        if (memoCovers(memo, now, firstWeekday, user)) {
            return fetchDayTotal(requester(opts), startOfDay(now), now).then(function (today) {
                var totals = {};
                Object.keys(memo.counts).forEach(function (key) { totals[key] = memo.counts[key]; });
                totals[dayKey(now)] = today;
                return { activity: fromScrobbleDatesAndDayTotals([], totals, now, firstWeekday), memo: memo };
            });
        }
        return loadLastFmActivity(opts).then(function (activity) {
            return { activity: activity, memo: user ? memoFromActivity(activity, now, firstWeekday, user) : (memo || null) };
        });
    }

    /**
     * The memo to keep once a load settles: the one a Last.fm grid hands back, none for any
     * other result, and on a failed load (`next` undefined) the one it started from. Its date,
     * window, zone and account already keep it from being used where it does not apply.
     */
    function memoAfterLoad(previous, next) {
        if (next === undefined) return previous || null;
        return (next && next.memo) || null;
    }

    /** Resolves null when NepTunes has recorded nothing yet — the empty state, not a silent grid. */
    function loadHistoryActivity(opts) {
        var history = opts.history, now = opts.now, firstWeekday = opts.firstWeekday;
        return Promise.resolve(history.info()).then(function (info) {
            var since = info && info.since ? new Date(info.since) : null;
            if (!since || isNaN(since.getTime())) return null;
            return Promise.resolve(history.query({
                from: windowStart(now, firstWeekday).toISOString(),
                to: addDays(startOfDay(now), 1).toISOString(),    // half-open: all of today
                groupBy: 'day'
            })).then(function (result) {
                return fromDayCounts((result && result.rows) || [], now, firstWeekday, since);
            });
        });
    }

    function hasLastFmCall(nt) { return !!(nt && nt.lastFm && typeof nt.lastFm.call === 'function'); }
    function hasHistory(nt) {
        return !!(nt && nt.history && typeof nt.history.info === 'function' && typeof nt.history.query === 'function');
    }

    function hasCode(error, code) { return !!(error && error.code === code); }

    /** The account name in a user.getInfo response, or null when it has none. */
    function userName(info) {
        var name = info && info.user && info.user.name;
        return typeof name === 'string' && name ? name : null;
    }

    /**
     * Which source to read, and for Last.fm the signed-in account's name (null when it could not
     * be read). 'auto' probes Last.fm with user.getInfo (cached by the app for 10 s) and falls
     * back to NepTunes history when signed out, or when the app refuses the lastFm permission —
     * the passthrough is then as unusable as missing. An explicit Last.fm source asks the same
     * question only for the name, and loads either way: the pages report a signed-out account
     * themselves. An explicit source whose API is missing means an app older than the widget.
     */
    function probeSource(setting, nt) {
        var lastFm = hasLastFmCall(nt), history = hasHistory(nt);
        if (setting === 'lastfm') {
            if (!lastFm) return Promise.resolve({ source: 'tooOld' });
            return Promise.resolve(nt.lastFm.call('user.getInfo')).then(function (info) {
                return { source: 'lastfm', user: userName(info) };
            }, function () {
                return { source: 'lastfm', user: null };
            });
        }
        if (setting === 'history') return Promise.resolve({ source: history ? 'history' : 'tooOld' });
        if (!lastFm) return Promise.resolve({ source: history ? 'history' : 'tooOld' });
        return Promise.resolve(nt.lastFm.call('user.getInfo')).then(function (info) {
            return { source: 'lastfm', user: userName(info) };
        }, function (error) {
            if (hasCode(error, 'notSignedIn')) return { source: history ? 'history' : 'notSignedIn' };
            if (hasCode(error, 'permissionDenied')) return { source: history ? 'history' : 'tooOld' };
            throw error;
        });
    }

    /** Which source to read: 'lastfm', 'history', 'notSignedIn' or 'tooOld'. See probeSource. */
    function resolveSource(setting, nt) {
        return probeSource(setting, nt).then(function (probed) { return probed.source; });
    }

    /**
     * A source the app refuses permission for reads like one it does not have: too old. In
     * Automatic, an account signed out between the probe and the pages falls back to history
     * as the probe would have; "Sign in to Last.fm" is only for an explicit Last.fm source.
     */
    function loadActivity(opts) {
        var nt = opts.nt || {};
        function refused(error) {
            if (hasCode(error, 'permissionDenied')) return { kind: 'tooOld' };
            throw error;
        }
        function loadHistory() {
            return loadHistoryActivity({ history: nt.history, now: opts.now, firstWeekday: opts.firstWeekday })
                .then(function (activity) {
                    return activity ? { kind: 'grid', unit: 'plays', activity: activity } : { kind: 'empty' };
                }, refused);
        }
        return probeSource(opts.setting, nt).then(function (probed) {
            var source = probed.source;
            if (source === 'tooOld' || source === 'notSignedIn') return { kind: source };
            if (source === 'history') return loadHistory();
            return refreshLastFmActivity({
                call: function (method, params) { return nt.lastFm.call(method, params); },
                now: opts.now, firstWeekday: opts.firstWeekday, isCurrent: opts.isCurrent,
                memo: opts.memo, user: probed.user, retryDelays: opts.retryDelays, wait: opts.wait
            }).then(function (loaded) {
                return { kind: 'grid', unit: 'scrobbles', activity: loaded.activity, memo: loaded.memo };
            }, function (error) {
                if (hasCode(error, 'notSignedIn')) {
                    return opts.setting !== 'lastfm' && hasHistory(nt) ? loadHistory() : { kind: 'notSignedIn' };
                }
                return refused(error);
            });
        });
    }

    // ---- Strings --------------------------------------------------------------
    // The widget's own translations, one table per app language, chosen by state.language.
    // Counts go through Intl.PluralRules; numbers and dates through state.locale. Wording
    // follows the app's catalogs where they say the same thing (the Scrobble nouns, "No data
    // for this day", the 7-week total, Settings, "widget").

    var STRINGS = {
        ar: {
            scrobbles: { zero: '{n} سكروبل', one: 'سكروبل واحد', two: 'سكروبلان', few: '{n} سكروبلات', many: '{n} سكروبلًا', other: '{n} سكروبل' },
            plays: { zero: '{n} مرة تشغيل', one: 'مرة تشغيل واحدة', two: 'مرتا تشغيل', few: '{n} مرات تشغيل', many: '{n} مرة تشغيل', other: '{n} مرة تشغيل' },
            noData: 'لا توجد بيانات لهذا اليوم',
            signIn: 'سجّل الدخول إلى Last.fm من إعدادات NepTunes',
            nothingYet: 'لم تستمع إلى أي شيء بعد',
            loadFailed: 'تعذّر تحميل نشاطك',
            tooOld: 'حدِّث NepTunes لاستخدام هذه الأداة',
            loading: 'جارٍ تحميل نشاط الاستماع في آخر 7 أسابيع',
            totals: { scrobbles: 'السكروبلات في آخر 7 أسابيع: {n}', plays: 'مرات التشغيل في آخر 7 أسابيع: {n}' }
        },
        ca: {
            scrobbles: { one: '{n} scrobble', many: '{n} de scrobbles', other: '{n} scrobbles' },
            plays: { one: '{n} reproducció', many: '{n} de reproduccions', other: '{n} reproduccions' },
            noData: 'Sense dades per a aquest dia',
            signIn: 'Inicia la sessió a Last.fm als Ajustos de NepTunes',
            nothingYet: 'Encara no has escoltat res',
            loadFailed: 'No s’ha pogut carregar la teva activitat',
            tooOld: 'Actualitza NepTunes per fer servir aquest giny',
            loading: 'Carregant la teva activitat d’escolta de les últimes 7 setmanes',
            totals: { scrobbles: 'Scrobbles de les últimes 7 setmanes: {n}', plays: 'Reproduccions de les últimes 7 setmanes: {n}' }
        },
        de: {
            scrobbles: { one: '{n} Scrobble', other: '{n} Scrobbles' },
            plays: { one: '{n} Wiedergabe', other: '{n} Wiedergaben' },
            noData: 'Keine Daten für diesen Tag',
            signIn: 'Melde dich in den NepTunes-Einstellungen bei Last.fm an',
            nothingYet: 'Noch nichts gehört',
            loadFailed: 'Deine Aktivität konnte nicht geladen werden',
            tooOld: 'Aktualisiere NepTunes, um dieses Widget zu verwenden',
            loading: 'Dein Hörverlauf der letzten 7 Wochen wird geladen',
            totals: { scrobbles: 'Scrobbles der letzten 7 Wochen: {n}', plays: 'Wiedergaben der letzten 7 Wochen: {n}' }
        },
        en: {
            scrobbles: { one: '{n} scrobble', other: '{n} scrobbles' },
            plays: { one: '{n} play', other: '{n} plays' },
            noData: 'No data for this day',
            signIn: 'Sign in to Last.fm in NepTunes Settings',
            nothingYet: 'Nothing played yet',
            loadFailed: 'Couldn’t load your activity',
            tooOld: 'Update NepTunes to use this widget',
            loading: 'Loading your last 7 weeks of listening',
            totals: { scrobbles: 'Scrobbles in the last 7 weeks: {n}', plays: 'Plays in the last 7 weeks: {n}' }
        },
        es: {
            scrobbles: { one: '{n} scrobble', many: '{n} de scrobbles', other: '{n} scrobbles' },
            plays: { one: '{n} reproducción', many: '{n} de reproducciones', other: '{n} reproducciones' },
            noData: 'Sin datos para este día',
            signIn: 'Inicia sesión en Last.fm desde los Ajustes de NepTunes',
            nothingYet: 'Aún no has escuchado nada',
            loadFailed: 'No se pudo cargar tu actividad',
            tooOld: 'Actualiza NepTunes para usar este widget',
            loading: 'Cargando tu actividad de escucha de las últimas 7 semanas',
            totals: { scrobbles: 'Scrobbles de las últimas 7 semanas: {n}', plays: 'Reproducciones de las últimas 7 semanas: {n}' }
        },
        fr: {
            scrobbles: { one: '{n} scrobble', many: '{n} de scrobbles', other: '{n} scrobbles' },
            plays: { one: '{n} écoute', many: '{n} d’écoutes', other: '{n} écoutes' },
            noData: 'Aucune donnée pour ce jour',
            signIn: 'Connectez-vous à Last.fm dans les Réglages de NepTunes',
            nothingYet: 'Vous n’avez encore rien écouté',
            loadFailed: 'Impossible de charger votre activité',
            tooOld: 'Mettez à jour NepTunes pour utiliser ce widget',
            loading: 'Chargement de votre activité d’écoute des 7 dernières semaines',
            totals: { scrobbles: 'Scrobbles des 7 dernières semaines : {n}', plays: 'Écoutes des 7 dernières semaines : {n}' }
        },
        it: {
            scrobbles: { one: '{n} scrobble', many: '{n} di scrobble', other: '{n} scrobble' },
            plays: { one: '{n} ascolto', many: '{n} di ascolti', other: '{n} ascolti' },
            noData: 'Nessun dato per questo giorno',
            signIn: 'Accedi a Last.fm nelle Impostazioni di NepTunes',
            nothingYet: 'Non hai ancora ascoltato nulla',
            loadFailed: 'Impossibile caricare la tua attività',
            tooOld: 'Aggiorna NepTunes per usare questo widget',
            loading: 'Caricamento dei tuoi ascolti delle ultime 7 settimane',
            totals: { scrobbles: 'Scrobble delle ultime 7 settimane: {n}', plays: 'Ascolti delle ultime 7 settimane: {n}' }
        },
        ja: {
            scrobbles: { other: '{n} Scrobble' },
            plays: { other: '{n} 回再生' },
            noData: 'この日のデータはありません',
            signIn: 'NepTunes の設定で Last.fm にサインインしてください',
            nothingYet: 'まだ何も再生していません',
            loadFailed: 'アクティビティを読み込めませんでした',
            tooOld: 'このウィジェットを使うには NepTunes をアップデートしてください',
            loading: '過去7週間の再生履歴を読み込み中',
            totals: { scrobbles: '過去7週間のScrobble: {n}', plays: '過去7週間の再生回数: {n}' }
        },
        nl: {
            scrobbles: { one: '{n} scrobble', other: '{n} scrobbles' },
            plays: { one: '{n} keer afgespeeld', other: '{n} keer afgespeeld' },
            noData: 'Geen gegevens voor deze dag',
            signIn: 'Log in bij Last.fm via de NepTunes-instellingen',
            nothingYet: 'Nog niets afgespeeld',
            loadFailed: 'Je activiteit kon niet worden geladen',
            tooOld: 'Werk NepTunes bij om deze widget te gebruiken',
            loading: 'Je luisteractiviteit van de laatste 7 weken wordt geladen',
            totals: { scrobbles: 'Scrobbles in de laatste 7 weken: {n}', plays: '{n} keer afgespeeld in de laatste 7 weken' }
        },
        pl: {
            scrobbles: { one: '{n} scrobble', few: '{n} scrobble', many: '{n} scrobbli', other: '{n} scrobbla' },
            plays: { one: '{n} odtworzenie', few: '{n} odtworzenia', many: '{n} odtworzeń', other: '{n} odtworzenia' },
            noData: 'Brak danych dla tego dnia',
            signIn: 'Zaloguj się do Last.fm w ustawieniach NepTunes',
            nothingYet: 'Jeszcze nic nie odtworzono',
            loadFailed: 'Nie udało się wczytać aktywności',
            tooOld: 'Zaktualizuj NepTunes, aby używać tego widżetu',
            loading: 'Wczytywanie aktywności z ostatnich 7 tygodni',
            totals: { scrobbles: 'Scrobble z ostatnich 7 tygodni: {n}', plays: 'Odtworzenia z ostatnich 7 tygodni: {n}' }
        },
        'pt-BR': {
            // CLDR files 0 under "one"; Brazilian Portuguese counts zero in the plural.
            scrobbles: { zero: '{n} scrobbles', one: '{n} scrobble', many: '{n} de scrobbles', other: '{n} scrobbles' },
            plays: { zero: '{n} reproduções', one: '{n} reprodução', many: '{n} de reproduções', other: '{n} reproduções' },
            noData: 'Sem dados para este dia',
            signIn: 'Entre no Last.fm nos Ajustes do NepTunes',
            nothingYet: 'Você ainda não ouviu nada',
            loadFailed: 'Não foi possível carregar sua atividade',
            tooOld: 'Atualize o NepTunes para usar este widget',
            loading: 'Carregando sua atividade das últimas 7 semanas',
            totals: { scrobbles: 'Scrobbles das últimas 7 semanas: {n}', plays: 'Reproduções das últimas 7 semanas: {n}' }
        },
        ru: {
            scrobbles: { one: '{n} скроббл', few: '{n} скроббла', many: '{n} скробблов', other: '{n} скроббла' },
            plays: { one: '{n} прослушивание', few: '{n} прослушивания', many: '{n} прослушиваний', other: '{n} прослушивания' },
            noData: 'Нет данных за этот день',
            signIn: 'Войдите в Last.fm в настройках NepTunes',
            nothingYet: 'Вы ещё ничего не слушали',
            loadFailed: 'Не удалось загрузить активность',
            tooOld: 'Обновите NepTunes, чтобы пользоваться этим виджетом',
            loading: 'Загрузка прослушиваний за последние 7 недель',
            totals: { scrobbles: 'Скробблы за последние 7 недель: {n}', plays: 'Прослушивания за последние 7 недель: {n}' }
        },
        uk: {
            scrobbles: { one: '{n} скробл', few: '{n} скробли', many: '{n} скроблів', other: '{n} скробла' },
            plays: { one: '{n} прослуховування', few: '{n} прослуховування', many: '{n} прослуховувань', other: '{n} прослуховування' },
            noData: 'Немає даних за цей день',
            signIn: 'Увійдіть у Last.fm у налаштуваннях NepTunes',
            nothingYet: 'Ви ще нічого не слухали',
            loadFailed: 'Не вдалося завантажити активність',
            tooOld: 'Оновіть NepTunes, щоб користуватися цим віджетом',
            loading: 'Завантаження прослуховувань за останні 7 тижнів',
            totals: { scrobbles: 'Скробли за останні 7 тижнів: {n}', plays: 'Прослуховування за останні 7 тижнів: {n}' }
        },
        'zh-Hans': {
            scrobbles: { other: '{n} 次 Scrobble' },
            plays: { other: '{n} 次播放' },
            noData: '这一天没有数据',
            signIn: '请在 NepTunes 设置中登录 Last.fm',
            nothingYet: '还没有收听记录',
            loadFailed: '无法加载你的收听记录',
            tooOld: '请更新 NepTunes 以使用此小组件',
            loading: '正在加载最近 7 周的收听记录',
            totals: { scrobbles: '最近 7 周的 Scrobble：{n}', plays: '最近 7 周的播放次数：{n}' }
        }
    };
    var LANGUAGES = Object.keys(STRINGS);

    function pickLanguage(tag) {
        if (typeof tag !== 'string' || !tag) return 'en';
        if (STRINGS[tag]) return tag;
        var lower = tag.toLowerCase();
        if (lower === 'pt' || lower.indexOf('pt-') === 0) return 'pt-BR';
        if (lower === 'zh' || lower.indexOf('zh-') === 0) return 'zh-Hans';
        var base = lower.split('-')[0];
        return STRINGS[base] ? base : 'en';
    }

    // A malformed tag (the ICU "ar_SA" form) makes Intl throw RangeError; degrade, never die.
    function formatNumber(n, locale) {
        try { return new Intl.NumberFormat(locale || undefined).format(n); } catch (e) { return String(n); }
    }

    function formatDay(date, locale) {
        try { return new Intl.DateTimeFormat(locale || undefined, { day: 'numeric', month: 'short' }).format(date); }
        catch (e) { return dayKey(date); }
    }

    function pluralCategory(n, lang) {
        try { return new Intl.PluralRules(lang).select(n); } catch (e) { return n === 1 ? 'one' : 'other'; }
    }

    /** A table's `zero` form wins for 0 in any language, as a stringsdict's does. */
    function countText(unit, n, lang, locale) {
        var forms = (STRINGS[lang] || STRINGS.en)[unit];
        var form = (n === 0 && forms.zero) || forms[pluralCategory(n, lang)] || forms.other;
        return form.replace('{n}', formatNumber(n, locale));
    }

    function summaryText(unit, total, lang, locale) {
        return (STRINGS[lang] || STRINGS.en).totals[unit].replace('{n}', formatNumber(total, locale));
    }

    // ---- Geometry & settings ----------------------------------------------------
    // One layout, used both to place the DOM and to hit-test pointer events, so what is
    // drawn and what is hovered cannot disagree. Proportions are the onboarding's: 11pt
    // cells 3pt apart, radius 3 — a 95pt grid of which each gap is 3/95.

    var CARD_GUTTER = { left: 20, top: 16, right: 20, bottom: 24 };   // shadow extent + 8 (styles.css)
    var BARE_GUTTER = { left: 6, top: 6, right: 6, bottom: 6 };
    var CARD_PADDING = 0.1;
    var CALLOUT_GAP = 5;
    /** The top two rows have nothing above them inside the card, so their callout drops below. */
    var ROWS_WITHOUT_ROOM_ABOVE = 2;

    function layout(width, height, background) {
        var bare = background === 'none';
        var g = bare ? BARE_GUTTER : CARD_GUTTER;
        var availableWidth = Math.max(0, width - g.left - g.right);
        var availableHeight = Math.max(0, height - g.top - g.bottom);
        var side = Math.min(availableWidth, availableHeight);
        var cardX = g.left + Math.floor((availableWidth - side) / 2);
        var cardY = g.top + Math.floor((availableHeight - side) / 2);
        var pad = bare ? 0 : Math.round(side * CARD_PADDING);
        var inner = side - 2 * pad;
        var gap = Math.max(1, Math.round(inner * 3 / 95));
        var cell = Math.max(1, Math.floor((inner - (WEEK_COUNT - 1) * gap) / WEEK_COUNT));
        var gridSide = WEEK_COUNT * cell + (WEEK_COUNT - 1) * gap;
        var offset = Math.floor((inner - gridSide) / 2);
        return {
            card: { x: cardX, y: cardY, side: side },
            grid: { x: cardX + pad + offset, y: cardY + pad + offset, side: gridSide },
            cell: cell,
            gap: gap,
            radius: Math.round(cell * 3 / 11 * 2) / 2,
            panelRadius: Math.min(22, Math.max(10, Math.round(side * 0.11))),
            statusSize: Math.min(15, Math.max(10, Math.round(side / 12)))
        };
    }

    function cellRect(l, column, row, rtl) {
        var pitch = l.cell + l.gap;
        var visualColumn = rtl ? WEEK_COUNT - 1 - column : column;
        return { x: l.grid.x + visualColumn * pitch, y: l.grid.y + row * pitch, w: l.cell, h: l.cell };
    }

    /** Page CSS px → the slot under them. Each gap is split between its two neighbours. */
    function hitTest(l, x, y, rtl) {
        if (!isFinite(x) || !isFinite(y)) return null;
        var pitch = l.cell + l.gap, half = l.gap / 2;
        var gx = x - l.grid.x + half, gy = y - l.grid.y + half;
        if (gx < 0 || gy < 0 || gx >= WEEK_COUNT * pitch || gy >= ROWS * pitch) return null;
        var visualColumn = Math.floor(gx / pitch);
        return { column: rtl ? WEEK_COUNT - 1 - visualColumn : visualColumn, row: Math.floor(gy / pitch) };
    }

    function calloutBounds(width, height) { return { x: 2, y: 2, w: width - 4, h: height - 4 }; }

    /**
     * ScrobbleActivityCalloutLayout: centred on the cell, above it or below, clamped to bounds.
     * The Swift layout clamps only across; a widget window is small enough that a callout can
     * run off its bottom too, so this clamps down as well, the top edge winning if both bind.
     */
    function calloutOrigin(cell, size, row, bounds) {
        var above = row >= ROWS_WITHOUT_ROOM_ABOVE;
        var x = cell.x + cell.w / 2 - size.w / 2;
        var y = above ? cell.y - CALLOUT_GAP - size.h : cell.y + cell.h + CALLOUT_GAP;
        x = Math.min(Math.max(x, bounds.x), Math.max(bounds.x + bounds.w - size.w, bounds.x));
        y = Math.min(Math.max(y, bounds.y), Math.max(bounds.y + bounds.h - size.h, bounds.y));
        return { x: x, y: y, above: above };
    }

    /** 49 slots, column-major (index = column × 7 + row): the window's days, then empty slots. */
    function gridCells(activity, now, firstWeekday) {
        var days = activity ? activity.days : null;
        var count = days ? days.length : windowDays(now, firstWeekday).length;
        var cells = [];
        for (var i = 0; i < ROWS * WEEK_COUNT; i++) {
            if (i >= count) cells.push({ kind: 'outside' });
            else if (!days) cells.push({ kind: 'pending' });
            else cells.push({ kind: 'day', day: days[i] });
        }
        return cells;
    }

    function cellClass(cell) {
        if (cell.kind === 'outside') return 'outside';
        if (cell.kind === 'pending') return 'pending';
        return cell.day.count === null ? 'unknown' : 'level-' + cell.day.level;
    }

    function loadingMotion(reduceMotion) { return reduceMotion ? 'pulse' : 'sweep'; }

    /** A second past the next local midnight, through the calendar so a 23 h or 25 h day is right. */
    function msUntilNextMidnight(now) {
        return addDays(startOfDay(now), 1).getTime() - now.getTime() + 1000;
    }

    var DEFAULT_SETTINGS = {
        source: 'auto', accentSource: 'album', fixedColor: '#5B92EA', theme: 'auto', firstWeekday: 'system', background: 'card'
    };
    var SETTING_VALUES = {
        source: ['auto', 'lastfm', 'history'],
        accentSource: ['album', 'fixed'],
        theme: ['auto', 'dark', 'light'],
        firstWeekday: ['system', 'monday', 'sunday', 'saturday'],
        background: ['card', 'none']
    };

    /** The one colour form a setting may hold: it reaches the page only as three numbers. */
    function isHexColor(value) { return typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value); }

    // NTKit is the vendored neptunes-kit.js, loaded before this file (and set up by the tests).
    function accentRgb(hex) {
        var rgb = isHexColor(hex) && typeof NTKit !== 'undefined' && NTKit.hexToRgb ? NTKit.hexToRgb(hex) : null;
        return rgb || [91, 146, 234];
    }

    function normalizeSettings(raw) {
        raw = raw || {};
        var out = {};
        Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
            var value = raw[key];
            var allowed = SETTING_VALUES[key];
            if (allowed) out[key] = allowed.indexOf(value) !== -1 ? value : DEFAULT_SETTINGS[key];
            else out[key] = isHexColor(value) ? value : DEFAULT_SETTINGS[key];
        });
        return out;
    }

    // ---- Accent -------------------------------------------------------------------
    // "From album art" (the default) tints the grid with the playing cover's dominant colour;
    // "Fixed color" with the user's pick. With nothing playing, or a track without a cover, album
    // art falls back to NepTunes' own accent: this widget stays up with nothing playing, and its
    // idle grid is the app's blue — not a grey one, and not the fixed colour, which is Fixed's.

    /**
     * NepTunes' app accent for the panel: the source of truth is `Color.appAccent` in
     * NepTunesKit/Sources/NepTunesUI/AppAccent.swift — Display P3 (91, 146, 234) on a light
     * appearance, (60, 120, 217) on a dark one. The ramp below mixes in sRGB from three sRGB
     * numbers, so both are carried here converted to sRGB (both sit inside it, nothing clipped).
     * Widgets have no API for the app's colour; restate it here if AppAccent.swift changes.
     * It is a brand colour made for both appearances, so it is painted as is, never moved.
     */
    var APP_ACCENT_LIGHT = [71, 148, 241];   // Display P3 (91, 146, 234)
    var APP_ACCENT_DARK = [30, 122, 224];    // Display P3 (60, 120, 217)
    function appAccent(dark) { return (dark ? APP_ACCENT_DARK : APP_ACCENT_LIGHT).slice(); }

    /**
     * The album colour as the grid paints it. A cover's dominant colour can sit right on the
     * panel (navy on the dark card, pale yellow on the light one) and take the whole ramp with
     * it, so it is moved, hue kept, until it reads against the panel — NTKit's legibleAccent,
     * the ink the other widgets derive from the same cover. A picked colour is painted as picked.
     */
    function albumAccent(rgb, dark) { return NTKit.legibleAccent(rgb, dark); }

    /**
     * What the grid should be tinted with: `{ key, rgb }` to paint at once, or `{ key, url, pending }`
     * for a cover to decode first, with `pending` the tint to show meanwhile when the grid has none
     * yet. `key` is the cache identity of that tint — the page repaints exactly when it moves, and
     * statechange fires on every position tick. A picked colour does not depend on the panel, so
     * only the album and app-accent keys carry the theme.
     */
    function accentTarget(s, artworkURL, dark) {
        var polarity = dark ? 'dark' : 'light';
        if (s.accentSource === 'fixed') return { key: 'fixed|' + s.fixedColor, rgb: accentRgb(s.fixedColor) };
        if (artworkURL) return { key: 'album|' + polarity + '|' + artworkURL, url: artworkURL, pending: appAccent(dark) };
        return { key: 'app|' + polarity, rgb: appAccent(dark) };
    }

    // ---- States -------------------------------------------------------------------
    var STATUS_KEYS = { notSignedIn: 'signIn', empty: 'nothingYet', error: 'loadFailed', tooOld: 'tooOld' };

    /** The STRINGS key a settled load shows instead of the grid, or null for the grid itself. */
    function statusKey(result) { return (result && STATUS_KEYS[result.kind]) || null; }

    // ---- Page (browser only) ------------------------------------------------
    // Everything below touches the DOM or window.NepTunes. Nodes are looked up in init():
    // Node and JavaScriptCore load this file with no document.

    var REFRESH_MS = 10 * 60 * 1000;
    var RETRY_MS = 60 * 1000;
    // A reload can be the probe, 15 Last.fm pages and up to 49 day totals, so a run of source or
    // week-start changes loads once, when it settles. Appearance changes (a ColorPicker drag
    // posts one per tick) never load.
    var SETTINGS_RELOAD_MS = 400;

    var root = null, card = null, panelShadow = null, gridEl = null, statusEl = null;
    var calloutEl = null, calloutCount = null, calloutDate = null, resizeHandle = null;
    var cellEls = [];
    var settings = normalizeSettings(null);
    var settingsArrived = false;   // NepTunes.settings is null until the host's first push
    var state = null;
    var lang = 'en', locale = null, rtl = false;
    var phase = 'loading';         // 'loading' until a load settles, then 'ready'
    var result = null;             // what loadActivity() last settled on
    var resultFirstWeekday = 1;    // the first weekday `result` was loaded for
    // The Last.fm grid's completed days, so a refresh asks for today alone (refreshLastFmActivity).
    // Forgotten on a new source or week start and a new local day, kept through a failed load;
    // ignored for any Last.fm account or time zone but the one it was filled for (memoCovers).
    var lastFmMemo = null;
    var loadToken = 0;
    var currentLayout = null;
    var cells = [];
    var hoveredIndex = -1;
    var reducedMotion = null;
    var refreshTimer = null, midnightTimer = null, retryTimer = null, settingsReloadTimer = null;
    // The accentTarget key on the grid, or ACCENT_UNSET before the first paint: an object, so it
    // never equals a key, which is always a string.
    var ACCENT_UNSET = {};
    var lastAccentKey = ACCENT_UNSET;

    function effectiveFirstWeekday() {
        // `state || {}`: before the host's first push there is no region to follow yet.
        return firstWeekday(settings.firstWeekday, state || {});
    }

    function buildCells() {
        var fragment = document.createDocumentFragment();
        for (var i = 0; i < ROWS * WEEK_COUNT; i++) {
            var el = document.createElement('div');
            el.className = 'cell outside';
            el.dataset.index = String(i);
            // Diagonal distance from the top-left corner, 0…1: the loading sweep's phase.
            el.style.setProperty('--diag', String((Math.floor(i / ROWS) + i % ROWS) / 12));
            fragment.appendChild(el);
            cellEls.push(el);
        }
        gridEl.appendChild(fragment);
    }

    function applyAppearance() {
        root.classList.remove('theme-auto', 'theme-dark', 'theme-light');
        root.classList.add('theme-' + settings.theme);
        root.classList.toggle('bare', settings.background === 'none');
        updateAccent();
    }

    function paintAccent(rgb) { root.style.setProperty('--accent-rgb', rgb.join(', ')); }

    /**
     * Repaints the accent when what it depends on moved: the source, the fixed colour, the cover
     * and — for a cover — the panel's polarity. A new cover keeps the old tint until it has
     * decoded, so a change of cover goes straight from one tint to the next.
     */
    function updateAccent() {
        var nt = window.NepTunes;
        var dark = NTKit.panelIsDark(settings.theme);
        var url = settings.accentSource === 'album' && nt && nt.getArtworkDataURL ? nt.getArtworkDataURL() : null;
        var target = accentTarget(settings, url, dark);
        if (target.key === lastAccentKey) return;
        var firstPaint = lastAccentKey === ACCENT_UNSET;
        lastAccentKey = target.key;
        if (target.rgb) { paintAccent(target.rgb); return; }
        // First load with a cover: nothing earlier to keep while it decodes, so the app accent.
        if (firstPaint) paintAccent(target.pending);
        // NTKit.accent resolves a neutral palette for an undecodable cover rather than rejecting.
        NTKit.accent(target.url).then(function (palette) {
            if (lastAccentKey !== target.key) return;   // the cover or the settings moved on meanwhile
            paintAccent(albumAccent(palette.accent, dark));
        });
    }

    // The desktop switched between light and dark. The panel follows in CSS; an album colour was
    // picked against the old panel, so it is picked again. An explicit theme does not move.
    function onThemeChange() {
        if (settings.theme === 'auto') updateAccent();
    }

    function applyLayout() {
        currentLayout = layout(window.innerWidth, window.innerHeight, settings.background);
        var c = currentLayout.card;
        [card, panelShadow].forEach(function (el) {
            el.style.left = c.x + 'px';
            el.style.top = c.y + 'px';
            el.style.width = c.side + 'px';
            el.style.height = c.side + 'px';
        });
        root.style.setProperty('--panel-radius', currentLayout.panelRadius + 'px');
        root.style.setProperty('--cell-radius', currentLayout.radius + 'px');
        root.style.setProperty('--status-size', currentLayout.statusSize + 'px');
        for (var i = 0; i < cellEls.length; i++) {
            var r = cellRect(currentLayout, Math.floor(i / ROWS), i % ROWS, rtl);
            var s = cellEls[i].style;
            s.left = r.x + 'px';
            s.top = r.y + 'px';
            s.width = r.w + 'px';
            s.height = r.h + 'px';
        }
    }

    function render() {
        var status = phase === 'ready' ? statusKey(result) : null;
        gridEl.hidden = !!status;
        statusEl.hidden = !status;
        card.dataset.phase = phase;
        card.dataset.kind = result ? result.kind : '';
        if (status) {
            statusEl.textContent = STRINGS[lang][status];
            hideCallout();
            return;
        }
        var activity = phase === 'ready' && result && result.kind === 'grid' ? result.activity : null;
        cells = gridCells(activity, new Date(), activity ? resultFirstWeekday : effectiveFirstWeekday());
        var motion = activity ? null : loadingMotion(!!(reducedMotion && reducedMotion.matches));
        gridEl.classList.toggle('sweep', motion === 'sweep');
        gridEl.classList.toggle('pulse', motion === 'pulse');
        for (var i = 0; i < cellEls.length; i++) {
            var cell = cells[i], el = cellEls[i];
            el.className = 'cell ' + cellClass(cell);
            if (cell.kind === 'day') {
                el.dataset.key = cell.day.key;
                el.dataset.count = cell.day.count === null ? '' : String(cell.day.count);
                el.dataset.level = String(cell.day.level);
            } else {
                delete el.dataset.key;
                delete el.dataset.count;
                delete el.dataset.level;
            }
        }
        gridEl.setAttribute('aria-label', activity
            ? summaryText(result.unit, totalCount(activity), lang, locale)
            : STRINGS[lang].loading);
        // The class reset above dropped the outline; this puts it back, with fresh text.
        if (hoveredIndex >= 0) showCallout(hoveredIndex);
    }

    function onPointerMove(point) {
        if (!point || !currentLayout) return;
        var hit = hitTest(currentLayout, Number(point.x), Number(point.y), rtl);
        if (!hit) { hideCallout(); return; }
        showCallout(hit.column * ROWS + hit.row);
    }

    function showCallout(index) {
        var cell = cells[index];
        if (!cell || cell.kind !== 'day' || !result || result.kind !== 'grid') { hideCallout(); return; }
        if (hoveredIndex !== index && cellEls[hoveredIndex]) cellEls[hoveredIndex].classList.remove('hovered');
        hoveredIndex = index;
        cellEls[index].classList.add('hovered');
        calloutCount.textContent = cell.day.count === null
            ? STRINGS[lang].noData
            : countText(result.unit, cell.day.count, lang, locale);
        calloutDate.textContent = formatDay(cell.day.date, locale);
        calloutEl.hidden = false;
        var row = index % ROWS;
        var origin = calloutOrigin(
            cellRect(currentLayout, Math.floor(index / ROWS), row, rtl),
            { w: calloutEl.offsetWidth, h: calloutEl.offsetHeight },
            row,
            calloutBounds(window.innerWidth, window.innerHeight));
        calloutEl.style.left = origin.x + 'px';
        calloutEl.style.top = origin.y + 'px';
        calloutEl.dataset.placement = origin.above ? 'above' : 'below';
    }

    function hideCallout() {
        if (cellEls[hoveredIndex]) cellEls[hoveredIndex].classList.remove('hovered');
        hoveredIndex = -1;
        if (calloutEl) calloutEl.hidden = true;
    }

    /** Back to the loading grid; a load still in flight can no longer land. */
    function showLoadingGrid() {
        loadToken++;
        phase = 'loading';
        result = null;
        hideCallout();
        render();
    }

    /**
     * Loads need the host's state (its region picks the week start) and its settings (the
     * source). The host pushes state first, so a load started then would read the defaults and
     * be redone as soon as the settings land.
     */
    function reload(showLoading) {
        if (!state || !settingsArrived) return;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        if (settingsReloadTimer) { clearTimeout(settingsReloadTimer); settingsReloadTimer = null; }
        if (showLoading || phase !== 'ready') showLoadingGrid();
        var token = ++loadToken;
        var weekStart = effectiveFirstWeekday();
        loadActivity({
            setting: settings.source, nt: window.NepTunes, now: new Date(), firstWeekday: weekStart,
            isCurrent: function () { return token === loadToken; }, memo: lastFmMemo
        })
            .then(function (next) {
                if (token !== loadToken) return;   // a newer load superseded this one
                lastFmMemo = memoAfterLoad(lastFmMemo, next);
                result = next;
                resultFirstWeekday = weekStart;
                phase = 'ready';
                render();
            }, function () {
                if (token !== loadToken) return;
                lastFmMemo = memoAfterLoad(lastFmMemo, undefined);
                // Calm: a refresh that fails keeps the grid already on screen; only a load with
                // nothing to show says so. Either way, try again in a minute.
                if (!(result && result.kind === 'grid')) {
                    result = { kind: 'error' };
                    phase = 'ready';
                    render();
                }
                retryTimer = setTimeout(function () { retryTimer = null; reload(false); }, RETRY_MS);
            });
    }

    // Today is the grid's last filled cell, so the window moves at local midnight.
    function scheduleMidnight() {
        if (midnightTimer) clearTimeout(midnightTimer);
        midnightTimer = setTimeout(function () {
            midnightTimer = null;
            lastFmMemo = null;   // a new day: load every day again, late scrobbles included
            reload(false);
            scheduleMidnight();
        }, msUntilNextMidnight(new Date()));
    }

    function onSettings(next) {
        if (!next) return;
        var previous = settingsArrived ? settings : null;
        settings = normalizeSettings(next);
        settingsArrived = true;
        // Accent, theme and background only restyle, at once and without a reload.
        applyAppearance();
        applyLayout();
        if (!state) { render(); return; }
        if (!previous) { reload(true); return; }   // the first load was waiting for these
        if (previous.source === settings.source && previous.firstWeekday === settings.firstWeekday) {
            render();
            return;
        }
        // A new source or week start invalidates what is on screen: back to the loading grid at
        // once, and load when the changes settle.
        lastFmMemo = null;
        showLoadingGrid();
        if (settingsReloadTimer) clearTimeout(settingsReloadTimer);
        settingsReloadTimer = setTimeout(function () {
            settingsReloadTimer = null;
            reload(false);
        }, SETTINGS_RELOAD_MS);
    }

    function onState(next) {
        if (!next) return;
        // Mirror for a right-to-left host. On state, not at startup: state is null until the
        // host's first push, which lands after DOMContentLoaded.
        if (next.layoutDirection) document.documentElement.dir = next.layoutDirection;
        var first = state === null;
        var weekdayBefore = first ? null : effectiveFirstWeekday();
        state = next;
        var nextLang = pickLanguage(next.language);
        var nextLocale = next.locale || null;
        var textChanged = nextLang !== lang || nextLocale !== locale;
        lang = nextLang;
        locale = nextLocale;
        updateAccent();   // cheap unless the cover changed: see accentTarget
        var nextRtl = next.layoutDirection === 'rtl';
        if (nextRtl !== rtl) {
            rtl = nextRtl;
            applyLayout();
            textChanged = true;
        }
        if (settingsArrived && (first || effectiveFirstWeekday() !== weekdayBefore)) {
            lastFmMemo = null;
            reload(true);
            return;
        }
        if (first || textChanged) render();   // statechange fires on every position tick: stay cheap otherwise
    }

    // Square-locked resize, V3's pattern: both deltas averaged, so the window grows along the
    // diagonal and the grid stays square.
    function setupResize() {
        var resizing = false, lastX = 0, lastY = 0;
        function post(message) {
            if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.neptunes) {
                window.webkit.messageHandlers.neptunes.postMessage(message);
            }
        }
        resizeHandle.addEventListener('mousedown', function (e) {
            resizing = true;
            lastX = e.screenX;
            lastY = e.screenY;
            e.preventDefault();
            e.stopPropagation();
        });
        document.addEventListener('mousemove', function (e) {
            if (!resizing) return;
            var delta = ((e.screenX - lastX) + (e.screenY - lastY)) / 2;
            lastX = e.screenX;
            lastY = e.screenY;
            post({ type: 'resizeMove', deltaX: delta, deltaY: delta });
        });
        document.addEventListener('mouseup', function () {
            if (!resizing) return;
            resizing = false;
            post({ type: 'resizeEnd' });
        });
    }

    function init() {
        root = document.documentElement;
        card = document.getElementById('widget');
        panelShadow = document.getElementById('panelShadow');
        gridEl = document.getElementById('grid');
        statusEl = document.getElementById('status');
        calloutEl = document.getElementById('callout');
        calloutCount = document.getElementById('calloutCount');
        calloutDate = document.getElementById('calloutDate');
        resizeHandle = document.getElementById('resizeHandle');

        buildCells();
        applyAppearance();
        applyLayout();
        render();
        window.addEventListener('resize', function () { applyLayout(); render(); });

        if (!window.NepTunes) return;
        reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
        if (reducedMotion && reducedMotion.addEventListener) reducedMotion.addEventListener('change', render);
        NepTunes.on('settingschange', onSettings);
        NepTunes.on('statechange', onState);
        NepTunes.on('themechange', onThemeChange);
        // pointerTracking (manifest): the host sends page-CSS-px pointer positions while the
        // pointer is over the widget. `:hover` never works in a widget panel.
        NepTunes.on('pointermove', onPointerMove);
        NepTunes.on('pointerleave', hideCallout);
        setupResize();
        onSettings(NepTunes.settings);
        onState(NepTunes.state);
        refreshTimer = setInterval(function () { reload(false); }, REFRESH_MS);
        scheduleMidnight();
        if (NepTunes._signalReady) NepTunes._signalReady();
    }

    function start() {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
        else init();
    }

    return {
        WEEK_COUNT: WEEK_COUNT, ROWS: ROWS, MAX_LEVEL: MAX_LEVEL,
        dayKey: dayKey, windowStart: windowStart, windowDays: windowDays, level: level,
        fromScrobbleDates: fromScrobbleDates, fromDayCounts: fromDayCounts, totalCount: totalCount,
        firstWeekday: firstWeekday,
        PAGE_SIZE: PAGE_SIZE, MAX_PAGES: MAX_PAGES, MAX_CONCURRENT_PAGES: MAX_CONCURRENT_PAGES,
        recentTracksPage: recentTracksPage, loadLastFmActivity: loadLastFmActivity,
        RETRY_DELAYS_MS: RETRY_DELAYS_MS, TRANSIENT_CODES: TRANSIENT_CODES,
        refreshLastFmActivity: refreshLastFmActivity, memoFromActivity: memoFromActivity, memoCovers: memoCovers,
        memoAfterLoad: memoAfterLoad,
        loadHistoryActivity: loadHistoryActivity, resolveSource: resolveSource, loadActivity: loadActivity,
        LANGUAGES: LANGUAGES, STRINGS: STRINGS, pickLanguage: pickLanguage, countText: countText,
        summaryText: summaryText, formatDay: formatDay, formatNumber: formatNumber,
        layout: layout, cellRect: cellRect, hitTest: hitTest, calloutBounds: calloutBounds,
        calloutOrigin: calloutOrigin, gridCells: gridCells, cellClass: cellClass,
        loadingMotion: loadingMotion, msUntilNextMidnight: msUntilNextMidnight,
        normalizeSettings: normalizeSettings, accentRgb: accentRgb, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
        albumAccent: albumAccent, accentTarget: accentTarget, appAccent: appAccent,
        statusKey: statusKey, REFRESH_MS: REFRESH_MS, RETRY_MS: RETRY_MS, SETTINGS_RELOAD_MS: SETTINGS_RELOAD_MS,
        start: start
    };
});
