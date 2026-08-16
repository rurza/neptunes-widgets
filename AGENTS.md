# AGENTS.md — authoring NepTunes widgets

> **Published mirror.** This is a read-only copy of the sample widgets from the
> NepTunes app repository, so a few references point at things that are not here.
> `Scripts/package-widgets.mjs`, `Scripts/widget-id-registry.json` and anything
> under `website/` are NepTunes' own release tooling; they describe how the
> built-in bundles reach the gallery. To publish a widget of your own, sign it
> with `widget-tools.mjs` and submit it at <https://neptunesmac.app/widgets/submit>.

Imperative guide for agents working inside this repository. A widget is a
`.nepget` bundle — a directory of plain HTML/CSS/JS plus `manifest.json` —
rendered in a `WKWebView` by the separate **NepTunes Widget** helper process,
not the main app.

Machine-readable contract for the manifest: **`manifest.schema.json`**
(JSON Schema, draft 2020-12). It is the source of truth for every field — read
it before writing a manifest, and validate against it before calling a bundle
done (see step 4 below). The full human narrative — complete manifest field
reference, the `window.NepTunes` JS API, update signing and publishing — lives
in `Docs/WidgetDevelopment.md`; this file is the compact, agent-facing version
that ends at the test loop.

## Create a widget

To add a widget: copy an existing bundle, edit its manifest and pages, then
validate and test it.

1. Copy the simplest existing bundle as your starting point rather than
   building from scratch — `Minimal.nepget/` is just text plus
   optional playback controls:

   ```bash
   cp -R Minimal.nepget YourWidget.nepget
   ```

   A bundle is `manifest.json`, `index.html` (entry point), `script.js`,
   `styles.css`, usually `sfsymbols.js` (icon rendering — copy it verbatim,
   don't reimplement it), and `preview.jpg` (960×400 JPEG, shown in Settings
   and the widget gallery — match the framing/scale of the existing bundles).

2. Edit `manifest.json`. Required fields: `manifestVersion`, `id`, `name`,
   `version`, `entry`, `defaultSize`. Request the **minimum** `permissions`
   the widget actually needs — each one is shown to the user at install, and
   adding one later forces a re-consent prompt on update.

   ```json
   {
       "manifestVersion": 1,
       "id": "pl.micropixels.neptunes.widget.your-widget",
       "name": "Your Widget",
       "version": "1.0.0",
       "author": "Adam Różyński",
       "description": "One line describing what it shows",
       "entry": "index.html",
       "defaultSize": { "width": 280, "height": 100 },
       "minSize": { "width": 200, "height": 80 },
       "resizable": false,
       "preview": "preview.jpg",
       "permissions": ["playbackControl"]
   }
   ```

3. Edit `index.html`/`script.js`/`styles.css`. Keep the page transparent and
   non-selectable — the window is borderless and floats over the desktop:

   ```css
   html { background: transparent; }
   * { -webkit-user-select: none; user-select: none; }
   ```

   The window is exactly `defaultSize`, so the only room for a drop shadow is
   `body` padding — budget it up front. Read state from `window.NepTunes` and
   call `window.NepTunes._signalReady()` once the DOM is wired and initial
   state/settings are applied (most sample widgets do this, e.g.
   `Glass.nepget/script.js`). Write `script.js` in the UMD shape
   from **Test it** below so it stays unit-testable.

4. Validate the bundle against the schema:

   ```bash
   node widget-tools.mjs validate YourWidget.nepget
   ```

   This checks `manifest.json` against `manifest.schema.json`
   and confirms the files it references (`entry`, `preview`, `icon`) actually
   exist in the bundle. Fix every reported error before moving on — signing
   the bundle and publishing it for update distribution are covered further
   below.

## Modify a widget

- **Bump `manifest.version` for any change to anything the widget loads** —
  HTML, CSS, JS, or the manifest itself. Patch for fixes, minor for new
  behavior. Skipping the bump means the edit reaches nobody who already
  installed the widget: persisted window size is keyed on the version, and
  the widget host keeps serving the old bundle to existing installs until the
  version changes. (Side effect: a bump resets that widget's user-customized
  window size back to `defaultSize` — so bump for real content changes, not
  for edits to a file nothing loads.)
- Syntax-check every script before assuming it works. One parse error kills
  the whole widget silently — the only symptom is `<img>` alt text where
  icons should be:

  ```bash
  for f in *.nepget/{script,sfsymbols}.js; do node --check "$f" || echo "BROKEN: $f"; done
  ```

- **Re-run `embed-sign` after every edit to a signed bundle.** `bundle.sig` covers
  every file's hash, and the app re-verifies it not just on install but every time
  it lists or loads an installed widget — an edited-but-unsigned bundle simply
  stops loading. See *Validate, sign, publish* below.
- To see a change in the *running* helper, bump the version, re-sign, then copy
  (never move) the bundle over the installed copy, and restart the helper — in
  that order: `embed-sign` must be the **last** edit to the bundle, because
  bumping `manifest.version` afterwards invalidates the signature you just
  wrote and the widget stops loading:

  ```bash
  node widget-tools.mjs embed-sign YourWidget.nepget \
    --key .keys/first-party-author.pem
  cp -R "YourWidget.nepget/." \
    "$HOME/Library/Group Containers/group.pl.micropixels.NepTunes/Widgets/pl.micropixels.neptunes.widget.your-widget/"
  pkill -x "NepTunes Widget"
  ```

  `cp` copies `bundle.sig` along with everything else, but it never *deletes* —
  if you removed a file from the bundle, delete it from the installed copy too or
  the leftover fails the completeness check.

  Do not build or relaunch the main NepTunes app to see this — it's a
  separate helper process; Adam builds/runs the main app himself in Xcode.

## Test it

Widget JS is testable in Node: write `script.js` as a self-starting UMD
module and keep the pure logic (arithmetic, formatting — no DOM) in functions
the factory returns, so the same file both `require`s cleanly in Node and
self-starts in the browser. Real example, `Minimal.nepget/script.js`:

```javascript
(function (factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else api.start();
})(function () {
    'use strict';

    function targetHeight(showAlbum, showControls) { /* pure arithmetic, no DOM */ }

    function init() {
        // Look up DOM nodes HERE, not at module scope — there is no `document` in Node.
        if (!window.NepTunes) return;
        // ... wire up state/settings, then window.NepTunes._signalReady() ...
    }

    function start() {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
        else init();
    }

    return { targetHeight: targetHeight, start: start };
});
```

Its test, `_dev/minimal.test.mjs`, pins the pure function via
`require('../Minimal.nepget/script.js')` — no DOM involved.

Then:

```bash
# Unit-test the pure parts — put new tests next to the existing ones
node --test _dev/*.test.mjs

# Interactive browser loop against a mocked bridge
cd SampleWidgets && python3 -m http.server   # then open /_dev/harness.html?widget=YourWidget

# Automatic light/dark reaction, rendered in a real WKWebView
_dev/theme-check/run.sh

# Right-to-left mirroring + host-locale number formatting, in a real WKWebView
_dev/rtl-check/run.sh

# Text shadows painted and not clipped by the ellipsis's overflow, from the pixels
_dev/shadow-check/run.sh

# Every SF Symbol drawn 1:1 — CSS box == data-size, so the PNG is never resampled
_dev/icon-check/run.sh

# Hover affordances: hidden, revealed by the host's nt-hover class, hidden again
_dev/hover-check/run.sh
```

- `_dev/mock-neptunes.js` installs a fake `window.NepTunes`
  (state, events, artwork, Last.fm) for `_dev/harness.html`. It
  is dev-only and never ships inside a bundle.
- `_dev/neptunes-kit.js` (`NTKit`) is the shared helper library
  — `formatTime`, `formatCount`, `relativeTime`, `clock`, `paletteFromPixels`,
  `legibleAccent`, `applyAccent`, `fitText`, `displayInfo`. Several sample bundles copy it in
  verbatim rather than reimplementing its arithmetic (e.g.
  `Charts.nepget/neptunes-kit.js`) — do the same if you use it,
  and add a case to `_dev/neptunes-kit.test.mjs` for anything
  you add to it.
- Never measure layout in CSS alone. WebKit floors computed line-heights
  (16.8px → 16px), so any height arithmetic (like `targetHeight` above) must
  be measured once in a real WKWebView and then pinned by a `_dev` test — see
  the comment at the top of `_dev/minimal.test.mjs`.
- If the widget reacts to automatic system light/dark switching, add a
  `react`/`stable` case for it to `_dev/theme-check/spec.json`
  so `run.sh` covers it — a pure-function test cannot catch a widget that
  simply never learns the desktop appearance changed.
- If anything in the widget appears on hover, add a case for it (both sides of
  the setting, if it has one) to `_dev/hover-check/spec.json`.
  **Gate the reveal on `html.nt-hover`, never on bare `:hover`** — see that
  check's README for why a `:hover` rule latches open after the first click.
  `nt-hover` fires over your **visible content**, not over the window: the host
  measures the union of `body`'s visible element children and hovers that rect, so
  the shadow gutter is not a hover target. Keep the card a child of `body`, and
  don't leave an invisible full-bleed layer in there — it would hand the whole
  window back. Details: `NepTunes Widget/README.md` → *`:hover` does not work in a
  widget*.

## The window.NepTunes API

Injected at document start into every widget by `NepTunes Widget/WidgetJSBridge.swift`.
That file is the source of truth; this list mirrors it.

### State

`window.NepTunes.state` is replaced on every push, then a `statechange` event fires:

```javascript
{
  playerState: 2,                 // 0 = unknown, 1 = stopped, 2 = playing, 3 = paused
  volume: 75,                     // 0-100
  isMuted: false,
  shuffleEnabled: false,
  playerPosition: 127.5,          // seconds at the moment of the push
  timestampMs: 1770000000000,     // ms since epoch — use THIS for position math
  timestamp: "2026-07-21T10:30:00Z",
  language: "ar",                 // host UI language, BCP-47 ("en", "pt-BR", "ar")
  locale: "ar-SA",                // host locale, BCP-47 — pass to toLocaleString/Intl
  layoutDirection: "rtl",         // "rtl" or "ltr" — the values `dir` takes
  track: {                        // absent when nothing is playing
    title: "Song Title",
    artist: "Artist Name",
    album: "Album Name",          // optional
    albumArtist: "Album Artist",  // optional
    duration: 240.0,              // seconds
    isLoved: true,                // optional
    isAdvertisement: true,        // Spotify only; ABSENT (undefined) for a real track —
                                  // check truthily, never `=== false`
    artworkData: "<base64 jpeg>"  // only with the artwork permission, and only
                                  // when it CHANGED — keep your last value
  },
  playerType: "appleMusic",       // or "spotify"
  capabilities: { canLove: true, canDislike: true, canRate: true,
                  canAddToLibrary: false, hasThreeStateRepeat: true },
  repeatMode: 1,                  // 1 = all, 2 = one, 3 = off
  rating: 80,                     // 0-100, Apple Music only
  isLoved: true, isDisliked: false
}
```

`artworkData` is omitted when unchanged and `null` when cleared — never assume a
push carries it. `window.NepTunes.settings` holds the current settings object.

`locale` is a **BCP-47** tag, not an ICU identifier: `Intl` and `toLocaleString`
raise `RangeError` on the underscore form (`"ar_SA"`), so the host converts before
publishing. Read the locale off state rather than hard-coding a tag — `NTKit.formatCount`
does, and takes an explicit one as its second argument. `layoutDirection` is how you
opt into mirroring; the host sets `lang` on the document but never `dir`, because
mirroring a bundle written against physical CSS would break it. All three arrive with
the first push, which lands *after* `DOMContentLoaded` — read them in your
`statechange` handler, not in `init()`, where `state` is still `null`.

Convenience getters: `track`, `isPlaying`, `isPaused`, `isStopped`, `volume`,
`isMuted`, `playerType`, `capabilities`.

### Events

```javascript
window.NepTunes.on('statechange', fn);     // player state pushed
window.NepTunes.on('settingschange', fn);  // user changed this widget's settings
window.NepTunes.on('themechange', fn);     // fn({dark: true|false}) on a system light/dark flip
window.NepTunes.off('statechange', fn);
```

CSS reacts to a system theme flip for free; anything JS computed once (theme
classes, artwork-derived accent ink, rasterized SF Symbols) does not — recompute
it in `themechange`, and `reload()` your symbols rather than `load()`.

### Methods

```javascript
window.NepTunes.getState();          // Promise<state>
window.NepTunes.getSettings();       // Promise<settings>
window.NepTunes.getArtworkDataURL(); // "data:image/jpeg;base64,…" or null (needs artwork)
window.NepTunes.setSize(w, h);       // request a window resize, clamped to minSize
window.NepTunes._signalReady();      // call once wired up, so the first state push lands

window.NepTunes.playPause();  window.NepTunes.next();  window.NepTunes.previous();          // playbackControl
// next()/previous() are dropped by the bridge itself while state.track.isAdvertisement is
// true (Spotify refuses to skip an ad); playPause() still works. Read the flag yourself
// only if you want your widget to grey its own prev/next while it's set.
window.NepTunes.setVolume(75); window.NepTunes.increaseVolume();
window.NepTunes.decreaseVolume(); window.NepTunes.toggleMute();                             // volumeControl
window.NepTunes.toggleLove(); window.NepTunes.toggleDislike();                              // love
window.NepTunes.setRating(80); window.NepTunes.increaseRating();
window.NepTunes.decreaseRating(); window.NepTunes.removeRating();                           // ratingControl
window.NepTunes.toggleShuffle(); window.NepTunes.toggleRepeat();                            // shuffleRepeatControl
window.NepTunes.activatePlayer(); window.NepTunes.switchPlayer();                           // playerActivation

// SF Symbols: rasterized natively, resolved as a PNG data URL
window.NepTunes.symbol('play.fill', { size: 24, weight: 'semibold', color: '#ffffff' })
  .then(function (dataURL) { img.src = dataURL; });

// Last.fm, proxied through the main app (needs the lastFm permission)
window.NepTunes.lastFm.getUserInfo();
window.NepTunes.lastFm.getTopAlbums('overall', 10);
window.NepTunes.lastFm.getTopArtists('overall', 10);
window.NepTunes.lastFm.getTopTracks('overall', 10);
window.NepTunes.lastFm.getRecentTracks(20);
window.NepTunes.lastFm.getTrackInfo(track, artist);
window.NepTunes.lastFm.getArtistInfo(artist);
window.NepTunes.lastFm.loveTrack(track, artist);    // also needs the love permission
window.NepTunes.lastFm.unloveTrack(track, artist);  // also needs the love permission
```

Calls without the matching permission are dropped by the native side — silently
for actions, as a rejected Promise for `lastFm.*`. Every `lastFm.*` request times
out after 15 s, `symbol()` after 5 s.

### Dragging

The whole window drags unless the pointer is over an interactive element. Give
controls a `BUTTON`/`INPUT`/`SELECT`/`TEXTAREA`/`A` tag, or one of the classes
`control-btn`, `icon-btn`, `rating-btn`, `header-btn`, `slider`, `resize-handle`.
A real drag swallows the trailing synthetic click; a stationary tap still lands.

## Permissions

Declare only what you use. Adding one in a later version is a permission
escalation and is highlighted to the user in the update consent sheet.

| Permission | Unlocks |
|------------|---------|
| `artwork` | `state.track.artworkData`, `getArtworkDataURL()` |
| `love` | `toggleLove()`, `toggleDislike()`, `lastFm.loveTrack()`, `lastFm.unloveTrack()` |
| `lastFm` | the whole `lastFm.*` namespace |
| `playbackControl` | `playPause()`, `next()`, `previous()` |
| `playerActivation` | `activatePlayer()`, `switchPlayer()` |
| `ratingControl` | `setRating()`, `increaseRating()`, `decreaseRating()`, `removeRating()` (Apple Music only) |
| `shuffleRepeatControl` | `toggleShuffle()`, `toggleRepeat()` |
| `volumeControl` | `setVolume()`, `increaseVolume()`, `decreaseVolume()`, `toggleMute()` |

## Validate, sign, publish

```bash
# 1. Structure: manifest vs manifest.schema.json, entry file present. Also runs
#    embed-verify when the bundle already has a bundle.sig.
node widget-tools.mjs validate MyWidget.nepget

# 2. Sign the BUNDLE in place. Writes bundle.sig (Ed25519 over every file's
#    SHA-256) and syncs manifest.authorPublicKey. `keygen my-widget-author` put
#    the private half in .keys/ (gitignored), the public half in
#    public-keys/. RE-RUN THIS AFTER EVERY CONTENT CHANGE, including a
#    version bump — one changed byte invalidates bundle.sig and the app then
#    refuses to install or load the bundle.
node widget-tools.mjs embed-sign MyWidget.nepget \
  --key .keys/my-widget-author.pem
node widget-tools.mjs embed-verify MyWidget.nepget

# 3. Package: enforce the id -> author-key registry, embed-sign, zip rooted at
#    "MyWidget.nepget/", copy preview.jpg to the site, sync the manifest version
#    into the gallery entry, regenerate + re-sign the feed
node Scripts/package-widgets.mjs MyWidget

# 4. Step 3 already signed the zip AND the feed. There is nothing to do by hand.
#
#    This used to be two steps using `widget-tools.mjs sign` / `verify`. Those
#    subcommands are gone: the script is now published verbatim at
#    neptunesmac.app/widget-tools.mjs, and raw Ed25519-over-any-file is
#    first-party feed plumbing a widget author never needs. Worse, on a public
#    download it invites `sign MyWidget.nepget.zip`, which produces a
#    real-looking signature that is NOT what the app checks — embed-sign is.
#    signBytes/verifyBytes are still exported; import them if you need them:
#
#      node --input-type=module -e "
#        import { signBytes } from './widget-tools.mjs';
#        import { readFileSync } from 'node:fs';
#        console.log(signBytes(
#          readFileSync('website/public/widgets/my-widget/my-widget.nepget.zip'),
#          readFileSync('.keys/my-widget-author.pem', 'utf8')));
#      "

# 5. Guards: shipped zips/gallery/feed vs the bundles, and the CLI round-trip
cd website && node --test test/*.test.js
```

`bundle.sig` covers **every** file in the bundle, recursively, except four leaf
file names: `bundle.sig` itself, `.DS_Store`, `.localized`, and anything starting
with `._`. Those are ignored **by design** — inert macOS metadata that the WebView
never executes. It is a leaf-*file* rule only: directories are always descended
into, so a folder named `._cache` is walked and its contents are signed.

A widget `id` belongs to exactly one author key. `Scripts/widget-id-registry.json`
records that mapping and `package-widgets.mjs` enforces it over every bundle
before packaging anything — signing a registered id with a different key aborts
the run. A third-party author sends only the **public** half for registration.

Publishing an update is the same flow with a bumped `manifest.version` (and a
fresh `embed-sign`). The app then offers it from the signed feed and asks the user
to confirm — nothing installs silently, and a newly requested permission is
highlighted in the consent sheet. Full lifecycle, key storage, and the trust
model: `Docs/WidgetDevelopment.md` → *Updates & Signing*.

## Shadows and sizing

Nearly every recurring "the shadow looks wrong" bug traces to these. They cost two
days across ~9 of the sample widgets before they were written down.

- **The window is exactly `manifest.defaultSize`.** `WidgetWindowController` creates
  the panel at that size, and `html, body` are transparent with `overflow: visible`,
  so **`body` padding is the only space a drop shadow has to render into.**
- **Compute the shadow's extent, then over-budget it.** For `box-shadow: 0 Y B color`
  the shadow reaches `|Y|+B` below, `B` to the sides, and `B−Y` above. Padding equal
  to the extent is **not enough**: at α ≥ 0.25 the shadow is still visibly non-zero at
  `B`, leaving a hard clip line that is invisible on a dark cover and glaring on a
  light one over a light wallpaper. What actually works: **keep α ≤ 0.16 and give
  padding ≥ extent + 8px** on every window-edge-facing side. For a sub-element cover
  (not full-bleed) add its centering gap when computing clearance; the side facing
  internal content or text does not clip.
- **Prefer a layered shadow** — tight contact plus soft ambient, both low alpha:
  `box-shadow: 0 2px 6px rgba(0,0,0,.14), 0 8px 20px rgba(0,0,0,.12)`. A single heavy
  shadow reads as a muddy dark box *and* clips. All sample widgets were standardized
  to α ≤ 0.14 layered shadows in `c55f3d12`.
- **Grow `defaultSize`/`minSize` (and `maxSize` if resizable) by the same delta** when
  you grow padding, so the visible card keeps its size.
- **A changed `defaultSize` is invisible to existing installs until you bump
  `manifest.version`** — persisted per-widget size is version-gated in
  `SharedDefaults.widgetSize(for:manifestVersion:)`.
- **Text shadow only makes sense on white text (dark theme).** Light theme means dark
  text and therefore no shadow — a white halo looks awful. Keep it a black drop
  (`0 1px 3px rgba(0,0,0,.5)`, no all-around ring) and make it a setting
  (`textShadow`, default on).
- **`-webkit-user-drag: none`** on the `*` reset or the cover `<img>`, or mousedown
  drags the album image instead of moving the window.
- **Don't use the album `--accent` for large fills or body text** — too garish over
  arbitrary art. Neutral white/dark controls, theme-flipped, read far cleaner; accent
  is for small cues only (hairlines, progress, dots).
- **Regenerate picker previews** with `_dev/preview-shot/run.sh <Widget>`,
  which renders the real bundle in a WKWebView (real SF Symbols, real shadow) onto the
  gallery backdrop, and reference `"preview": "preview.jpg"` in the manifest. The older
  `python3 _dev/make-previews.py` draws a PIL *impression* of a widget
  instead — it still owns the previews nobody has re-shot, and every one of those is a
  picture that can drift from the bundle. A new `preview.jpg` needs a re-`embed-sign`
  (it is inside the bundle) and a re-package (the site serves a copy of it).

To see an edit without rebuilding the app: copy the bundle into
`~/Library/Group Containers/group.pl.micropixels.NepTunes/Widgets/<manifest.id>/`,
then `pkill -f "NepTunes Widget"` — the helper respawns on the next play/pause.

## Rules that bite

- Never commit a private key, and never put one on the web host. `keygen` writes
  private halves to `.keys/`, which is gitignored; only the `.pub` files
  in `public-keys/` are committed.
- Re-run `embed-sign` after ANY edit to a signed bundle. A stale `bundle.sig` is
  not ignored — the app refuses the bundle outright.
- Never fetch from a URL you invented — the app downloads only from its hardcoded
  host, reconstructed from the widget slug.
- Bump `manifest.version`, or the change reaches nobody.
- Re-run `node Scripts/package-widgets.mjs` after every bundle edit, or the
  website ships stale bytes and `website/test/widgetPackaging.test.js` fails.
- Size `img.sf-icon` explicitly, **to exactly its `data-size`** — the PNG is a
  retina raster of that many points, so an unsized `<img>` renders at double size
  and *any* other box resamples it into a soft, mushy glyph. The two halves of the
  pair live in different files (`data-size` in the HTML, the box in the CSS), so
  neither looks wrong alone; `_dev/icon-check/run.sh` compares them from a real
  render. Percentages are the usual trap — a `34%` box is not a size you can match.
  Also verify symbol names really exist, or the icon is blank (icon-check fails on
  that too).
- `sfsymbols.js` takes its tint from a text-color CSS variable
  (`--text-primary` / `--text` / `--fg` / `--ink` / `--title`) or an explicit
  `--icon-color`; without one, icons fall back to white and vanish on light themes.
  **A plain `color:` does nothing** — the tint is baked into the PNG. Writing
  `color: var(--placeholder-glyph)` and expecting a 16% watermark got a solid white
  note in Glass for months, because the resolver fell straight through to `--title`.
- **Collapse ads to a placeholder, don't show the advertiser's copy.** When
  `track.isAdvertisement` is truthy, `track.title` / `track.artist` carry the
  ad's own marketing text. Show a neutral "Advertisement" label and clear the
  artist — or call `NTKit.displayInfo(state)` which does both.
- Do not build or relaunch the NepTunes app to "deploy" a change.
