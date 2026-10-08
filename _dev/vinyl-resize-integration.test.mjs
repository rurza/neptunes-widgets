import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Vinyl = require('../Vinyl.nepget/script.js');
const source = readFileSync(new URL('../Vinyl.nepget/script.js', import.meta.url), 'utf8');

class Classes {
    values = new Set();
    add(...values) { values.forEach((value) => this.values.add(value)); }
    remove(...values) { values.forEach((value) => this.values.delete(value)); }
    contains(value) { return this.values.has(value); }
    toggle(value, force) {
        const enabled = force === undefined ? !this.contains(value) : force;
        if (enabled) this.add(value); else this.remove(value);
        return enabled;
    }
}

class Element {
    constructor(id = '') {
        this.id = id;
        this.style = { values: {}, setProperty(key, value) { this.values[key] = value; } };
        this.classList = new Classes();
        this.listeners = {};
        this.children = [];
        this.clientWidth = 232;
        this.clientHeight = 232;
        this.hidden = false;
    }
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
    dispatch(name, event = {}) { (this.listeners[name] || []).forEach((fn) => fn(event)); }
    remove() { this.removed = true; }
    appendChild(child) { this.children.push(child); child.parent = this; }
    insertBefore(child) { this.appendChild(child); }
    setAttribute(key, value) { this[key] = value; }
    removeAttribute(key) { delete this[key]; }
    cloneNode() {
        const fragment = new Element('fragment');
        const elements = {
            '.track-info': new Element('track-info'), '.title': new Element('title'),
            '.artist': new Element('artist'), '.controls': new Element('controls'),
            '#playBtn': new Element('playBtn'), '#prevBtn': new Element('prevBtn'),
            '#nextBtn': new Element('nextBtn'), '#liveBadge': new Element('liveBadge')
        };
        fragment.querySelector = (selector) => elements[selector];
        return fragment;
    }
}

function browser(settings, { width = 232, height = 232, minimumAPI = true } = {}) {
    const elements = Object.fromEntries([
        'widget', 'emptyOpen', 'vinyl', 'artwork', 'leftSide', 'rightSide', 'bottomSide',
        'trackInfoTemplate', 'controlsTemplate', 'resizeHandle'
    ].map((id) => [id, new Element(id)]));
    elements.trackInfoTemplate.content = { cloneNode: () => elements.trackInfoTemplate.cloneNode() };
    elements.controlsTemplate.content = { cloneNode: () => elements.controlsTemplate.cloneNode() };
    const root = new Element('root');
    root.clientWidth = width;
    root.clientHeight = height;
    const documentListeners = {};
    const document = {
        readyState: 'complete', documentElement: root,
        getElementById: (id) => elements[id],
        addEventListener(name, callback) { (documentListeners[name] ||= []).push(callback); },
        dispatch(name, event = {}) { (documentListeners[name] || []).forEach((fn) => fn(event)); }
    };
    const callbacks = {};
    const sizeCalls = [];
    const minimumCalls = [];
    const messages = [];
    const nepTunes = {
        settings: null, state: null, on(name, fn) { callbacks[name] = fn; },
        setSize(width, height) { sizeCalls.push({ width, height }); },
        getArtworkDataURL() { return null; }, _signalReady() {}
    };
    if (minimumAPI) {
        nepTunes.setMinimumSize = (width, height) => minimumCalls.push({ width, height });
    }
    let resizeObserver;
    class TestResizeObserver { constructor(fn) { resizeObserver = fn; } observe() {} }
    const context = {
        document, window: {
            NepTunes: nepTunes, ResizeObserver: TestResizeObserver,
            addEventListener() {},
            webkit: { messageHandlers: { neptunes: { postMessage(message) { messages.push(message); } } } }
        }, console,
        ResizeObserver: TestResizeObserver,
        requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout,
        SFSymbols: { load() {}, reload() {} }
    };
    vm.runInNewContext(source, context, { filename: 'Vinyl/script.js' });
    const page = {
        root, elements, document, callbacks, sizeCalls, minimumCalls, messages,
        settings(next) { nepTunes.settings = next; callbacks.settingschange(next); },
        resize(width, height) { root.clientWidth = width; root.clientHeight = height; resizeObserver(); },
        // Node cannot resolve CSS calc/clamp. This reports the expected arithmetic only;
        // the real WebKit resize harness owns the rendered-size assertion.
        disc() {
            const current = nepTunes.settings || base;
            return `${Vinyl.discSizeForViewport(root.clientWidth, root.clientHeight,
                current.labelPosition || 'off', current.controlsPosition || 'off')}px`;
        }
    };
    if (settings) page.settings(settings);
    return page;
}

const base = { discSize: '136', labelPosition: 'off', controlsPosition: 'off' };
const positions = ['off', 'left', 'right', 'bottom'];

test('the first real settings delivery derives size from the restored host viewport', () => {
    const page = browser({ ...base, discSize: '80' }, { width: 316, height: 300 });
    assert.equal(page.disc(), '220px');
    assert.deepEqual(page.sizeCalls, []);
});

test('a restored custom viewport derives the disc without requesting a resize', () => {
    const page = browser(base, { width: 316, height: 300 });
    page.resize(316, 300);
    assert.equal(page.disc(), '220px');
    assert.deepEqual(page.sizeCalls, []);
});

test('manual resize does not echo setSize and unrelated updates preserve the custom disc', () => {
    const page = browser(base);
    page.resize(316, 300);
    assert.equal(page.disc(), '220px');
    page.settings({ ...base, textColor: 'black', spinRpm: '45' });
    assert.equal(page.disc(), '220px');
    assert.deepEqual(page.sizeCalls, []);
    page.callbacks.themechange();
    page.callbacks.statechange({ track: { title: 'Track', artist: 'Artist' }, playerState: 1 });
    assert.equal(page.disc(), '220px');
    assert.deepEqual(page.sizeCalls, []);
});

test('label and control panel changes preserve custom diameter and request each extent once', () => {
    const page = browser(base);
    assert.deepEqual(page.minimumCalls, [Vinyl.minimumWindowSize('off', 'off')]);
    page.resize(316, 300);
    page.settings({ ...base, labelPosition: 'left' });
    assert.deepEqual(page.minimumCalls, [
        Vinyl.minimumWindowSize('off', 'off'), Vinyl.minimumWindowSize('left', 'off')
    ]);
    assert.equal(page.disc(), '80px', 'CSS keeps the old viewport safe while the host applies the larger panel frame');
    assert.deepEqual(page.sizeCalls, [{ width: 472, height: 300 }]);
    page.resize(472, 300);
    assert.equal(page.disc(), '220px');
    page.settings({ ...base, labelPosition: 'left', controlsPosition: 'bottom' });
    assert.equal(page.disc(), '168px', 'CSS remains bounded until the bottom-panel frame arrives');
    assert.deepEqual(page.minimumCalls, [
        Vinyl.minimumWindowSize('off', 'off'),
        Vinyl.minimumWindowSize('left', 'off'),
        Vinyl.minimumWindowSize('left', 'bottom')
    ]);
    assert.deepEqual(page.sizeCalls, [
        { width: 472, height: 300 }, { width: 472, height: 352 }
    ]);
});

test('legacy discSize values are ignored at startup and on later settings pushes', () => {
    for (const legacy of ['80', '104', '136', '168', '208', '320', 'nonsense']) {
        const page = browser({ ...base, discSize: legacy }, { width: 316, height: 300 });
        assert.equal(page.disc(), '220px', `startup legacy value ${legacy}`);
        assert.deepEqual(page.sizeCalls, [], `startup legacy value ${legacy}`);
        page.settings({ ...base, discSize: legacy === '80' ? '320' : '80' });
        assert.equal(page.disc(), '220px', `later legacy value ${legacy}`);
        assert.deepEqual(page.sizeCalls, [], `later legacy value ${legacy}`);
    }
});

test('first real settings delivery applies panel bounds whether it precedes or follows observation', () => {
    const settings = { ...base, discSize: '80', labelPosition: 'bottom', controlsPosition: 'bottom' };
    const beforeObserver = browser(null, { width: 346, height: 284 });
    beforeObserver.settings(settings);
    assert.equal(beforeObserver.disc(), '152px');
    assert.deepEqual(beforeObserver.sizeCalls, []);
    beforeObserver.resize(346, 284);
    assert.deepEqual(beforeObserver.sizeCalls, []);

    const afterObserver = browser(null, { width: 176, height: 176 });
    afterObserver.resize(176, 176);
    afterObserver.settings(settings);
    assert.equal(afterObserver.disc(), '80px');
    assert.deepEqual(afterObserver.sizeCalls, [{ width: 330, height: 212 }]);
});

test('duplicate settings deliveries and unrelated values do not resize the window', () => {
    const page = browser(base, { width: 316, height: 300 });
    page.settings({ ...base });
    page.settings({ ...base, textColor: 'black', spinRpm: '45' });
    assert.equal(page.disc(), '220px');
    assert.deepEqual(page.sizeCalls, []);
    page.settings({ ...base, labelPosition: 'left' });
    page.settings({ ...base, labelPosition: 'left' });
    assert.deepEqual(page.sizeCalls, [{ width: 472, height: 300 }]);
});

test('rapid viewport notifications settle without setSize feedback', () => {
    const page = browser(base);
    for (const [width, height] of [[250, 250], [280, 260], [320, 300], [316, 300]]) {
        page.resize(width, height);
    }
    assert.equal(page.disc(), '220px');
    assert.deepEqual(page.sizeCalls, []);
});

test('restored undersized bottom panels are corrected once to readable minimum dimensions', () => {
    const page = browser({ ...base, labelPosition: 'bottom', controlsPosition: 'bottom' },
        { width: 176, height: 176 });
    page.resize(176, 176);
    assert.equal(page.disc(), '80px');
    assert.deepEqual(page.sizeCalls, [{ width: 330, height: 212 }]);
    page.resize(176, 176);
    assert.equal(page.sizeCalls.length, 1, 'repeated observer delivery must not create a resize loop');
    page.resize(330, 212);
    assert.equal(page.sizeCalls.length, 1);
});

test('every panel layout grows an undersized restored viewport to its content minimum', () => {
    for (const labelPosition of positions) {
        for (const controlsPosition of positions) {
            const settings = { ...base, labelPosition, controlsPosition };
            const page = browser(settings, { width: 160, height: 160 });
            const minimum = Vinyl.minimumWindowSize(labelPosition, controlsPosition);
            assert.equal(page.disc(), '80px', `${labelPosition}/${controlsPosition} smallest disc`);
            const needsResize = minimum.width > 160 || minimum.height > 160;
            assert.deepEqual(page.sizeCalls, needsResize ? [minimum] : [],
                `${labelPosition}/${controlsPosition} minimum resize`);
            page.resize(minimum.width, minimum.height);
            assert.deepEqual(page.sizeCalls, needsResize ? [minimum] : [],
                `${labelPosition}/${controlsPosition} no resize feedback`);
        }
    }
});

test('manual shrink cannot strand a readable bottom-panel layout below its minimum', () => {
    const page = browser(base);
    page.resize(176, 176);
    page.settings({ ...base, labelPosition: 'bottom', controlsPosition: 'bottom' });
    assert.deepEqual(page.sizeCalls, [{ width: 330, height: 228 }]);
    page.resize(330, 228);
    page.elements.resizeHandle.dispatch('mousedown', {
        screenX: 500, screenY: 500, preventDefault() {}, stopPropagation() {}
    });
    page.document.dispatch('mousemove', { screenX: 500, screenY: 450 });
    assert.deepEqual(JSON.parse(JSON.stringify(page.messages[0])), {
        type: 'resizeMove', deltaX: 0, deltaY: -16
    });
    assert.deepEqual(page.sizeCalls, [{ width: 330, height: 228 }],
        'normal resize is clamped, not repaired by a later setSize call');
    page.resize(330, 212);
    assert.equal(page.disc(), '80px');
    page.document.dispatch('mouseup');
});

test('the resize handle sends grow, shrink, and end messages through the existing mouse path', () => {
    const page = browser(base);
    const down = {
        screenX: 200, screenY: 200, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }
    };
    page.elements.resizeHandle.dispatch('mousedown', down);
    assert.equal(down.prevented, true);
    assert.equal(down.stopped, true);
    assert.equal(page.root.classList.contains('resize-active'), true);

    page.document.dispatch('mousemove', { screenX: 220, screenY: 220 });
    page.document.dispatch('mousemove', { screenX: 210, screenY: 210 });
    page.document.dispatch('mouseup');
    assert.equal(page.root.classList.contains('resize-active'), false);
    assert.deepEqual(JSON.parse(JSON.stringify(page.messages)), [
        { type: 'resizeMove', deltaX: 20, deltaY: 20 },
        { type: 'resizeMove', deltaX: -10, deltaY: -10 },
        { type: 'resizeEnd' }
    ]);
    page.document.dispatch('mousemove', { screenX: 230, screenY: 230 });
    assert.equal(page.messages.length, 3, 'movement after mouseup must not continue resizing');
});

test('the active resize path declares native minimums and clamps shrink deltas before posting', () => {
    for (const labelPosition of positions) {
        for (const controlsPosition of positions) {
            const settings = { ...base, labelPosition, controlsPosition };
            const minimum = Vinyl.minimumWindowSize(labelPosition, controlsPosition);
            const page = browser(settings, { width: minimum.width + 12, height: minimum.height + 12 });
            assert.deepEqual(page.minimumCalls, [minimum], `${labelPosition}/${controlsPosition} native floor`);

            page.elements.resizeHandle.dispatch('mousedown', {
                screenX: 100, screenY: 100, preventDefault() {}, stopPropagation() {}
            });
            page.document.dispatch('mousemove', { screenX: 70, screenY: 70 });
            assert.deepEqual(JSON.parse(JSON.stringify(page.messages[0])), {
                type: 'resizeMove', deltaX: -12, deltaY: -12
            }, `${labelPosition}/${controlsPosition} clamped movement`);
            page.document.dispatch('mousemove', { screenX: 60, screenY: 60 });
            assert.equal(page.messages.length, 1,
                `${labelPosition}/${controlsPosition} does not send a zero resize at the floor`);
            page.document.dispatch('mouseup');
        }
    }
});

test('an older helper without setMinimumSize still gets locally clamped resize requests', () => {
    const settings = { ...base, labelPosition: 'bottom', controlsPosition: 'bottom' };
    const minimum = Vinyl.minimumWindowSize('bottom', 'bottom');
    const page = browser(settings, { width: minimum.width, height: minimum.height + 24, minimumAPI: false });
    assert.deepEqual(page.minimumCalls, []);
    page.elements.resizeHandle.dispatch('mousedown', {
        screenX: 100, screenY: 100, preventDefault() {}, stopPropagation() {}
    });
    page.document.dispatch('mousemove', { screenX: 100, screenY: 50 });
    assert.deepEqual(JSON.parse(JSON.stringify(page.messages[0])), {
        type: 'resizeMove', deltaX: 0, deltaY: -24
    });
    page.document.dispatch('mouseup');
});
