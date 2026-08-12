import AppKit
import WebKit

// Loads each real .nepget in a WKWebView configured like the widget host, injects the real
// javascriptAPI (extracted from WidgetJSBridge.swift, so it can't drift from what ships),
// flips the effective appearance, and diffs what the page renders.
//
// Run it via ./run.sh — see README.md for what the cases mean.
//
// Usage: themecheck <SampleWidgets dir> <extracted-api.js> <spec.json>

let args = CommandLine.arguments
guard args.count >= 4 else { fputs("usage: themecheck <widgets-dir> <api.js> <spec.json>\n", stderr); exit(2) }
let widgetsDir = URL(fileURLWithPath: args[1])
let apiJS = try! String(contentsOf: URL(fileURLWithPath: args[2]), encoding: .utf8)

// A fake native side: answers `symbol` requests with a data URL that ENCODES the requested
// colour, so a stale icon tint is directly observable from the DOM.
final class Bridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    var symbolColors: [String] = []
    func userContentController(_ ucc: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let body = m.body as? [String: Any], let type = body["type"] as? String else { return }
        if type == "symbol", let id = body["requestId"] as? String {
            let color = (body["color"] as? String ?? "?")
            symbolColors.append(color)
            // Encode the colour into the returned URL so the test can read it back.
            let fake = "data:image/png;base64,TINT(\(color))"
            let js = "window.NepTunes._resolveSymbol('\(id)', true, '\(fake)', null);"
            webView?.evaluateJavaScript(js)
        }
    }
}

@MainActor
func fingerprint(_ web: WKWebView) async -> String {
    // Everything a user would perceive as "the theme": root/body classes, the resolved text
    // + accent custom properties, the actual painted text colour, and the icon tints.
    let js = """
    (function () {
      // Widgets don't agree on which element carries the theme: <html> (Glass, Stack),
      // <body> (Minimal, FullPlayer) or #widget (Charts). Read all three, plus the
      // painted colours and icon tints, so nothing that flips can hide from the diff.
      var hosts = [document.documentElement, document.body, document.getElementById('widget')].filter(Boolean);
      var NAMES = ['--text-primary','--text','--fg','--ink','--title','--icon-color','--accent-ink','--on','--bg-color','--text-secondary'];
      var vars = hosts.map(function (h, i) {
        var cs = getComputedStyle(h);
        return i + ':' + NAMES.map(function (n) { return n + '=' + cs.getPropertyValue(n).trim(); }).join(',')
                 + '|bg=' + cs.backgroundColor + '|fg=' + cs.color;
      }).join(';;');
      var classes = hosts.map(function (h) { return h.className; }).join('/');
      var icons = Array.prototype.filter.call(document.querySelectorAll('img.sf-icon[data-symbol]'), function (i) {
        return i.offsetParent !== null;   // visible only
      }).map(function (i) {
        return (i.src || '').replace(/^data:image\\/png;base64,/, '');
      }).join('|');
      var texts = Array.prototype.map.call(
        document.querySelectorAll('h1,h2,.title,.artist,#title,#artist,.track-info,.name,.row,li,.value'),
        function (e) { return getComputedStyle(e).color + '/' + getComputedStyle(e).backgroundColor; }
      ).slice(0, 8).join('|');
      return JSON.stringify({ classes: classes, vars: vars, icons: icons, texts: texts });
    })()
    """
    return await withCheckedContinuation { cont in
        web.evaluateJavaScript(js) { r, e in cont.resume(returning: (r as? String) ?? "ERR:\(String(describing: e))") }
    }
}

@MainActor
func settle(_ ms: UInt64) async { try? await Task.sleep(nanoseconds: ms * 1_000_000) }

@MainActor
final class Runner: NSObject, WKNavigationDelegate {
    var done: CheckedContinuation<Void, Never>?
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { done?.resume(); done = nil }

    func check(bundle: URL, name: String, settingsOverride: [String: Any]) async -> (String, Bool, String, String) {
        let bridge = Bridge()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let ucc = WKUserContentController()
        ucc.add(bridge, name: "neptunes")
        // The real injected API, verbatim.
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

        // Mirror the host: set settings + state, then emit. Defaults from the manifest,
        // with any per-widget override applied (e.g. textColor: system).
        var settings: [String: Any] = [:]
        if let md = FileManager.default.contents(atPath: bundle.appendingPathComponent("manifest.json").path),
           let m = (try? JSONSerialization.jsonObject(with: md)) as? [String: Any],
           let s = m["settings"] as? [String: Any], let schema = s["schema"] as? [[String: Any]] {
            for entry in schema { if let id = entry["id"] as? String { settings[id] = entry["default"] } }
        }
        for (k, v) in settingsOverride { settings[k] = v }
        let sJSON = String(data: try! JSONSerialization.data(withJSONObject: settings), encoding: .utf8)!

        // A tiny 2x2 red JPEG so artwork-derived accents have something to chew on.
        let art = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=="
        let state: [String: Any] = [
            "track": ["title": "Honey", "artist": "Robyn", "album": "Honey", "duration": 230, "artworkData": art],
            "playerState": 2, "playerPosition": 10, "volume": 70, "isMuted": false,
            "shuffleEnabled": false, "repeatMode": 0, "rating": 0, "isLoved": false,
            "playerType": "appleMusic",
            "capabilities": ["canLove": true, "canDislike": true, "canRate": true, "canAddToLibrary": true, "hasThreeStateRepeat": false]
        ]
        let stJSON = String(data: try! JSONSerialization.data(withJSONObject: state), encoding: .utf8)!
        await eval(web, "window.NepTunes.settings = \(sJSON); window.NepTunes._emit('settingschange', window.NepTunes.settings);")
        await eval(web, "window.NepTunes.state = \(stJSON); window.NepTunes._emit('statechange', window.NepTunes.state);")
        await settle(700)

        // --- Flip the appearance and see whether the widget follows. ---
        NSApp.appearance = NSAppearance(named: .darkAqua)
        await settle(700)
        let darkFP = await fingerprint(web)

        NSApp.appearance = NSAppearance(named: .aqua)
        await settle(900)
        let lightFP = await fingerprint(web)

        panel.close()
        return (name, darkFP != lightFP, darkFP, lightFP)
    }

    func eval(_ w: WKWebView, _ js: String) async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            w.evaluateJavaScript(js) { _, _ in c.resume() }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

Task { @MainActor in
    let runner = Runner()
    let specData = FileManager.default.contents(atPath: args[3])!
    let spec = (try! JSONSerialization.jsonObject(with: specData)) as! [[String: Any]]
    var failures: [String] = []

    for c in spec {
        let name = c["widget"] as! String
        let settings = c["settings"] as! [String: Any]
        let expect = c["expect"] as! String
        let why = c["why"] as! String
        let bundle = widgetsDir.appendingPathComponent("\(name).nepget")
        let label = "\(name) [\(settings.map { "\($0)=\($1)" }.joined(separator: ","))]"

        let (_, changed, d, l) = await runner.check(bundle: bundle, name: name, settingsOverride: settings)
        func iconsOf(_ fp: String) -> String {
            guard let d = fp.data(using: .utf8),
                  let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return "?" }
            return (o["icons"] as? String) ?? ""
        }
        let dIcons = iconsOf(d), lIcons = iconsOf(l)
        let hasIcons = !dIcons.isEmpty
        let iconsChanged = dIcons != lIcons
        var ok = (expect == "react") ? changed : !changed
        // A widget whose panel flips in CSS can still leave natively-rasterised icons stale.
        // For follow-the-system cases that actually have icons, require the tint to change too.
        if expect == "react" && hasIcons && !iconsChanged { ok = false }
        if expect == "stable" && hasIcons && iconsChanged { ok = false }
        if ok {
            let icons = hasIcons ? (iconsChanged ? ", icons re-tinted" : ", icons unchanged") : ", no icons"
            print("✅ \(label): \(expect == "react" ? "re-themed" : "unchanged")\(icons) — \(why)")
        } else {
            failures.append(label)
            let d1 = hasIcons ? (iconsChanged ? "icons re-tinted" : "ICONS STALE") : "no icons"
            print("❌ \(label): expected \(expect) [panel changed=\(changed), \(d1)] — \(why)")
            print("   dark : \(d.prefix(260))")
            print("   light: \(l.prefix(260))")
        }
    }
    print("\n=== \(spec.count - failures.count)/\(spec.count) passed ===")
    if !failures.isEmpty { print("FAILED: \(failures.joined(separator: " | "))") }
    exit(failures.isEmpty ? 0 : 1)
}
app.run()
