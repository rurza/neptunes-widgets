#!/usr/bin/env python3
"""Extract the JS that `WidgetJSBridge.javascriptAPI` evaluates to, so the E2E checks run the
exact JS that ships rather than a hand-copied version that can drift.

    extract-api.py path/to/WidgetJSBridge.swift out/api.js

The literal splices in other Swift string literals, e.g. `\\(WidgetHistoryBridge.javascriptNamespace)`.
Each `\\(TypeName.member)` is resolved to the `static let member = \"\"\"` (or raw `#\"\"\"`)
literal declared by `TypeName` under NepTunesKit/Sources, recursively, and every literal is
decoded by Swift's own rules: the closing delimiter's indentation is stripped, escapes are
decoded (a raw literal only honours `\\#`-prefixed ones), and an interpolated value is inserted
verbatim -- Swift does not re-indent it, so neither does this. Anything it cannot resolve
exactly is an error (exit 1, nothing written), never a guess.
"""
import os
import re
import sys


class ExtractError(Exception):
    pass


OPENING = re.compile(r'(#*)"""\s*$')
# `[attributes/modifiers] enum|struct|class|actor|extension Name`; group 1 is the indentation,
# group 2 the full (possibly dotted) name, so `extension Foo.Bar` is not `Foo`.
TYPE_DECLARATION = re.compile(r'^(\s*)(?:[\w()@]+\s+)*(?:enum|struct|class|actor|extension)\s+([\w.]+)')
TYPE_MEMBER = re.compile(r'^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$')
SIMPLE_ESCAPES = {'\\': '\\', '"': '"', "'": "'", 'n': '\n', 't': '\t', 'r': '\r', '0': '\0'}


def literal_body(lines, open_i, where):
    """The content of the multiline literal opened on `lines[open_i]` with the closing
    delimiter's indentation stripped (escapes not yet decoded), its `#`s, and its line span."""
    hashes = OPENING.search(lines[open_i]).group(1)
    closing = '"""' + hashes
    close_i = next((i for i in range(open_i + 1, len(lines))
                    if lines[i].lstrip().startswith(closing)), None)
    if close_i is None:
        raise ExtractError(f'{where}: no closing {closing} for the literal opened on line {open_i + 1}')

    closing_line = lines[close_i]
    indent = closing_line[:len(closing_line) - len(closing_line.lstrip())]
    body = []
    for i in range(open_i + 1, close_i):
        line = lines[i]
        if line.startswith(indent):
            body.append(line[len(indent):])
        elif line.strip() == '':
            body.append('')
        else:
            raise ExtractError(f'{where}:{i + 1}: insufficient indentation; the line does not start '
                               f'with the closing delimiter\'s indentation {indent!r}, which Swift rejects')
    return '\n'.join(body), hashes, (open_i + 2, close_i)


def decode(text, hashes, where, resolve):
    """Decode a literal's escapes and interpolations the way Swift does."""
    introducer = '\\' + hashes
    out = []
    i = 0
    while i < len(text):
        if not text.startswith(introducer, i):
            out.append(text[i])
            i += 1
            continue
        j = i + len(introducer)
        c = text[j] if j < len(text) else ''
        if c == '(':
            depth, k = 1, j + 1
            while k < len(text) and depth:
                depth += {'(': 1, ')': -1}.get(text[k], 0)
                k += 1
            if depth:
                raise ExtractError(f'{where}: unterminated interpolation {text[i:i + 40]!r}')
            expression = text[j + 1:k - 1].strip()
            match = TYPE_MEMBER.match(expression)
            if not match:
                raise ExtractError(f'{where}: cannot resolve interpolation {introducer}({expression}); '
                                   'only TypeName.member naming a static string literal is supported')
            out.append(resolve(match.group(1), match.group(2)))
            i = k
        elif c in SIMPLE_ESCAPES:
            out.append(SIMPLE_ESCAPES[c])
            i = j + 1
        elif c == 'u':
            match = re.match(r'u\{([0-9A-Fa-f]{1,8})\}', text[j:])
            if not match:
                raise ExtractError(f'{where}: malformed unicode escape {text[i:i + 14]!r}')
            scalar = int(match.group(1), 16)
            if scalar > 0x10FFFF or 0xD800 <= scalar <= 0xDFFF:
                raise ExtractError(f'{where}: unicode escape {text[i:i + 14]!r} is not a Unicode scalar value')
            out.append(chr(scalar))
            i = j + match.end()
        else:
            # Line continuation: the introducer, optional trailing blanks, then the newline.
            match = re.match(r'[ \t]*\n', text[j:])
            if not match:
                raise ExtractError(f'{where}: invalid escape {text[i:i + 6]!r}')
            i = j + match.end()
    return ''.join(out)


class Resolver:
    """Resolves `TypeName.member` to the decoded value of that static string literal."""

    def __init__(self, sources_dir):
        self.sources_dir = sources_dir
        self.stack = []

    def swift_files(self, key):
        if not os.path.isdir(self.sources_dir):
            raise ExtractError(f'cannot resolve \\({key}): no NepTunesKit sources at {self.sources_dir}')
        for root, dirs, files in os.walk(self.sources_dir):
            dirs.sort()
            for name in sorted(files):
                if name.endswith('.swift'):
                    yield os.path.join(root, name)

    def __call__(self, type_name, member):
        key = f'{type_name}.{member}'
        if key in self.stack:
            raise ExtractError(f'interpolation cycle: {" -> ".join(self.stack + [key])}')

        member_line = re.compile(r'^\s*(?:\w+\s+)*static\s+let\s+' + re.escape(member)
                                 + r'\s*(?::\s*String\s*)?=\s*#*"""\s*$')
        found = []
        for path in self.swift_files(key):
            with open(path, encoding='utf-8') as source:
                lines = source.read().split('\n')
            # Only members inside a declaration of `type_name` itself count. A scope runs from
            # that declaration to the next top-level (column-0) declaration of anything else,
            # so a later type's namesake -- or `extension TypeName.Nested`'s -- is never taken.
            in_scope = False
            for i, line in enumerate(lines):
                declaration = TYPE_DECLARATION.match(line)
                if declaration:
                    if declaration.group(2) == type_name:
                        in_scope = True
                    elif declaration.group(1) == '':
                        in_scope = False
                elif in_scope and member_line.match(line):
                    found.append((path, lines, i))

        if not found:
            raise ExtractError(f'cannot resolve \\({key}): no `static let {member} = """` (or #"""...) '
                               f'inside a declaration of {type_name} under {self.sources_dir}')
        if len(found) > 1:
            places = ', '.join(f'{os.path.relpath(p, self.sources_dir)}:{i + 1}' for p, _, i in found)
            raise ExtractError(f'cannot resolve \\({key}): ambiguous, declared at {places}')

        path, lines, open_i = found[0]
        where = f'{os.path.relpath(path, self.sources_dir)} ({key})'
        self.stack.append(key)
        try:
            text, hashes, _ = literal_body(lines, open_i, where)
            return decode(text, hashes, where, self)
        finally:
            self.stack.pop()


def extract(bridge_path):
    with open(bridge_path, encoding='utf-8') as source:
        lines = source.read().split('\n')
    start = next((i for i, l in enumerate(lines) if 'var javascriptAPI: String {' in l), None)
    if start is None:
        raise ExtractError(f'{bridge_path}: no `var javascriptAPI: String {{`')
    open_i = next((i for i in range(start, len(lines)) if OPENING.search(lines[i])), None)
    if open_i is None:
        raise ExtractError(f'{bridge_path}: javascriptAPI has no multiline string literal')

    sources = os.path.join(os.path.dirname(os.path.abspath(bridge_path)), '..', 'NepTunesKit', 'Sources')
    where = os.path.basename(bridge_path)
    text, hashes, span = literal_body(lines, open_i, where)
    js = decode(text, hashes, where, Resolver(os.path.normpath(sources)))

    for marker in ('window.NepTunes', 'themechange', 'lastFm.call', 'history:'):
        if marker not in js:
            raise ExtractError(f'extraction looks wrong: the result has no {marker!r}')
    return js, span


def main(argv):
    if len(argv) != 3:
        sys.stderr.write(f'usage: {argv[0]} WidgetJSBridge.swift out.js\n')
        return 2
    try:
        js, (first, last) = extract(argv[1])
    except ExtractError as error:
        sys.stderr.write(f'extract-api.py: {error}\n')
        return 1
    with open(argv[2], 'w', encoding='utf-8') as out:
        out.write(js)
    print(f'extracted {len(js)} chars, lines {first}..{last} -> {argv[2]}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
