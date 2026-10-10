const test = require('node:test');
const assert = require('node:assert/strict');
const { CueSheets } = require('../host/cue-sheets');

const mime = (name, given) => given || (/\.mp4$/.test(name) ? 'video/mp4' : 'image/jpeg');
// 한국 시간으로 적은 시각을 UTC 밀리초로
const at = text => Date.parse(text + '+09:00');
const sites = [{ id: 'lobby', monitors: 2 }, { id: 'dining', monitors: 1 }];

test('the old schedule becomes one default sheet per place and plays as before', () => {
  const cue = new CueSheets({ version: 5, entries: [
    { siteId: 'lobby', file1: 'a.jpg', file2: 'b.jpg', duration: 10, videoDuration: 'original', audio: 'none', transition: 'fade', enabled: true },
    { siteId: 'lobby', file1: 'clip.mp4', file1Mime: 'video/mp4', duration: 10, videoDuration: 'original', enabled: true },
    { siteId: 'lobby', file1: 'off.jpg', duration: 10, enabled: false },
    { siteId: 'dining', file1: 'menu.jpg', duration: 20, enabled: true } ] }, sites);
  assert.equal(cue.migrated, true);
  assert.deepEqual(cue.sheets.map(s => [s.siteId, s.name, s.type, s.rows.length]), [['lobby', '기본', 'sync', 3], ['dining', '기본', 'sync', 1]]);
  const sent = cue.payload('lobby', mime);
  assert.equal(sent.mode, 'sync');
  assert.deepEqual(sent.entries.map(e => [e.filename, e.filename2, e.duration, e.videoDuration]), [['a.jpg', 'b.jpg', 10, 'custom'], ['clip.mp4', '', 0, 'original']]);
  // An older server reading the file still finds the default sheets' rows.
  assert.deepEqual(cue.toJSON().entries.map(e => e.siteId + ':' + e.file1), ['lobby:a.jpg', 'lobby:clip.mp4', 'lobby:off.jpg', 'dining:menu.jpg']);
  // Reading the new file back does not migrate again.
  const again = new CueSheets(JSON.parse(JSON.stringify(cue.toJSON())), sites);
  assert.equal(again.migrated, false); assert.equal(again.sheets.length, 2);
});

test('automatic switching: pinned, then a dated rule, then weekly rules in list order, then the default', () => {
  const cue = new CueSheets({ sheets: [], siteState: {} }, sites);
  const weekday = cue.create('lobby', { name: '평일용', type: 'sync', rows: [{ file1: 'a.jpg', duration: 10 }] });
  const sunday = cue.create('lobby', { name: '주일용', type: 'separate', rules: [{ kind: 'week', days: [0], from: '07:00', to: '14:00' }], a: [{ file: 'a.jpg' }], b: [{ file: 'b.mp4' }] });
  const xmas = cue.create('lobby', { name: '성탄', type: 'separate', rules: [{ kind: 'date', date: '2026-12-25', from: '', to: '' }], a: [{ file: 'x.jpg' }] });
  assert.equal(cue.state('lobby').defaultId, weekday.id, 'the first sheet of a place becomes its default');
  assert.equal(cue.active('lobby', at('2026-10-10T10:20')).name, '평일용');            // Saturday
  assert.equal(cue.active('lobby', at('2026-10-11T06:59')).name, '평일용');            // Sunday before the rule
  assert.equal(cue.active('lobby', at('2026-10-11T07:00')).name, '주일용');
  assert.equal(cue.active('lobby', at('2026-10-11T13:59')).name, '주일용');
  assert.equal(cue.active('lobby', at('2026-10-11T14:00')).name, '평일용');
  assert.equal(cue.active('lobby', at('2026-12-25T09:00')).name, '성탄', 'a dated rule wins over weekly rules (25 Dec 2026 is a Friday)');
  cue.update(xmas.id, { name: '성탄', rules: [{ kind: 'date', date: '2026-10-11', from: '09:00', to: '10:00' }], a: [{ file: 'x.jpg' }] });
  assert.equal(cue.active('lobby', at('2026-10-11T09:30')).name, '성탄', 'a dated rule wins inside a weekly rule');
  assert.equal(cue.active('lobby', at('2026-10-11T10:30')).name, '주일용');

  const next = cue.next('lobby', at('2026-10-10T10:20'));
  assert.deepEqual([next.name, next.at], ['주일용', at('2026-10-11T07:00')]);

  cue.setState('lobby', { pinnedId: weekday.id });
  assert.equal(cue.active('lobby', at('2026-10-11T08:00')).name, '평일용', 'a pinned sheet ignores the timetable');
  cue.setState('lobby', { pinnedId: null });
  assert.equal(cue.active('lobby', at('2026-10-11T08:00')).name, '주일용');

  assert.throws(() => cue.remove(weekday.id), /기본 큐시트는 지울 수 없습니다/);
  cue.setState('lobby', { defaultId: sunday.id }); cue.remove(weekday.id);
  assert.equal(cue.active('lobby', at('2026-10-10T10:20')).name, '주일용');
  assert.equal(cue.active('dining', Date.now()), null, 'a place without sheets has nothing to play');
});

test('rules are validated and a failed save changes nothing', () => {
  const cue = new CueSheets({ sheets: [], siteState: {} }, sites);
  const sheet = cue.create('lobby', { name: ' 주일용 ', type: 'sync', rows: [{ file1: 'a.jpg' }] });
  assert.equal(sheet.name, '주일용');
  for (const rules of [[{ kind: 'week', days: [], from: '07:00', to: '09:00' }], [{ kind: 'week', days: [0], from: '09:00', to: '09:00' }],
    [{ kind: 'week', days: [0], from: '9', to: '10:00' }], [{ kind: 'date', date: '2026-13-40' }], [{ kind: 'date', date: '2026-12-25', from: '10:00', to: '' }]]) {
    assert.throws(() => cue.update(sheet.id, { name: '바뀜', rules, rows: [] }), /적용/);
  }
  assert.equal(sheet.name, '주일용'); assert.equal(sheet.rows.length, 1);
  assert.throws(() => cue.create('lobby', { name: '  ' }), /이름/);
});

test('what the player receives: separate lists, sync rows that wait for a video on B, hidden items and versions', () => {
  const cue = new CueSheets({ sheets: [], siteState: {} }, sites);
  const sync = cue.create('lobby', { name: '평일용', type: 'sync', rows: [
    { file1: 'photo.jpg', file2: 'clip.mp4', file2Mime: 'video/mp4', duration: 0 },                 // wait for B's video
    { file1: 'photo.jpg', file2: 'clip.mp4', file2Mime: 'video/mp4', duration: 10 },                // cut or loop at 10 s
    { file1: 'photo.jpg', file2: 'other.jpg', duration: 0 },                                       // photos only: 10 s
    { file1: 'clip.mp4', file1Mime: 'video/mp4', duration: 30, videoDuration: 'custom' },
    { file2: 'right-only.jpg', duration: 5 },
    { file1: 'later.jpg', duration: 5, validFrom: '2026-11-01' }, { file1: 'ended.jpg', duration: 5, validTo: '2026-10-01' } ] });
  const now = at('2026-10-10T10:00');
  const first = cue.payload('lobby', mime, now);
  assert.deepEqual(first.entries.map(e => [e.filename, e.filename2, e.duration]),
    [['photo.jpg', 'clip.mp4', 0], ['photo.jpg', 'clip.mp4', 10], ['photo.jpg', 'other.jpg', 10], ['clip.mp4', '', 30], ['right-only.jpg', '', 5]]);
  assert.equal(cue.payload('lobby', mime, now + 60000).version, first.version, 'the same content keeps its version, so a reconnecting player does not restart');
  assert.equal(cue.payload('lobby', mime, at('2026-11-01T00:00')).entries.length, 6, 'an item appears on its start date');
  assert.notEqual(cue.payload('lobby', mime, at('2026-11-01T00:00')).version, first.version);

  const separate = cue.create('lobby', { name: '주일용', type: 'separate',
    a: [{ file: 'a1.jpg', duration: 0 }, { file: 'a2.mp4', duration: 0, sound: true }, { file: 'off.jpg', enabled: false }],
    b: [{ file: 'b1.mp4', duration: 45 }, { file: 'b2.jpg', duration: 15, sound: true }] });
  cue.setState('lobby', { pinnedId: separate.id });
  const sent = cue.payload('lobby', mime, now);
  assert.equal(sent.mode, 'separate'); assert.equal(sent.name, '주일용'); assert.notEqual(sent.version, first.version);
  assert.deepEqual(sent.entries.map(e => [e.filename, e.duration, e.sound, e.url2]), [['a1.jpg', 10, 'none', ''], ['a2.mp4', 0, 'left', '']]);
  assert.deepEqual(sent.entriesB.map(e => [e.filename, e.duration, e.sound]), [['b1.mp4', 45, 'none'], ['b2.jpg', 15, 'none']], 'a photo never has sound');
  assert.equal(cue.payload('dining', mime, now).entries.length, 0);
});
