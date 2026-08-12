#!/bin/bash
# Checks that every SF Symbol a sample widget draws is painted 1:1 — CSS box == data-size — so
# WebKit never resamples the natively rasterised PNG and the glyph stays sharp.
#
#   ./run.sh                 # check the bundles in this checkout
#   ./run.sh /path/to/other  # check some other SampleWidgets directory
#
# Exit status is 0 only when every case in spec.json passes.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
widgets="${1:-$(cd "$here/../.." && pwd)}"
bridge="$(cd "$here/../../.." && pwd)/NepTunes Widget/WidgetJSBridge.swift"
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT

# Run the JS the app really injects, pulled straight from the Swift source, so this can
# never drift from what ships. Shared with theme-check and shadow-check. The published mirror
# has no app source, so it carries a committed snapshot of the same extraction instead.
if [ -f "$bridge" ]; then
  python3 "$here/../theme-check/extract-api.py" "$bridge" "$build/api.js"
elif [ -f "$here/../api.js" ]; then
  cp "$here/../api.js" "$build/api.js"
else
  echo "no WidgetJSBridge.swift at '$bridge' and no _dev/api.js snapshot — cannot run" >&2
  exit 1
fi
swiftc -O -o "$build/iconcheck" "$here/iconcheck.swift"
"$build/iconcheck" "$widgets" "$build/api.js" "$here/spec.json"
