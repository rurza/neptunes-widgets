/* CD Case — the playing album as a real CD in a jewel case.

   Models (both CC-BY, see manifest description / README):
     case  "Hypnagogia Boundless Dreams Jewel Case" by sodaraptor
     disc  "CD" by Regex

   Host constraints this file is written against, all verified:
     - no fetch and no XHR on bundle files (opaque file: origin), so three.js
       and the models are classic <script> includes and the GLBs arrive as
       base64 in models.js, parsed straight from an ArrayBuffer
     - no ES modules, no Web Workers from the bundle
     - no console and no Web Inspector, so failures surface in #err
     - window.NepTunes.state is null until the host's first push, which lands
       AFTER DOMContentLoaded, so nothing may read state at init
     - artworkData is RAW base64 with no data: prefix; getArtworkDataURL()
       is what makes it usable, and it is omitted from pushes when unchanged
     - WebKit freezes rAF whenever the widget is occluded, which at desktop
       level is most of the time, so all motion is derived from wall-clock
       time and never accumulated per frame
*/
(function () {
  'use strict';

  /* ===================== the track-change reveal =====================

     A sleeve must never change while you are looking at it. So the case turns
     one full lap on a track change and each printed face is repainted only
     while it is hidden, which is what makes the new artwork already be there
     when that face swings back into view.

     Deciding WHEN a face may be repainted needs no scene, so it does not have
     one: these are handed the case's FACING (cos of its yaw, +1 dead square,
     -1 turned right round) and hand back the faces that may be redrawn now.
     That is the only reason the two bugs they replace are covered by tests.

       - The lap does not always start square on. Scroll the case round to its
         back and change track and the old code repainted the back on its very
         first frame, with the back filling the window: it assumed the front
         was the face you had been looking at, and at 180 degrees it is not.

       - Artwork can land after the back has already been repainted. Nothing
         ever repainted it again, not the front's swap half a lap later and not
         the end of the lap, so the back kept the previous track's blurred
         cover and the previous track's title until some later track change
         happened to redraw it.

     Both come out of one idea, which is now the whole of the rule: a face may
     be repainted whenever it is hidden, and must be whenever what it is
     wearing is out of date. Earliest safe moment rather than latest, so a
     dropped frame cannot miss the window and a late sleeve is picked up by
     every face that has not yet come back round. */

  var TURN = 1.15;               // seconds for the lap
  /* |facing| under this and the face is 85 degrees off: a few pixels of
     grazing edge, and nothing redrawn there can be seen changing. */
  var EDGE_ON = 0.08;

  function easeInOut(k) {
    return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  }

  /* Travel = the correction to square, PLUS a whole turn, in one direction.

     Easing from `start` to 2*PI looks like one sweep but is short: starting at
     +0.5 rad it travels only 331 degrees, so it never actually completes a
     turn. Going the way that passes through square first and then carries on a
     full lap gives 2*PI + |start| every time, monotonic, no reversal. */
  function lapAngle(start, e) {
    var dir = start > 0 ? -1 : 1;
    return start + e * (dir * Math.PI * 2 - start);
  }

  /* Which printed faces are both out of date and out of sight. `wearing` holds
     the sleeve each face was last painted from, `seq` the one on the case now.
     Order is fixed so the work, and the test, are deterministic. */
  function facesToPaint(facing, wearing, seq) {
    var out = [];
    if (wearing.back !== seq && facing > -EDGE_ON) out.push('back');
    if (wearing.front !== seq && facing < EDGE_ON) out.push('front');
    return out;
  }

  /* ===================== the back panel's two axes =====================

     The case's UVs are not square, and the printed back's are further from
     square than the front's. Measured off the shipped model: the flat back
     panel is 63.144 x 55.624 units (142 x 125mm, a jewel case exactly) and its
     UVs span 0.7888 of the wrap across and 0.9990 down. So one u is about 1.39
     v, and the wrap it is all printed into is 1698x1000.

     Which means a canvas pixel lands on the case NARROWER than it is tall:
     0.0455 units across against 0.0557 down. So anything drawn square into
     that canvas prints at 82% of its width, which is what had the title
     looking condensed.

     The FRONT had the same bug and it was found years earlier: a cover that
     looked squashed, fixed by reshaping the rect it is drawn in (CASE_SQUEEZE
     and BOOKLET, below). A rect cannot fix the back, because what the back
     carries is TYPE: a title in a rect of the wrong shape is not cropped, it
     is condensed. So the type is set in square units and stretched into the
     wrap's own on the way out. */
  var BACK_PANEL = { wide: 63.144, tall: 55.624, u: 0.7888, v: 0.9990 };

  /* The factor that undoes that, for a wrap of w x h: how much wider than
     square the horizontal axis has to be drawn, which is 1.2236 for the
     1698x1000 wrap the back ships with. Multiply the horizontal axis by it and
     a letter comes out on the case the shape it was drawn. `squeeze` is
     CASE_SQUEEZE, which narrows the whole case and so the panel with it. */
  function backStretch(w, h, squeeze) {
    var perU = BACK_PANEL.wide * squeeze / BACK_PANEL.u;
    var perV = BACK_PANEL.tall / BACK_PANEL.v;
    return (perV * w) / (perU * h);
  }

  /* What to do with a sleeve that has just arrived.

     Artwork is not the only way one arrives: a track with no artwork at all and
     a track whose bytes will not decode both produce a drawn placeholder, and a
     placeholder is just as much a change to a face you may be looking at. All
     three go through here, so none of them can put a sleeve on the case at a
     moment the lap is busy hiding one.

       'hold'   a lap is running and will reveal it at its next hidden moment.
                Putting it on now shows the change AND leaves the lap's own
                pending sleeve to overwrite it a moment later.
       'reveal' a change is armed but nothing is turning yet: hold it and start
                the lap, so the swap happens out of sight.
       'adopt'  nothing on screen to protect, or nothing coming that would hide
                the change. Put it on.

     Positional arguments rather than a named bag: the callers build these at
     three separate sites, and one misspelt key on an object literal would mean
     a silent 'adopt' for every sleeve, which is the bug this prevents. */
  function sleeveArrival(hasAlbum, turning, armed) {
    if (!hasAlbum) return 'adopt';
    if (turning) return 'hold';
    if (armed) return 'reveal';
    return 'adopt';
  }

  /* Where "Open the case when paused" should put the lid on a state push.

     The lid is also driven by hand: clicking the case toggles it. Deriving the
     pose from every push therefore threw that away, because the host pushes
     state roughly once a second while anything plays — so a case clicked open
     shut again within the second and read as a widget that refuses to open.

     The setting describes what PAUSING does, so it acts on the play/pause
     transition and leaves whatever pose you chose alone in between. `was` is
     null before the first push and while the setting is being switched on, so
     that both land the pose immediately rather than waiting for a transition
     that may be a whole album away.

     Returns the new lid target, or null to leave the lid where it is. */
  function lidPoseOnState(openOnPause, playing, was) {
    if (!openOnPause) return null;
    if (playing === was) return null;
    return playing ? 0 : 1;
  }

  /* ===== the printed back's type =====

     The back carries a title, an album and an artist, and no track list, so a
     long title IS the composition. Two decisions keep it from becoming a wall
     of bold, and both are pure so they can be tested away from a canvas.

     They take a `measure(text, size)` rather than a context for the same
     reason: the arithmetic is the part that goes wrong, and it goes wrong the
     same way whatever face is measuring. */

  /* What a label tacks on the end of a title: the reason a title is long is
     almost always one of these, not the song's actual name. */
  var QUALIFIER = /(remaster|remix|re-?record|version|edit\b|\bmix\b|live\b|mono|stereo|instrumental|acoustic|unplugged|demo\b|radio|single|deluxe|bonus|reprise|take \d|feat\.|featuring|\b(19|20)\d{2}\b)/i;

  /* Take that qualifier off the title so it can be set smaller underneath,
     which is how every player shows it anyway. Nothing is dropped: the suffix
     is printed, one step down the hierarchy.

     A trailing bracket group is unambiguous and comes off whatever it says. A
     dash is not: "Bohemian Rhapsody - Remastered 2011" is a title plus a
     label's note and "Jekyll - Hyde" is a title, and nothing in the string
     says which, so the tail has to read as a qualifier before it is demoted.
     A title that is nothing BUT a bracket group, or led by one ("(I Can't Get
     No) Satisfaction"), is left exactly as it is. */
  function splitTitleSuffix(title) {
    var t = String(title == null ? '' : title).trim();
    var m = t.match(/^(.*\S)\s*([(\[][^()\[\]]*[)\]])$/);
    if (m && m[1].length >= 3) return { main: m[1], suffix: m[2] };
    m = t.match(/^(.*\S)\s+[-–—]\s+(\S.*)$/);
    if (m && m[1].length >= 3 && QUALIFIER.test(m[2])) return { main: m[1], suffix: m[2] };
    return { main: t, suffix: '' };
  }

  /* Greedy wrap, unbounded. Words first, and characters when a word is wider
     than the column on its own: a Japanese title has no spaces anywhere in it,
     and a wrap that can only break on one prints a single line straight off
     the edge of the case. */
  function wrapAll(measure, text, maxW, size) {
    var words = String(text).split(/\s+/).filter(Boolean);
    var lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (cur && measure(cur + ' ' + w, size) <= maxW) { cur += ' ' + w; continue; }
      if (cur) { lines.push(cur); cur = ''; }
      while (w.length > 1 && measure(w, size) > maxW) {
        var n = 1;
        while (n < w.length && measure(w.slice(0, n + 1), size) <= maxW) n++;
        lines.push(w.slice(0, n));
        w = w.slice(n);
      }
      cur = w;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function titleLines(measure, text, maxW, size) {
    return wrapAll(measure, text, maxW, size).length;
  }

  /* The same wrap, cut to `maxLines`. What is left over is marked rather than
     dropped: silently binning the tail is how "feat. Dennis" once became
     "Dennis Dennis", and the back is the only place the full title is set. */
  function wrapTitle(measure, text, maxW, size, maxLines) {
    var lines = wrapAll(measure, text, maxW, size);
    if (lines.length <= maxLines) return lines;
    lines = lines.slice(0, maxLines);
    var last = lines[maxLines - 1];
    while (last.length > 1 && measure(last + '…', size) > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = last.replace(/[\s,(\[\-]+$/, '') + '…';
    return lines;
  }

  /* The largest size at which the title still lands inside `maxLines`. At one
     fixed size a three-word title and a fifty-character one are set identically
     and only the second fills the panel edge to edge, twice over. Shrinking is
     bounded: below `lo` the title stops being the loudest thing on the back, so
     the floor holds and the extra line is drawn instead. */
  function fitTitleSize(measure, text, maxW, maxLines, hi, lo) {
    for (var s = hi; s > lo; s *= 0.94) {
      if (titleLines(measure, text, maxW, s) <= maxLines) return s;
    }
    return lo;
  }

  var PURE = {
    TURN: TURN, EDGE_ON: EDGE_ON,
    easeInOut: easeInOut, lapAngle: lapAngle, facesToPaint: facesToPaint,
    BACK_PANEL: BACK_PANEL, backStretch: backStretch,
    sleeveArrival: sleeveArrival, lidPoseOnState: lidPoseOnState,
    splitTitleSuffix: splitTitleSuffix, titleLines: titleLines,
    wrapTitle: wrapTitle, fitTitleSize: fitTitleSize
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = PURE;
  if (typeof window === 'undefined') return;

  var THREE = window.NT3D && window.NT3D.THREE;
  var GLTFLoader = window.NT3D && window.NT3D.GLTFLoader;
  var RoomEnvironment = window.NT3D && window.NT3D.RoomEnvironment;

  var errEl = document.getElementById('err');
  var emptyEl = document.getElementById('empty');
  var emptyText = document.getElementById('emptyText');
  var canvas = document.getElementById('gl');

  function guard(what, fn) {
    return function () {
      try { return fn.apply(this, arguments); }
      catch (e) { fail(what, e); }
    };
  }

  function fail(what, e) {
    errEl.hidden = false;
    errEl.textContent = what + '\n' + ((e && (e.stack || e.message)) || e || '');
  }
  window.addEventListener('error', function (ev) { fail('error', ev.error || ev.message); });
  window.addEventListener('unhandledrejection', function (ev) { fail('rejection', ev.reason); });

  if (!THREE) { fail('three.js did not load'); return; }

  /* ===================== settings ===================== */

  var opts = { caseSize: '320', idleMotion: false, discSpin: true, openOnPause: false,
               spinOnChange: true, hingeTint: true, quality: 'balanced' };

  function readSettings() {
    var s = (window.NepTunes && window.NepTunes.settings) || null;
    if (!s) return;
    if (typeof s.idleMotion === 'boolean') opts.idleMotion = s.idleMotion;
    if (typeof s.hingeTint === 'boolean' && s.hingeTint !== opts.hingeTint) {
      opts.hingeTint = s.hingeTint;
      recompositeTray();               // the tray wrap is baked; it has to be redrawn
    }
    if (typeof s.discSpin === 'boolean') opts.discSpin = s.discSpin;
    if (typeof s.openOnPause === 'boolean' && s.openOnPause !== opts.openOnPause) {
      opts.openOnPause = s.openOnPause;
      lastPlaying = null;              // re-arm: the new setting takes effect on the next push
    }
    if (typeof s.spinOnChange === 'boolean') opts.spinOnChange = s.spinOnChange;
    if (typeof s.quality === 'string') opts.quality = s.quality;
    if (typeof s.caseSize === 'string' && s.caseSize !== opts.caseSize) {
      opts.caseSize = s.caseSize;
      applyCaseSize();
    }
    applyQuality();
  }

  // Framerate is not the place to save power here: a choppy object reads as
  // broken. High and Balanced both run at the display's own rate and differ
  // only in resolution; Battery saver is the one that throttles, and the loop
  // already stops entirely when nothing is moving.
  /* dpr above the display's own ratio is supersampling: the frame is rendered
     larger and downsampled, which is what actually cleans up the case's thin
     plastic rails. MSAA alone leaves them crawling at widget sizes. */
  /* 60 is the cap, not the display's rate. On a 120Hz panel, uncapped doubles
     the per-second cost of a transparent-window composite for motion that is a
     slow drift — there is nothing in this scene moving fast enough to read the
     difference. dpr above the display ratio is supersampling, which is what
     actually cleans up the case's thin plastic rails. */
  var QUALITY = {
    high: { dpr: 2.5, fps: 60 },
    balanced: { dpr: 2, fps: 60 },
    low: { dpr: 1.25, fps: 30 }
  };
  function quality() { return QUALITY[opts.quality] || QUALITY.balanced; }

  /* Size is the window's size, not a zoom: the case always fills its window, so
     resizing the window is what makes the artwork bigger. Height follows the
     case's own proportions so it never letterboxes. */
  function applyCaseSize() {
    var w = parseInt(opts.caseSize, 10);
    if (!w || !window.NepTunes || !window.NepTunes.setSize) return;
    // The case's own ratio, after the squeeze: 60.95 x 55.62 units. Getting
    // this wrong only costs transparent window, but transparent window is what
    // steals clicks from whatever sits behind the widget.
    window.NepTunes.setSize(w, Math.round(w / 1.0958));
  }

  /* ===================== renderer ===================== */

  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  renderer.setClearAlpha(0);
  /* ACES with a little exposure, dialled in against the source JPEG side by
     side rather than derived. A straight-on key this bright would clip the
     highlights of any light sleeve without a roll-off; ACES compresses them
     instead, which is why it beat both NoToneMapping and Neutral by eye. */
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.11;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  var scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.03).texture;

  /* Rig tuned against the untouched source JPEG shown alongside the render.

     The key is straight-on (X = 0) and bright, with the environment nearly off:
     a raking key and a strong ambient wash both flatten the sleeve and pull it
     away from the file. Numbers are from the tuner, not from theory. */
  var key = new THREE.DirectionalLight(0xffffff, 1.09);
  key.position.set(0.00, 1.40, 2.35);
  scene.add(key);

  var warm = new THREE.DirectionalLight(0xffffff, 1.15);
  warm.position.set(1.2, -0.3, 1.4);
  scene.add(warm);
  scene.environmentIntensity = 0.09;

  var camera = new THREE.PerspectiveCamera(24, 1, 0.01, 8000);
  var tilt = new THREE.Group();
  scene.add(tilt);


  function applyQuality() {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality().dpr));
    resize();
  }

  function resize() {
    // The CANVAS's box, not the window's. In the widget they are the same
    // thing; in a tuner the canvas is a fixed widget-sized panel inside a
    // larger window, and taking the window's aspect renders it squashed.
    var w = canvas.clientWidth || window.innerWidth;
    var h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (built) frame();
    invalidate();
  }
  window.addEventListener('resize', resize);

  /* ===================== artwork ===================== */

  var album = null;          // HTMLCanvasElement, square, the current cover
  var dom = [130, 130, 140]; // dominant colour of THAT cover
  var domCSS = 'rgb(130,130,140)';
  var avg = [110, 110, 120];
  var meta = {
    album: '', artist: '', title: '', player: '',
    duration: 0, posSeed: 0, posAt: 0     // position is a SEED, not a ticking value
  };

  // The host only broadcasts playerPosition on track change, play/pause, seek
  // or a drift resync, so rendering it directly gives a frozen bar. Extrapolate
  // from the seed and the timestamp that came with it.
  function elapsed(now) {
    if (!meta.posAt) return 0;
    var e = meta.posSeed + (playing ? (now - meta.posAt) / 1000 : 0);
    return meta.duration ? Math.max(0, Math.min(meta.duration, e)) : Math.max(0, e);
  }
  function clock(sec) {
    sec = Math.max(0, Math.floor(sec));
    var m = Math.floor(sec / 60), s2 = sec % 60;
    return m + ':' + (s2 < 10 ? '0' : '') + s2;
  }

  // One place that decides the working colour space for every canvas we make.
  function ctx2d(canvas) {
    var g = null;
    try { g = canvas.getContext('2d', { colorSpace: 'srgb' }); } catch (e) { g = null; }
    return g || canvas.getContext('2d');
  }

  /* Not every track has artwork: the permission can be absent, the player can
     have none, and a lookup can fail. Without a sleeve nothing gets composited
     and the model's ORIGINAL game artwork stays on the case, which must never
     ship. So there is always a sleeve, even if we have to draw it. */
  function placeholderCover(title, artist) {
    var S = 1024;
    var c = document.createElement('canvas');
    c.width = c.height = S;
    var g = ctx2d(c);

    var bg = g.createLinearGradient(0, 0, S, S);
    bg.addColorStop(0, '#2b2f38');
    bg.addColorStop(1, '#14171d');
    g.fillStyle = bg;
    g.fillRect(0, 0, S, S);

    // a plain disc mark, so an empty sleeve still reads as a music sleeve
    g.strokeStyle = 'rgba(255,255,255,.13)';
    g.lineWidth = S * 0.008;
    g.beginPath(); g.arc(S / 2, S * 0.42, S * 0.20, 0, 7); g.stroke();
    g.beginPath(); g.arc(S / 2, S * 0.42, S * 0.062, 0, 7); g.stroke();

    g.textAlign = 'center';
    g.fillStyle = 'rgba(255,255,255,.82)';
    g.font = '600 ' + (S * 0.058) + 'px -apple-system, sans-serif';
    var t = String(title || 'Unknown');
    while (t.length > 1 && g.measureText(t).width > S * 0.84) t = t.slice(0, -1);
    g.fillText(t === String(title || 'Unknown') ? t : t + '…', S / 2, S * 0.74);

    if (artist) {
      g.fillStyle = 'rgba(255,255,255,.45)';
      g.font = '500 ' + (S * 0.038) + 'px -apple-system, sans-serif';
      var a = String(artist);
      while (a.length > 1 && g.measureText(a).width > S * 0.84) a = a.slice(0, -1);
      g.fillText(a === String(artist) ? a : a + '…', S / 2, S * 0.80);
    }
    return c;
  }

  /* A sleeve that has arrived supersedes anything still waiting to be shown.

     Clearing pendingAlbum here is the whole of the stale-cover bug. This used
     to set `album` and leave the pending one alone, so a reveal already in
     flight would reach its swap point and overwrite the sleeve it had just
     been handed with the PREVIOUS track's. Skipping tracks faster than the
     1.15s lap is all it took, and it looked random because it depended on
     where in the lap the second track landed. */
  /* The one door every sleeve comes in by, decoded or drawn. See sleeveArrival
     at the top of the file for which of the three it is and why. */
  function offerSleeve(sleeve) {
    switch (sleeveArrival(!!album, phase === PHASE_TURN, turnArmed)) {
      case 'hold':   pendingAlbum = sleeve; break;
      case 'reveal': pendingAlbum = sleeve; fireTurn(); break;
      default:       adoptSleeve(sleeve);
    }
    invalidate();
  }

  function adoptSleeve(canvasEl) {
    pendingAlbum = null;
    album = canvasEl;
    albumSeq++;
    printSeq++;
    blurCache = null;
    blurCacheKey = null;
    dom = dominantOf(album);
    domCSS = css(dom);
    avg = meanOf(album, 97);
    recomposite();
  }

  function squareCanvas(img) {
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    var side = Math.max(iw, ih) || 1024;
    var c = document.createElement('canvas');
    c.width = c.height = side;
    var g = ctx2d(c);
    var sc = Math.max(side / iw, side / ih);   // cover-fit: crop, never squash
    g.drawImage(img, (side - iw * sc) / 2, (side - ih * sc) / 2, iw * sc, ih * sc);
    return c;
  }

  function meanOf(cv, step) {
    var d = ctx2d(cv).getImageData(0, 0, cv.width, cv.height).data;
    var r = 0, g = 0, b = 0, n = 0;
    for (var i = 0; i < d.length; i += 4 * step) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    return [r / n, g / n, b / n];
  }

  // Saturation-weighted, because a plain mean of any cover comes out mud.
  function dominantOf(cv) {
    var d = ctx2d(cv).getImageData(0, 0, cv.width, cv.height).data;
    var r = 0, g = 0, b = 0, w = 0;
    for (var i = 0; i < d.length; i += 4 * 31) {
      var R = d[i] / 255, G = d[i + 1] / 255, B = d[i + 2] / 255;
      var mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      var k = (mx - mn) * (mx - mn) * (0.35 + mx) + 0.015;
      r += R * k; g += G * k; b += B * k; w += k;
    }
    return [r / w * 255, g / w * 255, b / w * 255];
  }

  function css(c) { return 'rgb(' + c.map(function (v) { return Math.round(v); }).join(',') + ')'; }

  /* Regions of the case wraps, normalised against the source textures
     (1698x1000). BACK_ALL is the full printed back; HINGE is the tray column
     where a real booklet's folded edge shows. The FRONT's regions are not
     here: they come from the model's own geometry further down, which is the
     only place they were ever going to be right. */
  var BACK_ALL = { x0: 0.1207, y0: 0.0180, x1: 0.9011, y1: 0.9820 };
  // Inset a normal print margin from BACK_ALL. This used to start at 0.29 to
  // clear a painted spine band; that band is gone now that the artwork runs
  // continuously across the back, so the old inset was just dead left margin.
  var BACK_TEXT = { x0: 0.1550, y0: 0.0180, x1: 0.8750, y1: 0.9820 };
  var HINGE = { x0: 0.1120, y0: 0.0250, x1: 0.1760, y1: 0.9750 };

  /* Composite at the source wrap's own resolution. The wraps are 2048 and the
     artwork is ~600px, so a larger canvas adds no detail — only a bigger
     canvas to draw, a bigger blur, and a bigger mipmapped texture upload. */
  var COMPOSITE_SCALE = 1, COMPOSITE_MAX = 2048;

  // A canvas sized off the source image, scaled up so the album art is not
  // resampled down into a small print area and back up again on screen.
  function surfaceFor(src) {
    var sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight;
    var w = Math.min(COMPOSITE_MAX, Math.round(sw * COMPOSITE_SCALE));
    var h = Math.round(w * sh / sw);
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = ctx2d(c);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, w, h);
    return { canvas: c, g: g, w: w, h: h };
  }

  function rectIn(r, w, h) {
    return { x: r.x0 * w, y: r.y0 * h, w: (r.x1 - r.x0) * w, h: (r.y1 - r.y0) * h };
  }

  var blurCache = null, blurCacheKey = null;
  /* Identity, not dimensions. Every sleeve is 600x600, so keying the blur cache
     on size alone matches ANY two covers and hands back the previous album's
     blur — which is exactly how a stale strip ends up beside a fresh cover. */
  var albumSeq = 0;

  /* A real separable box blur over pixel data.

     Two approaches do NOT work here. `ctx.filter = 'blur()'` is silently
     ignored by this host, failing without throwing. And downscale-then-upscale
     leaves the image blocky: reaching a useful radius means falling to a few
     dozen pixels, and magnifying that back up 20x shows every one of them —
     which is what the previous three attempts were doing. An earlier version
     also drew a canvas onto ITSELF to soften it, which blurs nothing.

     Three box passes approximate a Gaussian closely. Done at a fixed working
     size it is cheap, and the result is genuinely smooth, so the final upscale
     has no hard edges left to magnify. */
  function boxBlurData(data, w, h, r) {
    var tmp = new Uint8ClampedArray(data.length);
    var i, x, y, c, sum, idx, count;

    for (y = 0; y < h; y++) {
      for (c = 0; c < 4; c++) {
        sum = 0; count = 0;
        for (x = -r; x <= r; x++) {
          idx = Math.min(w - 1, Math.max(0, x));
          sum += data[(y * w + idx) * 4 + c]; count++;
        }
        for (x = 0; x < w; x++) {
          tmp[(y * w + x) * 4 + c] = sum / count;
          var add = Math.min(w - 1, x + r + 1), rem = Math.max(0, x - r);
          sum += data[(y * w + add) * 4 + c] - data[(y * w + rem) * 4 + c];
        }
      }
    }
    for (x = 0; x < w; x++) {
      for (c = 0; c < 4; c++) {
        sum = 0; count = 0;
        for (y = -r; y <= r; y++) {
          idx = Math.min(h - 1, Math.max(0, y));
          sum += tmp[(idx * w + x) * 4 + c]; count++;
        }
        for (y = 0; y < h; y++) {
          data[(y * w + x) * 4 + c] = sum / count;
          var addY = Math.min(h - 1, y + r + 1), remY = Math.max(0, y - r);
          sum += tmp[(addY * w + x) * 4 + c] - tmp[(remY * w + x) * 4 + c];
        }
      }
    }
  }

  function blurredCopy(src, strength) {
    var WORK = 320;                       // blur here, then upscale once
    var w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
    var w = WORK, h = Math.max(8, Math.round(WORK * h0 / w0));

    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = ctx2d(c);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, w, h);

    var r = Math.max(1, Math.round(w * strength));
    var img = g.getImageData(0, 0, w, h);
    boxBlurData(img.data, w, h, r);
    boxBlurData(img.data, w, h, r);
    boxBlurData(img.data, w, h, r);       // three passes ~= Gaussian
    g.putImageData(img, 0, 0);
    return c;
  }

  function drawCoverBlurred(g, box, radius) {
    // The back repaints about once a second while it faces the viewer; the blur
    // only depends on the artwork, so build it once per sleeve.
    var key = albumSeq + ':' + radius.toFixed(3);
    if (blurCacheKey !== key || !blurCache) {
      blurCache = blurredCopy(album, radius);
      blurCacheKey = key;
    }
    var small = blurCache;
    var s = Math.max(box.w / small.width, box.h / small.height);
    g.save();
    g.beginPath(); g.rect(box.x, box.y, box.w, box.h); g.clip();
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(small, box.x + (box.w - small.width * s) / 2,
                box.y + (box.h - small.height * s) / 2, small.width * s, small.height * s);
    g.restore();
  }

  // Fit the whole sleeve inside the box without cropping it, centred.
  /* The lid's printed face, and the booklet on it, taken out of the MODEL.

     Fitting a plane to the 72 front-facing triangles of ntsc_case_front gives
     a linear UV -> position map whose residual is 0.19mm, so the mapping is
     exactly affine and reduces to two numbers:

         85.293 model units per u        56.173 model units per v
         face = u 0.1712..0.8535, v 0..1   =   58.196 x 56.173 units

     The two axes are NOT the same scale — one u is 1.518 v — so a rect that is
     square in TEXTURE PIXELS renders 1.118x too NARROW on the case. That is
     the whole of the "cover is squashed" bug. The rect this replaces measured
     974 x 956 texture pixels: square on the texture, 0.897 of square on the
     case. The render measured 0.882.

     Four attempts to correct this by measuring the picture all failed, and
     were always going to: the number does not come from a picture. */
  /* The case is squeezed horizontally so that its printed face is SQUARE.

     As it ships, that face is 58.196 x 56.173 units — 130.9 x 126.3mm. A
     square cover as tall as the face is therefore always ~10mm narrower than
     it, and that 10mm has to be filled with something. Paper, plastic and a
     printed CD spine were all tried there and all of them read as a gap,
     because a gap is what it is: the face is the wrong shape for the artwork
     that goes in it.

     Taking the 10mm out of the case instead makes the face square, and the
     cover then sits in a frame of equal width on all four sides. The cost is
     that the case renders 137.4 x 125mm rather than a jewel case's 142 x 125.
     That is 3.5% narrower, on an object with nothing beside it to measure
     against. It also squares up the tray's disc well, which was the other
     place the model's proportions showed.

     Applied to the case at load rather than baked into the GLB: identical
     result, reversible in one line, and no chance of corrupting the model.
     The DISC is not squeezed — it is seated separately and scaled uniformly,
     because a CD is round. */
  var CASE_SQUEEZE = 56.173 / 58.196;                 // 0.96524

  var UNITS_PER_U = 85.293 * CASE_SQUEEZE, UNITS_PER_V = 56.173;
  var FRONT_FACE = { x0: 0.1712, y0: 0.0, x1: 0.8535, y1: 1.0 };

  /* The booklet: square, centred on the face, inset by the same margin on all
     four sides.

     The margin comes from the model, not from taste: it prints its own cover
     between v 0.022 and 0.978 and leaves the rest as the case's plastic frame.
     Now that the face is square (see CASE_SQUEEZE) the same margin applies
     across, so the frame is one even border and the artwork is a true square
     inside it. */
  var BOOKLET = (function () {
    var y0 = 0.0220, y1 = 0.9780;
    var inset = y0 * UNITS_PER_V / UNITS_PER_U;       // the same margin, in u
    return { x0: FRONT_FACE.x0 + inset, y0: y0, x1: FRONT_FACE.x1 - inset, y1: y1 };
  })();

  /* A block of paper leaves seen end-on: the booklet's folded spine, and the
     same thing that shows in the hinge. Near-white with only a hint of the
     sleeve's colour, fine leaf edges of varying weight, a shadow at the fold,
     and a little grain — the grain being what stops a large flat fill from
     banding. `foldRight` puts the fold shadow on the right, which is where the
     booklet meets its own cover. */
  /* Continue the case's own frame down the two sides of the cover.

     The model prints a plastic frame above and below its cover but not beside
     it: what it has there is the game's spine on one side and the last of the
     game's cover on the other, and both have to go. Rather than invent a
     colour for them, read the frame the model DOES draw — average the top band
     along its length to get its cross-section, then lay that ramp down each
     side. Three of the four edges are then literally the same pixels, so they
     cannot fail to match. */
  function paintSideFrame(g, f, bk) {
    var top = Math.round(bk.y - f.y);
    var x0 = Math.round(bk.x), ww = Math.round(bk.w);
    if (top < 2 || ww < 2) return;
    var ramp = [];
    try {
      var d = g.getImageData(x0, Math.round(f.y), ww, top).data;
      for (var row = 0; row < top; row++) {
        var r = 0, gg = 0, bb = 0, n = 0;
        for (var col = 0; col < ww; col += 3) {
          var i = (row * ww + col) * 4;
          r += d[i]; gg += d[i + 1]; bb += d[i + 2]; n++;
        }
        ramp.push('rgb(' + Math.round(r / n) + ',' + Math.round(gg / n) + ',' + Math.round(bb / n) + ')');
      }
    } catch (e) { return; }          // tainted or out of bounds: leave it alone

    // The ramp runs from the case's outer edge inward, so it is laid down each
    // side in the direction that matches.
    var sides = [[f.x, bk.x], [f.x + f.w, bk.x + bk.w]];
    for (var si = 0; si < 2; si++) {
      var outer = sides[si][0], inner = sides[si][1];
      var step = (inner - outer) / ramp.length;
      for (var k = 0; k < ramp.length; k++) {
        var xa = outer + step * k;
        g.fillStyle = ramp[k];
        g.fillRect(Math.min(xa, xa + step) - 0.5, bk.y, Math.abs(step) + 1.5, bk.h);
      }
    }
  }

  function compositeFront(src) {
    /* Keep the model's own wrap underneath. Clearing it left the lid with no
       substance at all: you could see the desktop between the disc and the
       case, and from behind the lid disappeared entirely. What is outside the
       front face is the case's edges and its wrap-around, which is exactly
       what should still be there. */
    var S = surfaceFor(src), c = S.canvas, g = S.g, w = S.w, h = S.h;

    /* The sleeve goes into the BOOKLET area, 1:1, filling it exactly.

       No contain, no cover, no fitting of any kind: the booklet area is square
       on the case and the sleeve is square, so it drops straight in. Everything
       that went wrong before came from fitting the sleeve to the whole 142x125
       FACE instead — that is 1.197:1, so it either cropped 17% off the top and
       bottom or left a 17% margin.

       BOOKLET is not a square rect in the texture, because the wrap's
       pixels-per-millimetre differ between the axes. Its width was measured by
       rendering a square and correcting until it came out square on screen. */
    var f = rectIn(FRONT_FACE, w, h);
    var bk = rectIn(BOOKLET, w, h);

    g.save();
    g.beginPath(); g.rect(f.x, f.y, f.w, f.h); g.clip();
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';


    /* Left of the booklet is the hinge side, and the model's console branding
       sits under it — logo, spine text, ratings box — which must never show.
       Covered with a ramp taken from the sleeve's own edge column: it matches
       at the seam, and has no horizontal detail to smear. */
    /* Left of the booklet is its folded spine — PAPER, the same stack of leaves
       that shows in the hinge. Every previous version filled this strip with a
       colour instead (a sampled bar, stretched edge pixels, a blur, a ramp) and
       every one of them read as a slab stuck beside the artwork, because a flat
       fill is not what is there. It also has to cover the console branding
       underneath it. */
    /* Only the two side margins are painted. Everything else on the face is
       the model's own wrap — the frame above and below the cover — and it
       stays. Blanket-filling the whole face is what turned the case into a
       picture with a white border. */
    paintSideFrame(g, f, bk);
    g.drawImage(album, bk.x, bk.y, bk.w, bk.h);
    g.restore();
    return c;
  }

  /* The back of the original model is an entire game back cover: screenshots,
     a blurb and a ratings box. All of it goes. The NepTunes API exposes only
     the CURRENT track, never the album's track listing, so there is no honest
     way to print a real one — the back carries the album and artist over a
     dimmed sleeve instead of a fabricated list. */
  function compositeBack(src, now) {
    var S = surfaceFor(src), c = S.canvas, g = S.g, w = S.w, h = S.h;

    var bg = rectIn(BACK_ALL, w, h);
    // Radius is set against the print width, not in raw pixels, so it looks the
    // same whatever the composite resolution or the widget's size.
    drawCoverBlurred(g, bg, 0.06);   // fraction of width, resolution independent
    /* Enough wash to hold white type over a blurred sleeve, and no more. At
       .62 the artwork behind it was nearly gone, which is a waste of the one
       place the album's own colour has the whole panel to itself. */
    g.fillStyle = 'rgba(6,8,14,.42)';
    g.fillRect(bg.x, bg.y, bg.w, bg.h);

    var b = rectIn(BACK_TEXT, w, h);
    /* Asymmetric, and deliberately so. The type is set ragged right, so an
       equal margin either side is not an equal margin: the left one is a hard
       edge every line starts from and the right one is whatever the longest
       line happens to leave, which on a long title was almost nothing. Pull
       the column in from the left and hold a wide, empty right margin, so the
       rag has somewhere to be ragged into. */
    var padL = b.h * 0.055, padR = b.h * 0.150, padT = b.h * 0.085;

    /* Set the type in SQUARE units and stretch it into the wrap's own, so a
       letter arrives on the case the shape it was drawn rather than condensed
       to 82% (see BACK_PANEL). Every horizontal figure below is divided by the
       stretch because the transform multiplies it straight back; the vertical
       ones are untouched, since it is only the u axis that is wrong.

       The blurred cover behind the type is left out of this deliberately. It
       is a wash at a 6% blur radius with no shape to distort, and correcting
       it would only change which part of a square sleeve gets cropped. */
    var stretch = backStretch(w, h, CASE_SQUEEZE);
    g.save();
    g.scale(stretch, 1);

    var x = (b.x + padL) / stretch, maxW = (b.w - padL - padR) / stretch;
    g.textAlign = 'left';
    g.textBaseline = 'top';

    /* Four tiers, and only one of them is set at a size decided in advance.

       The album is a standing head, the artist a standing footer, and the
       title is whatever the track happens to be called: two words or fifty
       characters of live-recording provenance. Setting all three at fixed
       sizes is what made a long title fill the panel edge to edge, twice
       over, break mid-parenthesis, and leave the artist reading as a caption
       to it. So the title is FITTED, its qualifier is demoted a tier, and the
       artist is pegged to whatever size the title came out at, so the two
       never invert. */
    var split = splitTitleSuffix(meta.title || '');
    var measure = function (t, size) {
      g.font = '700 ' + size + 'px -apple-system, sans-serif';
      return g.measureText(t).width;
    };

    var titleMin = b.h * 0.046;
    var titleSize = fitTitleSize(measure, split.main, maxW, 2, b.h * 0.072, titleMin);
    // Two lines is the target and the floor is the price of keeping the type
    // readable, so a title that will not fit at the floor gets a third line
    // rather than an ellipsis three words in.
    var lines = wrapTitle(measure, split.main, maxW, titleSize,
                          titleSize > titleMin ? 2 : 3);
    var lead = titleSize * 1.12;

    var albumSize = b.h * 0.030;
    var suffixSize = Math.max(b.h * 0.030, titleSize * 0.46);
    var artistSize = Math.min(b.h * 0.042, Math.max(b.h * 0.034, titleSize * 0.62));

    /* A single is filed under its own name, so meta.album is the title again
       and the head would print it twice, in caps, directly above itself. It is
       matched against the demoted title as well: "Alive! (Live)" off the album
       "Alive!" is the same repetition with a qualifier hiding it. */
    var albumText = (meta.album || '').toUpperCase();
    if (albumText === String(meta.title || '').toUpperCase()
        || albumText === split.main.toUpperCase()) albumText = '';

    /* The qualifier belongs to the title, so it sits closer to it than the
       artist sits to either: equal gaps read as three separate lines, which is
       the thing demoting it was meant to stop.

       Then measure the whole block and centre it. Laying out from the top of a
       full-height box leaves the copy stranded against the ceiling with an
       empty void beneath, which reads as a misalignment. */
    var gapA = b.h * 0.030, gapB = b.h * 0.034, gapS = titleSize * 0.04;
    var blockH = (albumText ? albumSize + gapA : 0)
               + lines.length * lead
               + (split.suffix ? gapS + suffixSize : 0)
               + gapB + artistSize;
    var y = b.y + (b.h - blockH) / 2;

    if (albumText) {
      g.fillStyle = 'rgba(255,255,255,.58)';
      g.font = '600 ' + albumSize + 'px -apple-system, sans-serif';
      fitText(g, albumText, x, y, maxW);
      y += albumSize + gapA;
    }

    g.fillStyle = 'rgba(255,255,255,.95)';
    g.font = '700 ' + titleSize + 'px -apple-system, sans-serif';
    lines.forEach(function (ln, i) { g.fillText(ln, x, y + i * lead); });
    y += lines.length * lead;

    if (split.suffix) {
      y += gapS;
      g.fillStyle = 'rgba(255,255,255,.68)';
      g.font = '500 ' + suffixSize + 'px -apple-system, sans-serif';
      fitText(g, split.suffix, x, y, maxW);
      y += suffixSize;
    }
    y += gapB;

    g.fillStyle = 'rgba(255,255,255,.80)';
    g.font = '600 ' + artistSize + 'px -apple-system, sans-serif';
    fitText(g, meta.artist || '', x, y, maxW);

    if (meta.player) {
      g.fillStyle = 'rgba(255,255,255,.44)';
      g.font = '600 ' + (b.h * 0.026) + 'px -apple-system, sans-serif';
      g.textAlign = 'right';
      // Pinned to the corner, not to the text column: the column's right edge
      // is now a wide empty margin, and a mark hanging off the end of nothing
      // reads as a line of type that lost its own.
      fitText(g, meta.player, (b.x + b.w - padT) / stretch, b.y + padT, maxW * 0.5);
      g.textAlign = 'left';
    }

    g.restore();
    return c;
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
    g.fill();
  }


  // Single line, truncated with an ellipsis rather than overflowing the insert.
  function fitText(g, text, x, y, maxW) {
    if (!text) return;
    var t = String(text);
    if (g.measureText(t).width <= maxW) { g.fillText(t, x, y); return; }
    while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    g.fillText(t.replace(/[\s,(\[\-]+$/, '') + '…', x, y);
  }

  function compositeTray(src) {
    var S = surfaceFor(src), c = S.canvas, g = S.g, w = S.w, h = S.h;

    /* The booklet's folded edge, seen end-on: a stack of paper leaves.

       This used to be a four-stop gradient of the album's dominant colour,
       which reads as moulded plastic rather than paper, and a smooth gradient
       across a flat area of this size visibly bands on 8-bit. Paper is almost
       white — it takes only a hint of the sleeve's colour — and what makes it
       read as a stack is the leaf edges, not a ramp. */
    /* How much of the sleeve's colour the paper carries.

       Coloured is what a real booklet's folded edge looks like when the cover
       is printed to the edge, and it is the one place in the case where the
       album's colour shows without competing with the artwork. Near-white is
       the plain-paper alternative, which is what a booklet printed on white
       stock looks like. Neither is wrong, so it is a setting. */
    var wash = opts.hingeTint ? 0.28 : 0.86;
    var b = rectIn(HINGE, w, h);
    var paper = [
      Math.round(dom[0] + (247 - dom[0]) * wash),
      Math.round(dom[1] + (245 - dom[1]) * wash),
      Math.round(dom[2] + (238 - dom[2]) * wash)
    ];
    g.fillStyle = 'rgb(' + paper.join(',') + ')';
    g.fillRect(b.x, b.y, b.w, b.h);

    // Leaf edges: many fine lines of slightly varying weight, which is what a
    // cut paper block actually looks like end-on.
    var leaves = Math.max(14, Math.round(b.w / 3));
    for (var i = 0; i < leaves; i++) {
      var f = (i + 0.5) / leaves;
      var x = b.x + b.w * f;
      // deterministic jitter: no Math.random, so the texture is stable across
      // recomposites and cannot shimmer between track changes
      var n = Math.sin(i * 12.9898) * 43758.5453;
      n = n - Math.floor(n);
      g.fillStyle = 'rgba(0,0,0,' + (0.05 + n * 0.09).toFixed(3) + ')';
      g.fillRect(x, b.y, Math.max(1, b.w / leaves * 0.45), b.h);
    }

    // The fold sits in shadow against the hinge; the outer edge catches light.
    var fold = g.createLinearGradient(b.x + b.w * 0.72, 0, b.x + b.w, 0);
    fold.addColorStop(0, 'rgba(0,0,0,0)');
    fold.addColorStop(1, 'rgba(0,0,0,.42)');
    g.fillStyle = fold;
    g.fillRect(b.x + b.w * 0.72, b.y, b.w * 0.28, b.h);

    var lip = g.createLinearGradient(b.x, 0, b.x + b.w * 0.16, 0);
    lip.addColorStop(0, 'rgba(0,0,0,.22)');
    lip.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = lip;
    g.fillRect(b.x, b.y, b.w * 0.16, b.h);

    // A little grain, which is what stops a large flat fill from banding.
    var grain = g.getImageData(b.x, b.y, Math.max(1, Math.round(b.w)), Math.max(1, Math.round(b.h)));
    var gd = grain.data;
    for (var k = 0; k < gd.length; k += 4) {
      var v = ((k * 2654435761) % 97) / 97 - 0.5;
      gd[k] += v * 7; gd[k + 1] += v * 7; gd[k + 2] += v * 7;
    }
    g.putImageData(grain, b.x, b.y);
    return c;
  }

  function makeTexture(c) {
    var t = new THREE.CanvasTexture(c);
    t.flipY = false;                       // glTF UV convention
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return t;
  }

  /* ===================== model assembly ===================== */

  var built = false;
  var parts = { lid: null, tray: null, backs: [], disc: null, spin: null };
  var sources = {};                       // original texture images, kept for recompositing
  var lidShutQ = null, lidShutP = null, lidOpenQ = null, lidOpenP = null;

  function parseGLB(b64, cb) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    new GLTFLoader().parse(bytes.buffer, '', cb, function (e) { fail('model parse failed', e); });
  }

  function meshesNamed(root, name) {
    var out = [];
    root.traverse(function (o) { if (o.isMesh && o.name === name) out.push(o); });
    return out;
  }

  var build = guard('build failed', function (caseRoot, discRoot) {
    // EVERY measurement below is taken in world space (Box3.setFromObject), and
    // the render loop has been turning `tilt` since page load. Measuring while
    // it is mid-rotation makes the shell's bounding box, the chosen depth axis
    // and the sign of `forward` all depend on how long loading happened to
    // take, which is why the case assembled correctly only some of the time.
    // Pin the rotation to zero for the whole build and restore it at the end.
    var poseBefore = tilt.rotation.clone();
    tilt.rotation.set(0, 0, 0);
    tilt.updateMatrixWorld(true);

    tilt.add(caseRoot);
    // Before ANY measurement below: every world-space box, the depth axis and
    // the disc's seat are all read off the case as it is actually drawn.
    caseRoot.scale.x = CASE_SQUEEZE;
    caseRoot.updateMatrixWorld(true);

    // Clone the shared materials so the front can differ from the back, and
    // keep the untouched source images so artwork changes can recomposite.
    parts.lid = meshesNamed(caseRoot, 'ntsc_case_front')[0] || null;
    parts.tray = meshesNamed(caseRoot, 'ntsc_case_inner')[0] || null;
    parts.backs = meshesNamed(caseRoot, 'ntsc_case_back_1')
      .concat(meshesNamed(caseRoot, 'ntsc_case_back_2'));

    [['lid', parts.lid], ['tray', parts.tray]].forEach(function (pair) {
      var m = pair[1];
      if (!m) return;
      var mat = (Array.isArray(m.material) ? m.material[0] : m.material).clone();
      m.material = mat;
      if (mat.map && mat.map.image) sources[pair[0]] = mat.map.image;
    });
    parts.backs.forEach(function (m, i) {
      var mat = (Array.isArray(m.material) ? m.material[0] : m.material).clone();
      m.material = mat;
      if (mat.map && mat.map.image) sources['back' + i] = mat.map.image;
    });

    /* The promo sticker is console branding, and the model's own flat disc is
       replaced by the real one. Both are DETACHED, not just hidden.

       Box3.setFromObject walks the graph without asking whether anything in it
       is visible, so a hidden mesh still sets the size of the case as far as
       every measurement here is concerned — and these two are nowhere near the
       case. The promo sticker rides the lid out to z 27, and the artist's disc
       hangs 2.75 units below the shell. Left in the graph they made the shut
       case measure 14.6 deep instead of 2.6 and pushed its centre 1.16 up, so
       the camera framed a volume three times the case's depth and the case sat
       high in the window. */
    var slot = null;
    ['ntsc_case_promo', 'ntsc_disc_front', 'ntsc_disc_back'].forEach(function (n) {
      meshesNamed(caseRoot, n).forEach(function (m) {
        m.updateWorldMatrix(true, false);
        if (n !== 'ntsc_case_promo') {
          var b = new THREE.Box3().setFromObject(m);
          slot = slot ? slot.union(b) : b;
        }
        m.visible = false;
        if (m.parent) m.parent.remove(m);
      });
    });

    // Shut the lid. The artist authored the case closed and swung the lid open
    // by -25 degrees about Z AND translated it forward, so restoring the base's
    // orientation is only half of it; the rest is worked out from the boxes.
    var base = null;
    caseRoot.traverse(function (o) {
      if (o.isMesh && o.name.indexOf('ntsc_case_back') === 0 && !base) base = o;
    });
    var depthAxis = 2, lidThick = 0, forward = true;
    window.__diag = {
      lid: parts.lid ? parts.lid.name : null,
      base: base ? base.name : null,
      sameParent: !!(parts.lid && base) && parts.lid.parent === base.parent,
      lidParent: parts.lid && parts.lid.parent ? (parts.lid.parent.name || parts.lid.parent.type) : null,
      baseParent: base && base.parent ? (base.parent.name || base.parent.type) : null,
      slot: !!slot
    };
    // Compare in WORLD space. Requiring a shared parent is wrong: a mesh with
    // two material slots becomes two glTF primitives wrapped in a Group, so the
    // base sits one level deeper than the lid and a same-parent test silently
    // skips closing the case altogether.
    if (parts.lid && base) {
      lidOpenQ = parts.lid.quaternion.clone();
      lidOpenP = parts.lid.position.clone();

      parts.lid.updateMatrixWorld(true);
      base.updateMatrixWorld(true);
      var baseWorldQ = base.getWorldQuaternion(new THREE.Quaternion());
      var lidParentQ = parts.lid.parent
        ? parts.lid.parent.getWorldQuaternion(new THREE.Quaternion())
        : new THREE.Quaternion();
      // local = parentWorld^-1 * desiredWorld
      parts.lid.quaternion.copy(lidParentQ.invert().multiply(baseWorldQ));
      parts.lid.updateMatrixWorld(true);

      var body = new THREE.Box3(), any = 0;
      caseRoot.traverse(function (o) {
        if (!o.isMesh || o === parts.lid || !o.visible) return;
        if (o.name.indexOf('ntsc_disc') === 0) return;
        o.updateWorldMatrix(true, false);
        body.expandByObject(o); any++;
      });
      if (any) {
        var lbox = new THREE.Box3().setFromObject(parts.lid);
        var bsz = body.getSize(new THREE.Vector3()).toArray();
        depthAxis = bsz.indexOf(Math.min.apply(null, bsz));
        var lc = lbox.getCenter(new THREE.Vector3()).toArray();
        var bc = body.getCenter(new THREE.Vector3()).toArray();
        lidThick = lbox.max.toArray()[depthAxis] - lbox.min.toArray()[depthAxis];
        forward = lc[depthAxis] > bc[depthAxis];
        var d = new THREE.Vector3(
          depthAxis === 0 ? 0 : bc[0] - lc[0],
          depthAxis === 1 ? 0 : bc[1] - lc[1],
          depthAxis === 2 ? 0 : bc[2] - lc[2]);
        d.setComponent(depthAxis, bc[depthAxis] - lc[depthAxis]);
        applyWorldDelta(parts.lid, d);
      }
    }

    // Disc: diameter from the case interior (a CD is 120mm in a 125mm case),
    // seated on the tray, and only then is the lid closed over it. Doing the
    // lid first is what put the disc outside the case.
    if (discRoot && slot) {
      var spin = new THREE.Group(), holder = new THREE.Group();
      holder.add(discRoot); spin.add(holder); tilt.add(spin);
      parts.spin = spin; parts.disc = discRoot;

      // Point the PRINTED face at the viewer with a single rotation. Deriving
      // the axis unsigned and flipping afterwards turns the disc over, which
      // also mirrors the artwork (the title came out upside down).
      var axis = signedDiscAxis(discRoot) || discAxis(discRoot);
      if (axis) holder.quaternion.setFromUnitVectors(axis, new THREE.Vector3(0, 0, 1));
      holder.updateMatrixWorld(true);

      var db = new THREE.Box3().setFromObject(holder);
      holder.position.sub(db.getCenter(new THREE.Vector3()));
      holder.updateMatrixWorld(true);
      db = new THREE.Box3().setFromObject(holder);
      var dsz = db.getSize(new THREE.Vector3()).toArray();
      var dOrd = dsz.slice().sort(function (a, b) { return b - a; });

      var trayBox = new THREE.Box3();
      if (parts.tray) { parts.tray.updateWorldMatrix(true, false); trayBox.expandByObject(parts.tray); }

      var shellBox = new THREE.Box3(), shellAny = 0;
      parts.backs.forEach(function (m) {
        m.updateWorldMatrix(true, false); shellBox.expandByObject(m); shellAny++;
      });
      var tsz = trayBox.getSize(new THREE.Vector3()).toArray();
      var td = tsz.indexOf(Math.min.apply(null, tsz));

      /* Size and seat the disc from the case, in real millimetres.

         A CD is 120mm across in a case 142mm wide, and it sits on the tray's
         moulded hub — which is NOT the middle of the case. Measured off
         ntsc_case_inner: a raised hinge column occupies x -31.574..-26.625,
         the tray plate runs -26.625..31.169, and the hub is a small raised
         disc centred at x +2.159 in a shell spanning -31.572..31.572.

         Centring on the shell — what this used to do — parks the disc 4.9mm
         toward the hinge, leaving a 10.8mm gap on one side and 2.8mm on the
         other. Shut, nobody can tell. Open, it is the first thing you see,
         because the tray's disc well is very nearly square and the disc
         visibly is not centred in it.

         The model's own disc mesh is no help: its centre is (2.156, -3.485).
         The x agrees with the hub to three decimals; the y is 7.8mm low, far
         enough that the artist's disc hangs out of the bottom of the case. */
      var ref = shellAny ? shellBox : trayBox;
      var shellSz = ref.getSize(new THREE.Vector3()).toArray();
      var wideAxis = 0, wide = -1, tallAxis = 0, tall = Infinity;
      for (var ai = 0; ai < 3; ai++) {
        if (ai === td) continue;
        if (shellSz[ai] > wide) { wide = shellSz[ai]; wideAxis = ai; }
        if (shellSz[ai] < tall) { tall = shellSz[ai]; tallAxis = ai; }
      }
      // Diameter from the case's HEIGHT: a 120mm disc in a 125mm case. The
      // width is squeezed 3.5% to square up the cover (see CASE_SQUEEZE), so
      // sizing off it would quietly shrink the disc by the same amount.
      spin.scale.setScalar((tall * (120 / 125)) / ((dOrd[0] + dOrd[1]) / 2));

      var pos = ref.getCenter(new THREE.Vector3());

      /* Which side the hinge is on, from the one thing that marks it out: the
         column stands proud of the tray plate, toward the lid. Reading it off
         the tray's own vertices beats assuming the model's axes point a
         particular way — every constant in this file that assumed something
         about the model turned out to be wrong. */
      var hingeSign = 0;
      var gp = parts.tray && parts.tray.geometry && parts.tray.geometry.attributes.position;
      if (gp) {
        parts.tray.updateWorldMatrix(true, false);
        var v = new THREE.Vector3(), lo = Infinity, hi = -Infinity, i;
        for (i = 0; i < gp.count; i++) {
          v.fromBufferAttribute(gp, i).applyMatrix4(parts.tray.matrixWorld);
          var dz = v.getComponent(td);
          if (dz < lo) lo = dz;
          if (dz > hi) hi = dz;
        }
        var near = forward ? hi : lo, tol = (hi - lo) * 0.12, sum = 0, n = 0;
        for (i = 0; i < gp.count; i++) {
          v.fromBufferAttribute(gp, i).applyMatrix4(parts.tray.matrixWorld);
          if (Math.abs(v.getComponent(td) - near) > tol) continue;
          sum += v.getComponent(wideAxis); n++;
        }
        if (n) hingeSign = (sum / n) > pos.getComponent(wideAxis) ? 1 : -1;
      }
      pos.setComponent(wideAxis,
        pos.getComponent(wideAxis) - hingeSign * (2.159 / 63.144) * wide);
      spin.position.copy(pos);
      spin.updateMatrixWorld(true);
      var dbox = new THREE.Box3().setFromObject(spin);
      var thick = dbox.max.toArray()[td] - dbox.min.toArray()[td];
      // Seat against the SHELL's interior, not the tray's face. In this model
      // the tray plate sits at the front of the shell, so "resting on the tray"
      // parks the disc at the very front of the case volume and it reads as
      // lifted the moment the lid opens.
      pos.setComponent(td, ref.max.toArray()[td] - thick / 2 - 0.10);
      spin.position.copy(pos);
      spin.updateMatrixWorld(true);

      if (parts.lid) {
        var contents = new THREE.Box3().setFromObject(spin).union(trayBox);
        var lb2 = new THREE.Box3().setFromObject(parts.lid);
        var need = forward
          ? contents.max.toArray()[depthAxis] + 0.18 - lb2.max.toArray()[depthAxis]
          : contents.min.toArray()[depthAxis] - 0.18 - lb2.min.toArray()[depthAxis];
        var pv = new THREE.Vector3();
        pv.setComponent(depthAxis, need);
        applyWorldDelta(parts.lid, pv);
        lidShutP = parts.lid.position.clone();
        lidShutQ = parts.lid.quaternion.clone();
      }
    }

    if (parts.spin) {
      var dbg = new THREE.Box3().setFromObject(parts.spin);
      var sb = new THREE.Box3();
      parts.backs.forEach(function (m) { sb.expandByObject(m); });
      window.__diag2 = {
        discCentre: dbg.getCenter(new THREE.Vector3()).toArray().map(function (v) { return +v.toFixed(2); }),
        shellCentre: sb.getCenter(new THREE.Vector3()).toArray().map(function (v) { return +v.toFixed(2); }),
        discSize: dbg.getSize(new THREE.Vector3()).toArray().map(function (v) { return +v.toFixed(2); }),
        shellSize: sb.getSize(new THREE.Vector3()).toArray().map(function (v) { return +v.toFixed(2); })
      };
    }

    tilt.rotation.copy(poseBefore);
    tilt.updateMatrixWorld(true);

    /* The tray must be solid and the disc's clear layer must not punch a hole.

       A glTF BLEND material still writes depth by default, so the disc's
       clear-plastic ring occluded the tray behind it and then blended against
       the background — you could see the desktop through a case that is
       supposed to have a paper insert and a tray behind the disc. */
    tilt.traverse(function (o) {
      if (!o.isMesh) return;
      var ms = Array.isArray(o.material) ? o.material : [o.material];
      ms.forEach(function (m) {
        if (m.name === 'clearplastic') {
          m.transparent = true;
          m.depthWrite = false;          // may not occlude the tray
          m.opacity = Math.min(m.opacity, 0.35);
        }
        if (o.name === 'ntsc_case_inner' || o.name.indexOf('ntsc_case_back') === 0) {
          m.transparent = false;         // the case has a solid back
          m.depthWrite = true;
          m.side = THREE.DoubleSide;
        }
        m.needsUpdate = true;
      });
    });

    /* The disc is metal, and metal is lit by the ENVIRONMENT, not by lamps.

       The scene runs environmentIntensity at 0.09 because that is what makes
       the printed sleeve read true — but at 0.09 a mirror has almost nothing to
       reflect and renders nearly black, which is why the disc looked like a
       dark plate with a rainbow rim instead of silver. Materials carry their
       own envMapIntensity, so the disc can be given a proper environment
       without disturbing the sleeve. */
    if (parts.disc) {
      parts.disc.traverse(function (o) {
        if (!o.isMesh) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) {
          if (m.name === 'metalfoil') {
            m.metalness = 1.0;
            m.roughness = 0.13;               // a CD is a near-mirror
            m.color = new THREE.Color(0xf2f4f7);
            m.envMapIntensity = 4.0;
          } else if (m.name === 'discBottom') {
            m.metalness = 1.0;
            m.roughness = 0.24;
            m.color = new THREE.Color(0xd8dce2);
            m.envMapIntensity = 3.0;
          } else if (m.name === 'clearplastic') {
            m.metalness = 0.0;
            m.roughness = 0.04;
            m.envMapIntensity = 2.2;
            m.opacity = Math.min(m.opacity, 0.22);
          } else if (m.name === 'label') {
            // printed onto aluminium, so slightly glossy rather than matte
            m.roughness = 0.55;
            m.envMapIntensity = 0.9;
          }
          m.needsUpdate = true;
        });
      });
    }

    var maxAniso = renderer.capabilities.getMaxAnisotropy();
    tilt.traverse(function (o) {
      if (!o.isMesh) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) {
        ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap'].forEach(function (k) {
          if (!m[k]) return;
          m[k].anisotropy = maxAniso;
          m[k].generateMipmaps = true;
          m[k].minFilter = THREE.LinearMipmapLinearFilter;
          m[k].needsUpdate = true;
        });
      });
    });

    built = true;
    // A lid that silently fails to close looks like a rendering bug, so say so.
    if (!lidOpenQ) fail('lid did not close', JSON.stringify(window.__diag));
    frame();
    recomposite();
    invalidate();
  });

  function applyWorldDelta(obj, worldDelta) {
    var inv = new THREE.Matrix4().copy(obj.parent.matrixWorld).invert();
    var a = new THREE.Vector3().applyMatrix4(inv);
    var b = worldDelta.clone().applyMatrix4(inv);
    obj.position.add(b.sub(a));
    obj.updateMatrixWorld(true);
  }

  // The vector from the disc's underside to its printed face IS the signed
  // axis, and needs no guesswork about normal directions.
  function signedDiscAxis(root) {
    var lab = null, bot = null;
    root.traverse(function (o) {
      if (!o.isMesh) return;
      var ms = Array.isArray(o.material) ? o.material : [o.material];
      var names = ms.map(function (m) { return m.name; });
      o.updateWorldMatrix(true, false);
      var c = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
      if (names.indexOf('label') !== -1) lab = c;
      if (names.indexOf('discBottom') !== -1) bot = c;
    });
    if (!lab || !bot) return null;
    var v = lab.clone().sub(bot);
    return v.lengthSq() > 1e-9 ? v.normalize() : null;
  }

  // The thin axis of the label mesh's LOCAL box is the disc's own axis;
  // averaging vertex normals is fragile on a rimmed or double-sided mesh.
  function discAxis(root) {
    var axis = null;
    root.traverse(function (o) {
      if (!o.isMesh || axis) return;
      var ms = Array.isArray(o.material) ? o.material : [o.material];
      if (!ms.some(function (m) { return m.name === 'label'; })) return;
      o.geometry.computeBoundingBox();
      var sz = o.geometry.boundingBox.getSize(new THREE.Vector3());
      var local = sz.x <= sz.y && sz.x <= sz.z ? new THREE.Vector3(1, 0, 0)
                : sz.y <= sz.z ? new THREE.Vector3(0, 1, 0)
                : new THREE.Vector3(0, 0, 1);
      var na = o.geometry.attributes.normal;
      if (na) {                            // the thin axis carries no sign
        var acc = new THREE.Vector3(), v = new THREE.Vector3();
        var st = Math.max(1, Math.floor(na.count / 300));
        for (var i = 0; i < na.count; i += st) { v.fromBufferAttribute(na, i); acc.add(v); }
        if (acc.lengthSq() > 1e-6 && acc.normalize().dot(local) < 0) local.negate();
      }
      o.updateWorldMatrix(true, false);
      axis = local.applyMatrix3(new THREE.Matrix3().getNormalMatrix(o.matrixWorld)).normalize();
    });
    return axis;
  }

  /* How far the case can be tilted. The camera is fitted to hold it at this
     angle at EVERY yaw, so it is a real limit rather than a clamp that bites
     early — scroll the case to it and it goes, wherever the case is pointing. */
  var PITCH_LIMIT = 0.85;

  var fitBudget = { ty: 0, tx: 0, half: new THREE.Vector3(1, 1, 1) };
  var restD = 0, camZ = 0;

  var halfShut = new THREE.Vector3(), halfOpen = new THREE.Vector3(), halfNow = new THREE.Vector3();
  var fittedFor = -1;

  /* Half-extents about tilt's OWN ORIGIN, not about the box centre — that is
     the point the case rotates about, so it is the only radius the clamp
     below can use. For the shut case the two are the same; for the open one
     they are not, because the lid swings out to one side. */
  function halfAbout(target) {
    var b = new THREE.Box3().setFromObject(tilt);
    return target.set(
      Math.max(Math.abs(b.min.x), Math.abs(b.max.x)),
      Math.max(Math.abs(b.min.y), Math.abs(b.max.y)),
      Math.max(Math.abs(b.min.z), Math.abs(b.max.z)));
  }

  function frame() {
    if (!tilt.children.length) return;
    var saved = tilt.rotation.clone();
    tilt.rotation.set(0, 0, 0);
    tilt.updateMatrixWorld(true);

    var box = new THREE.Box3().setFromObject(tilt);
    var centre = box.getCenter(new THREE.Vector3());
    tilt.children.forEach(function (c) { c.position.sub(centre); });
    tilt.updateMatrixWorld(true);
    halfAbout(halfShut);

    /* An open case sweeps a much larger volume than a shut one — the lid comes
       25 degrees out of the case and stands proud of it. Measure that pose as
       well and fit whichever one the case is actually in: fitting the open
       pose permanently would shrink the case for a state it is rarely in. */
    if (parts.lid && lidOpenQ) {
      var q = parts.lid.quaternion.clone(), pp = parts.lid.position.clone();
      parts.lid.quaternion.copy(lidOpenQ);
      if (lidOpenP) parts.lid.position.copy(lidOpenP);
      tilt.updateMatrixWorld(true);
      halfAbout(halfOpen);
      parts.lid.quaternion.copy(q); parts.lid.position.copy(pp);
      tilt.updateMatrixWorld(true);
    } else {
      halfOpen.copy(halfShut);
    }

    tilt.rotation.copy(saved);
    tilt.updateMatrixWorld(true);
    fittedFor = -1;
    fitFor(lidT);
  }

  // Fit the frame to the pose the case is in — shut, open, or part way.
  function fitFor(t) {
    if (!halfShut.lengthSq()) return;
    t = Math.max(0, Math.min(1, t || 0));
    if (Math.abs(t - fittedFor) < 0.004) return;
    fittedFor = t;
    halfNow.lerpVectors(halfShut, halfOpen, t);

    /* The distance that holds the case in EVERY pose it can be put in.

       Solved, not guessed. A corner at (x, y, z) after rotation projects
       through a divide by (d - z), so it stays inside the frustum when

           d >= z + max( |y| / tan(vFov/2), |x| / tan(hFov/2) )

       Take the largest any corner needs over the whole rotation envelope and
       the case can never leave the frame — no clamp, no correction, nothing
       that fights the scroll.

       This replaces a fit that held the case face-on plus a tilt limiter that
       took up the slack. The limiter was the problem: it was free head-on and
       collapsed to about three degrees by the time the case had turned sixty,
       so tilting to look at the top or bottom edge worked or did not depending
       on where the case happened to be pointing.

       It costs ~17% of the case's apparent size, and that price does not come
       down by asking for less: the worst pose is near 40 degrees of tilt, and
       fitting for only 23 costs 16%. It is the whole range or nothing, and a
       rotation that quietly refuses to go where the scroll asks is worse than
       a slightly smaller case. */
    var ty = Math.tan(camera.fov * Math.PI / 360);
    var tx = ty * camera.aspect;
    fitBudget.ty = ty;
    fitBudget.tx = tx;

    fitBudget.half.copy(halfNow);

    /* The resting distance covers every YAW, but only the tilt the idle drift
       can reach. Yaw is what the case does on its own — the track-change lap
       is a full turn — so holding all of it at a fixed distance keeps that
       animation free of any zoom. */
    restD = 0;
    for (var yi = 0; yi < 72; yi++) {
      restD = Math.max(restD, poseDistance(fitBudget.half, ty, tx, yi * Math.PI / 36, 0.10));
    }
    restD *= 1.02;
    camera.near = restD / 800;
    camera.far = restD * 30;
    camera.updateProjectionMatrix();
    if (!camZ) camZ = restD;
    camera.position.set(0, 0, camZ);
    camera.lookAt(0, 0, 0);
  }

  /* How far back the lens has to be for this exact pose to fit.

     A corner at (x, y, z) after rotation projects through a divide by (d - z),
     so it is inside the frustum when

         d >= z + max( |y| / tan(vFov/2), |x| / tan(hFov/2) )

     and the pose fits when that holds for all eight of them. */
  function poseDistance(h, ty, tx, y, p) {
    var cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p), need = 0;
    for (var i = 0; i < 8; i++) {
      var X = (i & 1) ? h.x : -h.x, Y = (i & 2) ? h.y : -h.y, Z = (i & 4) ? h.z : -h.z;
      var x1 = X * cy + Z * sy, z1 = Z * cy - X * sy;
      // The lift is a world translation applied after the rotation, so it is
      // added after it here too rather than folded into the half-extents.
      var y2 = Y * cp - z1 * sp, z2 = Y * sp + z1 * cp;
      var d = z2 + Math.max(Math.abs(y2) / ty, Math.abs(x1) / tx);
      if (d > need) need = d;
    }
    return need;
  }

  /* Hold the case in frame by moving the LENS, not by refusing the rotation.

     Tilting is what costs room: a case fitted to hold 49 degrees of tilt at
     every yaw has to sit 18% further back all the time, and it spends that on
     a pose it is almost never in. The tilt limiter this replaces spent nothing
     but bit instead — free head-on, down to about three degrees by the time
     the case had turned sixty, so tilting to see the top edge worked or did
     not depending on where the case happened to be pointing.

     So: fit the resting distance to every yaw, and ease back only as far as
     the tilt of the moment actually needs. Outward is immediate, because a
     lens that lags cannot stop a clip; inward is eased, so the case drifts
     back as it settles rather than snapping. The track-change lap is pure yaw
     and never moves the lens at all. */
  function trackPose(dt, y, p) {
    if (!fitBudget.ty) return;
    var want = Math.max(restD, poseDistance(fitBudget.half, fitBudget.ty, fitBudget.tx, y, p) * 1.02);
    if (want > camZ) camZ = want;
    else camZ += (want - camZ) * Math.min(1, dt * 5);
    camera.position.z = camZ;
  }



  // Paper is a dielectric. If the model ships the insert as even slightly
  // metallic, its colour stops being albedo and becomes a specular tint.
  function makePrintedPaper(mat) {
    /* The printed insert is paper UNDER clear plastic, not plastic.

       The model's material carries the normal and roughness maps of a scanned
       plastic case, and those were being applied over the album artwork —
       hazing it and dulling its colour. Over the cover the plastic should be
       effectively clear, so those maps come off and the surface becomes a
       matte dielectric.

       Lit, not emissive: an emissive sleeve reproduces colour exactly but
       removes every trace of shading and the case stops reading as an object.
       Instead the lighting is kept at unit sum (see the light rig), so albedo
       maps to output roughly 1:1 without any channel clipping — which is what
       turned deep red into pink. */
    mat.color = new THREE.Color(0xffffff);
    mat.emissive = new THREE.Color(0x000000);
    mat.emissiveMap = null;
    mat.emissiveIntensity = 0;
    mat.metalness = 0;
    mat.roughness = 1.0;                 // paper: no specular lobe at all
    mat.normalMap = null;                // <- the plastic texture over the art
    mat.roughnessMap = null;
    mat.metalnessMap = null;
    mat.aoMap = null;
    mat.envMapIntensity = 0.05;          // a whisper, so it is not dead flat
    mat.needsUpdate = true;
  }

  /* Each face composites on its own, because the track-change reveal repaints
     them at different moments: whichever one is hidden, as soon as it is.

     `printSeq` is the generation of what SHOULD be printed and `wearing` what
     each face was last printed from, so "is this face out of date" is a
     question the reveal can answer without inspecting a texture. A face that
     misses its moment stays answerable as out of date instead of being
     silently left behind, which is exactly how the back used to go stale.

     The generation moves on for the ARTWORK and for the printed text alike:
     the back carries the title, the artist and the album as well as the cover,
     so a track change dates it even when the artwork is byte-for-byte what it
     already was. */
  var printSeq = 0;
  var wearing = { front: -1, back: -1 };

  function printedText() {
    return [meta.album, meta.artist, meta.title, meta.player].join(' ');
  }

  function recompositeFront() {
    if (!built || !album || !parts.lid || !sources.lid) return;
    var m = parts.lid.material;
    m.map = makeTexture(compositeFront(sources.lid));
    makePrintedPaper(m);
    // Opaque, and visible from behind: the lid is a real panel, and when the
    // case opens you look at the back of it.
    m.transparent = false;
    m.depthWrite = true;
    m.side = THREE.DoubleSide;
    m.needsUpdate = true;
  }

  function recompositeTray() {
    if (!built || !album || !parts.tray || !sources.tray) return;
    parts.tray.material.map = makeTexture(compositeTray(sources.tray));
    parts.tray.material.needsUpdate = true;
  }

  function recompositeDisc() {
    if (!built || !album || !parts.disc) return;
    var lab = makeTexture(album);

    /* The case wraps are the model's OWN textures redrawn, so they take the
       glTF convention makeTexture applies and land back exactly where they
       came from. The disc's label is not: it is the sleeve, new content on
       somebody else's UVs, and this disc mesh runs v UP the disc. Measured on
       the shipped model: the vertices at v=0.15 sit at the bottom edge and
       those at v=0.85 at the top, so with the wraps' flipY the album's first
       row prints along the BOTTOM and the whole sleeve comes out mirrored top
       to bottom, which reads as upside down and back to front at once.

       _dev/shot/disc-orientation.js measures this against the built scene and
       fails if it comes back. */
    lab.flipY = true;

    var hits = 0;
    parts.disc.traverse(function (o) {
      if (!o.isMesh) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) {
        if (m.name !== 'label') return;
        m.map = lab;
        m.color = new THREE.Color(0xffffff);
        m.needsUpdate = true;
        hits++;
      });
    });
    return hits;
  }

  var lastBackAt = 0;
  function recompositeBack(now) {
    if (!built || !album) return;
    lastBackAt = now || performance.now();
    parts.backs.forEach(function (m, i) {
      if (!sources['back' + i]) return;
      var t = makeTexture(compositeBack(sources['back' + i], lastBackAt));
      if (m.material.map) m.material.map.dispose();
      m.material.map = t;
      makePrintedPaper(m.material);
    });
  }

  /* The front, the tray and the disc label are ONE face as far as the reveal
     is concerned: all three are behind the lid and swing into view together,
     so they are repainted together and carry one stamp between them. */
  function paintFront() {
    if (!built || !album) return;
    recompositeFront();
    recompositeTray();
    recompositeDisc();
    wearing.front = printSeq;
  }

  function paintBack(now) {
    if (!built || !album) return;
    recompositeBack(now);
    wearing.back = printSeq;
  }

  // Repaint what is out of date wherever the case happens to be standing. Only
  // for when nothing is turning and nothing is about to: while a reveal is
  // armed or running, being out of date is the point.
  function paintStaleFaces(now) {
    if (wearing.back !== printSeq) paintBack(now);
    if (wearing.front !== printSeq) paintFront();
  }

  var recomposite = guard('recomposite failed', function () {
    if (!built || !album) return;
    paintFront();
    paintBack();
    invalidate();
  });

  /* ===================== interaction ===================== */

  var yaw = 0, pitch = 0, homeYaw = 0, homePitch = 0;
  var releaseAt = 0;
  var HOLD = 3.0, RETURN = 1.2;   // HOLD is raised by the tuner's hold hook       // stay put where released, then travel home
  var lidT = 0, lidTarget = 0;
  /* Track-change reveal.

     A sleeve must never change while you are looking at it. The case turns one
     full lap and each face is repainted only while it is hidden, so the new
     artwork is already there when that face swings back into view. Composited
     textures are baked, so replacing `album` partway through a lap alters
     nothing on screen: a face only changes when it is repainted.

     WHICH face may be repainted WHEN is decided by facesToPaint at the top of
     this file, where it can be tested. */
  var turnStart = 0;
  var turnArmed = false, turnArmedAt = 0;

  var PHASE_NONE = 0, PHASE_TURN = 1;
  var phase = PHASE_NONE;

  var pendingAlbum = null;
  var homeFromYaw = 0, homeFromPitch = 0;

  // Wait for the new artwork, but not forever: consecutive tracks from one
  // album share a cover and no new bytes ever arrive, so fall back on a timer.
  function armTurn() {
    if (!opts.spinOnChange) return;
    turnArmed = true;
    turnArmedAt = performance.now();
    invalidate();
  }

  function fireTurn() {
    if (!turnArmed) return;
    // Stay armed if a reveal is already running: consuming the arm here meant
    // the second track's lap was silently dropped. The 1500ms fallback will
    // fire it as soon as this one lands.
    if (phase !== PHASE_NONE) return;
    turnArmed = false;
    phase = PHASE_TURN;
    turnStart = performance.now();
    homeFromYaw = yaw;
    homeFromPitch = pitch;
    releaseAt = 0;                             // the settle must not fight it
    invalidate();
  }

  function adoptPending() {
    if (!pendingAlbum) return;
    album = pendingAlbum;
    pendingAlbum = null;
    albumSeq++;
    printSeq++;
    blurCache = null;
    blurCacheKey = null;
    dom = dominantOf(album);
    domCSS = css(dom);
    avg = meanOf(album, 97);
  }

  /* One continuous sweep.

     Not "return home, then spin": that reads as two animations bolted together
     and you can see the seam where the first stops. Instead a single eased
     motion carries the case from wherever it is, through a full lap, landing
     square. Because the resting angle is folded into the same curve, the total
     travel is a lap plus whatever correction was needed, and it never stops on
     the way.

     Faces are repainted by where the case is actually POINTING, not by elapsed
     time, so a repaint stays hidden regardless of where the sweep began. And
     the sweep does NOT always begin square on. */
  function turnAngle(now) {
    if (phase !== PHASE_TURN) return 0;

    var k = (now - turnStart) / 1000 / TURN;
    if (k >= 1) {
      phase = PHASE_NONE;
      turnStart = 0;
      yaw = 0; pitch = 0; homeYaw = 0; homePitch = 0;
      /* Landed square. Anything still out of date is repainted here whether or
         not it can be seen: a face left wearing the previous track is worse
         than one that changes where you can watch it change. A full lap hides
         both faces, so this is the net for frames dropped across a whole
         half-turn, or for a sleeve that landed in the last of the lap. */
      adoptPending();
      paintStaleFaces(now);
      return 0;
    }

    var e = easeInOut(k);
    var angle = lapAngle(homeFromYaw, e);

    yaw = 0;                              // the sweep owns the rotation
    pitch = homeFromPitch * (1 - e);

    /* Take a sleeve that landed mid-lap right now, before deciding what to
       repaint. Adopting is invisible on its own (the textures are baked) and
       what each face is WEARING moves only when that face is repainted, so
       every face that has not yet had its hidden moment picks the new sleeve
       up at that moment instead of being left on the old one. */
    adoptPending();
    var due = facesToPaint(Math.cos(angle), wearing, printSeq);
    for (var i = 0; i < due.length; i++) {
      if (due[i] === 'back') paintBack(now); else paintFront();
    }
    return angle;
  }

  /* Turning the case is bound to SCROLL, not drag.

     A mousedown on a non-interactive element is how the host moves a widget
     around the desktop, so consuming it for rotation would break the only
     gesture that works there (the interactive allow-list in WidgetJSBridge is
     a hard-coded set of tags and classes and CANVAS is on neither, and the
     panel never receives mouseMoved without a button held).

     Wheel events do not collide with that: two-finger trackpad scroll and
     Magic Mouse surface scroll both arrive as `wheel`, and macOS sends its own
     momentum tail, so the flick decelerates without us simulating inertia.
     The host injecting `overscroll-behavior:none` into every widget is a
     strong sign scroll is delivered here. */

  var WHEEL_YAW = 0.0060, WHEEL_PITCH = 0.0042;

  window.addEventListener('wheel', function (e) {
    // Shift-scroll on a mouse with one axis maps to horizontal, as usual.
    var dx = e.deltaX, dy = e.deltaY;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    if (!dx && !dy) return;

    yaw += dx * WHEEL_YAW;
    // Orientation is 2*PI-periodic, so an accumulated yaw of ten turns looks
    // identical to its wrapped value — but returning home from the raw figure
    // would unwind all ten. Wrapping to (-PI, PI] is invisible now and makes
    // the journey home always the short way round.
    yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch + dy * WHEEL_PITCH));

    // Restart the settle clock on every event, including the momentum tail, so
    // the case only begins its journey home once the flick has truly stopped.
    releaseAt = performance.now();
    homeYaw = yaw;
    homePitch = pitch;

    invalidate();
    e.preventDefault();          // no page scrolling, but mousedown is untouched
  }, { passive: false });

  /* Click to open the case.

     Deliberately a `click` listener, and deliberately without preventDefault:
     in the shipping host a mousedown on a non-interactive element is what
     starts a WINDOW DRAG, so consuming mousedown breaks moving the widget.
     A click still arrives afterwards when the pointer did not travel, so both
     gestures can coexist. The distance guard keeps a drag from counting. */
  var downX = 0, downY = 0;
  canvas.addEventListener('mousedown', function (e) { downX = e.clientX; downY = e.clientY; });
  canvas.addEventListener('click', function (e) {
    if (!lidOpenQ) return;
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 6) return;
    lidTarget = lidTarget > 0.5 ? 0 : 1;
    invalidate();
  });

  // Right-click is suppressed by the host anyway; stop the page adding its own.
  window.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  /* ===================== NepTunes ===================== */

  var playing = false;
  var lastPlaying = null;   // null until the first push — see lidPoseOnState
  var lastArtURL = null;
  var artSeq = 0;
  var lastIdent = null;
  var lastSleeveId = null;

  var applyState = guard('applyState failed', function (state) {
    if (!state) return;

    // Mirror for a right-to-left host language. Nothing in this bundle's layout reverses
    // — it is one GL canvas plus a centred, column-direction empty state — but `#emptyText`
    // is real text, and `dir` is what gives an Arabic string its paragraph direction. The
    // 3D scene is unaffected either way. Applied on state rather than at startup because
    // window.NepTunes.state is null until the host's first push, which lands after
    // DOMContentLoaded.
    if (state.layoutDirection) document.documentElement.dir = state.layoutDirection;
    var t = state.track;
    var has = !!(t && t.title);
    emptyEl.hidden = has;
    if (!has) {
      emptyText.textContent = state.playerType ? 'Nothing playing' : 'No player';
      playing = false;
      lastPlaying = false;
      invalidate();
      return;
    }

    // Turning the case the instant the track changes spins the OLD cover,
    // because artwork lands later (up to a second, plus network for a lookup).
    // Arm it here and fire when the new sleeve is actually on the case.
    var ident = (t.title || '') + '\u0000' + (t.artist || '');
    // The sleeve is identified by album + album artist, not by track. Two
    // tracks off one album deliver identical artwork, and on many pushes the
    // host omits artworkData entirely because the bytes have not changed — so
    // waiting for "new" artwork there means waiting for something that will
    // never arrive. Fire the turn immediately in that case.
    var sleeveId = (t.albumArtist || t.artist || '') + '\u0000' + (t.album || '');
    var sameSleeve = (lastSleeveId !== null && sleeveId === lastSleeveId);
    if (lastIdent !== null && ident !== lastIdent) {
      armTurn();
      if (sameSleeve) fireTurn();       // nothing to wait for
    }
    lastIdent = ident;
    lastSleeveId = sleeveId;

    var wasPrinted = printedText();
    meta.album = t.album || t.title || '';
    meta.artist = t.artist || '';
    meta.title = t.title || '';
    meta.duration = typeof t.duration === 'number' ? t.duration : 0;
    meta.player = state.playerType === 'spotify' ? 'Spotify'
                : state.playerType === 'appleMusic' ? 'Apple Music' : '';
    if (typeof state.playerPosition === 'number') {
      meta.posSeed = state.playerPosition;
      meta.posAt = state.timestampMs || performance.now();
      // timestampMs is epoch ms; performance.now() is not. Normalise to the
      // monotonic clock so the extrapolation cannot jump.
      meta.posAt = performance.now();
    }
    playing = state.playerState === 2;
    var pose = lidPoseOnState(opts.openOnPause, playing, lastPlaying);
    lastPlaying = playing;
    if (pose !== null) lidTarget = pose;

    // The back is printed with the title, the artist and the album, so it is
    // out of date the moment any of them move, with or without new artwork.
    if (printedText() !== wasPrinted) printSeq++;

    // The host omits artworkData when the bytes have not changed and the
    // injected pushState carries the previous value forward, so the data URL
    // string is a stable, cheap change signal.
    var url = window.NepTunes.getArtworkDataURL ? window.NepTunes.getArtworkDataURL() : null;
    if (url && url !== lastArtURL) {
      lastArtURL = url;
      // Decoding is asynchronous and two of them can be in flight at once, so
      // they can also finish out of order — at which point the older sleeve
      // wins and the case wears the wrong cover until the next track. Stamp
      // each request and let only the newest one land.
      var seq = ++artSeq;
      var img = new Image();
      img.onload = function () {
        if (seq !== artSeq) return;
        offerSleeve(squareCanvas(img));
      };
      img.onerror = function () {
        if (seq !== artSeq) return;
        // A sleeve we cannot decode is the same as no sleeve: draw one.
        lastArtURL = null;
        offerSleeve(placeholderCover(meta.album || meta.title, meta.artist));
      };
      img.src = url;
    } else if (!url) {
      // No artwork at all. Redraw the placeholder whenever the track changes so
      // it always names what is actually playing.
      if (lastArtURL !== null || !album) {
        lastArtURL = null;
        artSeq++;                        // no sleeve outranks one still in flight
        offerSleeve(placeholderCover(meta.album || meta.title, meta.artist));
      }
    }

    /* Nothing turning and nothing about to: repaint whatever the track change
       has dated, right where the case stands. While a reveal is armed or
       running, being out of date is the whole point and the lap does it. But
       with `spinOnChange` off no lap ever runs, and this is the only thing
       that keeps the case current. */
    if (phase === PHASE_NONE && !turnArmed) paintStaleFaces();
    invalidate();
  });

  var connect = guard('connect failed', function () {
    var N = window.NepTunes;
    if (!N) { fail('window.NepTunes missing'); return; }
    N.on('statechange', function (s) { applyState(s); });
    N.on('settingschange', function () { readSettings(); invalidate(); });
    N.on('themechange', function () { invalidate(); });
    readSettings();
    if (N.state) applyState(N.state);      // may already have arrived
  });

  /* ===================== loop ===================== */

  var t0 = performance.now();
  var lastDraw = 0;
  var dirtyUntil = 0;

  // Rendering only while something is actually moving matters here: the widget
  // sits on the desktop for hours and a permanently spinning GL loop is a real
  // battery cost.
  function invalidate() { dirtyUntil = performance.now() + 250; }

  function animating(now) {
    /* Unconditional: rAF is frozen whenever the widget is occluded, so a
       release can expire while nothing is running. Gating on the elapsed time
       here meant waking up past the deadline and never returning at all — the
       case just stayed wherever it was left. tick() clears releaseAt when the
       journey home is actually finished. */
    if (releaseAt) return true;
    if (phase !== PHASE_NONE || turnArmed) return true;
    if (Math.abs(lidT - lidTarget) > 0.001) return true;
    if (opts.idleMotion && !releaseAt) return true;
    return now < dirtyUntil;
  }

  var tick = guard('render failed', function () {
    var now = performance.now();
    var capFps = quality().fps;
    if (capFps && now - lastDraw < 1000 / capFps) return;
    if (!animating(now)) return;
    var dt = Math.min((now - lastDraw) / 1000, 0.05);
    lastDraw = now;
    var t = (now - t0) / 1000;

    var settle = 1;
    if (releaseAt) {
      var e = (now - releaseAt) / 1000;
      if (e < HOLD) {
        yaw = homeYaw; pitch = homePitch;   // frozen exactly where it was left
        settle = 0;
      } else {
        var k = Math.min(1, (e - HOLD) / RETURN);
        var sm = k * k * (3 - 2 * k);
        yaw = homeYaw * (1 - sm);
        pitch = homePitch * (1 - sm);
        settle = sm;
        if (k >= 1) { yaw = 0; pitch = 0; homeYaw = 0; homePitch = 0; releaseAt = 0; }
      }
    }

    // Same-album tracks never deliver new bytes, so release the armed turn.
    if (turnArmed && now - turnArmedAt > 1500) fireTurn();

    lidT += (lidTarget - lidT) * Math.min(1, dt * 7.5);
    // Both poses are needed. The shut pose is captured unconditionally once the
    // disc is seated, but the open pose only exists if the lid/base branch ran,
    // so guarding on one of them alone crashes slerp with a null argument.
    if (parts.lid && lidShutQ && lidOpenQ) {
      parts.lid.quaternion.slerpQuaternions(lidShutQ, lidOpenQ, lidT);
      if (lidShutP && lidOpenP) parts.lid.position.lerpVectors(lidShutP, lidOpenP, lidT);
    }


    var spin = turnAngle(now);         // also walks yaw/pitch home
    if (turnStart) settle = 0;         // no idle drift mid-turn
    var amp = opts.idleMotion ? 1 : 0;
    /* Rest is square-on, and the drift is a breath around it rather than a
       pose — at the original amplitude the case swung 17 degrees and was
       basically never facing you straight.

       Cutting it to a 4.9 degree swing fixed that and went too far the other
       way: on a 37 second period the case moves 0.8 degrees a second, which is
       slow enough to read as not moving at all. Measured over 12 seconds it
       travelled from 0.3 to 4.6 degrees and back — real, and invisible.

       Two frequencies rather than one, so it wanders instead of ticking back
       and forth: about 10 degrees of yaw and 4.5 of tilt, over 11 and 20
       seconds, which comes to a peak of 4.6 degrees a second. Slow enough to
       read as a breath, fast enough to read at all. */
    fitFor(lidT);                      // an opening case needs a wider frame
    var driftY = (Math.sin(t * 0.58) * 0.105 + Math.sin(t * 0.32 + 1.1) * 0.062) * settle * amp;
    var driftX = (Math.sin(t * 0.43) * 0.050 + Math.sin(t * 0.26 + 0.6) * 0.028) * settle * amp;
    var ry = yaw + spin + driftY;
    var rx = pitch + driftX;
    tilt.rotation.y = ry;
    tilt.rotation.x = rx;
    trackPose(dt, ry, rx);

    renderer.render(scene, camera);
  });

  // An off-screen window may have its rAF throttled; let a harness ask for one
  // frame directly. Harmless in production, nothing calls it there.
  /* Development hook. Exposes the scene so a tuner harness can drive the light
     rig live; nothing in the shipped widget reads it. */
  window.__nt = {
    THREE: THREE, renderer: renderer, scene: scene, camera: camera,
    key: key, fill: warm, parts: parts,
    redraw: function () { invalidate(); },
    // rAF is frozen while the window is occluded or off-screen, so a harness
    // that never becomes visible has to drive the loop itself.
    step: function () { invalidate(); tick(); },
    // Put the case in an exact pose and hold it there, so a harness can measure
    // a silhouette instead of trying to hit one with synthetic scroll events.
    pose: function (y, pi) {
      yaw = homeYaw = y; pitch = homePitch = pi;
      releaseAt = performance.now(); invalidate();
    },
    open: function (v) { lidTarget = v ? 1 : 0; lidT = lidTarget; invalidate(); },
    // Park the case wherever it is put, for a tuner. The widget holds a pose
    // for three seconds and then travels home, which is right on a desktop and
    // useless when you are trying to look at one angle.
    holdPose: function (on) { HOLD = on ? 1e9 : 3.0; invalidate(); },
    fit: function () {
      return {
        shut: halfShut.toArray().map(function (v) { return +v.toFixed(2); }),
        open: halfOpen.toArray().map(function (v) { return +v.toFixed(2); }),
        budget: [+fitBudget.tx.toFixed(4), +fitBudget.ty.toFixed(4)],
        camZ: +camera.position.z.toFixed(2), lidT: +lidT.toFixed(3), fittedFor: fittedFor,
        rot: [+tilt.rotation.x.toFixed(3), +tilt.rotation.y.toFixed(3)],
        yaw: +yaw.toFixed(3), pitch: +pitch.toFixed(3), phase: phase, rel: releaseAt ? 1 : 0
      };
    },
    materials: function () {
      var out = [];
      tilt.traverse(function (o) {
        if (!o.isMesh) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) {
          if (out.indexOf(m) === -1) out.push(m);
        });
      });
      return out;
    }
  };

  window.__ntForceRender = function () {
    try { renderer.render(scene, camera); } catch (e) { /* not built yet */ }
  };

  (function raf() { tick(); requestAnimationFrame(raf); })();

  /* ===================== boot ===================== */

  applyQuality();
  try {
    parseGLB(window.NT_CASE_B64, function (caseGltf) {
      parseGLB(window.NT_DISC_B64, function (discGltf) {
        build(caseGltf.scene, discGltf.scene);
      });
    });
  } catch (e) {
    fail('boot failed', e);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', connect);
  } else {
    connect();
  }
})();
