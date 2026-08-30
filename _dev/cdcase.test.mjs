import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// script.js exports its pure half and returns before touching the DOM, so it
// can be required here. The track-change reveal's bookkeeping lives in that
// half deliberately: it decides WHEN a printed face may be repainted, it needs
// no scene to decide it, and both bugs below were invisible in the app for as
// long as the decision was buried in the render loop.
const CD = require('../CDCase.nepget/script.js');

const { EDGE_ON, easeInOut, lapAngle, facesToPaint } = CD;

/* Where the lap can start. yaw is wrapped to (-PI, PI] before a lap begins, so
   this is the whole range: square on, a nudge off, edge-on, and turned right
   round to the back, which is the pose the reveal used to get wrong. */
const STARTS = [0, 0.35, -0.35, 1.2, -1.2, Math.PI / 2, -Math.PI / 2,
                2.4, -2.4, Math.PI, -3.0];

const onScreen = (face, facing) => (face === 'back' ? facing < -EDGE_ON : facing > EDGE_ON);

/* The lap, replayed frame by frame with no scene in it.

   `seq` is the generation of what SHOULD be printed, which the track change
   itself moves on: the back carries the title and the artist as well as the
   cover, so it is out of date the moment the track changes even when the
   artwork is byte-for-byte the same.

   `arriveAt` is where in the lap a late sleeve lands and moves it on again:
   null when the artwork was already in hand and the lap only started because
   of it, a fraction when the 1500ms fallback gave up waiting and the bytes
   turned up mid-lap. */
function runLap(startYaw, { frames = 240, arriveAt = null } = {}) {
    let seq = 1;                              // 0 is what the faces are wearing
    const wearing = { front: 0, back: 0 };
    const paints = [];

    for (let i = 0; i <= frames; i++) {
        const k = i / frames;
        if (arriveAt !== null && k >= arriveAt) seq = 2;

        if (k >= 1) {
            // Landing square. Anything still out of date is repainted here
            // whether or not it can be seen: a face left wearing the previous
            // track is worse than one that changes where you can watch it.
            for (const face of ['back', 'front']) {
                if (wearing[face] !== seq) { wearing[face] = seq; paints.push({ k, face, facing: 1, last: true }); }
            }
            break;
        }

        const facing = Math.cos(lapAngle(startYaw, easeInOut(k)));
        for (const face of facesToPaint(facing, wearing, seq)) {
            wearing[face] = seq;
            paints.push({ k, face, facing, last: false });
        }
    }
    return { wearing, paints, seq };
}

/* ---- the rule itself --------------------------------------------------- */

test('a face already wearing the current sleeve is never repainted', () => {
    for (const facing of [-1, -0.5, 0, 0.5, 1]) {
        assert.deepEqual(facesToPaint(facing, { front: 7, back: 7 }, 7), []);
    }
});

test('a face is due the moment it is out of date and out of sight', () => {
    const stale = { front: 0, back: 0 };
    // Square on: the front fills the window, the back is behind it.
    assert.deepEqual(facesToPaint(1, stale, 1), ['back']);
    // Turned right round: the back fills the window, the front is behind it.
    assert.deepEqual(facesToPaint(-1, stale, 1), ['front']);
    // Edge-on: neither face reads, so both may be repainted at once.
    assert.deepEqual(facesToPaint(0, stale, 1), ['back', 'front']);
});

test('the edge-on band is what decides hidden, on both sides', () => {
    const stale = { front: 0, back: 0 };
    assert.ok(facesToPaint(EDGE_ON * 0.99, stale, 1).includes('front'),
        'inside the band the front is grazing and safe to repaint');
    assert.ok(!facesToPaint(EDGE_ON * 1.01, stale, 1).includes('front'),
        'outside it the front is on screen');
    assert.ok(facesToPaint(-EDGE_ON * 0.99, stale, 1).includes('back'));
    assert.ok(!facesToPaint(-EDGE_ON * 1.01, stale, 1).includes('back'));
});

/* ---- the invariant the whole reveal exists for ------------------------- */

test('no face is ever repainted while it is on screen, wherever the lap starts', () => {
    for (const start of STARTS) {
        for (const arriveAt of [null, 0.1, 0.3, 0.5, 0.7]) {
            for (const { face, facing, last } of runLap(start, { arriveAt }).paints) {
                if (last) continue;         // the documented last resort; see below
                assert.ok(!onScreen(face, facing),
                    `start ${start.toFixed(2)}, arriveAt ${arriveAt}: the ${face} was repainted at facing ${facing.toFixed(3)}`);
            }
        }
    }
});

test('a lap always ends with both faces wearing the current sleeve', () => {
    for (const start of STARTS) {
        for (const arriveAt of [null, 0.1, 0.3, 0.5, 0.7, 0.95]) {
            const { wearing, seq } = runLap(start, { arriveAt });
            assert.equal(wearing.back, seq, `start ${start.toFixed(2)}, arriveAt ${arriveAt}: back left stale`);
            assert.equal(wearing.front, seq, `start ${start.toFixed(2)}, arriveAt ${arriveAt}: front left stale`);
        }
    }
});

/* ---- the two bugs ------------------------------------------------------ */

/* Artwork lands late. The lap had already given up waiting and started, the
   back had already been repainted from the OUTGOING sleeve, and the sleeve
   that arrived afterwards was handed only to the front, so the back wore the
   previous track's blurred cover and the previous track's title until some
   later track change happened to redraw it. */
test('a sleeve that lands after the back was repainted still reaches the back', () => {
    const { wearing, paints } = runLap(0, { arriveAt: 0.5 });

    const first = paints.find((p) => p.face === 'back');
    assert.ok(first && first.k < 0.5, 'the back is repainted early, from the outgoing sleeve');

    const again = paints.filter((p) => p.face === 'back' && p.k >= 0.5);
    assert.equal(again.length, 1, 'and again once the new sleeve arrives');
    assert.ok(!again[0].last, 'while it is hidden, not as the lap lands');
    assert.equal(wearing.back, 2);
});

/* The lap does not always start square on. Scroll the case round to its back
   and change track and the reveal used to repaint the back on its very first
   frame, with the back filling the window: the outgoing title and the outgoing
   artwork were replaced in plain sight, which is the one thing the lap is for. */
test('a lap that starts on the back does not repaint the back in front of you', () => {
    const { paints, wearing } = runLap(Math.PI, { arriveAt: null });

    const back = paints.filter((p) => p.face === 'back');
    assert.equal(back.length, 1, 'the back is repainted exactly once');
    assert.ok(back[0].k > 0, 'and not on the first frame, where it fills the window');
    assert.ok(back[0].facing >= -EDGE_ON,
        `the back was repainted at facing ${back[0].facing.toFixed(3)}, still on screen`);

    // The front, meanwhile, is behind the case at that moment and can be done
    // at once, which is what makes it new by the time it swings round.
    const front = paints.filter((p) => p.face === 'front');
    assert.equal(front.length, 1);
    assert.equal(front[0].k, 0);
    assert.equal(wearing.back, 1);
    assert.equal(wearing.front, 1);
});

test('a lap that starts square on repaints the back first, before it swings in', () => {
    const { paints } = runLap(0, { arriveAt: null });
    assert.equal(paints[0].face, 'back');
    assert.equal(paints[0].k, 0, 'the back is behind the case from the first frame');

    const front = paints.find((p) => p.face === 'front');
    assert.ok(front.k > 0 && front.facing <= EDGE_ON,
        'and the front waits until the case has turned it out of sight');
});

test('every face gets its turn hidden during a lap, so nothing is left to the landing', () => {
    // A lap is a full turn: both faces pass behind the case. Repainting on the
    // landing frame is the net for a dropped frame, not the normal path.
    for (const start of STARTS) {
        const { paints } = runLap(start, { arriveAt: null });
        assert.ok(!paints.some((p) => p.last),
            `start ${start.toFixed(2)}: a face was left for the landing frame`);
    }
});

/* ---- the sweep the lap is built on ------------------------------------- */

test('the lap is a full turn plus the correction to square, and never reverses', () => {
    for (const start of STARTS) {
        let prev = lapAngle(start, 0);
        assert.equal(prev, start);
        const dir = start > 0 ? -1 : 1;
        for (let i = 1; i <= 200; i++) {
            const a = lapAngle(start, easeInOut(i / 200));
            assert.ok(dir > 0 ? a >= prev : a <= prev, `start ${start}: the sweep reversed`);
            prev = a;
        }
        assert.ok(Math.abs(Math.abs(prev - start) - (Math.PI * 2 + Math.abs(start))) < 1e-9,
            `start ${start}: travelled ${Math.abs(prev - start).toFixed(4)}, not a lap plus the correction`);
        assert.ok(Math.abs(Math.cos(prev) - 1) < 1e-9, `start ${start}: did not land square`);
    }
});

/* ---- the back panel's two axes ----------------------------------------- */

/* The case's UVs are not square, and the back's are further from square than
   the front's. The front's version of this was found and fixed long ago (a
   squashed cover, see CASE_SQUEEZE in script.js); the back was left with it,
   and because the back is the face that carries TYPE it showed up as a title
   set in something that looked condensed.
 
   The numbers in BACK_PANEL are measured off the model, and the file's own
   history is that measuring them off a picture does not work. So they are
   measured off the model here too, from the GLB that ships in models.js, and
   the constants have to agree with it. */

function readCaseGLB() {
    const src = readFileSync(new URL('../CDCase.nepget/models.js', import.meta.url), 'utf8');
    const b64 = /window\.NT_CASE_B64="([^"]+)"/.exec(src)[1];
    const data = Buffer.from(b64, 'base64');

    let off = 12, json = null, bin = null;      // past the 12-byte GLB header
    while (off < data.length) {
        const len = data.readUInt32LE(off), type = data.readUInt32LE(off + 4);
        const body = data.subarray(off + 8, off + 8 + len);
        if (type === 0x4E4F534A) json = JSON.parse(body.toString('utf8'));
        else if (type === 0x004E4942) bin = body;
        off += 8 + len;
    }
    return { json, bin };
}

// glTF accessors, quantized (KHR_mesh_quantization) and normalized.
const COMPONENT = {
    5120: { get: (b, o) => b.readInt8(o), size: 1, norm: 127 },
    5121: { get: (b, o) => b.readUInt8(o), size: 1, norm: 255 },
    5122: { get: (b, o) => b.readInt16LE(o), size: 2, norm: 32767 },
    5123: { get: (b, o) => b.readUInt16LE(o), size: 2, norm: 65535 },
    5126: { get: (b, o) => b.readFloatLE(o), size: 4, norm: 1 },
};
const COUNTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readAccessor({ json, bin }, index) {
    const a = json.accessors[index];
    const c = COMPONENT[a.componentType], n = COUNTS[a.type];
    const bv = json.bufferViews[a.bufferView];
    const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const stride = bv.byteStride || c.size * n;
    const out = [];
    for (let i = 0; i < a.count; i++) {
        const v = [];
        for (let k = 0; k < n; k++) {
            const raw = c.get(bin, base + i * stride + k * c.size);
            v.push(a.normalized ? Math.max(raw / c.norm, -1) : raw);
        }
        out.push(v);
    }
    return out;
}

function rotate(q, p) {
    const [x, y, z, w] = q;
    const m = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ];
    return m.map((row) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2]);
}

/* The flat printed panel: the vertices sharing the model's outermost Z. The
   rest of the primitive is the case's rim, which is not printed on. */
function measureBackPanel() {
    const glb = readCaseGLB();
    const node = glb.json.nodes.find((n) => n.name === 'ntsc_case_back');
    const S = node.scale, Q = node.rotation;
    const world = [], uvs = [];

    for (const prim of glb.json.meshes[node.mesh].primitives) {
        const pos = readAccessor(glb, prim.attributes.POSITION);
        const uv = readAccessor(glb, prim.attributes.TEXCOORD_0);
        pos.forEach((p, i) => {
            world.push(rotate(Q, [p[0] * S[0], p[1] * S[1], p[2] * S[2]]));
            uvs.push(uv[i]);
        });
    }

    const zMin = Math.min(...world.map((w) => w[2]));
    const flat = world.map((w, i) => [w, uvs[i]]).filter(([w]) => Math.abs(w[2] - zMin) < 0.05);
    const span = (vals) => Math.max(...vals) - Math.min(...vals);
    return {
        wide: span(flat.map(([w]) => w[0])),
        tall: span(flat.map(([w]) => w[1])),
        u: span(flat.map(([, t]) => t[0])),
        v: span(flat.map(([, t]) => t[1])),
    };
}

test('BACK_PANEL is what the shipped model actually says', () => {
    const m = measureBackPanel();
    for (const key of ['wide', 'tall', 'u', 'v']) {
        assert.ok(Math.abs(m[key] - CD.BACK_PANEL[key]) < 0.002,
            `BACK_PANEL.${key} is ${CD.BACK_PANEL[key]}, the model says ${m[key].toFixed(4)}`);
    }
    // The front's own note puts its 58.196 x 56.173 unit face at 130.9 x
    // 126.3mm, so a unit is 2.249mm. The back panel should come out at a real
    // jewel case's 142 x 125, which is the check that the axes are read the
    // right way round rather than merely self-consistent.
    const MM = 130.9 / 58.196;
    assert.ok(Math.abs(m.wide * MM - 142) < 1, `back panel is ${(m.wide * MM).toFixed(1)}mm wide`);
    assert.ok(Math.abs(m.tall * MM - 125) < 1, `back panel is ${(m.tall * MM).toFixed(1)}mm tall`);
});

/* CASE_SQUEEZE sits below the DOM guard, inside the front face's own argument,
   which is where it is explained and where it belongs. So it cannot be
   imported. Read it out of the source rather than restating it here: a second
   copy of a constant is a copy that can go stale while every assertion built on
   it still passes. */
function caseSqueeze() {
    const src = readFileSync(new URL('../CDCase.nepget/script.js', import.meta.url), 'utf8');
    const m = /var CASE_SQUEEZE = ([\d.]+) \/ ([\d.]+);/.exec(src);
    assert.ok(m, 'CASE_SQUEEZE is no longer declared the way this test reads it');
    return Number(m[1]) / Number(m[2]);
}

test('a canvas pixel prints narrower than it is tall, and backStretch is the correction', () => {
    const SQUEEZE = caseSqueeze();
    const p = CD.BACK_PANEL;
    const perU = p.wide * SQUEEZE / p.u, perV = p.tall / p.v;

    assert.ok(perU / perV > 1.35, `one u is ${(perU / perV).toFixed(3)} v, so the axes are not square`);

    // A canvas pixel is narrower on the case than it is tall, so anything drawn
    // square into the wrap lands at 82% of its width. That is the condensed
    // title, and backStretch is what widens it back.
    assert.ok(perU / 1698 < perV / 1000, 'a canvas pixel is narrower than it is tall');
    const stretch = CD.backStretch(1698, 1000, SQUEEZE);
    assert.ok(Math.abs(stretch - 1.2236) < 0.002, `backStretch is ${stretch.toFixed(4)}`);
    assert.ok(Math.abs(1 / stretch - 0.8173) < 0.002, `uncorrected type prints at ${(100 / stretch).toFixed(1)}% width`);

    // A wrap already in the panel's own proportions would need no correction.
    assert.ok(Math.abs(CD.backStretch(perU, perV, SQUEEZE) - 1) < 1e-9);
});

/* ---- every sleeve comes in the same door -------------------------------- */

/* A sleeve does not only arrive by decoding successfully. It also arrives as a
   drawn placeholder when the track has no artwork at all, and again when the
   bytes will not decode. Those two paths used to put it straight on the case:
   mid-lap that repaints the printed face in full view, which is the one thing
   the lap exists to prevent, and it drops the sleeve the lap is holding.

   Positional arguments rather than a named bag, deliberately. The caller builds
   these at three separate sites, and a misspelt key on an object literal is a
   silent 'adopt' for every sleeve, which is exactly the bug restored. */
const ARRIVAL = [true, false];

test('a sleeve that arrives mid-lap is always held, however it was arrived at', () => {
    for (const armed of ARRIVAL) {
        assert.equal(CD.sleeveArrival(true, true, armed), 'hold');
    }
});

test('a sleeve that arrives with a lap armed starts it, rather than landing first', () => {
    assert.equal(CD.sleeveArrival(true, false, true), 'reveal');
});

test('a sleeve is put straight on only when nothing is on screen to protect', () => {
    assert.equal(CD.sleeveArrival(true, false, false), 'adopt', 'nothing is going to hide the change');
    for (const turning of ARRIVAL) {
        for (const armed of ARRIVAL) {
            assert.equal(CD.sleeveArrival(false, turning, armed), 'adopt', 'the case is bare');
        }
    }
});

test('with an album on the case, a lap in flight never resolves to adopt', () => {
    for (const turning of ARRIVAL) {
        for (const armed of ARRIVAL) {
            const verdict = CD.sleeveArrival(true, turning, armed);
            if (turning || armed) {
                assert.notEqual(verdict, 'adopt',
                    `turning=${turning} armed=${armed} would change a face that may be on screen`);
            }
        }
    }
});

/* ---- the printed back's typography -------------------------------------- */

/* A back panel carries three lines of type and no track list, so a title that
   runs to fifty characters is the whole composition. Set at one fixed size it
   filled two full-width lines, broke mid-parenthesis, and left the artist
   looking like a caption to a wall of bold. Both decisions that fix that are
   pure and both are worth pinning: what counts as a qualifier, and how far the
   title may shrink to stay inside its two lines.

   `titleLines` and `fitTitleSize` take a measure function rather than a canvas
   so they can be exercised here. The stub below is a monospace world (every
   glyph half an em wide), which is wrong about a real face and exactly right
   for the question these two answer, which is arithmetic. */
const { splitTitleSuffix, titleLines, fitTitleSize } = CD;

const monospace = (text, size) => text.length * size * 0.5;

test('a trailing bracketed qualifier comes off the title', () => {
    assert.deepEqual(
        splitTitleSuffix('Rock And Roll All Nite (Live From Detroit, MI/1975)'),
        { main: 'Rock And Roll All Nite', suffix: '(Live From Detroit, MI/1975)' });
    assert.deepEqual(
        splitTitleSuffix('IV. Presto (Ode To Joy) [Live]'),
        { main: 'IV. Presto (Ode To Joy)', suffix: '[Live]' },
        'only the last group comes off; the first is part of the name');
});

/* The dash form is the ambiguous one. "Bohemian Rhapsody - Remastered 2011" is
   a title plus a label's note; "Jekyll - Hyde" is a title. Nothing in the
   string says which, so the tail has to look like a qualifier before it is
   demoted, and a title is never taken apart on a bare dash. */
test('a dashed tail is demoted only when it reads as a qualifier', () => {
    assert.deepEqual(splitTitleSuffix('Bohemian Rhapsody - Remastered 2011'),
        { main: 'Bohemian Rhapsody', suffix: 'Remastered 2011' });
    assert.deepEqual(splitTitleSuffix('Jekyll - Hyde'),
        { main: 'Jekyll - Hyde', suffix: '' });
});

test('a title that is all qualifier, or led by one, is left whole', () => {
    for (const whole of ['(I Can\'t Get No) Satisfaction', '(Live)', 'Satisfaction', '']) {
        assert.equal(splitTitleSuffix(whole).main, whole, whole || '(empty)');
        assert.equal(splitTitleSuffix(whole).suffix, '');
    }
});

/* The one property that matters more than where the split lands: the back is
   the only place the full title is printed, so demoting a qualifier may not
   quietly drop a word of it. */
test('splitting loses nothing of the title', () => {
    for (const t of ['Rock And Roll All Nite (Live From Detroit, MI/1975)',
                     'Bohemian Rhapsody - Remastered 2011',
                     'Jekyll - Hyde', 'Satisfaction', '  spaced  out  ']) {
        const words = (str) => str.split(/\s+/).filter((w) => w && !/^[-–—]$/.test(w));
        const { main, suffix } = splitTitleSuffix(t);
        assert.deepEqual(words(main + ' ' + suffix), words(t), t);
    }
});

test('a title only shrinks as far as it has to, and never past the floor', () => {
    const hi = 70, lo = 46, maxW = 600;
    assert.equal(fitTitleSize(monospace, 'Alive!', maxW, 2, hi, lo), hi,
        'a short title is set at full size');

    const long = 'IV. Presto, live at the Berliner Philharmonie';
    const fitted = fitTitleSize(monospace, long, maxW, 2, hi, lo);
    assert.ok(fitted < hi && fitted >= lo, `fitted to ${fitted}`);
    assert.ok(titleLines(monospace, long, maxW, fitted) <= 2, 'and it actually fits');

    const absurd = 'x'.repeat(40) + ' ' + 'y'.repeat(40) + ' ' + 'z'.repeat(40);
    assert.equal(fitTitleSize(monospace, absurd, maxW, 2, hi, lo), lo,
        'nothing fits, so the floor holds and the extra line is drawn instead');
});

test('a word longer than the column is broken, not run off the edge', () => {
    const word = 'Supercalifragilisticexpialidocious';
    assert.equal(titleLines(monospace, word, 40, 20), Math.ceil(word.length / 4));
    assert.equal(titleLines(monospace, '', 600, 20), 0);
});

/* A title with no spaces in it is not a curiosity: it is how most Japanese and
   Chinese titles are written, and a wrap that can only break on a space sets
   one as a single line and draws it off the edge of the printed panel. */
test('a title with nowhere to break is broken anyway', () => {
    const lines = CD.wrapTitle(monospace, '君の知らない物語をもう一度だけ', 100, 20, 4);
    assert.ok(lines.length > 1, `stayed on one line: ${lines.join(' | ')}`);
    for (const ln of lines) assert.ok(monospace(ln, 20) <= 100, `${ln} overflows`);
    assert.equal(lines.join(''), '君の知らない物語をもう一度だけ', 'and nothing is lost');
});

test('a title that outruns its lines is marked, not quietly cut', () => {
    const lines = CD.wrapTitle(monospace, 'one two three four five six seven eight', 100, 20, 2);
    assert.equal(lines.length, 2);
    assert.ok(lines[1].endsWith('…'), lines[1]);
    for (const ln of lines) assert.ok(monospace(ln, 20) <= 100, `${ln} overflows`);
});

test('a title that fits is handed back whole, with no ellipsis', () => {
    assert.deepEqual(CD.wrapTitle(monospace, 'Alive!', 600, 20, 2), ['Alive!']);
    assert.deepEqual(CD.wrapTitle(monospace, '', 600, 20, 2), []);
});

/* ===== "Open the case when paused" =====

   The host pushes state about once a second while anything plays, and once a
   second flat during a live stream (whose position never advances, so the app's
   drift check used to fire on every poll). Re-deriving the lid pose from every
   one of those pushes overwrote the pose a click had just chosen, so clicking
   the case open during radio lasted well under a second. The setting acts on the
   play/pause transition instead; null means "leave the lid alone". */
const { lidPoseOnState } = CD;

test('the setting off never touches the lid', () => {
    assert.equal(lidPoseOnState(false, true, false), null);
    assert.equal(lidPoseOnState(false, false, true), null);
    assert.equal(lidPoseOnState(false, true, null), null);
});

test('a repeated push at the same playback state leaves the lid alone', () => {
    // This is the bug: every one of these used to re-assert a pose.
    assert.equal(lidPoseOnState(true, true, true), null);
    assert.equal(lidPoseOnState(true, false, false), null);
});

test('the pose lands on the play/pause transition', () => {
    assert.equal(lidPoseOnState(true, false, true), 1, 'pausing opens the case');
    assert.equal(lidPoseOnState(true, true, false), 0, 'playing shuts it');
});

test('the first push poses the case whichever state it arrives in', () => {
    // `was` is null before the first push and after the setting is switched on,
    // so neither has to wait for a transition that may be a whole album away.
    assert.equal(lidPoseOnState(true, false, null), 1);
    assert.equal(lidPoseOnState(true, true, null), 0);
});
