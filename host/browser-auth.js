const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Only signed, revocable credentials are stored in the browser, never passwords.
module.exports = function browserAuth(app, dataDir, env = process.env) {
  const passwords = { admin: env.ADMIN_PASSWORD || '', camera: env.CAMERA_PASSWORD || '' };
  const file = path.join(dataDir, 'browser-auth.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const save = () => {
    fs.writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  };
  if (!state) { state = { secret: crypto.randomBytes(32).toString('hex'), admin: 0, camera: 0 }; save(); }
  const sign = value => crypto.createHmac('sha256', state.secret).update(value).digest('base64url');
  const equal = (a, b) => {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const name = role => `signage_${role}`;
  const lifetime = 365 * 24 * 3600 * 1000;
  const secure = /^https:/.test(env.PUBLIC_BASE_URL || '');
  const options = { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: lifetime };
  const fingerprint = role => sign(passwords[role]);
  function check(req, role) {
    if (!passwords[role]) return role === 'admin' && env.NODE_ENV !== 'production' && !env.RAILWAY_ENVIRONMENT_ID;
    const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name(role) + '='));
    if (!cookie) return false;
    const [payload, signature] = cookie.slice(name(role).length + 1).split('.');
    if (!payload || !signature || !equal(sign(payload), signature)) return false;
    try {
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return value.role === role && value.until > Date.now() && value.epoch === state[role] && value.password === fingerprint(role);
    } catch { return false; }
  }
  function sameOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    if (!req.headers.origin) return true; // Native clients and local tooling have no Origin.
    try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
  }
  function guard(role) {
    return (req, res, next) => {
      res.set('Cache-Control', 'no-store');
      if (!check(req, role)) {
        if (req.method === 'GET' && !req.originalUrl.startsWith('/api/') && !req.originalUrl.startsWith('/live/api/')) {
          return res.redirect(`/login?role=${role}`);
        }
        return res.status(401).json({ error: '암호를 입력하여 다시 연결해 주세요.' });
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req)) return res.status(403).json({ error: '다른 사이트에서 보낸 요청입니다.' });
      next();
    };
  }
  const attempts = new Map();
  const sweep = setInterval(() => { for (const [key, item] of attempts) if (item.until < Date.now()) attempts.delete(key); }, 60000);
  sweep.unref();
  app.get('/login', (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public', 'login.html')); });
  app.post('/auth/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!sameOrigin(req)) return res.sendStatus(403);
    const role = req.body.role;
    if (!['admin', 'camera'].includes(role)) return res.sendStatus(400);
    if (!passwords[role]) return res.status(503).json({ error: '서버에 접속 암호가 아직 설정되지 않았습니다.' });
    const key = `${req.ip}:${role}`, now = Date.now();
    let attempt = attempts.get(key);
    if (!attempt || attempt.until < now) { attempt = { count: 0, until: now + 15 * 60000 }; attempts.set(key, attempt); }
    if (attempt.count >= 10) return res.status(429).json({ error: '잠시 후 다시 시도해 주세요. (최대 15분)' });
    attempt.count++;
    if (!equal(String(req.body.password || ''), passwords[role])) return res.status(401).json({ error: '암호를 확인해 주세요.' });
    attempts.delete(key);
    const payload = Buffer.from(JSON.stringify({ role, until: now + lifetime, epoch: state[role], password: fingerprint(role) })).toString('base64url');
    res.cookie(name(role), `${payload}.${sign(payload)}`, options);
    res.json({ success: true, redirect: role === 'admin' ? '/index.html' : '/camera' });
  });
  app.post('/auth/logout', (req, res) => {
    if (!sameOrigin(req)) return res.sendStatus(403);
    for (const role of ['admin', 'camera']) res.clearCookie(name(role), { ...options, maxAge: undefined });
    res.json({ success: true });
  });
  app.post('/auth/revoke', guard('admin'), (req, res) => {
    const role = req.body.role;
    if (!['admin', 'camera'].includes(role)) return res.sendStatus(400);
    state[role]++; save(); res.json({ success: true });
  });
  return { check, guard, configured: role => !!passwords[role], sameOrigin };
};
