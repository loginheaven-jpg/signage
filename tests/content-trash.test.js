const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { ContentLibrary, contentUsage } = require('../host/content-library');
const GDriveSync = require('../host/gdrive-sync');
const fixture = require('../scripts/helpers/content-fixture.cjs');

function storage(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-trash-'));
  const uploadsDir = path.join(root, 'uploads'); fs.mkdirSync(uploadsDir);
  t.after(() => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('signage-trash-')); fs.rmSync(root, { recursive: true, force: true }); });
  const options = { dataDir: root, uploadsDir };
  return { root, uploadsDir, options, library: new ContentLibrary(options) };
}
const local = { id: 'local', filename: 'poster.png', originalName: '안내.png', source: 'local', mimeType: 'image/png' };

test('trash has no expiry; restart, preview, restore identity and permanent-delete tombstones preserve the agreed lifecycle', async t => {
  const s = storage(t); fs.writeFileSync(path.join(s.uploadsDir, local.filename), 'original bytes');
  await s.library.trash(local, () => []);
  assert.equal(fs.existsSync(path.join(s.uploadsDir, local.filename)), false);
  const record = s.library.records.get(local.id);
  s.library.commit({ ...record, trashedAt: '2000-01-01T00:00:00Z' });
  let lib = new ContentLibrary(s.options);
  assert.equal(lib.list().count, 1); assert.equal(lib.list().totalBytes, 14);
  assert.equal(fs.readFileSync(lib.preview('local').path, 'utf8'), 'original bytes');
  assert.equal(lib.unavailable(local.filename), true);
  const restored = await lib.restore('local');
  assert.equal(restored.id, local.id); assert.equal(restored.filename, local.filename);
  assert.equal(lib.unavailable(local.filename), false);
  lib = new ContentLibrary(s.options); assert.equal(lib.activeFiles()[0].id, 'local');
  await lib.trash(restored, () => []); await lib.purge('local'); await lib.purge('local');
  lib = new ContentLibrary(s.options); assert.equal(lib.list().count, 0);
  assert.equal(lib.unavailable(local.filename), true);
  assert.equal(fs.readdirSync(lib.blobs).length, 0);
  await assert.rejects(lib.restore('local'), { status: 404 });
});

test('inactive and expired references across every site and monitor block trash; write failure leaves original and index untouched', async t => {
  const s = storage(t); fs.writeFileSync(path.join(s.uploadsDir, local.filename), 'bytes');
  const sheets = [{ id: 's', name: '지난 행사', siteId: 'other', type: 'separate', a: [{ file: local.filename, enabled: false, validTo: '2000-01-01' }], b: [{ file: local.filename }] }];
  const usage = name => contentUsage(sheets, [{ id: 'other', name: '식당' }], name);
  assert.deepEqual(usage(local.filename).map(u => [u.siteName, u.monitor, u.row]), [['식당', 'A', 1], ['식당', 'B', 1]]);
  await assert.rejects(s.library.trash(local, usage), error => error.status === 409 && error.locations.length === 2);
  assert.equal(fs.readFileSync(path.join(s.uploadsDir, local.filename), 'utf8'), 'bytes');
  const commit = s.library.commit; s.library.commit = () => { throw new Error('disk full'); };
  await assert.rejects(s.library.trash(local, () => []), /disk full/);
  assert.equal(s.library.list().count, 0); assert.equal(fs.readdirSync(s.library.blobs).length, 0);
  assert.equal(fs.existsSync(path.join(s.uploadsDir, local.filename)), true); s.library.commit = commit;
  await assert.rejects(s.library.trash({ ...local, filename: '../private' }, () => []), /파일 경로/);
});

test('interrupted restore is recoverable and only explicitly requested permanent deletion is resumed after restart', async t => {
  const s = storage(t); fs.writeFileSync(path.join(s.uploadsDir, local.filename), 'bytes');
  await s.library.trash(local, () => []);
  s.library.commit = () => { throw new Error('disk full'); };
  await assert.rejects(s.library.restore('local'), /disk full/);
  const lib = new ContentLibrary(s.options);
  assert.equal(lib.list().count, 1); assert.equal(fs.existsSync(path.join(s.uploadsDir, local.filename)), false);
  assert.equal(fs.readFileSync(lib.preview('local').path, 'utf8'), 'bytes');
  lib.commit({ ...lib.records.get('local'), status: 'deleting' });
  const restarted = new ContentLibrary(s.options);
  assert.equal(restarted.list().count, 0); assert.equal(fs.readdirSync(restarted.blobs).length, 0);
});

test('concurrent actions cannot contradict a pending move; a newly added reference aborts before committing trash', async t => {
  const s = storage(t); fs.writeFileSync(path.join(s.uploadsDir, local.filename), 'bytes');
  const pending = s.library.trash(local, () => []);
  assert.equal(s.library.unavailable(local.filename), true);
  await assert.rejects(s.library.restore(local.id), { status: 409 });
  await assert.rejects(s.library.trash(local, () => []), { status: 409 });
  await pending; await s.library.restore(local.id);
  await assert.rejects(s.library.purge(local.id), { status: 404 }, 'active files cannot be permanently deleted');
  let checks = 0;
  await assert.rejects(s.library.trash(local, () => ++checks === 1 ? [] : [{ sheetId: 'late', row: 1 }]), { status: 409 });
  assert.equal(s.library.list().count, 0);
  assert.equal(fs.readFileSync(path.join(s.uploadsDir, local.filename), 'utf8'), 'bytes');
});

test('Drive trash, purge and restored snapshots stay excluded through sync and restart without changing the Drive original', async t => {
  const s = storage(t), file = { ...local, id: 'drive-1', source: 'gdrive', filename: 'gdrive_drive-1_poster.png' };
  fs.writeFileSync(path.join(s.uploadsDir, file.filename), 'Drive snapshot');
  await s.library.trash(file, () => []);
  let downloads = 0;
  const sync = new GDriveSync({ downloadDir: s.uploadsDir, isExcluded: id => s.library.excludesDrive(id) });
  sync.drive = { files: { list: async () => ({ data: { files: [{ id: file.id, name: 'poster.png', modifiedTime: 'new' }] } }), get: async () => { downloads++; throw new Error('must not download'); } } };
  sync.syncedFiles.set(file.id, { name: 'poster.png', localPath: path.join(s.uploadsDir, file.filename), modifiedTime: 'old' });
  await sync.sync(); assert.equal(downloads, 0); assert.equal(sync.getFileList().length, 0);
  await s.library.restore(file.id);
  sync.drive.files.list = async () => ({ data: { files: [] } });
  await sync.sync(); assert.equal(fs.readFileSync(path.join(s.uploadsDir, file.filename), 'utf8'), 'Drive snapshot');
  assert.equal(new ContentLibrary(s.options).activeFiles()[0].id, file.id);
  await s.library.trash(file, () => []); await s.library.purge(file.id);
  s.library = new ContentLibrary(s.options);
  sync.drive.files.list = async () => ({ data: { files: [{ id: file.id, name: 'poster.png', modifiedTime: 'later' }] } });
  await sync.sync(); assert.equal(downloads, 0); assert.equal(s.library.list().count, 0);
});

test('an in-flight Drive download cannot resurrect an excluded file; list failures preserve cache and pagination completes before cleanup', async t => {
  const s = storage(t); let excluded = false, release, began;
  const started = new Promise(resolve => { began = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const sync = new GDriveSync({ downloadDir: s.uploadsDir, isExcluded: () => excluded });
  sync.drive = { files: {
    list: async () => ({ data: { files: [{ id: 'd1', name: 'poster.png', modifiedTime: 'now' }] } }),
    get: async () => ({ data: Readable.from((async function* () { began(); await gate; yield Buffer.from('download'); })()) })
  } };
  const running = sync.sync(); await started; excluded = true; release(); await running;
  assert.deepEqual(fs.readdirSync(s.uploadsDir), ['.sync-state.json']);
  fs.writeFileSync(path.join(s.uploadsDir, 'kept.png'), 'kept'); excluded = false;
  sync.syncedFiles.set('kept', { name: 'kept.png', localPath: path.join(s.uploadsDir, 'kept.png'), modifiedTime: 'now' });
  sync.drive.files.list = async () => { throw new Error('temporary Drive failure'); };
  await sync.sync(); assert.equal(fs.existsSync(path.join(s.uploadsDir, 'kept.png')), true);
  const tokens = [];
  sync.drive.files.list = async options => { tokens.push(options.pageToken); return { data: options.pageToken ? { files: [{ id: 'kept', name: 'kept.png', modifiedTime: 'now' }] } : { files: [], nextPageToken: 'page2' } }; };
  await sync.sync(); assert.deepEqual(tokens, [undefined, 'page2']); assert.equal(sync.getFileList().length, 1);
});

test('Drive publishes completed downloads with correct bytes and failed replacement retains the previous cache', async t => {
  const s = storage(t); let completed;
  const sync = new GDriveSync({ downloadDir: s.uploadsDir, onSyncComplete: files => { completed = files; } });
  let modifiedTime = 'v1';
  sync.drive = { files: {
    list: async () => ({ data: { files: [{ id: 'download', name: 'poster.png', mimeType: 'image/png', modifiedTime, size: '14' }] } }),
    get: async () => ({ data: Readable.from([Buffer.from('complete bytes')]) })
  } };
  await sync.sync();
  assert.equal(completed.length, 1); assert.equal(completed[0].size, 14);
  assert.equal(fs.readFileSync(path.join(s.uploadsDir, completed[0].filename), 'utf8'), 'complete bytes');
  modifiedTime = 'v2'; sync.drive.files.get = async () => { throw new Error('download unavailable'); };
  await sync.sync(); assert.equal(sync.syncedFiles.get('download').modifiedTime, 'v1');
  assert.equal(fs.readFileSync(path.join(s.uploadsDir, completed[0].filename), 'utf8'), 'complete bytes');
  assert.equal(fs.readdirSync(s.uploadsDir).some(name => name.endsWith('.part')), false);
});

test('real authenticated content API blocks referenced/trashed cue files, supports partial batches and retains bytes across restart', { timeout: 45000 }, async t => {
  const f = await fixture({ password: 'content-test-only' }); t.after(() => f.cleanup());
  assert.equal((await f.api('/api/content-trash')).status, 401);
  assert.equal((await fetch(f.base + '/api/content-trash/drive-1/preview')).status, 401);
  await f.login();
  const usage = await f.api('/api/content/used/usage'); assert.equal(usage.data.locations.length, 4);
  const blocked = await f.api('/api/content/used', 'DELETE'); assert.equal(blocked.status, 409); assert.equal(blocked.data.locations.length, 4);
  assert.equal((await f.api('/api/content/unused', 'DELETE')).status, 200);
  assert.equal((await f.api('/api/content/unused', 'DELETE')).status, 200, 'response-loss retry is idempotent');
  assert.equal((await f.api('/api/content')).data.some(file => file.id === 'unused'), false);
  let trash = await f.api('/api/content-trash'); assert.equal(trash.data.count, 2);
  const draft = { siteId: 'lobby', name: '금지 편성', type: 'sync', rows: [{ file1: 'unused.png' }] };
  assert.equal((await f.api('/api/sheets', 'POST', draft)).status, 409);
  assert.equal((await f.api('/api/sheets/live', 'PUT', draft)).status, 409);
  assert.equal((await f.api('/api/content-trash/delete', 'POST', { ids: ['unused'] })).status, 400);
  const partial = await f.api('/api/content-trash/restore', 'POST', { ids: ['unused', 'missing', 'drive-1'] });
  assert.deepEqual(partial.data.results.map(r => r.success), [true, false, true]);
  assert.equal(fs.readFileSync(path.join(f.uploads, 'unused.png')).equals(f.image), true);
  await f.stop(); await f.start();
  const active = (await f.api('/api/content')).data;
  assert.equal(active.filter(file => file.id === 'unused').length, 1);
  assert.equal(active.find(file => file.id === 'drive-1').retainedLocal, true);
  assert.equal((await f.api('/api/content-trash')).data.count, 0);
  assert.equal((await f.api('/api/content/unused', 'DELETE')).status, 200);
  assert.equal((await f.api('/api/content-trash/delete', 'POST', { ids: ['unused'], confirm: true })).data.success, true);
  await f.stop(); await f.start();
  assert.equal((await f.api('/api/content-trash/restore', 'POST', { ids: ['unused'] })).data.results[0].success, false);
  assert.equal((await f.api('/api/content')).data.some(file => file.id === 'unused'), false);
  assert.equal((await f.api('/api/sheets', 'POST', draft)).status, 409);
});
