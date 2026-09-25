const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { PhotoArchive, META_PREFIX } = require('../host/photo-archive');

function fixture(t, { shared = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-archive-test-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('signage-archive-test-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const remote = new Map();
  const calls = { creates: [], reads: [], trash: [] };
  let next = 0;
  const drive = { files: {
    generateIds: async () => ({ data: { ids: ['remote-' + (++next)] } }),
    get: async p => {
      calls.reads.push(p.fileId);
      if (p.fileId === 'folder') return { data: { id: 'folder', name: '사진', mimeType: 'application/vnd.google-apps.folder', driveId: shared ? 'shared-drive' : undefined, capabilities: { canAddChildren: true } } };
      const file = remote.get(p.fileId);
      if (!file) throw Object.assign(new Error('Missing'), { code: 404 });
      if (p.alt === 'media') return { data: Readable.from(file.bytes) };
      return { data: { ...file } };
    },
    create: async p => {
      calls.creates.push(p.requestBody.id);
      if (remote.has(p.requestBody.id)) throw Object.assign(new Error('Duplicate'), { code: 409 });
      const bytes = [];
      for await (const chunk of p.media.body) bytes.push(chunk);
      remote.set(p.requestBody.id, { ...p.requestBody, mimeType: p.media.mimeType, bytes: Buffer.concat(bytes), createdTime: new Date().toISOString() });
      return { data: { id: p.requestBody.id } };
    },
    list: async () => ({ data: { files: [...remote.values()].filter(r => !r.trashed && r.parents.includes('folder')) } }),
    update: async p => { calls.trash.push(p.fileId); Object.assign(remote.get(p.fileId), p.requestBody); return { data: { id: p.fileId } }; }
  } };
  const archive = new PhotoArchive({ dataDir: root, folderId: 'folder', drive });
  function add(message = '기억할 문구') {
    const source = path.join(root, randomUUID() + '.jpg'); fs.writeFileSync(source, 'photo-content');
    const p = { id: randomUUID(), message, ts: Date.parse('2026-09-25T16:30:00Z') };
    const record = archive.enqueue(p, source, { id: 'site', name: '현관' });
    fs.unlinkSync(source); // Exactly what live clear/TTL does; archive must survive.
    return record;
  }
  return { root, archive, drive, remote, calls, add };
}

test('archive survives live file deletion/restart, uses Korean date, uploads metadata to the selected folder', async t => {
  const { root, archive, drive, remote, add } = fixture(t);
  const r = add();
  assert.equal(archive.list({ date: '2026-09-26' }).total, 1);
  assert.equal(archive.list({ date: '2026-09-25' }).total, 0);
  const restored = new PhotoArchive({ dataDir: root, folderId: 'folder', drive });
  assert.equal(restored.get(r.id).message, '기억할 문구');
  assert.ok(restored.localPath(restored.get(r.id)));
  await restored.cycle();
  const saved = restored.get(r.id);
  assert.equal(saved.status, 'saved');
  assert.deepEqual(remote.get(saved.driveId).parents, ['folder']);
  assert.equal(JSON.parse(remote.get(saved.driveId).description.slice(META_PREFIX.length)).message, r.message);
});

test('personal My Drive sharing is detected as insufficient for service account uploads', async t => {
  const { archive, calls, add } = fixture(t, { shared: false });
  const r = add(); await archive.cycle();
  assert.equal(archive.status().ready, false);
  assert.match(archive.status().error, /Google 계정/);
  assert.equal(calls.creates.length, 0);
  assert.equal(archive.get(r.id).status, 'pending');
  assert.ok(archive.localPath(r));
  archive.authMode = 'oauth'; await archive.cycle(true);
  assert.equal(archive.get(r.id).status, 'saved');
});

test('ambiguous Drive timeout retries the same generated ID without creating duplicates', async t => {
  const { archive, drive, remote, calls, add } = fixture(t);
  const create = drive.files.create;
  let first = true;
  drive.files.create = async p => {
    const result = await create(p);
    if (first) { first = false; throw Object.assign(new Error('timeout after save'), { code: 'ETIMEDOUT' }); }
    return result;
  };
  const r = add(); await archive.cycle();
  assert.equal(r.status, 'error'); assert.ok(archive.localPath(r));
  assert.ok(r.nextAttempt > Date.now());
  await archive.cycle(); assert.equal(calls.creates.length, 1, 'backoff is honored');
  await archive.cycle(true);
  assert.equal(r.status, 'saved'); assert.equal(remote.size, 1);
  assert.equal(calls.creates[0], calls.creates[1]);
});

test('cancellation during an upload trashes the resulting file and cannot resurrect it', async t => {
  const { archive, drive, remote, add } = fixture(t);
  const r = add();
  const create = drive.files.create;
  drive.files.create = async p => { const result = await create(p); archive.markDelete(r.id); return result; };
  await archive.cycle();
  assert.equal(archive.get(r.id), null);
  assert.equal(r.status, 'deleted');
  assert.equal(remote.get(r.driveId).trashed, true);
  assert.equal(archive.list().total, 0);
  assert.equal(archive.localPath(r), null);
});

test('offline deletion survives restart and waits for a real Drive trash acknowledgement', async t => {
  const { root, archive, drive, remote, add } = fixture(t);
  const r = add(); await archive.cycle();
  const update = drive.files.update;
  drive.files.update = async () => { throw Object.assign(new Error('Forbidden'), { code: 403 }); };
  archive.markDelete(r.id); await archive.cycle();
  assert.equal(r.status, 'deleting'); assert.equal(remote.get(r.driveId).trashed, undefined);
  drive.files.update = update;
  const restarted = new PhotoArchive({ dataDir: root, folderId: 'folder', drive });
  await restarted.cycle(true);
  assert.equal(restarted.records.get(r.id).status, 'deleted');
  assert.equal(remote.get(r.driveId).trashed, true);
});

test('Drive inventory paginates, restores captions after local metadata loss, and tracks external removal', async t => {
  const { root, archive, drive, remote, add } = fixture(t);
  const r = add(); await archive.cycle();
  const first = [...remote.values()][0];
  const external = { id: 'external', name: 'external.jpg', parents: ['folder'], mimeType: 'image/jpeg', description: '<b>plain text</b>', createdTime: '2026-09-24T12:00:00Z' };
  remote.set(external.id, external);
  const list = drive.files.list;
  drive.files.list = async p => p.pageToken ? { data: { files: [external] } } : { data: { files: [first], nextPageToken: 'page2' } };
  const rebuilt = new PhotoArchive({ dataDir: path.join(root, 'rebuilt'), folderId: 'folder', drive });
  await rebuilt.cycle();
  assert.equal(rebuilt.list().total, 2);
  assert.equal(rebuilt.get(r.id).message, r.message);
  assert.equal(rebuilt.get('drive_external').message, '<b>plain text</b>');
  drive.files.list = list; remote.get(first.id).trashed = true;
  await rebuilt.cycle(true); assert.equal(rebuilt.get(r.id), null);
});

test('a moved file is never trashed outside the specified archive folder', async t => {
  const { archive, remote, calls, add } = fixture(t);
  const r = add(); await archive.cycle();
  remote.get(r.driveId).parents = ['other-folder'];
  archive.markDelete(r.id); await archive.cycle();
  assert.equal(r.status, 'deleting'); assert.equal(calls.trash.length, 0);
});
