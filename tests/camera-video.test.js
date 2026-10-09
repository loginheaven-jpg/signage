const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const express = require('../host/node_modules/express');
const ffmpeg = require('../host/node_modules/@ffmpeg-installer/ffmpeg').path;
const { mountCameraService } = require('../host/camera-service');
const { probe } = require('../host/camera-video');
const { fixture } = require('./helpers/camera-fixture');

// Real clips from the bundled ffmpeg: a phone-like recording with sound, and one over the limit.
function clip(dir, name, args) {
  const file = path.join(dir, name);
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', ...args, file]);
  return fs.readFileSync(file);
}

async function service(t) {
  const f = fixture(t);
  const config = { enabled: true, archiveEnabled: true, settings: { cancelSec: 60 } };
  const published = [];
  const app = express(); app.use(express.json());
  mountCameraService(app, { archive: f.archive, auth: { check: req => req.get('x-auth') === 'camera', sameOrigin: () => true },
    getConfig: () => config, getSites: () => [{ id: 'screen', name: '본당', online: true }],
    // The converted files are temporary; inspect them while publish still owns them.
    publish: (photo, media) => {
      const copy = path.join(f.root, 'published-' + published.length + '.mp4');
      fs.copyFileSync(media.video, copy);
      published.push({ photo, media, copy, poster: fs.readFileSync(media.poster) }); return 1;
    }, delivery: () => [], cancel: () => {}, mail: null });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'x-auth': 'camera', connection: 'close' };
  const get = (route, options = {}) => fetch(base + '/live/api/camera/' + route, { ...options, headers: { ...headers, ...options.headers } });
  headers.cookie = (await get('config')).headers.get('set-cookie').split(';')[0];
  const upload = ({ bytes, mode = 'both', requestId = crypto.randomUUID(), target = { year: '2027', eventName: '신년예배' }, ...extra }) => {
    const body = new FormData();
    for (const [key, value] of Object.entries({ mode, requestId, target: JSON.stringify(target), capturedAt: '2027-01-03T11:00:00', uploaderName: '김예봄', siteId: 'screen', ...extra })) body.append(key, value);
    body.append('video', new Blob([bytes], { type: 'video/mp4' }), '촬영.mp4');
    return get('video', { method: 'POST', body });
  };
  const shown = async count => { for (let i = 0; i < 300 && published.length < count; i++) await new Promise(r => setTimeout(r, 100)); assert.equal(published.length, count); };
  const rowOf = async id => (await get('uploads').then(r => r.json())).uploads.find(u => u.id === id);
  return { ...f, config, published, get, upload, shown, rowOf };
}

test('a camera video is archived untouched and published as a monitor MP4 of the same length, silent by default', { timeout: 120000 }, async t => {
  const f = await service(t);
  // 2560x1440 forces the re-encode path that phone recordings take.
  const bytes = clip(f.root, 'phone.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=2:size=2560x1440:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
  const config = await f.get('config').then(r => r.json());
  assert.equal(config.maxVideoSeconds, 180); assert.equal(config.maxVideoBytes, 500 * 1024 * 1024);

  const requestId = crypto.randomUUID();
  const response = await f.upload({ bytes, requestId, message: '환영합니다' });
  const accepted = await response.json();
  assert.equal(response.status, 200, JSON.stringify(accepted));
  assert.equal(accepted.upload.kind, 'video'); assert.equal(accepted.upload.live, 'pending');
  assert.equal(accepted.upload.mail, undefined, 'videos are never mailed');

  await f.shown(1);
  const { photo, media, copy, poster } = f.published[0];
  assert.equal(photo.message, '환영합니다'); assert.equal(media.muted, true);
  assert.ok(Math.abs(media.durationMs - 2000) < 300, 'monitors are told the real length: ' + media.durationMs);
  const out = await probe(copy);
  assert.equal(out.codec, 'h264'); assert.equal(Math.max(out.width, out.height), 1920); assert.equal(out.audio, false, 'silent by default');
  assert.ok(Math.abs(out.seconds - 2) < 0.3);
  assert.deepEqual([poster[0], poster[1]], [0xff, 0xd8], 'poster is a JPEG for the grid and for older players');
  for (let i = 0; i < 50 && (await f.rowOf(accepted.upload.id)).live !== 'sent'; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal((await f.rowOf(accepted.upload.id)).live, 'sent');

  // The archive receives the original bytes, as a video, under the chosen event.
  await f.archive.cycle(true);
  const record = f.archive.records.get(accepted.upload.id);
  assert.equal(record.mimeType, 'video/mp4'); assert.match(record.name, /\.mp4$/); assert.equal(record.status, 'saved');
  const saved = [...f.remote.values()].find(file => file.appProperties?.signagePhotoId === record.id);
  assert.equal(Buffer.compare(saved.bytes, bytes), 0);
  assert.equal(f.archive.list().photos[0].video, true);

  // Retrying the same request is answered from the receipt and never shown twice.
  const replay = await f.upload({ bytes, requestId, message: '환영합니다' }).then(r => r.json());
  assert.equal(replay.replay, true); assert.equal(f.published.length, 1);
});

test('unchecking silent keeps the sound; display-only videos are not archived', { timeout: 120000 }, async t => {
  const f = await service(t);
  const bytes = clip(f.root, 'light.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
  const accepted = await f.upload({ bytes, mode: 'live', muted: '0' }).then(r => r.json());
  await f.shown(1);
  assert.equal(f.published[0].media.muted, false);
  assert.equal((await probe(f.published[0].copy)).audio, true);
  assert.equal(f.archive.records.has(accepted.upload.id), false);
  assert.equal(accepted.upload.archive, 'none');
});

test('videos over three minutes and files that are not videos are refused', { timeout: 120000 }, async t => {
  const f = await service(t);
  const long = clip(f.root, 'long.mp4', ['-f', 'lavfi', '-i', 'color=c=black:size=64x64:rate=1:duration=190', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']);
  const tooLong = await f.upload({ bytes: long });
  assert.equal(tooLong.status, 400); assert.match((await tooLong.json()).error, /3분/);
  const notVideo = await f.upload({ bytes: Buffer.from('not a video at all') });
  assert.equal(notVideo.status, 400); assert.match((await notVideo.json()).error, /영상/);
  assert.equal(f.published.length, 0); assert.equal(f.archive.records.size, 0);
});
