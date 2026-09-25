// Optional real Electron smoke test after client/updater.prepareLocal().
// Uses a hidden test window and never registers Startup or connects to production.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const client = path.resolve(__dirname, '../client');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-electron-smoke-'));
const depsRoot = path.join(client, '.signage/dependencies');
const dependency = fs.readdirSync(depsRoot).find(name => fs.existsSync(path.join(depsRoot, name, 'node_modules/electron/dist/electron.exe')));
const executable = path.join(depsRoot, dependency, 'node_modules/electron/dist/electron.exe');
const healthFile = path.join(root, 'health.json');
const stopFile = path.join(root, 'stop.json');
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'signage-smoke-test', version: '2.1.0', main: 'main.js' }));
fs.writeFileSync(path.join(root, 'main.js'), `
const { app, BrowserWindow, ipcMain } = require('electron');
const { createHealthMonitor } = require(${JSON.stringify(path.join(client, 'supervisor-health.js'))});
let win;
app.setPath('userData', ${JSON.stringify(path.join(root, 'user-data'))});
const monitor = createHealthMonitor({ app, ipcMain, windows: () => [win], version: '2.1.0' });
app.whenReady().then(() => {
  win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, preload: ${JSON.stringify(path.join(client, 'preload.js'))} } });
  win.loadURL('data:text/html,<html><body>Unattended updater smoke test<script>window.signage.rendererReady()</script></body></html>');
  setTimeout(() => monitor.quit(), 10000);
});
`);
const env = { ...process.env, SIGNAGE_RUN_ID: 'electron-smoke', SIGNAGE_HEALTH_FILE: healthFile, SIGNAGE_STOP_FILE: stopFile };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [root], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', data => { output += data; });
child.stderr.on('data', data => { output += data; });
const timeout = setTimeout(() => child.kill(), 20000);
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => {
  clearTimeout(timeout);
  try {
    assert.equal(code, 0, output);
    const health = JSON.parse(fs.readFileSync(healthFile));
    assert.equal(health.ready, true);
    assert.equal(health.pid, child.pid);
    assert.equal(health.version, '2.1.0');
    assert.equal(JSON.parse(fs.readFileSync(stopFile)).runId, 'electron-smoke');
    console.log('Real Electron: renderer heartbeat, hidden window readiness and intentional shutdown passed.');
  } catch (error) { console.error(error.message, output.slice(-2000)); process.exitCode = 1; }
  finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('signage-electron-smoke-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
