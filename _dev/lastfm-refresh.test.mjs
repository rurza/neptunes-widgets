import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Scrobbles and Charts used to poll Last.fm every 30 s and 60 s. They now refresh when
// NepTunes says Last.fm accepted a scrobble (the `scrobble` event, NepTunes 4.1.1+) and on a
// slow timer that catches what the event never reports: scrobbles from another device, and
// hosts before 4.1.1. A failed load is retried, first at the old cadence and then backing off
// to the slow refresh, so a rate limit or a network blip clears soon without hammering
// Last.fm. Signed out is not retried at all: signing in is picked up by the refresh after the
// next track change, a settings change or the slow refresh.
//
// Both widgets carry the same refresher; every case below runs against each of them.

const WIDGETS = [
    { name: 'Scrobbles', api: require('../Scrobbles.nepget/script.js'), retryMs: 30000 },
    { name: 'Charts', api: require('../Charts.nepget/script.js'), retryMs: 60000 },
];

function fakeTimers() {
    let next = 1;
    const timeouts = new Map();
    const intervals = [];
    return {
        timeouts, intervals,
        setTimeout(fn, ms) { const id = next++; timeouts.set(id, { fn, ms }); return id; },
        clearTimeout(id) { timeouts.delete(id); },
        setInterval(fn, ms) { const id = next++; intervals.push({ fn, ms }); return id; },
    };
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

// A load whose answers the test hands out by hand, in whatever order it likes.
function manualLoad() {
    const pending = [];
    const load = () => { const d = deferred(); pending.push(d); return d.promise; };
    return { load, pending };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

for (const { name, api, retryMs } of WIDGETS) {
    test(`${name}: the slow refresh runs every five minutes`, () => {
        const timers = fakeTimers();
        const refresher = api.makeRefresher({ load: () => Promise.resolve(1), apply() {}, fail() {}, retryMs, timers });
        refresher.start();
        assert.deepEqual(timers.intervals.map((i) => i.ms), [5 * 60 * 1000]);
    });

    test(`${name}: an older answer landing after a newer one is dropped`, async () => {
        // A refresh started just before a scrobble can answer after the one the scrobble
        // started — with the pre-scrobble numbers. It must not paint over the newer answer.
        const timers = fakeTimers();
        const { load, pending } = manualLoad();
        const applied = [];
        const refresher = api.makeRefresher({ load, apply: (r) => applied.push(r), fail() {}, retryMs, timers });

        refresher.refresh();
        refresher.refresh();
        await settle();
        assert.equal(pending.length, 2, 'the newer refresh is not held back by the one in flight');

        pending[1].resolve('after the scrobble');
        await settle();
        pending[0].resolve('before the scrobble');
        await settle();
        assert.deepEqual(applied, ['after the scrobble']);
    });

    test(`${name}: an older failure landing after a newer answer changes nothing`, async () => {
        const timers = fakeTimers();
        const { load, pending } = manualLoad();
        const applied = [], failed = [];
        const refresher = api.makeRefresher({ load, apply: (r) => applied.push(r), fail: (e) => failed.push(e), retryMs, timers });

        refresher.refresh();
        refresher.refresh();
        await settle();
        pending[1].resolve('fresh');
        await settle();
        pending[0].reject(Object.assign(new Error('late'), { code: 'timeout' }));
        await settle();
        assert.deepEqual(applied, ['fresh']);
        assert.deepEqual(failed, []);
        assert.equal(timers.timeouts.size, 0, 'no retry for an answer nobody is waiting for');
    });

    test(`${name}: a failure is retried, first at the old polling cadence`, async () => {
        const timers = fakeTimers();
        const failed = [];
        let calls = 0;
        const refresher = api.makeRefresher({
            load: () => { calls++; return Promise.reject(Object.assign(new Error('x'), { code: 'rateLimited' })); },
            apply() {}, fail: (e) => failed.push(e.code), retryMs, timers,
        });
        refresher.refresh();
        await settle();
        assert.deepEqual(failed, ['rateLimited']);
        assert.deepEqual([...timers.timeouts.values()].map((t) => t.ms), [retryMs]);

        // The retry is a refresh like any other.
        [...timers.timeouts.values()][0].fn();
        await settle();
        assert.equal(calls, 2);
    });

    test(`${name}: repeated failures back off, doubling up to the slow refresh`, async () => {
        const timers = fakeTimers();
        const refresher = api.makeRefresher({
            load: () => Promise.reject(Object.assign(new Error('x'), { code: 'network' })),
            apply() {}, fail() {}, retryMs, timers,
        });
        const delays = [];
        refresher.refresh();
        for (let i = 0; i < 6; i++) {
            await settle();
            const [[id, pending]] = [...timers.timeouts.entries()];
            delays.push(pending.ms);
            timers.timeouts.delete(id);
            pending.fn();
        }
        const expected = [];
        for (let d = retryMs; expected.length < 6; d = Math.min(d * 2, 5 * 60 * 1000)) expected.push(d);
        assert.deepEqual(delays, expected);
        assert.equal(delays.at(-1), 5 * 60 * 1000, 'capped at the slow refresh');
    });

    test(`${name}: a success resets the back-off`, async () => {
        const timers = fakeTimers();
        let fail = true;
        const refresher = api.makeRefresher({
            load: () => (fail ? Promise.reject(Object.assign(new Error('x'), { code: 'timeout' })) : Promise.resolve('ok')),
            apply() {}, fail() {}, retryMs, timers,
        });
        refresher.refresh(); await settle();
        refresher.refresh(); await settle();
        assert.deepEqual([...timers.timeouts.values()].map((t) => t.ms), [retryMs * 2]);
        fail = false;
        refresher.refresh(); await settle();
        fail = true;
        refresher.refresh(); await settle();
        assert.deepEqual([...timers.timeouts.values()].map((t) => t.ms), [retryMs]);
    });

    test(`${name}: signed out is shown but never retried`, async () => {
        // Retrying it would keep a signed-out widget polling Last.fm at the old cadence forever.
        const timers = fakeTimers();
        const failed = [];
        const refresher = api.makeRefresher({
            load: () => Promise.reject(Object.assign(new Error('x'), { code: 'notSignedIn' })),
            apply() {}, fail: (e) => failed.push(e.code), retryMs, timers,
        });
        refresher.refresh();
        await settle();
        assert.deepEqual(failed, ['notSignedIn']);
        assert.equal(timers.timeouts.size, 0);
    });

    test(`${name}: a success schedules no retry, and a new refresh replaces a pending one`, async () => {
        const timers = fakeTimers();
        let fail = true;
        const refresher = api.makeRefresher({
            load: () => (fail ? Promise.reject(new Error('down')) : Promise.resolve('ok')),
            apply() {}, fail() {}, retryMs, timers,
        });
        refresher.refresh();
        await settle();
        assert.equal(timers.timeouts.size, 1);

        fail = false;
        refresher.refresh();                 // say, the scrobble event, before the retry is due
        assert.equal(timers.timeouts.size, 0, 'the pending retry is cancelled');
        await settle();
        assert.equal(timers.timeouts.size, 0);
    });

    test(`${name}: a throwing apply is reported as a failure, as before`, async () => {
        const timers = fakeTimers();
        const failed = [];
        const refresher = api.makeRefresher({
            load: () => Promise.resolve('ok'),
            apply() { throw new Error('render'); }, fail: (e) => failed.push(e.message), retryMs, timers,
        });
        refresher.refresh();
        await settle();
        assert.deepEqual(failed, ['render']);
    });

    test(`${name}: refreshes on the scrobble event and no longer polls on a short interval`, () => {
        // The event is registered unconditionally: on a host before 4.1.1 `on` just keeps the
        // listener and nothing ever fires it, which is why minNepTunesVersion stays put.
        const source = readFileSync(new URL(`../${name}.nepget/script.js`, import.meta.url), 'utf8');
        assert.match(source, /NepTunes\.on\('scrobble',/);
        assert.doesNotMatch(source, /setInterval\((loadStats|loadChart)\b/);
        const manifest = JSON.parse(readFileSync(new URL(`../${name}.nepget/manifest.json`, import.meta.url), 'utf8'));
        assert.equal(manifest.minNepTunesVersion, '4.1.0');
    });
}
