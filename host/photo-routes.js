'use strict';
const crypto = require('node:crypto');

function mountPhotoRoutes(app, archive, removeFromScreen) {
  const oauthStates = new Map();
  app.use('/api/photos', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['sec-fetch-site'] === 'cross-site') return res.sendStatus(403);
    next();
  });
  app.get('/api/photos/status', (req, res) => res.json(archive.status()));
  app.get('/api/photos', (req, res) => {
    const date = String(req.query.date || '');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '날짜를 확인해 주세요.' });
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    res.json({ ...archive.list({ date, offset }), status: archive.status() });
  });
  app.post('/api/photos/sync', (req, res) => {
    archive.cycle(true).catch(() => {});
    res.status(202).json({ success: true });
  });
  app.get('/api/photos/oauth/start', (req, res) => {
    try {
      const auth = archive.oauthClient();
      const now = Date.now();
      for (const [key, entry] of oauthStates) if (entry.expires < now) oauthStates.delete(key);
      if (oauthStates.size >= 100) return res.status(429).send('잠시 후 다시 연결해 주세요.');
      const state = crypto.randomBytes(32).toString('hex');
      const binding = crypto.randomBytes(32).toString('hex');
      oauthStates.set(state, { binding, expires: now + 600000 });
      res.cookie('photo_oauth', binding, { httpOnly: true, secure: archive.redirectUri.startsWith('https:'), sameSite: 'lax', maxAge: 600000, path: '/api/photos/oauth' });
      res.redirect(auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/drive'], state }));
    } catch { res.status(503).send('Google 계정 연결 준비가 필요합니다. 서버의 Google OAuth 설정을 확인해 주세요.'); }
  });
  app.get('/api/photos/oauth/callback', async (req, res) => {
    const state = String(req.query.state || '');
    const entry = oauthStates.get(state);
    oauthStates.delete(state);
    const cookie = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('photo_oauth='))?.slice('photo_oauth='.length);
    res.clearCookie('photo_oauth', { path: '/api/photos/oauth' });
    res.set('Referrer-Policy', 'no-referrer');
    if (!entry || entry.expires < Date.now() || cookie !== entry.binding) return res.status(400).send('연결 요청이 만료되었습니다. 사진 보관함에서 다시 시작해 주세요.');
    if (req.query.error || !req.query.code) return res.redirect('/photos?connection=cancelled');
    try {
      await archive.serialize(() => archive.connect(String(req.query.code)));
      archive.cycle(true).catch(() => {});
      res.redirect('/photos?connection=success');
    } catch { res.redirect('/photos?connection=failed'); }
  });
  app.get('/api/photos/:id/image', (req, res, next) => {
    archive.image(req.params.id, res, req.query.download === '1').catch(next);
  });
  app.delete('/api/photos/:id', (req, res) => {
    if (!archive.markDelete(req.params.id)) return res.status(404).json({ error: '사진을 찾을 수 없습니다.' });
    removeFromScreen(req.params.id);
    archive.cycle().catch(() => {});
    res.status(202).json({ success: true, status: 'deleting' });
  });
}
module.exports = { mountPhotoRoutes };
