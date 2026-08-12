#!/bin/bash
# Checks that every sample widget really mirrors for a right-to-left host, and that the copy
# of neptunes-kit.js it actually loaded formats numbers against the host locale.
#
#   ./run.sh                 # check the bundles in this checkout
#   ./run.sh /path/to/other  # check some other SampleWidgets directory
#
# The Swift gates for this are source checks (grep script.js for `documentElement.dir`,
# byte-compare the vendored kits). Those stay green for a widget that never applies the
# direction at runtime — this is the check that doesn't.
#
# Exit status is 0 only when every bundle passes.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
widgets="${1:-$(cd "$here/../.." && pwd)}"
bridge="$(cd "$here/../../.." && pwd)/NepTunes Widget/WidgetJSBridge.swift"
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT

# Run the JS the app really injects, pulled straight from the Swift source, so this can
# never drift from what ships. Shared with theme-check — one extractor, one source of
# truth. The published mirror has no app source, so it carries a committed snapshot of the
# same extraction instead.
if [ -f "$bridge" ]; then
  python3 "$here/../theme-check/extract-api.py" "$bridge" "$build/api.js"
elif [ -f "$here/../api.js" ]; then
  cp "$here/../api.js" "$build/api.js"
else
  echo "no WidgetJSBridge.swift at '$bridge' and no _dev/api.js snapshot — cannot run" >&2
  exit 1
fi
swiftc -O -o "$build/rtlcheck" "$here/rtlcheck.swift"
"$build/rtlcheck" "$widgets" "$build/api.js"
