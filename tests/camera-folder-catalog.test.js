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

test('aggregate deadline ends the wait, releases failed requests and rejects late incomplete listings', async t => {
  const f = fixture(t); let release, signal;
  const gate = new Promise(resolve => { release = resolve; });
  const list = f.drive.files.list;
  f.drive.files.list = async (params, options) => { signal = options.signal; await gate; return list(params); };
  const logs = [], catalog = new CameraFolderCatalog(f.archive, { timeoutMs: 20, log: entry => logs.push(entry) });
  await assert.rejects(catalog.get('2026'), e => e.status === 504);
  assert.equal(signal.aborted, true); assert.equal(catalog.cache.size, 0);
  assert.equal(catalog.pending.size, 0, 'a permanently hung transport cannot pin future retries');
  await assert.rejects(catalog.get('2026'), e => e.status === 504);
  assert.equal(logs.length, 2); assert.equal(logs[0].phase, 'years'); assert.equal(logs[0].status, 504);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(catalog.cache.size, 0, 'late response does not become a successful empty list');
  assert.equal((await catalog.get('2026')).exists, false);
});

test('a late abandoned request cannot remove or replace a newer retry for the same year', async t => {
  const f = fixture(t); f.folder('year', '2026', 'root'); f.folder('event', '예배', 'year');
  let releaseOld, releaseNew, reads = 0;
  const oldGate = new Promise(resolve => { releaseOld = resolve; });
  const newGate = new Promise(resolve => { releaseNew = resolve; });
  const list = f.drive.files.list;
  f.drive.files.list = async (...args) => {
    if (++reads === 1) await oldGate;
    else if (reads === 2) await newGate;
    return list(...args);
  };
  const catalog = new CameraFolderCatalog(f.archive, { timeoutMs: 100, log: () => {} });
  await assert.rejects(catalog.get('2026'), e => e.status === 504 && e.publicMessage.includes('FOLDERS_YEARS_504'));
  const retry = catalog.get('2026');
  releaseOld(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(catalog.pending.size, 1); assert.equal(catalog.cache.size, 0);
  releaseNew();
  assert.equal((await retry).events[0].id, 'event');
  assert.equal(reads, 3, 'late first read never starts another event request');
  assert.equal(catalog.pending.size, 0);
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
