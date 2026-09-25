'use strict';

// Dependency-free supervisor. The Windows bootstrap holds a per-install mutex.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function within(root, relative, allowRoot = false) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Invalid relative path');
  const target = path.resolve(root, relative);
  const base = path.resolve(root).toLowerCase();
  if (!(allowRoot && target.toLowerCase() === base) && !target.toLowerCase().startsWith(base + path.sep)) {
    throw new Error('Path escapes installation');
  }
  return target;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temp, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { readJson(file); fs.copyFileSync(file, file + '.bak'); } catch (_) { }
  fs.renameSync(temp, file);
}

function compareVersions(a, b) {
  const parse = v => {
    if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error('Invalid release version');
    return v.split('.').map(Number);
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function dependencyKey(lock) {
  lock = JSON.parse(JSON.stringify(lock));
  delete lock.name; delete lock.version;
  if (lock.packages?.['']) { delete lock.packages[''].name; delete lock.packages[''].version; }
  return `${process.platform}-${process.arch}-${sha256(JSON.stringify(canonical(lock)))}`;
}

function validateManifest(manifest, base) {
  if (manifest.schema !== 1 || manifest.minUpdaterSchema > 1) throw new Error('Unsupported update protocol');
  compareVersions(manifest.version, '0.0.0');
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('Invalid package checksum');
  if (!Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > 32 * 1024 * 1024) throw new Error('Invalid package size');
  if ((manifest.minNodeMajor || 22) > Number(process.versions.node.split('.')[0])) throw new Error('This update needs a newer Node runtime');
  const url = new URL(manifest.url, base);
  if (url.origin !== new URL(base).origin || url.username || url.password) throw new Error('Update package must come from the configured server');
  return { ...manifest, url: url.href, id: `${manifest.version}-${manifest.sha256.slice(0, 16)}` };
}

async function download(url, { timeout = 10000, maxBytes = 32 * 1024 * 1024, fetcher = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetcher(url, { signal: controller.signal, redirect: 'error', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (Number(res.headers.get('content-length')) > maxBytes) throw new Error('Download exceeds limit');
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) { controller.abort(); throw new Error('Download exceeds limit'); }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); }
}

async function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve); killer.once('exit', resolve);
    });
  } else { child.kill('SIGKILL'); }
}

function runTool(exe, args, { cwd, timeout = 180000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const collect = data => { output = (output + data).slice(-12000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      void killTree(child).finally(() => reject(new Error(`${path.basename(exe)} timed out`)));
    }, timeout);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve(output);
      else reject(new Error(`${path.basename(exe)} ${timedOut ? 'timed out' : 'failed (' + code + ')'}: ${output.slice(-2000)}`));
    });
  });
}

function createUpdater(root, hooks = {}) {
  root = path.resolve(root);
  const store = within(root, '.signage');
  fs.mkdirSync(store, { recursive: true });
  const stateFile = path.join(store, 'state.json');
  const tool = hooks.runTool || runTool;
  const get = hooks.download || download;
  const log = message => {
    const file = path.join(store, 'updater.log');
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.old');
      fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
    } catch (_) { }
  };
  let state;
  for (const file of [stateFile, stateFile + '.bak']) {
    try {
      const saved = readJson(file);
      if (saved.schema === 1 && Array.isArray(saved.rejected)) { state = saved; break; }
    } catch (_) { }
  }
  if (!state) state = { schema: 1, active: null, previous: null, pending: null, rejected: [] };
  const save = () => atomicJson(stateFile, state);
  const sourcePath = descriptor => {
    if (descriptor.dir !== '.' && !descriptor.dir.replace(/\\/g, '/').startsWith('.signage/releases/')) throw new Error('Invalid release location');
    const result = within(root, descriptor.dir, true);
    if (descriptor.dir !== '.') within(path.join(store, 'releases'), path.relative(path.join(store, 'releases'), result));
    return result;
  };
  const modulesPath = descriptor => {
    if (descriptor.modules !== '.' && !descriptor.modules.replace(/\\/g, '/').startsWith('.signage/dependencies/')) throw new Error('Invalid dependency location');
    const result = within(root, descriptor.modules, true);
    if (descriptor.modules !== '.') within(path.join(store, 'dependencies'), path.relative(path.join(store, 'dependencies'), result));
    return result;
  };
  const electronPath = descriptor => path.join(modulesPath(descriptor), 'node_modules/electron/dist/electron.exe');
  const playable = descriptor => {
    try {
      return !!descriptor && fs.existsSync(path.join(sourcePath(descriptor), 'main.js')) &&
        fs.existsSync(electronPath(descriptor)) && fs.existsSync(path.join(modulesPath(descriptor), 'node_modules/ws/package.json'));
    } catch (_) { return false; }
  };
  function removeOwned(relative) {
    const target = within(store, relative);
    if (!/^(staging|dependencies|releases)[\\/][^\\/]+/.test(relative)) throw new Error('Refusing to remove storage root');
    // Deletion is confined to a verified absolute child of this installation's storage.
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  }
  function rejectPending(reason) {
    if (state.pending) {
      state.rejected = [...state.rejected.filter(id => id !== state.pending.id), state.pending.id].slice(-12);
      log(`Rejected ${state.pending.version}: ${reason}`);
      state.pending = null; save();
    }
  }
  // The bootstrap mutex guarantees no other installer is using these temporary
  // directories. A power cut can leave them behind but never makes them active.
  try {
    for (const name of fs.readdirSync(path.join(store, 'staging'))) {
      if (/^(deps|release)-[a-f0-9-]{36}$/.test(name)) removeOwned(path.join('staging', name));
    }
  } catch (e) { if (e.code !== 'ENOENT') log(`Staging cleanup deferred: ${e.message}`); }
  if (state.pending) rejectPending('previous startup was interrupted before health confirmation');
  if (!playable(state.active)) {
    if (playable(state.previous)) { state.active = state.previous; state.previous = null; save(); }
    else state.active = null;
  }
  if (!state.active) {
    try {
      const pkg = readJson(path.join(root, 'package.json'));
      const legacy = { id: `local-${pkg.version}`, version: pkg.version, dir: '.', modules: '.', legacy: compareVersions(pkg.version, '2.1.0') < 0 };
      if (playable(legacy)) { state.active = legacy; save(); }
    } catch (_) { }
  }

  async function extract(archive, destination) {
    if (hooks.extract) return hooks.extract(archive, destination);
    await tool('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'extract.ps1'), '-Archive', archive, '-Destination', destination], { timeout: 30000 });
  }

  async function dependencies(dir) {
    const pkg = readJson(path.join(dir, 'package.json'));
    const lock = readJson(path.join(dir, 'package-lock.json'));
    if (JSON.stringify(canonical(pkg.dependencies)) !== JSON.stringify(canonical(lock.packages?.['']?.dependencies))) throw new Error('Dependency lock does not match package');
    const key = dependencyKey(lock);
    const relative = path.join('.signage', 'dependencies', key);
    const target = within(root, relative);
    const valid = () => {
      try {
        return readJson(path.join(target, 'complete.json')).key === key &&
          fs.existsSync(path.join(target, 'node_modules/electron/dist/electron.exe')) &&
          readJson(path.join(target, 'node_modules/electron/package.json')).version === lock.packages['node_modules/electron'].version &&
          readJson(path.join(target, 'node_modules/ws/package.json')).version === lock.packages['node_modules/ws'].version;
      } catch (_) { return false; }
    };
    if (valid()) return relative;
    const stageRel = path.join('staging', 'deps-' + crypto.randomUUID());
    const stage = within(store, stageRel);
    fs.mkdirSync(stage, { recursive: true });
    try {
      for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(dir, name), path.join(stage, name));
      if (hooks.installDependencies) await hooks.installDependencies(stage);
      else {
        const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
        if (!fs.existsSync(npmCli)) throw new Error('npm runtime is missing');
        log(`Installing locked modules ${key.slice(0, 24)}`);
        await tool(process.execPath, [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--fetch-retries=0', '--fetch-timeout=15000',
          '--cache', path.join(store, 'npm-cache')], { cwd: stage, timeout: 180000,
          env: { ...process.env, ELECTRON_CACHE: path.join(store, 'electron-cache') } });
      }
      if (!fs.existsSync(path.join(stage, 'node_modules/electron/dist/electron.exe'))) throw new Error('Electron installation incomplete');
      atomicJson(path.join(stage, 'complete.json'), { key });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target)) removeOwned(path.join('dependencies', key));
      fs.renameSync(stage, target);
      if (!valid()) throw new Error('Installed modules do not match lockfile');
      return relative;
    } finally { if (fs.existsSync(stage)) removeOwned(stageRel); }
  }

  async function prepareLocal() {
    const pkg = readJson(path.join(root, 'package.json'));
    const modules = await dependencies(root);
    const descriptor = { id: `local-${pkg.version}-${path.basename(modules)}`, version: pkg.version, dir: '.', modules, legacy: false };
    if (!playable(descriptor)) throw new Error('Local player is incomplete');
    return descriptor;
  }

  async function stageRelease(manifest) {
    const dirRel = path.join('.signage', 'releases', manifest.id);
    const destination = within(root, dirRel);
    try {
      const saved = readJson(path.join(destination, 'release.json'));
      if (saved.id === manifest.id && playable(saved)) return saved;
    } catch (_) { }
    const stageRel = path.join('staging', 'release-' + crypto.randomUUID());
    const stage = within(store, stageRel);
    const unpacked = path.join(stage, 'files');
    fs.mkdirSync(unpacked, { recursive: true });
    try {
      log(`Downloading client ${manifest.version}`);
      const bytes = await get(manifest.url, { timeout: 30000, maxBytes: manifest.size });
      if (bytes.length !== manifest.size || sha256(bytes) !== manifest.sha256) throw new Error('Package checksum/size mismatch');
      const archive = path.join(stage, 'client.zip');
      fs.writeFileSync(archive, bytes);
      await extract(archive, unpacked);
      for (const forbidden of ['config.json', 'cache', 'node_modules', 'credentials', '.signage', '.git']) {
        if (fs.existsSync(path.join(unpacked, forbidden))) throw new Error(`Release contains mutable data: ${forbidden}`);
      }
      for (const name of ['main.js', 'preload.js', 'supervisor-health.js', 'live-delivery.js', 'player.html', 'setup.html', 'waiting.html', 'updater.js', 'extract.ps1', 'package-lock.json']) {
        if (!fs.existsSync(path.join(unpacked, name))) throw new Error(`Missing release file: ${name}`);
      }
      if (readJson(path.join(unpacked, 'package.json')).version !== manifest.version) throw new Error('Package version mismatch');
      for (const name of ['main.js', 'preload.js', 'updater.js']) await tool(process.execPath, ['--check', path.join(unpacked, name)], { timeout: 10000 });
      const modules = await dependencies(unpacked);
      const descriptor = { id: manifest.id, version: manifest.version, dir: dirRel, modules, legacy: false };
      atomicJson(path.join(unpacked, 'release.json'), descriptor);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (fs.existsSync(destination)) removeOwned(path.join('releases', manifest.id));
      fs.renameSync(unpacked, destination);
      return descriptor;
    } finally { if (fs.existsSync(stage)) removeOwned(stageRel); }
  }

  async function checkForUpdate() {
    let config = {};
    try { config = readJson(path.join(root, 'config.json')); } catch (_) { }
    const base = new URL(config.hostUrl || 'https://signage.yebom.org');
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
      throw new Error('Automatic executable updates require HTTPS');
    }
    const url = new URL('/updates/client.json', base).href;
    const bytes = await get(url, { timeout: 5000, maxBytes: 256 * 1024 });
    const manifest = validateManifest(JSON.parse(bytes.toString('utf8')), base);
    state.serverVersion = manifest.serverVersion || 'unknown';
    state.lastCheckAt = new Date().toISOString(); save();
    log(`Server ${state.serverVersion}; published client ${manifest.version}`);
    if (state.rejected.includes(manifest.id)) return null;
    const currentVersion = state.active?.version || '0.0.0';
    if (compareVersions(manifest.version, currentVersion) <= 0) return null;
    return stageRelease(manifest);
  }

  function begin(descriptor) { state.pending = descriptor; save(); }
  function accept(descriptor) {
    if (state.active?.id !== descriptor.id) state.previous = state.active;
    state.active = descriptor; state.pending = null; save();
    log(`Healthy client ${descriptor.version} activated`);
  }
  function rollback(reason) {
    if (!playable(state.previous)) return false;
    state.rejected = [...state.rejected, state.active.id].slice(-12);
    state.active = state.previous; state.previous = null; state.pending = null; save();
    log(`Rolled back to ${state.active.version}: ${reason}`);
    return true;
  }

  function startPlayer(descriptor) {
    const runId = crypto.randomUUID();
    const runDir = within(store, path.join('runs', runId));
    fs.mkdirSync(runDir, { recursive: true });
    const env = { ...process.env, SIGNAGE_DATA_DIR: root, SIGNAGE_MODULES_DIR: modulesPath(descriptor),
      SIGNAGE_RUN_ID: runId, SIGNAGE_HEALTH_FILE: path.join(runDir, 'health.json'),
      SIGNAGE_STOP_FILE: path.join(runDir, 'stop.json'), SIGNAGE_UPDATE_REQUEST: path.join(runDir, 'update.json') };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronPath(descriptor), [sourcePath(descriptor)], {
      cwd: sourcePath(descriptor), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const capture = data => {
      try {
        const file = path.join(store, 'player.log');
        if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.old');
        fs.appendFileSync(file, data);
      } catch (_) { }
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const run = { child, runId, runDir, descriptor, startedAt: Date.now(), exited: false, error: null };
    child.once('exit', () => { run.exited = true; });
    child.once('error', error => { run.exited = true; run.error = error; });
    log(`Starting ${descriptor.version}; PID ${child.pid}`);
    return run;
  }
  const intentionalStop = run => {
    try { return readJson(path.join(run.runDir, 'stop.json')).runId === run.runId; } catch (_) { return false; }
  };
  const healthy = run => {
    if (run.exited) return false;
    if (run.descriptor.legacy) return true;
    try {
      const health = readJson(path.join(run.runDir, 'health.json'));
      return health.runId === run.runId && health.pid === run.child.pid && health.version === run.descriptor.version &&
        health.ready === true && Date.now() - health.at < 20000 && health.at <= Date.now() + 5000;
    } catch (_) { return false; }
  };
  async function stopPlayer(run) {
    atomicJson(path.join(run.runDir, 'update.json'), { runId: run.runId });
    for (let i = 0; i < 20 && !run.exited; i++) await delay(500);
    if (!run.exited) await killTree(run.child);
  }

  async function supervise({ stabilityMs = 15000, healthTimeoutMs = 60000, checkIntervalMs = 30 * 60 * 1000,
    pollMs = 1000, restartDelayMs = 3000 } = {}) {
    let next = null, run = null, checkJob = null, staged = null;
    let stableSince = 0, lastHealthy = 0, crashes = [], nextCheck = 0;
    try { next = await checkForUpdate(); } catch (e) { log(`Update unavailable; keeping installed player: ${e.message}`); }
    if (!next && state.active?.dir === '.' && !state.active.legacy && state.active.modules === '.') {
      try { next = await prepareLocal(); }
      catch (e) { log(`Bundled module verification deferred: ${e.message}`); }
    }
    nextCheck = Date.now() + checkIntervalMs;
    for (;;) {
      if (!run) {
        let descriptor = next || state.active;
        next = null;
        if (!playable(descriptor)) {
          try { descriptor = await prepareLocal(); }
          catch (e) { log(`Waiting for installation: ${e.message}`); await delay(60000); continue; }
        }
        if (descriptor.id !== state.active?.id) begin(descriptor);
        run = startPlayer(descriptor); stableSince = 0; lastHealthy = Date.now();
      }
      if (intentionalStop(run) || (run.descriptor.legacy && run.exited && run.child.exitCode === 0)) {
        state.pending = null; save(); log('Player deliberately stopped; supervisor exiting'); return;
      }
      const good = healthy(run);
      if (good) {
        lastHealthy = Date.now();
        if (!stableSince) stableSince = Date.now();
        if (state.pending && Date.now() - stableSince >= stabilityMs) accept(run.descriptor);
      } else stableSince = 0;
      if (run.exited || Date.now() - lastHealthy > healthTimeoutMs || (state.pending && Date.now() - run.startedAt > healthTimeoutMs * 2)) {
        const reason = run.error?.message || (run.exited ? `exit ${run.child.exitCode}` : 'renderer heartbeat timed out');
        log(`Player failed: ${reason}`);
        if (!run.exited) await stopPlayer(run);
        if (state.pending) rejectPending(reason);
        else {
          crashes = crashes.filter(at => Date.now() - at < 5 * 60 * 1000); crashes.push(Date.now());
          if (crashes.length >= 3 && rollback(reason)) crashes = [];
        }
        run = null;
        await delay(Math.min(60000, Math.max(restartDelayMs, crashes.length * restartDelayMs)));
        continue;
      }
      // Stage updates while the current display keeps playing. Only switch after
      // download, integrity checks and dependency installation have succeeded.
      if (!state.pending && !checkJob && Date.now() >= nextCheck) {
        nextCheck = Date.now() + checkIntervalMs;
        checkJob = checkForUpdate().then(value => { staged = value; }).catch(e => log(`Background update skipped: ${e.message}`)).finally(() => { checkJob = null; });
      }
      if (staged && !state.pending) {
        next = staged; staged = null;
        await stopPlayer(run); run = null;
        continue;
      }
      await delay(pollMs);
    }
  }
  return { root, store, state, playable, dependencies, prepareLocal, stageRelease, checkForUpdate, begin, accept,
    rejectPending, rollback, healthy, intentionalStop, supervise, log };
}

module.exports = { createUpdater, within, atomicJson, compareVersions, dependencyKey, validateManifest, download, runTool, sha256 };
if (require.main === module) {
  const index = process.argv.indexOf('--root');
  const root = index >= 0 ? process.argv[index + 1] : __dirname;
  try {
    const updater = createUpdater(root);
    updater.supervise().catch(error => { updater.log(`Supervisor failed: ${error.stack}`); process.exitCode = 1; });
  } catch (error) { console.error(error); process.exitCode = 1; }
}
