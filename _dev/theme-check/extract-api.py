#!/usr/bin/env python3
"""Extract the `javascriptAPI` Swift multiline string literal verbatim, so the E2E check
runs the exact JS that ships rather than a hand-copied version that can drift."""
import re, sys

src = open(sys.argv[1], encoding='utf-8').read()
lines = src.split('\n')

start = next(i for i, l in enumerate(lines) if 'var javascriptAPI: String {' in l)
open_i = next(i for i in range(start, len(lines)) if lines[i].strip() == '"""')
close_i = next(i for i in range(open_i + 1, len(lines)) if lines[i].strip() == '"""')

# Swift strips the closing delimiter's indentation from every line of the literal.
indent = len(lines[close_i]) - len(lines[close_i].lstrip())
body = []
for l in lines[open_i + 1:close_i]:
    body.append(l[indent:] if l[:indent].strip() == '' else l.lstrip())

js = '\n'.join(body)
assert '\\(' not in js, "Swift interpolation present — extraction would be wrong"
assert 'window.NepTunes' in js and 'themechange' in js, "extraction looks wrong"
open(sys.argv[2], 'w', encoding='utf-8').write(js)
print(f"extracted {len(js)} chars, lines {open_i+2}..{close_i} -> {sys.argv[2]}")
