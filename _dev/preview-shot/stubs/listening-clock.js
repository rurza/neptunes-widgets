// Canned listening history for the Listening Clock preview, installed right after the injected
// API: a believable month of listening by hour — quiet small hours, a lunchtime bump, the evening
// peak — the same on every run. Nothing is hovered: the preview shows the clock as it rests, the
// peak hour in the middle. `__previewReady` holds the shot until the clock is drawn.
(function () {
  window.__previewReady = false;
  var FIXED = new Date(2026, 9, 2, 12).getTime(), RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(FIXED); else super(...args); }
    static now() { return FIXED; }
  }
  window.Date = FixedDate;

  var plays = [9, 4, 2, 1, 0, 0, 2, 11, 19, 16, 12, 14, 24, 18, 13, 15, 20, 27, 31, 36, 44, 52, 38, 17];
  window.NepTunes.history = {
    info: function () { return Promise.resolve({ since: '2026-01-01T00:00:00Z', plays: 4000 }); },
    query: function () {
      return Promise.resolve({ rows: plays.map(function (p, hour) { return { hour: hour, plays: p, seconds: p * 215 }; }) });
    }
  };

  var poll = setInterval(function () {
    var card = document.getElementById('widget');
    if (!card || card.dataset.kind !== 'clock') return;
    clearInterval(poll);
    window.__previewReady = true;
  }, 50);
})();
