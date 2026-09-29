// Canned listening history for the Activity preview, installed right after the injected API: a
// believable seven weeks — busier weekends, a quiet stretch, a few silent days — the same on
// every run. The clock is pinned to a Saturday — the last day of the week in en-US, the locale
// the preview is staged in — so the grid is a full square, and once the grid is drawn one day
// is hovered, so the preview shows the callout too. `__previewReady` holds the shot until then.
(function () {
  window.__previewReady = false;
  var FIXED = new Date(2026, 8, 26, 12).getTime(), RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(FIXED); else super(...args); }
    static now() { return FIXED; }
  }
  window.Date = FixedDate;

  var pattern = [3, 0, 5, 8, 2, 12, 16, 4, 6, 0, 9, 11, 14, 20, 2, 5, 7, 0, 3, 18, 22, 6, 1, 4, 9,
                 13, 17, 25, 0, 0, 2, 7, 10, 15, 19, 5, 8, 3, 6, 12, 21, 24, 4, 9, 11, 16, 14, 3, 7];
  function key(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  window.NepTunes.history = {
    info: function () { return Promise.resolve({ since: '2026-01-01T00:00:00Z', plays: 4000 }); },
    query: function (q) {
      var rows = [], from = new Date(q.from), to = new Date(q.to), i = 0;
      for (var d = new Date(from.getFullYear(), from.getMonth(), from.getDate()); d < to;
           d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1), i++) {
        rows.push({ date: key(d), plays: pattern[i % pattern.length], seconds: 0 });
      }
      return Promise.resolve({ rows: rows });
    }
  };

  var poll = setInterval(function () {
    var card = document.getElementById('widget');
    if (!card || card.dataset.kind !== 'grid') return;
    clearInterval(poll);
    // The preview is of a full seven-by-seven square. A cell that is outside the window (a
    // clock that is not the last day of the week) or has no count would ship a grid with a
    // hole in it, so the shot fails instead: the reason is reported and it is never ready.
    var cells = document.querySelectorAll('.cell');
    var lit = Array.prototype.filter.call(cells, function (c) { return /\blevel-\d\b/.test(c.className); });
    if (cells.length !== 49 || lit.length !== 49) {
      window.__previewError = 'the grid is not a full 7×7 square: ' + lit.length + ' of ' + cells.length + ' cells are days with a count';
      return;
    }
    var r = document.querySelector('.cell[data-index="32"]').getBoundingClientRect();
    window.NepTunes._emit('pointermove', { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    window.__previewReady = true;
  }, 50);
})();
