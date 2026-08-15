#!/bin/bash
# Renders preview.jpg for a bundle from the bundle itself — the real HTML/CSS/JS in a WKWebView,
# real SF Symbols, real drop shadow — instead of drawing an impression of it.
#
#   ./run.sh                 # every widget listed in spec.json
#   ./run.sh Glass           # just this one
#   ./run.sh /path/to/other SampleWidgets-dir-first-if-you-pass-one
#
# Writes <Bundle>.nepget/preview.jpg in place. Re-sign and re-package the bundle afterwards:
#   node Scripts/widget-tools.mjs embed-sign SampleWidgets/Glass.nepget --key Scripts/.keys/first-party-author.pem
#   node Scripts/package-widgets.mjs Glass
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
widgets="$(cd "$here/../.." && pwd)"
if [ "${1:-}" = "--widgets" ]; then widgets="$2"; shift 2; fi
bridge="$(cd "$here/../../.." && pwd)/NepTunes Widget/WidgetJSBridge.swift"
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT

# The JS the app really injects, pulled straight from the Swift source so this cannot drift from
# what ships. Shared with the checks next door. The published mirror has no app source, so it
# carries a committed snapshot of the same extraction instead.
if [ -f "$bridge" ]; then
  python3 "$here/../theme-check/extract-api.py" "$bridge" "$build/api.js"
elif [ -f "$here/../api.js" ]; then
  cp "$here/../api.js" "$build/api.js"
else
  echo "no WidgetJSBridge.swift at '$bridge' and no _dev/api.js snapshot — cannot run" >&2
  exit 1
fi
swiftc -O -o "$build/previewshot" "$here/previewshot.swift"
"$build/previewshot" "$widgets" "$build/api.js" "$here/spec.json" "$@"
