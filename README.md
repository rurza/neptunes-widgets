# NepTunes sample widgets

Every widget that ships with [NepTunes](https://neptunesmac.app), as source you
can read, run and copy.

A NepTunes widget is a `.nepget` bundle: a directory of plain HTML, CSS and
JavaScript plus a `manifest.json`, rendered in a `WKWebView` by the NepTunes
widget helper process. No build step, no framework, no bundler.

## Start here

```bash
cp -R Minimal.nepget MyWidget.nepget
```

`Minimal.nepget` is text plus optional playback controls, the smallest complete
example. Edit its `manifest.json`, `index.html`, `script.js` and `styles.css`,
then validate:

```bash
curl -O https://neptunesmac.app/widget-tools.mjs
node widget-tools.mjs validate MyWidget.nepget
```

`widget-tools.mjs` also signs bundles (`keygen`, `embed-sign`, `embed-verify`).
It has no dependencies and embeds its own copy of the manifest schema.

## Docs

The full documentation is published at
**<https://neptunesmac.app/docs/>**, the same material rendered and searchable:

- [Quick start](https://neptunesmac.app/docs/quick-start/) ·
  [Manifest reference](https://neptunesmac.app/docs/manifest/) ·
  [JavaScript API](https://neptunesmac.app/docs/javascript-api/)
- [Settings](https://neptunesmac.app/docs/settings/) ·
  [Permissions](https://neptunesmac.app/docs/permissions/) ·
  [Debugging](https://neptunesmac.app/docs/debugging/)
- [Publishing](https://neptunesmac.app/docs/publishing/) ·
  [Updates and signing](https://neptunesmac.app/docs/updates-and-signing/) ·
  [Security and sandbox](https://neptunesmac.app/docs/security-and-sandbox/)

In this repository:

- **[AGENTS.md](AGENTS.md)**: the compact, imperative authoring loop. Start here.
- **[WidgetDevelopment.md](WidgetDevelopment.md)**: the full narrative. Every
  manifest field, the `window.NepTunes` JavaScript API, signing and publishing.
- **[manifest.schema.json](manifest.schema.json)**: the machine-readable
  contract every manifest is validated against.

## Testing without the app

`_dev/` holds the harness the widgets are developed against:

- `_dev/harness.html` + `_dev/mock-neptunes.js`: a fake `window.NepTunes`
  (state, events, artwork, Last.fm) so you can iterate in a browser.
- `_dev/neptunes-kit.js`: the shared helper library (`NTKit`) the bundles use.
- `_dev/theme-check`, `_dev/shadow-check`, `_dev/rtl-check`, `_dev/icon-check`:
  the checks each bundle is held to. They need macOS and a Swift toolchain.
- `node --test _dev/*.test.mjs`: the unit tests.

## Publishing your widget

Sign it, then submit it at <https://neptunesmac.app/widgets/submit>. Approved
widgets appear in the in-app gallery.

## About this repository

It is a **read-only mirror**, published automatically from the NepTunes app
repository. Issues are welcome; pull requests can't be merged here, so open an
issue describing the change instead.

## Licence

MIT for the code. The preview images (`*.nepget/preview.jpg`) are not covered.
See [LICENSE](LICENSE) and replace them with your own.
