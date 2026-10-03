import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Apple revised the system colours on 2025-06-09 (HIG → Color → System colors). Widgets that
// draw an Apple system colour must use the current value, which matches NSColor.system* on
// macOS 26 and later. This sweeps every bundle, and the shared _dev files bundles copy, for
// the values Apple retired, in hex (any case, optional alpha suffix) and rgb()/array form.

const RETIRED = {
  // dark appearance
  'red (dark)': 'FF453A', 'orange (dark)': 'FF9F0A', 'yellow (dark)': 'FFD60A',
  'mint (dark)': '66D4CF', 'mint (dark, alt)': '63E6E2', 'teal (dark)': '40C8E0',
  'teal (dark, alt)': '40CBE0', 'cyan (dark)': '64D2FF', 'blue (dark)': '0A84FF',
  'indigo (dark)': '5E5CE6', 'purple (dark)': 'BF5AF2', 'brown (dark)': 'AC8E68',
  // light appearance
  'red (light)': 'FF3B30', 'orange (light)': 'FF9500', 'mint (light)': '00C7BE',
  'teal (light)': '30B0C7', 'cyan (light)': '32ADE6', 'blue (light)': '007AFF',
  'indigo (light)': '5856D6', 'purple (light)': 'AF52DE', 'brown (light)': 'A2845E',
};

const PATTERNS = Object.entries(RETIRED).flatMap(([name, hex]) => {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return [
    { name, re: new RegExp(`#${hex}(?:[0-9a-f]{2})?(?![0-9a-f])`, 'i') },
    { name, re: new RegExp(`(?<![\\d.])${r}\\s*,\\s*${g}\\s*,\\s*${b}(?![\\d.])`) },
  ];
});

function retiredColours(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const { name, re } of PATTERNS) {
      const m = line.match(re);
      if (m) hits.push({ line: i + 1, name, match: m[0] });
    }
  });
  return hits;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const TEXT = /\.(css|js|mjs|html|json|svg)$/;
const SHARED = ['neptunes-kit.js', 'mock-neptunes.js', 'harness.html', 'sfsymbols.js', 'history-stats.js'];

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : filesUnder(p);
    return TEXT.test(name) ? [p] : [];
  });
}

const bundles = readdirSync(root).filter((n) => n.endsWith('.nepget')).sort();

function bundleHits(bundle) {
  return filesUnder(join(root, bundle)).flatMap((file) =>
    retiredColours(readFileSync(file, 'utf8')).map((h) =>
      `${file.slice(root.length)}:${h.line} ${h.match} (retired ${h.name})`));
}

test('the detector finds retired values in every form it claims to', () => {
  for (const sample of ['color: #0A84FF;', 'color:#0a84ff', 'fill="#0A84FF80"',
                        'rgba(10, 132, 255, 0.5)', 'rgb(10,132,255)', '[10, 132, 255]']) {
    assert.equal(retiredColours(sample).length, 1, sample);
  }
});

test('the detector leaves current and unrelated values alone', () => {
  for (const sample of ['#0091FF', '#0088FF', '#30D158', '#FF375F', '#0A84FF1F2', '#10A84FF',
                        'rgb(110, 132, 255)', 'rgb(10, 132, 2550)', '0.10, 132, 255']) {
    assert.deepEqual(retiredColours(sample), [], sample);
  }
});

test('the sweep covers every bundle', () => {
  assert.ok(bundles.length >= 17, `found ${bundles.length} bundles`);
});

for (const bundle of bundles) {
  test(`${bundle} uses no retired system colour`, () => {
    assert.deepEqual(bundleHits(bundle), []);
  });
}

test('the shared _dev files use no retired system colour', () => {
  const hits = SHARED.flatMap((name) =>
    retiredColours(readFileSync(join(root, '_dev', name), 'utf8')).map((h) => `${name}:${h.line} ${h.match}`));
  assert.deepEqual(hits, []);
});
