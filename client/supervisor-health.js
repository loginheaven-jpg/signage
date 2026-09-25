const fs = require('node:fs');

function createHealthMonitor({ app, ipcMain, windows, version, env = process.env, now = Date.now }) {
  const seen = new Map();
  let timer;
  const enabled = !!(env.SIGNAGE_RUN_ID && env.SIGNAGE_HEALTH_FILE);
  function write(file, data) {
    if (!file) return;
    try { fs.writeFileSync(file + '.tmp', JSON.stringify(data)); fs.renameSync(file + '.tmp', file); } catch (_) { }
  }
  ipcMain.on('player-health', (event, status) => { seen.set(event.sender.id, { at: now(), ready: status?.ready === true }); });
  function tick() {
    if (!enabled) return;
    try {
      if (env.SIGNAGE_UPDATE_REQUEST && fs.existsSync(env.SIGNAGE_UPDATE_REQUEST)) {
        const request = JSON.parse(fs.readFileSync(env.SIGNAGE_UPDATE_REQUEST, 'utf8'));
        if (request.runId === env.SIGNAGE_RUN_ID) { app.quit(); return; }
      }
    } catch (_) { }
    const targets = windows().filter(w => w && !w.isDestroyed());
    const ready = targets.length > 0 && targets.every(w => {
      const health = seen.get(w.webContents.id);
      return !w.webContents.isLoading() && health?.ready && now() - health.at < 15000;
    });
    write(env.SIGNAGE_HEALTH_FILE, { runId: env.SIGNAGE_RUN_ID, pid: process.pid, version, ready, at: now() });
  }
  function quit() {
    if (enabled) write(env.SIGNAGE_STOP_FILE, { runId: env.SIGNAGE_RUN_ID, at: now() });
    app.quit();
  }
  if (enabled) timer = setInterval(tick, 5000);
  app.on('will-quit', () => clearInterval(timer));
  return { quit, tick };
}

module.exports = { createHealthMonitor };
