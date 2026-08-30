import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * The live-stream transport contract, swept across every bundle that has a transport
 * rather than pinned one bundle at a time.
 *
 * Apple Music stations are the reason this exists. A station is a `URL track` whose
 * duration is `missing value` and whose `player position` stays at 0 for the whole
 * broadcast (measured against Music.app, 2026-08-28), so there is nothing to seek in,
 * nothing to skip back to, and nothing to resume: pressing play again restarts the
 * stream. Every widget with a transport therefore has to say the same three things,
 * and a sweep is what makes sure a bundle added later says them too — a per-bundle
 * test file only covers the bundles somebody remembered to write one for.
 */

const bundles = readdirSync(SAMPLES)
    .filter((name) => name.endsWith('.nepget'))
    .filter((name) => /id="(prev|next)Btn"/.test(readFileSync(join(SAMPLES, name, 'index.html'), 'utf8')))
    .sort();

/*
 * Load every pure half up front, remembering the failure instead of raising it. A bundle
 * exports its pure half only if script.js reaches `module.exports` before it touches the
 * DOM; one that does not throws `document is not defined` on require, and letting that
 * escape at module scope would abort the whole file and hide the other bundles' results.
 */
const loaded = new Map();
for (const bundle of bundles) {
    try {
        loaded.set(bundle, { module: require(join(SAMPLES, bundle, 'script.js')), error: null });
    } catch (error) {
        loaded.set(bundle, { module: null, error });
    }
}

function pureHalf(bundle) {
    const { module, error } = loaded.get(bundle);
    if (error) assert.fail(`${bundle} has no requirable pure half: ${error.message}`);
    return module;
}

test('there are bundles with a transport to check', () => {
    assert.ok(bundles.length >= 4, `found only ${bundles.length} bundles with prev/next`);
});

for (const bundle of bundles) {
    const name = bundle.replace(/\.nepget$/, '');

    test(`${name} exports its live-stream helpers`, () => {
        const w = pureHalf(bundle);
        assert.equal(typeof w.transportHidden, 'function', `${name} does not export transportHidden`);
        assert.equal(typeof w.transportGlyph, 'function', `${name} does not export transportGlyph`);
    });

    // Prev/next are HIDDEN during a stream, not greyed: the bridge refuses them centrally
    // (WidgetTransportGuard) and there is no earlier point in a broadcast to skip back to,
    // so an inert-looking button would only invite a tap that means nothing.
    test(`${name} hides prev/next for a live stream only`, () => {
        const { transportHidden } = pureHalf(bundle);
        assert.equal(transportHidden({ title: 'Jessica', isLiveStream: true }), true);
        assert.equal(transportHidden({ title: 'Time', artist: 'Pink Floyd' }), false);
        // An ad is greyed, never hidden — it ends, and the track after it is skippable.
        assert.equal(transportHidden({ title: 'Summer Sale', isAdvertisement: true }), false);
        // `isLiveStream` is only ever sent when true, and `track` itself may be missing.
        assert.equal(transportHidden({ isLiveStream: undefined }), false);
        assert.equal(transportHidden(undefined), false);
        assert.equal(transportHidden(null), false);
    });

    // playerState: 1 stopped, 2 playing, 3 paused. Only PLAYING differs for a stream —
    // stopping a broadcast is not pausing it, because resuming starts it over.
    test(`${name} shows stop, not pause, while a stream plays`, () => {
        const { transportGlyph } = pureHalf(bundle);
        assert.equal(transportGlyph(2, true), 'stop');
        assert.equal(transportGlyph(2, false), 'pause');
        assert.equal(transportGlyph(3, true), 'play');
        assert.equal(transportGlyph(3, false), 'play');
        assert.equal(transportGlyph(1, true), 'play');
    });

    // The glyph the CSS reveals has to exist in the page, or the button goes blank.
    test(`${name} has a stop glyph in its play button`, () => {
        const html = readFileSync(join(SAMPLES, bundle, 'index.html'), 'utf8');
        assert.ok(/data-symbol="stop\.fill"/.test(html), `${name} never draws stop.fill`);
    });

    // Only bundles that render a timeline need this one.
    const timeline = loaded.get(bundle).module?.hasTimeline;
    if (timeline) {
        test(`${name} gives a live stream no timeline`, () => {
            assert.equal(timeline({ title: 'Jessica', isLiveStream: true }), false);
            assert.equal(timeline({ title: 'Time', duration: 413 }), true);
            // An ad keeps its timeline — it has a real duration and a real position.
            // Same split as PlaybackAffordances, where only a live stream drops it.
            assert.equal(timeline({ title: 'Summer Sale', isAdvertisement: true }), true);
            assert.equal(timeline(undefined), true);
        });
    }
}
