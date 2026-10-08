#!/bin/bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
build="$(mktemp -d)"
evidence="$(mktemp -d "/private/var/folders/2d/x2yp50bd6c13tk8456c7s8x40000gn/T/opencode/vinyl-render-evidence.XXXXXX")"
trap 'rm -rf "$build"' EXIT
swiftc -parse-as-library -O -o "$build/vinyl-render-check" "$here/main.swift"
set +e
"$build/vinyl-render-check" "$root/SampleWidgets/Vinyl.nepget" "$evidence"
status=$?
set -e
echo "Evidence retained at: $evidence"
exit "$status"
