#!/bin/bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
baseline="${1:-/private/var/folders/2d/x2yp50bd6c13tk8456c7s8x40000gn/T/opencode/vinyl-shadow-baseline-534892d0/SampleWidgets/Vinyl.nepget}"
candidate="${2:-$root/SampleWidgets/Vinyl.nepget}"
build="$(mktemp -d)"
evidence="$(mktemp -d "/private/var/folders/2d/x2yp50bd6c13tk8456c7s8x40000gn/T/opencode/vinyl-render-evidence.XXXXXX")"
trap 'rm -rf "$build"' EXIT
swiftc -parse-as-library -O -o "$build/vinyl-render-check" \
  "$here/main.swift" \
  "$root/NepTunesKit/Sources/NepTunesKit/SFSymbolRasterizer.swift"
set +e
"$build/vinyl-render-check" "$baseline" "$candidate" "$evidence"
status=$?
set -e
echo "Evidence retained at: $evidence"
exit "$status"
