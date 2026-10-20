const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const sharp = require('../../host/node_modules/sharp');
const { ContentLibrary } = require('../../host/content-library');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function contentFixture({ password = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-content-'));
  const uploads = path.join(root, 'uploads'); fs.mkdirSync(uploads);
  const image = await sharp({ create: { width: 120, height: 68, channels: 3, background: '#6087ae' } }).png().toBuffer();
  const names = ['unused', 'second', 'used', 'quote'];
  const content = names.map(name => ({ id: name === 'quote' ? "quote-'id" : name, filename: name + '.png', originalName: name === 'quote' ? "행사 <안내>&'최종.png" : name + '.png', size: image.length, mimeType: 'image/png', source: 'local', uploadedAt: '2026-01-01T00:00:00Z' }));
  for (const file of content) fs.writeFileSync(path.join(uploads, file.filename), image);
  fs.writeFileSync(path.join(root, 'content.json'), JSON.stringify(content));
  fs.writeFileSync(path.join(root, 'sites.json'), JSON.stringify([{ id: 'lobby', name: '로비', monitors: 2 }, { id: 'dining', name: '식당', monitors: 2 }]));
  const item = { file: 'used.png', enabled: false, validTo: '2000-01-01', duration: 10, transition: 'fade' };
  fs.writeFileSync(path.join(root, 'schedule.json'), JSON.stringify({ sheets: [
    { id: 'live', siteId: 'lobby', name: '기본', type: 'sync', rules: [], rows: [], a: [], b: [] },
    { id: 'history', siteId: 'dining', name: '지난 행사', type: 'separate', rules: [], rows: [], a: [item], b: [item] },
    { id: 'sync', siteId: 'lobby', name: '대기 큐시트', type: 'sync', rules: [], rows: [{ file1: 'used.png', file2: 'used.png', enabled: false }], a: [], b: [] }
  ], siteState: { lobby: { defaultId: 'live' }, dining: { defaultId: 'history' } } }));
  // Drive 원본/API가 없어도 휴지통의 보존 사본으로 복원한다.
  fs.writeFileSync(path.join(uploads, 'gdrive_drive-1_picture.png'), image);
  const library = new ContentLibrary({ dataDir: root, uploadsDir: uploads });
  await library.trash({ id: 'drive-1', filename: 'gdrive_drive-1_picture.png', originalName: 'Drive 보관 사진.png', size: image.length, mimeType: 'image/png', source: 'gdrive' }, () => []);
  let child, logs = '', cookie = '', base;
  async function start() {
    const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    base = 'http://127.0.0.1:' + port; logs = '';
    child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '../../host'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port), DATA_DIR: root, UPLOADS_DIR: uploads, ADMIN_PASSWORD: password, CAMERA_PASSWORD: '', NODE_ENV: 'test', RAILWAY_ENVIRONMENT_ID: '', GOOGLE_SERVICE_ACCOUNT_KEY: '', GDRIVE_FOLDER_ID: 'test' } });
    child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
    for (let i = 0; i < 200; i++) {
      if (await fetch(base + '/login').then(r => r.ok, () => false)) return;
      if (child.exitCode !== null) throw new Error('Server exited: ' + logs);
      await sleep(100);
    }
    throw new Error('Server start timeout: ' + logs);
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const done = new Promise(resolve => child.once('exit', resolve)); child.kill(); await done;
  }
  async function api(route, method = 'GET', body) {
    const response = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  }
  async function login() {
    const response = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'admin', password }) });
    if (!response.ok) throw new Error('Test login failed');
    cookie = response.headers.get('set-cookie').split(';')[0];
  }
  async function cleanup() {
    await stop();
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('signage-content-')) throw new Error('Unsafe test cleanup');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  try { await start(); } catch (error) { await cleanup(); throw error; }
  return { get base() { return base; }, root, uploads, content, image, api, login, start, stop, cleanup };
};
