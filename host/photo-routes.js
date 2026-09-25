'use strict';
const crypto = require('node:crypto');
const { PHOTO_SCOPE } = require('./photo-archive');

function mountPhotoRoutes(app, archive, removeFromScreen) {
  const oauthStates = new Map();
  const pickerSessions = new Map();
  const prune = () => {
    for (const map of [oauthStates, pickerSessions]) for (const [key, value] of map) if (value.expires < Date.now()) map.delete(key);
  };
  const cleanup = setInterval(prune, 60000); cleanup.unref();
  const cookieValue = (req, name) => String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1);
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
      if (!archive.status().pickerConfigured) return res.status(503).send('Google 폴더 선택 기능 설정이 필요합니다. 사진 보관함 안내를 확인해 주세요.');
      const auth = archive.oauthClient();
      const now = Date.now();
      for (const [key, entry] of oauthStates) if (entry.expires < now) oauthStates.delete(key);
      if (oauthStates.size >= 100) return res.status(429).send('잠시 후 다시 연결해 주세요.');
      const state = crypto.randomBytes(32).toString('hex');
      const binding = crypto.randomBytes(32).toString('hex');
      oauthStates.set(state, { binding, expires: now + 600000 });
      res.cookie('photo_oauth', binding, { httpOnly: true, secure: archive.redirectUri.startsWith('https:'), sameSite: 'lax', maxAge: 600000, path: '/api/photos/oauth' });
      res.redirect(auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', include_granted_scopes: false, scope: [PHOTO_SCOPE], state }));
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
      prune();
      if (pickerSessions.size >= 100) return res.status(429).send('잠시 후 다시 연결해 주세요.');
      const auth = await archive.connect(String(req.query.code));
      const id = crypto.randomBytes(32).toString('hex');
      pickerSessions.set(id, { auth, expires: Date.now() + 600000 });
      res.cookie('photo_picker', id, { httpOnly: true, secure: archive.redirectUri.startsWith('https:'), sameSite: 'strict', maxAge: 600000, path: '/api/photos/picker' });
      res.redirect('/photos?connection=select-folder');
    } catch (e) { res.redirect('/photos?connection=' + (e.code === 'PHOTO_SCOPE_MISMATCH' ? 'scope-required' : 'failed')); }
  });
  app.use('/api/photos/picker', (req, res, next) => {
    res.set('Referrer-Policy', 'no-referrer');
    if (req.method !== 'POST' || req.get('origin') !== new URL(archive.redirectUri).origin) return res.sendStatus(403);
    prune();
    req.pickerId = cookieValue(req, 'photo_picker');
    req.pickerSession = pickerSessions.get(req.pickerId);
    if (!req.pickerSession) return res.status(401).json({ error: '연결 시간이 만료되었습니다. Google 계정 연결부터 다시 시작해 주세요.' });
    next();
  });
  app.post('/api/photos/picker/config', async (req, res) => {
    try {
      const token = await req.pickerSession.auth.getAccessToken();
      if (!token.token) throw new Error('Missing access token');
      res.json({ accessToken: token.token, developerKey: archive.pickerKey, appId: archive.pickerAppId, folderId: archive.folderId });
    } catch { res.status(401).json({ error: 'Google 계정을 다시 연결해 주세요.' }); }
  });
  app.post('/api/photos/picker/select', async (req, res) => {
    const session = req.pickerSession;
    if (session.saving) return res.status(409).json({ error: '폴더 연결을 저장하고 있습니다.' });
    if (req.body?.folderId !== archive.folderId) return res.status(400).json({ error: '미리 지정한 photos 보관 폴더를 선택해 주세요.' });
    session.saving = true;
    try {
      await archive.serialize(() => archive.completeConnection(session.auth, req.body.folderId));
      pickerSessions.delete(req.pickerId);
      res.clearCookie('photo_picker', { path: '/api/photos/picker' });
      archive.cycle(true).catch(() => {});
      res.json({ success: true });
    } catch { session.saving = false; res.status(400).json({ error: '선택한 폴더의 접근·편집 권한을 확인하지 못했습니다. 폴더 선택을 다시 시도해 주세요.' }); }
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
