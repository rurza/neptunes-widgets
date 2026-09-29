import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Scrobbles = require('../Scrobbles.nepget/script.js');

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
    assert.notEqual(Scrobbles.accentKey('album', null, '#FF375F', true),
                    Scrobbles.accentKey('fixed', null, '#FF375F', true));
});

test('a repeat of the same state does not repaint', () => {
    // statechange fires on every position tick, play/pause, volume and mute. Re-deriving
    // the palette there costs a legibleAccent search plus four custom-property writes on
    // the card, several times a minute, for a colour that did not move.
    assert.equal(Scrobbles.accentKey('fixed', null, '#FF375F', true),
                 Scrobbles.accentKey('fixed', null, '#FF375F', true));
    assert.equal(Scrobbles.accentKey('album', 'data:image/png;base64,AAA', '#FF375F', true),
                 Scrobbles.accentKey('album', 'data:image/png;base64,AAA', '#FF375F', true));
});

test('a theme flip repaints in both modes', () => {
    // --accent-ink is picked against the panel, so the same colour on a light panel is a
    // different ink. Nothing else in the key changes when the system flips.
    for (const source of ['album', 'fixed']) {
        assert.notEqual(Scrobbles.accentKey(source, 'data:x', '#FF375F', true),
                        Scrobbles.accentKey(source, 'data:x', '#FF375F', false));
    }
});

test('a new colour or a new cover repaints', () => {
    assert.notEqual(Scrobbles.accentKey('fixed', null, '#FF375F', true),
                    Scrobbles.accentKey('fixed', null, '#30D158', true));
    assert.notEqual(Scrobbles.accentKey('album', 'data:cover-a', '#FF375F', true),
                    Scrobbles.accentKey('album', 'data:cover-b', '#FF375F', true));
});

test('losing the cover repaints, so the accent falls back to neutral', () => {
    // Playing -> stopped. The album branch resolves NEUTRAL for a null URL, but only if
    // it is reached: the key has to move for that to happen.
    assert.notEqual(Scrobbles.accentKey('album', 'data:cover-a', '#FF375F', true),
                    Scrobbles.accentKey('album', null, '#FF375F', true));
});

// ---- Last.fm passthrough (NepTunes 4.1+) ----------------------------------------------
// The shape the adapters must reproduce is pinned against NepTunesKit's own decoders by
// LastFmWidgetAdapterParityTests; these cover the edges and the feature detection.

const nowPlaying = { artist: { name: 'Robyn', mbid: '' }, name: 'Honey', image: [], album: { mbid: '', '#text': 'Honey' },
  url: 'https://www.last.fm/music/Robyn/_/Honey', '@attr': { nowplaying: 'true' }, loved: '0' };
const played = { artist: { '#text': 'Low', mbid: '' }, date: { uts: '1790000000', '#text': '' }, name: 'Days Like These',
  image: [{ size: 'extralarge', '#text': 'https://lastfm.freetls.fastly.net/i/u/300x300/c.png' }], album: { mbid: '', '#text': '' }, loved: '1' };

test('recent tracks adapt to what the old getRecentTracks returned', () => {
  assert.deepStrictEqual(Scrobbles.adaptRecentTracks({ recenttracks: { track: [nowPlaying, played] } }), [
    { name: 'Honey', artist: 'Robyn', album: 'Honey', url: 'https://www.last.fm/music/Robyn/_/Honey', isNowPlaying: true, isLoved: false },
    { name: 'Days Like These', artist: 'Low', album: '', imageURL: 'https://lastfm.freetls.fastly.net/i/u/300x300/c.png',
      date: '2026-09-21T14:13:20Z', isNowPlaying: false, isLoved: true },
  ]);
});

test('user info keeps the lifetime playcount and drops empty fields', () => {
  const info = Scrobbles.adaptUserInfo({ user: { name: 'rj', realname: '', playcount: '123456', registered: { unixtime: '1037793040' } } });
  assert.deepStrictEqual(info, { name: 'rj', playcount: 123456, registeredDate: '2002-11-20T11:50:40Z' });
  assert.equal(Scrobbles.adaptUserInfo({}).playcount, 0);
});

test('with the passthrough, the counter and the feed are two raw calls, extended', async () => {
  const calls = [];
  const lfm = {
    call: async (method, params) => { calls.push([method, params]); return method === 'user.getInfo' ? { user: { playcount: '5' } } : { recenttracks: { track: [played] } }; },
    getUserInfo: () => assert.fail('the narrow method was used'),
  };
  const [info, tracks] = await Scrobbles.fetchStats(lfm, 8);
  assert.deepStrictEqual(calls, [['user.getInfo', undefined], ['user.getRecentTracks', { limit: '8', extended: '1' }]]);
  assert.equal(info.playcount, 5);
  assert.equal(tracks[0].isLoved, true);
});

test('an app without the passthrough gets the narrow methods, exactly as before', async () => {
  const lfm = { getUserInfo: async () => ({ playcount: 1 }), getRecentTracks: async (n) => [{ name: 'x', n }] };
  assert.deepStrictEqual(await Scrobbles.fetchStats(lfm, 12), [{ playcount: 1 }, [{ name: 'x', n: 12 }]]);
});

// ---- A failed refresh --------------------------------------------------------------------
// The passthrough says why a load failed. Only a signed-out account replaces the feed with the
// sign-in message; a rate limit, timeout or network blip keeps what is on screen until the next
// refresh. The narrow methods reject without a code, so an older app keeps today's behaviour.

test('a coded failure other than signed-out keeps the feed on screen', () => {
  for (const code of ['rateLimited', 'timeout', 'network', 'lastFm:8', 'tooLarge']) {
    const error = Object.assign(new Error(code), { code });
    assert.equal(Scrobbles.keepsFeedOnFailure(error, true), true, code);
  }
});

test('signing out, an uncoded failure, or nothing on screen shows the sign-in message', () => {
  const coded = (code) => Object.assign(new Error(code), { code });
  assert.equal(Scrobbles.keepsFeedOnFailure(coded('notSignedIn'), true), false);
  assert.equal(Scrobbles.keepsFeedOnFailure(new Error('older app'), true), false);
  assert.equal(Scrobbles.keepsFeedOnFailure(undefined, true), false);
  assert.equal(Scrobbles.keepsFeedOnFailure(coded('rateLimited'), false), false);   // first load: nothing to keep
});
