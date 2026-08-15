# hover-check

Verifies what a widget's **hover affordance** actually does: that the thing the spec names is off
screen until the host says the pointer is over the window, on screen while it is, and off screen
again once it leaves — measured in a real `WKWebView`, with the real injected API and the real
class the host sets.

```bash
./run.sh                                   # this checkout
./run.sh "/path/to/other/SampleWidgets"    # another tree, e.g. to confirm a baseline fails
```

## Why this exists rather than a unit test

Glass shipped a **Controls: On hover** mode that hid the transport row and nothing else. The
frosted sheet stayed exactly where it was, at exactly its old height, now with a blank slab of
glass where the buttons had been — while the point of the mode is a full-bleed cover that the
panel returns to when you reach for it. Every part of that is a matter of which CSS rule wins:
the JS did toggle its class, the setting did arrive, and the row's own `opacity` was `0`.

The rules deciding it are also unusually easy to get wrong here, in ways nothing else catches:

- **A widget cannot use `:hover`.** Its panel never becomes key, so AppKit delivers no
  `mouseMoved` events to the web view and WebKit never re-evaluates the hover chain. A `:hover`
  rule latches onto whatever was clicked last and stays matched — Glass's reveal carried
  `.widget:hover`, so the first click on a control pinned the sheet open for good.
  `WidgetWindowController.setHoverClass` toggles `nt-hover` on `<html>` from system-wide mouse
  monitors instead; that class is what this harness toggles, character for character.
- **Specificity beats intent.** `.widget.stopped .controls` already outranked every reveal
  selector once, pinning Glass's transport at 0.55 in both modes and making "On hover" look like
  a dead switch (fixed in `86e6d25a`). Nothing playing is exactly the state you are in while
  changing the setting, so that is the state that has to be checked.
- **Hidden has to mean inert.** An invisible panel that still swallows clicks stops the window
  dragging from the cover under it, and hands out presses on buttons nobody can see.

## How it decides

Each case loads the bundle at its `manifest.defaultSize`, pushes the manifest's default settings
with the case's overrides on top plus a playing track, and then samples three phases:
**idle → `nt-hover` added → `nt-hover` removed**.

What it samples is the element's **effective** opacity: the product of every `opacity` from the
element up to `<html>`, with `display: none` / `visibility: hidden` anywhere in the chain read as
zero. That is what a user sees — a control row at opacity 1 inside a panel at opacity 0 is not on
screen, and a panel at opacity 1 whose row is hidden is very much still on screen. It is also what
separates the two shapes a bundle can implement:

| `expect` | means |
|----------|-------|
| `hover-gated` | off screen idle, fully on screen under `nt-hover`, off screen again after it leaves (a third phase, so a latched reveal is a failure rather than a pass) |
| `always-visible` | fully on screen in all three phases — the other side of the same setting |

`"inert": true` additionally requires `pointer-events` to follow the visibility: `none` while
hidden, anything else while revealed.

### Transitions are cut before measuring

Nothing here is ever ordered front, so WebKit has no display link driving the page and **a CSS
transition never progresses**: `getComputedStyle` keeps returning the value the property started
at, however long the harness waits. Left alone that reads as "the hover state never changes", and
it inverts per bundle depending on which end the markup starts from — Glass's row reported a
permanent 1, Headline's a permanent 0, both wrong. So the harness injects
`* { transition: none !important; animation: none !important; }` right after load, and every
reveal resolves to its end state on the spot. The end state is what these cases are about; the
duration of the fade is not.

## Adding a case

Append to `spec.json`:

```json
{
  "widget": "Glass",
  "settings": { "controls": "hover" },
  "selector": ".panel",
  "expect": "hover-gated",
  "inert": true,
  "why": "On hover hides the whole frosted sheet"
}
```

`settings` holds only the overrides — the manifest's own defaults are merged in first — and `why`
is printed with the result, pass or fail, so a case explains itself in the output. A widget with
no hover affordance needs no case; one that grows a hover-gated element should get both sides of
its setting, so the "Always" half cannot quietly break while the hover half passes.
