const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createUpdater, within, atomicJson, dependencyKey, validateManifest, download, runTool, sha256 } = require('../client/updater');
const { createHealthMonitor } = require('../client/supervisor-health');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-updater-'));
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(dir).startsWith('signage-updater-'));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  return dir;
}
const fixtureLock = version => ({ name: 'signage-client', version, lockfileVersion: 3, packages: {
  '': { name: 'signage-client', version, dependencies: { electron: '28.3.3', ws: '8.18.0' } },
  'node_modules/electron': { version: '28.3.3', integrity: 'sha512-fixture' },
  'node_modules/ws': { version: '8.18.0', integrity: 'sha512-fixture' }
} });
function writeSource(dir, version, main = '') {
  fs.mkdirSync(dir, { recursive: true });
  atomicJson(path.join(dir, 'package.json'), { name: 'signage-client', version, main: 'main.js', dependencies: fixtureLock(version).packages[''].dependencies });
  atomicJson(path.join(dir, 'package-lock.json'), fixtureLock(version));
  for (const name of ['preload.js', 'supervisor-health.js', 'live-delivery.js', 'updater.js', 'extract.ps1', 'player.html', 'setup.html', 'waiting.html']) fs.writeFileSync(path.join(dir, name), '');
  fs.writeFileSync(path.join(dir, 'main.js'), main);
}
function fakeModules(dir, executable = false) {
  const dist = path.join(dir, 'node_modules/electron/dist');
  fs.mkdirSync(dist, { recursive: true });
  if (executable) fs.copyFileSync(process.execPath, path.join(dist, 'electron.exe'));
  else fs.writeFileSync(path.join(dist, 'electron.exe'), 'fixture');
  atomicJson(path.join(dir, 'node_modules/electron/package.json'), { version: '28.3.3' });
  atomicJson(path.join(dir, 'node_modules/ws/package.json'), { version: '8.18.0' });
}
function fixture(t, options = {}) {
  const root = temp(t);
  writeSource(root, '2.0.1', options.oldMain);
  fakeModules(root, options.executable);
  fs.mkdirSync(path.join(root, 'cache'));
  fs.writeFileSync(path.join(root, 'cache/movie.mp4'), 'existing-media');
  atomicJson(path.join(root, 'config.json'), { hostUrl: 'https://signage.example', clientId: 'keep-id', approved: true });
  const bytes = Buffer.from('verified-zip-fixture');
  const manifest = { schema: 1, minUpdaterSchema: 1, version: '2.1.0', serverVersion: '1.1.0',
    url: '/downloads/client.zip', sha256: sha256(bytes), size: bytes.length };
  let installs = 0;
  const hooks = {
    download: async url => url.endsWith('.json') ? Buffer.from(JSON.stringify(manifest)) : bytes,
    extract: async (_archive, dir) => writeSource(dir, '2.1.0', options.newMain),
    installDependencies: async dir => { installs++; fakeModules(dir, options.executable); },
    runTool: async () => '', ...options.hooks
  };
  return { root, bytes, manifest, hooks, installs: () => installs };
}

test('updates are staged separately, preserve data, and only switch after health confirmation', async t => {
  const f = fixture(t);
  const updater = createUpdater(f.root, f.hooks);
  const next = await updater.checkForUpdate();
  assert.equal(updater.state.active.version, '2.0.1');
  assert.equal(updater.state.serverVersion, '1.1.0');
  assert.equal(next.version, '2.1.0');
  updater.begin(next);
  assert.equal(updater.state.active.version, '2.0.1');
  updater.accept(next);
  assert.equal(updater.state.active.version, '2.1.0');
  assert.equal(updater.state.previous.version, '2.0.1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'config.json'))).clientId, 'keep-id');
  assert.equal(fs.readFileSync(path.join(f.root, 'cache/movie.mp4'), 'utf8'), 'existing-media');
  assert.equal(fs.existsSync(path.join(f.root, 'node_modules/electron/dist/electron.exe')), true);
});

test('power interruption before confirmation restores last known good and quarantines failed release', async t => {
  const f = fixture(t);
  const updater = createUpdater(f.root, f.hooks);
  const next = await updater.checkForUpdate();
  updater.begin(next);
  const restarted = createUpdater(f.root, f.hooks);
  assert.equal(restarted.state.active.version, '2.0.1');
  assert.equal(restarted.state.pending, null);
  assert.ok(restarted.state.rejected.includes(next.id));
  assert.equal(await restarted.checkForUpdate(), null);
});

test('bad checksums and module installation failures never replace the working player', async t => {
  for (const failure of ['checksum', 'npm']) {
    const f = fixture(t);
    if (failure === 'checksum') f.manifest.sha256 = '0'.repeat(64);
    else f.hooks.installDependencies = async () => { throw new Error('npm offline'); };
    const updater = createUpdater(f.root, f.hooks);
    await assert.rejects(updater.checkForUpdate(), failure === 'checksum' ? /checksum/ : /offline/);
    assert.equal(updater.state.active.version, '2.0.1');
    assert.equal(updater.state.pending, null);
    assert.equal(updater.playable(updater.state.active), true);
  }
});

test('an offline server preserves installed playback, and a corrupt state file uses its backup', async t => {
  const f = fixture(t, { hooks: { download: async () => { throw new Error('offline'); } } });
  const updater = createUpdater(f.root, f.hooks);
  await assert.rejects(updater.checkForUpdate(), /offline/);
  atomicJson(path.join(f.root, '.signage/state.json'), updater.state);
  fs.writeFileSync(path.join(f.root, '.signage/state.json'), '{interrupted');
  const restored = createUpdater(f.root, f.hooks);
  assert.equal(restored.state.active.version, '2.0.1');
});

test('source-only updates reuse modules; actual lock changes use a different dependency cache', async t => {
  const f = fixture(t);
  const updater = createUpdater(f.root, f.hooks);
  const first = await updater.dependencies(f.root);
  const newDir = path.join(f.root, 'source-only');
  writeSource(newDir, '2.2.0');
  assert.equal(await updater.dependencies(newDir), first);
  assert.equal(f.installs(), 1);
  const changed = fixtureLock('2.2.0');
  changed.packages['node_modules/ws'].version = '8.18.1';
  assert.notEqual(dependencyKey(changed), dependencyKey(fixtureLock('2.0.1')));
});

test('manifest and local path validation reject executable downloads outside the configured server', () => {
  const m = { schema: 1, version: '2.1.0', size: 10, sha256: 'a'.repeat(64), url: 'https://other.example/client.zip' };
  assert.throws(() => validateManifest(m, 'https://signage.example'), /configured server/);
  assert.throws(() => within('C:/signage', '../outside'), /escapes/);
  assert.throws(() => validateManifest({ ...m, url: '/client.zip', version: '../x' }, 'https://signage.example'), /version/);
});

test('renderer health requires all windows, and an intentional quit is distinguished from a crash', t => {
  const root = temp(t), app = new EventEmitter(), ipcMain = new EventEmitter();
  let time = Date.now(), quits = 0;
  app.quit = () => { quits++; };
  const env = { SIGNAGE_RUN_ID: 'run', SIGNAGE_HEALTH_FILE: path.join(root, 'health.json'),
    SIGNAGE_STOP_FILE: path.join(root, 'stop.json'), SIGNAGE_UPDATE_REQUEST: path.join(root, 'update.json') };
  const windows = [1, 2].map(id => ({ isDestroyed: () => false, webContents: { id, isLoading: () => false } }));
  const monitor = createHealthMonitor({ app, ipcMain, windows: () => windows, version: '2.1.0', env, now: () => time });
  t.after(() => app.emit('will-quit'));
  ipcMain.emit('player-health', { sender: { id: 1 } }, { ready: true });
  monitor.tick();
  assert.equal(JSON.parse(fs.readFileSync(env.SIGNAGE_HEALTH_FILE)).ready, false);
  ipcMain.emit('player-health', { sender: { id: 2 } }, { ready: false });
  monitor.tick();
  assert.equal(JSON.parse(fs.readFileSync(env.SIGNAGE_HEALTH_FILE)).ready, false, 'heartbeat without initialized application is not healthy');
  ipcMain.emit('player-health', { sender: { id: 2 } }, { ready: true });
  monitor.tick();
  assert.equal(JSON.parse(fs.readFileSync(env.SIGNAGE_HEALTH_FILE)).ready, true);
  time += 16000;
  monitor.tick();
  assert.equal(JSON.parse(fs.readFileSync(env.SIGNAGE_HEALTH_FILE)).ready, false);
  atomicJson(env.SIGNAGE_UPDATE_REQUEST, { runId: 'run' });
  monitor.tick();
  assert.equal(quits, 1);
  assert.equal(fs.existsSync(env.SIGNAGE_STOP_FILE), false, 'update-triggered quit must restart');
  monitor.quit();
  assert.equal(JSON.parse(fs.readFileSync(env.SIGNAGE_STOP_FILE)).runId, 'run');
});

test('download limits and stalled tools are bounded', { timeout: 10000 }, async t => {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('too much data'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  await assert.rejects(download(`http://127.0.0.1:${server.address().port}`, { maxBytes: 3 }), /limit/);
  await assert.rejects(runTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }), /timed out/);
});

const playerFixture = version => `
const fs = require('fs');
const env = process.env;
const timer = setInterval(() => fs.writeFileSync(env.SIGNAGE_HEALTH_FILE, JSON.stringify({
  runId: env.SIGNAGE_RUN_ID, pid: process.pid, version: '${version}', ready: true, at: Date.now()
})), 20);
setTimeout(() => {
  fs.writeFileSync(env.SIGNAGE_STOP_FILE, JSON.stringify({ runId: env.SIGNAGE_RUN_ID }));
  clearInterval(timer); process.exit(0);
}, 1200);
`;
test('Windows supervisor switches to a healthy child process and honors deliberate shutdown', { timeout: 20000 }, async t => {
  const f = fixture(t, { executable: true, oldMain: playerFixture('2.0.1'), newMain: playerFixture('2.1.0') });
  const updater = createUpdater(f.root, f.hooks);
  await updater.supervise({ stabilityMs: 80, pollMs: 20, healthTimeoutMs: 2000, restartDelayMs: 20 });
  assert.equal(updater.state.active.version, '2.1.0');
  assert.equal(updater.state.pending, null);
});

test('Windows supervisor restores the previous executable when a candidate crashes at startup', { timeout: 20000 }, async t => {
  const f = fixture(t, { executable: true, oldMain: playerFixture('2.0.1'), newMain: 'process.exit(1);' });
  const updater = createUpdater(f.root, f.hooks);
  await updater.supervise({ stabilityMs: 80, pollMs: 20, healthTimeoutMs: 2000, restartDelayMs: 20 });
  assert.equal(updater.state.active.version, '2.0.1');
  assert.equal(updater.state.rejected.length, 1);
});
