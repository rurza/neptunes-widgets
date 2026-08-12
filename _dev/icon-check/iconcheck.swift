import AppKit
import WebKit

// Asserts, from a real render, that every `img.sf-icon` in a bundle is drawn 1:1 — that its CSS
// box is exactly the `data-size` the native side rasterised, so WebKit never resamples the PNG.
//
// Run it via ./run.sh — see README.md for what this catches and why a static check cannot.
//
// Usage: iconcheck <SampleWidgets dir> <extracted-api.js> <spec.json>

let args = CommandLine.arguments
guard args.count >= 4 else {
    fputs("usage: iconcheck <widgets-dir> <api.js> <spec.json>\n", stderr); exit(2)
}
let widgetsDir = URL(fileURLWithPath: args[1])
let apiJS = try! String(contentsOf: URL(fileURLWithPath: args[2]), encoding: .utf8)

/// The native side, faking exactly the one property this check is about.
///
/// It does NOT link `SFSymbolRasterizer` — the published mirror of this folder carries no app
/// source, the same reason `api.js` is extracted rather than imported. What it reproduces is the
/// rasteriser's *contract*: a square PNG of `round(pointSize * deviceScale)` pixels. That is the
/// number `naturalWidth` reports, and comparing it to the CSS box is the whole assertion, so a
/// flat square carries it exactly as well as the real glyph would.
///
/// The symbol name is still resolved through `NSImage(systemSymbolName:)`, which is plain
/// AppKit: a name that does not exist renders as nothing in the app, and the only symptom is an
/// `<img>` sitting there empty. Caught here as a hard failure instead.
@MainActor
final class Bridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    private(set) var unknownSymbols: [String] = []
    private var cache: [Int: String] = [:]

    private func square(_ px: Int) -> String {
        if let hit = cache[px] { return hit }
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
                                   bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                   isPlanar: false, colorSpaceName: .deviceRGB,
                                   bytesPerRow: px * 4, bitsPerPixel: 32)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor.white.setFill()
        NSRect(x: 0, y: 0, width: px, height: px).fill()
        NSGraphicsContext.restoreGraphicsState()
        let url = "data:image/png;base64," + rep.representation(using: .png, properties: [:])!
            .base64EncodedString()
        cache[px] = url
        return url
    }

    nonisolated func userContentController(_ ucc: WKUserContentController, didReceive m: WKScriptMessage) {
        MainActor.assumeIsolated {
            guard let body = m.body as? [String: Any],
                  body["type"] as? String == "symbol",
                  let id = body["requestId"] as? String,
                  let name = body["name"] as? String else { return }
            guard NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil else {
                if !unknownSymbols.contains(name) { unknownSymbols.append(name) }
                webView?.evaluateJavaScript("window.NepTunes._resolveSymbol('\(id)', false, '');")
                return
            }
            let size = body["size"] as? Double ?? 24
            let dpr = min(max(body["dpr"] as? Double ?? 2, 1), 3)
            let px = Int((size * dpr).rounded())
            webView?.evaluateJavaScript(
                "window.NepTunes._resolveSymbol('\(id)', true, '\(square(px))');")
        }
    }
}

@MainActor func settle(_ ms: UInt64) async { try? await Task.sleep(nanoseconds: ms * 1_000_000) }

@MainActor
final class Renderer: NSObject, WKNavigationDelegate {
    var done: CheckedContinuation<Void, Never>?
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { done?.resume(); done = nil }

    var web: WKWebView!
    var panel: NSPanel!
    let bridge = Bridge()

    func load(bundle: URL, width: Double, height: Double) async {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let ucc = WKUserContentController()
        ucc.add(bridge, name: "neptunes")
        ucc.addUserScript(WKUserScript(source: apiJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = ucc
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                        styleMask: [.borderless, .resizable], backing: .buffered, defer: false)
        panel.isOpaque = false; panel.backgroundColor = .clear
        web = WKWebView(frame: panel.contentView!.bounds, configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = self
        bridge.webView = web
        panel.contentView!.addSubview(web)

        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            done = c
            web.loadFileURL(bundle.appendingPathComponent("index.html"),
                            allowingReadAccessTo: bundle.deletingLastPathComponent())
        }
        await settle(400)
    }

    func push(settings: [String: Any], track: [String: Any], hover: Bool) async {
        let state: [String: Any] = [
            "track": track, "playerState": 2, "playerPosition": 10, "volume": 70, "isMuted": false,
            "shuffleEnabled": false, "repeatMode": 1, "rating": 80, "isLoved": true,
            "playerType": "appleMusic", "layoutDirection": "ltr", "language": "en", "locale": "en-US",
            "capabilities": ["canLove": true, "canDislike": true, "canRate": true,
                             "canAddToLibrary": true, "hasThreeStateRepeat": true],
        ]
        let s = String(data: try! JSONSerialization.data(withJSONObject: settings), encoding: .utf8)!
        let t = String(data: try! JSONSerialization.data(withJSONObject: state), encoding: .utf8)!
        await eval("window.NepTunes.settings = \(s); window.NepTunes._emit('settingschange', window.NepTunes.settings);")
        await eval("window.NepTunes.state = \(t); window.NepTunes._emit('statechange', window.NepTunes.state);")
        if hover {
            // What WidgetWindowController.setHoverClass does; some bundles only build their
            // hover affordances' icons once it lands.
            await eval("document.documentElement.classList.add('nt-hover')")
        }
        // Icons are fetched over an async bridge round-trip per icon, and several bundles
        // re-request the whole set from their `settingschange` handler. Wait for the count to
        // stop moving rather than guessing a sleep.
        var previous = -1
        for _ in 0..<40 {
            await settle(100)
            let n = Int(await eval("""
            (function () {
              var n = 0;
              document.querySelectorAll('img.sf-icon[data-symbol]').forEach(function (i) {
                if (i.naturalWidth > 0) n++;
              });
              return n;
            })()
            """)) ?? 0
            if n == previous && n > 0 { return }
            previous = n
        }
    }

    @discardableResult
    func eval(_ js: String) async -> String {
        await withCheckedContinuation { (c: CheckedContinuation<String, Never>) in
            web.evaluateJavaScript(js) { r, _ in
                if let s = r as? String { c.resume(returning: s) }
                else if let n = r as? NSNumber { c.resume(returning: n.stringValue) }
                else { c.resume(returning: "") }
            }
        }
    }

    func close() { panel?.close(); panel = nil; web = nil }
}

/// Every icon the page is actually showing, as `symbol;cssW;cssH;naturalW;naturalH;dpr`.
///
/// Hidden icons are skipped, not failed: bundles keep both halves of a swap pair in the DOM
/// (play/pause, heart/heart.fill) with one of them `display: none`, and an icon in a
/// `display: none` subtree has no box to compare against.
let ICONS_JS = """
(function () {
  var out = [];
  document.querySelectorAll('img.sf-icon[data-symbol]').forEach(function (img) {
    var s = getComputedStyle(img);
    if (s.display === 'none' || !img.getClientRects().length) return;
    var r = img.getBoundingClientRect();
    out.push([img.dataset.symbol, r.width, r.height,
              img.naturalWidth, img.naturalHeight, window.devicePixelRatio].join(';'));
  });
  return out.join('|');
})()
"""

@MainActor
func run() async -> Int {
    let specData = FileManager.default.contents(atPath: args[3])!
    let spec = (try! JSONSerialization.jsonObject(with: specData)) as! [String: Any]
    let cases = spec["cases"] as! [[String: Any]]
    let track = spec["track"] as! [String: Any]
    var failures: [String] = []

    var stale: [String] = []

    for c in cases {
        let widget = c["widget"] as! String
        let label = (c["label"] as? String) ?? widget
        let bundle = widgetsDir.appendingPathComponent("\(widget).nepget")
        guard let manifestData = FileManager.default.contents(
                atPath: bundle.appendingPathComponent("manifest.json").path),
              let manifest = (try? JSONSerialization.jsonObject(with: manifestData)) as? [String: Any]
        else {
            failures.append(label)
            print("❌ \(label): no manifest.json")
            continue
        }

        // Settings the host would push: the manifest's own defaults, then the case's overrides
        // for whatever has to be switched on to make an optional icon exist at all.
        var settings: [String: Any] = [:]
        if let schema = (manifest["settings"] as? [String: Any])?["schema"] as? [[String: Any]] {
            for definition in schema {
                if let id = definition["id"] as? String, let value = definition["default"] {
                    settings[id] = value
                }
            }
        }
        for (k, v) in (c["settings"] as? [String: Any] ?? [:]) { settings[k] = v }

        let defaultSize = manifest["defaultSize"] as? [String: Any] ?? [:]
        let width = c["width"] as? Double ?? (defaultSize["width"] as? Double ?? 320)
        let height = c["height"] as? Double ?? (defaultSize["height"] as? Double ?? 320)

        // `artwork: false` sends a track with no cover, which is the only way to put a bundle's
        // no-artwork placeholder glyph on screen — it is `display: none` the rest of the time,
        // and skipped icons are not checked.
        var caseTrack = track
        if c["artwork"] as? Bool == false { caseTrack["artworkData"] = nil }

        let r = Renderer()
        await r.load(bundle: bundle, width: width, height: height)
        await r.push(settings: settings, track: caseTrack, hover: c["hover"] as? Bool ?? false)
        let raw = await r.eval(ICONS_JS)
        let unknown = r.bridge.unknownSymbols
        r.close()

        var problems: [String] = []
        for name in unknown {
            problems.append("`\(name)` is not an SF Symbol on this OS — it renders as an empty box")
        }

        let rows = raw.split(separator: "|").map(String.init)
        if rows.isEmpty {
            problems.append("no visible sf-icon rendered — the bundle draws none, or its script died")
        }
        var checked = 0
        for row in rows {
            let f = row.split(separator: ";", omittingEmptySubsequences: false).map(String.init)
            guard f.count == 6, let cssW = Double(f[1]), let cssH = Double(f[2]),
                  let natW = Double(f[3]), let natH = Double(f[4]), let dpr = Double(f[5])
            else { problems.append("could not parse icon row `\(row)`"); continue }
            checked += 1
            if natW == 0 {
                problems.append("\(f[0]): never loaded (naturalWidth 0)")
                continue
            }
            // What the CSS box asks the compositor to paint, in device pixels, against what the
            // PNG actually holds. Equal means 1:1; anything else is a resample, and a resampled
            // glyph is a soft glyph. Half a pixel of slack for the round-trip through CSS px.
            for (axis, css, nat) in [("width", cssW, natW), ("height", cssH, natH)] {
                let wanted = (css * dpr).rounded()
                if abs(wanted - nat) > 0.5 {
                    problems.append(String(
                        format: "%@ %@: CSS box %.2fpx wants %.0f device px, PNG is %.0f — %@ by %.2f×. Set data-size to %.0f, or the CSS box to %.0f.",
                        f[0], axis, css, wanted, nat,
                        nat < wanted ? "upscaled" : "downscaled",
                        wanted / nat, css, nat / dpr))
                }
            }
        }

        if problems.isEmpty {
            print("✅ \(label): \(checked) icon\(checked == 1 ? "" : "s") drawn 1:1")
        } else if let why = c["stale"] as? String {
            // Known debt, declared in spec.json rather than quietly left out of it: these
            // bundles predate the rule and clearing them costs a version bump each, which
            // resets every install's window size. Reported every run so it cannot be forgotten,
            // but not a failure — see README.md → "The stale list".
            stale.append(label)
            print("⚠️  \(label): known stale — \(why)")
            for p in problems { print("     · \(p)") }
        } else {
            failures.append(label)
            print("❌ \(label):")
            for p in problems { print("     · \(p)") }
        }
    }

    let passed = cases.count - failures.count - stale.count
    print("\n=== \(passed)/\(cases.count) passed, \(stale.count) known stale ===")
    if !stale.isEmpty { print("STALE:  \(stale.joined(separator: " | "))") }
    if !failures.isEmpty { print("FAILED: \(failures.joined(separator: " | "))") }
    return failures.isEmpty ? 0 : 1
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
Task { @MainActor in exit(Int32(await run())) }
app.run()
