const test = require('node:test');
const assert = require('node:assert/strict');
const { PhotoArchive } = require('../host/photo-archive');
const { targetInput } = require('../host/drive-folders');
const { fixture } = require('./helpers/camera-fixture');

test('new year/event folders are lazy, serialized, reused, and survive timeout/restart', async t => {
  const { root, archive, drive, remote, calls } = fixture(t);
  await archive.initialize();
  const input = { year: '2027', eventName: '  신년   예배 ', eventDate: '2027-01-03' };
  assert.equal(calls.creates.length, 0);
  const [first, second] = await Promise.all([archive.serialize(() => archive.folders.resolve(input)), archive.serialize(() => archive.folders.resolve(input))]);
  assert.equal(first.eventId, second.eventId);
  assert.deepEqual(calls.creates.map(c => c.name), ['2027', '20270103 신년 예배']);
  assert.deepEqual(remote.get(first.eventId).parents, [first.yearId]);
  const create = drive.files.create; let once = true;
  drive.files.create = async p => { const result = await create(p); if (once) { once = false; throw Object.assign(new Error('ambiguous'), { code: 'ETIMEDOUT' }); } return result; };
  await assert.rejects(archive.folders.resolve({ year: '2027', eventName: '새 행사' }), /ambiguous/);
  const restarted = new PhotoArchive({ dataDir: root, folderId: 'root', drive, authMode: 'oauth' });
  await restarted.initialize();
  await restarted.serialize(() => restarted.folders.resolve({ year: '2027', eventName: '새 행사' }));
  assert.equal([...remote.values()].filter(f => f.name === '새 행사').length, 1);
});

test('duplicate names require explicit folder IDs and selected folders cannot escape root/year', async t => {
  const { archive, folder, remote } = fixture(t);
  folder('y1', '2026', 'root'); folder('y2', '2026', 'root');
  folder('e1', '부활절', 'y1'); folder('e2', '부활절', 'y1'); folder('outside', '행사', 'elsewhere');
  await assert.rejects(archive.folders.resolve({ year: '2026', eventName: '부활절' }), /연도 폴더가 여러/);
  await assert.rejects(archive.folders.resolve({ year: '2026', yearId: 'y1', eventName: '부활절' }), /같은 이름/);
  const selected = await archive.folders.resolve({ year: '2026', yearId: 'y1', eventId: 'e2' });
  assert.equal(selected.eventId, 'e2');
  await assert.rejects(archive.folders.resolve({ year: '2026', yearId: 'y1', eventId: 'outside' }), /이동·삭제/);
  remote.get('e2').parents = ['elsewhere'];
  await assert.rejects(archive.folders.validateRecord({ rootId: 'root', folderId: 'e2', target: selected }), /이동·삭제/);
});

test('folder query failure never means missing; invalid dates and traversal names are rejected', async t => {
  const { archive, drive, calls } = fixture(t);
  drive.files.list = async () => { throw new Error('network'); };
  await assert.rejects(archive.folders.resolve({ year: '2027', eventName: '행사' }), /network/);
  assert.equal(calls.creates.length, 0);
  for (const value of [{ year: '2026', eventName: '../행사' }, { year: '2026', eventName: '..' }, { year: '2026', eventName: '행사', eventDate: '2026-99-99' }, { year: '2026', eventName: '행사', eventDate: '2026-02-30' }, { year: '2026', eventName: '행사', eventDate: '2025-01-01' }]) assert.throws(() => targetInput(value));
});
