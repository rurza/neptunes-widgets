(function (factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.NTKit = api;
  else if (typeof self !== 'undefined') self.NTKit = api;
})(function () {
  'use strict';

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function formatTime(sec) {
    sec = Number(sec);
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + pad2(s);
  }

  /** The host's BCP-47 tag, or null before the host's first state push. */
  function hostLocale() {
    // `window` is absent under the node test runner, and state is null until the host
    // pushes in webView(_:didFinish:) — after DOMContentLoaded. Same typeof guard the
    // module wrapper above uses.
    if (typeof window === 'undefined') return null;
    var st = window.NepTunes && window.NepTunes.state;
    return (st && st.locale) || null;
  }

  function formatCount(n, locale) {
    n = Math.floor(Number(n));
    if (!isFinite(n) || n < 0) n = 0;
    // Never a hard-coded tag: 'en-US' pinned US grouping in all fifteen locales and Latin
    // digits in ar-SA, which uses ٤٧٬٢١٣. `locale` is for tests and for a widget that
    // already has the state in hand; otherwise read it off the host.
    var tag = locale || hostLocale();
    // toLocaleString throws RangeError on a malformed tag — an ICU identifier ("ar_SA")
    // rather than BCP-47 ("ar-SA") does it. This runs on every state push, so a bad tag
    // from the host has to degrade to the runtime default, not take the widget down.
    if (tag) {
      try { return n.toLocaleString(tag); } catch (e) { /* fall through to the default */ }
    }
    return n.toLocaleString();
  }

  function toMs(v) {
    if (v == null) return null;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; // < 1e12 => unix seconds
    var t = Date.parse(v);
    return isNaN(t) ? null : t;
  }

  function relativeTime(date, now) {
    var t = toMs(date); if (t == null) return '';
    var ref = now == null ? Date.now() : toMs(now);
    var min = Math.floor(Math.max(0, ref - t) / 60000);
    if (min < 1) return 'now';
    if (min < 60) return min + 'm';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h';
    var day = Math.floor(hr / 24);
    if (day === 1) return 'yesterday';
    if (day < 7) return day + 'd';
    return Math.floor(day / 7) + 'w';
  }

  // sample: {position, duration, playing, timestamp(ISO) | timestampMs}
  function clock(sample, nowFn) {
    var now = nowFn || function () { return Date.now(); };
    var base = Number(sample.position) || 0;
    var dur = Number(sample.duration) || 0;
    var playing = !!sample.playing;
    var t0 = sample.timestampMs != null ? sample.timestampMs
           : (sample.timestamp ? Date.parse(sample.timestamp) : now());
    return function () {
      var pos = playing ? base + (now() - t0) / 1000 : base;
      if (dur > 0) pos = Math.min(pos, dur);
      return pos < 0 ? 0 : pos;
    };
  }

  function luminance(rgb) {
    var a = [rgb[0], rgb[1], rgb[2]].map(function (v) {
      v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }

  function onColor(rgb) { return luminance(rgb) > 0.45 ? [0, 0, 0] : [255, 255, 255]; }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var h = 0, s = 0, l = (mx + mn) / 2;
    if (d) {
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, s, l];
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs((h / 60) % 2 - 1));
    var m = l - c / 2, r1, g1, b1;
    if (h < 60) { r1 = c; g1 = x; b1 = 0; }
    else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
    else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
    else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
    else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
    else { r1 = c; g1 = 0; b1 = x; }
    return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
  }

  function contrastRatio(a, b) {
    var la = luminance(a), lb = luminance(b);
    var hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  // Adjust an accent so it stays legible used as TEXT/numerals against a near-black
  // (dark=true) or near-white (dark=false) panel, preserving hue. Steps lightness toward
  // the panel-opposite end until it clears WCAG 4.5:1 — so even high-luminance hues
  // (yellow on white, navy on black) end up readable rather than vanishing.
  function legibleAccent(rgb, dark) {
    var panel = dark ? [12, 12, 14] : [251, 251, 252];
    var hsl = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    var h = hsl[0], s = hsl[1], l = hsl[2];
    if (s > 0.12) s = Math.max(s, 0.45); // keep it colourful, not washed to grey
    l = dark ? Math.max(l, 0.55) : Math.min(l, 0.5);
    var out = hslToRgb(h, s, l), guard = 0;
    while (contrastRatio(out, panel) < 4.5 && guard < 60) {
      l += dark ? 0.02 : -0.02;
      if (l >= 1) { out = hslToRgb(h, s, 1); break; }
      if (l <= 0) { out = hslToRgb(h, s, 0); break; }
      out = hslToRgb(h, s, l);
      guard++;
    }
    return out;
  }

  // Step a colour's lightness toward the panel-opposite end until it clears `target`
  // contrast against the panel, leaving hue and saturation where they are. This is the
  // half of `legibleAccent` that applies to a colour which is *meant* to be quiet:
  // legibleAccent also re-saturates and clamps lightness first, which is right for an
  // accent and would undo the point of a muted tone.
  function liftToContrast(rgb, dark, target) {
    var panel = dark ? [12, 12, 14] : [251, 251, 252];
    if (contrastRatio(rgb, panel) >= target) return rgb;
    var hsl = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    var h = hsl[0], s = hsl[1], l = hsl[2], out = rgb, guard = 0;
    while (contrastRatio(out, panel) < target && guard < 60) {
      l += dark ? 0.02 : -0.02;
      if (l >= 1) return hslToRgb(h, s, 1);
      if (l <= 0) return hslToRgb(h, s, 0);
      out = hslToRgb(h, s, l);
      guard++;
    }
    return out;
  }

  // '#rrggbb' or '#rgb' (hash optional) to [r,g,b], or null if it is not that.
  //
  // Strict on purpose. parseInt stops at the first character it cannot read and returns
  // the digits it got up to there, so parseInt('FF375G', 16) is 1045365 rather than NaN:
  // an isNaN() guard passes it straight through and the widget paints a colour nobody
  // picked. Only a full-width hex test rejects it.
  function hexToRgb(hex) {
    if (typeof hex !== 'string') return null;
    var m = hex.charAt(0) === '#' ? hex.slice(1) : hex;
    if (m.length === 3) m = m[0] + m[0] + m[1] + m[1] + m[2] + m[2];
    if (!/^[0-9a-f]{6}$/i.test(m)) return null;
    var n = parseInt(m, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // The {accent,on,muted} palette for a colour the USER picked, rather than one pulled
  // out of artwork. Same shape and same 50%-toward-grey muted as `paletteFromPixels`,
  // with one difference that matters: that function can only ever return a mid-vivid
  // pixel, so its muted always lands somewhere readable. A colour well hands over pure
  // black and pure white too, and `--muted` paints body text, so muted is pushed back
  // onto the panel here rather than left wherever the arithmetic put it.
  function fixedPalette(rgb, dark) {
    var muted = rgb.map(function (v) { return Math.round(v * 0.5 + 110 * 0.5); });
    return { accent: rgb, on: onColor(rgb), muted: liftToContrast(muted, dark !== false, 4.5) };
  }

  // Is the widget's panel dark? Picks which way `legibleAccent` should push.
  function panelIsDark(theme) {
    if (theme === 'light') return false;
    if (theme === 'dark') return true;
    // auto / unset: follow the system, defaulting to dark.
    return !(typeof window !== 'undefined' && window.matchMedia &&
             window.matchMedia('(prefers-color-scheme: light)').matches);
  }

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, mx ? d / mx : 0, mx];
  }

  // rgba: flat array / Uint8ClampedArray of RGBA bytes
  function paletteFromPixels(rgba) {
    var buckets = {}, best = null, bestScore = -1, sum = [0, 0, 0], n = 0;
    for (var i = 0; i + 3 < rgba.length; i += 4) {
      var r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], al = rgba[i + 3];
      if (al < 8) continue;
      sum[0] += r; sum[1] += g; sum[2] += b; n++;
      var hsv = rgbToHsv(r, g, b);
      // weight vivid, mid-bright pixels; ignore near-grey / near-black / near-white
      if (hsv[1] < 0.25 || hsv[2] < 0.15 || hsv[2] > 0.97) continue;
      var key = Math.round(hsv[0] / 24) + '|' + Math.round(hsv[1] * 4) + '|' + Math.round(hsv[2] * 4);
      var bk = buckets[key] || (buckets[key] = { r: 0, g: 0, b: 0, c: 0 });
      bk.r += r; bk.g += g; bk.b += b; bk.c++;
      var score = bk.c * (0.5 + hsv[1]) * (0.5 + hsv[2]);
      if (score > bestScore) { bestScore = score; best = bk; }
    }
    var accent;
    if (best) accent = [Math.round(best.r / best.c), Math.round(best.g / best.c), Math.round(best.b / best.c)];
    else if (n) accent = [Math.round(sum[0] / n), Math.round(sum[1] / n), Math.round(sum[2] / n)];
    else accent = [124, 124, 132];
    var muted = accent.map(function (v) { return Math.round(v * 0.5 + 110 * 0.5); });
    return { accent: accent, on: onColor(accent), muted: muted };
  }

  // ---- DOM glue (browser only) ----
  var NEUTRAL = { accent: [124, 124, 132], on: [255, 255, 255], muted: [150, 150, 156] };
  var _cache = {};
  function accent(dataURL) {
    if (!dataURL) return Promise.resolve(NEUTRAL);
    if (_cache[dataURL]) return Promise.resolve(_cache[dataURL]);
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement('canvas'); c.width = 32; c.height = 32;
          var ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, 32, 32);
          var data = ctx.getImageData(0, 0, 32, 32).data;
          var p = paletteFromPixels(data);
          _cache[dataURL] = p; resolve(p);
        } catch (e) {
          resolve(NEUTRAL);
        }
      };
      img.onerror = function () { resolve(NEUTRAL); };
      img.src = dataURL;
    });
  }

  function _rgb(a) { return 'rgb(' + a[0] + ',' + a[1] + ',' + a[2] + ')'; }
  // dark (default true) selects a panel-appropriate, contrast-safe `--accent-ink` for text/
  // numerals; `--accent` stays the raw album colour for fills/markers.
  function applyAccent(el, p, dark) {
    el.style.setProperty('--accent', _rgb(p.accent));
    el.style.setProperty('--on', _rgb(p.on));
    el.style.setProperty('--muted', _rgb(p.muted));
    el.style.setProperty('--accent-ink', _rgb(legibleAccent(p.accent, dark !== false)));
  }

  function fitText(el, opts) {
    opts = opts || {}; var min = opts.min || 14, max = opts.max || 64;
    var parent = el.parentElement; if (!parent) return;
    var lo = min, hi = max, best = min;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      el.style.fontSize = mid + 'px';
      if (el.scrollWidth <= parent.clientWidth && el.scrollHeight <= parent.clientHeight) {
        best = mid; lo = mid + 1;
      } else hi = mid - 1;
    }
    el.style.fontSize = best + 'px';
  }

  // Title/artist to display for a state, collapsing a Spotify ad to a neutral
  // placeholder so the advertiser's own copy never shows. Mirrors the native
  // widget's NowPlayingLayout.displayTitle + WidgetRenderModel.artist logic.
  function displayInfo(state) {
    var track = state && state.track;
    if (!track) return { title: 'Not Playing', artist: '' };
    if (track.isAdvertisement) return { title: 'Advertisement', artist: '' };
    return { title: track.title || 'Unknown Title', artist: track.artist || '' };
  }

  return {
    formatTime: formatTime, formatCount: formatCount, relativeTime: relativeTime,
    clock: clock, paletteFromPixels: paletteFromPixels, luminance: luminance,
    onColor: onColor, legibleAccent: legibleAccent, panelIsDark: panelIsDark,
    hexToRgb: hexToRgb, fixedPalette: fixedPalette,
    accent: accent, applyAccent: applyAccent, fitText: fitText,
    displayInfo: displayInfo
  };
});
