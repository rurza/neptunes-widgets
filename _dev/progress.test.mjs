import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Headline and Strip used to redraw their progress line and elapsed label from a
// requestAnimationFrame loop for as long as a track played. The line is now one Web Animation
// from where the track is to its end, and the label is rewritten once a second, on the
// second. These are the two numbers each of them is started from.

const WIDGETS = {
    Headline: require('../Headline.nepget/script.js'),
    Strip: require('../Strip.nepget/script.js'),
};

for (const [name, W] of Object.entries(WIDGETS)) {
    test(`${name}: the progress line runs from where the track is to its end`, () => {
        assert.deepEqual(W.progressRun(30, 120), { from: 0.25, remainingMs: 90000 });
        assert.deepEqual(W.progressRun(0, 200), { from: 0, remainingMs: 200000 });
    });

    test(`${name}: a finished, unknown-length or out-of-range position does not animate`, () => {
        assert.deepEqual(W.progressRun(120, 120), { from: 1, remainingMs: 0 });
        assert.deepEqual(W.progressRun(130, 120), { from: 1, remainingMs: 0 });
        // No duration: the line has always sat at zero, while the label still counts.
        assert.deepEqual(W.progressRun(42, 0), { from: 0, remainingMs: 0 });
        assert.deepEqual(W.progressRun(-1, 100), { from: 0, remainingMs: 100000 });
    });

    test(`${name}: the label wakes when the shown second changes, not before`, () => {
        // formatTime floors, so 12.25 s reads 0:12 until 13.0 s.
        assert.equal(W.msToNextSecond(12.25), 750);
        assert.equal(W.msToNextSecond(12), 1000);
        // A timer that fired a hair early wakes again just past the boundary rather than
        // waiting a whole second with the old number on screen.
        assert.equal(W.msToNextSecond(12.9996), 1);
        assert.ok(W.msToNextSecond(12.999999) >= 1);
    });
}
