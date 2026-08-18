# preview-shot

Renders a bundle's `preview.jpg` **from the bundle** — the real HTML/CSS/JS in a `WKWebView`
configured like the widget host, the real injected API, real SF Symbols rasterised natively —
then composites the shot onto the gallery backdrop.

```bash
./run.sh                 # every widget listed in spec.json
./run.sh Glass           # just this one
```

It writes `<Bundle>.nepget/preview.jpg` in place, 960×400, which is what the in-app picker and the
web gallery expect. **Re-sign and re-package afterwards** — `preview.jpg` is inside the bundle, so
it is covered by `bundle.sig`, and the site serves a copy of it as the widget's screenshot:

```bash
node Scripts/widget-tools.mjs embed-sign SampleWidgets/Glass.nepget --key Scripts/.keys/first-party-author.pem
node Scripts/package-widgets.mjs Glass
```

## Why this exists

The previews in this tree were drawn, not rendered: `_dev/make-previews.py` paints a PIL
impression of each widget — panels as flat rounded rectangles, transport glyphs as hand-plotted
triangles. An impression drifts from the bundle the moment either changes, and it cannot show what
the widget actually does. Glass's showed a flat dark slab where the real widget has frosted glass
over the album cover, with the cover itself reduced to a plain blue gradient. It was a picture of a
different widget.

This renders the widget instead, so what you see in the picker is what installs.

## How it stages a render

- **Settings** are the manifest's own defaults — a preview shows the widget as it arrives, not as
  someone configured it. `spec.json` may override per widget.
- **The desktop appearance is pinned dark**, so a `theme: auto` bundle resolves the same way on
  any Mac that runs this, and lands in the same dark grid as the drawn previews.
- **The album art is generated** — a diagonal gradient with a soft highlight, from `spec.json`'s
  two stops. A preview ships inside the app and on the web, so it cannot borrow a real cover, but
  the widgets that tint themselves from the artwork still need something to read.
- **The state is a paused track**, so the transport shows a play glyph rather than a pause one.
- **Icons are waited for, not slept on.** Every SF Symbol is an async round-trip to the bridge and
  several bundles re-request the whole set from their `settingschange` handler; the shot is taken
  once the count of loaded icons stops moving. A symbol name that does not exist on this OS fails
  the run rather than shipping a preview with a hole in it.
- **Transitions are cut before the shot.** Nothing here is ever ordered front, so WebKit has no
  display link and a CSS transition never progresses — the artwork's own fade-in would leave every
  cover at opacity 0 and every preview showing the no-artwork placeholder. (Same trap as
  `_dev/hover-check`, for the same reason.)
- **The snapshot keeps its alpha**, which needs `underPageBackgroundColor = .clear` as well as
  `drawsBackground = false`; without it the shot comes back on an opaque white page and the
  widget's drop shadow lands on a white card. The window's transparent shadow gutter is part of
  the shot, so the shadow falls on the backdrop exactly as it falls on a desktop.
- **The backdrop matches `make-previews.py`'s** — near-black vertical gradient plus a faint accent
  glow top-left — so a re-rendered preview still belongs in a grid with the drawn ones.

## Traps it has already fallen into

- **Colours arrive as `rgba()`, not hex.** `sfsymbols.js` resolves a glyph's tint with
  `getComputedStyle`, and computed style reports a custom property **verbatim as authored** — so
  a bundle declaring `--icon-color: rgba(255, 255, 255, 0.9)` sends exactly that string. The
  parser here scanned for hex digits, found none, and rasterised every glyph **black**, on a dark
  panel, in a shipped preview, while the same widget drew them white on a real desktop because
  the shipping rasterizer (`NSColor(hexString:)` in NepTunesKit) accepts the functional notation.
  This harness has to accept everything that one does, or it is not previewing the widget the
  user gets.

## What it cannot render yet

The fake native side answers `symbol` and nothing else, so a widget whose content comes from
Last.fm (`Charts`, `Scrobbles`) renders empty and is not in `spec.json`. Those need canned
`lastFm.*` responses in the bridge before they can be shot. Everything else is a matter of adding
a `{ "name": "…" }` entry — and once a widget is listed here, its drawn twin in
`make-previews.py` is dead code for that widget.
