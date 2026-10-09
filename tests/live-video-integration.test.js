const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const WebSocket = require('../host/node_modules/ws');
const ffmpeg = require('../host/node_modules/@ffmpeg-installer/ffmpeg').path;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('real HTTP/WebSocket: a camera video reaches the monitor as a playable MP4 with its length and sound choice', { timeout: 90000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-tests-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '../host'), windowsHide: true,
    env: { ...process.env, PORT: String(port), DATA_DIR: temp, UPLOADS_DIR: path.join(temp, 'uploads'),
      ADMIN_PASSWORD: '', CAMERA_PASSWORD: '', GOOGLE_SERVICE_ACCOUNT_KEY: '', GDRIVE_FOLDER_ID: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '', socket;
  child.stdout.on('data', b => { logs += b; });
  child.stderr.on('data', b => { logs += b; });
  t.after(async () => {
    socket?.terminate();
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(temp).startsWith('signage-tests-'));
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function api(route, method = 'GET', body) {
    const res = await fetch(base + route, { method,
      headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    assert.ok(res.ok, `${method} ${route}: ${res.status}`);
    return res.json();
  }
  async function waitFor(fn, timeout = 60000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await fn()) return; await sleep(50); }
    assert.fail('Timed out waiting for condition\n' + logs);
  }
  await waitFor(() => api('/api/sites').then(() => true, () => false), 8000);
  const { site } = await api('/api/sites', 'POST', { name: 'test-display' });
  await api('/api/live', 'PUT', { enabled: true });
  const { token } = await api('/api/live');
  socket = new WebSocket(base.replace('http', 'ws'));
  const messages = [];
  socket.on('message', b => messages.push(JSON.parse(b)));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'register', clientId: 'player', name: 'player', siteId: site.id }));
  await waitFor(() => messages.some(m => m.type === 'registered'), 3000);
  await api('/api/clients/player/approve', 'POST', { siteId: site.id });

  const clip = path.join(temp, 'clip.mov');
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
  const form = new FormData();
  for (const [key, value] of Object.entries({ mode: 'live', requestId: crypto.randomUUID(), uploaderName: '김예봄', siteId: site.id, message: '환영합니다', muted: '0' })) form.append(key, value);
  form.append('video', new Blob([fs.readFileSync(clip)], { type: 'video/quicktime' }), 'clip.mov');
  const response = await fetch(base + '/live/api/camera/video', { method: 'POST', body: form, headers: { 'x-live-token': token } });
  const accepted = await response.json();
  assert.equal(response.status, 200, JSON.stringify(accepted));
  assert.equal(accepted.upload.live, 'pending');

  await waitFor(() => messages.some(m => m.type === 'live_photo'));
  const { photo } = messages.find(m => m.type === 'live_photo');
  assert.equal(photo.message, '환영합니다'); assert.equal(photo.muted, false);
  assert.ok(Math.abs(photo.durationMs - 2000) < 300, String(photo.durationMs));
  assert.match(photo.url, /\.jpg$/, 'older players still receive a picture');
  const poster = await fetch(base + photo.url);
  assert.equal(poster.status, 200); assert.equal(poster.headers.get('content-type'), 'image/jpeg');
  // Players fetch videos in byte ranges.
  const part = await fetch(base + photo.video, { headers: { range: 'bytes=0-99' } });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-type'), 'video/mp4');
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  const session = (await api('/api/live')).sessions.flatMap(s => s.photos).find(p => p.id === photo.id);
  assert.ok(session, 'the video is listed on the monitoring page like a photo');

  // Clearing the live session removes both the poster and the video file.
  await api('/api/live/clear', 'POST', {});
  await waitFor(async () => (await fetch(base + photo.video)).status === 404, 5000);
  assert.equal((await fetch(base + photo.url)).status, 404);
});
