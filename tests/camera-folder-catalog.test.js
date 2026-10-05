const test = require('node:test');
const assert = require('node:assert/strict');
const { CameraFolderCatalog } = require('../host/camera-folder-catalog');
const { fixture } = require('./helpers/camera-fixture');

test('folder browsing coalesces, reuses successful snapshots, and force refresh discovers changes without duplicate year queries', async t => {
  const f = fixture(t); f.folder('year', '2026', 'root'); f.folder('event', '가을예배', 'year');
  let now = 100, release;
  const gate = new Promise(resolve => { release = resolve; });
  const list = f.drive.files.list;
  f.drive.files.list = async (...args) => { await gate; return list(...args); };
  const catalog = new CameraFolderCatalog(f.archive, { now: () => now });
  const first = catalog.get('2026'), second = catalog.get('2026'); release();
  assert.deepEqual(await first, await second); assert.equal(f.calls.lists.length, 2, 'root and selected year once each');
  f.folder('new-event', '새 행사', 'year');
  assert.equal((await catalog.get('2026')).events.length, 1); assert.equal(f.calls.lists.length, 2);
  assert.equal((await catalog.get('2026', '', true)).events.length, 2); assert.equal(f.calls.lists.length, 4);
  now += 61000;
  const stale = await catalog.get('2026'); assert.equal(stale.refreshing, true); assert.ok(stale.warning);
  await catalog.pending.get('2026/');
  assert.equal((await catalog.get('2026')).refreshing, undefined);
  const missing = await catalog.get('2027'); assert.equal(missing.exists, false); assert.deepEqual(missing.events, []);
  assert.equal(f.calls.creates.length, 0, 'browsing never creates folders');
});

test('aggregate deadline ends the wait, aborts Drive and coalesces late calls without caching an incomplete listing', async t => {
  const f = fixture(t); let release, signal;
  const gate = new Promise(resolve => { release = resolve; });
  const list = f.drive.files.list;
  f.drive.files.list = async (params, options) => { signal = options.signal; await gate; return list(params); };
  const logs = [], catalog = new CameraFolderCatalog(f.archive, { timeoutMs: 20, log: entry => logs.push(entry) });
  await assert.rejects(catalog.get('2026'), e => e.status === 504);
  assert.equal(signal.aborted, true); assert.equal(catalog.cache.size, 0);
  await assert.rejects(catalog.get('2026'), e => e.status === 504);
  assert.equal(logs.length, 1); assert.equal(logs[0].phase, 'years'); assert.equal(logs[0].status, 504);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(catalog.cache.size, 0, 'late response does not become a successful empty list');
  assert.equal((await catalog.get('2026')).exists, false);
});

test('listing failure is never a missing year; moved remembered IDs and Google authorization failures stay explicit', async t => {
  const f = fixture(t); f.folder('year', '2026', 'root'); f.folder('event', '예배', 'year');
  const catalog = new CameraFolderCatalog(f.archive, { log: () => {} });
  await assert.rejects(catalog.get('2026', 'outside'), e => e.status === 409);
  await catalog.get('2026');
  f.drive.files.list = async () => { throw Object.assign(new Error('secret Google request must not be logged'), { code: 403 }); };
  await assert.rejects(catalog.get('2026', '', true), e => e.code === 403);
  assert.equal(catalog.cache.size, 0); assert.equal(f.calls.creates.length, 0);
  await assert.rejects(catalog.get('2027'), e => e.code === 403);
});

test('cached folder IDs cannot authorize a write after the folder is moved', async t => {
  const f = fixture(t); f.folder('year', '2026', 'root'); f.folder('event', '예배', 'year');
  const catalog = new CameraFolderCatalog(f.archive); await catalog.get('2026');
  f.remote.get('event').parents = ['outside'];
  assert.equal((await catalog.get('2026')).events.length, 1);
  await assert.rejects(f.archive.folders.resolve({ year: '2026', yearId: 'year', eventId: 'event' }), e => e.status === 409);
  assert.equal(f.calls.creates.length, 0);
});
