# shadow-check

Verifies, from the rendered pixels, that a widget's **text** shadow is actually drawn — in every
text colour the widget offers — and that it is not sliced off by the `overflow` its ellipsis
needs.

```bash
./run.sh                                   # this checkout
./run.sh "/path/to/other/SampleWidgets"    # another tree, e.g. to confirm a baseline fails
```

## Why this exists rather than a unit test

Two bugs in `Minimal.nepget`, neither of which any existing test could see.

The first was a settings bug hiding as a styling one: `body.light` set `--text-shadow: none`, so
picking **Text Color: Black** silently disabled the **Shadow Opacity** slider. Nothing threw,
nothing mismeasured — the slider moved and the widget did not.

The second is only visible in pixels. `text-overflow: ellipsis` requires `overflow: hidden`, and
overflow clips at the *padding* box. At `line-height: 1.2` a 14px line box leaves about a quarter
of a point of half-leading, so a descender sits flush against that edge and the shadow it casts
below — 1px of offset plus a 3px blur — was cut off in a dead straight line. So was the tail of
the glyph itself: the ogonek of a Polish `ę` rendered flat-bottomed. A DOM assertion cannot see
either. `getComputedStyle` reports the shadow the author asked for, not the one the compositor
drew, and every box measures exactly as intended — the clip is doing precisely what it was told.

So this loads the real bundle in a `WKWebView` configured like the widget host (non-persistent
store, `drawsBackground = false`, the API injected at document start), pushes state and settings
the way `WidgetJSBridge` does, and reads the frame back. The injected API is extracted verbatim
from `WidgetJSBridge.swift` by `theme-check/extract-api.py`, shared with that check, so neither
can drift from the JS that actually ships.

## How it decides

Each case is rendered **twice** — once at the case's `shadowOpacity`, once at `0` — and the
difference between the two frames *is* the shadow. That needs no absolute colour constants and
works for a dark shadow or a light one, which matters because a widget may later invert it.

Three assertions per case:

1. **The shadow exists.** `getComputedStyle(...).textShadow` is not `none`.
2. **It escapes the glyphs' box**, below and to the left.
3. **Buying it that room did not move the layout** — the `.labels` block must still measure
   exactly its line boxes plus its gaps.

Four traps worth knowing, all learned here:

- **Anchor to the text, never to the element.** The fix works by padding the clip box outward and
  taking the same amount back with negative margins, so an assertion measured from the element's
  border box moves *with* the fix and proves nothing. The glyphs do not move, so the probe rect
  comes from a `Range` over the text node instead.
- **Skip the row that straddles the clip edge.** The clip sits a fraction of a point below the
  text box, so at 2× one device row is part-shadow and scored a clipped render as a pass. Hence
  `PROBE_INSET`.
- **Give the probe label clear air.** The band below a label must be able to hold nothing but
  that label's own shadow, or the label underneath supplies the pixels and the case passes for
  the wrong reason. Either probe the bottom-most label, or send a track that leaves the rows
  below it empty — the spec does both.
- **Nothing composites here, so nothing animates.** `requestAnimationFrame` never fires in this
  harness, and a CSS transition therefore never advances a single step — the property is frozen
  at its *start* value permanently, not merely for a while. No amount of settling helps. Artwork
  is the case that exposed it: its cover fades in with `transition: opacity 0.3s`, so the element
  came out correct in every respect the DOM can report — right class, right `background-image` —
  and stuck at `opacity: 0`, leaving the labels over a near-black placeholder where a black
  shadow measures 5/255 and cannot be told from noise. A user script neutralises `transition` and
  `animation` at document start so every case renders its end state. Watch for this in any widget
  check that reads pixels rather than computed style: the symptom is a frame that looks like the
  widget's *initial* state, with a DOM that insists it is in the final one.

## Adding a case

Append to `spec.json`: `widget`, `label`, `appearance` (`dark`/`light` — drives
`prefers-color-scheme` for follow-the-system text colours), `settings`, `track`, `probe`
(a selector), the window `width`/`height`, and `pin`.

For `pin`, leave it out on the first run: the check prints the block to paste back. Capture it
**before** the change you are about to make, so it pins the layout you must not disturb.

Covered today: `Minimal`, `Artwork`, `Glass`, `Sleeve` and `Stack` — every bundle that pairs a
live `text-shadow` with the `overflow: hidden` an ellipsis needs. All five clipped; all five are
fixed. `Scrobbles` and the rest either carry no text shadow or do not clip their labels.

## Debugging a failure

- The failure line ends with how much shadow was found in the frame overall. If that is `0`, the
  two frames are the same picture and the fault is in the check, not the widget.
- `SHADOWCHECK_DUMP=<dir> ./run.sh` writes the lit and unlit frames of every failing case.
- If a probe's shadow is real but too faint to measure, it is contrast, not clipping: the label
  is over something too close to the shadow's own colour. Give the case a track whose artwork is
  light, rather than loosening the threshold.
