import AppKit
import WebKit

// Loads each real .nepget in a WKWebView configured like the widget host, pushes the settings
// the host would push, and measures what its hover affordance actually does.
//
// A widget cannot use `:hover`. Its panel never becomes key, so AppKit delivers no mouseMoved
// events to the web view and WebKit never re-evaluates the hover chain — see
// `NepTunes Widget/README.md` → ":hover does not work in a widget".
// `WidgetWindowController.setHoverClass` toggles `nt-hover` on <html> from system-wide mouse
// monitors instead, and that class is exactly what this harness toggles.
//
// Each case names an element and what it must do:
//
//   hover-gated    — off screen until `nt-hover` lands, on screen while it is there, off screen
//                    again once it goes. `"inert": true` additionally requires it to stop taking
//                    clicks while it is off screen.
//   always-visible — on screen in all three phases (the "Always" side of the same setting).
//
// Opacity is measured up the whole ancestor chain, because that is what a user sees: a control
// row at opacity 1 inside a panel at opacity 0 is not on screen, and a panel at opacity 1 whose
// row is hidden is very much still on screen.
//
// Run it via ./run.sh — see README.md for what the cases mean.
//
// Usage: hovercheck <SampleWidgets dir> <extracted-api.js> <spec.json>

let args = CommandLine.arguments
guard args.count >= 4 else { fputs("usage: hovercheck <widgets-dir> <api.js> <spec.json>\n", stderr); exit(2) }
let widgetsDir = URL(fileURLWithPath: args[1])
let apiJS = try! String(contentsOf: URL(fileURLWithPath: args[2]), encoding: .utf8)

/// A fake native side. Only `symbol` matters here: an unanswered request leaves an `<img>`
/// without a source forever, and a bundle that sizes itself around its icons would lay out
/// against boxes that never fill.
final class Bridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    /// 1×1 transparent PNG. The pixels are irrelevant; that the request resolves is not.
    static let pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

    func userContentController(_ ucc: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let body = m.body as? [String: Any], body["type"] as? String == "symbol",
              let id = body["requestId"] as? String else { return }
        webView?.evaluateJavaScript("window.NepTunes._resolveSymbol('\(id)', true, '\(Bridge.pixel)');")
    }
}

@MainActor func settle(_ ms: UInt64) async { try? await Task.sleep(nanoseconds: ms * 1_000_000) }

/// What the user actually sees of `selector`: the product of every opacity from the element up
/// to <html>, plus the element's own `pointer-events`. Returns `"<opacity>|<pointer-events>"`,
/// or `"MISSING"` when the bundle has no such element.
func measureJS(_ selector: String) -> String {
    // Through JSON so a selector carrying quotes cannot break out of the script.
    let quoted = String(data: try! JSONSerialization.data(withJSONObject: [selector]), encoding: .utf8)!
    return """
    (function () {
      var el = document.querySelector(\(quoted)[0]);
      if (!el) return 'MISSING';
      var opacity = 1, node = el;
      while (node && node.nodeType === 1) {
        var cs = getComputedStyle(node);
        // display:none / visibility:hidden are not opacities, but they hide just as hard.
        if (cs.display === 'none' || cs.visibility === 'hidden') { opacity = 0; break; }
        opacity *= parseFloat(cs.opacity);
        node = node.parentElement;
      }
      return opacity.toFixed(3) + '|' + getComputedStyle(el).pointerEvents;
    })()
    """
}

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
        // The real injected API, verbatim, so this cannot drift from what ships.
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

        // This panel is never ordered front — nothing here draws to a screen — so WebKit has no
        // display link driving it and a CSS transition never progresses: `getComputedStyle`
        // keeps returning the value the property STARTED at, however long you wait. That reads
        // as a widget whose hover state simply never changes (and it silently inverts per
        // bundle, depending on which end its markup starts from). Cut the transitions and every
        // reveal resolves to its end state on the spot, which is the state being checked.
        await eval("""
        (function () {
          var s = document.createElement('style');
          s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
          document.head.appendChild(s);
        })()
        """)
    }

    /// Mirror the host: settings first, then a playing track, each announced the way the bridge
    /// announces them.
    func push(settings: [String: Any], track: [String: Any]) async {
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
    }

    func hover(_ on: Bool) async {
        // Character for character what WidgetWindowController.setHoverClass evaluates.
        await eval("document.documentElement.classList.toggle('nt-hover', \(on ? "true" : "false"))")
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

/// One phase of a case: what the element looked like at a moment in time.
struct Sample {
    let opacity: Double
    let pointerEvents: String
    let raw: String

    init(_ raw: String) {
        self.raw = raw
        let parts = raw.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        opacity = parts.count == 2 ? (Double(parts[0]) ?? -1) : -1
        pointerEvents = parts.count == 2 ? parts[1] : "?"
    }

    var missing: Bool { raw == "MISSING" }
    var onScreen: Bool { opacity >= 0.99 }
    var offScreen: Bool { opacity >= 0 && opacity <= 0.01 }
}

@MainActor
func run() async -> Int {
    let specData = FileManager.default.contents(atPath: args[3])!
    let spec = (try! JSONSerialization.jsonObject(with: specData)) as! [String: Any]
    let cases = spec["cases"] as! [[String: Any]]
    let track = spec["track"] as! [String: Any]
    var failures: [String] = []

    for c in cases {
        let widget = c["widget"] as! String
        let selector = c["selector"] as! String
        let expect = c["expect"] as! String
        let why = c["why"] as! String
        let inert = c["inert"] as? Bool ?? false
        let overrides = c["settings"] as? [String: Any] ?? [:]
        let label = "\(widget) \(selector) [\(overrides.map { "\($0)=\($1)" }.sorted().joined(separator: ","))]"

        let bundle = widgetsDir.appendingPathComponent("\(widget).nepget")
        guard let manifestData = FileManager.default.contents(
                atPath: bundle.appendingPathComponent("manifest.json").path),
              let manifest = (try? JSONSerialization.jsonObject(with: manifestData)) as? [String: Any]
        else {
            failures.append(label)
            print("❌ \(label): no manifest.json")
            continue
        }

        // The settings the host pushes: the manifest's own defaults, then this case's overrides.
        var settings: [String: Any] = [:]
        if let schema = (manifest["settings"] as? [String: Any])?["schema"] as? [[String: Any]] {
            for definition in schema {
                if let id = definition["id"] as? String, let value = definition["default"] { settings[id] = value }
            }
        }
        for (k, v) in overrides { settings[k] = v }

        let defaultSize = manifest["defaultSize"] as? [String: Any] ?? [:]
        let width = defaultSize["width"] as? Double ?? 320
        let height = defaultSize["height"] as? Double ?? 320

        let r = Renderer()
        await r.load(bundle: bundle, width: width, height: height)
        await r.push(settings: settings, track: track)
        await settle(500)                       // the bundle's own settingschange/statechange work
        let idle = Sample(await r.eval(measureJS(selector)))
        await r.hover(true)
        await settle(300)
        let hovered = Sample(await r.eval(measureJS(selector)))
        await r.hover(false)                    // and it has to hide again, not latch open
        await settle(300)
        let after = Sample(await r.eval(measureJS(selector)))
        r.close()

        var problems: [String] = []
        if idle.missing || hovered.missing || after.missing {
            problems.append("no element matches `\(selector)` — the bundle changed shape, or its script died")
        } else if expect == "hover-gated" {
            if !idle.offScreen {
                problems.append(String(format: "idle: %@ is at opacity %.3f, expected it off screen",
                                       selector, idle.opacity))
            }
            if !hovered.onScreen {
                problems.append(String(format: "nt-hover: %@ is at opacity %.3f, expected it fully on screen",
                                       selector, hovered.opacity))
            }
            if !after.offScreen {
                problems.append(String(format: "after nt-hover left: %@ stayed at opacity %.3f — it latched open",
                                       selector, after.opacity))
            }
            if inert {
                if idle.pointerEvents != "none" {
                    problems.append("idle: pointer-events is `\(idle.pointerEvents)` — invisible controls still take clicks")
                }
                if hovered.pointerEvents == "none" {
                    problems.append("nt-hover: pointer-events is `none` — the revealed controls cannot be clicked")
                }
                if after.pointerEvents != "none" {
                    problems.append("after nt-hover left: pointer-events is `\(after.pointerEvents)`")
                }
            }
        } else if expect == "always-visible" {
            for (phase, s) in [("idle", idle), ("nt-hover", hovered), ("after nt-hover left", after)] {
                if !s.onScreen {
                    problems.append(String(format: "%@: %@ is at opacity %.3f, expected it fully on screen",
                                           phase, selector, s.opacity))
                }
            }
        } else {
            problems.append("unknown expectation `\(expect)`")
        }

        if problems.isEmpty {
            let shape = expect == "hover-gated"
                ? "hidden → revealed → hidden\(inert ? ", inert while hidden" : "")"
                : "on screen throughout"
            print("✅ \(label): \(shape) — \(why)")
        } else {
            failures.append(label)
            print("❌ \(label) — \(why)")
            for p in problems { print("     · \(p)") }
            print("     idle=\(idle.raw)  nt-hover=\(hovered.raw)  after=\(after.raw)")
        }
    }

    print("\n=== \(cases.count - failures.count)/\(cases.count) passed ===")
    if !failures.isEmpty { print("FAILED: \(failures.joined(separator: " | "))") }
    return failures.isEmpty ? 0 : 1
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
Task { @MainActor in exit(Int32(await run())) }
app.run()
