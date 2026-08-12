import AppKit
import WebKit

// Loads each real .nepget in a WKWebView configured like the widget host, injects the real
// javascriptAPI (extracted from WidgetJSBridge.swift, so it can't drift from what ships),
// pushes a right-to-left Arabic state and then a left-to-right English one, and reads back
// what the document actually did.
//
// This exists because the Swift-side gates for this behaviour are source checks — they grep
// script.js for `documentElement.dir` and compare the vendored kits byte-for-byte. Both stay
// green for a widget that never applies the direction at runtime (an early `return` above the
// call, a handler that never fires). Only a real WKWebView settles it.
//
// Run it via ./run.sh.
//
// Usage: rtlcheck <SampleWidgets dir> <extracted-api.js>

let args = CommandLine.arguments
guard args.count >= 3 else { fputs("usage: rtlcheck <widgets-dir> <api.js>\n", stderr); exit(2) }
let widgetsDir = URL(fileURLWithPath: args[1])
let apiJS = try! String(contentsOf: URL(fileURLWithPath: args[2]), encoding: .utf8)

/// A fake native side. Widgets ask for SF Symbols and Last.fm data at startup; answering the
/// symbol requests keeps them from stalling before they ever handle a state push.
final class Bridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    func userContentController(_ ucc: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let body = m.body as? [String: Any], let type = body["type"] as? String,
              let id = body["requestId"] as? String else { return }
        if type == "symbol" {
            let fake = "data:image/png;base64,AAAA"
            webView?.evaluateJavaScript("window.NepTunes._resolveSymbol('\(id)', true, '\(fake)', null);")
        }
    }
}

@MainActor func settle(_ ms: UInt64) async { try? await Task.sleep(nanoseconds: ms * 1_000_000) }

struct Result {
    let name: String
    let dirRTL: String
    let dirLTR: String
    let countArabic: String?   // nil when the bundle does not vendor the kit
    let countEnglish: String?
    var mirrors: Bool { dirRTL == "rtl" && dirLTR == "ltr" }
    var formats: Bool {
        guard let ar = countArabic, let en = countEnglish else { return true }
        return ar == "٤٨٬٢١٣" && en == "48,213"
    }
}

@MainActor
final class Runner: NSObject, WKNavigationDelegate {
    var done: CheckedContinuation<Void, Never>?
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { done?.resume(); done = nil }

    /// The 2x2 red JPEG themecheck uses, so artwork-derived accents have something to chew on.
    static let artwork = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=="

    func state(language: String, locale: String, direction: String) -> [String: Any] {
        [
            // The three fields WidgetJSBridge publishes for localisation. `locale` is BCP-47:
            // the ICU form ("ar_SA") makes toLocaleString throw RangeError.
            "language": language, "locale": locale, "layoutDirection": direction,
            "track": ["title": "Honey", "artist": "Robyn", "album": "Honey",
                      "duration": 230, "artworkData": Self.artwork],
            "playerState": 2, "playerPosition": 10, "volume": 70, "isMuted": false,
            "shuffleEnabled": false, "repeatMode": 0, "rating": 0, "isLoved": false,
            "playerType": "appleMusic",
            "capabilities": ["canLove": true, "canDislike": true, "canRate": true,
                             "canAddToLibrary": true, "hasThreeStateRepeat": false],
        ]
    }

    func check(bundle: URL, name: String) async -> Result {
        let bridge = Bridge()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let ucc = WKUserContentController()
        ucc.add(bridge, name: "neptunes")
        ucc.addUserScript(WKUserScript(source: apiJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = ucc
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 220),
                            styleMask: [.borderless, .resizable], backing: .buffered, defer: false)
        panel.isOpaque = false; panel.backgroundColor = .clear
        let web = WKWebView(frame: panel.contentView!.bounds, configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = self
        bridge.webView = web
        panel.contentView!.addSubview(web)

        let index = bundle.appendingPathComponent("index.html")
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            done = c
            web.loadFileURL(index, allowingReadAccessTo: bundle.deletingLastPathComponent())
        }
        await settle(400)

        // Defaults straight from the manifest, exactly as the host would send them.
        var settings: [String: Any] = [:]
        if let md = FileManager.default.contents(atPath: bundle.appendingPathComponent("manifest.json").path),
           let m = (try? JSONSerialization.jsonObject(with: md)) as? [String: Any],
           let s = m["settings"] as? [String: Any], let schema = s["schema"] as? [[String: Any]] {
            for entry in schema { if let id = entry["id"] as? String { settings[id] = entry["default"] } }
        }
        let sJSON = String(data: try! JSONSerialization.data(withJSONObject: settings), encoding: .utf8)!
        await eval(web, "window.NepTunes.settings = \(sJSON); window.NepTunes._emit('settingschange', window.NepTunes.settings);")

        let (dirRTL, countAR) = await push(web, state(language: "ar", locale: "ar-SA", direction: "rtl"))
        // Flip back: a widget that hard-assigns "rtl" once would pass the first half and
        // strand an English user in a mirrored layout.
        let (dirLTR, countEN) = await push(web, state(language: "en", locale: "en-US", direction: "ltr"))

        panel.close()
        return Result(name: name, dirRTL: dirRTL, dirLTR: dirLTR,
                      countArabic: countAR, countEnglish: countEN)
    }

    /// Push a state, let the widget react, then read the direction it applied and — when the
    /// bundle vendors the kit — what its own copy of `formatCount` produces for that host.
    func push(_ web: WKWebView, _ state: [String: Any]) async -> (String, String?) {
        let json = String(data: try! JSONSerialization.data(withJSONObject: state), encoding: .utf8)!
        await eval(web, "window.NepTunes.state = \(json); window.NepTunes._emit('statechange', window.NepTunes.state);")
        await settle(500)
        let dir = await evalString(web, "document.documentElement.dir || ''")
        // NTKit is the vendored kit as it actually loaded in this page — not the master.
        let count = await evalString(web, "(typeof NTKit === 'undefined') ? '' : NTKit.formatCount(48213)")
        return (dir, count.isEmpty ? nil : count)
    }

    func eval(_ w: WKWebView, _ js: String) async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            w.evaluateJavaScript(js) { _, _ in c.resume() }
        }
    }

    func evalString(_ w: WKWebView, _ js: String) async -> String {
        await withCheckedContinuation { (c: CheckedContinuation<String, Never>) in
            w.evaluateJavaScript(js) { r, e in
                c.resume(returning: (r as? String) ?? "ERR:\(String(describing: e))")
            }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

Task { @MainActor in
    let runner = Runner()
    let bundles = try! FileManager.default
        .contentsOfDirectory(at: widgetsDir, includingPropertiesForKeys: nil)
        .filter { $0.pathExtension == "nepget" }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }

    guard !bundles.isEmpty else { print("no .nepget bundles in \(widgetsDir.path)"); exit(2) }

    var failures: [String] = []
    for bundle in bundles {
        let name = bundle.deletingPathExtension().lastPathComponent
        let r = await runner.check(bundle: bundle, name: name)
        let kit = r.countArabic.map { "\($0) / \(r.countEnglish ?? "?")" } ?? "no kit"
        if r.mirrors && r.formats {
            print("✅ \(name): dir rtl→\(r.dirRTL) ltr→\(r.dirLTR), count \(kit)")
        } else {
            failures.append(name)
            var why: [String] = []
            if !r.mirrors { why.append("never applied the host direction (got rtl→'\(r.dirRTL)', ltr→'\(r.dirLTR)')") }
            if !r.formats { why.append("formatCount ignored the host locale (got \(kit), expected ٤٨٬٢١٣ / 48,213)") }
            print("❌ \(name): \(why.joined(separator: "; "))")
        }
    }
    print("\n=== \(bundles.count - failures.count)/\(bundles.count) passed ===")
    if !failures.isEmpty { print("FAILED: \(failures.joined(separator: " | "))") }
    exit(failures.isEmpty ? 0 : 1)
}
app.run()
