/**
 * NTHistory — what the listening-history widgets (Listening Clock, Genre Trends) share: the
 * strings both say, number/day/hour/duration formatting through the host locale, the days a
 * range setting covers and how `history.info().since` cuts them, what a history error shows,
 * the accent the bars are tinted with, and the page plumbing both controllers run the same way
 * (accent repaint, load / retry / refresh policy, host hookup). Vendored verbatim into each bundle that uses it, as
 * neptunes-kit.js is; _dev/history-stats.test.mjs pins it and holds every copy to this master.
 */
(function (factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.NTHistory = api;
    else if (typeof self !== 'undefined') self.NTHistory = api;
})(function () {
    'use strict';

    // ---- Calendar ---------------------------------------------------------------
    // Local calendar days, as history.query buckets them (the wall clock where the play happened).

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    function startOfDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }

    // Through the Date constructor, never `+ 86400000`: a DST day is 23 or 25 hours long.
    function addDays(date, n) { return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n); }

    function dayKey(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    /** A second past the next local midnight, through the calendar so a 23 h or 25 h day is right. */
    function msUntilNextMidnight(now) {
        return addDays(startOfDay(now), 1).getTime() - now.getTime() + 1000;
    }

    /** The zone local day keys are cut in: its name where the engine has one, and today's offset. */
    function timeZoneKey(now) {
        var zone = '';
        try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
        return zone + '|' + (-startOfDay(now).getTimezoneOffset());
    }

    // ---- Ranges -----------------------------------------------------------------

    /** Days per range setting value; 'all' runs from the day of the first recorded play. */
    var RANGE_DAYS = { '7d': 7, '30d': 30, all: null };

    /** `info().since` as a Date, or null when nothing is recorded yet or it cannot be read. */
    function parseSince(info) {
        var since = info && info.since ? new Date(info.since) : null;
        return since && !isNaN(since.getTime()) ? since : null;
    }

    /**
     * The local days `range` covers, ending today: `from` (the start of its first day) and `to`
     * (the start of tomorrow — half-open, so all of today). `partial` when history began after
     * `from`: the first days have no data, and must not read as silent. Null without `since`:
     * nothing is recorded, so there is nothing to ask for.
     */
    function rangeWindow(range, now, since) {
        if (!Object.prototype.hasOwnProperty.call(RANGE_DAYS, range)) throw new Error('unknown range: ' + range);
        if (!since) return null;
        var today = startOfDay(now);
        var sinceDay = startOfDay(since);
        var days = RANGE_DAYS[range];
        var from = days === null ? sinceDay : addDays(today, -(days - 1));
        if (from > today) from = today;   // a `since` ahead of this Mac's clock: today alone
        return { from: from, to: addDays(today, 1), sinceDay: sinceDay, partial: sinceDay > from };
    }

    // ---- Errors -----------------------------------------------------------------

    function hasHistory(nt) {
        return !!(nt && nt.history && typeof nt.history.info === 'function' && typeof nt.history.query === 'function');
    }

    /**
     * What a failed history load shows, and whether asking again in a minute can help.
     * `permissionDenied` is an app that refuses a permission the manifest declares — one too old
     * to know it — so it reads like a missing `history`: update NepTunes. `invalidQuery` is this
     * widget's own mistake, and the same query would fail the same way: no retry. `unavailable`,
     * `timeout` and anything without a code are passing failures: retried.
     */
    function failure(error) {
        var code = error && error.code;
        if (code === 'permissionDenied') return { kind: 'tooOld', retry: false };
        if (code === 'invalidQuery') return { kind: 'error', retry: false };
        return { kind: 'error', retry: true };
    }

    // ---- Strings ----------------------------------------------------------------
    // One table per app language, chosen by state.language. `plays`, `noData`, `tooOld` and
    // `noPlays.all` are the Listening Activity widget's own wording, so the stats widgets say
    // the same thing the same way.

    var STRINGS = {
        ar: {
            plays: { zero: '{n} مرة تشغيل', one: 'مرة تشغيل واحدة', two: 'مرتا تشغيل', few: '{n} مرات تشغيل', many: '{n} مرة تشغيل', other: '{n} مرة تشغيل' },
            notRecording: 'لم يُسجَّل شيء بعد. يحتفظ NepTunes بسجل استماعك بدءًا من الإصدار 4.0.',
            noPlays: { '7d': 'لا توجد مرات تشغيل في آخر 7 أيام', '30d': 'لا توجد مرات تشغيل في آخر 30 يومًا', all: 'لم تستمع إلى أي شيء بعد' },
            loadFailed: 'تعذّر تحميل سجل استماعك',
            tooOld: 'حدِّث NepTunes لاستخدام هذه الأداة',
            noData: 'لا توجد بيانات لهذا اليوم',
            range: { '7d': 'آخر 7 أيام', '30d': 'آخر 30 يومًا', all: 'كل الأوقات' },
            since: 'منذ {date}'
        },
        ca: {
            plays: { one: '{n} reproducció', many: '{n} de reproduccions', other: '{n} reproduccions' },
            notRecording: 'Encara no s’ha enregistrat res. NepTunes guarda el teu historial d’escolta des de la versió 4.0.',
            noPlays: { '7d': 'Cap reproducció en els últims 7 dies', '30d': 'Cap reproducció en els últims 30 dies', all: 'Encara no has escoltat res' },
            loadFailed: 'No s’ha pogut carregar el teu historial d’escolta',
            tooOld: 'Actualitza NepTunes per fer servir aquest giny',
            noData: 'Sense dades per a aquest dia',
            range: { '7d': 'Últims 7 dies', '30d': 'Últims 30 dies', all: 'Sempre' },
            since: 'Des del {date}'
        },
        de: {
            plays: { one: '{n} Wiedergabe', other: '{n} Wiedergaben' },
            notRecording: 'Noch nichts aufgezeichnet. NepTunes speichert deinen Hörverlauf ab Version 4.0.',
            noPlays: { '7d': 'Keine Wiedergaben in den letzten 7 Tagen', '30d': 'Keine Wiedergaben in den letzten 30 Tagen', all: 'Noch nichts gehört' },
            loadFailed: 'Dein Hörverlauf konnte nicht geladen werden',
            tooOld: 'Aktualisiere NepTunes, um dieses Widget zu verwenden',
            noData: 'Keine Daten für diesen Tag',
            range: { '7d': 'Letzte 7 Tage', '30d': 'Letzte 30 Tage', all: 'Gesamt' },
            since: 'Seit {date}'
        },
        en: {
            plays: { one: '{n} play', other: '{n} plays' },
            notRecording: 'Nothing recorded yet. NepTunes keeps your listening history from version 4.0 on.',
            noPlays: { '7d': 'No plays in the last 7 days', '30d': 'No plays in the last 30 days', all: 'Nothing played yet' },
            loadFailed: 'Couldn’t load your listening history',
            tooOld: 'Update NepTunes to use this widget',
            noData: 'No data for this day',
            range: { '7d': 'Last 7 days', '30d': 'Last 30 days', all: 'All time' },
            since: 'Since {date}'
        },
        es: {
            plays: { one: '{n} reproducción', many: '{n} de reproducciones', other: '{n} reproducciones' },
            notRecording: 'Aún no hay nada registrado. NepTunes guarda tu historial de escucha desde la versión 4.0.',
            noPlays: { '7d': 'Sin reproducciones en los últimos 7 días', '30d': 'Sin reproducciones en los últimos 30 días', all: 'Aún no has escuchado nada' },
            loadFailed: 'No se pudo cargar tu historial de escucha',
            tooOld: 'Actualiza NepTunes para usar este widget',
            noData: 'Sin datos para este día',
            range: { '7d': 'Últimos 7 días', '30d': 'Últimos 30 días', all: 'Siempre' },
            since: 'Desde el {date}'
        },
        fr: {
            plays: { one: '{n} écoute', many: '{n} d’écoutes', other: '{n} écoutes' },
            notRecording: 'Rien n’a encore été enregistré. NepTunes conserve votre historique d’écoute depuis la version 4.0.',
            noPlays: { '7d': 'Aucune écoute ces 7 derniers jours', '30d': 'Aucune écoute ces 30 derniers jours', all: 'Vous n’avez encore rien écouté' },
            loadFailed: 'Impossible de charger votre historique d’écoute',
            tooOld: 'Mettez à jour NepTunes pour utiliser ce widget',
            noData: 'Aucune donnée pour ce jour',
            range: { '7d': '7 derniers jours', '30d': '30 derniers jours', all: 'Depuis toujours' },
            since: 'Depuis le {date}'
        },
        it: {
            plays: { one: '{n} ascolto', many: '{n} di ascolti', other: '{n} ascolti' },
            notRecording: 'Ancora nessun dato registrato. NepTunes conserva la cronologia degli ascolti dalla versione 4.0.',
            noPlays: { '7d': 'Nessun ascolto negli ultimi 7 giorni', '30d': 'Nessun ascolto negli ultimi 30 giorni', all: 'Non hai ancora ascoltato nulla' },
            loadFailed: 'Impossibile caricare la cronologia degli ascolti',
            tooOld: 'Aggiorna NepTunes per usare questo widget',
            noData: 'Nessun dato per questo giorno',
            range: { '7d': 'Ultimi 7 giorni', '30d': 'Ultimi 30 giorni', all: 'Sempre' },
            since: 'Dal {date}'
        },
        ja: {
            plays: { other: '{n} 回再生' },
            notRecording: 'まだ記録はありません。NepTunes はバージョン 4.0 から再生履歴を記録しています。',
            noPlays: { '7d': '過去7日間の再生はありません', '30d': '過去30日間の再生はありません', all: 'まだ何も再生していません' },
            loadFailed: '再生履歴を読み込めませんでした',
            tooOld: 'このウィジェットを使うには NepTunes をアップデートしてください',
            noData: 'この日のデータはありません',
            range: { '7d': '過去7日間', '30d': '過去30日間', all: '全期間' },
            since: '{date}以降'
        },
        nl: {
            plays: { one: '{n} keer afgespeeld', other: '{n} keer afgespeeld' },
            notRecording: 'Nog niets vastgelegd. NepTunes houdt je luistergeschiedenis bij vanaf versie 4.0.',
            noPlays: { '7d': 'Niets afgespeeld in de laatste 7 dagen', '30d': 'Niets afgespeeld in de laatste 30 dagen', all: 'Nog niets afgespeeld' },
            loadFailed: 'Je luistergeschiedenis kon niet worden geladen',
            tooOld: 'Werk NepTunes bij om deze widget te gebruiken',
            noData: 'Geen gegevens voor deze dag',
            range: { '7d': 'Laatste 7 dagen', '30d': 'Laatste 30 dagen', all: 'Altijd' },
            since: 'Sinds {date}'
        },
        pl: {
            plays: { one: '{n} odtworzenie', few: '{n} odtworzenia', many: '{n} odtworzeń', other: '{n} odtworzenia' },
            notRecording: 'Nic jeszcze nie zapisano. NepTunes zapisuje historię słuchania od wersji 4.0.',
            noPlays: { '7d': 'Brak odtworzeń w ciągu ostatnich 7 dni', '30d': 'Brak odtworzeń w ciągu ostatnich 30 dni', all: 'Jeszcze nic nie odtworzono' },
            loadFailed: 'Nie udało się wczytać historii słuchania',
            tooOld: 'Zaktualizuj NepTunes, aby używać tego widżetu',
            noData: 'Brak danych dla tego dnia',
            range: { '7d': 'Ostatnie 7 dni', '30d': 'Ostatnie 30 dni', all: 'Cały czas' },
            since: 'Od {date}'
        },
        'pt-BR': {
            // CLDR files 0 under "one"; Brazilian Portuguese counts zero in the plural.
            plays: { zero: '{n} reproduções', one: '{n} reprodução', many: '{n} de reproduções', other: '{n} reproduções' },
            notRecording: 'Nada registrado ainda. O NepTunes guarda seu histórico de reprodução desde a versão 4.0.',
            noPlays: { '7d': 'Nenhuma reprodução nos últimos 7 dias', '30d': 'Nenhuma reprodução nos últimos 30 dias', all: 'Você ainda não ouviu nada' },
            loadFailed: 'Não foi possível carregar seu histórico de reprodução',
            tooOld: 'Atualize o NepTunes para usar este widget',
            noData: 'Sem dados para este dia',
            range: { '7d': 'Últimos 7 dias', '30d': 'Últimos 30 dias', all: 'Todo o período' },
            since: 'Desde {date}'
        },
        ru: {
            plays: { one: '{n} прослушивание', few: '{n} прослушивания', many: '{n} прослушиваний', other: '{n} прослушивания' },
            notRecording: 'Пока ничего не записано. NepTunes ведёт историю прослушиваний начиная с версии 4.0.',
            noPlays: { '7d': 'Нет прослушиваний за последние 7 дней', '30d': 'Нет прослушиваний за последние 30 дней', all: 'Вы ещё ничего не слушали' },
            loadFailed: 'Не удалось загрузить историю прослушиваний',
            tooOld: 'Обновите NepTunes, чтобы пользоваться этим виджетом',
            noData: 'Нет данных за этот день',
            range: { '7d': 'Последние 7 дней', '30d': 'Последние 30 дней', all: 'Всё время' },
            since: 'С {date}'
        },
        uk: {
            plays: { one: '{n} прослуховування', few: '{n} прослуховування', many: '{n} прослуховувань', other: '{n} прослуховування' },
            notRecording: 'Поки нічого не записано. NepTunes веде історію прослуховувань починаючи з версії 4.0.',
            noPlays: { '7d': 'Немає прослуховувань за останні 7 днів', '30d': 'Немає прослуховувань за останні 30 днів', all: 'Ви ще нічого не слухали' },
            loadFailed: 'Не вдалося завантажити історію прослуховувань',
            tooOld: 'Оновіть NepTunes, щоб користуватися цим віджетом',
            noData: 'Немає даних за цей день',
            range: { '7d': 'Останні 7 днів', '30d': 'Останні 30 днів', all: 'Весь час' },
            since: 'З {date}'
        },
        'zh-Hans': {
            plays: { other: '{n} 次播放' },
            notRecording: '尚无记录。NepTunes 从 4.0 版起记录你的收听历史。',
            noPlays: { '7d': '最近 7 天没有播放记录', '30d': '最近 30 天没有播放记录', all: '还没有收听记录' },
            loadFailed: '无法加载你的收听历史',
            tooOld: '请更新 NepTunes 以使用此小组件',
            noData: '这一天没有数据',
            range: { '7d': '最近 7 天', '30d': '最近 30 天', all: '全部时间' },
            since: '自 {date}起'
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

    function strings(lang) { return STRINGS[lang] || STRINGS.en; }

    // A malformed tag (the ICU "ar_SA" form) makes Intl throw RangeError; degrade, never die.
    function formatNumber(n, locale) {
        try { return new Intl.NumberFormat(locale || undefined).format(n); } catch (e) { return String(n); }
    }

    function formatDay(date, locale) {
        try { return new Intl.DateTimeFormat(locale || undefined, { day: 'numeric', month: 'short' }).format(date); }
        catch (e) { return dayKey(date); }
    }

    /** An hour of the day as the locale writes a time: "21:00", "9:00 PM". */
    function formatHour(hour, locale) {
        try { return new Intl.DateTimeFormat(locale || undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(2026, 0, 1, hour)); }
        catch (e) { return pad2(hour) + ':00'; }
    }

    /** The same hour without its minutes, "9 PM", "21 Uhr", for where the full time does not fit. */
    function formatHourCompact(hour, locale) {
        try { return new Intl.DateTimeFormat(locale || undefined, { hour: 'numeric' }).format(new Date(2026, 0, 1, hour)); }
        catch (e) { return pad2(hour); }
    }

    /** "06" in the locale's own digits — the clock's 00/06/12/18 marks. */
    function formatTwoDigits(n, locale) {
        try { return new Intl.NumberFormat(locale || undefined, { minimumIntegerDigits: 2, useGrouping: false }).format(n); }
        catch (e) { return pad2(n); }
    }

    /** Listening time, to the minute: "45 min", "3 hr", "2 hr 15 min". */
    function formatDuration(seconds, locale) {
        var minutes = Math.round(Math.max(0, Number(seconds) || 0) / 60);
        var h = Math.floor(minutes / 60), m = minutes % 60;
        function unit(value, name) {
            try { return new Intl.NumberFormat(locale || undefined, { style: 'unit', unit: name, unitDisplay: 'short' }).format(value); }
            catch (e) { return value + (name === 'hour' ? ' h' : ' min'); }
        }
        if (h === 0) return unit(m, 'minute');
        if (m === 0) return unit(h, 'hour');
        return unit(h, 'hour') + ' ' + unit(m, 'minute');
    }

    /** The same time as hours and minutes, "1:17", for where the words do not fit. */
    function formatDurationCompact(seconds, locale) {
        var minutes = Math.round(Math.max(0, Number(seconds) || 0) / 60);
        return formatNumber(Math.floor(minutes / 60), locale) + ':' + formatTwoDigits(minutes % 60, locale);
    }

    function pluralCategory(n, lang) {
        try { return new Intl.PluralRules(lang).select(n); } catch (e) { return n === 1 ? 'one' : 'other'; }
    }

    /** A count of plays in the host language; a table's `zero` form wins for 0, as a stringsdict's does. */
    function playsText(n, lang, locale) {
        var forms = strings(lang).plays;
        var form = (n === 0 && forms.zero) || forms[pluralCategory(n, lang)] || forms.other;
        return form.replace('{n}', formatNumber(n, locale));
    }

    /** "Last 7 days", "All time" — or "Since 12 Sep" when history began inside the range. */
    function rangeCaption(range, win, lang, locale) {
        var s = strings(lang);
        if (win && win.partial) return s.since.replace('{date}', formatDay(win.sinceDay, locale));
        return s.range[range];
    }

    /** The status line for a settled load that has nothing to draw, or null for the chart itself. */
    function statusText(result, range, lang) {
        var s = strings(lang);
        switch (result && result.kind) {
            case 'notRecording': return s.notRecording;
            case 'noPlays': return s.noPlays[range];
            case 'error': return s.loadFailed;
            case 'tooOld': return s.tooOld;
            default: return null;
        }
    }

    // ---- Settings & accent ------------------------------------------------------

    function isHexColor(value) { return typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value); }

    function hexToRgb(hex) {
        return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    }

    /**
     * Settings with anything missing or unknown replaced by its default. `allowed` lists the
     * values of each choice setting; a key absent from it is a colour, which must be #RRGGBB.
     */
    function normalizeSettings(raw, defaults, allowed) {
        raw = raw || {};
        var out = {};
        Object.keys(defaults).forEach(function (key) {
            var value = raw[key];
            if (allowed[key]) out[key] = allowed[key].indexOf(value) !== -1 ? value : defaults[key];
            else out[key] = isHexColor(value) ? value : defaults[key];
        });
        return out;
    }

    /**
     * NepTunes' app accent (NepTunesUI's AppAccent.swift: Display P3 (91, 146, 234) light,
     * (60, 120, 217) dark), carried in sRGB because the bars mix in sRGB — the same numbers the
     * Listening Activity widget paints with nothing playing.
     */
    var APP_ACCENT_LIGHT = [71, 148, 241];
    var APP_ACCENT_DARK = [30, 122, 224];
    function appAccent(dark) { return (dark ? APP_ACCENT_DARK : APP_ACCENT_LIGHT).slice(); }

    /**
     * macOS's systemBlue as Apple revised it on 2025-06-09 (HIG → Color → System colors), the
     * value NSColor.systemBlue reports in sRGB: #0088FF under Aqua, #0091FF under Dark Aqua. The
     * default accent (`accentSource: 'system'`), painted for the panel's appearance.
     */
    var SYSTEM_BLUE_LIGHT = [0, 136, 255];
    var SYSTEM_BLUE_DARK = [0, 145, 255];
    function systemBlue(dark) { return (dark ? SYSTEM_BLUE_DARK : SYSTEM_BLUE_LIGHT).slice(); }

    /**
     * What to tint with: `{ key, rgb }` to paint at once, or `{ key, url, pending }` for a cover to
     * decode first (`pending` is the tint to show meanwhile). `key` is the cache identity: the page
     * repaints exactly when it moves, and statechange fires on every position tick. Activity's
     * accentTarget, plus the system blue: `system` paints systemBlue for the panel's appearance,
     * `fixed` the picked colour, `album` the cover's (the app accent with nothing playing).
     */
    function accentTarget(settings, artworkURL, dark) {
        var polarity = dark ? 'dark' : 'light';
        if (settings.accentSource === 'system') return { key: 'system|' + polarity, rgb: systemBlue(dark) };
        if (settings.accentSource === 'fixed') return { key: 'fixed|' + settings.fixedColor, rgb: hexToRgb(settings.fixedColor) };
        if (artworkURL) return { key: 'album|' + polarity + '|' + artworkURL, url: artworkURL, pending: appAccent(dark) };
        return { key: 'app|' + polarity, rgb: appAccent(dark) };
    }

    // ---- Page plumbing ------------------------------------------------------------
    // What both page controllers run the same way. No DOM here: the page hands in what to paint
    // and render, so Node runs all of it.

    /**
     * The accent repaint: `update(settings, nt)` paints exactly when accentTarget's key moves —
     * at once for the system blue, a fixed colour or the app accent, after decoding for a cover
     * (the app accent meanwhile, on the very first paint only). A cover that finishes decoding
     * after the key moved on is dropped. `themeChanged` is the desktop flipping light/dark: the
     * system blue moves to the new appearance's and an album colour, picked against the old
     * panel, is picked again; an explicit theme does not move. `kit` is NTKit (the default, read
     * when called).
     */
    function accentPainter(paint, kit) {
        var UNSET = {};
        var lastKey = UNSET;
        function update(settings, nt) {
            var k = kit || NTKit;
            var dark = k.panelIsDark(settings.theme);
            var url = settings.accentSource === 'album' && nt && nt.getArtworkDataURL ? nt.getArtworkDataURL() : null;
            var target = accentTarget(settings, url, dark);
            if (target.key === lastKey) return;
            var firstPaint = lastKey === UNSET;
            lastKey = target.key;
            if (target.rgb) { paint(target.rgb); return; }
            if (firstPaint) paint(target.pending);
            return k.accent(target.url).then(function (palette) {
                if (lastKey !== target.key) return;   // the cover or the settings moved on meanwhile
                paint(k.legibleAccent(palette.accent, dark));
            });
        }
        function themeChanged(settings, nt) {
            if (settings.theme === 'auto') update(settings, nt);
        }
        return { update: update, themeChanged: themeChanged };
    }

    // Read when called: a page's test stub replaces window.setTimeout after this file loads.
    var GLOBAL_TIMERS = {
        setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
        clearTimeout: function (id) { return clearTimeout(id); },
        setInterval: function (fn, ms) { return setInterval(fn, ms); },
        clearInterval: function (id) { return clearInterval(id); }
    };

    /**
     * The load policy both stats pages share. It owns `phase` ('loading' until a load settles,
     * then 'ready'), `result` (what the last load settled on) and `resultRange` (the range it was
     * for); the page reads them to render. Options:
     *   contentKind — the result kind that draws something ('clock', 'chart'): a failed refresh
     *                 over it stays calm, keeping it on screen;
     *   canLoad()   — false until both the host's state and settings have arrived;
     *   range()     — the range setting now; initialRange — resultRange before any load;
     *   load(range, now, isCurrent) — one load, a promise; isCurrent() turns false once a newer
     *                 load (or a range change) supersedes it;
     *   onLoading() — the page's own resets on going back to loading (hover), before render();
     *   render(); refreshMs, retryMs, settingsReloadMs; now() (default new Date()); timers.
     * A failure the page can do nothing about is said at once; a passing one (failure().retry)
     * is retried after retryMs. Too old is said whatever is showing.
     */
    function loadController(o) {
        var timers = o.timers || GLOBAL_TIMERS;
        var now = o.now || function () { return new Date(); };
        var token = 0;
        var retryTimer = null, settingsReloadTimer = null, midnightTimer = null, refreshTimer = null;
        var c = { phase: 'loading', result: null, resultRange: o.initialRange };

        function clearPending() {
            if (retryTimer) { timers.clearTimeout(retryTimer); retryTimer = null; }
            if (settingsReloadTimer) { timers.clearTimeout(settingsReloadTimer); settingsReloadTimer = null; }
        }

        function settle(result, range) {
            c.result = result;
            c.resultRange = range;
            c.phase = 'ready';
            o.render();
        }

        c.showLoading = function () {
            token++;
            c.phase = 'loading';
            c.result = null;
            if (o.onLoading) o.onLoading();
            o.render();
        };

        c.reload = function (showLoadingFirst) {
            if (!o.canLoad()) return;
            clearPending();
            if (showLoadingFirst || c.phase !== 'ready') c.showLoading();
            var mine = ++token;
            var range = o.range();
            Promise.resolve(o.load(range, now(), function () { return mine === token; })).then(function (next) {
                if (mine !== token) return;   // a newer load superseded this one
                settle(next, range);
            }, function (error) {
                if (mine !== token) return;
                var failed = failure(error);
                // Calm: a refresh that fails keeps the drawing on screen; only a load with
                // nothing to show says so. Too old is said at once, whatever is showing.
                if (failed.kind === 'tooOld' || !(c.result && c.result.kind === o.contentKind)) settle({ kind: failed.kind }, range);
                if (failed.retry) retryTimer = timers.setTimeout(function () { retryTimer = null; c.reload(false); }, o.retryMs);
            });
        };

        /**
         * After the page normalised a settings push: `first` is the host's first push (the first
         * load was waiting for it), `rangeChanged` whether the range moved. A new range
         * invalidates what is on screen — back to loading at once — and a run of changes loads
         * once, when it settles; anything else only repaints.
         */
        c.settingsChanged = function (first, rangeChanged) {
            if (!o.canLoad()) { o.render(); return; }
            if (first) { c.reload(true); return; }
            if (!rangeChanged) { o.render(); return; }
            c.showLoading();
            if (settingsReloadTimer) timers.clearTimeout(settingsReloadTimer);
            settingsReloadTimer = timers.setTimeout(function () {
                settingsReloadTimer = null;
                c.reload(false);
            }, o.settingsReloadMs);
        };

        /** After a state push: the first one may start the first load; statechange fires on every
         * position tick, so a later one renders only when what the page writes (`changed`) moved. */
        c.stateChanged = function (first, changed) {
            if (first && o.canLoad()) { c.reload(true); return; }
            if (first || changed) o.render();
        };

        // Today is the range's last day, so it moves at local midnight.
        function scheduleMidnight() {
            if (midnightTimer) timers.clearTimeout(midnightTimer);
            midnightTimer = timers.setTimeout(function () {
                midnightTimer = null;
                c.reload(false);
                scheduleMidnight();
            }, msUntilNextMidnight(now()));
        }

        /** The periodic refresh and the midnight one. */
        c.startSchedule = function () {
            if (refreshTimer) timers.clearInterval(refreshTimer);
            refreshTimer = timers.setInterval(function () { c.reload(false); }, o.refreshMs);
            scheduleMidnight();
        };

        return c;
    }

    /**
     * Hooks a page to the host: listens for settings, state, theme and pointer events, runs
     * `beforeReplay` (resize setup), replays the host's current settings then state, runs
     * `started` (the refresh schedule), then signals ready. False without a host.
     */
    function connectHost(nt, h) {
        if (!nt) return false;
        ['settingschange', 'statechange', 'themechange', 'pointermove', 'pointerleave'].forEach(function (event) {
            nt.on(event, h[event]);
        });
        if (h.beforeReplay) h.beforeReplay();
        h.settingschange(nt.settings);
        h.statechange(nt.state);
        if (h.started) h.started();
        if (nt._signalReady) nt._signalReady();
        return true;
    }

    return {
        pad2: pad2, startOfDay: startOfDay, addDays: addDays, dayKey: dayKey,
        msUntilNextMidnight: msUntilNextMidnight, timeZoneKey: timeZoneKey,
        RANGE_DAYS: RANGE_DAYS, parseSince: parseSince, rangeWindow: rangeWindow,
        hasHistory: hasHistory, failure: failure,
        STRINGS: STRINGS, LANGUAGES: LANGUAGES, pickLanguage: pickLanguage, strings: strings,
        formatNumber: formatNumber, formatDay: formatDay, formatHour: formatHour, formatHourCompact: formatHourCompact,
        formatTwoDigits: formatTwoDigits, formatDuration: formatDuration,
        formatDurationCompact: formatDurationCompact, playsText: playsText,
        rangeCaption: rangeCaption, statusText: statusText,
        isHexColor: isHexColor, hexToRgb: hexToRgb, normalizeSettings: normalizeSettings,
        appAccent: appAccent, systemBlue: systemBlue, accentTarget: accentTarget,
        accentPainter: accentPainter, loadController: loadController, connectHost: connectHost
    };
});
