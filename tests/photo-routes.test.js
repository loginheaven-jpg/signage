const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('../host/node_modules/express');
const { mountPhotoRoutes } = require('../host/photo-routes');

test('photo APIs inherit administrator authentication; OAuth binds state to browser and consumes it once', async t => {
  const app = express();
  app.use(express.json());
  const calls = [];
  const archive = {
    status: () => ({ ready: false, pickerConfigured: true }),
    folderId: 'configured-folder', pickerKey: 'public-browser-key', pickerAppId: '12345',
    redirectUri: 'https://signage.yebom.org/api/photos/oauth/callback',
    oauthClient: () => ({ generateAuthUrl: options => 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams(options) }),
    serialize: fn => fn(), connect: async code => { calls.push(code); return { getAccessToken: async () => ({ token: 'short-lived-token' }) }; },
    completeConnection: async (auth, folderId) => { calls.push(folderId); }, cycle: async () => {}
  };
  app.use('/api', (req, res, next) => req.headers.authorization === 'Basic test' ? next() : res.sendStatus(401));
  mountPhotoRoutes(app, archive, () => {});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + '/api/photos/status')).status, 401);
  const headers = { authorization: 'Basic test' };
  const start = await fetch(base + '/api/photos/oauth/start', { headers, redirect: 'manual' });
  assert.equal(start.status, 302);
  const auth = new URL(start.headers.get('location'));
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  assert.equal(auth.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(auth.searchParams.get('include_granted_scopes'), 'false');
  const state = auth.searchParams.get('state');
  const cookie = start.headers.get('set-cookie').split(';')[0];
  assert.match(start.headers.get('set-cookie'), /HttpOnly/);
  assert.match(start.headers.get('set-cookie'), /Secure/);
  // Missing cookie cannot connect another person's account via a forged callback.
  const rejected = await fetch(base + '/api/photos/oauth/callback?state=' + state + '&code=stolen', { headers });
  assert.equal(rejected.status, 400); assert.equal(calls.length, 0);
  const second = await fetch(base + '/api/photos/oauth/start', { headers, redirect: 'manual' });
  const state2 = new URL(second.headers.get('location')).searchParams.get('state');
  const callback = base + '/api/photos/oauth/callback?state=' + state2 + '&code=valid';
  assert.equal((await fetch(callback, { headers: { ...headers, cookie }, redirect: 'manual' })).status, 400);
  const third = await fetch(base + '/api/photos/oauth/start', { headers, redirect: 'manual' });
  const state3 = new URL(third.headers.get('location')).searchParams.get('state');
  const headers3 = { ...headers, cookie: third.headers.get('set-cookie').split(';')[0] };
  const valid = base + '/api/photos/oauth/callback?state=' + state3 + '&code=valid';
  const result = await fetch(valid, { headers: headers3, redirect: 'manual' });
  assert.equal(result.status, 302); assert.equal(result.headers.get('location'), '/photos?connection=select-folder');
  assert.deepEqual(calls, ['valid']);
  assert.equal((await fetch(valid, { headers: headers3, redirect: 'manual' })).status, 400);
  const pickerCookie = result.headers.getSetCookie().find(s => s.startsWith('photo_picker=')).split(';')[0];
  const pickerHeaders = { ...headers, cookie: pickerCookie, origin: 'https://signage.yebom.org', 'Content-Type': 'application/json' };
  const configURL = base + '/api/photos/picker/config';
  assert.equal((await fetch(configURL, { method: 'POST', headers })).status, 403);
  assert.equal((await fetch(configURL, { method: 'POST', headers: { ...pickerHeaders, cookie: '' } })).status, 401);
  assert.equal((await fetch(configURL, { method: 'POST', headers: { ...pickerHeaders, origin: 'https://attacker.example' } })).status, 403);
  const config = await fetch(configURL, { method: 'POST', headers: pickerHeaders });
  assert.match(config.headers.get('cache-control'), /no-store/);
  assert.equal((await config.json()).accessToken, 'short-lived-token');
  const select = folderId => fetch(base + '/api/photos/picker/select', { method: 'POST', headers: pickerHeaders, body: JSON.stringify({ folderId }) });
  assert.equal((await select('other-folder')).status, 400);
  assert.deepEqual(calls, ['valid'], 'wrong folder must not replace the active connection');
  assert.equal((await select('configured-folder')).status, 200);
  assert.deepEqual(calls, ['valid', 'configured-folder']);
  assert.equal((await select('configured-folder')).status, 401, 'successful session cannot be replayed');
});
