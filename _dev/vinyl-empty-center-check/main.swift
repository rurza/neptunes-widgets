import AppKit
import WebKit

@MainActor
final class SymbolBridge: NSObject, WKScriptMessageHandler {
    weak var web: WKWebView?
    let rasterizer = SFSymbolRasterizer()

    nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            guard let body = message.body as? [String: Any], body["type"] as? String == "symbol",
                  let name = body["name"] as? String, let id = body["requestId"] as? String else { return }
            let size = body["size"] as? Double ?? 18
            let weight = body["weight"] as? String ?? "regular"
            let color = body["color"] as? String ?? "#ffffff"
            let scale = min(max(body["dpr"] as? Double ?? 2, 1), 3)
            let png = rasterizer.pngData(name: name, pointSize: size, weight: weight,
                                         hexColor: color, deviceScale: scale)
            let success = png != nil
            let dataURL = png.map { "data:image/png;base64," + $0.base64EncodedString() } ?? ""
            web?.evaluateJavaScript("window.NepTunes._resolveSymbol('\(id)', \(success), '\(dataURL)');")
        }
    }
}

@MainActor
final class Renderer: NSObject, WKNavigationDelegate {
    var finished = false
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finished = true }
    let web: WKWebView
    let window: NSWindow
    let bridge = SymbolBridge()

    init(api: String) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let controller = WKUserContentController()
        controller.add(bridge, name: "neptunes")
        controller.addUserScript(WKUserScript(source: api, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = controller
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 232, height: 232),
                          styleMask: [.borderless, .resizable], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        web = WKWebView(frame: window.contentView!.bounds, configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        super.init()
        window.contentView = web
        window.orderFrontRegardless()
        web.navigationDelegate = self
        bridge.web = web
    }

    func evaluate(_ js: String) -> Any? {
        var result: Any?
        var done = false
        web.evaluateJavaScript(js) { value, _ in result = value; done = true }
        while !done { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        return result
    }
    func snapshot() -> NSBitmapImageRep {
        var bitmap: NSBitmapImageRep?
        var done = false
        web.takeSnapshot(with: nil) { image, _ in
            if let image, let data = image.tiffRepresentation { bitmap = NSBitmapImageRep(data: data) }
            done = true
        }
        while !done { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        return bitmap!
    }
    func settle(_ seconds: Double = 0.25) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }
}

@main @MainActor
struct Entry {
    static func main() {
        let args = CommandLine.arguments
        guard args.count == 4 else { fputs("usage: check <bundle> <api.js> <evidence-dir>\n", stderr); exit(2) }
        let bundle = URL(fileURLWithPath: args[1])
        let api = try! String(contentsOfFile: args[2], encoding: .utf8)
        let evidence = URL(fileURLWithPath: args[3])
        try! FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true)
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let r = Renderer(api: api)
        r.web.loadFileURL(bundle.appendingPathComponent("index.html"), allowingReadAccessTo: bundle)
        while !r.finished { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
        r.settle(0.5)

        var problems: [String] = []
        var report = ["Native SF Symbol / WebKit ink-centering audit (play.fill, 18pt, default regular)"]
        for size in [80, 136, 217, 320] {
            let extent = size + 96
            r.window.setContentSize(NSSize(width: extent, height: extent))
            r.settle(0.15)
            for direction in ["ltr", "rtl"] {
                _ = r.evaluate("document.documentElement.dir='\(direction)'")
                r.settle(0.2)
                r.web.displayIfNeeded()
                r.window.displayIfNeeded()
                r.settle(0.15)
                let bitmap = r.snapshot()
                let filename = "play-\(size)-\(direction).png"
                try! bitmap.representation(using: .png, properties: [:])!.write(to: evidence.appendingPathComponent(filename))
                let js = """
                (() => {
                  const b=document.querySelector('#emptyOpen').getBoundingClientRect();
                  const i=document.querySelector('#emptyOpen img.sf-icon');
                  const r=i.getBoundingClientRect();
                  return {button:{x:b.x,width:b.width,y:b.y,height:b.height},
                    image:{x:r.x,width:r.width,y:r.y,height:r.height,naturalWidth:i.naturalWidth},
                    disc:(() => {const d=document.querySelector('.vinyl-shadow').getBoundingClientRect();return {x:d.x,width:d.width}})()};
                })()
                """
                guard let result = r.evaluate(js) as? [String: Any],
                      let button = result["button"] as? [String: Double],
                      let image = result["image"] as? [String: Double],
                      let naturalWidth = image["naturalWidth"], naturalWidth > 0 else {
                    problems.append("missing native play.fill render at \(size) \(direction)")
                    continue
                }
                let scale = CGFloat(bitmap.pixelsWide) / r.web.bounds.width
                let x0 = max(0, Int(image["x"]! * scale) - 2)
                let x1 = min(bitmap.pixelsWide - 1, Int((image["x"]! + image["width"]!) * scale) + 2)
                let cy = CGFloat(image["y"]! + image["height"]! / 2)
                let y0 = max(0, Int((r.web.bounds.height - cy - 7) * scale))
                let y1 = min(bitmap.pixelsHigh - 1, Int((r.web.bounds.height - cy + 7) * scale))
                var inkX: CGFloat = 0
                var inkWeight: CGFloat = 0
                if x0 <= x1 && y0 <= y1 {
                    for y in y0...y1 {
                        for x in x0...x1 {
                            guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
                            if color.redComponent > 0.78 && color.greenComponent > 0.78 && color.blueComponent > 0.78 {
                                let weight = min(color.redComponent, color.greenComponent, color.blueComponent)
                                inkX += CGFloat(x) * weight
                                inkWeight += weight
                            }
                        }
                    }
                }
                guard inkWeight > 0 else {
                    problems.append("no white symbol ink in WebKit pixels at \(size) \(direction): image=\(image), button=\(button), bitmap=\(bitmap.pixelsWide)x\(bitmap.pixelsHigh), scale=\(scale)")
                    continue
                }
                let measuredInkX = inkX / inkWeight / scale

                // Preserve the symbol's own rasterized ink-centroid offset (the glyph's
                // optical center is not its pixel centroid). Compare WebKit's observed ink
                // against that exact native PNG shape placed at the button's true center.
                let nativePNG = r.evaluate("document.querySelector('#emptyOpen img.sf-icon').src") as? String ?? ""
                guard let encoded = nativePNG.components(separatedBy: ",").last,
                      let pngData = Data(base64Encoded: encoded),
                      let native = NSBitmapImageRep(data: pngData),
                      let alpha = native.bitmapData else { problems.append("could not read native PNG at \(size) \(direction)"); continue }
                var nativeX: CGFloat = 0
                var nativeWeight: CGFloat = 0
                for y in 0..<native.pixelsHigh {
                    for x in 0..<native.pixelsWide {
                        let a = CGFloat(alpha[y * native.bytesPerRow + x * native.samplesPerPixel + 3]) / 255
                        nativeX += CGFloat(x) * a
                        nativeWeight += a
                    }
                }
                let nativeCentroidOffset = nativeX / nativeWeight / scale - image["width"]! / 2
                let buttonCenter = button["x"]! + button["width"]! / 2
                let residual = measuredInkX - (buttonCenter + nativeCentroidOffset)
                report.append("\(size)px \(direction): ink-vs-native-centered residual \(String(format: "%.2f", residual))pt, circle \(result["disc"]!)")
                if abs(residual) > 0.8 { problems.append("ink is off button center by \(String(format: "%.2f", residual))pt at \(size) \(direction)") }

            }
        }
        report.append("FAILURES: \(problems.count)")
        report.append(contentsOf: problems)
        try! report.joined(separator: "\n").write(to: evidence.appendingPathComponent("report.txt"), atomically: true, encoding: .utf8)
        print(report.joined(separator: "\n"))
        r.window.close()
        if !problems.isEmpty { exit(1) }
    }
}
