import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Charts = require('../Charts.nepget/script.js');

// `accentKey` is the cache identity for "which accent is on screen right now". Everything
// that should repaint the accent has to change it, and everything that should not must
// leave it alone: the widget re-applies exactly when the key moves.
//
// It exists because the cache used to be the artwork URL by itself, and null did double
// duty as both "no artwork is playing" and "the cache was just cleared".

test('switching a fixed colour back to album art repaints, even with nothing playing', () => {
    // The reported bug. Pause the player (getArtworkDataURL() is null), set Accent to
    // "Fixed color", then set it back to "From album art". Under a URL-only cache both
    // states keyed on null, so the switch read as "nothing changed" and the fixed colour
    // stayed on the widget until artwork happened to appear.
    assert.notEqual(Charts.accentKey('album', null, '#FF375F', true),
                    Charts.accentKey('fixed', null, '#FF375F', true));
});

test('a repeat of the same state does not repaint', () => {
    // statechange fires on every position tick, play/pause, volume and mute. Re-deriving
    // the palette there costs a legibleAccent search plus four custom-property writes on
    // the card, several times a minute, for a colour that did not move.
    assert.equal(Charts.accentKey('fixed', null, '#FF375F', true),
                 Charts.accentKey('fixed', null, '#FF375F', true));
    assert.equal(Charts.accentKey('album', 'data:image/png;base64,AAA', '#FF375F', true),
                 Charts.accentKey('album', 'data:image/png;base64,AAA', '#FF375F', true));
});

test('a theme flip repaints in both modes', () => {
    // --accent-ink is picked against the panel, so the same colour on a light panel is a
    // different ink. Nothing else in the key changes when the system flips.
    for (const source of ['album', 'fixed']) {
        assert.notEqual(Charts.accentKey(source, 'data:x', '#FF375F', true),
                        Charts.accentKey(source, 'data:x', '#FF375F', false));
    }
});

test('a new colour or a new cover repaints', () => {
    assert.notEqual(Charts.accentKey('fixed', null, '#FF375F', true),
                    Charts.accentKey('fixed', null, '#30D158', true));
    assert.notEqual(Charts.accentKey('album', 'data:cover-a', '#FF375F', true),
                    Charts.accentKey('album', 'data:cover-b', '#FF375F', true));
});

test('losing the cover repaints, so the accent falls back to neutral', () => {
    // Playing -> stopped. The album branch resolves NEUTRAL for a null URL, but only if
    // it is reached: the key has to move for that to happen.
    assert.notEqual(Charts.accentKey('album', 'data:cover-a', '#FF375F', true),
                    Charts.accentKey('album', null, '#FF375F', true));
});

// ---- Last.fm passthrough (NepTunes 4.1+) ----------------------------------------------
// The shape the adapters must reproduce is pinned against NepTunesKit's own decoders by
// LastFmWidgetAdapterParityTests; these cover the edges and the feature detection.

const IMAGES = [
  { size: 'small', '#text': 'https://lastfm.freetls.fastly.net/i/u/34s/a.png' },
  { size: 'extralarge', '#text': 'https://lastfm.freetls.fastly.net/i/u/300x300/a.png' },
];
const rawTopAlbums = {
  topalbums: {
    album: [
      { artist: { name: 'Robyn', url: 'https://www.last.fm/music/Robyn', mbid: '' }, image: IMAGES, mbid: '',
        url: 'https://www.last.fm/music/Robyn/Honey', playcount: '42', '@attr': { rank: '1' }, name: 'Honey' },
      { artist: { name: 'Low', mbid: '' }, image: [{ size: 'extralarge', '#text': '' }], playcount: '7', name: 'HEY WHAT' },
    ],
    '@attr': { page: '1', totalPages: '15' },
  },
};

test('the passthrough body is adapted to what the old getTopAlbums returned', () => {
  assert.deepStrictEqual(Charts.adaptTopAlbums(rawTopAlbums), [
    { name: 'Honey', artist: 'Robyn', url: 'https://www.last.fm/music/Robyn/Honey', playcount: 42,
      imageURL: 'https://lastfm.freetls.fastly.net/i/u/300x300/a.png' },
    { name: 'HEY WHAT', artist: 'Low', playcount: 7 },
  ]);
});

test('a chart of one arrives as an object, not an array, and still adapts', () => {
  const one = { topartists: { artist: { name: 'Robyn', playcount: '3', image: [] } } };
  assert.deepStrictEqual(Charts.adaptTopArtists(one), [{ name: 'Robyn', playcount: 3 }]);
  assert.deepStrictEqual(Charts.adaptTopTracks({}), []);
});

test('with the passthrough, the chart is one raw call with the period and row count', async () => {
  const calls = [];
  const lf = {
    call: async (method, params) => { calls.push([method, params]); return rawTopAlbums; },
    getTopAlbums: () => assert.fail('the narrow method was used'),
  };
  const items = await Charts.fetchChart(lf, 'albums', '1month', 8);
  assert.deepStrictEqual(calls, [['user.getTopAlbums', { period: '1month', limit: '8' }]]);
  assert.equal(items[0].playcount, 42);
  await Charts.fetchChart(lf, 'artists', '7day', 5);
  await Charts.fetchChart(lf, 'tracks', 'overall', 10);
  assert.deepStrictEqual(calls.slice(1).map(([m]) => m), ['user.getTopArtists', 'user.getTopTracks']);
});

test('an app without the passthrough gets the narrow methods, exactly as before', async () => {
  const lf = { getTopTracks: async (period, limit) => [{ name: 't', period, limit }] };
  assert.deepStrictEqual(await Charts.fetchChart(lf, 'tracks', '3month', 5), [{ name: 't', period: '3month', limit: 5 }]);
});

test('thumbnails come only through the app, never as a remote <img>', () => {
  const item = { imageURL: 'https://lastfm.freetls.fastly.net/i/u/300x300/a.png' };
  const withImages = { image: () => {} };
  assert.equal(Charts.wantsThumbnail(item, true, withImages), true);
  assert.equal(Charts.wantsThumbnail(item, false, withImages), false);
  assert.equal(Charts.wantsThumbnail(item, true, {}), false);   // older app: no thumbnails, as today
  assert.equal(Charts.wantsThumbnail({}, true, withImages), false);
  // Last.fm's generic star, which it serves for every artist since it stopped hosting artist photos.
  assert.equal(Charts.wantsThumbnail({ imageURL: 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png' }, true, withImages), false);
});

test('a thumbnail is fetched once, a failure is not remembered, and only data URLs are drawn', async () => {
  let asked = 0;
  const lf = { image: async (url) => { asked++; return url.endsWith('bad.png') ? 'https://evil/x.png' : 'data:image/png;base64,AAA'; } };
  assert.equal(await Charts.loadThumbnail(lf, 'https://lastfm.freetls.fastly.net/i/u/a.png'), 'data:image/png;base64,AAA');
  await Charts.loadThumbnail(lf, 'https://lastfm.freetls.fastly.net/i/u/a.png');
  assert.equal(asked, 1);
  assert.equal(await Charts.loadThumbnail(lf, 'https://lastfm.freetls.fastly.net/i/u/bad.png'), null);
  await Charts.loadThumbnail(lf, 'https://lastfm.freetls.fastly.net/i/u/bad.png');
  assert.equal(asked, 3);
});

// ---- A failed refresh --------------------------------------------------------------------
// Only a signed-out account replaces the chart with the sign-in message; a rate limit, timeout
// or network blip leaves the chart on screen for the next refresh. The narrow methods reject
// without a code, so an older app keeps today's behaviour.

test('a coded failure other than signed-out keeps the chart on screen', () => {
  for (const code of ['rateLimited', 'timeout', 'network', 'lastFm:8', 'tooLarge']) {
    const error = Object.assign(new Error(code), { code });
    assert.equal(Charts.keepsChartOnFailure(error, true), true, code);
  }
});

test('signing out, an uncoded failure, or nothing on screen shows the sign-in message', () => {
  const coded = (code) => Object.assign(new Error(code), { code });
  assert.equal(Charts.keepsChartOnFailure(coded('notSignedIn'), true), false);
  assert.equal(Charts.keepsChartOnFailure(new Error('older app'), true), false);
  assert.equal(Charts.keepsChartOnFailure(undefined, true), false);
  assert.equal(Charts.keepsChartOnFailure(coded('rateLimited'), false), false);   // first load: nothing to keep
});
