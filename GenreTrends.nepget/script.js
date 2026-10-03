/**
 * Genre Trends — your top genres day by day, as a stacked area standing on the bottom edge: one
 * band for each of the top five genres and a grey "Other" for the rest, over the last 7 or 30
 * days, against a plays-per-day scale (two or three round gridlines, labelled on the leading
 * edge, the unit above). Each band's name is written inside it where it fits; a one-line legend
 * names the bands that had no room. history.query gives per-range totals only, so the timeline
 * is one { groupBy: 'genre' } query per day, asked a couple at a time, with finished days
 * remembered until midnight and today asked again. Pinned by _dev/genre-trends.test.mjs and, in
 * WebKit, by GenreTrendsWidgetPageTests.
 */
(function (factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else api.start();
})(function () {
    'use strict';

    // NTHistory (history-stats.js) and NTKit (neptunes-kit.js) are loaded before this file, and
    // set up as globals by the tests. Read them inside functions: Node loads this file bare.

    // ---- Model --------------------------------------------------------------

    /** The genres drawn by name: the top five of the range; the rest are summed into "Other". */
    var TOP_GENRES = 5;

    /** The range's days, oldest first, ending today. */
    function rangeDays(range, now) {
        var count = NTHistory.RANGE_DAYS[range];
        if (!(count > 0)) throw new Error('unknown range: ' + range);
        var today = NTHistory.startOfDay(now), days = [];
        for (var i = count - 1; i >= 0; i--) days.push(NTHistory.addDays(today, -i));
        return days;
    }

    function compareNames(a, b) {
        var x = a.toLowerCase(), y = b.toLowerCase();
        if (x !== y) return x < y ? -1 : 1;
        return a < b ? -1 : a > b ? 1 : 0;
    }

    /** Genres by plays over the range, most first, ties by name; the top TOP_GENRES of them. */
    function rankGenres(totals) {
        return Object.keys(totals).sort(function (a, b) {
            return (totals[b] - totals[a]) || compareNames(a, b);
        }).slice(0, TOP_GENRES);
    }

    /**
     * The range's days with each genre's plays, and the genres to draw. A day before the day of
     * `since` (the first recorded play) is unknown — NepTunes was not recording — so it has no values and takes no part
     * in the ranking. A known day without rows is silent: every genre 0. A play with several genres
     * counts once under each (history.query reports it so), so a day's values can add up to more
     * than its plays: the chart shows shares over time, never a share of total plays. `other` is
     * the day's plays in every genre outside the top five, summed (so it inherits that double
     * counting); `hasOther` says whether any day has some. `total` is the top five plus `other`,
     * which is what the stack is as tall as.
     */
    function buildTimeline(days, rowsByKey, since) {
        var sinceDay = since ? NTHistory.startOfDay(since) : null;
        var totals = {};
        var out = days.map(function (day) {
            var key = NTHistory.dayKey(day);
            var known = !sinceDay || day >= sinceDay;
            var values = {};
            if (known) {
                (rowsByKey[key] || []).forEach(function (row) {
                    var genre = row && typeof row.genre === 'string' ? row.genre.trim() : '';
                    var plays = row ? Math.max(0, Number(row.plays) || 0) : 0;
                    if (!genre || !plays) return;
                    values[genre] = (values[genre] || 0) + plays;
                    totals[genre] = (totals[genre] || 0) + plays;
                });
            }
            return { date: day, key: key, known: known, values: values, total: 0 };
        });
        var genres = rankGenres(totals);
        var hasOther = false;
        out.forEach(function (d) {
            var top = 0, all = 0;
            Object.keys(d.values).forEach(function (genre) {
                all += d.values[genre];
                if (genres.indexOf(genre) >= 0) top += d.values[genre];
            });
            d.other = all - top;
            d.total = all;
            if (d.other > 0) hasOther = true;
        });
        return { days: out, genres: genres, hasOther: hasOther };
    }

    /** The slot of the "Other" band: macOS's system grey, in styles.css as --genre-other. */
    var OTHER_SLOT = 'genre-other';

    /**
     * A genre's colour slot: its rank, the same in the chart and the legend. Five genres, five
     * slots — macOS's system blue, green, indigo, pink and orange, defined per theme in
     * styles.css as --genre-0 … --genre-4.
     */
    function colorSlot(rank) { return 'genre-' + rank; }

    /**
     * The bands drawn, top of the stack first: the top genres by rank, then "Other" (in the host
     * language) when it has plays. Other goes last, at the bottom edge: the ranking reads top to
     * bottom, so the catch-all comes after the fifth genre, where the eye arrives last, and the
     * top-ranked genre keeps the top edge.
     */
    function bands(timeline, lang) {
        var words = STRINGS[lang] || STRINGS.en;
        var out = timeline.genres.map(function (genre, rank) { return { name: genreName(genre, words), slot: colorSlot(rank), other: false }; });
        if (timeline.hasOther) out.push({ name: words.other, slot: OTHER_SLOT, other: true });
        return out;
    }

    /**
     * A genre's name as the chart writes it. A real genre called what the catch-all is called —
     * "Other", or the host language's word for it, in any case — keeps its own colour, and its
     * name is quoted the host language's way (“Other”, „Inne”, « Autres »), so it never reads as
     * the grey band. Always, not only when the grey band is drawn too: the name stays the same
     * from one refresh to the next.
     */
    function genreName(genre, words) {
        var key = genre.trim().toLowerCase();
        if (key !== STRINGS.en.other.toLowerCase() && key !== words.other.toLowerCase()) return genre;
        return words.quoted.replace('{name}', genre.trim());
    }

    /** A band's plays on a day: a genre's own, or Other's sum. */
    function bandValue(timeline, day, index) {
        if (index >= timeline.genres.length) return day.other || 0;
        return day.values[timeline.genres[index]] || 0;
    }

    // ---- Stack layout -------------------------------------------------------------

    function round2(n) { return Math.round(n * 100) / 100; }

    /** The busiest known day's stack total. */
    function busiestTotal(timeline) {
        var most = 0;
        timeline.days.forEach(function (d) { if (d.known && d.total > most) most = d.total; });
        return most;
    }

    /** Room left over the busiest day when the top is not on a line: the peak never touches the edge. */
    var HEADROOM = 1.04;

    /** 1, 2, 5, 10, 20, 50, … — the first round step for which `fits(step)` holds. */
    function firstStep(fits) {
        for (var power = 1; ; power *= 10) {
            for (var k = 0; k < 3; k++) if (fits([1, 2, 5][k] * power)) return [1, 2, 5][k] * power;
        }
    }

    /**
     * The plays-per-day scale: { step, ticks, top } — labelled lines at step, 2 × step, … and the
     * chart's top in plays, which the stack and the lines are both drawn against. `maxLines` is
     * 3, or 2 where three would crowd their labels.
     *
     * The step is the smallest of 1, 2, 5, 10, 20, 50, … with at most `maxLines` whole steps under
     * the busiest day. With two or more under it, those are the lines (each at or under the
     * busiest day) and the top is the busiest day plus 4% — the edge carries no number and the
     * peak stays just clear of it: 64 → 20/40/60 under 66.56, 1500 → 500/1000/1500 under 1560,
     * 7 → 2/4/6 under 7.28. With only one under it (the busiest day just short of the next round
     * value: 80–99, 930), the top goes up to the round line above instead — the smallest step
     * that reaches the busiest day in `maxLines` lines, at least two: 99 → 50/100,
     * 930 → 500/1000, 0 or 1 → 1/2. With three lines, either way, from 2 plays up, the busiest
     * day fills at least 80% of the height. Two lines can leave it lower (down to 60%), but they
     * are only for plots too short for three labels, which no allowed widget size has. Steps are
     * whole plays: the numbers are counts.
     */
    function niceScale(busiest, maxLines) {
        var lines = maxLines === 2 ? 2 : 3;
        var target = Math.max(1, Number(busiest) || 0);
        var ticks = [], i;
        var step = firstStep(function (s) { return Math.floor(target / s) <= lines; });
        var under = Math.floor(target / step);
        if (under >= 2) {
            for (i = 1; i <= under; i++) ticks.push(step * i);
            return { step: step, ticks: ticks, top: target * HEADROOM };
        }
        step = firstStep(function (s) { return Math.ceil(target / s) <= lines; });
        var needed = Math.max(2, Math.ceil(target / step));
        for (i = 1; i <= needed; i++) ticks.push(step * i);
        return { step: step, ticks: ticks, top: ticks[ticks.length - 1] };
    }

    /** Three lines when the plot keeps their labels a line plus a pixel either side apart, else two. */
    function tickLines(plotHeight, lineHeight) {
        return plotHeight / 3 >= lineHeight + 2 ? 3 : 2;
    }

    /**
     * A tick label: the locale's number, grouped and in its own digits ("1,000", "1.000", "١٬٠٠٠"),
     * as NTHistory.formatNumber writes every count, or its short notation ("1.5K", "1,5 tys.")
     * when `compact`. A malformed locale tag (the ICU "ar_SA" form) makes Intl throw; degrade to
     * plain digits, never die.
     */
    function formatTick(n, locale, compact) {
        if (!compact) return NTHistory.formatNumber(n, locale);
        try { return new Intl.NumberFormat(locale || undefined, { notation: 'compact' }).format(n); }
        catch (e) { return String(n); }
    }

    /** The widest the tick gutter should get from full numbers: 12% of the chart's width. */
    var MAX_GUTTER_SHARE = 0.12;
    function maxGutter(chartWidth) { return round2(chartWidth * MAX_GUTTER_SHARE); }

    /**
     * Whether the tick labels switch to the compact form: only when the widest full label (as
     * WebKit measured it) is wider than maxGutter, and the widest compact one is narrower — some
     * locales' short form is no shorter ("1 tys." for "1000", German "15.000" for "15.000").
     */
    function useCompact(fullWidth, compactWidth, chartWidth) {
        return fullWidth > maxGutter(chartWidth) && compactWidth < fullWidth;
    }

    /** Space between a tick label and the plot. */
    var TICK_GAP = 4;

    /**
     * The chart area split for the scale. On top, a line for the unit caption ("Plays per day"),
     * then half a tick label's line (the top label is centred on the top line) and a pixel: the
     * plot starts below that. On the leading edge — left, or right for a right-to-left host — the
     * gutter (the widest tick label plus TICK_GAP, `gutter`) holds the labels, which end (start,
     * right to left) TICK_GAP from the plot: `labelEdge`, with `align` the text alignment. The
     * plot is the rest, so the bands and their names never reach into the gutter.
     */
    function axisLayout(chart, gutter, lineHeight, rtl) {
        var top = lineHeight + Math.ceil(lineHeight / 2) + 1;
        var plot = {
            x: rtl ? chart.x : chart.x + gutter, y: chart.y + top,
            w: Math.max(0, chart.w - gutter), h: Math.max(0, chart.h - top)
        };
        return {
            plot: plot,
            caption: { x: rtl ? chart.x + chart.w : chart.x, y: chart.y, align: rtl ? 'right' : 'left' },
            labelEdge: rtl ? plot.x + plot.w + TICK_GAP : plot.x - TICK_GAP,
            align: rtl ? 'left' : 'right'
        };
    }

    /** Each line of `scale` at its height in `plot`: { value, y }, the scale's top at the plot's top. */
    function tickPositions(scale, plot) {
        return scale.ticks.map(function (value) {
            return { value: value, y: round2(plot.y + plot.h - value * plot.h / scale.top) };
        });
    }

    /**
     * Each genre's band as points { day, x, top, bottom } in page px, over the known days only.
     * On each day the drawn genres sum to `total`; the stack stands on the chart's bottom edge,
     * total × scale tall, the top-ranked genre at the top and Other at the bottom. The chart's
     * top is `top` plays — niceScale's top for the busiest day when not given — the same top the
     * lines are drawn against, so the bands read against them. Days run left to right (right to left for a
     * right-to-left host). A lone known day — history began today — gets a second point half a
     * day back, so its band has width.
     */
    function stackLayout(timeline, chart, rtl, top) {
        var days = timeline.days, n = days.length;
        var step = n > 1 ? chart.w / (n - 1) : 0;
        var bottom = chart.y + chart.h;
        if (!(top > 0)) top = niceScale(busiestTotal(timeline)).top;
        var scale = chart.h / top;
        var xs = days.map(function (_, i) { return round2(rtl ? chart.x + chart.w - i * step : chart.x + i * step); });
        var known = [];
        days.forEach(function (d, i) { if (d.known) known.push(i); });
        var count = timeline.genres.length + (timeline.hasOther ? 1 : 0);
        var layers = [];
        for (var b = 0; b < count; b++) layers.push([]);
        known.forEach(function (i) {
            var y = bottom - days[i].total * scale;
            layers.forEach(function (layer, g) {
                var height = bandValue(timeline, days[i], g) * scale;
                layer.push({ day: i, x: xs[i], top: round2(y), bottom: round2(y + height) });
                y += height;
            });
        });
        if (known.length === 1 && n > 1) {
            layers.forEach(function (layer) {
                var p = layer[0];
                layer.unshift({ day: p.day, x: round2(p.x + (rtl ? step / 2 : -step / 2)), top: p.top, bottom: p.bottom });
            });
        }
        var noData = null;
        if (known.length === 0) noData = { x: chart.x, w: chart.w };
        else if (known[0] > 0) {
            var edge = xs[known[0]], start = xs[0];
            noData = { x: Math.min(edge, start), w: round2(Math.abs(edge - start)) };
        }
        return { layers: layers, xs: xs, step: step, bottom: bottom, top: top, scale: scale, noData: noData };
    }

    /** A band as an SVG path: along its top edge, back along its bottom edge. Linear on purpose. */
    function layerPath(points) {
        if (!points.length) return '';
        var top = points.map(function (p) { return p.x + ',' + p.top; });
        var bottom = points.slice().reverse().map(function (p) { return p.x + ',' + p.bottom; });
        return 'M' + top.join('L') + 'L' + bottom.join('L') + 'Z';
    }

    /**
     * The day and genre under a page point: the nearest day by x (each gap split between two days)
     * and the band that day's column puts under y, or genre -1 between and around bands. Null off
     * the chart.
     */
    function hitTest(stack, chart, x, y) {
        if (!isFinite(x) || !isFinite(y) || !stack.xs.length) return null;
        var half = stack.step / 2;
        if (x < chart.x - half || x > chart.x + chart.w + half || y < chart.y || y > chart.y + chart.h) return null;
        var day = 0;
        for (var i = 1; i < stack.xs.length; i++) {
            if (Math.abs(stack.xs[i] - x) < Math.abs(stack.xs[day] - x)) day = i;
        }
        var genre = -1;
        stack.layers.forEach(function (layer, g) {
            layer.forEach(function (p) {
                if (p.day === day && p.bottom > p.top && y >= p.top && y < p.bottom) genre = g;
            });
        });
        return { day: day, genre: genre };
    }

    // ---- Labels on the bands -------------------------------------------------

    /** A band's top and bottom edge at x, between its points (sorted by x), or null off its ends. */
    function edgesAt(points, x) {
        var n = points.length;
        if (!n || x < points[0].x - 1e-9 || x > points[n - 1].x + 1e-9) return null;
        for (var i = 1; i < n; i++) {
            var a = points[i - 1], b = points[i];
            if (x <= b.x + 1e-9) {
                var t = b.x === a.x ? 0 : Math.min(1, Math.max(0, (x - a.x) / (b.x - a.x)));
                return { top: a.top + (b.top - a.top) * t, bottom: a.bottom + (b.bottom - a.bottom) * t };
            }
        }
        return { top: points[n - 1].top, bottom: points[n - 1].bottom };
    }

    /**
     * The room a band leaves over [a, b]: the lowest bottom edge less the highest top edge there
     * (both edges are straight between points, so the extremes lie at a, b or a point between),
     * with the middle of that room. Null when [a, b] runs past the band's ends.
     */
    function roomOver(points, a, b) {
        var ea = edgesAt(points, a), eb = edgesAt(points, b);
        if (!ea || !eb) return null;
        var maxTop = Math.max(ea.top, eb.top), minBottom = Math.min(ea.bottom, eb.bottom);
        points.forEach(function (p) {
            if (p.x > a && p.x < b) { maxTop = Math.max(maxTop, p.top); minBottom = Math.min(minBottom, p.bottom); }
        });
        return { room: minBottom - maxTop, middle: (maxTop + minBottom) / 2 };
    }

    /**
     * The best centre for a label `width` wide in the band (points sorted by x): every centre
     * whose box — the label plus padX either side, its line plus padY above and below — fits
     * between the band's edges all the way across, scored by the room left. The most room wins;
     * among equals, the one nearest the middle of them, then the earliest. Null when none fits.
     */
    function bestSpot(points, width, opts) {
        var half = width / 2 + opts.padX;
        var lo = points[0].x + half, hi = points[points.length - 1].x - half;
        if (lo > hi + 1e-9) return null;
        if (hi < lo) hi = lo;
        var need = opts.height + 2 * opts.padY;
        var candidates = [], steps = Math.max(1, Math.ceil(hi - lo));
        for (var i = 0; i <= steps; i++) candidates.push(lo + (hi - lo) * i / steps);
        points.forEach(function (p) { if (p.x > lo && p.x < hi) candidates.push(p.x); });
        candidates.sort(function (a, b) { return a - b; });
        var fits = [];
        candidates.forEach(function (x) {
            var r = roomOver(points, x - half, x + half);
            if (r && r.room >= need - 1e-9) fits.push({ x: x, room: r.room, middle: r.middle });
        });
        if (!fits.length) return null;
        var most = Math.max.apply(null, fits.map(function (f) { return f.room; }));
        var best = fits.filter(function (f) { return f.room >= most - 1e-6; });
        var centre = (best[0].x + best[best.length - 1].x) / 2;
        return best.reduce(function (pick, f) { return Math.abs(f.x - centre) < Math.abs(pick.x - centre) - 1e-9 ? f : pick; });
    }

    /**
     * Where a band's name goes, written inside the band: { x, y } its centre in page px, `width`
     * the width it gets, and `truncated` when that is less than the text's own (the page cuts it
     * with an ellipsis). `opts`: width (the text's), minWidth (the narrowest cut worth drawing),
     * height (its line), padX / padY (clear space around it), rtl. The label must fit at its own
     * width; failing that, the widest cut from minWidth up that fits. Null when none does — the
     * legend names that band instead. Right to left the band is read from the right, so the same
     * choice comes out mirrored.
     */
    function placeLabel(points, opts) {
        var flip = opts.rtl ? -1 : 1;
        var sorted = (points || []).map(function (p) { return { x: flip * p.x, top: p.top, bottom: p.bottom }; })
            .sort(function (a, b) { return a.x - b.x; });
        if (sorted.length < 2) return null;
        var width = opts.width, spot = bestSpot(sorted, width, opts);
        if (!spot) {
            var lo = Math.ceil(Math.min(opts.minWidth, opts.width)), hi = Math.floor(opts.width);
            if (!bestSpot(sorted, lo, opts)) return null;
            while (lo < hi) {
                var mid = Math.ceil((lo + hi) / 2);
                if (bestSpot(sorted, mid, opts)) lo = mid; else hi = mid - 1;
            }
            width = lo;
            spot = bestSpot(sorted, width, opts);
        }
        var x = flip * spot.x;
        // Rounded away from zero symmetrically, so a mirrored x rounds the same as the original,
        // and `+ 0` turns a -0 (a centre on 0 flipped back) into 0, which deepEqual tells apart.
        return { x: (x < 0 ? -round2(-x) : round2(x)) + 0, y: round2(spot.middle), width: round2(width), truncated: width < opts.width };
    }

    function linear(c) {
        var v = c / 255;
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }

    function luminance(rgb) { return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]); }

    /** WCAG's contrast ratio between two sRGB colours, [r, g, b] 0–255. */
    function contrastRatio(a, b) {
        var la = luminance(a), lb = luminance(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    }

    /** The label inks: white, and the near-black of macOS's label text (styles.css). */
    var INK = { light: [255, 255, 255], dark: [29, 29, 31] };

    /** 'light' (white) or 'dark' (near-black): whichever contrasts more with the band colour. */
    function labelInk(rgb) {
        if (!rgb) return 'dark';
        return contrastRatio(rgb, INK.light) > contrastRatio(rgb, INK.dark) ? 'light' : 'dark';
    }

    /** "rgb(r, g, b)" / "rgba(…)" as WebKit computes a colour, as [r, g, b]; null otherwise. */
    function parseRgb(text) {
        var m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(String(text || ''));
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    }

    /** The bands the legend names: the ones that got no label on the chart. */
    function legendBands(placements) {
        var out = [];
        placements.forEach(function (p, i) { if (!p) out.push(i); });
        return out;
    }

    // ---- Loading ------------------------------------------------------------

    var MAX_CONCURRENT_DAYS = 2;

    function dayQuery(day) {
        return { from: day.toISOString(), to: NTHistory.addDays(day, 1).toISOString(), groupBy: 'genre', limit: 1000 };
    }

    /** What a load rejects with once a newer one has replaced it. Nothing shows it. */
    function supersededError() {
        var error = new Error('superseded');
        error.code = 'superseded';
        return error;
    }

    /**
     * Runs `task(item)` over `items` with at most `limit` in flight. The first failure fails the
     * run, and no further task starts after it. Activity's runBounded.
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

    /**
     * The finished days' rows, for the zone their day keys were cut in and the day they were
     * asked on. A finished day can still change after it was asked for — the host fills in a
     * track's genre late, and writes a play when it ends, so a track started at 23:55 can land
     * after midnight — so the memory lasts one day: the first load of a new day (the midnight
     * reload) asks for the whole range again, and the refreshes after it ask for today alone.
     */
    function freshMemo(now) { return { timeZone: NTHistory.timeZoneKey(now), day: NTHistory.dayKey(now), rows: {} }; }

    /** `memo` while it belongs to this zone and this day, a fresh one otherwise. */
    function memoFor(memo, now) {
        var usable = memo && memo.rows && memo.timeZone === NTHistory.timeZoneKey(now) && memo.day === NTHistory.dayKey(now);
        return usable ? memo : freshMemo(now);
    }

    /**
     * Each day's genre rows, by day key. A finished day comes from `memo` when it is there; every
     * other day is asked for, at most `maxConcurrent` at once; today is always asked again, it is
     * still filling up. Days before `sinceDay` are not asked for at all. Each finished day goes
     * into `memo` as it lands, so a load that fails part-way keeps what it got. A superseded load
     * asks for nothing more.
     */
    function loadDays(opts) {
        var memo = opts.memo, todayKey = NTHistory.dayKey(opts.now);
        var isCurrent = opts.isCurrent || function () { return true; };
        var rowsByKey = {}, toAsk = [];
        opts.days.forEach(function (day) {
            var key = NTHistory.dayKey(day);
            if (opts.sinceDay && day < opts.sinceDay) return;
            if (key !== todayKey && Object.prototype.hasOwnProperty.call(memo.rows, key)) rowsByKey[key] = memo.rows[key];
            else toAsk.push(day);
        });
        return runBounded(toAsk, opts.maxConcurrent || MAX_CONCURRENT_DAYS, function (day) {
            if (!isCurrent()) return Promise.reject(supersededError());
            return Promise.resolve(opts.history.query(dayQuery(day))).then(function (result) {
                var key = NTHistory.dayKey(day), rows = (result && result.rows) || [];
                rowsByKey[key] = rows;
                if (key !== todayKey) memo.rows[key] = rows;
            });
        }).then(function () { return rowsByKey; });
    }

    /**
     * One load. Resolves to { kind: 'chart', timeline, since }, or a state: 'notRecording',
     * 'noPlays' (nothing played in the range), 'noGenres' (plays, none with a genre) or 'tooOld'
     * (an app without the history API). History errors reject, untouched. `opts.memo` is used and
     * filled in place: pass memoFor()'s result.
     */
    function loadTrends(opts) {
        var nt = opts.nt || {};
        if (!NTHistory.hasHistory(nt)) return Promise.resolve({ kind: 'tooOld' });
        return Promise.resolve(nt.history.info()).then(function (info) {
            var since = NTHistory.parseSince(info);
            if (!since) return { kind: 'notRecording' };
            var days = rangeDays(opts.range, opts.now);
            var sinceDay = NTHistory.startOfDay(since);
            return loadDays({
                history: nt.history, days: days, sinceDay: sinceDay, now: opts.now, memo: opts.memo,
                isCurrent: opts.isCurrent, maxConcurrent: opts.maxConcurrent
            }).then(function (rowsByKey) {
                var timeline = buildTimeline(days, rowsByKey, sinceDay);
                if (timeline.genres.length) return { kind: 'chart', timeline: timeline, since: since };
                // No genre anywhere: was nothing played, or nothing played had a genre?
                var today = NTHistory.startOfDay(opts.now);
                var from = days[0] < sinceDay ? sinceDay : days[0];
                if (from > today) from = today;
                return Promise.resolve(nt.history.query({
                    from: from.toISOString(), to: NTHistory.addDays(today, 1).toISOString(), groupBy: 'none'
                })).then(function (result) {
                    var row = result && result.rows && result.rows[0];
                    return { kind: row && Number(row.plays) > 0 ? 'noGenres' : 'noPlays' };
                });
            });
        });
    }

    /**
     * The page's load: loadTrends over a memory of finished days that it keeps between loads
     * (memoFor). `host()` is the NepTunes object.
     */
    function trendsLoader(host) {
        var memo = null;
        return function (range, now, isCurrent) {
            memo = memoFor(memo, now);
            return loadTrends({ nt: host(), now: now, range: range, memo: memo, isCurrent: isCurrent });
        };
    }

    // ---- Strings --------------------------------------------------------------
    // The chart's own words; everything both stats widgets say is NTHistory's.

    var STRINGS = {
        ar: { loading: 'جارٍ تحميل اتجاهات الأنواع', noGenres: 'لا تتوفر معلومات عن الأنواع لهذه الأيام', summary: 'أبرز الأنواع: {list}', other: 'أخرى', perDay: 'مرات التشغيل في اليوم', quoted: '«{name}»' },
        ca: { loading: 'Carregant les teves tendències de gèneres', noGenres: 'No hi ha informació de gènere per a aquests dies', summary: 'Gèneres principals: {list}', other: 'Altres', perDay: 'Reproduccions per dia', quoted: '«{name}»' },
        de: { loading: 'Deine Genre-Trends werden geladen', noGenres: 'Keine Genre-Angaben für diese Tage', summary: 'Top-Genres: {list}', other: 'Andere', perDay: 'Wiedergaben pro Tag', quoted: '„{name}“' },
        en: { loading: 'Loading your genre trends', noGenres: 'No genre information for these days', summary: 'Top genres: {list}', other: 'Other', perDay: 'Plays per day', quoted: '“{name}”' },
        es: { loading: 'Cargando tus tendencias de géneros', noGenres: 'No hay información de género para estos días', summary: 'Géneros principales: {list}', other: 'Otros', perDay: 'Reproducciones por día', quoted: '«{name}»' },
        fr: { loading: 'Chargement de vos tendances de genres', noGenres: 'Aucune information de genre pour ces jours', summary: 'Genres principaux : {list}', other: 'Autres', perDay: 'Écoutes par jour', quoted: '«\u00a0{name}\u00a0»' },
        it: { loading: 'Caricamento delle tendenze dei generi', noGenres: 'Nessuna informazione sul genere per questi giorni', summary: 'Generi principali: {list}', other: 'Altri', perDay: 'Ascolti al giorno', quoted: '«{name}»' },
        ja: { loading: 'ジャンルの傾向を読み込み中', noGenres: 'この期間のジャンル情報はありません', summary: 'トップジャンル: {list}', other: 'その他', perDay: '1日あたりの再生回数', quoted: '「{name}」' },
        nl: { loading: 'Je genretrends worden geladen', noGenres: 'Geen genre-informatie voor deze dagen', summary: 'Topgenres: {list}', other: 'Overig', perDay: 'Afspeelbeurten per dag', quoted: '‘{name}’' },
        pl: { loading: 'Wczytywanie trendów gatunków', noGenres: 'Brak informacji o gatunkach dla tych dni', summary: 'Najpopularniejsze gatunki: {list}', other: 'Inne', perDay: 'Odtworzenia dziennie', quoted: '„{name}”' },
        'pt-BR': { loading: 'Carregando suas tendências de gêneros', noGenres: 'Sem informações de gênero para estes dias', summary: 'Principais gêneros: {list}', other: 'Outros', perDay: 'Reproduções por dia', quoted: '“{name}”' },
        ru: { loading: 'Загрузка жанровых трендов', noGenres: 'Нет сведений о жанрах за эти дни', summary: 'Главные жанры: {list}', other: 'Другие', perDay: 'Прослушиваний в день', quoted: '«{name}»' },
        uk: { loading: 'Завантаження жанрових трендів', noGenres: 'Немає відомостей про жанри за ці дні', summary: 'Головні жанри: {list}', other: 'Інші', perDay: 'Прослуховувань на день', quoted: '«{name}»' },
        'zh-Hans': { loading: '正在加载流派趋势', noGenres: '这些天没有流派信息', summary: '热门流派：{list}', other: '其他', perDay: '每日播放次数', quoted: '“{name}”' }
    };

    /** The status line for a settled load with nothing to draw, or null for the chart. */
    function statusText(result, range, lang) {
        if (result && result.kind === 'noGenres') return (STRINGS[lang] || STRINGS.en).noGenres;
        return NTHistory.statusText(result, range, lang);
    }

    function listText(items, locale) {
        try { return new Intl.ListFormat(locale || undefined, { type: 'conjunction' }).format(items); }
        catch (e) { return items.join(', '); }
    }

    function summaryText(genres, lang, locale) {
        return (STRINGS[lang] || STRINGS.en).summary.replace('{list}', listText(genres, locale));
    }

    // ---- Geometry & settings ----------------------------------------------------

    var CARD_GUTTER = { left: 20, top: 16, right: 20, bottom: 24 };   // shadow extent + 8 (styles.css)
    var BARE_GUTTER = { left: 6, top: 6, right: 6, bottom: 6 };
    var CALLOUT_GAP = 8;

    function clamp(value, lo, hi) { return Math.min(hi, Math.max(lo, value)); }

    /**
     * The card fills the window inside the gutter; the chart fills the card above the footer (the
     * date axis and the legend), whose height the page measures in WebKit and passes in.
     */
    function layout(width, height, background, footerHeight) {
        var bare = background === 'none';
        var g = bare ? BARE_GUTTER : CARD_GUTTER;
        var card = { x: g.left, y: g.top, w: Math.max(0, width - g.left - g.right), h: Math.max(0, height - g.top - g.bottom) };
        var shorter = Math.min(card.w, card.h);
        var pad = bare ? 0 : clamp(Math.round(shorter * 0.07), 8, 16);
        var footerGap = 6;
        return {
            card: card,
            pad: pad,
            chart: {
                x: card.x + pad, y: card.y + pad,
                w: Math.max(0, card.w - 2 * pad),
                h: Math.max(0, card.h - 2 * pad - footerHeight - footerGap)
            },
            footer: { x: card.x + pad, y: card.y + card.h - pad - footerHeight, w: Math.max(0, card.w - 2 * pad), h: footerHeight },
            panelRadius: clamp(Math.round(shorter * 0.11), 10, 22),
            statusSize: clamp(Math.round(shorter / 12), 10, 14),
            textSize: clamp(Math.round(shorter * 0.06), 9, 12)
        };
    }

    /** Centred above the point, below it when there is no room above, clamped to `bounds`. */
    function calloutOrigin(point, size, bounds) {
        var x = point.x - size.w / 2;
        var above = point.y - CALLOUT_GAP - size.h >= bounds.y;
        var y = above ? point.y - CALLOUT_GAP - size.h : point.y + CALLOUT_GAP;
        x = Math.min(Math.max(x, bounds.x), Math.max(bounds.x + bounds.w - size.w, bounds.x));
        y = Math.min(Math.max(y, bounds.y), Math.max(bounds.y + bounds.h - size.h, bounds.y));
        return { x: x, y: y, above: above };
    }

    var DEFAULT_SETTINGS = { range: '7d', theme: 'auto', background: 'card' };
    var SETTING_VALUES = {
        range: ['7d', '30d'],
        theme: ['auto', 'dark', 'light'],
        background: ['card', 'none']
    };

    function normalizeSettings(raw) { return NTHistory.normalizeSettings(raw, DEFAULT_SETTINGS, SETTING_VALUES); }

    // ---- Page (browser only) ------------------------------------------------

    var REFRESH_MS = 10 * 60 * 1000;
    var RETRY_MS = 60 * 1000;
    var SETTINGS_RELOAD_MS = 400;

    var root = null, card = null, panelShadow = null, chartEl = null, layersEl = null, noDataEl = null;
    var guideEl = null, gridEl = null, ticksEl = null, labelsEl = null, footerEl = null, axisStart = null, axisEnd = null, legendEl = null;
    var statusEl = null, calloutEl = null, calloutTitle = null, calloutCount = null, calloutDate = null;
    var resizeHandle = null;
    var settings = normalizeSettings(null);
    var settingsArrived = false;
    var state = null;
    var lang = 'en', locale = null, rtl = false;
    // NTHistory.loadController: owns phase, result (what loadTrends() last settled on) and
    // resultRange, and the load / retry / refresh policy. Made in init().
    var loader = null;
    var currentLayout = null, currentStack = null;
    var currentPlot = null;        // axisLayout().plot: the chart area less the caption line and the tick gutter
    var currentBands = [];         // bands(): the drawn bands, top of the stack first
    var currentPlacements = [];    // placeLabel() per band, null for a band without a label
    var highlighted = -1;          // the band hovered in the chart or the legend (its index)
    var SVG_NS = 'http://www.w3.org/2000/svg';

    function applyAppearance() {
        root.classList.remove('theme-auto', 'theme-dark', 'theme-light');
        root.classList.add('theme-' + settings.theme);
        root.classList.toggle('bare', settings.background === 'none');
        inkLabels();
    }

    /** The palette is CSS and follows a theme flip by itself; the labels' ink is picked here. */
    function onThemeChange() { inkLabels(); }

    function timeline() {
        var result = loader.result;
        return loader.phase === 'ready' && result && result.kind === 'chart' ? result.timeline : null;
    }

    /** The legend: one item per band in `indices` (the bands without a label); hidden when none. */
    function renderLegend(indices) {
        legendEl.textContent = '';
        indices.forEach(function (index) {
            var band = currentBands[index];
            var item = document.createElement('span');
            item.className = 'legend-item ' + band.slot;
            item.dataset.rank = String(index);
            var swatch = document.createElement('i');
            swatch.className = 'swatch';
            var name = document.createElement('span');
            name.className = 'legend-name';
            name.dir = 'auto';
            name.textContent = band.name;
            item.appendChild(swatch);
            item.appendChild(name);
            legendEl.appendChild(item);
        });
        legendEl.hidden = !indices.length;
    }

    function sameList(a, b) { return a.length === b.length && a.every(function (v, i) { return v === b[i]; }); }

    /**
     * Lays the chart out and names its bands. First with no legend, so the chart has all the
     * room; the bands still without a label go into the legend, which takes a line from the
     * chart, and the smaller chart is labelled again — any band that lost its label there joins
     * the legend, which is one line whatever it holds, so the layout stands.
     *
     * Why two passes always settle: the footer's height depends only on whether the legend is
     * shown, never on what it holds (it is clipped to one line). So the chart's size changes at
     * most once (no legend → legend), and the labelling of that smaller chart is final: its
     * unlabelled bands are written into the legend without moving the chart again. Rebuilt legend
     * items are new elements, so the hover highlight is applied again at the end.
     */
    function applyLayout() {
        var t = timeline();
        currentBands = t ? bands(t, lang) : [];
        var shown = [];
        renderLegend(shown);
        layoutPass();
        for (var pass = 0; pass < 2; pass++) {
            var missing = legendBands(currentPlacements);
            if (sameList(missing, shown)) break;
            var resize = !shown.length !== !missing.length;
            shown = missing;
            renderLegend(shown);
            if (resize) layoutPass();
        }
        applyHighlight();
    }

    /** Lays the card out around the footer as WebKit measured it, then draws the bands. */
    function layoutPass() {
        var footerHeight = footerEl.hidden ? 0 : Math.ceil(footerEl.getBoundingClientRect().height);
        var l = currentLayout = layout(window.innerWidth, window.innerHeight, settings.background, footerHeight);
        [card, panelShadow].forEach(function (el) {
            el.style.left = l.card.x + 'px';
            el.style.top = l.card.y + 'px';
            el.style.width = l.card.w + 'px';
            el.style.height = l.card.h + 'px';
        });
        root.style.setProperty('--panel-radius', l.panelRadius + 'px');
        root.style.setProperty('--status-size', l.statusSize + 'px');
        root.style.setProperty('--text-size', l.textSize + 'px');
        footerEl.style.left = (l.footer.x - l.card.x) + 'px';
        footerEl.style.width = l.footer.w + 'px';
        footerEl.style.bottom = l.pad + 'px';
        // The chart SVG covers the card, so its coordinates are page px minus the card's origin.
        chartEl.setAttribute('width', String(l.card.w));
        chartEl.setAttribute('height', String(l.card.h));
        chartEl.setAttribute('viewBox', l.card.x + ' ' + l.card.y + ' ' + l.card.w + ' ' + l.card.h);
        drawBands();
    }

    /**
     * The plays-per-day scale for the chart area: the unit caption, the tick labels in the
     * leading gutter and the gridlines across the plot. Sets currentPlot and returns the scale.
     * The line count comes from the plot's height (which the gutter does not change); the gutter
     * from the widest label as WebKit measures it — the full numbers, or their compact form when
     * the full ones would take more than maxGutter and the compact ones are narrower.
     */
    function drawScale(t, l) {
        var size = l.textSize, lineHeight = Math.round(size * 1.2);
        var scale = niceScale(busiestTotal(t), tickLines(axisLayout(l.chart, 0, lineHeight, rtl).plot.h, lineHeight));
        ticksEl.style.fontSize = size + 'px';
        ticksEl.style.lineHeight = lineHeight + 'px';
        var caption = document.createElement('div');
        caption.className = 'tick-unit';
        caption.textContent = (STRINGS[lang] || STRINGS.en).perDay;
        ticksEl.appendChild(caption);
        var labels = scale.ticks.map(function (value) {
            var el = document.createElement('div');
            el.className = 'tick-label';
            el.textContent = formatTick(value, locale, false);
            ticksEl.appendChild(el);
            return el;
        });
        function widest() { return Math.max.apply(null, labels.map(function (el) { return el.getBoundingClientRect().width; })); }
        var full = widest();
        var fullTexts = labels.map(function (el) { return el.textContent; });
        labels.forEach(function (el, i) { el.textContent = formatTick(scale.ticks[i], locale, true); });
        var compact = widest();
        var isCompact = useCompact(full, compact, l.chart.w);
        if (!isCompact) labels.forEach(function (el, i) { el.textContent = fullTexts[i]; });
        ticksEl.dataset.notation = isCompact ? 'compact' : 'full';
        var axis = axisLayout(l.chart, Math.ceil(isCompact ? compact : full) + TICK_GAP, lineHeight, rtl);
        var plot = currentPlot = axis.plot;
        tickPositions(scale, plot).forEach(function (tick, i) {
            var el = labels[i], w = el.getBoundingClientRect().width;
            el.style.left = ((axis.align === 'right' ? axis.labelEdge - w : axis.labelEdge) - l.card.x) + 'px';
            el.style.top = (tick.y - lineHeight / 2 - l.card.y) + 'px';
            el.dataset.value = String(tick.value);
            gridLine(plot, tick.y, 'grid-line');
        });
        gridLine(plot, plot.y + plot.h, 'grid-line baseline');
        caption.style.maxWidth = l.chart.w + 'px';
        var cw = caption.getBoundingClientRect().width;
        caption.style.left = ((axis.caption.align === 'right' ? axis.caption.x - cw : axis.caption.x) - l.card.x) + 'px';
        caption.style.top = (axis.caption.y - l.card.y) + 'px';
        return scale;
    }

    function gridLine(plot, y, className) {
        var line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('class', className);
        line.setAttribute('x1', String(plot.x));
        line.setAttribute('x2', String(plot.x + plot.w));
        line.setAttribute('y1', String(y));
        line.setAttribute('y2', String(y));
        gridEl.appendChild(line);
    }

    function drawBands() {
        var t = timeline(), l = currentLayout;
        layersEl.textContent = '';
        labelsEl.textContent = '';
        gridEl.textContent = '';
        ticksEl.textContent = '';
        currentPlacements = [];
        currentPlot = l.chart;
        var scale = t ? drawScale(t, l) : null;
        currentStack = t ? stackLayout(t, currentPlot, rtl, scale.top) : null;
        if (!currentStack) { noDataEl.setAttribute('width', '0'); return; }
        currentStack.layers.forEach(function (points, index) {
            var path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('class', 'band ' + currentBands[index].slot);
            path.setAttribute('data-rank', String(index));
            path.setAttribute('d', layerPath(points));
            layersEl.appendChild(path);
        });
        drawLabels(l);
        var nd = currentStack.noData;
        noDataEl.setAttribute('x', String(nd ? nd.x : 0));
        noDataEl.setAttribute('y', String(currentPlot.y));
        noDataEl.setAttribute('width', String(nd ? nd.w : 0));
        noDataEl.setAttribute('height', String(currentPlot.h));
        applyHighlight();
    }

    /**
     * Writes each band's name inside it where placeLabel finds room — the text's own width, or a
     * cut of at least about three letters, which CSS ends with an ellipsis. The labels' size is
     * the footer's, so they scale with the widget; their line plus a pixel above and below must
     * fit in the band. A label never crosses its band's edges, and the bands never overlap, so
     * neither do the labels, and none reaches the footer.
     */
    function drawLabels(l) {
        var size = l.textSize, lineHeight = Math.round(size * 1.2);
        currentPlacements = currentStack.layers.map(function (points, index) {
            var el = document.createElement('div');
            el.className = 'band-label';
            el.dataset.rank = String(index);
            el.dir = 'auto';
            el.textContent = currentBands[index].name;
            el.style.fontSize = size + 'px';
            el.style.lineHeight = lineHeight + 'px';
            labelsEl.appendChild(el);
            var natural = Math.ceil(el.getBoundingClientRect().width);
            var placement = placeLabel(points, {
                width: natural, minWidth: Math.min(natural, Math.ceil(size * 3)),
                height: lineHeight, padX: 3, padY: 1, rtl: rtl
            });
            if (!placement) { labelsEl.removeChild(el); return null; }
            el.style.width = placement.width + 'px';
            el.style.left = (placement.x - placement.width / 2 - l.card.x) + 'px';
            el.style.top = (placement.y - lineHeight / 2 - l.card.y) + 'px';
            return placement;
        });
        inkLabels();
    }

    /** Each label's ink, from its band's colour as the current theme paints it. */
    function inkLabels() {
        if (!labelsEl) return;
        Array.prototype.forEach.call(labelsEl.childNodes, function (el) {
            var path = layersEl.querySelector('[data-rank="' + el.dataset.rank + '"]');
            var ink = labelInk(path ? parseRgb(getComputedStyle(path).fill) : null);
            el.classList.toggle('ink-light', ink === 'light');
            el.classList.toggle('ink-dark', ink === 'dark');
        });
    }

    function applyHighlight() {
        Array.prototype.forEach.call(layersEl.childNodes, function (path) {
            var rank = Number(path.getAttribute('data-rank'));
            path.classList.toggle('dimmed', highlighted >= 0 && rank !== highlighted);
            path.classList.toggle('highlighted', rank === highlighted);
        });
        Array.prototype.forEach.call(labelsEl.childNodes, function (el) {
            el.classList.toggle('dimmed', highlighted >= 0 && Number(el.dataset.rank) !== highlighted);
        });
        Array.prototype.forEach.call(legendEl.childNodes, function (item) {
            item.classList.toggle('dimmed', highlighted >= 0 && Number(item.dataset.rank) !== highlighted);
        });
    }

    function render() {
        var status = loader.phase === 'ready' ? statusText(loader.result, loader.resultRange, lang) : null;
        var t = timeline();
        card.dataset.phase = loader.phase;
        card.dataset.kind = loader.result ? loader.result.kind : '';
        chartEl.style.visibility = status ? 'hidden' : 'visible';
        footerEl.hidden = !t;
        statusEl.hidden = !status;
        if (status) statusEl.textContent = status;
        if (t) {
            axisStart.textContent = NTHistory.formatDay(t.days[0].date, locale);
            axisEnd.textContent = NTHistory.formatDay(t.days[t.days.length - 1].date, locale);
        }
        chartEl.setAttribute('aria-label', t ? summaryText(t.genres, lang, locale) : (STRINGS[lang] || STRINGS.en).loading);
        clearHover();
        applyLayout();
    }

    /**
     * Drops the hover: the callout, the guide and the highlight. On every render — new data can
     * reorder the genres, so a kept rank could light up a different genre, and the bands move
     * under a still pointer either way; always clearing is simpler than comparing rankings and
     * never shows a stale highlight — and on a resize, which moves every band. The host's next
     * pointermove puts it back.
     */
    function clearHover() {
        hideCallout();
        highlighted = -1;
    }

    function onResize() {
        clearHover();
        applyLayout();
    }

    function showCallout(hit, point) {
        var t = timeline();
        var day = t.days[hit.day];
        calloutTitle.textContent = day.known ? currentBands[hit.genre].name : '';
        calloutTitle.hidden = !day.known;
        calloutCount.textContent = day.known ? NTHistory.playsText(bandValue(t, day, hit.genre), lang, locale) : NTHistory.strings(lang).noData;
        calloutDate.textContent = NTHistory.formatDay(day.date, locale);
        calloutEl.hidden = false;
        var origin = calloutOrigin(point, { w: calloutEl.offsetWidth, h: calloutEl.offsetHeight },
            { x: 2, y: 2, w: window.innerWidth - 4, h: window.innerHeight - 4 });
        calloutEl.style.left = (origin.x - currentLayout.card.x) + 'px';
        calloutEl.style.top = (origin.y - currentLayout.card.y) + 'px';
        guideEl.setAttribute('x1', String(currentStack.xs[hit.day]));
        guideEl.setAttribute('x2', String(currentStack.xs[hit.day]));
        guideEl.setAttribute('y1', String(currentPlot.y));
        guideEl.setAttribute('y2', String(currentPlot.y + currentPlot.h));
        guideEl.style.visibility = 'visible';
    }

    function hideCallout() {
        if (calloutEl) calloutEl.hidden = true;
        if (guideEl) guideEl.style.visibility = 'hidden';
    }

    /** The band of the legend item under a page point, -1 for none; items the line clips off don't count. */
    function legendRankAt(x, y) {
        var rank = -1;
        if (legendEl.hidden) return rank;
        var box = legendEl.getBoundingClientRect();
        Array.prototype.forEach.call(legendEl.childNodes, function (item) {
            var r = item.getBoundingClientRect();
            if (r.bottom > box.bottom + 0.5 || r.right > box.right + 0.5 || r.left < box.left - 0.5) return;
            if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) rank = Number(item.dataset.rank);
        });
        return rank;
    }

    function onPointerMove(point) {
        if (!point || !currentStack) return;
        var x = Number(point.x), y = Number(point.y);
        var hit = hitTest(currentStack, currentPlot, x, y);
        var next = -1;
        if (hit && (hit.genre >= 0 || !timeline().days[hit.day].known)) {
            next = hit.genre;
            showCallout(hit, { x: x, y: y });
        } else {
            hideCallout();
            next = legendRankAt(x, y);
        }
        if (next !== highlighted) { highlighted = next; applyHighlight(); }
    }

    function onPointerLeave() {
        hideCallout();
        if (highlighted !== -1) { highlighted = -1; applyHighlight(); }
    }

    function onSettings(next) {
        if (!next) return;
        var previous = settingsArrived ? settings : null;
        settings = normalizeSettings(next);
        settingsArrived = true;
        applyAppearance();
        loader.settingsChanged(!previous, !!previous && previous.range !== settings.range);
    }

    function onState(next) {
        if (!next) return;
        // Mirror for a right-to-left host: the days run from the right, the legend from the right.
        if (next.layoutDirection) document.documentElement.dir = next.layoutDirection;
        var first = state === null;
        state = next;
        var nextLang = NTHistory.pickLanguage(next.language);
        var nextLocale = next.locale || null;
        var nextRtl = next.layoutDirection === 'rtl';
        var changed = nextLang !== lang || nextLocale !== locale || nextRtl !== rtl;
        lang = nextLang;
        locale = nextLocale;
        rtl = nextRtl;
        loader.stateChanged(first, changed);
    }

    // Free resize: the chart is wide by nature, so width and height move independently.
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
            post({ type: 'resizeMove', deltaX: e.screenX - lastX, deltaY: e.screenY - lastY });
            lastX = e.screenX;
            lastY = e.screenY;
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
        chartEl = document.getElementById('chart');
        layersEl = document.getElementById('layers');
        noDataEl = document.getElementById('nodata');
        guideEl = document.getElementById('guide');
        gridEl = document.getElementById('grid');
        ticksEl = document.getElementById('ticks');
        labelsEl = document.getElementById('labels');
        footerEl = document.getElementById('footer');
        axisStart = document.getElementById('axisStart');
        axisEnd = document.getElementById('axisEnd');
        legendEl = document.getElementById('legend');
        statusEl = document.getElementById('status');
        calloutEl = document.getElementById('callout');
        calloutTitle = document.getElementById('calloutTitle');
        calloutCount = document.getElementById('calloutCount');
        calloutDate = document.getElementById('calloutDate');
        resizeHandle = document.getElementById('resizeHandle');

        loader = NTHistory.loadController({
            contentKind: 'chart',
            initialRange: '7d',
            canLoad: function () { return !!state && settingsArrived; },
            range: function () { return settings.range; },
            load: trendsLoader(function () { return window.NepTunes; }),
            render: render,
            refreshMs: REFRESH_MS, retryMs: RETRY_MS, settingsReloadMs: SETTINGS_RELOAD_MS
        });

        applyAppearance();
        render();
        window.addEventListener('resize', onResize);

        NTHistory.connectHost(window.NepTunes, {
            settingschange: onSettings,
            statechange: onState,
            themechange: onThemeChange,
            pointermove: onPointerMove,
            pointerleave: onPointerLeave,
            beforeReplay: setupResize,
            started: loader.startSchedule
        });
    }

    function start() {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
        else init();
    }

    return {
        TOP_GENRES: TOP_GENRES, rangeDays: rangeDays, rankGenres: rankGenres, buildTimeline: buildTimeline,
        colorSlot: colorSlot, OTHER_SLOT: OTHER_SLOT, bands: bands, bandValue: bandValue,
        stackLayout: stackLayout, layerPath: layerPath, hitTest: hitTest,
        busiestTotal: busiestTotal, niceScale: niceScale, tickLines: tickLines, formatTick: formatTick,
        maxGutter: maxGutter, useCompact: useCompact, axisLayout: axisLayout, tickPositions: tickPositions,
        placeLabel: placeLabel, contrastRatio: contrastRatio, labelInk: labelInk, parseRgb: parseRgb,
        legendBands: legendBands,
        MAX_CONCURRENT_DAYS: MAX_CONCURRENT_DAYS, dayQuery: dayQuery,
        freshMemo: freshMemo, memoFor: memoFor, loadDays: loadDays, loadTrends: loadTrends, trendsLoader: trendsLoader,
        STRINGS: STRINGS, statusText: statusText, summaryText: summaryText,
        layout: layout, calloutOrigin: calloutOrigin,
        DEFAULT_SETTINGS: DEFAULT_SETTINGS, normalizeSettings: normalizeSettings,
        REFRESH_MS: REFRESH_MS, RETRY_MS: RETRY_MS, SETTINGS_RELOAD_MS: SETTINGS_RELOAD_MS,
        start: start
    };
});
