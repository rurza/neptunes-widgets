import AppKit
import WebKit

// Renders a real .nepget in a WKWebView configured like the widget host and asserts, from the
// pixels, that the text shadow is (a) actually painted for every text colour and (b) not clipped
// off by the `overflow: hidden` the ellipsis needs.
//
// Run it via ./run.sh — see README.md for why this is a renderer and not a unit test.
//
// Usage: shadowcheck <SampleWidgets dir> <extracted-api.js> <spec.json>

let args = CommandLine.arguments
guard args.count >= 4 else { fputs("usage: shadowcheck <widgets-dir> <api.js> <spec.json>\n", stderr); exit(2) }
let widgetsDir = URL(fileURLWithPath: args[1])
let apiJS = try! String(contentsOf: URL(fileURLWithPath: args[2]), encoding: .utf8)

// Mid grey, so a dark shadow and a light one are both measurable against it.
let BACKDROP = NSColor(srgbRed: 0x8a / 255.0, green: 0x8a / 255.0, blue: 0x8a / 255.0, alpha: 1)
// A channel difference this small is antialiasing noise, not shadow.
let NOISE = 2
// Start the "did the shadow escape?" band this far below the text box. The clip edge sits a
// fraction of a point under it (the half-leading of a 1.2 line-height), so a device row that
// straddles the edge is part shadow and would score a clipped render as a pass. The shadow
// reaches ~4pt down — offset 1 plus blur 3 — so an inset of 1 still leaves it plenty to find.
let PROBE_INSET = 1.0

// A rendered frame, plus the scale that maps CSS points to its pixels.
struct Frame {
    let px: [UInt8]         // RGBA8, row-major
    let w: Int, h: Int, scale: Int

    func diff(_ other: Frame, x: Int, y: Int) -> Int {
        guard x >= 0, y >= 0, x < w, y < h else { return 0 }
        let i = (y * w + x) * 4
        return (0..<3).map { abs(Int(px[i + $0]) - Int(other.px[i + $0])) }.max()!
    }

    /// Pixels in a CSS-point rect that differ from `other` by more than noise.
    func differingPixels(from other: Frame, cssRect r: (x: Double, y: Double, w: Double, h: Double)) -> Int {
        let x0 = max(0, Int((r.x * Double(scale)).rounded(.down)))
        let y0 = max(0, Int((r.y * Double(scale)).rounded(.down)))
        let x1 = min(w, Int(((r.x + r.w) * Double(scale)).rounded(.up)))
        let y1 = min(h, Int(((r.y + r.h) * Double(scale)).rounded(.up)))
        var n = 0
        guard y1 > y0, x1 > x0 else { return 0 }
        for y in y0..<y1 {
            for x in x0..<x1 where diff(other, x: x, y: y) > NOISE { n += 1 }
        }
        return n
    }

    /// CSS-point bounds of everything that differs from `other` — where the shadow actually landed.
    func differingBox(from other: Frame) -> (x0: Double, y0: Double, x1: Double, y1: Double)? {
        var minX = w, minY = h, maxX = -1, maxY = -1
        for y in 0..<h {
            for x in 0..<w where diff(other, x: x, y: y) > NOISE {
                minX = min(minX, x); maxX = max(maxX, x)
                minY = min(minY, y); maxY = max(maxY, y)
            }
        }
        guard maxX >= 0 else { return nil }
        let s = Double(scale)
        return (Double(minX) / s, Double(minY) / s, Double(maxX + 1) / s, Double(maxY + 1) / s)
    }

    func write(to path: String) {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h,
                                   bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                   colorSpaceName: .deviceRGB, bytesPerRow: w * 4, bitsPerPixel: 32)!
        px.withUnsafeBufferPointer { rep.bitmapData!.update(from: $0.baseAddress!, count: px.count) }
        try? rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
    }
}

// The native side, faking just enough for layout: a 16pt opaque PNG for every symbol request.
final class Bridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    let icon: String = {
        let img = NSImage(size: NSSize(width: 32, height: 32))
        img.lockFocus(); NSColor.white.setFill(); NSRect(x: 0, y: 0, width: 32, height: 32).fill(); img.unlockFocus()
        let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
        return "data:image/png;base64," + rep.representation(using: .png, properties: [:])!.base64EncodedString()
    }()
    func userContentController(_ ucc: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let body = m.body as? [String: Any], body["type"] as? String == "symbol",
              let id = body["requestId"] as? String else { return }
        webView?.evaluateJavaScript("window.NepTunes._resolveSymbol('\(id)', true, '\(icon)', null);")
    }
}

@MainActor func settle(_ ms: UInt64) async { try? await Task.sleep(nanoseconds: ms * 1_000_000) }


@MainActor
final class Renderer: NSObject, WKNavigationDelegate {
    var done: CheckedContinuation<Void, Never>?
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { done?.resume(); done = nil }

    var web: WKWebView!
    var panel: NSPanel!
    private let bridge = Bridge()

    /// Load a bundle into a host-replica web view sized like the widget's window.
    func load(bundle: URL, width: Double, height: Double, appearance: String) async {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let ucc = WKUserContentController()
        ucc.add(bridge, name: "neptunes")
        // The real injected API, verbatim from WidgetJSBridge.swift, so this can't drift.
        ucc.addUserScript(WKUserScript(source: apiJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = ucc
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        // Drives the same effectiveAppearance -> prefers-color-scheme path a real system switch
        // does, without disturbing the developer's desktop. Matters for `textColor: system`.
        NSApp.appearance = NSAppearance(named: appearance == "light" ? .aqua : .darkAqua)

        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                        styleMask: [.borderless, .resizable], backing: .buffered, defer: false)
        panel.isOpaque = false; panel.backgroundColor = .clear
        web = WKWebView(frame: panel.contentView!.bounds, configuration: config)
        web.setValue(false, forKey: "drawsBackground")   // chromeless, like the host
        web.navigationDelegate = self
        bridge.webView = web
        panel.contentView!.addSubview(web)

        // Land every transition and animation on its end state at once. This harness never
        // composites — `requestAnimationFrame` does not fire — so a transition started by the
        // widget's own JS never advances a single step and the property is frozen at its *start*
        // value for good. Artwork was the case that exposed it: its cover is faded in with
        // `transition: opacity 0.3s`, so the element ended up correct in every other respect —
        // right class, right background-image — and stuck at `opacity: 0`, leaving the labels
        // over a near-black placeholder where a black shadow cannot be measured. No sleep fixes
        // that; nothing is ticking.
        ucc.addUserScript(WKUserScript(source: """
        (function () {
          var css = '*, *::before, *::after { transition: none !important; animation: none !important; }';
          var apply = function () {
            var s = document.createElement('style');
            s.textContent = css;
            (document.head || document.documentElement).appendChild(s);
          };
          if (document.head) apply(); else document.addEventListener('DOMContentLoaded', apply);
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            done = c
            web.loadFileURL(bundle.appendingPathComponent("index.html"),
                            allowingReadAccessTo: bundle.deletingLastPathComponent())
        }
        await settle(400)
    }

    func push(settings: [String: Any], track: [String: Any]) async {
        let state: [String: Any] = [
            "track": track, "playerState": 2, "playerPosition": 10, "volume": 70, "isMuted": false,
            "shuffleEnabled": false, "repeatMode": 0, "rating": 0, "isLoved": false,
            "playerType": "appleMusic", "layoutDirection": "ltr",
            "capabilities": ["canLove": true, "canDislike": true, "canRate": true,
                             "canAddToLibrary": true, "hasThreeStateRepeat": false]
        ]
        let s = String(data: try! JSONSerialization.data(withJSONObject: settings), encoding: .utf8)!
        let t = String(data: try! JSONSerialization.data(withJSONObject: state), encoding: .utf8)!
        await eval("window.NepTunes.settings = \(s); window.NepTunes._emit('settingschange', window.NepTunes.settings);")
        await eval("window.NepTunes.state = \(t); window.NepTunes._emit('statechange', window.NepTunes.state);")
        await settle(600)
    }

    /// Snapshot composited over an opaque backdrop, so a shadow's alpha becomes a colour difference.
    func frame(width: Double, height: Double) async -> Frame {
        let cfg = WKSnapshotConfiguration()
        cfg.rect = CGRect(x: 0, y: 0, width: width, height: height)
        let img: NSImage? = await withCheckedContinuation { c in
            web.takeSnapshot(with: cfg) { i, _ in c.resume(returning: i) }
        }
        guard let img else { fputs("snapshot failed\n", stderr); exit(3) }
        let scale = 2
        let pw = Int(width) * scale, ph = Int(height) * scale
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pw, pixelsHigh: ph,
                                   bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                   colorSpaceName: .deviceRGB, bytesPerRow: pw * 4, bitsPerPixel: 32)!
        rep.size = NSSize(width: width, height: height)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        BACKDROP.setFill()
        NSRect(x: 0, y: 0, width: width, height: height).fill()
        img.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
        NSGraphicsContext.restoreGraphicsState()
        let buf = UnsafeBufferPointer(start: rep.bitmapData!, count: pw * ph * 4)
        return Frame(px: Array(buf), w: pw, h: ph, scale: scale)
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

/// The glyphs' own box, from a Range over the text node — independent of any padding the element
/// carries. This is the whole point: the fix works by padding the clip box outward, so an
/// assertion anchored to the *element* box would move with the fix and prove nothing. The text
/// does not move, so anchor to it.
let TEXT_RECT_JS = """
(function (sel) {
  var el = document.querySelector(sel);
  if (!el) return '';
  var r = document.createRange();
  r.selectNodeContents(el);
  var b = r.getBoundingClientRect();
  return [b.left, b.top, b.right, b.bottom].join(',');
})
"""

@MainActor
func run() async -> Int {
    let specData = FileManager.default.contents(atPath: args[3])!
    let spec = (try! JSONSerialization.jsonObject(with: specData)) as! [String: Any]
    let cases = spec["cases"] as! [[String: Any]]
    var failures: [String] = []

    for c in cases {
        let widget = c["widget"] as! String
        let label = c["label"] as! String
        let appearance = c["appearance"] as? String ?? "dark"
        let probe = c["probe"] as! String
        let width = c["width"] as? Double ?? 280
        let height = c["height"] as? Double ?? 100
        let settings = c["settings"] as! [String: Any]
        let track = c["track"] as! [String: Any]
        let bundle = widgetsDir.appendingPathComponent("\(widget).nepget")

        let r = Renderer()
        await r.load(bundle: bundle, width: width, height: height, appearance: appearance)

        // With the shadow on.
        await r.push(settings: settings, track: track)
        let shadowCSS = await r.eval("getComputedStyle(document.querySelector('\(probe)')).textShadow")
        let rectCSV = await r.eval("(\(TEXT_RECT_JS))('\(probe)')")
        // Where every pinned label's glyphs sit. Pinned in spec.json from a render taken *before*
        // the shadow gutter existed, because the whole risk in paying for that gutter with padding
        // and taking it back with negative margins is that the two stop cancelling. Several of
        // these labels already carry a margin-top of their own, which a `margin` shorthand would
        // quietly eat.
        let pins = c["pin"] as? [String: [Double]] ?? [:]
        var measuredPins: [String: [Double]] = [:]
        for sel in (c["pinSelectors"] as? [String] ?? Array(pins.keys)).sorted() {
            let csv = await r.eval("(\(TEXT_RECT_JS))('\(sel)')")
            measuredPins[sel] = csv.split(separator: ",").compactMap { Double($0) }
        }
        let lit = await r.frame(width: width, height: height)

        // The same frame with the text shadow suppressed in CSS — the difference between the two
        // IS the shadow. Doing it this way rather than through each widget's own setting needs no
        // per-widget knowledge, isolates the *text* shadow from whatever else a `textShadow`
        // toggle happens to turn off, and costs no layout (a shadow occupies no space).
        await r.eval("""
        (function () {
          var s = document.createElement('style');
          s.id = 'shadowcheck-off';
          s.textContent = '*, *::before, *::after { text-shadow: none !important; }';
          document.head.appendChild(s);
        })()
        """)
        await settle(200)
        let unlit = await r.frame(width: width, height: height)
        r.close()

        var problems: [String] = []

        // 1. The shadow must exist at all. Minimal's `body.light` used to force it to `none`, so
        //    the Shadow Opacity slider did nothing whatsoever for anyone who picked black text.
        if shadowCSS.isEmpty || shadowCSS == "none" {
            problems.append("text-shadow on \(probe) is `\(shadowCSS)` — the shadow setting draws nothing")
        }

        guard rectCSV.split(separator: ",").count == 4 else {
            failures.append(label)
            print("❌ \(label): could not measure \(probe)")
            continue
        }
        let v = rectCSV.split(separator: ",").map { Double($0)! }
        let (tl, tt, tr, tb) = (v[0], v[1], v[2], v[3])

        // 2. The shadow must survive past the glyphs' own box. `overflow: hidden` (which
        //    `text-overflow: ellipsis` requires) clips at the padding box, and a 1.2 line-height
        //    leaves so little half-leading that a descender's shadow is cut dead at the edge.
        let below = lit.differingPixels(from: unlit, cssRect: (x: tl - 4, y: tb + PROBE_INSET, w: (tr - tl) + 8, h: 2))
        if below == 0 {
            problems.append(String(format: "shadow is clipped at the bottom of %@ (y=%.1f): 0 shadow pixels below it", probe, tb))
        }
        // Same clip, other axis: the blur spreads sideways off the first glyph too.
        let leftOf = lit.differingPixels(from: unlit, cssRect: (x: tl - 3, y: tt, w: 3, h: tb - tt))
        if leftOf == 0 {
            problems.append(String(format: "shadow is clipped at the left of %@ (x=%.1f): 0 shadow pixels beside it", probe, tl))
        }

        // 3. …and buying that room must not have moved a single glyph.
        for (sel, want) in pins.sorted(by: { $0.key < $1.key }) {
            guard let got = measuredPins[sel], got.count == 4 else {
                problems.append("pinned \(sel) could not be measured")
                continue
            }
            let drift = zip(got, want).map { abs($0 - $1) }.max() ?? 0
            if drift > 0.05 {
                problems.append(String(format: "%@ moved: pinned [%@], rendered [%@]", sel,
                                       want.map { String(format: "%.2f", $0) }.joined(separator: ", "),
                                       got.map { String(format: "%.2f", $0) }.joined(separator: ", ")))
            }
        }
        // No pins yet? Print the block to paste into spec.json, rather than passing silently as
        // if the layout were guarded. Capture these from the tree *before* the gutter goes in.
        if pins.isEmpty {
            let body = measuredPins.sorted { $0.key < $1.key }
                .map { "\"\($0.key)\": [\($0.value.map { String(format: "%.4f", $0) }.joined(separator: ", "))]" }
                .joined(separator: ", ")
            print("ℹ️  \(label): unpinned layout — add  \"pin\": { \(body) }")
        }

        // A whole-frame count, reported only on failure: if this is 0 the shadow was never lit in
        // the first place and the two frames are the same picture, which is a fault in the check
        // rather than in the widget. Set SHADOWCHECK_DUMP=<dir> to get the frames themselves.
        if !problems.isEmpty {
            let whole = lit.differingPixels(from: unlit, cssRect: (x: 0, y: 0, w: width, h: height))
            var note = "(\(whole) px of shadow in the frame overall"
            if let box = lit.differingBox(from: unlit) {
                note += String(format: ", spanning x %.1f..%.1f y %.1f..%.1f",
                               box.x0, box.x1, box.y0, box.y1)
            }
            problems.append(note + ")")
            if let dir = ProcessInfo.processInfo.environment["SHADOWCHECK_DUMP"] {
                let stem = label.replacingOccurrences(of: "/", with: "-")
                lit.write(to: "\(dir)/\(stem) · lit.png")
                unlit.write(to: "\(dir)/\(stem) · unlit.png")
            }
        }

        if problems.isEmpty {
            print("✅ \(label): shadow `\(shadowCSS)`, \(below) px below + \(leftOf) px beside \(probe), layout unmoved")
        } else {
            failures.append(label)
            print("❌ \(label):")
            for p in problems { print("     · \(p)") }
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
