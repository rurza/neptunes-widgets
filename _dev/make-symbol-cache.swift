// Renders the SF Symbols the sample widgets ask for into _dev/sfsymbols-cache.json,
// so the browser harness shows the REAL glyphs instead of hand-drawn approximations.
//
//   swift SampleWidgets/_dev/make-symbol-cache.swift
//
// Only the harness uses the output. The shipped bundles never read it — inside the app,
// window.NepTunes.symbol() rasterises through AppKit natively. This exists because the
// mock bridge cannot, and approximated glyphs made V3's control rows read as wrong when
// the widget itself was fine.
//
// Each symbol is rendered once, WHITE, at a single large size; mock-neptunes.js scales
// and tints it with a `source-atop` canvas fill, which is the same compositing the
// native renderSFSymbol does.

import AppKit
import Foundation

let symbols = [
    "arrow.2.squarepath",
    "arrow.up.right.square",
    "backward.end.fill",
    "forward.end.fill",
    "hand.thumbsdown",
    "hand.thumbsdown.fill",
    "heart",
    "heart.fill",
    "music.note",
    "pause.fill",
    "play.fill",
    "repeat",
    "repeat.1",
    "shuffle",
    "speaker",
    "speaker.slash",
    "speaker.slash.fill",
    "speaker.wave.1",
    "speaker.wave.2",
    "speaker.wave.2.fill",
    "speaker.wave.3",
    "star",
    "star.fill",
    "stop.fill",
    "xmark",
]

/// Rendered big enough that every widget's largest use downsamples rather than upsamples.
let pointSize: CGFloat = 256

func render(_ name: String) -> String? {
    let config = NSImage.SymbolConfiguration(pointSize: pointSize, weight: .regular)
    guard let base = NSImage(systemSymbolName: name, accessibilityDescription: nil),
          let image = base.withSymbolConfiguration(config) else { return nil }

    let natural = image.size
    guard natural.width > 0, natural.height > 0 else { return nil }

    // SQUARE canvas with the glyph aspect-fit inside, mirroring renderSFSymbol in
    // WidgetJSBridge.swift. Most SF Symbols are not square (speaker.wave.2.fill is ~1.4:1),
    // and widgets size img.sf-icon as a square box — a natural-size PNG would be stretched
    // by that CSS. V3's .nocover is the obvious victim: width/height both 60%.
    //
    // Not reproduced here: the native renderer also applies an optical-centering offset
    // (minimum-enclosing-circle rather than bounding box) so asymmetric glyphs like a play
    // triangle sit right in a circular button. Bounding-box centring is close enough for
    // the harness; expect a sub-pixel difference on play.fill.
    let side = Int(pointSize.rounded())
    let fit = min(pointSize / natural.width, pointSize / natural.height)
    let drawSize = NSSize(width: natural.width * fit, height: natural.height * fit)
    let origin = CGPoint(x: (pointSize - drawSize.width) / 2, y: (pointSize - drawSize.height) / 2)

    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: side,
        pixelsHigh: side,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else { return nil }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    image.draw(in: NSRect(origin: origin, size: drawSize))
    // Flatten to pure white, preserving the glyph's alpha — the template the harness tints.
    NSColor.white.set()
    NSRect(x: 0, y: 0, width: CGFloat(side), height: CGFloat(side)).fill(using: .sourceAtop)
    NSGraphicsContext.restoreGraphicsState()

    guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
    return "data:image/png;base64," + png.base64EncodedString()
}

var out: [String: String] = [:]
var missing: [String] = []
for name in symbols {
    if let url = render(name) { out[name] = url } else { missing.append(name) }
}

let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let dest = here.appendingPathComponent("sfsymbols-cache.json")
let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys, .prettyPrinted])
try data.write(to: dest)

print("wrote \(dest.path) — \(out.count) symbols")
if !missing.isEmpty { print("MISSING (not available on this macOS): \(missing.joined(separator: ", "))") }
