const test = require('node:test');
const assert = require('node:assert/strict');
const { PhotoFolderCatalog } = require('../host/photo-folder-catalog');
const { fixture } = require('./helpers/camera-fixture');

test('library folder reads coalesce, bound parallelism, reuse a fresh snapshot and refresh stale data without blocking', async t => {
  const f = fixture(t);
  for (let i = 0; i < 6; i++) { f.folder('year-' + i, String(2020 + i), 'root'); f.folder('event-' + i, '행사', 'year-' + i); }
  let release, fourStarted, active = 0, peak = 0, now = 100;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { fourStarted = resolve; });
  const list = f.drive.files.list;
  f.drive.files.list = async (...args) => {
    if (args[0].q.startsWith("'year-")) {
      peak = Math.max(peak, ++active); if (active === 4) fourStarted();
      await gate; active--;
    }
    return list(...args);
  };
  const catalog = new PhotoFolderCatalog(f.archive, { now: () => now });
  const first = catalog.get(), second = catalog.get();
  await started; assert.equal(peak, 4); release();
  assert.deepEqual(await first, await second);
  assert.equal(f.calls.lists.length, 7, 'one root query and one query per year, shared by both callers');
  f.folder('new-event', '새 행사', 'year-0');
  assert.equal((await catalog.get()).years.find(group => group.id === 'year-0').events.length, 1);
  assert.equal(f.calls.lists.length, 7, 'fresh reads perform no Drive queries');
  now += 61000;
  const stale = await catalog.get();
  assert.equal(stale.checkedAt, 100); assert.ok(catalog.pending, 'stale data is returned while refreshing');
  await catalog.pending;
  assert.equal((await catalog.get()).years.find(group => group.id === 'year-0').events.length, 2);
  assert.equal(f.calls.lists.length, 14);
});

test('folder navigation is saved and readable before any blocked media scan completes', async t => {
  const f = fixture(t); f.folder('year', '2026', 'root'); f.folder('event', '가을소풍', 'year');
  let release, mediaStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { mediaStarted = resolve; });
  const list = f.drive.files.list;
  f.drive.files.list = async (...args) => {
    if (args[0].q.includes('mimeType contains')) { mediaStarted(); await gate; }
    return list(...args);
  };
  const scan = f.archive.importFiles();
  await started;
  const before = f.calls.lists.length;
  assert.equal(f.archive.list().folders.years[0].events[0].name, '가을소풍');
  assert.equal((await f.archive.folderBrowser.get()).years[0].id, 'year');
  assert.equal(f.calls.lists.length, before, 'cached folder navigation does not wait for or repeat the media scan');
  release(); await scan;
});

test('failed and timed-out folder reads preserve the snapshot, release retries and discard abandoned results', async t => {
  const f = fixture(t); f.folder('year', '2026', 'root'); f.folder('event', '원래 행사', 'year');
  const catalog = new PhotoFolderCatalog(f.archive, { timeoutMs: 40 });
  await catalog.get();
  const snapshot = structuredClone(f.archive.folderCatalog), list = f.drive.files.list;
  let release, calls = 0, signal;
  const gate = new Promise(resolve => { release = resolve; });
  f.drive.files.list = async (params, options) => {
    if (++calls === 1) { signal = options.signal; await gate; }
    return list(params, options);
  };
  await assert.rejects(catalog.get({ force: true, wait: true }), error => error.status === 504);
  assert.equal(signal.aborted, true); assert.equal(catalog.pending, null);
  assert.deepEqual(f.archive.folderCatalog, snapshot);
  await catalog.get(); assert.equal(calls, 1, 'retry backoff prevents a polling request storm');
  f.remote.get('event').name = '최신 행사';
  await catalog.get({ force: true, wait: true });
  assert.equal(f.archive.folderCatalog.years[0].events[0].name, '최신 행사');
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(catalog.pending, null); assert.equal(f.archive.folderError, '');
  assert.equal(f.archive.folderCatalog.years[0].events[0].name, '최신 행사');
  f.drive.files.list = async () => { throw Object.assign(new Error('do not expose Google internals'), { code: 403 }); };
  await assert.rejects(catalog.get({ force: true, wait: true }));
  assert.equal(f.archive.folderCatalog.years[0].events[0].name, '최신 행사');
  assert.ok(f.archive.folderError); assert.equal(f.archive.folderError.includes('internals'), false);
});
