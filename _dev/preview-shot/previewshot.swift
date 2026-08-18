import AppKit
import WebKit

// Renders a bundle's `preview.jpg` from the bundle itself: the real HTML/CSS/JS in a WKWebView
// configured like the widget host, the real injected API, real SF Symbols rasterised natively
// the way the host rasterises them — snapshotted, then composited onto the gallery backdrop.
//
// The alternative, and what most of the previews in this tree still are, is `_dev/make-previews.py`:
// a hand-drawn PIL impression of each widget. Those drift the moment a bundle changes and cannot
// show what a bundle actually does — Glass's mock had a flat panel where the real widget has
// frosted glass over the cover, and drew its own approximations of the transport glyphs.
//
// Usage: previewshot <SampleWidgets dir> <extracted-api.js> <spec.json> [Widget ...]
//        (no widget names = every widget listed in the spec)

let args = CommandLine.arguments
guard args.count >= 4 else {
    fputs("usage: previewshot <widgets-dir> <api.js> <spec.json> [Widget ...]\n", stderr)
    exit(2)
}
let widgetsDir = URL(fileURLWithPath: args[1])
let apiJS = try! String(contentsOf: URL(fileURLWithPath: args[2]), encoding: .utf8)
let wanted = Set(args.dropFirst(4))

let CANVAS = NSSize(width: 960, height: 400)   // what the picker and the web gallery expect
let SNAPSHOT_SCALE: CGFloat = 3                // supersample, then downscale into the canvas
let FIT = 0.92                                 // fraction of the canvas the window may occupy

// MARK: - Colour helpers

extension NSColor {
    /// `#rgb` / `#rrggbb`, the form the spec is written in, and CSS `rgb()` / `rgba()`, the form
    /// a bundle's own colour variables come back in.
    ///
    /// Both, because this parser is on the receiving end of `resolveColor()` in sfsymbols.js,
    /// which hands over whatever `getComputedStyle` returns for the widget's ink variable — and
    /// computed style reports a custom property verbatim as authored. A bundle that writes
    /// `--icon-color: rgba(255, 255, 255, 0.9)` therefore sends exactly that string. Scanning it
    /// for hex digits finds none, which used to leave `v` at zero and rasterise every glyph
    /// BLACK, on a dark panel, in a shipped preview — while the same widget drew them white on a
    /// real desktop, because the shipping rasterizer (`NSColor(hexString:)` in NepTunesKit)
    /// accepts the functional notation. This harness has to accept everything that one does or
    /// it is not previewing the widget the user gets.
    convenience init(hex: String) {
        let trimmed = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.lowercased().hasPrefix("rgb") {
            let parts = trimmed.drop(while: { $0 != "(" }).dropFirst().prefix(while: { $0 != ")" })
                .split(whereSeparator: { ",/ ".contains($0) })
                .compactMap { Double($0) }
            if parts.count >= 3 {
                self.init(srgbRed: CGFloat(parts[0]) / 255, green: CGFloat(parts[1]) / 255,
                          blue: CGFloat(parts[2]) / 255,
                          alpha: parts.count > 3 ? CGFloat(parts[3]) : 1)
                return
            }
        }
        var s = trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "# "))
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        self.init(srgbRed: CGFloat((v >> 16) & 0xff) / 255,
                  green: CGFloat((v >> 8) & 0xff) / 255,
                  blue: CGFloat(v & 0xff) / 255,
                  alpha: 1)
    }
}

// MARK: - The fake native side

/// Answers the two things a bundle asks the host for while it renders: SF Symbols, and nothing
/// else. `SFSymbolRasterizer` in NepTunesKit is the shipping version of this; the parameters it
/// takes (name, point size, weight, colour, dpr) are the ones the bridge forwards, so a preview
/// gets the same glyphs at the same weights the widget will draw on a real desktop.
final class Bridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    private(set) var unknownSymbols: [String] = []

    func userContentController(_ ucc: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let body = m.body as? [String: Any], body["type"] as? String == "symbol",
              let id = body["requestId"] as? String, let name = body["name"] as? String else { return }
        let size = body["size"] as? Double ?? 24
        let dpr = min(max(body["dpr"] as? Double ?? 2, 1), 3)
        let weight: NSFont.Weight = {
            switch body["weight"] as? String {
            case "bold": return .bold
            case "semibold": return .semibold
            case "medium": return .medium
            case "light": return .light
            default: return .regular
            }
        }()
        let tint = NSColor(hex: (body["color"] as? String) ?? "#ffffff")
        let config = NSImage.SymbolConfiguration(pointSize: size, weight: weight)
        guard let symbol = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
                .withSymbolConfiguration(config) else {
            if !unknownSymbols.contains(name) { unknownSymbols.append(name) }
            webView?.evaluateJavaScript("window.NepTunes._resolveSymbol('\(id)', false, '');") { _, _ in }
            return
        }
        guard let png = tinted(symbol, tint, dpr) else { return }
        webView?.evaluateJavaScript(
            "window.NepTunes._resolveSymbol('\(id)', true, 'data:image/png;base64,\(png)');") { _, _ in }
    }

    /// The glyph filled with `tint`, at `dpr` device pixels per point, as base64 PNG.
    private func tinted(_ image: NSImage, _ tint: NSColor, _ dpr: Double) -> String? {
        let size = image.size
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: Int((size.width * dpr).rounded()),
            pixelsHigh: Int((size.height * dpr).rounded()), bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        else { return nil }
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(origin: .zero, size: size))
        tint.set()
        NSRect(origin: .zero, size: size).fill(using: .sourceAtop)
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])?.base64EncodedString()
    }
}

// MARK: - Generated album art

/// An abstract cover: a diagonal two-stop gradient with a soft highlight. Deliberately not a real
/// album — a preview that ships in the app and on the web cannot borrow someone's artwork — but
/// enough of one that the widgets which tint themselves from the art have something to read.
func generatedCover(from: NSColor, to: NSColor, side: Int = 800) -> Data {
    let size = NSSize(width: side, height: side)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side,
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGradient(colors: [from, to])!.draw(in: NSRect(origin: .zero, size: size), angle: 45)
    NSGradient(colors: [NSColor(white: 1, alpha: 0.22), NSColor(white: 1, alpha: 0)])!
        .draw(fromCenter: NSPoint(x: side / 4, y: side * 3 / 4), radius: 0,
              toCenter: NSPoint(x: side / 4, y: side * 3 / 4), radius: CGFloat(side) * 0.7,
              options: [])
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .jpeg, properties: [.compressionFactor: 0.92])!
}

// MARK: - Backdrop

/// The gallery backdrop every preview in this tree sits on: a near-black vertical gradient with a
/// faint accent glow in the top-left corner. Kept in step with `_dev/make-previews.py`'s
/// `backdrop()` so a re-rendered preview still belongs in the same grid as the drawn ones.
func drawBackdrop(_ spec: [String: Any], in rect: NSRect) {
    let top = NSColor(hex: spec["top"] as? String ?? "#1A1A20")
    let bottom = NSColor(hex: spec["bottom"] as? String ?? "#0C0C10")
    NSGradient(colors: [top, bottom])!.draw(in: rect, angle: -90)

    let glow = NSColor(hex: spec["glow"] as? String ?? "#3A4A80").withAlphaComponent(0.20)
    let center = NSPoint(x: rect.width * 0.16, y: rect.maxY - rect.height * 0.12)
    NSGradient(colors: [glow, glow.withAlphaComponent(0)])!
        .draw(fromCenter: center, radius: 0, toCenter: center, radius: rect.height * 0.85, options: [])
}

// MARK: - Rendering one bundle

@MainActor func settle(_ ms: UInt64) async { try? await Task.sleep(nanoseconds: ms * 1_000_000) }

@MainActor
final class Shooter: NSObject, WKNavigationDelegate {
    var done: CheckedContinuation<Void, Never>?
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { done?.resume(); done = nil }

    var web: WKWebView!
    var panel: NSPanel!
    let bridge = Bridge()

    func load(bundle: URL, size: NSSize) async {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let ucc = WKUserContentController()
        ucc.add(bridge, name: "neptunes")
        ucc.addUserScript(WKUserScript(source: apiJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = ucc
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        panel = NSPanel(contentRect: NSRect(origin: .zero, size: size),
                        styleMask: [.borderless], backing: .buffered, defer: false)
        panel.isOpaque = false; panel.backgroundColor = .clear
        web = WKWebView(frame: panel.contentView!.bounds, configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        // Without this the snapshot comes back on an opaque white page and the widget's own drop
        // shadow lands on a white card instead of the backdrop.
        web.underPageBackgroundColor = .clear
        web.navigationDelegate = self
        bridge.webView = web
        panel.contentView!.addSubview(web)

        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            done = c
            web.loadFileURL(bundle.appendingPathComponent("index.html"),
                            allowingReadAccessTo: bundle.deletingLastPathComponent())
        }
        await settle(400)

        // Nothing here is ever ordered front, so WebKit has no display link and a CSS transition
        // never progresses: the artwork's own fade-in would leave every cover at opacity 0 and the
        // preview would show the no-artwork placeholder. Cut them and every widget renders its
        // settled state, which is the state a preview is of.
        await eval("""
        (function () {
          var s = document.createElement('style');
          s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
          document.head.appendChild(s);
        })()
        """)
    }

    func push(settings: [String: Any], state: [String: Any]) async {
        let s = String(data: try! JSONSerialization.data(withJSONObject: settings), encoding: .utf8)!
        let t = String(data: try! JSONSerialization.data(withJSONObject: state), encoding: .utf8)!
        await eval("window.NepTunes.settings = \(s); window.NepTunes._emit('settingschange', window.NepTunes.settings);")
        await eval("window.NepTunes.state = \(t); window.NepTunes._emit('statechange', window.NepTunes.state);")

        // Every icon is an async round-trip to the bridge, and bundles re-request the whole set
        // from their settingschange handler. Wait for the count to stop moving rather than
        // guessing a sleep — a preview shot one icon early is a preview with a hole in it.
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
            if n == previous { break }
            previous = n
        }
        await settle(200)
    }

    func snapshot(size: NSSize) async -> NSImage? {
        let config = WKSnapshotConfiguration()
        config.rect = web.bounds
        config.snapshotWidth = NSNumber(value: Double(size.width * SNAPSHOT_SCALE))
        return await withCheckedContinuation { (c: CheckedContinuation<NSImage?, Never>) in
            web.takeSnapshot(with: config) { image, error in
                if let error { fputs("snapshot failed: \(error)\n", stderr) }
                c.resume(returning: image)
            }
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

@MainActor
func run() async -> Int {
    let spec = (try! JSONSerialization.jsonObject(
        with: Data(contentsOf: URL(fileURLWithPath: args[3])))) as! [String: Any]
    let backdropSpec = spec["backdrop"] as? [String: Any] ?? [:]
    let coverSpec = spec["cover"] as? [String: Any] ?? [:]
    let trackSpec = spec["track"] as? [String: Any] ?? [:]
    let entries = (spec["widgets"] as! [[String: Any]])
        .filter { wanted.isEmpty || wanted.contains($0["name"] as! String) }
    guard !entries.isEmpty else {
        fputs("no widget in the spec matches \(wanted.sorted().joined(separator: ", "))\n", stderr)
        return 2
    }

    // A widget with `theme: auto` resolves against the desktop appearance, and the gallery is a
    // dark grid. Fix it here so a preview never depends on how the Mac running this is set up.
    NSApp.appearance = NSAppearance(named: .darkAqua)

    let cover = generatedCover(from: NSColor(hex: coverSpec["from"] as? String ?? "#E2603F"),
                               to: NSColor(hex: coverSpec["to"] as? String ?? "#2B2050"))
    var failures: [String] = []

    for entry in entries {
        let name = entry["name"] as! String
        let bundle = widgetsDir.appendingPathComponent("\(name).nepget")
        guard let manifestData = FileManager.default.contents(
                atPath: bundle.appendingPathComponent("manifest.json").path),
              let manifest = (try? JSONSerialization.jsonObject(with: manifestData)) as? [String: Any],
              let defaultSize = manifest["defaultSize"] as? [String: Any],
              let width = defaultSize["width"] as? Double, let height = defaultSize["height"] as? Double
        else {
            failures.append(name)
            print("❌ \(name): no manifest.json with a defaultSize")
            continue
        }

        // The settings a fresh install would have — a preview shows the widget as it arrives.
        var settings: [String: Any] = [:]
        if let schema = (manifest["settings"] as? [String: Any])?["schema"] as? [[String: Any]] {
            for definition in schema {
                if let id = definition["id"] as? String, let value = definition["default"] { settings[id] = value }
            }
        }
        for (k, v) in (entry["settings"] as? [String: Any] ?? [:]) { settings[k] = v }

        var track = trackSpec
        track["artworkData"] = cover.base64EncodedString()
        let state: [String: Any] = [
            "track": track,
            "playerState": entry["playerState"] as? Int ?? spec["playerState"] as? Int ?? 3,
            "playerPosition": 64, "volume": 70, "isMuted": false, "shuffleEnabled": false,
            "repeatMode": 1, "rating": 80, "isLoved": true, "playerType": "appleMusic",
            "layoutDirection": "ltr", "language": "en", "locale": "en-US",
            "capabilities": ["canLove": true, "canDislike": true, "canRate": true,
                             "canAddToLibrary": true, "hasThreeStateRepeat": true],
        ]

        let shooter = Shooter()
        let windowSize = NSSize(width: width, height: height)
        await shooter.load(bundle: bundle, size: windowSize)
        await shooter.push(settings: settings, state: state)
        let shot = await shooter.snapshot(size: windowSize)
        let unknown = shooter.bridge.unknownSymbols
        shooter.close()

        guard let shot else {
            failures.append(name)
            print("❌ \(name): WebKit returned no snapshot")
            continue
        }
        if !unknown.isEmpty {
            failures.append(name)
            print("❌ \(name): not an SF Symbol on this OS — \(unknown.joined(separator: ", "))")
            continue
        }

        // Compose: backdrop, then the window scaled to fill most of the canvas. The window
        // includes the bundle's transparent shadow gutter, so the drop shadow lands on the
        // backdrop exactly as it lands on a desktop.
        let canvas = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: Int(CANVAS.width), pixelsHigh: Int(CANVAS.height),
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        canvas.size = CANVAS
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: canvas)
        NSGraphicsContext.current?.imageInterpolation = .high
        let frame = NSRect(origin: .zero, size: CANVAS)
        drawBackdrop(backdropSpec, in: frame)
        let scale = min(CANVAS.width * FIT / width, CANVAS.height * FIT / height)
        let drawn = NSSize(width: (width * scale).rounded(), height: (height * scale).rounded())
        shot.draw(in: NSRect(x: ((CANVAS.width - drawn.width) / 2).rounded(),
                             y: ((CANVAS.height - drawn.height) / 2).rounded(),
                             width: drawn.width, height: drawn.height),
                  from: .zero, operation: .sourceOver, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()

        let jpeg = canvas.representation(using: .jpeg, properties: [.compressionFactor: 0.92])!
        let out = bundle.appendingPathComponent("preview.jpg")
        do { try jpeg.write(to: out) } catch {
            failures.append(name)
            print("❌ \(name): could not write preview.jpg — \(error)")
            continue
        }
        print(String(format: "✅ %@: %.0f×%.0f window rendered at %.2f× onto %.0f×%.0f — %@",
                     name, width, height, scale, CANVAS.width, CANVAS.height,
                     out.path.replacingOccurrences(of: widgetsDir.path + "/", with: "")))
    }

    if !failures.isEmpty { print("\nFAILED: \(failures.joined(separator: " | "))") }
    return failures.isEmpty ? 0 : 1
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
Task { @MainActor in exit(Int32(await run())) }
app.run()
