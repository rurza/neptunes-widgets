import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { installNepTunesMock } = require('./mock-neptunes.js');

// The mock stands in for the app while a widget is developed in a browser. Where it models a
// rule the app enforces it must refuse the same things: a widget that only ever met a
// permissive mock ships calls the app turns down.

function mock(opts) {
  const win = {};
  const ctl = installNepTunesMock(win, { latency: 0, ...(opts || {}) });
  return { N: win.NepTunes, ctl };
}
const codeOf = (promise) => promise.then(() => 'resolved', (e) => e.code);

test('lastFm.call answers allowed reads in Last.fm\'s own shape', async () => {
  const { N } = mock();
  const body = await N.lastFm.call('user.getInfo');
  assert.equal(typeof body.user.name, 'string');
  assert.equal(typeof body.user.playcount, 'string', 'Last.fm sends numbers as strings');
});

test('lastFm.call refuses what the app refuses', async () => {
  const { N } = mock();
  for (const method of ['auth.getSession', 'auth.getToken', 'track.love', 'track.scrobble',
                        'album.addTags', 'user.shout', 'getInfo', '', 'user.getInfo.x']) {
    assert.equal(await codeOf(N.lastFm.call(method)), 'methodNotAllowed', method);
  }
});

test('lastFm.call follows the app\'s allowlist to the letter', async () => {
  const { N } = mock();
  // LastFmPassthroughPolicy.isAllowed: the verb is longer than "get" and ASCII letters only,
  // and the package matches case-sensitively.
  for (const method of ['user.get', 'User.getInfo', 'user.get_info', 'user.getInfo2', 'user.getÍnfo', null, 42]) {
    assert.equal(await codeOf(N.lastFm.call(method)), 'methodNotAllowed', String(method));
  }
  // Allowed but not modelled by the mock: an honest Last.fm error, not a refusal.
  assert.equal(await codeOf(N.lastFm.call('geo.getTopArtists', { country: 'poland' })), 'lastFm:3');
});

test('lastFm.call passes numbers and booleans as strings, like the bridge', async () => {
  const { N } = mock();
  const body = await N.lastFm.call('user.getTopAlbums', { period: '7day', limit: 2 });
  assert.equal(body.topalbums.album.length, 2);
  assert.equal(body.topalbums['@attr'].perPage, '2');
});

test('a user-scoped read with nobody signed in is notSignedIn unless it names a user', async () => {
  const { N } = mock({ signedOut: true });
  assert.equal(await codeOf(N.lastFm.call('user.getRecentTracks')), 'notSignedIn');
  assert.equal(await codeOf(N.lastFm.call('user.getRecentTracks', { user: 'rj' })), 'resolved');
});

test('user.getRecentTracks honours from/to, limit and page', async () => {
  const { N } = mock();
  const to = Math.floor(Date.now() / 1000);
  const from = to - 30 * 86400;
  const params = { from: String(from), to: String(to), limit: '50' };
  const one = (await N.lastFm.call('user.getRecentTracks', { ...params, page: '1' })).recenttracks;
  assert.ok(Number(one['@attr'].totalPages) > 1, 'thirty days should span several pages');
  const dated = one.track.filter((t) => t.date);
  assert.ok(dated.length <= 50);
  for (const t of dated) {
    const uts = Number(t.date.uts);
    assert.ok(uts >= from && uts < to, `${uts} outside [${from}, ${to})`);
  }
  const two = (await N.lastFm.call('user.getRecentTracks', { ...params, page: '2' })).recenttracks;
  assert.ok(Number(two.track[0].date.uts) <= Number(dated[dated.length - 1].date.uts), 'pages overlap');
  assert.ok(!two.track.some((t) => t['@attr'] && t['@attr'].nowplaying), 'now playing only on page 1');
});

test('lastFm.image loads Last.fm image hosts only, as a data URL', async () => {
  const { N } = mock();
  assert.match(await N.lastFm.image('https://lastfm.freetls.fastly.net/i/u/300x300/abc.png'), /^data:image\//);
  for (const bad of ['http://lastfm.freetls.fastly.net/i/u/300x300/abc.png',
                     'https://evil.example/a.png',
                     'https://lastfm.freetls.fastly.net.evil.example/a.png',
                     'data:image/png;base64,AAAA']) {
    assert.equal(await codeOf(N.lastFm.image(bad)), 'urlNotAllowed', bad);
  }
});

test('lastFm.image applies the rest of LastFmImagePolicy too', async () => {
  const { N } = mock();
  assert.match(await N.lastFm.image('https://LASTFM-IMG2.akamaized.net:443/i/u/a.png'), /^data:image\//);
  for (const bad of ['https://lastfm.freetls.fastly.net:8443/a.png',
                     'https://me:pw@lastfm.freetls.fastly.net/a.png',
                     'https://lastfm.freetls.fastly.net/' + 'a'.repeat(2048),
                     '', null]) {
    assert.equal(await codeOf(N.lastFm.image(bad)), 'urlNotAllowed', String(bad).slice(0, 60));
  }
});

test('the chart images the mock hands out load through image()', async () => {
  const { N } = mock();
  const body = await N.lastFm.call('user.getTopAlbums', { period: '7day', limit: '3' });
  const url = body.topalbums.album[0].image.find((i) => i.size === 'extralarge')['#text'];
  assert.match(await N.lastFm.image(url), /^data:image\//);
});

test('without a declared permission the new calls reject with permissionDenied', async () => {
  const { N } = mock({ permissions: ['artwork'] });
  assert.equal(await codeOf(N.lastFm.call('user.getInfo')), 'permissionDenied');
  assert.equal(await codeOf(N.lastFm.image('https://lastfm.freetls.fastly.net/i/u/a.png')), 'permissionDenied');
  assert.equal(await codeOf(N.history.info()), 'permissionDenied');
  assert.equal(await codeOf(N.history.recent({})), 'permissionDenied');

  const granted = mock({ permissions: ['lastFm', 'listeningHistory'] }).N;
  assert.equal(await codeOf(granted.lastFm.call('user.getInfo')), 'resolved');
  assert.equal(await codeOf(granted.history.info()), 'resolved');
});

test('history.query groups by local day, chronologically, inside a half-open range', async () => {
  const { N } = mock();
  const to = new Date(); to.setHours(0, 0, 0, 0); to.setDate(to.getDate() + 1);
  const from = new Date(to); from.setDate(from.getDate() - 7);
  const { rows } = await N.history.query({ from: from.toISOString(), to: to.toISOString(), groupBy: 'day' });
  const dates = rows.map((r) => r.date);
  assert.deepEqual(dates, [...dates].sort());
  for (const r of rows) {
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isInteger(r.plays) && r.plays >= 0);
    assert.ok(r.seconds >= 0);
  }
});

test('history.query takes Dates as well as ISO strings, like the bridge', async () => {
  const { N } = mock();
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 86400000);
  const { rows } = await N.history.query({ from, to, groupBy: 'weekday' });
  for (const r of rows) assert.ok(r.weekday >= 1 && r.weekday <= 7, 'ISO weekdays');
  assert.equal(await codeOf(N.history.query({ from: new Date(NaN), to, groupBy: 'day' })), 'invalidQuery');
});

test('history.query ranks entities by plays and honours limit', async () => {
  const { N } = mock();
  const { rows } = await N.history.query({ from: '2000-01-01T00:00:00Z', to: new Date().toISOString(),
                                           groupBy: 'artist', limit: 3 });
  assert.ok(rows.length <= 3);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].plays >= rows[i].plays);
  assert.equal(typeof rows[0].artist, 'string');
});

test('history.query rows carry the keys their grouping owns', async () => {
  const { N } = mock();
  const range = { from: '2000-01-01T00:00:00Z', to: new Date().toISOString() };
  const album = (await N.history.query({ ...range, groupBy: 'album' })).rows[0];
  assert.deepEqual(Object.keys(album).sort(), ['album', 'artist', 'plays', 'seconds']);
  const track = (await N.history.query({ ...range, groupBy: 'track' })).rows[0];
  assert.deepEqual(Object.keys(track).sort(), ['album', 'artist', 'plays', 'seconds', 'title']);
});

test('history.query rejects a malformed query with invalidQuery', async () => {
  const { N } = mock();
  const range = { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' };
  assert.equal(await codeOf(N.history.query({ ...range, groupBy: 'month' })), 'invalidQuery');
  assert.equal(await codeOf(N.history.query({ groupBy: 'day' })), 'invalidQuery');
  assert.equal(await codeOf(N.history.query({ ...range, groupBy: 'day', sort: 'loudness' })), 'invalidQuery');
  assert.equal(await codeOf(N.history.query({ from: range.to, to: range.from, groupBy: 'day' })), 'invalidQuery');
  assert.equal(await codeOf(N.history.query({ ...range, groupBy: 'artist', limit: 0 })), 'invalidQuery');
  assert.equal(await codeOf(N.history.query({ from: '2026-01-01', to: range.to, groupBy: 'day' })), 'invalidQuery',
               'a bare date is not an instant');
});

test('history.info says when recording began, and nothing exists before it', async () => {
  const { N } = mock({ historyDays: 10 });
  const { since, plays } = await N.history.info();
  assert.ok(!Number.isNaN(Date.parse(since)));
  assert.ok(Number.isInteger(plays));
  const { rows } = await N.history.query({ from: '2000-01-01T00:00:00Z', to: since, groupBy: 'none' });
  assert.deepEqual(rows.map((r) => [r.plays, r.seconds]), [[0, 0]]);
});

test('history.recent is newest first and pages with before', async () => {
  const { N } = mock();
  const page1 = (await N.history.recent({ limit: 5 })).plays;
  assert.equal(page1.length, 5);
  for (let i = 1; i < page1.length; i++) assert.ok(page1[i - 1].startedAt >= page1[i].startedAt);
  const page2 = (await N.history.recent({ limit: 5, before: page1[4].startedAt })).plays;
  assert.ok(page2.every((p) => p.startedAt < page1[4].startedAt));
  for (const key of ['startedAt', 'title', 'artist', 'album', 'seconds', 'duration', 'player', 'listened', 'skipped']) {
    assert.ok(key in page1[0], key);
  }
});

test('an unavailable history rejects every call with unavailable', async () => {
  const { N, ctl } = mock();
  ctl.setHistoryUnavailable(true);
  assert.equal(await codeOf(N.history.info()), 'unavailable');
  assert.equal(await codeOf(N.history.recent({})), 'unavailable');
  assert.equal(await codeOf(N.history.query({ from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', groupBy: 'day' })), 'unavailable');
});

test('state carries firstWeekday, and the controller can change it', () => {
  const { N, ctl } = mock({ firstWeekday: 7 });
  assert.equal(N.state.firstWeekday, 7);
  let seen = null;
  N.on('statechange', (s) => { seen = s.firstWeekday; });
  ctl.setFirstWeekday(1);
  assert.equal(seen, 1);
});

test('without an explicit value firstWeekday is still an ISO weekday', () => {
  const { N } = mock();
  assert.ok(N.state.firstWeekday >= 1 && N.state.firstWeekday <= 7);
});

test('pointer events are coalesced and de-duplicated the way the host does it', async () => {
  const { N, ctl } = mock();
  const events = [];
  N.on('pointermove', (p) => events.push(['move', p.x, p.y]));
  N.on('pointerleave', () => events.push(['leave']));
  ctl.pointerMove(10.7, 20.2);
  ctl.pointerMove(10.2, 20.9);           // same CSS pixel: nothing new
  ctl.pointerMove(11, 20);               // inside the interval: parked
  assert.deepEqual(events, [['move', 10, 20]]);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(events, [['move', 10, 20], ['move', 11, 20]]);
  ctl.pointerLeave();
  ctl.pointerLeave();
  assert.deepEqual(events.slice(2), [['leave']]);
});

test('a parked move that returned to the last sent pixel is not flushed', async () => {
  const { N, ctl } = mock();
  const events = [];
  N.on('pointermove', (p) => events.push([p.x, p.y]));
  ctl.pointerMove(5, 5);
  ctl.pointerMove(6, 5);                 // parked
  ctl.pointerMove(5, 5);                 // back where the page was told: nothing is news
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(events, [[5, 5]]);
});

test('pointerleave is sent at once and drops a parked move', async () => {
  const { N, ctl } = mock();
  const events = [];
  N.on('pointermove', (p) => events.push(['move', p.x, p.y]));
  N.on('pointerleave', () => events.push(['leave']));
  ctl.pointerLeave();                    // never over the page: nothing to leave
  ctl.pointerMove(1, 1);
  ctl.pointerMove(2, 2);                 // parked
  ctl.pointerLeave();
  assert.deepEqual(events, [['move', 1, 1], ['leave']]);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(events, [['move', 1, 1], ['leave']]);
});

test('quitPlayer() pushes the state the host sends with no player running', () => {
  const { N, ctl } = mock();
  const seen = [];
  N.on('statechange', (s) => seen.push(s));
  ctl.quitPlayer();
  assert.equal(seen.length, 1);
  assert.equal(N.state.track, undefined, 'the host omits track with no player');
  assert.equal(N.state.playerType, undefined, 'and omits playerType');
  assert.equal(N.state.playerState, 0, 'unknown, not stopped');
  assert.equal(N.track, null);
  assert.equal(N.playerType, null, 'the bridge getter reads an absent playerType as null');
  assert.equal(N.getArtworkDataURL(), null);
  assert.ok(!N.isStopped && !N.isPlaying && !N.isPaused);
});

test('with no player running, transport does nothing: there is nothing to send it to', () => {
  const { N, ctl } = mock();
  ctl.quitPlayer();
  N.playPause(); N.next(); N.previous(); ctl.nextTrack();
  assert.equal(N.state.playerState, 0);
  assert.equal(N.track, null);
});

test('activatePlayer() with no player launches one, paused on its last track', () => {
  const launches = [];
  const { N, ctl } = mock({ onActivatePlayer: (launched) => launches.push(launched) });
  ctl.quitPlayer();
  N.activatePlayer();
  assert.deepEqual(launches, [true]);
  assert.equal(ctl.activations, 1);
  assert.equal(N.state.playerType, 'appleMusic');
  assert.equal(N.state.playerState, 3, 'launched players come up paused');
  assert.equal(typeof N.track.title, 'string');
});

test('activatePlayer() with a player running only brings it forward', () => {
  const launches = [];
  const { N, ctl } = mock({ onActivatePlayer: (launched) => launches.push(launched) });
  let pushes = 0;
  N.on('statechange', () => pushes++);
  N.activatePlayer();
  assert.deepEqual(launches, [false]);
  assert.equal(ctl.activations, 1);
  assert.equal(pushes, 0, 'nothing about the playback changed');
  assert.equal(N.state.playerState, 2);
});

test('stop() is the end of the queue: the player runs on and keeps its last track', () => {
  const { N, ctl } = mock();
  const title = N.track.title;
  ctl.stop();
  assert.equal(N.state.playerState, 1);
  assert.equal(N.state.playerType, 'appleMusic');
  assert.equal(N.track.title, title);
  assert.ok(N.isStopped);
  ctl.stop({ clearTrack: true });
  assert.equal(N.track, null);
  assert.equal(N.state.playerState, 1);
  assert.equal(N.playerType, 'appleMusic');
  // Playing again brings a track back.
  ctl.togglePlay();
  assert.equal(typeof N.state.track.title, 'string');
  assert.ok(N.isPlaying);
});

test('opts.playerState 0 and 1 start with no player, and stopped', () => {
  assert.equal(mock({ playerState: 0 }).N.state.playerState, 0);
  assert.equal(mock({ playerState: 0 }).N.track, null);
  const stopped = mock({ playerState: 1 }).N;
  assert.equal(stopped.state.playerState, 1);
  assert.equal(typeof stopped.track.title, 'string');
});

test('offersShowSetting: only a manifest that handles nothing playing gets the picker', () => {
  const { offersShowSetting } = require('./mock-neptunes.js');
  assert.equal(offersShowSetting(null), false);
  assert.equal(offersShowSetting({}), false);
  assert.equal(offersShowSetting({ alwaysVisible: false }), false);
  assert.equal(offersShowSetting({ alwaysVisible: true }), true);
  assert.equal(offersShowSetting({ supportsNoPlayback: true }), true);
});

test('effectiveAlwaysVisible follows the contract: no picker, override, manifest default', () => {
  const { effectiveAlwaysVisible } = require('./mock-neptunes.js');
  // No picker: an override is ignored.
  assert.equal(effectiveAlwaysVisible({}, 'always'), false);
  assert.equal(effectiveAlwaysVisible(null, 'always'), false);
  // An override wins over the manifest default.
  assert.equal(effectiveAlwaysVisible({ alwaysVisible: true }, 'playback'), false);
  assert.equal(effectiveAlwaysVisible({ supportsNoPlayback: true }, 'always'), true);
  // No override: the manifest default.
  assert.equal(effectiveAlwaysVisible({ alwaysVisible: true }), true);
  assert.equal(effectiveAlwaysVisible({ supportsNoPlayback: true }), false);
});

test('isWidgetVisible mirrors the host: playback, or an effective Show setting of Always', () => {
  const { isWidgetVisible } = require('./mock-neptunes.js');
  const { N, ctl } = mock();
  assert.equal(isWidgetVisible({}, N.state), true);
  ctl.togglePlay();                       // paused is still playback
  assert.equal(isWidgetVisible({}, N.state), true);
  ctl.stop();                             // end of queue, last track kept: not playback
  assert.equal(isWidgetVisible({}, N.state), false);
  ctl.quitPlayer();
  assert.equal(isWidgetVisible({}, N.state), false);
  assert.equal(isWidgetVisible(null, N.state), false);
  assert.equal(isWidgetVisible({ alwaysVisible: false }, N.state), false);
  assert.equal(isWidgetVisible({ alwaysVisible: true }, N.state), true);
  assert.equal(isWidgetVisible({ alwaysVisible: true }, N.state, 'playback'), false);
  assert.equal(isWidgetVisible({ supportsNoPlayback: true }, N.state), false);
  assert.equal(isWidgetVisible({ supportsNoPlayback: true }, N.state, 'always'), true);
  assert.equal(isWidgetVisible({}, N.state, 'always'), false, 'no picker, no Always');
});

// Motion artwork: the host gives `track.motionArtworkURL` (a URL for <video src>) only to a widget
// declaring "supportsMotionArtwork" with the "artwork" permission, while the user has not turned
// "Animated cover" off, and only with a track. The mock serves a small generated sample loop.

test('a widget that declares motion artwork gets the sample loop on the track', () => {
  const { N } = mock({ supportsMotionArtwork: true, permissions: ['artwork'] });
  assert.equal(typeof N.track.motionArtworkURL, 'string');
  assert.match(N.track.motionArtworkURL, /motion-artwork-sample\.mp4$/);
  assert.equal(N.getMotionArtworkURL(), N.track.motionArtworkURL);
});

test('no motion artwork without the manifest key, without the artwork permission, or turned off', () => {
  for (const opts of [{}, { supportsMotionArtwork: false }, { supportsMotionArtwork: true, permissions: ['playbackControl'] },
                      { supportsMotionArtwork: true, motionArtwork: false }]) {
    const { N } = mock(opts);
    assert.equal(N.track.motionArtworkURL, undefined, JSON.stringify(opts));
    assert.equal(N.getMotionArtworkURL(), null, JSON.stringify(opts));
  }
  // Not gated on permissions when the mock was given none, as for the other APIs.
  assert.equal(typeof mock({ supportsMotionArtwork: true }).N.getMotionArtworkURL(), 'string');
});

test('flipping Animated cover pushes a statechange with, then without, the URL', () => {
  const { N, ctl } = mock({ supportsMotionArtwork: true, motionArtwork: false });
  const seen = [];
  N.on('statechange', (s) => seen.push(s.track && s.track.motionArtworkURL));
  ctl.setMotionArtwork(true);
  ctl.setMotionArtwork(false);
  assert.equal(seen.length, 2);
  assert.match(seen[0], /motion-artwork-sample\.mp4$/);
  assert.equal(seen[1], undefined);
  assert.equal(N.getMotionArtworkURL(), null);
});

test('no track, no motion artwork', () => {
  const { N, ctl } = mock({ supportsMotionArtwork: true });
  ctl.stop({ clearTrack: true });
  assert.equal(N.getMotionArtworkURL(), null);
  ctl.quitPlayer();
  assert.equal(N.getMotionArtworkURL(), null);
  N.activatePlayer();
  assert.equal(typeof N.getMotionArtworkURL(), 'string', 'a track again, the loop again');
});

test('opts.motionArtworkURL replaces the sample loop', () => {
  const { N } = mock({ supportsMotionArtwork: true, motionArtworkURL: 'loop.mp4' });
  assert.equal(N.getMotionArtworkURL(), 'loop.mp4');
});

test('offersMotionArtwork: the app offers Animated cover only with the key and the artwork permission', () => {
  const { offersMotionArtwork } = require('./mock-neptunes.js');
  assert.equal(offersMotionArtwork(null), false);
  assert.equal(offersMotionArtwork({ supportsMotionArtwork: true }), false);
  assert.equal(offersMotionArtwork({ supportsMotionArtwork: true, permissions: ['lastFm'] }), false);
  assert.equal(offersMotionArtwork({ supportsMotionArtwork: false, permissions: ['artwork'] }), false);
  assert.equal(offersMotionArtwork({ supportsMotionArtwork: true, permissions: ['artwork'] }), true);
});

test('the sample loop is a small MP4 — it is published with the widgets', async () => {
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(new URL('./motion-artwork-sample.mp4', import.meta.url));
  assert.ok(bytes.length > 0 && bytes.length < 500 * 1024, `${bytes.length} bytes`);
  assert.equal(bytes.toString('latin1', 4, 8), 'ftyp', 'not an MP4');
});
