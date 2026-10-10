const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('../host/node_modules/express');
const { mountPhotoRoutes } = require('../host/photo-routes');

test('library API validates folder/type filters and passes the complete selection to the archive', async t => {
  const app = express(), calls = [];
  const archive = {
    status: () => ({ ready: true }),
    list: filters => { calls.push(filters); return { total: 0, photos: [], counts: { photos: 0, videos: 0 }, folders: { years: [], rootTotal: 0, awaitingTotal: 0 } }; }
  };
  mountPhotoRoutes(app, archive, () => {});
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/photos';
  const response = await fetch(base + '?year=2025&yearId=year-2025&eventId=event-a&kind=video&date=2026-10-11&offset=40');
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], { year: '2025', yearId: 'year-2025', eventId: 'event-a', kind: 'video', date: '2026-10-11', scope: '', offset: 40 });
  assert.deepEqual((await response.json()).counts, { photos: 0, videos: 0 });
  assert.equal((await fetch(base + '?scope=root&kind=photo')).status, 200);
  for (const query of ['year=202', 'year=2026&yearId=bad/id', 'yearId=year-2025', 'year=2026&eventId=bad/id', 'eventId=event-a', 'scope=root&year=2026', 'scope=outside', 'kind=audio']) {
    assert.equal((await fetch(base + '?' + query)).status, 400, query);
  }
  assert.equal(calls.length, 2, 'invalid inputs never reach the inventory');
});

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
  assert.equal((await fetch(base + '/api/photos/folders')).status, 401);
  const headers = { authorization: 'Basic test' };
  const start = await fetch(base + '/api/photos/oauth/start?picker=1', { headers, redirect: 'manual' });
  assert.equal(start.status, 302);
  const auth = new URL(start.headers.get('location'));
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  assert.equal(auth.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive');
  assert.equal(auth.searchParams.get('include_granted_scopes'), 'false');
  const state = auth.searchParams.get('state');
  const cookie = start.headers.get('set-cookie').split(';')[0];
  assert.match(start.headers.get('set-cookie'), /HttpOnly/);
  assert.match(start.headers.get('set-cookie'), /Secure/);
  // Missing cookie cannot connect another person's account via a forged callback.
  const rejected = await fetch(base + '/api/photos/oauth/callback?state=' + state + '&code=stolen', { headers });
  assert.equal(rejected.status, 400); assert.equal(calls.length, 0);
  const second = await fetch(base + '/api/photos/oauth/start?picker=1', { headers, redirect: 'manual' });
  const state2 = new URL(second.headers.get('location')).searchParams.get('state');
  const callback = base + '/api/photos/oauth/callback?state=' + state2 + '&code=valid';
  assert.equal((await fetch(callback, { headers: { ...headers, cookie }, redirect: 'manual' })).status, 400);
  const third = await fetch(base + '/api/photos/oauth/start?picker=1', { headers, redirect: 'manual' });
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
  // A failed token exchange reports why as a fixed code, never Google's response text.
  archive.connect = async () => { throw Object.assign(new Error('secret detail'), { response: { data: { error: 'invalid_client', error_description: 'secret detail' } } }); };
  const fourth = await fetch(base + '/api/photos/oauth/start?picker=1', { headers, redirect: 'manual' });
  const state4 = new URL(fourth.headers.get('location')).searchParams.get('state');
  const failed = await fetch(base + '/api/photos/oauth/callback?state=' + state4 + '&code=valid',
    { headers: { ...headers, cookie: fourth.headers.get('set-cookie').split(';')[0] }, redirect: 'manual' });
  assert.equal(failed.headers.get('location'), '/photos?connection=failed&reason=invalid_client');
});

test('administrator consent completes the shared fixed-root connection without Picker and remains admin-only', async t => {
  const app = express(); const calls = [];
  app.use('/api', (req, res, next) => req.headers.authorization === 'Basic admin' ? next() : res.sendStatus(401));
  const archive = {
    folderId: 'church-root', redirectUri: 'https://signage.yebom.org/api/photos/oauth/callback',
    status: () => ({ oauthConfigured: true, pickerConfigured: false }),
    oauthClient: () => ({ generateAuthUrl: options => 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams(options) }),
    connect: async code => { calls.push(code); return { credentials: { refresh_token: 'server-only' } }; },
    serialize: fn => fn(), completeConnection: async (auth, root) => { assert.equal(auth.credentials.refresh_token, 'server-only'); calls.push(root); },
    cycle: async () => { calls.push('wake'); }
  };
  mountPhotoRoutes(app, archive, () => {});
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + '/api/photos/oauth/start', { redirect: 'manual' })).status, 401);
  const headers = { authorization: 'Basic admin' };
  const start = await fetch(base + '/api/photos/oauth/start', { headers, redirect: 'manual' });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const callback = base + '/api/photos/oauth/callback?state=' + state + '&code=admin-consent';
  const completed = await fetch(callback, { headers: { ...headers, cookie }, redirect: 'manual' });
  assert.equal(completed.headers.get('location'), '/photos?connection=success');
  assert.equal(completed.headers.getSetCookie().some(s => s.startsWith('photo_picker=')), false);
  assert.deepEqual(calls, ['admin-consent', 'church-root', 'wake']);
  assert.equal((await fetch(callback, { headers: { ...headers, cookie }, redirect: 'manual' })).status, 400);
  assert.equal((await fetch(base + '/api/photos/oauth/start?picker=1', { headers, redirect: 'manual' })).status, 503);
});
