const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const WebSocket = require('../host/node_modules/ws');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('real HTTP/WebSocket: upload, delayed readiness, reconnect, acknowledgement, cancellation and isolation', { timeout: 25000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-tests-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const sockets = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '../host'), windowsHide: true,
    env: { ...process.env, PORT: String(port), DATA_DIR: temp, UPLOADS_DIR: path.join(temp, 'uploads'),
      ADMIN_PASSWORD: '', GOOGLE_SERVICE_ACCOUNT_KEY: '', GDRIVE_FOLDER_ID: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', b => { logs += b; });
  child.stderr.on('data', b => { logs += b; });
  t.after(async () => {
    sockets.forEach(s => s.terminate());
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
    const root = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(path.resolve(temp).startsWith(root) && path.basename(temp).startsWith('signage-tests-'));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  async function api(route, method = 'GET', body) {
    const res = await fetch(base + route, { method,
      headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    assert.ok(res.ok, `${method} ${route}: ${res.status}`);
    return res.json();
  }
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { await api('/api/sites'); up = true; break; } catch (e) { await sleep(100); }
  }
  assert.ok(up, logs);
  const { site } = await api('/api/sites', 'POST', { name: 'test-display' });
  await api('/api/live', 'PUT', { enabled: true });
  const { token } = await api('/api/live');
  async function connect(id) {
    const socket = new WebSocket(base.replace('http', 'ws'));
    sockets.push(socket);
    const messages = [];
    socket.on('message', b => messages.push(JSON.parse(b)));
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'register', clientId: id, name: id, siteId: site.id }));
    await waitFor(() => messages.some(m => m.type === 'registered'));
    return { socket, messages };
  }
  async function waitFor(fn, timeout = 2000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (fn()) return; await sleep(20); }
    assert.fail('Timed out waiting for condition\n' + logs);
  }
  async function upload() {
    const form = new FormData();
    form.append('t', token); form.append('siteId', site.id); form.append('uploaderId', 'test');
    form.append('photo', new Blob([Buffer.from('test-image')], { type: 'image/jpeg' }), 'photo.jpg');
    const res = await fetch(base + '/live/api/photo', { method: 'POST', body: form });
    assert.equal(res.status, 200);
    return res.json();
  }
  const delivery = id => api(`/live/api/delivery?t=${token}&ids=${id}`);
  const player = await connect('approved-player');
  await api('/api/clients/approved-player/approve', 'POST', { siteId: site.id });
  const { photo, screens } = await upload();
  const archived = await api('/api/photos');
  assert.ok(archived.photos.some(p => p.id === photo.id && p.status === 'pending'));
  assert.equal((await fetch(base + `/api/photos/${photo.id}/image?download=1`)).status, 200);
  assert.equal(screens, 1);
  await waitFor(() => player.messages.some(m => m.photo?.id === photo.id));
  assert.equal((await delivery(photo.id)).photos[0].displayed, 0, 'sending a socket message is not display success');

  // Initial IPC could be lost while the Electron renderer loads. Ready must replay it.
  player.messages.length = 0;
  player.socket.send(JSON.stringify({ type: 'live_ready', seen: [] }));
  await waitFor(() => player.messages.some(m => m.photo?.id === photo.id));
  player.socket.send(JSON.stringify({ type: 'live_result', photoId: photo.id, status: 'image_error' }));
  await sleep(50);
  assert.deepEqual((await delivery(photo.id)).photos[0].errors, ['image_error']);
  player.socket.send(JSON.stringify({ type: 'live_result', photoId: photo.id, status: 'displayed' }));
  await sleep(50);
  assert.equal((await delivery(photo.id)).photos[0].displayed, 1);
  assert.equal((await delivery(photo.id)).photos[0].errors.length, 0);

  const rogue = await connect('unapproved-player');
  const missed = await upload();
  rogue.socket.send(JSON.stringify({ type: 'live_result', photoId: missed.photo.id, status: 'displayed' }));
  await sleep(50);
  assert.equal((await delivery(missed.photo.id)).photos[0].displayed, 0);
  assert.equal(rogue.messages.filter(m => m.type === 'live_photo').length, 0);

  await new Promise(resolve => { player.socket.once('close', resolve); player.socket.close(); });
  const offline = await upload();
  assert.equal(offline.screens, 0);
  const reconnected = await connect('approved-player');
  reconnected.socket.send(JSON.stringify({ type: 'live_ready', seen: [photo.id] }));
  await waitFor(() => reconnected.messages.some(m => m.photo?.id === offline.photo.id));
  assert.equal(reconnected.messages.filter(m => m.photo?.id === photo.id).length, 0, 'already displayed photos are not replayed');

  // Missing acknowledgements are retried without needing a reconnect.
  reconnected.messages.length = 0;
  await waitFor(() => reconnected.messages.some(m => m.photo?.id === offline.photo.id), 11000);
  reconnected.socket.send(JSON.stringify({ type: 'live_result', photoId: offline.photo.id, status: 'stopped' }));
  await sleep(50);
  assert.deepEqual((await delivery(offline.photo.id)).photos[0].errors, ['stopped']);
  const file = await fetch(base + offline.photo.url);
  assert.equal(file.status, 200);
  await api(`/live/api/photo/${offline.photo.id}?t=${token}&uploaderId=test`, 'DELETE');
  assert.equal((await fetch(base + `/api/photos/${offline.photo.id}/image`)).status, 404, 'uploader cancellation also removes archive access');
  assert.equal((await fetch(base + offline.photo.url)).status, 404);
  reconnected.messages.length = 0;
  reconnected.socket.send(JSON.stringify({ type: 'live_ready', seen: [] }));
  await sleep(100);
  assert.equal(reconnected.messages.some(m => m.photo?.id === offline.photo.id), false);
  const denied = await fetch(base + `/live/api/delivery?t=invalid&ids=${photo.id}`);
  assert.equal(denied.status, 401);
  await api('/api/live/clear', 'POST', {});
  assert.equal((await fetch(base + photo.url)).status, 404);
  assert.equal((await fetch(base + `/api/photos/${photo.id}/image`)).status, 200, 'live clear preserves the independent archive copy');
  const crossSiteDelete = await fetch(base + `/api/photos/${photo.id}`, { method: 'DELETE', headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSiteDelete.status, 403);
  await api(`/api/photos/${photo.id}`, 'DELETE');
  assert.equal((await fetch(base + `/api/photos/${photo.id}/image`)).status, 404);
});
