import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The five resizable card widgets resize from an invisible handle in the card's bottom-right
// corner. NepTunes clips a card to the system's continuous corner (R = 27px, reaching ~41px along
// each edge), and a click on a clipped-away pixel falls through to the desktop, so a 16-20px
// handle kept only a sliver of itself (46% / 62%, measured in WebKit). And the handle's
// `cursor: nwse-resize` is almost never seen: the widget helper runs in the background, and macOS
// gives the cursor to the active app only. So each of these widgets:
//
//   * grows the handle to 32x32 at the card's bottom-right corner (84% grabbable after the clip),
//     without taking a control's clicks,
//   * draws a grip on hover: a short stroke along the card's corner, inset 6px, that takes no
//     pointer — the handle stays the hit target,
//
// with the same geometry and the same timing in all five. These pin the CSS and markup; the
// reveal itself is measured in a real WKWebView by _dev/hover-check (one case per widget).

const WIDGETS = ['Activity', 'Artwork', 'GenreTrends', 'ListeningClock', 'V3'];

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = (w) => read(`../${w}.nepget/styles.css`).replace(/\/\*[\s\S]*?\*\//g, '');
const html = (w) => read(`../${w}.nepget/index.html`).replace(/<!--[\s\S]*?-->/g, '');

/** The declarations every top-level rule listing exactly `selector` sets, later rules winning, or null. */
function rule(text, selector) {
  const want = selector.replace(/\s+/g, ' ').trim();
  // Only top-level rules: drop @media blocks (and their nested rules) first.
  const flat = text.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  let decls = null;
  for (const [, sel, body] of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = sel.split(',').map((s) => s.replace(/\s+/g, ' ').trim());
    if (!selectors.includes(want)) continue;
    decls ??= {};
    for (const d of body.split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      decls[d.slice(0, i).trim()] = d.slice(i + 1).replace(/\s+/g, ' ').trim();
    }
  }
  return decls;
}

/** The fallback radius a widget gives `.nt-card`, as a px string ("12px"). */
function fallbackRadius(w) {
  const text = css(w);
  const card = rule(text, w === 'V3' || w === 'Artwork' ? '.widget' : '.card');
  const radius = card['border-radius'];
  if (/^\d+px$/.test(radius)) return radius;
  const name = radius.match(/^var\((--[\w-]+)\)$/)[1];
  return rule(text, ':root')[name];
}

// The bottom-right corner of the host's continuous corner (card-shape.css, a byte copy of
// WidgetCardShape.styleSheet()), as three cubics in a box of 1.52866 x 1.52866 radii: from the end
// of the right edge, down round the corner, to the start of the bottom edge.
function cornerCubics() {
  const shape = read('./card-shape.css');
  const c = [...shape.matchAll(/([\d.]+) \* var\(--nt-card-radius\)/g)].map((m) => Number(m[1]));
  // The coefficients the shape uses, in order of first appearance.
  const [k, b, d, e, f, g, h] = [...new Set(c)];  // 1.52866 0.074911 0.631494 1.08849 0.868407 0.16906 0.372824
  assert.equal(k, 1.52866);
  const r = (v) => k - v;
  return [
    [[k, 0], [k, r(e)], [k, r(f)], [r(b), r(d)]],
    [[r(b), r(d)], [r(g), r(h)], [r(h), r(g)], [r(d), r(b)]],
    [[r(d), r(b)], [r(f), k], [r(e), k], [0, k]],
  ];
}

/** `M x y C … C …` as cubics. */
function parseCubics(d) {
  const n = d.match(/-?[\d.]+/g).map(Number);
  assert.match(d, /^M[\d.]+ [\d.]+( C(?:[\d.]+ ){5}[\d.]+)+$/, `not a single M…C run: ${d}`);
  const cubics = [];
  let start = [n[0], n[1]];
  for (let i = 2; i < n.length; i += 6) {
    const cubic = [start, [n[i], n[i + 1]], [n[i + 2], n[i + 3]], [n[i + 4], n[i + 5]]];
    cubics.push(cubic);
    start = cubic[3];
  }
  return cubics;
}

/** Points along cubics, each with its arc length from the start. */
function sample(cubics, perCubic) {
  const out = [];
  let length = 0, prev = null;
  for (const [p0, p1, p2, p3] of cubics) {
    for (let i = 0; i <= perCubic; i++) {
      const t = i / perCubic, u = 1 - t;
      const p = [0, 1].map((a) => u * u * u * p0[a] + 3 * u * u * t * p1[a] + 3 * u * t * t * p2[a] + t * t * t * p3[a]);
      if (prev) length += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      out.push({ p, length });
      prev = p;
    }
  }
  return out;
}

/** The grip's <svg> and its one <path>, from index.html. */
function gripMarkup(w) {
  const m = html(w).match(/<svg class="resize-grip"([^>]*)>\s*<path d="([^"]+)"([^>]*?)\/?>(?:<\/path>)?\s*<\/svg>/);
  assert.ok(m, `${w}: no <svg class="resize-grip"><path d="…"></svg> in index.html`);
  return { attrs: m[1], d: m[2], pathAttrs: m[3] };
}

for (const w of WIDGETS) {
  test(`${w}: the resize handle is a 32x32 hit area at the card's bottom-right corner`, () => {
    const handle = rule(css(w), '.resize-handle');
    assert.ok(handle, `${w}: no .resize-handle rule`);
    assert.equal(handle.position, 'absolute');
    assert.equal(handle.right, '0');
    assert.equal(handle.bottom, '0');
    assert.equal(handle.width, '32px');
    assert.equal(handle.height, '32px');
    assert.equal(handle.cursor, 'nwse-resize');
    // Physical, never mirrored: it resizes the window, whose origin does not flip under RTL.
    assert.ok(!('inset-inline-end' in handle) && !('left' in handle), `${w}: the handle must stay physical`);
  });

  test(`${w}: the grip lives in the card, after the content and before the handle`, () => {
    const page = html(w);
    const grip = page.indexOf('class="resize-grip"');
    const handle = page.indexOf('class="resize-handle"');
    const card = page.search(/class="[^"]*\bnt-card\b/);
    assert.ok(grip > card && grip < handle, `${w}: the grip must sit inside .nt-card, just before the handle`);
    assert.match(gripMarkup(w).attrs, /aria-hidden="true"/);
  });

  test(`${w}: the grip takes no pointer and is hidden until nt-hover`, () => {
    const text = css(w);
    const grip = rule(text, '.resize-grip');
    assert.ok(grip, `${w}: no .resize-grip rule`);
    assert.equal(grip['pointer-events'], 'none', 'the handle under it stays the hit target');
    assert.equal(grip.opacity, '0');
    const shown = rule(text, 'html.nt-hover .resize-grip');
    assert.ok(shown, `${w}: no html.nt-hover .resize-grip rule — never gate on bare :hover`);
    assert.equal(shown.opacity, '1');
    assert.ok(!/:hover/.test(text.replace(/html\.nt-hover/g, '')), `${w}: a :hover rule latches in a widget`);
  });

  test(`${w}: the grip follows the card radius, with the widget's own corner as the fallback`, () => {
    const grip = rule(css(w), '.resize-grip');
    const fallback = fallbackRadius(w);
    assert.equal(grip['--grip-radius'], `max(calc(var(--nt-card-radius, ${fallback}) - 6px), 10px)`);
    assert.equal(grip.width, 'calc(2.52866 * var(--grip-radius))');
    assert.equal(grip.height, 'calc(2.52866 * var(--grip-radius))');
    assert.equal(grip.right, 'calc(6px - 0.5 * var(--grip-radius))');
    assert.equal(grip.bottom, 'calc(6px - 0.5 * var(--grip-radius))');
  });

  test(`${w}: round caps and halo fit inside the SVG even while opacity is composited`, () => {
    const { attrs, d } = gripMarkup(w);
    const viewBox = attrs.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
    const points = sample(parseCubics(d), 100).map(({ p }) => p);
    // The smallest grip radius is 10 CSS px. A 3px stroke plus its 1px halo needs
    // 2.5px on either side even when WebKit clips a composited SVG to its viewport.
    const margin = 2.5 / 10;
    for (const p of points) for (let axis = 0; axis < 2; axis++) {
      assert.ok(p[axis] - margin >= viewBox[axis], 'stroke escapes the near viewport edge');
      assert.ok(p[axis] + margin <= viewBox[axis] + viewBox[axis + 2],
        'round cap/halo escapes the far viewport edge during the fade');
    }
  });

  test(`${w}: the grip's stroke traces the middle 60% of the host's continuous corner`, () => {
    const { attrs, d } = gripMarkup(w);
    assert.match(attrs, /viewBox="-0\.5 -0\.5 2\.52866 2\.52866"/);
    const corner = sample(cornerCubics(), 4000);
    const total = corner[corner.length - 1].length;
    const nearest = (p) => corner.reduce((best, c) => {
      const dist = Math.hypot(c.p[0] - p[0], c.p[1] - p[1]);
      return dist < best.dist ? { dist, length: c.length } : best;
    }, { dist: Infinity });
    const grip = sample(parseCubics(d), 40);
    // On the curve everywhere (1e-3 radii is 0.02px at the 21px the grip is drawn at)...
    for (const { p } of grip) assert.ok(nearest(p).dist < 1e-3, `${p} is off the corner`);
    // ...from 20% to 80% of the way round it, so the ends sit where the curve is still turning.
    assert.ok(Math.abs(nearest(grip[0].p).length / total - 0.2) < 0.005, 'starts at 20%');
    assert.ok(Math.abs(nearest(grip[grip.length - 1].p).length / total - 0.8) < 0.005, 'ends at 80%');
  });
}

test('the five grips are identical apart from the fallback radius and the theme ink', () => {
  const pick = (w) => {
    const text = css(w);
    const grip = { ...rule(text, '.resize-grip') };
    delete grip['--grip-radius'];
    return {
      grip,
      path: rule(text, '.resize-grip path'),
      shown: rule(text, 'html.nt-hover .resize-grip'),
      markup: gripMarkup(w),
    };
  };
  const first = pick(WIDGETS[0]);
  for (const w of WIDGETS.slice(1)) assert.deepEqual(pick(w), first, w);
  // A 3px stroke with round caps, the same width at every size, trimmed to the corner's middle.
  assert.equal(first.path['stroke-width'], '3');
  assert.equal(first.path['stroke-linecap'], 'round');
  assert.equal(first.path['vector-effect'], 'non-scaling-stroke');
  assert.equal(first.path.stroke, 'var(--grip-ink)');
  // V3's hover timing: in after the 0.13s hover gate, out at once.
  assert.equal(first.grip.transition, 'opacity 0.1s linear');
  assert.equal(first.shown.transition, 'opacity 0.15s linear 0.13s');
});

test('every widget defines the grip ink for each of its themes', () => {
  // V3 is dark only (one palette); the others have a dark :root, a .theme-light override and the
  // same override for .theme-auto under prefers-color-scheme: light.
  for (const w of WIDGETS) {
    const text = read(`../${w}.nepget/styles.css`).replace(/\/\*[\s\S]*?\*\//g, '');
    const palettes = w === 'V3' ? 1 : 3;
    assert.equal(text.match(/--grip-ink:/g)?.length, palettes, `${w}: --grip-ink per palette`);
    assert.equal(text.match(/--grip-halo:/g)?.length, palettes, `${w}: --grip-halo per palette`);
  }
});

// ---------------------------------------------------------------------------
// The bigger handle must not take a control's clicks. Measured in WebKit at every window size
// from minSize up: only two widgets have a control within 32px of the corner, and only near
// their minimum size.
// ---------------------------------------------------------------------------

test('Artwork: the transport and Open player stay above the handle', () => {
  const text = css('Artwork');
  const handle = Number(rule(text, '.resize-handle')['z-index']);
  const controls = rule(text, '.controls');
  // The row is full-bleed, so it takes no pointer itself: only its buttons outrank the handle,
  // and the rest of the corner still resizes.
  assert.ok(Number(controls['z-index']) > handle, '.controls must stack above the handle');
  assert.equal(controls['pointer-events'], 'none');
  assert.equal(rule(text, '.controls .control-btn')['pointer-events'], 'auto');
  assert.ok(Number(rule(text, '.empty-open')['z-index']) > handle, '.empty-open must stack above the handle');
});

test("V3: the handle's notch clears the transport row at the minimum size", () => {
  // The transport row is centred in the card: three 34px buttons 11px apart (124px wide), the
  // second of two rows 17px apart, so its last button's box ends at (C/2 + 62, C/2 + 42.5) in a
  // card of side C — the window minus body's 20px gutter on each side. The handle starts at
  // C - 32, so the button reaches into it by (94 - C/2, 74.5 - C/2), most at minSize.
  const manifest = JSON.parse(read('../V3.nepget/manifest.json'));
  const c = manifest.minSize.width - 40;
  const into = { x: 94 - c / 2, y: 74.5 - c / 2 };
  const clip = rule(css('V3'), '.resize-handle')['clip-path'];
  const m = clip.match(/^polygon\((\d+)px 0, 100% 0, 100% 100%, 0 100%, 0 (\d+(?:\.\d+)?)px, \1px \2px\)$/);
  assert.ok(m, `unexpected clip-path: ${clip}`);
  assert.ok(Number(m[1]) >= into.x, `notch ${m[1]}px wide, button reaches ${into.x}px`);
  assert.ok(Number(m[2]) >= into.y, `notch ${m[2]}px tall, button reaches ${into.y}px`);
});

test('the unclipped grip ships as a patch release of each widget', () => {
  const versions = Object.fromEntries(WIDGETS.map((w) => {
    const manifest = JSON.parse(read(`../${w}.nepget/manifest.json`));
    assert.equal(manifest.minNepTunesVersion, '4.1.0', `${w}: no new host requirement`);
    return [w, manifest.version];
  }));
  assert.deepEqual(versions, {
    Activity: '1.2.1', Artwork: '1.7.1', GenreTrends: '1.2.1', ListeningClock: '1.2.1', V3: '1.5.1',
  });
});
