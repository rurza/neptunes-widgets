/**
 * Listening Clock — when you listen, as 24 hour bars around a ring: midnight at the top, going
 * clockwise, each as long as that hour's plays against the busiest hour's, with a minimum bar for
 * any hour that has plays and 2° gaps between them. Reads NepTunes' own listening history only —
 * history.query({ groupBy: 'hour' }) over the last 7 or 30 days or all of it — so hours are the
 * local wall-clock hours the plays happened in. Pinned by _dev/listening-clock.test.mjs
 * and, in WebKit, by ListeningClockWidgetPageTests.
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

    var HOURS = 24;
    var INNER_RATIO = 35 / 80;      // where the bars start, of the outer radius
    var CENTER_RATIO = 30 / 80;     // the disc in the middle
    var LABEL_RATIO = 95 / 80;      // where the 00/06/12/18 marks sit
    var MIN_BAR_SHARE = 8 / 45;     // the shortest bar, of the ring's width
    var GAP_DEGREES = 2;
    var LABEL_HOURS = [0, 6, 12, 18];

    /** history.query({ groupBy: 'hour' }) rows → plays and seconds per hour; a missing hour is 0. */
    function hourBuckets(rows) {
        var plays = [], seconds = [];
        for (var h = 0; h < HOURS; h++) { plays.push(0); seconds.push(0); }
        (rows || []).forEach(function (row) {
            var hour = row ? Number(row.hour) : NaN;
            if (!Number.isInteger(hour) || hour < 0 || hour >= HOURS) return;
            plays[hour] += Math.max(0, Number(row.plays) || 0);
            seconds[hour] += Math.max(0, Number(row.seconds) || 0);
        });
        return { plays: plays, seconds: seconds };
    }

    function totalPlays(buckets) {
        return buckets.plays.reduce(function (sum, n) { return sum + n; }, 0);
    }

    /** How far an hour's bar reaches across the ring: 0 when silent, else the minimum up to 1. */
    function barShare(plays, hour) {
        var count = plays[hour];
        if (!(count > 0)) return 0;
        var most = Math.max.apply(null, plays);
        return MIN_BAR_SHARE + (1 - MIN_BAR_SHARE) * count / most;
    }

    /** The busiest hour, the earliest of a tie; -1 when every hour is silent. */
    function peakHour(plays) {
        var best = -1;
        for (var h = 0; h < HOURS; h++) {
            if (plays[h] > 0 && (best < 0 || plays[h] > plays[best])) best = h;
        }
        return best;
    }

    /** Hours from 6:00 to 18:00 are day, drawn at full strength; the rest see-through (styles.css). */
    function isDaytime(hour) { return hour >= 6 && hour < 18; }

    /** Where an hour's segment starts and ends: degrees clockwise from +x on a y-down screen. */
    function segmentAngles(hour) {
        var step = 360 / HOURS;
        return { start: hour * step - 90 + GAP_DEGREES / 2, end: (hour + 1) * step - 90 - GAP_DEGREES / 2 };
    }

    /** Where an hour's mark goes: the hour's start, so 00 is straight up and 06 straight right. */
    function labelAngle(hour) { return hour * (360 / HOURS) - 90; }

    function round2(n) { return Math.round(n * 100) / 100; }

    function polar(cx, cy, radius, degrees) {
        var a = degrees * Math.PI / 180;
        return [round2(cx + radius * Math.cos(a)), round2(cy + radius * Math.sin(a))];
    }

    /** One hour's annular segment from `inner` out to `outer`, as an SVG path. */
    function segmentPath(cx, cy, inner, outer, hour) {
        var a = segmentAngles(hour);
        var ri = round2(inner), ro = round2(outer);
        return 'M' + polar(cx, cy, inner, a.start) +
            'L' + polar(cx, cy, outer, a.start) +
            'A' + ro + ',' + ro + ' 0 0 1 ' + polar(cx, cy, outer, a.end) +
            'L' + polar(cx, cy, inner, a.end) +
            'A' + ri + ',' + ri + ' 0 0 0 ' + polar(cx, cy, inner, a.start) + 'Z';
    }

    /**
     * The hour under a page point: by angle, anywhere from the centre disc's edge out to the marks
     * (a gap belongs half to each neighbour). Null over the disc — which shows the peak — and
     * outside the marks.
     */
    function hourAt(l, x, y) {
        if (!isFinite(x) || !isFinite(y)) return null;
        var dx = x - l.cx, dy = y - l.cy;
        var distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < l.center || distance > l.labelRadius) return null;
        var degrees = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        if (degrees < 0) degrees += 360;
        return Math.min(HOURS - 1, Math.floor(degrees / (360 / HOURS)));
    }

    // ---- Loading ------------------------------------------------------------

    /**
     * One load: what history.info() says, then one hour query over the range. Resolves to
     * { kind: 'clock', buckets, window }, { kind: 'noPlays', window }, { kind: 'notRecording' } or
     * { kind: 'tooOld' } (an app without the history API). History errors reject, untouched.
     */
    function loadClock(opts) {
        var nt = opts.nt || {};
        if (!NTHistory.hasHistory(nt)) return Promise.resolve({ kind: 'tooOld' });
        return Promise.resolve(nt.history.info()).then(function (info) {
            var win = NTHistory.rangeWindow(opts.range, opts.now, NTHistory.parseSince(info));
            if (!win) return { kind: 'notRecording' };
            return Promise.resolve(nt.history.query({
                from: win.from.toISOString(), to: win.to.toISOString(), groupBy: 'hour'
            })).then(function (result) {
                var buckets = hourBuckets(result && result.rows);
                if (!totalPlays(buckets)) return { kind: 'noPlays', window: win };
                return { kind: 'clock', buckets: buckets, window: win };
            });
        });
    }

    // ---- Strings --------------------------------------------------------------
    // The clock's own words; everything both stats widgets say is NTHistory's.

    var STRINGS = {
        ar: { peak: 'الذروة', loading: 'جارٍ تحميل ساعة الاستماع', summary: 'ساعة الذروة: {hour}' },
        ca: { peak: 'Pic', loading: 'Carregant el teu rellotge d’escolta', summary: 'Hora amb més escoltes: {hour}' },
        de: { peak: 'Spitze', loading: 'Deine Höruhr wird geladen', summary: 'Meistgehörte Stunde: {hour}' },
        en: { peak: 'Peak', loading: 'Loading your listening clock', summary: 'Busiest hour: {hour}' },
        es: { peak: 'Pico', loading: 'Cargando tu reloj de escucha', summary: 'Hora con más escuchas: {hour}' },
        fr: { peak: 'Pic', loading: 'Chargement de votre horloge d’écoute', summary: 'Heure la plus écoutée : {hour}' },
        it: { peak: 'Picco', loading: 'Caricamento dell’orologio degli ascolti', summary: 'Ora con più ascolti: {hour}' },
        ja: { peak: 'ピーク', loading: 'リスニングクロックを読み込み中', summary: '最もよく聴く時間: {hour}' },
        nl: { peak: 'Piek', loading: 'Je luisterklok wordt geladen', summary: 'Drukste uur: {hour}' },
        pl: { peak: 'Szczyt', loading: 'Wczytywanie zegara słuchania', summary: 'Najczęściej słuchana godzina: {hour}' },
        'pt-BR': { peak: 'Pico', loading: 'Carregando seu relógio de reprodução', summary: 'Horário com mais reproduções: {hour}' },
        ru: { peak: 'Пик', loading: 'Загрузка часов прослушивания', summary: 'Самый активный час: {hour}' },
        uk: { peak: 'Пік', loading: 'Завантаження годинника прослуховувань', summary: 'Найактивніша година: {hour}' },
        'zh-Hans': { peak: '高峰', loading: '正在加载收听时钟', summary: '收听最多的时段：{hour}' }
    };

    /**
     * The middle of the clock, as lines of text, `strong` marking the one set large. Idle: the
     * peak hour and its plays. Over an hour: that hour, its plays and its listening time. With
     * room for two lines only, the last line is left out. Each line but the label carries `compact`
     * — the hour without minutes, the bare number of plays, the time as "1:17" — for when
     * "12:00 AM", "22 прослушивания" or "1 Std. 17 Min." cannot fit the disc at a legible size.
     */
    function centerLines(buckets, hovered, lineCount, lang, locale) {
        var lines;
        if (hovered >= 0) {
            lines = [
                { text: NTHistory.formatHour(hovered, locale), strong: true,
                  compact: NTHistory.formatHourCompact(hovered, locale) },
                { text: NTHistory.playsText(buckets.plays[hovered], lang, locale), strong: false,
                  compact: NTHistory.formatNumber(buckets.plays[hovered], locale) },
                { text: NTHistory.formatDuration(buckets.seconds[hovered], locale), strong: false,
                  compact: NTHistory.formatDurationCompact(buckets.seconds[hovered], locale) }
            ];
        } else {
            var peak = peakHour(buckets.plays);
            if (peak < 0) return [];
            lines = [
                { text: (STRINGS[lang] || STRINGS.en).peak, strong: false },
                { text: NTHistory.formatHour(peak, locale), strong: true,
                  compact: NTHistory.formatHourCompact(peak, locale) },
                { text: NTHistory.playsText(buckets.plays[peak], lang, locale), strong: false,
                  compact: NTHistory.formatNumber(buckets.plays[peak], locale) }
            ];
        }
        return lines.slice(0, lineCount);
    }

    // ---- Geometry & settings ----------------------------------------------------
    // One layout, used both to draw and to hit-test, so what is drawn and what is hovered cannot
    // disagree. The card is square and centred, as Activity's is.

    var CARD_GUTTER = { left: 20, top: 16, right: 20, bottom: 24 };   // room for the host's card shadow (styles.css)
    var BARE_GUTTER = { left: 6, top: 6, right: 6, bottom: 6 };
    /** A centre disc this wide or wider has room for three lines; narrower, two. */
    var THREE_LINE_DISC = 46;

    function clamp(value, lo, hi) { return Math.min(hi, Math.max(lo, value)); }

    function layout(width, height, background) {
        var bare = background === 'none';
        var g = bare ? BARE_GUTTER : CARD_GUTTER;
        var availableWidth = Math.max(0, width - g.left - g.right);
        var availableHeight = Math.max(0, height - g.top - g.bottom);
        var side = Math.min(availableWidth, availableHeight);
        var cardX = g.left + Math.floor((availableWidth - side) / 2);
        var cardY = g.top + Math.floor((availableHeight - side) / 2);
        var pad = bare ? 0 : Math.round(side * 0.05);
        var labelSize = clamp(Math.round(side * 0.06), 9, 13);
        var outer = Math.max(0, Math.floor((side / 2 - pad - labelSize * 0.6) / LABEL_RATIO));
        var inner = outer * INNER_RATIO;
        var center = outer * CENTER_RATIO;
        var centerFont = clamp(Math.round(outer * 0.17), 9, 22);
        return {
            card: { x: cardX, y: cardY, side: side },
            cx: cardX + side / 2,
            cy: cardY + side / 2,
            outer: outer,
            inner: inner,
            center: center,
            labelRadius: outer * LABEL_RATIO,
            labelSize: labelSize,
            captionSize: clamp(Math.round(side * 0.05), 9, 12),
            // The range caption sits in the card's top corner and stops short of the 00 mark.
            captionWidth: Math.max(0, Math.floor(side / 2 - pad - labelSize)),
            centerBox: { w: Math.round(inner * 1.7), h: Math.round(inner * 1.3) },
            centerFont: centerFont,
            centerSmall: Math.max(8, Math.round(centerFont * 0.78)),
            centerLineCount: center * 2 >= THREE_LINE_DISC ? 3 : 2,
            panelRadius: clamp(Math.round(side * 0.11), 10, 22),
            statusSize: clamp(Math.round(side / 13), 10, 14)
        };
    }

    var DEFAULT_SETTINGS = {
        range: '30d', accentSource: 'system', fixedColor: '#5B92EA', theme: 'auto', background: 'card'
    };
    var SETTING_VALUES = {
        range: ['7d', '30d', 'all'],
        accentSource: ['system', 'album', 'fixed'],
        theme: ['auto', 'dark', 'light'],
        background: ['card', 'none']
    };

    function normalizeSettings(raw) { return NTHistory.normalizeSettings(raw, DEFAULT_SETTINGS, SETTING_VALUES); }

    // ---- Page (browser only) ------------------------------------------------
    // Everything below touches the DOM or window.NepTunes. Nodes are looked up in init():
    // Node and JavaScriptCore load this file with no document.

    var SVG_NS = 'http://www.w3.org/2000/svg';
    var REFRESH_MS = 10 * 60 * 1000;
    var RETRY_MS = 60 * 1000;
    // A run of range changes loads once, when it settles; appearance changes never load.
    var SETTINGS_RELOAD_MS = 400;

    var root = null, card = null, face = null, tracksEl = null, barsEl = null;
    var discEl = null, labelsEl = null, centerEl = null, captionEl = null, statusEl = null, resizeHandle = null;
    var trackEls = [], barEls = [], labelEls = [], lineEls = [];
    var settings = normalizeSettings(null);
    var settingsArrived = false;   // NepTunes.settings is null until the host's first push
    var state = null;
    var lang = 'en', locale = null;
    // NTHistory.loadController: owns phase, result (what loadClock() last settled on) and
    // resultRange, and the load / retry / refresh policy. Made in init().
    var loader = null;
    var accent = null;             // NTHistory.accentPainter, made in init()
    var currentLayout = null;
    var hoveredHour = -1;

    function svg(tag, attrs) {
        var el = document.createElementNS(SVG_NS, tag);
        Object.keys(attrs || {}).forEach(function (key) { el.setAttribute(key, attrs[key]); });
        return el;
    }

    function buildFace() {
        for (var h = 0; h < HOURS; h++) {
            var track = svg('path', { 'class': 'track', 'data-hour': String(h) });
            var bar = svg('path', { 'class': 'bar', 'data-hour': String(h) });
            tracksEl.appendChild(track);
            barsEl.appendChild(bar);
            trackEls.push(track);
            barEls.push(bar);
        }
        LABEL_HOURS.forEach(function (hour) {
            var label = svg('text', { 'class': 'hour-label', 'data-hour': String(hour), 'text-anchor': 'middle', 'dominant-baseline': 'central' });
            labelsEl.appendChild(label);
            labelEls.push(label);
        });
        for (var i = 0; i < 3; i++) {
            var line = document.createElement('div');
            line.className = 'center-line';
            centerEl.appendChild(line);
            lineEls.push(line);
        }
    }

    function applyAppearance() {
        root.classList.remove('theme-auto', 'theme-dark', 'theme-light');
        root.classList.add('theme-' + settings.theme);
        root.classList.toggle('bare', settings.background === 'none');
        // A bare clock is no card: no system corner to clip it, no shadow to cast.
        card.classList.toggle('nt-card', settings.background !== 'none');
        updateAccent();
    }

    function paintAccent(rgb) { root.style.setProperty('--accent-rgb', rgb.join(', ')); }

    /** Repaints the accent when its source, the fixed colour, the cover or the panel's polarity moved. */
    function updateAccent() { accent.update(settings, window.NepTunes); }

    // The desktop switched between light and dark: the panel follows in CSS; an album colour is
    // picked again against the new panel. An explicit theme does not move.
    function onThemeChange() { accent.themeChanged(settings, window.NepTunes); }

    /** Card, ring, marks and centre box, from the layout. Bars are drawn by render(). */
    function applyLayout() {
        var l = currentLayout = layout(window.innerWidth, window.innerHeight, settings.background);
        card.style.left = l.card.x + 'px';
        card.style.top = l.card.y + 'px';
        card.style.width = l.card.side + 'px';
        card.style.height = l.card.side + 'px';
        root.style.setProperty('--panel-radius', l.panelRadius + 'px');
        root.style.setProperty('--label-size', l.labelSize + 'px');
        root.style.setProperty('--caption-size', l.captionSize + 'px');
        root.style.setProperty('--status-size', l.statusSize + 'px');
        captionEl.style.maxWidth = l.captionWidth + 'px';
        face.setAttribute('width', String(l.card.side));
        face.setAttribute('height', String(l.card.side));
        face.setAttribute('viewBox', '0 0 ' + l.card.side + ' ' + l.card.side);
        var cx = l.cx - l.card.x, cy = l.cy - l.card.y;   // card-local: the face is the card's child
        for (var h = 0; h < HOURS; h++) trackEls[h].setAttribute('d', segmentPath(cx, cy, l.inner, l.outer, h));
        discEl.setAttribute('cx', String(cx));
        discEl.setAttribute('cy', String(cy));
        discEl.setAttribute('r', String(round2(l.center)));
        labelEls.forEach(function (label, i) {
            var p = polar(cx, cy, l.labelRadius, labelAngle(LABEL_HOURS[i]));
            label.setAttribute('x', String(p[0]));
            label.setAttribute('y', String(p[1]));
        });
        centerEl.style.width = l.centerBox.w + 'px';
        centerEl.style.height = l.centerBox.h + 'px';
        centerEl.style.left = round2(cx - l.centerBox.w / 2) + 'px';
        centerEl.style.top = round2(cy - l.centerBox.h / 2) + 'px';
    }

    /**
     * Shrinks a centre line half a pixel at a time until it fits the centre box across, no smaller
     * than MIN_LINE_PX. Still too wide there, the line falls back to `compact` (when it has one),
     * shrunk the same way.
     */
    var MIN_LINE_PX = 8;
    function fitLine(el, line, size) {
        function shrink(text) {
            var px = size;
            el.textContent = text;
            el.style.fontSize = px + 'px';
            while (px > MIN_LINE_PX && el.scrollWidth > centerEl.clientWidth) {
                px -= 0.5;
                el.style.fontSize = px + 'px';
            }
            return el.scrollWidth <= centerEl.clientWidth;
        }
        if (!shrink(line.text) && line.compact) shrink(line.compact);
    }

    function renderCenter() {
        var result = loader.result;
        var buckets = loader.phase === 'ready' && result && result.kind === 'clock' ? result.buckets : null;
        var lines = buckets ? centerLines(buckets, hoveredHour, currentLayout.centerLineCount, lang, locale) : [];
        lineEls.forEach(function (el, i) {
            var line = lines[i];
            el.hidden = !line;
            el.textContent = '';
            el.classList.toggle('strong', !!(line && line.strong));
            if (line) fitLine(el, line, line.strong ? currentLayout.centerFont : currentLayout.centerSmall);
        });
    }

    function renderHover() {
        for (var h = 0; h < HOURS; h++) {
            trackEls[h].classList.toggle('hovered', h === hoveredHour);
            barEls[h].classList.toggle('hovered', h === hoveredHour);
        }
        renderCenter();
    }

    function render() {
        var phase = loader.phase, result = loader.result;
        var status = phase === 'ready' ? NTHistory.statusText(result, loader.resultRange, lang) : null;
        var buckets = phase === 'ready' && result && result.kind === 'clock' ? result.buckets : null;
        card.dataset.phase = phase;
        card.dataset.kind = result ? result.kind : '';
        face.style.visibility = status ? 'hidden' : 'visible';
        centerEl.hidden = !!status;
        captionEl.hidden = !!status;
        statusEl.hidden = !status;
        if (status) {
            statusEl.textContent = status;
            hoveredHour = -1;
            return;
        }
        var l = currentLayout, cx = l.cx - l.card.x, cy = l.cy - l.card.y;
        for (var h = 0; h < HOURS; h++) {
            var share = buckets ? barShare(buckets.plays, h) : 0;
            barEls[h].setAttribute('d', share > 0 ? segmentPath(cx, cy, l.inner, l.inner + (l.outer - l.inner) * share, h) : '');
            barEls[h].setAttribute('class', 'bar ' + (isDaytime(h) ? 'day' : 'night'));
            barEls[h].dataset.plays = buckets ? String(buckets.plays[h]) : '';
        }
        labelEls.forEach(function (label, i) { label.textContent = NTHistory.formatTwoDigits(LABEL_HOURS[i], locale); });
        captionEl.textContent = NTHistory.rangeCaption(settings.range, buckets ? result.window : null, lang, locale);
        var words = STRINGS[lang] || STRINGS.en;
        face.setAttribute('aria-label', buckets
            ? words.summary.replace('{hour}', NTHistory.formatHour(peakHour(buckets.plays), locale))
            : words.loading);
        renderHover();
    }

    function onPointerMove(point) {
        if (!point || !currentLayout || !(loader.result && loader.result.kind === 'clock') || loader.phase !== 'ready') return;
        var hour = hourAt(currentLayout, Number(point.x), Number(point.y));
        var next = hour === null ? -1 : hour;
        if (next === hoveredHour) return;
        hoveredHour = next;
        renderHover();
    }

    function onPointerLeave() {
        if (hoveredHour < 0) return;
        hoveredHour = -1;
        if (card) renderHover();
    }

    function onSettings(next) {
        if (!next) return;
        var previous = settingsArrived ? settings : null;
        settings = normalizeSettings(next);
        settingsArrived = true;
        applyAppearance();
        applyLayout();
        // The first push starts the first load; a new range goes back to loading at once and
        // loads when it settles; anything else only repaints.
        loader.settingsChanged(!previous, !!previous && previous.range !== settings.range);
    }

    function onState(next) {
        if (!next) return;
        // Mirror for a right-to-left host (the caption moves to the other corner; the clock itself
        // never mirrors — midnight is up and time runs clockwise in every language).
        if (next.layoutDirection) document.documentElement.dir = next.layoutDirection;
        var first = state === null;
        state = next;
        var nextLang = NTHistory.pickLanguage(next.language);
        var nextLocale = next.locale || null;
        var textChanged = nextLang !== lang || nextLocale !== locale;
        lang = nextLang;
        locale = nextLocale;
        updateAccent();   // cheap unless the cover changed
        loader.stateChanged(first, textChanged);   // statechange fires on every position tick
    }

    // Square-locked resize, Activity's pattern: both deltas averaged, so the clock stays round.
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
        face = document.getElementById('face');
        tracksEl = document.getElementById('tracks');
        barsEl = document.getElementById('bars');
        discEl = document.getElementById('disc');
        labelsEl = document.getElementById('labels');
        centerEl = document.getElementById('center');
        captionEl = document.getElementById('caption');
        statusEl = document.getElementById('status');
        resizeHandle = document.getElementById('resizeHandle');

        accent = NTHistory.accentPainter(paintAccent);
        loader = NTHistory.loadController({
            contentKind: 'clock',
            initialRange: '30d',
            canLoad: function () { return !!state && settingsArrived; },   // loads need the range
            range: function () { return settings.range; },
            load: function (range, now) { return loadClock({ nt: window.NepTunes, now: now, range: range }); },
            onLoading: function () { hoveredHour = -1; },
            render: render,
            refreshMs: REFRESH_MS, retryMs: RETRY_MS, settingsReloadMs: SETTINGS_RELOAD_MS
        });

        buildFace();
        applyAppearance();
        applyLayout();
        render();
        window.addEventListener('resize', function () { applyLayout(); render(); });

        NTHistory.connectHost(window.NepTunes, {
            settingschange: onSettings,
            statechange: onState,
            themechange: onThemeChange,
            // pointerTracking (manifest): page-CSS-px positions while the pointer is over the widget.
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
        HOURS: HOURS, INNER_RATIO: INNER_RATIO, CENTER_RATIO: CENTER_RATIO, LABEL_RATIO: LABEL_RATIO,
        MIN_BAR_SHARE: MIN_BAR_SHARE, GAP_DEGREES: GAP_DEGREES, LABEL_HOURS: LABEL_HOURS,
        hourBuckets: hourBuckets, totalPlays: totalPlays, barShare: barShare, peakHour: peakHour,
        isDaytime: isDaytime, segmentAngles: segmentAngles, labelAngle: labelAngle,
        segmentPath: segmentPath, hourAt: hourAt, loadClock: loadClock,
        STRINGS: STRINGS, centerLines: centerLines,
        layout: layout, DEFAULT_SETTINGS: DEFAULT_SETTINGS, normalizeSettings: normalizeSettings,
        REFRESH_MS: REFRESH_MS, RETRY_MS: RETRY_MS, SETTINGS_RELOAD_MS: SETTINGS_RELOAD_MS,
        start: start
    };
});
