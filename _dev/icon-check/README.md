# icon-check

Verifies, from a real render, that every SF Symbol a bundle draws is painted **1:1** — that its
CSS box is exactly the `data-size` the native side rasterised — so WebKit never resamples the
PNG and the glyph stays sharp.

```bash
./run.sh                                   # this checkout
./run.sh "/path/to/other/SampleWidgets"    # another tree
```

## Why this exists

`window.NepTunes.symbol()` returns a **PNG**, not an SVG: `SFSymbolRasterizer` draws the glyph
into a square canvas of `round(pointSize × devicePixelRatio)` pixels and bakes the tint in. So
the CSS box is not a request — it is a resample instruction. `data-size="18"` in a `20px` box is
a 1.11× upscale of an already-small glyph, and it reads exactly as it sounds: soft edges, mushy
diagonals, a play triangle that looks blurred next to a crisp pause bar drawn at its right size.

Nothing catches this today. It is invisible to `node --check`, invisible to the schema
validator, and invisible to `getComputedStyle` — every box measures exactly what the author
asked for. The two halves of the mismatch also live in *different files*, `data-size` in
`index.html` and the box in `styles.css`, so neither reads as wrong on its own. AGENTS.md has
warned about it since the beginning ("Size `img.sf-icon` explicitly — the PNG is retina") and
seven of the twelve bundles that draw icons drifted anyway.

It reports downscales too, not just upscales. A downscale is the milder fault — WebKit is
resampling *down*, which mostly reads as slightly heavy rather than blurred — but it is still
not the glyph the rasteriser was asked for, and it wastes the raster.

## How it decides

Each case loads the real bundle in a `WKWebView` configured like the widget host (non-persistent
store, `drawsBackground = false`, the API injected at document start, extracted verbatim from
`WidgetJSBridge.swift` by `theme-check/extract-api.py`), pushes settings and a playing track the
way `WidgetJSBridge` does, then reads every visible `img.sf-icon` and compares
`naturalWidth/Height` against `round(boxSize × devicePixelRatio)`.

The fake bridge does **not** link `SFSymbolRasterizer` — the published mirror of this folder
carries no app source, the same reason `api.js` is extracted rather than imported. It reproduces
the rasteriser's *contract* instead: a square PNG of `round(pointSize × deviceScale)` pixels.
That number is what `naturalWidth` reports and the comparison is the whole assertion, so a flat
white square carries it as well as the real glyph would. Symbol *names* are still resolved
through `NSImage(systemSymbolName:)`, which is plain AppKit — a name that does not exist is a
hard failure here rather than a silently empty `<img>` in the shipped widget.

Three traps worth knowing:

- **Hidden icons are skipped, not failed.** Bundles keep both halves of a swap pair in the DOM
  (play/pause, heart/heart.fill) with one `display: none`, and an icon in a `display: none`
  subtree has no box to compare against. A case therefore only needs to cover states that put a
  **new** symbol on screen — not every state.
- **A placeholder glyph needs `"artwork": false`.** The no-artwork `music.note` is hidden
  whenever a cover is present, so a case that sends artwork silently checks the transport row
  and nothing else. Every bundle with a placeholder gets a second, coverless case.
- **Don't sleep, settle.** Icons arrive over an async bridge round-trip each, and several
  bundles re-request the whole set from their `settingschange` handler. The check waits for the
  loaded count to stop moving instead of guessing a duration.

## The stale list

A case with a `"stale": "<why>"` string reports `⚠️` and does **not** fail the run. It is
declared debt, not an exemption: these bundles predate the rule, and clearing each one costs a
`manifest.version` bump, which resets that widget's window size for everyone who already
installed it (`SharedDefaults.widgetSize(for:manifestVersion:)`). That is a call worth making
deliberately, per widget, rather than as a side effect of adding this check.

They are listed in `spec.json` with the actual mismatch, and printed on every run so the debt
stays visible. **A bundle that is not on the list fails hard** — which is the point: a new
widget, or a regression in one already fixed, cannot land quietly.

To clear one: make the CSS box and the `data-size` agree (prefer changing `data-size` to match
the box, so the on-screen size does not move), drop its `stale` line here, then bump, re-sign
and repackage the bundle as usual.

## Adding a case

Append to `spec.json`: `widget` is required and everything else is optional — `label` (defaults
to the widget name; needed when one bundle has two cases), `settings` (**overrides only**, the
manifest's own defaults are merged in first), `width`/`height` (default to
`manifest.defaultSize`), `hover` for icons that only exist under the host's `nt-hover` class,
and `artwork: false` for a placeholder case.
