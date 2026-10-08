#!/bin/bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
build="$(mktemp -d)"
evidence="$(mktemp -d "/private/var/folders/2d/x2yp50bd6c13tk8456c7s8x40000gn/T/opencode/vinyl-empty-center.XXXXXX")"
trap 'rm -rf "$build"' EXIT
python3 "$root/SampleWidgets/_dev/theme-check/extract-api.py" \
  "$root/NepTunes Widget/WidgetJSBridge.swift" "$build/api.js"
swiftc -parse-as-library -O -o "$build/check" "$here/main.swift" \
  "$root/NepTunesKit/Sources/NepTunesKit/SFSymbolRasterizer.swift"
set +e
"$build/check" "$root/SampleWidgets/Vinyl.nepget" "$build/api.js" "$evidence"
status=$?
set -e
echo "Evidence retained at: $evidence"
exit "$status"
