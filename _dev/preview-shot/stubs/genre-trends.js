// Canned listening history for the Genre Trends preview, installed right after the injected API:
// a believable week across eight genres — one rising, one fading, the rest wandering — the same on
// every run. The top five are drawn by name and the last three make up Other. Nothing is hovered:
// the preview shows every band at full colour with its name written on it.
// `__previewReady` holds the shot until the chart is drawn.
(function () {
  window.__previewReady = false;
  var FIXED = new Date(2026, 9, 2, 12).getTime(), RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(FIXED); else super(...args); }
    static now() { return FIXED; }
  }
  window.Date = FixedDate;

  var week = {
    'Electronic':  [12, 14, 9, 16, 18, 22, 19],
    'Indie Rock':  [15, 11, 13, 10, 12, 8, 9],
    'Hip-Hop':     [4, 6, 9, 8, 11, 13, 15],
    'Jazz':        [8, 9, 6, 5, 6, 4, 7],
    'Soul':        [6, 5, 7, 8, 5, 6, 4],
    'Ambient':     [3, 4, 2, 4, 2, 3, 4],
    'Classical':   [2, 3, 1, 3, 3, 2, 4],
    'Metal':       [2, 1, 2, 1, 2, 2, 1]
  };
  var first = new Date(2026, 8, 26).getTime();
  window.NepTunes.history = {
    info: function () { return Promise.resolve({ since: '2026-01-01T00:00:00Z', plays: 4000 }); },
    query: function (q) {
      if (q.groupBy !== 'genre') return Promise.resolve({ rows: [{ plays: 100, seconds: 0 }] });
      var from = new Date(q.from);
      var i = Math.round((new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime() - first) / 86400000);
      return Promise.resolve({ rows: Object.keys(week).map(function (genre) {
        return { genre: genre, plays: week[genre][Math.max(0, Math.min(6, i))], seconds: 0 };
      }) });
    }
  };

  var poll = setInterval(function () {
    var card = document.getElementById('widget');
    if (!card || card.dataset.kind !== 'chart') return;
    clearInterval(poll);
    window.__previewReady = true;
  }, 50);
})();
