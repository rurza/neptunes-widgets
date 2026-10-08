import AppKit
import WebKit

@MainActor
final class Runner: NSObject, WKNavigationDelegate {
    let view: WKWebView
    let window: NSWindow
    var loaded = false
    override init() {
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: #"""
        window.NepTunes = {
          settings:null, state:null,
          handlers:{}, on(n,f){this.handlers[n]=f}, setSize(){}, getArtworkDataURL(){return null},
          _signalReady(){}, activatePlayer(){}, playPause(){}, previous(){}, next(){},
          _resolveSymbol(id,ok,url){},
          emitSettings(s){this.settings=s;this.handlers.settingschange(s)}
        };
        window.SFSymbols={load(){},reload(){}};
        """#, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = controller
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: 260, height: 260), configuration: config)
        window = NSWindow(contentRect: NSRect(x: 20, y: 20, width: 260, height: 260),
                          styleMask: [.borderless], backing: .buffered, defer: false)
        super.init()
        window.contentView = view
        window.orderFrontRegardless()
        view.navigationDelegate = self
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
    func wait(_ seconds: Double = 0.15) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }
    func js(_ script: String) -> Any? {
        var result: Any?
        var done = false
        view.evaluateJavaScript(script) { value, _ in result = value; done = true }
        while !done { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        return result
    }
}

@main
@MainActor
struct Entry {
static func main() {
let args = CommandLine.arguments
guard args.count == 3 else { fputs("usage: vinyl-render-check <bundle> <evidence-dir>\n", stderr); exit(2) }
let bundle = URL(fileURLWithPath: args[1])
let evidence = URL(fileURLWithPath: args[2])
try! FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let runner = Runner()
runner.view.loadFileURL(bundle.appendingPathComponent("index.html"), allowingReadAccessTo: bundle)
while !runner.loaded { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
runner.wait(0.5)

let positions = ["off", "left", "right", "bottom"]
var failures: [String] = []
var lines = ["WKWebView Vinyl layout audit", "diameters: 80, 136, custom 217, 320; all 16 panel placements; aqua + darkAqua"]
for appearance in [NSAppearance.Name.aqua, .darkAqua] {
 for diameter in [80, 136, 217, 320] {
    for label in positions {
        for controls in positions {
            let extW = max(label == "left" ? 160 : 0, controls == "left" ? 84 : 0) + (label == "left" || controls == "left" ? 12 : 0)
                + max(label == "right" ? 160 : 0, controls == "right" ? 84 : 0) + (label == "right" || controls == "right" ? 12 : 0)
            let bottom = (label == "bottom" || controls == "bottom") ? 52 : 0
            let bottomWidth = (label == "bottom" ? 160 : 0) + (controls == "bottom" ? 84 : 0)
                + (label == "bottom" && controls == "bottom" ? 6 : 0)
            let width = max(diameter, bottomWidth) + 96 + extW
            let height = diameter + 96 + bottom
            runner.window.appearance = NSAppearance(named: appearance)
            _ = runner.js("window.NepTunes.emitSettings({labelPosition:'\(label)',controlsPosition:'\(controls)'})")
            runner.window.setContentSize(NSSize(width: width, height: height))
            runner.wait(0.04)
            _ = runner.js("""
              if (document.querySelector('.title')) document.querySelector('.title').textContent='A representative long track title';
              if (document.querySelector('.artist')) document.querySelector('.artist').textContent='Artist name';
            """)
            let result = runner.js("""
            (() => {
              const d=document.querySelector('.vinyl-shadow').getBoundingClientRect();
              const c=document.querySelector('.controls');
              const l=document.querySelector('.track-info');
              return {disc:[d.width,d.height], controls:c?c.getBoundingClientRect().toJSON():null,
                label:l?l.getBoundingClientRect().toJSON():null,
                handle:document.querySelector('.resize-handle').getBoundingClientRect().toJSON(),
                viewport:[document.documentElement.clientWidth,document.documentElement.clientHeight]};
            })()
            """) as? [String: Any] ?? [:]
            let disc = result["disc"] as? [Double] ?? []
            if disc.count != 2 || abs(disc[0] - Double(diameter)) > 0.5 || abs(disc[1] - Double(diameter)) > 0.5 {
                failures.append("disc mismatch \(diameter) \(label)/\(controls): \(disc)")
            }
            if let controlsRect = result["controls"] as? [String: Any],
               let w = controlsRect["width"] as? Double, let h = controlsRect["height"] as? Double,
               (w < 83 || h < 23) {
                failures.append("controls clipped \(diameter) \(label)/\(controls): \(w)x\(h)")
            }
            if label == "bottom", controls == "bottom",
               let labelRect = result["label"] as? [String: Any],
               let controlsRect = result["controls"] as? [String: Any],
               let labelRight = labelRect["right"] as? Double,
               let controlsLeft = controlsRect["left"] as? Double,
               controlsLeft - labelRight < 5.5 {
                failures.append("bottom row collision \(diameter): gap \(controlsLeft - labelRight)")
            }
            if let labelRect = result["label"] as? [String: Any], let w = labelRect["width"] as? Double,
               w < 150 { failures.append("label clipped \(diameter) \(label)/\(controls): \(w)") }
            let viewport = result["viewport"] as? [Double] ?? []
            if let handle = result["handle"] as? [String: Any],
               let x = handle["x"] as? Double, let y = handle["y"] as? Double,
               let w = handle["width"] as? Double, let h = handle["height"] as? Double,
               !viewport.isEmpty,
               (x < 0 || y < 0 || x + w > viewport[0] || y + h > viewport[1] || w < 18 || h < 18) {
                failures.append("resize handle not reachable \(diameter) \(label)/\(controls): \(x),\(y) \(w)x\(h) in \(viewport)")
            }
            for (kind, rect) in [("label", result["label"]), ("controls", result["controls"])] {
                if let rect = rect as? [String: Any], let x = rect["x"] as? Double,
                   let right = rect["right"] as? Double, !viewport.isEmpty,
                   (x < -0.5 || right > viewport[0] + 0.5) {
                    failures.append("\(kind) horizontally outside viewport \(diameter) \(label)/\(controls): \(x)…\(right) / \(viewport[0])")
                }
            }
            lines.append("\(diameter) \(label)/\(controls): \(String(describing: result))")
            if (diameter == 80 && label == "left" && controls == "left") ||
               (diameter == 80 && label == "bottom" && controls == "bottom") ||
               (diameter == 217 && label == "off" && controls == "off") ||
               (diameter == 136 && label == "bottom" && controls == "right") ||
               (diameter == 320 && label == "right" && controls == "left") {
                let image = runner.view.bitmapImageRepForCachingDisplay(in: runner.view.bounds)!
                runner.view.cacheDisplay(in: runner.view.bounds, to: image)
                let sizeName = diameter == 217 ? "custom217" : String(diameter)
                let filename = "vinyl-\(appearance.rawValue)-\(sizeName)-\(label)-\(controls).png"
                try! image.representation(using: .png, properties: [:])!.write(to: evidence.appendingPathComponent(filename))
            }
        }
    }
 }
}
let report = lines.joined(separator: "\n") + "\nFAILURES: \(failures.count)\n" + failures.joined(separator: "\n")
try! report.write(to: evidence.appendingPathComponent("report.txt"), atomically: true, encoding: .utf8)
print("WKWebView audited 128 renders; failures: \(failures.count)")
if !failures.isEmpty { exit(1) }
}

}
