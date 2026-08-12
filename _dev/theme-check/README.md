# theme-check

Verifies that every sample widget reacts correctly when macOS switches between light and
dark automatically.

```bash
./run.sh                                   # this checkout
./run.sh "/path/to/other/SampleWidgets"    # another tree, e.g. to confirm a baseline fails
```

## Why this exists rather than a unit test

The bug this was written for — widgets not following an automatic light→dark switch — was
invisible to every existing test, and a pure-function test could not have caught it. Nothing
was miscalculating a colour; the widgets simply never learned the desktop had changed. The
only way to observe that is to render the real bundle and flip the real appearance.

So this loads each `.nepget` in a `WKWebView` configured exactly like the widget host
(non-persistent store, `drawsBackground = false`, the API injected at document start), pushes
state and settings the way `WidgetJSBridge` does, flips `NSApp.appearance`, and diffs what the
page renders. The injected API is extracted verbatim from `WidgetJSBridge.swift` by
`extract-api.py`, so the check cannot drift from the JS that actually ships.

`NSApp.appearance` is used instead of really toggling System Settings: it drives the same
`effectiveAppearance` → WebKit `prefers-color-scheme` path a genuine system switch does, and
it doesn't disturb the developer's desktop.

## What it asserts

`spec.json` lists cases of `{widget, settings, expect}`:

- `react`  — the widget is set to its follow-the-system option (`theme: auto`,
  `textColor: system`) and **must** re-theme on a flip.
- `stable` — the widget is pinned to an explicit choice (`theme: dark`, `textColor: white`)
  and **must not** move. A system switch may never overrule what the user picked.

Two traps worth knowing, both learned the hard way here:

- **Icons are asserted separately.** SF Symbols are PNGs the native side rasterises with the
  tint baked in, so they cannot follow CSS. A widget whose panel flips via a CSS media query
  will look like it "reacted" while every icon stays stale — so the icon tints are diffed on
  their own. The check counts only icons with a layout box: an icon inside a hidden
  placeholder isn't user-visible, and WebKit doesn't keep the inherited custom properties of
  a `display:none` subtree up to date anyway.
- **Widgets disagree about where the theme lives.** `<html>` (Glass, Stack), `<body>`
  (Minimal, FullPlayer) or `#widget` (Charts). The fingerprint reads all three; reading only
  `<html>`/`<body>` silently reports "nothing changed" for Charts.

## Adding a widget

Add `react` and `stable` cases to `spec.json`. If the widget only renders the surface under
test in a particular configuration, put that in `settings` — e.g. Minimal only shows icons
with `showControls: true`, and Vinyl only renders text with `labelPosition` set.
