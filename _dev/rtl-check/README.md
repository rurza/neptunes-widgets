# rtl-check

Proves, in a real `WKWebView`, that every sample widget mirrors for a right-to-left host and
that the copy of `neptunes-kit.js` it actually loaded formats numbers against the host locale.

```bash
SampleWidgets/_dev/rtl-check/run.sh
```

Exit status is 0 only when all fourteen bundles pass.

## Why this exists and the Swift tests are not enough

Two suites already cover this ground, and both are **source** checks:

- `WidgetMirroringOptInTests` greps each `script.js` for `documentElement.dir`.
- `WidgetKitLocaleTests` byte-compares each bundle's `neptunes-kit.js` against the `_dev`
  master.

Neither can see a widget that carries the code and still never runs it — an early `return`
above the call, a handler wired to an event that never fires, a kit that loads but whose
function is never reached. The RTL work on this project has already shipped once behind a
green source gate while being inert on every Mac. So the source gates stay (they localise a
failure to a file and a line, which this cannot), and this runs the thing.

## What it does

For each `.nepget`, loading the **real** bundle with the **real** injected API — extracted
from `NepTunes Widget/WidgetJSBridge.swift` by `../theme-check/extract-api.py`, so it cannot
drift from what ships:

1. Push an Arabic state (`language: "ar"`, `locale: "ar-SA"`, `layoutDirection: "rtl"`),
   then read back `document.documentElement.dir`.
2. Evaluate `NTKit.formatCount(48213)` in the page, so the assertion runs against the copy of
   the kit *that bundle* loaded rather than the master. Bundles that do not vendor the kit
   report `no kit` and are not a failure.
3. Push an English state (`en-US`, `ltr`) and read both again — a widget that hard-assigns
   `"rtl"` once would otherwise pass step 1 and strand an English user in a mirrored layout.

Expected: `dir` follows the host both ways, and the count is `٤٨٬٢١٣` for `ar-SA` and
`48,213` for `en-US`.

## Verifying the check itself

It is only worth having if it can fail. Both mutations below were confirmed to produce a red
run, and the messages name the widget and the reason:

```bash
# a widget that never applies the direction
git show main:SampleWidgets/Minimal.nepget/script.js > SampleWidgets/Minimal.nepget/script.js
# a bundle carrying a stale kit that still hard-codes en-US — the original bug
git show main:SampleWidgets/Strip.nepget/neptunes-kit.js > SampleWidgets/Strip.nepget/neptunes-kit.js
```

```
❌ Minimal: never applied the host direction (got rtl→'', ltr→'')
❌ Strip: formatCount ignored the host locale (got 48,213 / 48,213, expected ٤٨٬٢١٣ / 48,213)
```

Restore with `git checkout`, then **re-sign** — reverting a file invalidates `bundle.sig`
just as surely as editing one does.

## Caveats

- Last.fm is not mocked, so the counts Charts and Scrobbles paint into the DOM are not
  exercised end to end; `formatCount` is called directly instead. That covers the formatting
  rule, not those two widgets' rendering paths.
- Only `dir` is read, not computed geometry. A widget that sets `dir` and then defeats it with
  physical CSS (`left`, `margin-left`) passes here. Logical properties are still on the author.
