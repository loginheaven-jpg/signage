const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../client/live-delivery.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(failures = 0) {
  const sent = [], images = [];
  let attempts = 0;
  class Image {
    set src(value) {
      if (!value) return;
      attempts++;
      queueMicrotask(() => attempts <= failures ? this.onerror?.() : this.onload?.());
    }
  }
  const context = { Image, requestAnimationFrame: fn => fn(),
    setTimeout: (fn, ms) => ms === 1000 ? setTimeout(fn, 0) : setTimeout(fn, ms), clearTimeout };
  vm.createContext(context);
  vm.runInContext(source, context);
  const delivery = context.LiveDelivery.create({ send: m => sent.push(m), url: u => u, visible: () => true });
  function show(photo) {
    const img = { isConnected: true };
    delivery.bind(img, photo);
    images.push(img);
  }
  return { delivery, sent, images, show, attempts: () => attempts };
}

test('socket receipt and preload alone are not display success; duplicate delivery displays once', async () => {
  const h = harness();
  const photo = { id: 'p1', url: '/one.jpg' };
  h.delivery.receive(photo, h.show);
  h.delivery.receive(photo, h.show);
  await flush();
  assert.equal(h.images.length, 1);
  assert.equal(h.sent.length, 0);
  h.images[0].onload();
  assert.equal(h.sent[0].status, 'displayed');
  h.delivery.receive(photo, h.show);
  await flush();
  assert.equal(h.images.length, 1);
  h.delivery.ready();
  assert.equal(h.sent.at(-1).seen[0], 'p1');
});

test('transient image failure is retried before display', async () => {
  const h = harness(1);
  h.delivery.receive({ id: 'retry', url: '/retry.jpg' }, h.show);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.attempts(), 2);
  assert.equal(h.images.length, 1);
  assert.equal(h.sent.length, 0);
});

test('permanent image failure is reported, never claimed as displayed', async () => {
  const h = harness(100);
  h.delivery.receive({ id: 'bad', url: '/bad.jpg' }, h.show);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.attempts(), 3);
  assert.equal(h.images.length, 0);
  assert.equal(h.sent.at(-1).status, 'image_error');
});

test('clear and delete during an image load prevent late display', async () => {
  for (const action of ['clear', 'remove']) {
    const h = harness();
    h.delivery.receive({ id: 'late', url: '/late.jpg' }, h.show);
    h.delivery[action]('late');
    await flush();
    assert.equal(h.images.length, 0);
    assert.equal(h.sent.length, 0);
  }
});

test('removed DOM images do not produce false display receipts', async () => {
  const h = harness();
  h.delivery.receive({ id: 'gone', url: '/gone.jpg' }, h.show);
  await flush();
  h.images[0].isConnected = false;
  h.images[0].onload();
  assert.equal(h.sent.length, 0);
});

test('Electron reapproval preserves an existing player and only loads a waiting page once', () => {
  const main = fs.readFileSync(path.join(__dirname, '../client/main.js'), 'utf8');
  const code = main.slice(main.indexOf('function handleMessage(msg)'), main.indexOf('let lastPlaying = null'));
  let url = 'file:///C:/Signage/player.html', loads = 0, ready = 0;
  const context = { console: { log() {} }, config: {}, saveConfig() {},
    mainWindow: { webContents: { id: 1, getURL: () => url }, loadFile() { loads++; }, setFullScreen() {} },
    ensureSecondWindow() {}, requestLiveReady() { ready++; }, liveReadyWindows: new Set([1]) };
  vm.createContext(context);
  vm.runInContext(code, context);
  context.handleMessage({ type: 'approved', siteId: 'site' });
  assert.equal(loads, 0);
  assert.equal(ready, 1);
  url = 'file:///C:/Signage/waiting.html';
  context.handleMessage({ type: 'approved', siteId: 'site' });
  assert.equal(loads, 1);
  assert.equal(context.liveReadyWindows.has(1), false);
});

test('Electron routes live to both displays, each only after its renderer is ready', () => {
  const main = fs.readFileSync(path.join(__dirname, '../client/main.js'), 'utf8');
  const code = main.slice(main.indexOf('function liveTarget('), main.indexOf('// ─── 재생 제어'));
  let loading = true;
  const sent = { 1: 0, 2: 0 };
  const results = [];
  const win = id => ({ isDestroyed: () => false, webContents: { id, isLoading: () => loading, send() { sent[id]++; } } });
  const context = { playerStopped: false, dualMonitor: true, mainWindow: win(1), secondWindow: win(2),
    liveReadyWindows: new Set(), sendLiveMessage: m => results.push(m) };
  vm.createContext(context);
  vm.runInContext(code, context);
  const payload = { photo: { id: 'p' } };
  context.routeLive('live-photo', payload);
  assert.deepEqual(sent, { 1: 0, 2: 0 });
  context.liveReadyWindows.add(2);
  context.routeLive('live-photo', payload);
  assert.deepEqual(sent, { 1: 0, 2: 0 });
  loading = false;
  context.routeLive('live-photo', payload);
  assert.deepEqual(sent, { 1: 0, 2: 1 }, 'a window that has not reported ready is skipped');
  context.liveReadyWindows.add(1);
  context.routeLive('live-photo', payload);
  assert.deepEqual(sent, { 1: 1, 2: 2 });
  context.dualMonitor = false;
  context.routeLive('live-photo', payload);
  assert.deepEqual(sent, { 1: 2, 2: 2 }, 'one physical monitor uses the main window only');
  context.playerStopped = true;
  context.routeLive('live-photo', payload);
  assert.deepEqual(sent, { 1: 2, 2: 2 });
  assert.equal(results[0].status, 'stopped');
});

test('Electron reports one readiness and one receipt per PC for two displays', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../client/main.js'), 'utf8');
  const code = main.slice(main.indexOf('const liveReadyWindows'), main.indexOf("ipcMain.on('player-stopped'"));
  const handlers = {};
  const results = [];
  const win = id => ({ isDestroyed: () => false, webContents: { id } });
  const context = { playerStopped: false, dualMonitor: true, mainWindow: win(1), secondWindow: win(2),
    setTimeout, clearTimeout, ipcMain: { on: (name, fn) => { handlers[name] = fn; } },
    ws: { readyState: 1, send: m => results.push(JSON.parse(m)) }, WebSocket: { OPEN: 1 } };
  vm.createContext(context);
  vm.runInContext(code + '\nthis.liveTarget = () => [mainWindow, secondWindow].filter(Boolean);', context);
  const from = (id, message) => handlers['live-delivery']({ sender: (id === 1 ? context.mainWindow : context.secondWindow).webContents }, message);

  from(1, { type: 'live_ready', seen: ['a', 'b'] });
  await new Promise(r => setTimeout(r, 350));
  assert.equal(results.length, 0, 'waits until every display is ready');
  from(2, { type: 'live_ready', seen: ['b', 'c'] });
  await new Promise(r => setTimeout(r, 350));
  assert.deepEqual(results, [{ type: 'live_ready', seen: ['b'] }], 'only photos shown on both displays count as seen');

  results.length = 0;
  from(1, { type: 'live_result', photoId: 'p', status: 'image_error' });
  assert.equal(results.length, 0, 'one failing display is not a failure while the other may still show it');
  from(2, { type: 'live_result', photoId: 'p', status: 'displayed' });
  assert.deepEqual(results.map(m => m.status), ['displayed']);
  from(1, { type: 'live_result', photoId: 'q', status: 'image_error' });
  from(2, { type: 'live_result', photoId: 'q', status: 'image_error' });
  assert.deepEqual(results.map(m => m.status), ['displayed', 'image_error'], 'reported as failed only when every display failed');
});

test('Electron readiness requests work with only one physical monitor', () => {
  const main = fs.readFileSync(path.join(__dirname, '../client/main.js'), 'utf8');
  const code = main.slice(main.indexOf('function requestLiveReady()'), main.indexOf("ipcMain.on('live-delivery'"));
  let sent = 0;
  const context = { secondWindow: null, liveTarget: () => [{ webContents: { id: 1, send() { sent++; } } }], liveReadyWindows: new Set([1]) };
  vm.createContext(context);
  vm.runInContext(code, context);
  context.requestLiveReady();
  assert.equal(sent, 1);
});

test('all player and mobile inline scripts parse', () => {
  for (const file of ['client/player.html', 'host/public/player.html', 'host/public/m.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1], { filename: file });
  }
});

test('server does not replay expired sessions, acknowledged images or unapproved clients', () => {
  const server = fs.readFileSync(path.join(__dirname, '../host/server.js'), 'utf8');
  const code = server.slice(server.indexOf('function livePublicPhoto('), server.indexOf('setInterval(() => { clients.forEach(syncLiveClient)'));
  let sent = 0;
  const photo = { id: 'p', url: '/p.jpg', ts: Date.now() };
  const session = { lastAt: Date.now(), photos: [photo] };
  const context = { liveConfig: { enabled: true, settings: { returnMs: 50000 } },
    liveSessions: new Map([['site', session]]), WebSocket: { OPEN: 1 }, console };
  vm.createContext(context);
  vm.runInContext(code, context);
  const info = { approved: true, liveReady: true, siteId: 'site', liveSeen: new Set(), liveAttempts: new Map(),
    ws: { readyState: 1, send() { sent++; } } };
  context.syncLiveClient(info);
  assert.equal(sent, 1);
  context.syncLiveClient(info);
  assert.equal(sent, 1, 'retry backoff');
  info.liveAttempts.clear();
  info.liveSeen.add('p');
  context.syncLiveClient(info);
  assert.equal(sent, 1);
  info.liveSeen.clear();
  session.lastAt = Date.now() - 60000;
  context.syncLiveClient(info);
  assert.equal(sent, 1);
  session.lastAt = Date.now();
  photo.ts = Date.now() - 60000;
  context.syncLiveClient(info);
  assert.equal(sent, 1, 'a fresh session must not revive old photos');
  photo.ts = Date.now();
  info.approved = false;
  context.syncLiveClient(info);
  assert.equal(sent, 1);
});

test('web and Electron use the same delivery implementation', () => {
  assert.equal(fs.readFileSync(path.join(__dirname, '../host/public/live-delivery.js'), 'utf8'), source);
});

// Original retention and monitor JPEG conversion are exercised with real image
// bytes and HTTP in camera-service.test.js, rather than a canvas implementation stub.
