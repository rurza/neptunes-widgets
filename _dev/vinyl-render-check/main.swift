import AppKit
import WebKit

private let positions = ["off", "left", "right", "bottom"]
private let baselinePadding = 48.0
private let candidatePadding = 40.0
private let registrationOffset = baselinePadding - candidatePadding
private let inkThreshold = 2
private let channelTolerance = 2

private struct RenderCase {
    let name: String
    let diameter: Double
    let label: String
    let controls: String
    let isDark: Bool
    var hasTrack: Bool = true
}

private struct Rect: Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var right: Double { x + width }
    var bottom: Double { y + height }

    func intersects(_ other: Rect) -> Bool {
        x < other.right && right > other.x && y < other.bottom && bottom > other.y
    }

    func translated(x dx: Double, y dy: Double) -> Rect {
        Rect(x: x + dx, y: y + dy, width: width, height: height)
    }
}

private struct Rendered {
    let bitmap: NSBitmapImageRep
    let rectangles: [String: Rect]
    let padding: [Double]
    let viewport: [Double]
    let widthScale: Double
    let heightScale: Double
}

private struct Pixel {
    // Premultiplied RGBA avoids treating arbitrary RGB values under zero alpha as ink.
    let r: UInt8
    let g: UInt8
    let b: UInt8
    let a: UInt8

    var channels: [Int] { [Int(r), Int(g), Int(b), Int(a)] }
}

@MainActor
private final class ResizeRequestHandler: NSObject, WKScriptMessageHandler {
    var receive: ((Double, Double) -> Void)?

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Double],
              let width = body["width"], let height = body["height"] else { return }
        receive?(width, height)
    }
}

private func jsonString(_ value: Any) -> String {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys])
    return String(data: data, encoding: .utf8)!
}

private func renderWindowSize(for renderCase: RenderCase, padding: Double) -> NSSize {
    func sideWidth(_ side: String) -> Double {
        let labelWidth = renderCase.label == side ? 160.0 : 0
        let controlsWidth = renderCase.controls == side ? 84.0 : 0
        let width = max(labelWidth, controlsWidth)
        return width == 0 ? 0 : width + 12
    }
    let bottomLabel = renderCase.label == "bottom" ? 160.0 : 0
    let bottomControls = renderCase.controls == "bottom" ? 84.0 : 0
    let bottomWidth = bottomLabel + bottomControls + (bottomLabel > 0 && bottomControls > 0 ? 6 : 0)
    let bottomExtra = bottomLabel > 0 || bottomControls > 0 ? 52.0 : 0
    return NSSize(
        width: max(renderCase.diameter, bottomWidth) + padding * 2 + sideWidth("left") + sideWidth("right"),
        height: renderCase.diameter + padding * 2 + bottomExtra
    )
}

@MainActor
private final class Renderer: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    private(set) var didFinish = false
    private let minimumSize: NSSize
    private let maximumSize: NSSize
    private let deferResizeRequests: Bool
    private var resizeHandler: ResizeRequestHandler?
    private(set) var requestedSizes: [NSSize] = []

    init(bundle: URL, renderCase: RenderCase, padding: Double, artworkURL: String,
         symbols: [String: String], symbolMapJSON: String,
         initialSize: NSSize? = nil, deferResizeRequests: Bool = false,
         minimumSize: NSSize, maximumSize: NSSize) {
        let size = initialSize ?? renderWindowSize(for: renderCase, padding: padding)
        let configuration = WKWebViewConfiguration()
        let handler = ResizeRequestHandler()
        configuration.userContentController.add(handler, name: "resize")
        let bridge = Self.bootstrapScript(
            renderCase: renderCase,
            artworkURL: artworkURL,
            symbolsJSON: symbolMapJSON
        )
        configuration.userContentController.addUserScript(WKUserScript(
            source: bridge,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        webView = WKWebView(
            frame: NSRect(x: 0, y: 0, width: size.width, height: size.height),
            configuration: configuration
        )
        self.minimumSize = minimumSize
        self.maximumSize = maximumSize
        self.deferResizeRequests = deferResizeRequests
        super.init()
        resizeHandler = handler
        handler.receive = { [weak self] width, height in self?.receiveResizeRequest(width: width, height: height) }
        webView.appearance = NSAppearance(named: renderCase.isDark ? .darkAqua : .aqua)
        webView.underPageBackgroundColor = .clear
        webView.navigationDelegate = self
        webView.loadFileURL(bundle.appendingPathComponent("index.html"), allowingReadAccessTo: bundle)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        didFinish = true
    }

    func evaluate(_ source: String) -> Any? {
        var result: Any?
        var completed = false
        webView.evaluateJavaScript(source) { value, _ in
            result = value
            completed = true
        }
        let deadline = Date().addingTimeInterval(10)
        while !completed && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        return completed ? result : nil
    }

    func waitForPage() throws {
        let deadline = Date().addingTimeInterval(15)
        while !didFinish && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        guard didFinish else { throw HarnessError.timeout("navigation did not finish") }

        let readyScript = #"""
        (() => {
          const images = Array.from(document.images);
          return document.fonts.status === 'loaded' && images.every((image) => image.complete) &&
            Array.from(document.querySelectorAll('.sf-icon')).every((image) =>
              image.complete && image.naturalWidth > 0);
        })()
        """#
        let imageDeadline = Date().addingTimeInterval(15)
        while Date() < imageDeadline {
            if (evaluate(readyScript) as? Bool == true) {
                // Let CSS transitions, artwork decoding, and first-layout observers settle.
                RunLoop.current.run(until: Date().addingTimeInterval(0.35))
                return
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
        let diagnostics = #"""
        JSON.stringify({fonts: document.fonts.status, images: Array.from(document.images).map((image) => ({
          symbol: image.dataset.symbol || 'artwork', src: image.currentSrc.slice(0, 48),
          complete: image.complete, width: image.naturalWidth, height: image.naturalHeight
        }))})
        """#
        throw HarnessError.timeout("fonts, cover, or SF Symbol images did not load: \(evaluate(diagnostics) as? String ?? "no diagnostics")")
    }

    func measurements() throws -> (rects: [String: Rect], padding: [Double], viewport: [Double]) {
        let script = #"""
        (() => {
          const selectors = {
            disc: '.vinyl-shadow', row: '.vinyl-row', label: '.track-info',
            controls: '.controls', bottom: '.bottom-row', title: '.title',
            artist: '.artist', grip: '.resize-grip', handle: '.resize-handle',
            emptyOpen: '.empty-open'
          };
          const rects = {};
          for (const [name, selector] of Object.entries(selectors)) {
            const element = document.querySelector(selector);
            if (!element || element.hidden || getComputedStyle(element).display === 'none') {
              rects[name] = null;
              continue;
            }
            const r = element.getBoundingClientRect();
            rects[name] = [r.x, r.y, r.width, r.height];
          }
          const style = getComputedStyle(document.querySelector('.widget'));
          return JSON.stringify({
            rects,
            padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
              .map((value) => parseFloat(value)),
            viewport: [document.documentElement.clientWidth, document.documentElement.clientHeight]
          });
        })()
        """#
        guard let json = evaluate(script) as? String,
              let data = json.data(using: .utf8),
              let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rawRects = root["rects"] as? [String: Any],
              let padding = root["padding"] as? [Double],
              let viewport = root["viewport"] as? [Double] else {
            throw HarnessError.invalidPage("could not read live element geometry")
        }
        var rectangles: [String: Rect] = [:]
        for (name, value) in rawRects {
            guard let values = value as? [Double], values.count == 4 else { continue }
            rectangles[name] = Rect(x: values[0], y: values[1], width: values[2], height: values[3])
        }
        return (rectangles, padding, viewport)
    }

    func snapshot() throws -> NSBitmapImageRep {
        var captured: NSImage?
        var captureError: Error?
        var completed = false
        let configuration = WKSnapshotConfiguration()
        configuration.rect = CGRect(origin: .zero, size: webView.frame.size)
        webView.takeSnapshot(with: configuration) { image, error in
            captured = image
            captureError = error
            completed = true
        }
        let deadline = Date().addingTimeInterval(15)
        while !completed && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        guard completed else { throw HarnessError.timeout("WKWebView snapshot timed out") }
        if let captureError { throw captureError }
        guard let image = captured, let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff) else {
            throw HarnessError.invalidPage("WKWebView returned no decodable bitmap")
        }
        return bitmap
    }

    func freezeMotionForFixture() {
        _ = evaluate(#"""
        (() => {
          if (!document.getElementById('__vinylRenderFreeze')) {
            const style = document.createElement('style');
            style.id = '__vinylRenderFreeze';
            style.textContent = `*, *::before, *::after {
              animation: none !important;
              transition: none !important;
              scroll-behavior: auto !important;
            }`;
            document.head.appendChild(style);
          }
          return true;
        })()
        """#)
        webView.layoutSubtreeIfNeeded()
    }

    func applyLatestResizeRequest() throws -> NSSize {
        guard let requested = requestedSizes.last else {
            throw HarnessError.invalidPage("widget did not request its panel-aware minimum size")
        }
        let bounded = boundedSize(width: requested.width, height: requested.height)
        resizeViewport(to: bounded)
        let expected = "Math.abs(document.documentElement.clientWidth-\(bounded.width))<1 && Math.abs(document.documentElement.clientHeight-\(bounded.height))<1"
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if evaluate(expected) as? Bool == true {
                RunLoop.current.run(until: Date().addingTimeInterval(0.15))
                return bounded
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        throw HarnessError.timeout("WKWebView did not adopt its bounded native setSize request")
    }

    private func receiveResizeRequest(width: Double, height: Double) {
        let bounded = boundedSize(width: width, height: height)
        requestedSizes.append(bounded)
        if !deferResizeRequests { resizeViewport(to: bounded) }
    }

    private func boundedSize(width: Double, height: Double) -> NSSize {
        NSSize(
            width: min(max(width, minimumSize.width), maximumSize.width),
            height: min(max(height, minimumSize.height), maximumSize.height)
        )
    }

    private func resizeViewport(to size: NSSize) {
        webView.setFrameSize(size)
        webView.layoutSubtreeIfNeeded()
    }

    private static func bootstrapScript(renderCase: RenderCase, artworkURL: String,
                                        symbolsJSON: String) -> String {
        let settings: [String: Any] = [
            "spinRpm": "33", "labelPosition": renderCase.label,
            "controlsPosition": renderCase.controls,
            "textColor": renderCase.isDark ? "white" : "black",
            "textShadow": true, "controlsBackground": true,
        ]
        var state: [String: Any] = [
            "playerState": renderCase.hasTrack ? 3 : 1,
            "playerType": "appleMusic",
            "layoutDirection": "ltr",
        ]
        if renderCase.hasTrack {
            state["track"] = [
                "title": "The Quiet Geometry of a Record Playing in a Room",
                "artist": "A Deterministic Test Artist",
                "album": "Baseline Comparison",
                "duration": 241.0,
            ] as [String: Any]
        }
        let seed: [String: Any] = [
            "settings": settings,
            "state": state,
            "artworkURL": artworkURL,
        ]
        let seedJSON = jsonString(seed)
        return #"""
        (() => {
          const seed = \#(seedJSON);
          const symbolData = \#(symbolsJSON);
          window.NepTunes = {
            settings: seed.settings,
            state: seed.state,
            on() {}, off() {}, _signalReady() {},
            setSize(width, height) {
              window.webkit.messageHandlers.resize.postMessage({width, height});
            },
            getArtworkDataURL() { return seed.artworkURL; },
            symbol(name, options) {
              const color = String((options && options.color) || '#fff').toLowerCase();
              const tone = color.includes('0, 0, 0') || color === '#000' || color === '#000000'
                ? 'black' : 'white';
              const size = Number(options && options.size) || 18;
              return Promise.resolve(symbolData[`${name}|${size}|${tone}`] || null);
            }
          };
        })();
        """#
    }
}

private enum HarnessError: Error, CustomStringConvertible {
    case timeout(String)
    case invalidPage(String)

    var description: String {
        switch self {
        case let .timeout(message): return "timeout: \(message)"
        case let .invalidPage(message): return "invalid page: \(message)"
        }
    }
}

@main
@MainActor
private struct Entry {
    static func main() throws {
        let args = CommandLine.arguments
        guard args.count == 4 else {
            fputs("usage: vinyl-render-check <immutable-baseline-bundle> <candidate-bundle> <evidence-dir>\n", stderr)
            exit(2)
        }
        let baseline = URL(fileURLWithPath: args[1], isDirectory: true)
        let candidate = URL(fileURLWithPath: args[2], isDirectory: true)
        let evidence = URL(fileURLWithPath: args[3], isDirectory: true)
        try FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true)
        let baselineLimits = try readWindowLimits(baseline)
        let candidateLimits = try readWindowLimits(candidate)

        let artworkURL = try deterministicArtworkURL()
        let symbols = try deterministicSymbols()
        let symbolsJSON = jsonString(symbols)
        let allCases = makeCases()
        let caseLimit = Int(ProcessInfo.processInfo.environment["VINYL_RENDER_LIMIT"] ?? "")
        let cases = caseLimit.map { Array(allCases.prefix(max(1, $0))) } ?? allCases
        var report = [
            "Vinyl gutter comparison",
            "baseline: \(baseline.path)",
            "candidate: \(candidate.path)",
            "viewport registration: baseline content shifted by \(registrationOffset)pt on each axis",
            "shadow/background ink threshold: \(inkThreshold) channel levels / 255",
            "RGBA per-channel tolerance: \(channelTolerance) / 255",
            "cases: \(cases.count) panel layouts / boundary pairs; all renders use a paused track and fixed cover"
        ]
        var failures: [String] = []
        var baselineShadowTail: (left: Double, right: Double, top: Double, bottom: Double)?
        var baselineMinimumViewport: [Double]?
        var candidateMinimumViewport: [Double]?
        var baselineDefaultViewport: [Double]?
        var candidateDefaultViewport: [Double]?

        for (index, renderCase) in cases.enumerated() {
            let baselineRender: Rendered
            let candidateRender: Rendered
            do {
                baselineRender = try render(
                    bundle: baseline, renderCase: renderCase,
                    padding: baselinePadding, artworkURL: artworkURL, symbols: symbols,
                    symbolsJSON: symbolsJSON, limits: baselineLimits
                )
                candidateRender = try render(
                    bundle: candidate, renderCase: renderCase,
                    padding: candidatePadding, artworkURL: artworkURL, symbols: symbols,
                    symbolsJSON: symbolsJSON, limits: candidateLimits
                )
            } catch {
                let message = "\(renderCase.name): \(error)"
                report.append("ERROR \(message)")
                failures.append(message)
                continue
            }

            if index == 0 {
                baselineMinimumViewport = baselineRender.viewport
                candidateMinimumViewport = candidateRender.viewport
                baselineShadowTail = measuredShadowTail(baselineRender)
            }
            if renderCase.name == "boundary-136-off-off-light" {
                baselineDefaultViewport = baselineRender.viewport
                candidateDefaultViewport = candidateRender.viewport
            }

            let geometryProblems = compareGeometry(
                baseline: baselineRender,
                candidate: candidateRender,
                renderCase: renderCase
            )
            let pixelResult = comparePixels(
                baseline: baselineRender,
                candidate: candidateRender,
                evidenceName: renderCase.name,
                evidenceDir: evidence
            )
            let discardedBaselineAlpha = measureDiscardedBaselineEdges(
                baseline: baselineRender,
                candidate: candidateRender
            )
            var problems = geometryProblems
            if pixelResult.significantDifferences > 0 {
                problems.append("\(pixelResult.significantDifferences) registered pixels differ above tolerance; max delta \(pixelResult.maxDelta)/255")
            }
            if discardedBaselineAlpha.count > 0 {
                problems.append("cropped baseline edge strips contain \(discardedBaselineAlpha.count) pixels above alpha threshold; max alpha \(discardedBaselineAlpha.maxAlpha)/255")
            }
            let status = problems.isEmpty ? "PASS" : "FAIL"
            report.append(
                "\(status) \(renderCase.name): \(pixelResult.significantDifferences) changed pixels, max \(pixelResult.maxDelta)/255; cropped-edge pixels above background threshold \(discardedBaselineAlpha.count), max contrast \(discardedBaselineAlpha.maxAlpha)/255"
            )
            failures.append(contentsOf: problems.map { "\(renderCase.name): \($0)" })
        }

        if let tail = baselineShadowTail {
            let measuredExtent = max(tail.left, tail.right, tail.top, tail.bottom)
            report.append(contentsOf: [
                "baseline shadow extent above \(inkThreshold)/255 background contrast: left \(String(format: "%.2f", tail.left))pt, right \(String(format: "%.2f", tail.right))pt, top \(String(format: "%.2f", tail.top))pt, bottom \(String(format: "%.2f", tail.bottom))pt",
                "candidate 40pt gutter leaves \(String(format: "%.2f", candidatePadding - measuredExtent))pt beyond the largest measured tail at this threshold",
                "cropped edge test compares each discarded baseline pixel to the actual transparent/background corner and requires zero contrast above threshold",
                "80pt minimum-disc viewport: baseline \(formatSize(baselineMinimumViewport)), candidate \(formatSize(candidateMinimumViewport))",
                "136pt default-disc viewport: baseline \(formatSize(baselineDefaultViewport)), candidate \(formatSize(candidateDefaultViewport))"
            ])
        }

        let scrollResult = runMinimumViewportChecks(
            baseline: baseline, candidate: candidate, artworkURL: artworkURL,
            symbolsJSON: symbolsJSON, baselineLimits: baselineLimits,
            candidateLimits: candidateLimits, evidence: evidence
        )
        report.append(contentsOf: scrollResult.lines)
        failures.append(contentsOf: scrollResult.failures)

        report.append("RESULT: \(failures.isEmpty ? "PASS" : "FAIL") (\(cases.count) render pairs; \(failures.count) assertion failures)")
        report.append(contentsOf: failures.map { "ASSERTION: \($0)" })
        let reportURL = evidence.appendingPathComponent("report.txt")
        try report.joined(separator: "\n").appending("\n").write(to: reportURL, atomically: true, encoding: .utf8)
        print(report.joined(separator: "\n"))
        print("Evidence: \(evidence.path)")
        if !failures.isEmpty { exit(1) }
    }

    private static func render(bundle: URL, renderCase: RenderCase, padding: Double,
                               artworkURL: String, symbols: [String: String],
                               symbolsJSON: String, limits: WindowLimits) throws -> Rendered {
        let renderer = Renderer(
            bundle: bundle,
            renderCase: renderCase,
            padding: padding,
            artworkURL: artworkURL,
            symbols: symbols,
            symbolMapJSON: symbolsJSON,
            minimumSize: limits.minimum,
            maximumSize: limits.maximum
        )
        try renderer.waitForPage()
        renderer.freezeMotionForFixture()
        let measurements = try renderer.measurements()
        let bitmap = try renderer.snapshot()
        let pointSize = bitmap.size
        let widthScale = Double(bitmap.pixelsWide) / pointSize.width
        let heightScale = Double(bitmap.pixelsHigh) / pointSize.height
        guard widthScale > 0, heightScale > 0 else {
            throw HarnessError.invalidPage("snapshot bitmap has invalid scale")
        }
        return Rendered(
            bitmap: bitmap,
            rectangles: measurements.rects,
            padding: measurements.padding,
            viewport: measurements.viewport,
            widthScale: widthScale,
            heightScale: heightScale
        )
    }

    private struct WindowLimits {
        let minimum: NSSize
        let maximum: NSSize
    }

    private static func readWindowLimits(_ bundle: URL) throws -> WindowLimits {
        let data = try Data(contentsOf: bundle.appendingPathComponent("manifest.json"))
        guard let manifest = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let minimum = manifest["minSize"] as? [String: Double],
              let maximum = manifest["maxSize"] as? [String: Double],
              let minWidth = minimum["width"], let minHeight = minimum["height"],
              let maxWidth = maximum["width"], let maxHeight = maximum["height"] else {
            throw HarnessError.invalidPage("manifest must declare minSize and maxSize for native setSize clamping")
        }
        return WindowLimits(minimum: NSSize(width: minWidth, height: minHeight),
                            maximum: NSSize(width: maxWidth, height: maxHeight))
    }

    private static func runMinimumViewportChecks(
        baseline: URL, candidate: URL, artworkURL: String, symbolsJSON: String,
        baselineLimits: WindowLimits, candidateLimits: WindowLimits, evidence: URL
    ) -> (lines: [String], failures: [String]) {
        var lines = ["minimum viewport root-scroll and host-resize checks"]
        var failures: [String] = []

        let baselineRepro = RenderCase(name: "baseline-scroll-repro-left-right-80", diameter: 80,
                                       label: "left", controls: "right", isDark: false)
        do {
            let old = Renderer(
                bundle: baseline, renderCase: baselineRepro, padding: baselinePadding,
                artworkURL: artworkURL, symbols: [:], symbolMapJSON: symbolsJSON,
                initialSize: baselineLimits.minimum, deferResizeRequests: true,
                minimumSize: baselineLimits.minimum, maximumSize: baselineLimits.maximum
            )
            try old.waitForPage()
            old.freezeMotionForFixture()
            let before = try probeScroll(renderer: old)
            if before.moved {
                lines.append("PASS old baseline reproduces root scroll movement before its queued native resize: \(before.summary)")
            } else {
                failures.append("old baseline did not reproduce root scrolling at a host-minimum viewport: \(before.summary)")
                lines.append("FAIL old baseline root-scroll reproduction: \(before.summary)")
            }
        } catch {
            failures.append("old baseline root-scroll reproduction errored: \(error)")
            lines.append("ERROR old baseline root-scroll reproduction: \(error)")
        }

        for label in positions {
            for controls in positions {
                let renderCase = RenderCase(name: "minimum-\(label)-\(controls)", diameter: 80,
                                            label: label, controls: controls, isDark: false)
                do {
                    let renderer = Renderer(
                        bundle: candidate, renderCase: renderCase, padding: candidatePadding,
                        artworkURL: artworkURL, symbols: [:], symbolMapJSON: symbolsJSON,
                        initialSize: candidateLimits.minimum, deferResizeRequests: true,
                        minimumSize: candidateLimits.minimum, maximumSize: candidateLimits.maximum
                    )
                    try renderer.waitForPage()
                    renderer.freezeMotionForFixture()
                    let scroll = try probeScroll(renderer: renderer)
                    if scroll.moved {
                        failures.append("\(renderCase.name): programmatic root scroll moved rendered content: \(scroll.summary)")
                    }

                    if label != "off" || controls != "off" {
                        let requestDeadline = Date().addingTimeInterval(2)
                        while renderer.requestedSizes.isEmpty && Date() < requestDeadline {
                            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
                        }
                    }
                    let finalSize: NSSize
                    if renderer.requestedSizes.isEmpty {
                        finalSize = candidateLimits.minimum
                    } else {
                        finalSize = try renderer.applyLatestResizeRequest()
                    }
                    let finalScroll = try probeScroll(renderer: renderer)
                    if finalScroll.moved {
                        failures.append("\(renderCase.name): root scroll moved content after host-clamped setSize: \(finalScroll.summary)")
                    }
                    let geometry = try renderer.measurements()
                    let geometryFailures = checkMinimumGeometry(geometry, allowEmptyPlay: false)
                    failures.append(contentsOf: geometryFailures.map { "\(renderCase.name): \($0)" })
                    let hostSize = [geometry.viewport[0], geometry.viewport[1]]
                    if abs(hostSize[0] - finalSize.width) > 0.5 || abs(hostSize[1] - finalSize.height) > 0.5 {
                        failures.append("\(renderCase.name): fake native host did not apply the bounded setSize request \(finalSize), actual \(hostSize)")
                    }
                    _ = renderer.evaluate("document.documentElement.classList.add('nt-hover'); true")
                    _ = try renderer.snapshot()
                    let grip = renderer.evaluate(#"""
                    (() => {
                      const svg=document.querySelector('.resize-grip'), handle=document.querySelector('#resizeHandle');
                      const p=svg.querySelector('path').getBoundingClientRect();
                      const x=p.x+p.width/2, y=p.y+p.height/2;
                      return JSON.stringify({opacity:+getComputedStyle(svg).opacity, hit:document.elementFromPoint(x,y)?.id||'', x,y});
                    })()
                    """#) as? String
                    if let grip, let data = grip.data(using: .utf8),
                       let info = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        if (info["opacity"] as? Double ?? 0) < 0.99 || (info["hit"] as? String) != "resizeHandle" {
                            failures.append("\(renderCase.name): visible resize grip is not hit-tested by its resize handle: \(grip)")
                        }
                    } else {
                        failures.append("\(renderCase.name): could not verify the visible resize-grip hit target")
                    }
                    let status = failures.contains(where: { $0.hasPrefix("\(renderCase.name):") }) ? "FAIL" : "PASS"
                    lines.append("\(status) \(renderCase.name) initial \(formatSize([candidateLimits.minimum.width, candidateLimits.minimum.height])), host-set \(formatSize([finalSize.width, finalSize.height])); pre/post scroll: \(scroll.summary) / \(finalScroll.summary)")
                } catch {
                    failures.append("\(renderCase.name): \(error)")
                    lines.append("ERROR \(renderCase.name): \(error)")
                }
            }
        }

        let emptyCase = RenderCase(name: "minimum-empty-stopped", diameter: 80,
                                   label: "off", controls: "off", isDark: false, hasTrack: false)
        do {
            let renderer = Renderer(
                bundle: candidate, renderCase: emptyCase, padding: candidatePadding,
                artworkURL: artworkURL, symbols: [:], symbolMapJSON: symbolsJSON,
                initialSize: candidateLimits.minimum, deferResizeRequests: true,
                minimumSize: candidateLimits.minimum, maximumSize: candidateLimits.maximum
            )
            try renderer.waitForPage()
            renderer.freezeMotionForFixture()
            let geometry = try renderer.measurements()
            let geometryFailures = checkMinimumGeometry(geometry, allowEmptyPlay: true)
            failures.append(contentsOf: geometryFailures.map { "\(emptyCase.name): \($0)" })
            let play = geometry.rects["emptyOpen"]
            if play == nil { failures.append("\(emptyCase.name): center play target is absent") }
            let playHit = renderer.evaluate(#"""
            (() => { const e=document.querySelector('.empty-open'); if(!e)return ''; const r=e.getBoundingClientRect(); return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.id||''; })()
            """#) as? String
            if playHit != "emptyOpen" { failures.append("\(emptyCase.name): center play is not the hit-tested element (\(playHit ?? "nil"))") }
            let scroll = try probeScroll(renderer: renderer)
            if scroll.moved { failures.append("\(emptyCase.name): programmatic scroll moved content: \(scroll.summary)") }
            lines.append("\(failures.contains(where: { $0.hasPrefix("\(emptyCase.name):") }) ? "FAIL" : "PASS") \(emptyCase.name): center play \(play.map(String.init(describing:)) ?? "missing"); \(scroll.summary)")
        } catch {
            failures.append("\(emptyCase.name): \(error)")
            lines.append("ERROR \(emptyCase.name): \(error)")
        }
        return (lines, failures)
    }

    private static func probeScroll(renderer: Renderer) throws -> (moved: Bool, summary: String) {
        _ = renderer.evaluate("window.scrollTo(0,0); true")
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        let reset = try renderer.measurements()
        _ = renderer.evaluate("window.scrollTo(32,32); window.scrollBy(16,16); true")
        RunLoop.current.run(until: Date().addingTimeInterval(0.10))
        let after = try renderer.measurements()
        func delta(_ key: String, _ component: KeyPath<Rect, Double>) -> Double {
            guard let old = reset.rects[key], let new = after.rects[key] else { return 0 }
            return abs(new[keyPath: component] - old[keyPath: component])
        }
        let rectMoved = delta("handle", \.x) > 0.5 || delta("handle", \.y) > 0.5 ||
            delta("disc", \.x) > 0.5 || delta("disc", \.y) > 0.5
        let details = renderer.evaluate(#"""
        JSON.stringify({x:window.scrollX,y:window.scrollY,top:document.scrollingElement.scrollTop,
          left:document.scrollingElement.scrollLeft,width:document.documentElement.scrollWidth,
          height:document.documentElement.scrollHeight})
        """#) as? String ?? "{}"
        let offsetsMoved: Bool
        if let data = details.data(using: .utf8),
           let values = try JSONSerialization.jsonObject(with: data) as? [String: Double] {
            offsetsMoved = ["x", "y", "top", "left"].contains { abs(values[$0] ?? 0) > 0.5 }
        } else {
            offsetsMoved = true
        }
        return (rectMoved || offsetsMoved,
                "scroll/extent=\(details), element rect movement=\(rectMoved)")
    }

    private static func checkMinimumGeometry(
        _ geometry: (rects: [String: Rect], padding: [Double], viewport: [Double]), allowEmptyPlay: Bool
    ) -> [String] {
        var failures: [String] = []
        for name in ["disc", "row", "label", "controls", "bottom", "title", "artist", "grip", "handle"] {
            guard let rect = geometry.rects[name] else { continue }
            if rect.x < -0.5 || rect.y < -0.5 || rect.right > geometry.viewport[0] + 0.5 || rect.bottom > geometry.viewport[1] + 0.5 {
                failures.append("\(name) bounds escape the actual viewport: \(rect) in \(geometry.viewport)")
            }
        }
        if geometry.rects["disc"] == nil { failures.append("disc is missing") }
        if allowEmptyPlay && geometry.rects["emptyOpen"] == nil { failures.append("stopped center play control is missing") }
        return failures
    }

    private static func makeCases() -> [RenderCase] {
        var cases: [RenderCase] = []
        for label in positions {
            for controls in positions {
                let caseIndex = cases.count
                let diameter: Double = [80, 136, 320][caseIndex % 3]
                cases.append(RenderCase(
                    name: "layout-\(label)-\(controls)-\(Int(diameter))-\(caseIndex % 2 == 0 ? "light" : "dark")",
                    diameter: diameter,
                    label: label,
                    controls: controls,
                    isDark: caseIndex % 2 != 0
                ))
            }
        }
        // Pin both advertised geometry boundaries in both appearances, in addition to the
        // complete 4×4 placement matrix above. off/off is deliberately reused for 80/light.
        cases.append(RenderCase(name: "boundary-80-off-off-dark", diameter: 80,
                                label: "off", controls: "off", isDark: true))
        cases.append(RenderCase(name: "boundary-136-off-off-light", diameter: 136,
                                label: "off", controls: "off", isDark: false))
        cases.append(RenderCase(name: "boundary-136-off-off-dark", diameter: 136,
                                label: "off", controls: "off", isDark: true))
        return cases
    }

    private static func compareGeometry(baseline: Rendered, candidate: Rendered,
                                        renderCase: RenderCase) -> [String] {
        var problems: [String] = []
        guard baseline.padding.count == 4, candidate.padding.count == 4,
              baseline.viewport.count == 2, candidate.viewport.count == 2 else {
            return ["malformed viewport or padding measurements"]
        }
        if baseline.padding.contains(where: { abs($0 - baselinePadding) > 0.5 }) {
            problems.append("baseline does not render with the expected 48pt outer padding: \(baseline.padding)")
        }
        if candidate.padding.contains(where: { abs($0 - candidatePadding) > 0.5 }) {
            problems.append("candidate does not render with uniform 40pt outer padding: \(candidate.padding)")
        }
        if baseline.viewport.count == 2 && candidate.viewport.count == 2 {
            for axis in 0..<2 {
                if abs((baseline.viewport[axis] - candidate.viewport[axis]) - registrationOffset * 2) > 0.5 {
                    problems.append("viewport axis \(axis) is not reduced by exactly 16pt: baseline \(baseline.viewport[axis]), candidate \(candidate.viewport[axis])")
                }
            }
        }
        guard let baseDisc = baseline.rectangles["disc"],
              let nextDisc = candidate.rectangles["disc"] else {
            return problems + ["album-record bounds are missing"]
        }
        if abs(baseDisc.width - renderCase.diameter) > 0.5 || abs(baseDisc.height - renderCase.diameter) > 0.5 {
            problems.append("baseline disc is not \(renderCase.diameter)pt: \(baseDisc)")
        }
        if abs(nextDisc.width - renderCase.diameter) > 0.5 || abs(nextDisc.height - renderCase.diameter) > 0.5 {
            problems.append("candidate disc is not \(renderCase.diameter)pt: \(nextDisc)")
        }

        // All content except the explicitly permitted resize affordance must be unchanged
        // after registering the inner content by the 8pt padding delta.
        for name in ["disc", "row", "label", "controls", "bottom", "title", "artist"] {
            let oldRect = baseline.rectangles[name]
            let newRect = candidate.rectangles[name]
            guard oldRect != nil || newRect != nil else { continue }
            guard let oldRect, let newRect else {
                problems.append("\(name) presence changed: baseline \(oldRect as Any), candidate \(newRect as Any)")
                continue
            }
            if abs(oldRect.x - newRect.x - registrationOffset) > 0.5 ||
                abs(oldRect.y - newRect.y - registrationOffset) > 0.5 ||
                abs(oldRect.width - newRect.width) > 0.5 ||
                abs(oldRect.height - newRect.height) > 0.5 {
                problems.append("\(name) changed beyond the known 8pt translation: baseline \(oldRect), candidate \(newRect)")
            }
        }

        for name in ["grip", "handle"] {
            guard let grip = candidate.rectangles[name] else {
                problems.append("candidate resize \(name) is missing")
                continue
            }
            if grip.x < -0.5 || grip.y < -0.5 || grip.right > candidate.viewport[0] + 0.5 || grip.bottom > candidate.viewport[1] + 0.5 {
                problems.append("candidate resize \(name) falls outside the viewport: \(grip)")
            }
            if let content = candidate.rectangles["controls"], grip.intersects(content) {
                problems.append("candidate resize \(name) overlaps transport controls")
            }
            if let content = candidate.rectangles["label"], grip.intersects(content) {
                problems.append("candidate resize \(name) overlaps track labels")
            }
        }
        return problems
    }

    private static func comparePixels(baseline: Rendered, candidate: Rendered,
                                      evidenceName: String, evidenceDir: URL) -> (significantDifferences: Int, maxDelta: Int) {
        savePNG(baseline.bitmap, to: evidenceDir.appendingPathComponent("\(evidenceName)-baseline.png"))
        savePNG(candidate.bitmap, to: evidenceDir.appendingPathComponent("\(evidenceName)-candidate.png"))
        let base = pixelBuffer(baseline.bitmap)
        let next = pixelBuffer(candidate.bitmap)
        let shiftX = Int((registrationOffset * candidate.widthScale).rounded())
        let shiftY = Int((registrationOffset * candidate.heightScale).rounded())
        let gripRects = [
            candidate.rectangles["grip"], candidate.rectangles["handle"],
            baseline.rectangles["grip"]?.translated(x: -registrationOffset, y: -registrationOffset),
            baseline.rectangles["handle"]?.translated(x: -registrationOffset, y: -registrationOffset),
        ].compactMap { $0 }
        var differences = 0
        var maximum = 0
        for y in 0..<candidate.bitmap.pixelsHigh {
            let oldY = y + shiftY
            guard oldY >= 0 && oldY < baseline.bitmap.pixelsHigh else { continue }
            for x in 0..<candidate.bitmap.pixelsWide {
                let oldX = x + shiftX
                guard oldX >= 0 && oldX < baseline.bitmap.pixelsWide else { continue }
                let point = CGPoint(x: (Double(x) + 0.5) / candidate.widthScale,
                                    y: (Double(y) + 0.5) / candidate.heightScale)
                if gripRects.contains(where: { point.x >= $0.x && point.x < $0.right && point.y >= $0.y && point.y < $0.bottom }) {
                    continue
                }
                let old = base[oldY * baseline.bitmap.pixelsWide + oldX].channels
                let new = next[y * candidate.bitmap.pixelsWide + x].channels
                let delta = zip(old, new).map { abs($0 - $1) }.max() ?? 0
                maximum = max(maximum, delta)
                if delta > channelTolerance { differences += 1 }
            }
        }
        return (differences, maximum)
    }

    private static func measureDiscardedBaselineEdges(baseline: Rendered,
                                                      candidate: Rendered) -> (count: Int, maxAlpha: Int) {
        let pixels = pixelBuffer(baseline.bitmap)
        let background = pixels[0]
        let shiftX = Int((registrationOffset * candidate.widthScale).rounded())
        let shiftY = Int((registrationOffset * candidate.heightScale).rounded())
        let retainedLeft = shiftX
        let retainedTop = shiftY
        let retainedRight = shiftX + candidate.bitmap.pixelsWide
        let retainedBottom = shiftY + candidate.bitmap.pixelsHigh
        var count = 0
        var maxAlpha = 0
        for y in 0..<baseline.bitmap.pixelsHigh {
            for x in 0..<baseline.bitmap.pixelsWide {
                let cropped = x < retainedLeft || x >= retainedRight || y < retainedTop || y >= retainedBottom
                guard cropped else { continue }
                let pixel = pixels[y * baseline.bitmap.pixelsWide + x]
                let contrast = backgroundContrast(pixel, background)
                if contrast > inkThreshold {
                    count += 1
                    maxAlpha = max(maxAlpha, contrast)
                }
            }
        }
        return (count, maxAlpha)
    }

    private static func measuredShadowTail(_ rendered: Rendered) -> (left: Double, right: Double, top: Double, bottom: Double) {
        guard let disc = rendered.rectangles["disc"] else { return (0, 0, 0, 0) }
        let pixels = pixelBuffer(rendered.bitmap)
        let background = pixels[0]
        let scale = rendered.widthScale
        let leftEdge = Int(floor(disc.x * scale))
        let rightEdge = Int(ceil(disc.right * scale)) - 1
        let topEdge = Int(floor(disc.y * rendered.heightScale))
        let bottomEdge = Int(ceil(disc.bottom * rendered.heightScale)) - 1
        var minX = Int.max, maxX = -1, minY = Int.max, maxY = -1
        for y in 0..<rendered.bitmap.pixelsHigh {
            for x in 0..<rendered.bitmap.pixelsWide {
                let outsideDiscBox = x < leftEdge || x > rightEdge || y < topEdge || y > bottomEdge
                guard outsideDiscBox else { continue }
                let contrast = backgroundContrast(pixels[y * rendered.bitmap.pixelsWide + x], background)
                guard contrast > inkThreshold else { continue }
                minX = min(minX, x); maxX = max(maxX, x)
                minY = min(minY, y); maxY = max(maxY, y)
            }
        }
        guard maxX >= 0 else { return (0, 0, 0, 0) }
        let left = max(0, Double(leftEdge - minX) / scale)
        let right = max(0, Double(maxX - rightEdge) / scale)
        let top = max(0, Double(topEdge - minY) / rendered.heightScale)
        let bottom = max(0, Double(maxY - bottomEdge) / rendered.heightScale)
        return (left, right, top, bottom)
    }

    private static func pixelBuffer(_ bitmap: NSBitmapImageRep) -> [Pixel] {
        var pixels: [Pixel] = []
        pixels.reserveCapacity(bitmap.pixelsWide * bitmap.pixelsHigh)
        for yTop in 0..<bitmap.pixelsHigh {
            for x in 0..<bitmap.pixelsWide {
                guard let color = bitmap.colorAt(x: x, y: bitmap.pixelsHigh - 1 - yTop),
                      let rgb = color.usingColorSpace(.deviceRGB) else {
                    pixels.append(Pixel(r: 0, g: 0, b: 0, a: 0))
                    continue
                }
                let alpha = UInt8(max(0, min(255, Int((rgb.alphaComponent * 255).rounded()))))
                func premultiplied(_ component: CGFloat) -> UInt8 {
                    UInt8(max(0, min(255, Int((component * rgb.alphaComponent * 255).rounded()))))
                }
                pixels.append(Pixel(r: premultiplied(rgb.redComponent),
                                    g: premultiplied(rgb.greenComponent),
                                    b: premultiplied(rgb.blueComponent), a: alpha))
            }
        }
        return pixels
    }

    private static func formatSize(_ size: [Double]?) -> String {
        guard let size, size.count == 2 else { return "unavailable" }
        return size.map { String(format: "%.1f", $0) }.joined(separator: "x") + "pt"
    }

    private static func backgroundContrast(_ pixel: Pixel, _ background: Pixel) -> Int {
        max(abs(Int(pixel.r) - Int(background.r)),
            abs(Int(pixel.g) - Int(background.g)),
            abs(Int(pixel.b) - Int(background.b)),
            abs(Int(pixel.a) - Int(background.a)))
    }

    private static func deterministicArtworkURL() throws -> String {
        let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: 96, pixelsHigh: 96,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
            isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        )!
        bitmap.size = NSSize(width: 96, height: 96)
        let colors: [(CGFloat, CGFloat, CGFloat)] = [
            (0.86, 0.17, 0.22), (0.97, 0.62, 0.16),
            (0.15, 0.51, 0.68), (0.31, 0.67, 0.39),
        ]
        for y in 0..<96 {
            for x in 0..<96 {
                let quadrant = (x < 48 ? 0 : 1) + (y < 48 ? 0 : 2)
                let color = colors[quadrant]
                bitmap.setColor(NSColor(calibratedRed: color.0, green: color.1, blue: color.2, alpha: 1), atX: x, y: y)
            }
        }
        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            throw HarnessError.invalidPage("could not generate deterministic cover art")
        }
        return "data:image/png;base64," + png.base64EncodedString()
    }

    private static func deterministicSymbols() throws -> [String: String] {
        let rasterizer = SFSymbolRasterizer()
        let names = ["play.fill", "pause.fill", "stop.fill", "backward.end.fill", "forward.end.fill"]
        var urls: [String: String] = [:]
        for name in names {
            for size: CGFloat in [18, 24] {
                for (tone, color) in [("white", "#fff"), ("black", "#000")] {
                    guard let png = rasterizer.pngData(
                        name: name, pointSize: size, weight: "regular",
                        hexColor: color, deviceScale: 1
                    ) else { continue }
                    urls["\(name)|\(Int(size))|\(tone)"] = "data:image/png;base64," + png.base64EncodedString()
                }
            }
        }
        return urls
    }

    private static func savePNG(_ bitmap: NSBitmapImageRep, to url: URL) {
        guard let data = bitmap.representation(using: .png, properties: [:]) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
