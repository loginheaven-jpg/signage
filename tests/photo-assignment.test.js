'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('../host/node_modules/sharp');
const express = require('../host/node_modules/express');
const { fixture } = require('./helpers/camera-fixture');
const { PhotoArchive } = require('../host/photo-archive');
const { assignPhotos } = require('../host/photo-assignment');
const { unclassifiedTarget } = require('../host/drive-folders');
const { mountPhotoRoutes } = require('../host/photo-routes');
const auth = require('../host/browser-auth');
async function originals(t, count = 1) {
  const f = fixture(t);
  f.folder('year', '2026', 'root'); f.folder('thanksgiving', '2026추수감사절', 'year');
  const source = path.join(f.root, 'original.png');
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#836abc' } }).png().toFile(source);
  const ids = Array.from({ length: count }, (_, i) => 'photo-' + i);
  for (const id of ids) f.archive.enqueue({ id, ts: Date.now() }, source, {}, { status: 'awaiting_target', splitUpload: true });
  return { ...f, ids, body: { ids, folderId: 'thanksgiving' } };
}
test('95 explicit originals are previewed, backed up, assigned and verified once; no server original is deleted', async t => {
  const f = await originals(t, 95);
  const preview = await assignPhotos(f.archive, f.body, true);
  assert.equal(preview.results.filter(r => r.status === 'eligible').length, 95);
  assert.equal(fs.existsSync(path.join(f.archive.root, 'assignment-backups')), false);
  assert.equal(f.calls.creates.length, 0);
  const first = await assignPhotos(f.archive, f.body);
  assert.equal(first.results.filter(r => r.status === 'assigned').length, 95);
  const replay = await assignPhotos(f.archive, f.body);
  assert.ok(replay.results.every(r => r.status === 'already_assigned'));
  const restored = new PhotoArchive({ dataDir: f.root, folderId: 'root', drive: f.drive, authMode: 'oauth' });
  for (let i = 0; i < 10; i++) await restored.cycle(true);
  assert.equal([...restored.records.values()].filter(r => r.status === 'saved').length, 95);
  for (const r of restored.records.values()) {
    assert.equal(r.folderId, 'thanksgiving'); assert.ok(r.verifiedAt); assert.ok(restored.localPath(r));
    const backup = path.join(restored.root, 'assignment-backups', r.id);
    assert.deepEqual(fs.readFileSync(path.join(backup, r.localName)), f.remote.get(r.driveId).bytes);
    assert.equal(JSON.parse(fs.readFileSync(path.join(backup, 'before.json'))).status, 'awaiting_target');
  }
  assert.equal(f.calls.creates.length, 95);
});
test('missing/corrupt/unreadable originals fail individually, and foreign folders or stale assigned records are never retargeted', async t => {
  const f = await originals(t, 4);
  fs.unlinkSync(f.archive.localPath(f.archive.get('photo-0')));
  f.archive.get('photo-1').originalHash = 'bad-checksum';
  fs.writeFileSync(f.archive.localPath(f.archive.get('photo-2')), 'not an image');
  const result = await assignPhotos(f.archive, f.body);
  assert.deepEqual(result.results.map(r => r.status), ['failed', 'failed', 'failed', 'assigned']);
  assert.equal(f.archive.get('photo-1').status, 'awaiting_target');
  f.folder('outside', '외부', 'another-root');
  await assert.rejects(assignPhotos(f.archive, { ids: ['photo-0'], folderId: 'outside' }));
  f.folder('other', '다른 행사', 'year');
  const changed = await assignPhotos(f.archive, { ids: ['photo-3'], folderId: 'other' });
  assert.equal(changed.results[0].status, 'failed'); assert.equal(f.archive.get('photo-3').folderId, 'thanksgiving');
  await assert.rejects(assignPhotos(f.archive, { ids: ['photo-0', 'photo-0'], folderId: 'thanksgiving' }));
});
test('Drive success without matching checksum is not saved; originals survive a mismatch and retry uses the same Drive ID', async t => {
  const f = await originals(t);
  await assignPhotos(f.archive, f.body);
  const get = f.drive.files.get;
  f.drive.files.get = async (...args) => { const result = await get(...args); if (result.data.mimeType === 'image/png') result.data.md5Checksum = 'incorrect'; return result; };
  await f.archive.cycle(true);
  const r = f.archive.get('photo-0'); assert.equal(r.status, 'error'); assert.ok(f.archive.localPath(r)); assert.equal(r.verifiedAt, undefined);
  const id = r.driveId; f.drive.files.get = get;
  await f.archive.cycle(true); assert.equal(r.status, 'saved'); assert.equal(r.driveId, id); assert.ok(r.verifiedAt);
  assert.equal(f.remote.size, 4); // root, year, event, one photo
});
test('assignment endpoints require administrator session and same-origin requests', async t => {
  const f = await originals(t), app = express(); app.use(express.json());
  const browserAuth = auth(app, f.root, { NODE_ENV: 'production', ADMIN_PASSWORD: 'admin', CAMERA_PASSWORD: 'camera' });
  app.use('/api', browserAuth.guard('admin')); mountPhotoRoutes(app, f.archive, () => {});
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); t.after(() => new Promise(r => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const login = async (role, password) => (await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, password }) })).headers.get('set-cookie').split(';')[0];
  const camera = await login('camera', 'camera'), admin = await login('admin', 'admin');
  const request = (cookie, origin, preview = false) => fetch(base + '/api/photos/assign' + (preview ? '/preview' : ''), { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(f.body) });
  assert.equal((await request('')).status, 401); assert.equal((await request(camera)).status, 401);
  assert.equal((await request(admin, 'https://attacker.example')).status, 403);
  assert.equal((await request(admin, undefined, true)).status, 200);
  assert.equal((await request(admin)).status, 202); await f.archive.cycle();
});
test('automatic folder uses the Korean capture year, and unknown dates use a frozen acceptance year', () => {
  assert.equal(unclassifiedTarget(Date.parse('2026-12-31T15:00:00Z')).year, '2027');
  assert.equal(unclassifiedTarget(null, Date.parse('2026-12-31T14:59:59Z')).year, '2026');
});
