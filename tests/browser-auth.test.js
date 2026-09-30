const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('../host/node_modules/express');
const createAuth = require('../host/browser-auth');

test('browser login isolates roles, rejects CSRF, persists across restart and revokes old sessions', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-auth-'));
  const servers = [];
  t.after(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function start(extra = {}) {
    const app = express(); app.use(express.json());
    const auth = createAuth(app, dir, { ADMIN_PASSWORD: 'test-admin', CAMERA_PASSWORD: 'test-camera', NODE_ENV: 'production', ...extra });
    app.get('/api/test', auth.guard('admin'), (req, res) => res.json({ ok: true }));
    app.post('/api/test', auth.guard('admin'), (req, res) => res.json({ ok: true }));
    app.get('/live/api/test', auth.guard('camera'), (req, res) => res.json({ ok: true }));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (url, body, cookie, origin) => fetch(base + url, {
      method: body ? 'POST' : 'GET', redirect: 'manual',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return request;
  }
  const request = await start();
  assert.equal((await request('/api/test')).status, 401);
  assert.equal((await request('/auth/login', { role: 'admin', password: 'wrong' })).status, 401);
  const admin = await request('/auth/login', { role: 'admin', password: 'test-admin' });
  const cookie = admin.headers.get('set-cookie').split(';')[0];
  assert.match(admin.headers.get('set-cookie'), /HttpOnly/);
  assert.match(admin.headers.get('set-cookie'), /SameSite=Lax/);
  assert.ok(!cookie.includes('test-admin'));
  assert.equal((await request('/api/test', null, cookie)).status, 200);
  assert.equal((await request('/live/api/test', null, cookie)).status, 401);
  assert.equal((await request('/api/test', {change:true}, cookie, 'https://attacker.example')).status, 403);
  assert.equal((await request('/auth/login', {role:'admin',password:'test-admin'}, null, 'https://attacker.example')).status, 403);
  const camera = await request('/auth/login', {role:'camera',password:'test-camera'});
  const cameraCookie = camera.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/test', null, cameraCookie)).status, 401);
  assert.equal((await request('/live/api/test', null, cameraCookie)).status, 200);
  assert.equal((await request('/auth/revoke', {role:'admin'}, cameraCookie)).status, 401);
  assert.equal((await request('/auth/revoke', {role:'camera'}, cookie)).status, 200);
  assert.equal((await request('/live/api/test', null, cameraCookie)).status, 401);
  const restarted = await start();
  assert.equal((await restarted('/api/test', null, cookie)).status, 200);
  const changed = await start({ADMIN_PASSWORD:'changed'});
  assert.equal((await changed('/api/test', null, cookie)).status, 401);
  const missing = await start({ADMIN_PASSWORD:''});
  assert.equal((await missing('/api/test')).status, 401);
  assert.equal((await missing('/auth/login', {role:'admin',password:''})).status, 503);
  assert.equal((await request('/api/test', null, cookie + 'tampered')).status, 401);
  for (let i = 0; i < 10; i++) await request('/auth/login', {role:'admin',password:'wrong'});
  assert.equal((await request('/auth/login', {role:'admin',password:'test-admin'})).status, 429);
});
