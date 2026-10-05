const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('../host/node_modules/express');
const sharp = require('../host/node_modules/sharp');
const { mountCameraService, parsePhotoDate } = require('../host/camera-service');
const { PhotoArchive } = require('../host/photo-archive');
const { fixture } = require('./helpers/camera-fixture');
const { PhotoMail } = require('../host/photo-mail');

async function service(t, { email = false, existingRoot } = {}) {
  const f = fixture(t, existingRoot);
  const config = { enabled: false, archiveEnabled: true, settings: { cancelSec: 60 } };
  const published = [], cancelled = [];
  const sent = [], clock = { now: Date.now() };
  const mail = email ? new PhotoMail({ dataDir: f.root, env: {}, now: () => clock.now, transport: { sendMail: async message => {
    for (const attachment of message.attachments) assert.equal((await sharp(attachment.path).metadata()).format, 'jpeg');
    sent.push(message);
  } } }) : null;
  const app = express(); app.use(express.json());
  mountCameraService(app, { archive: f.archive, auth: { check: req => req.get('x-auth') === 'camera', sameOrigin: req => req.get('sec-fetch-site') !== 'cross-site' },
    getConfig: () => config, getSites: () => [{ id: 'screen', name: '본당', online: true }],
    publish: (photo, bytes) => { published.push({ photo, bytes }); return 1; }, delivery: () => [], cancel: id => cancelled.push(id), mail });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'x-auth': 'camera', connection: 'close' };
  const get = async (route, options = {}) => fetch(base + '/live/api/camera/' + route, { ...options, headers: { ...headers, ...options.headers } });
  const initial = await get('config'); headers.cookie = initial.headers.get('set-cookie').split(';')[0];
  const png = await sharp({ create: { width: 24, height: 18, channels: 3, background: '#128654' } }).png().toBuffer();
  const upload = async ({ mode = 'archive', requestId = crypto.randomUUID(), bytes = png, name = 'original.png', target = { year: '2027', eventName: '신년예배' }, capturedAt = '2027-01-03T11:00:00', ...extra } = {}) => {
    const body = new FormData();
    const data = { mode, requestId, target: JSON.stringify(target), capturedAt, uploaderName: '김예봄', siteId: 'screen', ...extra };
    for (const [key, value] of Object.entries(data)) body.append(key, value);
    body.append('photo', new Blob([bytes], { type: 'image/png' }), name);
    return get('photo', { method: 'POST', body });
  };
  const preview = async ({ requestId = crypto.randomUUID(), mode = 'both', target = null, bytes = png, ...extra } = {}) => {
    const body = new FormData();
    for (const [key, value] of Object.entries({ requestId, mode, target: JSON.stringify(target), uploaderName: '김예봄', siteId: 'screen', originalName: 'original.png', capturedAt: '2027-01-03T11:00:00', ...extra })) body.append(key, value);
    body.append('photo', new Blob([bytes], { type: 'image/png' }), 'preview.png');
    return get('preview', { method: 'POST', body });
  };
  const original = (id, bytes = png) => { const body = new FormData(); body.append('photo', new Blob([bytes], { type: 'image/png' }), 'original.png'); return get('uploads/' + id + '/original', { method: 'POST', body }); };
  return { ...f, config, published, cancelled, base, headers, get, upload, preview, original, png, mail, sent, clock, server };
}

test('split receipts and private originals survive server restart, including interrupted location assignment', async t => {
  const f = await service(t); f.config.enabled = true;
  const requestId = crypto.randomUUID();
  const posted = (await f.preview({ requestId }).then(r => r.json())).upload;
  await f.original(posted.id);
  const receiptFile = path.join(f.archive.root, 'camera-receipts', posted.id + '.json');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  receipt.target = { year: '2027', eventName: '재시작 예배' };
  fs.writeFileSync(receiptFile, JSON.stringify(receipt)); // Crash between receipt and archive-record assignment.
  await new Promise(resolve => f.server.close(resolve));
  const restarted = await service(t, { existingRoot: f.root }); restarted.config.enabled = true;
  restarted.headers.cookie = f.headers.cookie;
  const replay = await restarted.preview({ requestId }).then(r => r.json());
  assert.equal(replay.replay, true); assert.equal(restarted.published.length, 0);
  assert.equal(restarted.archive.get(posted.id).status, 'pending');
  assert.equal(restarted.archive.get(posted.id).target.eventName, '재시작 예배');
  assert.equal((await restarted.original(posted.id).then(r => r.json())).replay, true);
  await restarted.archive.cycle(true);
  const record = restarted.archive.get(posted.id);
  assert.equal(record.status, 'saved'); assert.deepEqual(restarted.remote.get(record.driveId).bytes, f.png);
});

test('preview publishes without Google or an original; folder-free original stays private and target assignment is durable before Drive', async t => {
  const f = await service(t, { email: true }); f.config.enabled = true;
  const requestId = crypto.randomUUID();
  const getFile = f.drive.files.get; let googleCalls = 0;
  f.drive.files.get = async () => { googleCalls++; throw Object.assign(new Error('Google offline'), { code: 403 }); };
  const response = await f.preview({ requestId, email: 'guest@example.com' }); assert.equal(response.status, 200);
  const posted = (await response.json()).upload;
  assert.equal(posted.archive, 'awaiting_original'); assert.equal(posted.original, 'pending');
  assert.equal(f.published.length, 1); assert.equal(googleCalls, 0); assert.equal(f.archive.records.size, 0);
  assert.equal((await f.preview({ requestId, email: 'guest@example.com' }).then(r => r.json())).replay, true);
  assert.equal(f.published.length, 1); assert.equal(f.mail.jobOf(posted.id).photos.length, 1);
  const received = await f.original(posted.id).then(r => r.json());
  assert.equal(received.upload.original, 'received'); assert.equal(received.upload.archive, 'awaiting_target');
  assert.equal(googleCalls, 0); assert.equal(f.calls.creates.length, 0);
  assert.deepEqual(fs.readFileSync(f.archive.localPath(f.archive.get(posted.id))), f.png);
  assert.equal((await f.original(posted.id).then(r => r.json())).replay, true);
  const rebuilt = new PhotoArchive({ dataDir: f.root, folderId: 'root', drive: f.drive, authMode: 'oauth' });
  assert.equal(rebuilt.get(posted.id).status, 'awaiting_target');
  const target = { year: '2027', eventName: '신년예배' };
  assert.equal((await f.get('uploads/' + posted.id + '/target', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target) })).status, 202);
  assert.equal(f.archive.get(posted.id).status, 'pending');
  await f.archive.cycle(); f.drive.files.get = getFile; await f.archive.cycle(true);
  const saved = f.archive.get(posted.id); assert.equal(saved.status, 'saved');
  assert.deepEqual(f.remote.get(saved.driveId).bytes, f.png); assert.equal(f.published.length, 1);
  assert.equal((await f.original(posted.id, Buffer.from('different bytes'))).status, 400);
});

test('publication-only withdrawal survives the full-cancel deadline, preserves originals and mail, and cannot be replayed', async t => {
  const f = await service(t, { email: true }); f.config.enabled = true;
  const requestId = crypto.randomUUID(), input = { requestId, target: { year: '2027', eventName: '신년예배' }, email: 'guest@example.com' };
  const posted = (await f.preview(input).then(r => r.json())).upload;
  const cookie = f.headers.cookie; f.headers.cookie = '';
  assert.equal((await f.get('uploads/' + posted.id + '/withdraw', { method: 'DELETE' })).status, 404);
  assert.equal((await f.original(posted.id)).status, 404);
  f.headers.cookie = cookie;
  await f.original(posted.id); await f.archive.cycle(true);
  f.config.settings.cancelSec = 0;
  assert.equal((await f.get('uploads/' + posted.id, { method: 'DELETE' })).status, 410);
  assert.equal((await f.get('uploads/' + posted.id + '/withdraw', { method: 'DELETE', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const removed = (await f.get('uploads/' + posted.id + '/withdraw', { method: 'DELETE' }).then(r => r.json())).upload;
  assert.equal(removed.live, 'withdrawn'); assert.equal(removed.archive, 'saved'); assert.equal(removed.mail, 'queued');
  assert.equal(removed.canRetryDisplay, false); assert.equal(removed.canWithdraw, false);
  assert.ok(f.cancelled.includes(posted.id)); assert.equal(f.mail.jobs.size, 1);
  assert.deepEqual(f.remote.get(f.archive.get(posted.id).driveId).bytes, f.png);
  assert.equal((await f.preview(input).then(r => r.json())).upload.live, 'withdrawn'); assert.equal(f.published.length, 1);
  assert.equal((await f.get('uploads/' + posted.id + '/display', { method: 'POST' })).status, 409);
  assert.equal((await f.get('uploads/' + posted.id + '/withdraw', { method: 'DELETE' })).status, 200);
});

test('preview decoding failure preserves the separate original archive workflow', async t => {
  const f = await service(t); f.config.enabled = true;
  const bytes = (await sharp(f.png).jpeg().toBuffer()).subarray(0, 100);
  const response = await f.preview({ bytes }); assert.equal(response.status, 200);
  const posted = (await response.json()).upload;
  assert.equal(posted.live, 'error'); assert.equal(posted.archive, 'awaiting_original'); assert.equal(f.published.length, 0);
  assert.equal((await f.original(posted.id, bytes)).status, 200);
  assert.equal(f.archive.get(posted.id).status, 'awaiting_target');
  assert.deepEqual(fs.readFileSync(f.archive.localPath(f.archive.get(posted.id))), bytes);
});

test('target may arrive before original; full cancellation blocks a late original and upload conflicts preserve the first bytes', async t => {
  const f = await service(t); f.config.enabled = true;
  const posted = (await f.preview().then(r => r.json())).upload;
  const target = { year: '2027', eventName: '신년예배' };
  await f.get('uploads/' + posted.id + '/target', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target) });
  assert.equal(f.archive.records.size, 0);
  await f.original(posted.id); await f.archive.cycle(true);
  assert.equal(f.archive.get(posted.id).target.eventName, '신년예배');
  const otherImage = await sharp(f.png).negate().png().toBuffer();
  assert.equal((await f.original(posted.id, otherImage)).status, 409);
  const late = (await f.preview().then(r => r.json())).upload;
  assert.equal((await f.get('uploads/' + late.id, { method: 'DELETE' })).status, 200);
  assert.equal((await f.original(late.id)).status, 410); assert.equal(f.archive.records.has(late.id), false);
  const live = (await f.preview({ mode: 'live' }).then(r => r.json())).upload;
  assert.equal(live.original, 'none'); assert.equal((await f.original(live.id)).status, 410);
  assert.equal(live.canChangeTarget, false);
  assert.equal((await f.get('uploads/' + live.id + '/target', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target) })).status, 409);
});

test('camera email is limited to display modes; owner-only mail cancellation preserves display/archive and retries do not enqueue twice', async t => {
  const f = await service(t, { email: true }); f.config.enabled = true;
  const requestId = crypto.randomUUID();
  const both = await f.upload({ mode: 'both', requestId, email: 'guest@example.com' }).then(r => r.json());
  assert.equal(both.upload.mail, 'queued'); assert.equal(both.upload.canCancelMail, true);
  assert.equal((await f.upload({ mode: 'both', requestId, email: 'guest@example.com' }).then(r => r.json())).replay, true);
  assert.equal(f.mail.jobOf(both.upload.id).photos.length, 1);
  const live = await f.upload({ mode: 'live', email: 'guest@example.com' }).then(r => r.json());
  assert.equal(live.upload.mail, 'queued'); assert.equal(f.mail.jobOf(live.upload.id).photos.length, 2);
  const archive = await f.upload({ email: 'archive@example.com' }).then(r => r.json());
  assert.equal(archive.upload.mail, undefined); assert.equal(f.mail.jobOf(archive.upload.id), null);
  const cookie = f.headers.cookie; f.headers.cookie = '';
  assert.equal((await f.get('uploads/' + both.upload.id + '/mail', { method: 'DELETE' })).status, 404);
  f.headers.cookie = cookie;
  assert.equal((await f.get('uploads/' + both.upload.id + '/mail', { method: 'DELETE', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await f.get('uploads/' + both.upload.id + '/mail', { method: 'DELETE' })).status, 200);
  assert.equal((await f.get('uploads/' + both.upload.id + '/mail', { method: 'DELETE' })).status, 200);
  assert.equal(f.published.length, 2); assert.equal(f.cancelled.length, 0);
  await f.archive.cycle(true); assert.equal(f.archive.get(both.upload.id).status, 'saved');
  assert.deepEqual(f.remote.get(f.archive.get(both.upload.id).driveId).bytes, f.png);
  await f.mail.cycle(); assert.equal(f.sent.length, 0, 'wait for the cancellation window');
  f.clock.now += 63000; await f.mail.cycle();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].attachments.length, 1);
  assert.equal(f.mail.statusOf(live.upload.id), 'sent');
  assert.equal((await f.get('uploads/' + live.upload.id + '/mail', { method: 'DELETE' })).status, 410);
  const rows = (await f.get('uploads').then(r => r.json())).uploads;
  assert.equal(rows.find(r => r.id === both.upload.id).mail, 'cancelled');
  assert.equal(rows.find(r => r.id === live.upload.id).canCancelMail, false);
  assert.equal(fs.readdirSync(path.join(f.archive.root, 'camera-staging')).length, 0);
});

test('archive-only accepts private originals with live intake closed; retry survives response loss and restart', async t => {
  const f = await service(t), requestId = crypto.randomUUID();
  const result = await f.upload({ requestId }); assert.equal(result.status, 200);
  const { upload } = await result.json();
  assert.equal(f.published.length, 0);
  await f.archive.cycle(true);
  const record = f.archive.get(upload.id); assert.equal(record.status, 'saved');
  assert.equal(record.name, '20270103-110000_김예봄_' + new Date(record.ts + 9 * 3600000).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-') + '.png');
  assert.deepEqual(f.remote.get(record.driveId).bytes, f.png, 'original bytes survive unchanged');
  assert.deepEqual(f.remote.get(record.driveId).parents, [record.target.eventId]);
  const replay = await f.upload({ requestId }); assert.equal((await replay.json()).replay, true);
  assert.equal((await f.get('uploads').then(r => r.json())).uploads.length, 1);
  assert.equal((await f.upload({ requestId, capturedAt: '2027-01-04T11:00:00' })).status, 409);
  const restored = new PhotoArchive({ dataDir: f.root, folderId: 'root', drive: f.drive, authMode: 'oauth' });
  assert.equal(restored.get(upload.id).fingerprint, record.fingerprint);
  assert.equal((await fetch(f.base + '/uploads/' + record.localName)).status, 404);
  f.headers.cookie = ''; assert.equal((await f.get('uploads').then(r => r.json())).uploads.length, 0, 'another device cannot see receipts');
  assert.equal((await f.get('uploads/' + upload.id, { method: 'DELETE' })).status, 404);
});

test('both separates original archive from converted monitor delivery; live-only creates no Drive record', async t => {
  const f = await service(t); f.config.enabled = true;
  const requestId = crypto.randomUUID();
  const result = await f.upload({ mode: 'both', requestId }); const { upload } = await result.json();
  assert.equal(upload.live, 'sent'); assert.equal(f.published.length, 1);
  assert.equal((await sharp(f.published[0].bytes).metadata()).format, 'jpeg');
  assert.equal((await f.upload({ mode: 'both', requestId }).then(r => r.json())).replay, true);
  assert.equal(f.published.length, 1, 'retry does not redisplay');
  await f.archive.cycle(true);
  assert.deepEqual(f.remote.get(f.archive.get(upload.id).driveId).bytes, f.png);
  const live = await f.upload({ mode: 'live' }).then(r => r.json());
  assert.equal(live.upload.archive, 'none'); assert.equal(f.archive.records.has(live.upload.id), false);
  assert.equal((await f.get('uploads/' + upload.id, { method: 'DELETE' })).status, 200);
  await f.archive.cycle(true); assert.equal(f.archive.records.get(upload.id).status, 'deleted');
  assert.ok(f.cancelled.includes(upload.id));
});

test('partial failure preserves archive, rejects spoofed images and cross-site requests, and controls archive intake independently', async t => {
  const f = await service(t);
  const both = await f.upload({ mode: 'both' }).then(r => r.json());
  assert.equal(both.upload.live, 'error'); assert.equal(f.archive.records.has(both.upload.id), true);
  assert.equal((await f.upload({ bytes: Buffer.from('<svg><script>evil</script></svg>'), name: 'photo.png' })).status, 400);
  assert.equal((await f.get('photo', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  f.config.archiveEnabled = false; f.config.enabled = true;
  assert.equal((await f.get('uploads/' + both.upload.id + '/display', { method: 'POST' })).status, 200);
  assert.equal(f.published.length, 1, 'display retry uses the existing original without another Drive record');
  assert.equal((await f.upload()).status, 403);
  assert.equal((await f.upload({ mode: 'live' })).status, 200);
  await f.archive.cycle(true); assert.equal(f.archive.get(both.upload.id).status, 'saved');
  const files = fs.readdirSync(path.join(f.root, 'photo-archive', 'camera-staging'));
  assert.equal(files.length, 0, 'no rejected/private staging originals leak');
});

test('EXIF dates take precedence over file modification fallback; explicit edits and unknown dates are retained', async t => {
  const f = await service(t);
  const jpeg = await sharp(f.png).withExif({ IFD0: { DateTime: '2026:09:01 10:11:12' }, IFD2: { DateTimeOriginal: '2026:08:20 13:14:15' } }).jpeg().toBuffer();
  const exif = await f.upload({ bytes: jpeg, capturedAt: '', dateSource: 'fileModified', lastModified: String(Date.now()) }).then(r => r.json());
  assert.equal(f.archive.get(exif.upload.id).capturedAt, Date.parse('2026-08-20T04:14:15Z'));
  assert.equal(f.archive.get(exif.upload.id).dateSource, 'exif');
  const edited = await f.upload({ bytes: jpeg, capturedAt: '2026-08-21T12:00:00', dateSource: 'user' }).then(r => r.json());
  assert.equal(f.archive.get(edited.upload.id).capturedAt, Date.parse('2026-08-21T03:00:00Z'));
  const unknown = await f.upload({ capturedAt: '' }).then(r => r.json());
  assert.ok(f.archive.get(unknown.upload.id).name.startsWith('날짜미상_김예봄_'));
});

test('inventory restores event metadata after local index loss and does not trash a moved hierarchy', async t => {
  const f = await service(t);
  const result = await f.upload().then(r => r.json()); await f.archive.cycle(true);
  const record = f.archive.get(result.upload.id);
  const rebuilt = new PhotoArchive({ dataDir: path.join(f.root, 'rebuilt'), folderId: 'root', drive: f.drive, authMode: 'oauth' });
  await rebuilt.cycle(true);
  assert.equal(rebuilt.get(record.id).target.eventName, '신년예배');
  assert.equal(rebuilt.get(record.id).uploaderName, '김예봄');
  f.remote.get(record.target.yearId).parents = ['elsewhere'];
  f.archive.markDelete(record.id); await f.archive.cycle(true);
  assert.equal(record.status, 'deleting'); assert.equal(f.remote.get(record.driveId).trashed, undefined);
});

test('photo date parsing is independent of host timezone and rejects impossible dates', () => {
  assert.equal(parsePhotoDate('2026:10:05 09:10:11'), Date.parse('2026-10-05T00:10:11Z'));
  assert.equal(parsePhotoDate('2026-02-30T10:00:00'), null);
  assert.equal(parsePhotoDate('2026-10-05T10:00'), Date.parse('2026-10-05T01:00:00Z'));
});

test('unresolved moved-folder uploads can be redirected by their owner before any Drive file is allocated', async t => {
  const f = await service(t);
  f.folder('year', '2027', 'root'); f.folder('moved-event', '기존 행사', 'outside');
  const result = await f.upload({ target: { year: '2027', yearId: 'year', eventId: 'moved-event' } }).then(r => r.json());
  await f.archive.cycle(true);
  const record = f.archive.records.get(result.upload.id);
  assert.equal(record.status, 'error'); assert.equal(record.driveId, undefined);
  const response = await f.get('uploads/' + result.upload.id + '/target', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ year: '2027', eventName: '새 행사' }) });
  assert.equal(response.status, 202); await f.archive.cycle(true);
  assert.equal(record.status, 'saved'); assert.equal(record.target.eventName, '새 행사');
  assert.equal((await f.get('uploads/' + result.upload.id + '/target', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ year: '2027', eventName: '다른 행사' }) })).status, 409, 'a possibly saved original cannot be silently moved');
});
