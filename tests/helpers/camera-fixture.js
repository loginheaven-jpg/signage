'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { PhotoArchive } = require('../../host/photo-archive');
const { FOLDER } = require('../../host/drive-folders');
function fixture(t, existingRoot) {
  const root = existingRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'signage-camera-flow-'));
  if (!existingRoot) t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('signage-camera-flow-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let next = 0;
  const remote = new Map([['root', { id: 'root', name: '#교회사진영상', mimeType: FOLDER, capabilities: { canAddChildren: true } }]]);
  const calls = { creates: [], lists: [], updates: [] };
  const drive = { files: {
    generateIds: async () => ({ data: { ids: ['new-' + ++next] } }),
    get: async (p, options = {}) => {
      const file = remote.get(p.fileId);
      if (!file || file.trashed) throw Object.assign(new Error('Missing'), { code: 404 });
      if (p.alt === 'media') return { data: options.responseType === 'arraybuffer' ? file.bytes : Readable.from(file.bytes) };
      return { data: { ...file } };
    },
    list: async p => {
      calls.lists.push(p.q);
      const parent = p.q.match(/^'([\w-]+)' in parents/)[1];
      const folders = p.q.includes("mimeType = '");
      return { data: { files: [...remote.values()].filter(f => !f.trashed && f.parents?.includes(parent) && (folders ? f.mimeType === FOLDER : f.mimeType.startsWith('image/'))) } };
    },
    create: async p => {
      calls.creates.push(p.requestBody);
      if (remote.has(p.requestBody.id)) throw Object.assign(new Error('Duplicate'), { code: 409 });
      const bytes = [];
      if (p.media) for await (const chunk of p.media.body) bytes.push(chunk);
      const f = { ...p.requestBody, mimeType: p.media?.mimeType || p.requestBody.mimeType, bytes: Buffer.concat(bytes), createdTime: new Date().toISOString(), capabilities: { canAddChildren: true } };
      remote.set(f.id, f); return { data: { id: f.id } };
    },
    update: async p => { calls.updates.push(p.fileId); Object.assign(remote.get(p.fileId), p.requestBody); return { data: { id: p.fileId } }; }
  } };
  const archive = new PhotoArchive({ dataDir: root, folderId: 'root', drive, authMode: 'oauth' });
  const folder = (id, name, parent) => remote.set(id, { id, name, parents: [parent], mimeType: FOLDER, capabilities: { canAddChildren: true } });
  return { root, remote, drive, archive, calls, folder };
}
module.exports = { fixture };
