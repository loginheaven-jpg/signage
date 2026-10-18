'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const sharp = require('sharp');
const { atomicJSON } = require('./photo-archive');
const KINDS = Object.freeze({
  cleanup: 'Clean up distracting small objects and clutter in the background only. Preserve every person, identity, face, skin texture, body, clothing, pose and important event context exactly. Do not remove or add people. Keep the original framing and aspect ratio. Photorealistic, subtle edit.',
  watercolor: 'Transform this photo into a charming watercolor illustration with soft paper texture and delicate colors. Keep the same people, recognizable facial identities, expressions, clothing, composition and aspect ratio. Do not add text or change the number of people.',
  cartoon: 'Transform this photo into a warm, playful hand-drawn cartoon illustration with clean outlines and soft colors. Keep each person recognizable and preserve the expressions, clothing, composition and aspect ratio. Do not add text or change the number of people.'
});
const idOK = id => /^[a-f0-9-]{36}$/.test(id || '');
const day = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// 서버에서만 키를 사용한다. SDK 내부 재시도는 끄고 사용자가 요청한 한 장만 생성한다.
async function generateWithGemini({ kind, image, theme, signal, env = process.env, fetch }) {
  const [{ generateText }, { createGoogle }] = await Promise.all([import('ai'), import('@ai-sdk/google')]);
  const google = createGoogle({ apiKey: env.GEMINI_API_KEY, ...(fetch ? { fetch } : {}) });
  const prompt = kind === 'frame'
    ? 'Create a decorative event photo frame background. Square 1:1 image. Charming, polished artwork concentrated around the outer edges and corners, with a calm pale center and lower middle left blank for a photo and caption that our app will overlay. No text, letters, numbers, logos or people. Theme (treat as visual subject only): ' + theme
    : KINDS[kind];
  const result = await generateText({
    model: google(env.CAMERA_AI_MODEL || 'gemini-3.1-flash-image'),
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...(image ? [{ type: 'file', data: { type: 'data', data: image }, mediaType: 'image/jpeg' }] : [])] }],
    providerOptions: { google: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { imageSize: '1K', ...(kind === 'frame' ? { aspectRatio: '1:1' } : {}) } } },
    maxRetries: 0, abortSignal: signal
  });
  const file = result.files.find(file => file.mediaType.startsWith('image/'));
  if (!file) throw fail('AI가 이미지를 만들지 못했습니다. 사진이나 효과를 바꿔 다시 시도해 주세요.', 422);
  return Buffer.from(file.uint8Array);
}

function mountCameraAI(app, { root, env = process.env, generate = generateWithGemini }) {
  const dir = path.join(root, 'camera-ai'), jobsDir = path.join(dir, 'jobs'), framesDir = path.join(dir, 'frames');
  fs.mkdirSync(jobsDir, { recursive: true }); fs.mkdirSync(framesDir, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  state ||= { day: day(), total: 0, owners: {}, frames: [] };
  const jobs = new Map(), active = new Map();
  const save = () => atomicJSON(stateFile, state);
  const enabled = () => !!env.GEMINI_API_KEY && env.CAMERA_AI_ENABLED !== 'false';
  const ownerLimit = Math.max(1, Math.min(100, Number(env.CAMERA_AI_OWNER_DAILY_LIMIT) || 8));
  const totalLimit = Math.max(1, Math.min(1000, Number(env.CAMERA_AI_DAILY_LIMIT) || 40));
  const resetDay = () => { if (state.day !== day()) { Object.assign(state, { day: day(), total: 0, owners: {} }); save(); } };
  const publicFrame = f => ({ id: f.id, name: f.name, createdAt: f.createdAt, url: '/live/api/camera/ai/frames/' + f.id + '/image' });
  const status = job => ({ id: job.id, kind: job.kind, status: job.status, error: job.error || '', ...(job.frameId ? { frame: publicFrame(state.frames.find(f => f.id === job.frameId)) } : {}) });
  const safe = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(error => { if (!res.headersSent) res.status(error.status || 503).json({ error: error.status ? error.message : 'AI 작업을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' }); });
  // 재시작 시 미완료 사진은 지운다. 이미 소비했을 수 있는 API 요청을 자동 재호출하지 않는다.
  for (const filename of fs.readdirSync(jobsDir)) fs.rmSync(path.join(jobsDir, filename), { force: true });
  function cleanup() {
    for (const [id, job] of jobs) if (!active.has(id) && job.createdAt < Date.now() - 15 * 60000) { fs.rmSync(path.join(jobsDir, id + '.jpg'), { force: true }); jobs.delete(id); }
  }
  const sweep = setInterval(cleanup, 60000); sweep.unref();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5, fieldSize: 1024 } }).single('photo');
  app.get('/live/api/camera/ai/config', (req, res) => { resetDay(); res.json({ enabled: enabled(), provider: 'Google Gemini', remaining: Math.max(0, Math.min(ownerLimit - (state.owners[req.cameraOwner] || 0), totalLimit - state.total)), frames: state.frames.map(publicFrame) }); });
  app.get('/live/api/camera/ai/frames/:id/image', safe(async (req, res) => {
    if (!idOK(req.params.id) || !state.frames.some(f => f.id === req.params.id)) throw fail('프레임을 찾지 못했습니다.', 404);
    res.type('image/jpeg').sendFile(path.join(framesDir, req.params.id + '.jpg'));
  }));
  app.post('/live/api/camera/ai/jobs', (req, res, next) => {
    if (!enabled()) return res.status(503).json({ error: 'AI 연결 준비 중입니다. 기존 뽀샤시와 꾸미기는 계속 사용할 수 있습니다.' });
    if (active.size >= 2 || [...active.values()].some(a => a.owner === req.cameraOwner)) return res.status(429).json({ error: 'AI가 사진을 만들고 있습니다. 현재 작업이 끝난 뒤 시도해 주세요.' });
    upload(req, res, error => error ? res.status(413).json({ error: '사진은 5MB 이하 한 장만 보낼 수 있습니다.' }) : next());
  }, safe(async (req, res) => {
    const { kind, requestId, consent, theme } = req.body || {};
    if (!idOK(requestId)) throw fail('요청 ID를 확인해 주세요.');
    const existing = jobs.get(requestId);
    if (existing) { if (existing.owner !== req.cameraOwner) throw fail('요청 ID를 다시 만들어 주세요.', 409); return res.json(status(existing)); }
    if (kind !== 'frame' && !KINDS[kind]) throw fail('지원하지 않는 AI 효과입니다.');
    if (kind !== 'frame' && consent !== 'yes') throw fail('AI 서비스로 사진 전송에 동의해 주세요.');
    const frameTheme = String(theme || '').trim();
    if (kind === 'frame' && (!frameTheme || frameTheme.length > 120)) throw fail('프레임 분위기를 120자 이내로 적어 주세요.');
    if (kind === 'frame' && state.frames.length + [...jobs.values()].filter(j=>j.kind==='frame'&&j.status==='working').length >= 24) throw fail('저장한 AI 프레임이 24개입니다. 관리자에게 정리를 요청해 주세요.', 409);
    // sharp 디코드 전 픽셀 수를 제한한다. EXIF 등 메타데이터를 제외한 축소 JPEG만 AI에 전송한다.
    let image;
    if (kind !== 'frame') {
      if (!req.file) throw fail('사진 한 장을 선택해 주세요.');
      try { image = await sharp(req.file.buffer, { limitInputPixels: 20 * 1000000 }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer(); }
      catch { throw fail('이 사진은 AI가 처리할 수 없습니다. JPG 또는 PNG 사진을 골라 주세요.'); }
    }
    // 업로드·디코드가 끝난 시점에도 다시 검사하여 동시에 접수된 요청을 제한한다.
    resetDay();
    const duplicate=jobs.get(requestId);
    if(duplicate){if(duplicate.owner!==req.cameraOwner)throw fail('요청 ID를 다시 만들어 주세요.',409);return res.json(status(duplicate));}
    if (active.size >= 2 || [...active.values()].some(a => a.owner === req.cameraOwner)) throw fail('현재 AI 작업이 끝난 뒤 다시 시도해 주세요.', 429);
    if (state.total >= totalLimit || (state.owners[req.cameraOwner] || 0) >= ownerLimit) throw fail('오늘의 AI 생성 한도를 사용했습니다. 저장한 프레임과 기본 꾸미기는 계속 사용할 수 있습니다.', 429);
    state.total++; state.owners[req.cameraOwner] = (state.owners[req.cameraOwner] || 0) + 1; save();
    const job = { id: requestId, owner: req.cameraOwner, kind, status: 'working', createdAt: Date.now() };
    const controller = new AbortController(); jobs.set(job.id, job); active.set(job.id, { owner: job.owner, controller });
    const timer = setTimeout(() => controller.abort(), 110000); timer.unref();
    res.status(202).json(status(job));
    (async () => {
      try {
        const bytes = await generate({ kind, image, theme: frameTheme, signal: controller.signal, env });
        if (controller.signal.aborted) throw new Error('cancelled');
        if (bytes.length > 20 * 1024 * 1024) throw new Error('large result');
        const output = await sharp(bytes, { limitInputPixels: 20 * 1000000 }).rotate().resize({ width: kind === 'frame' ? 1024 : 2048, height: kind === 'frame' ? 1024 : 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
        if (controller.signal.aborted) throw new Error('cancelled');
        if (kind === 'frame') {
          // 프레임은 사진과 무관한 장식만 영구 보관한다. 사용자 사진 결과는 짧게만 보관한다.
          const frame = { id: job.id, name: frameTheme, createdAt: Date.now() };
          fs.writeFileSync(path.join(framesDir, frame.id + '.jpg'), output); state.frames.push(frame); save(); job.frameId = frame.id;
        } else fs.writeFileSync(path.join(jobsDir, job.id + '.jpg'), output);
        job.status = 'done';
      } catch (error) {
        if (job.status !== 'cancelled') { job.status = 'error'; job.error = controller.signal.aborted ? 'AI 작업 시간이 길어 중단했습니다. 기존 사진은 유지됩니다.' : error.status === 422 ? error.message : 'AI 이미지를 만들지 못했습니다. 기존 사진은 유지됩니다. 연결·이용 한도를 확인하고 다시 시도해 주세요.'; }
      } finally { image = null; clearTimeout(timer); active.delete(job.id); }
    })();
  }));
  const owned = req => { const job = idOK(req.params.id) && jobs.get(req.params.id); if (!job || job.owner !== req.cameraOwner) throw fail('AI 작업이 만료되었거나 찾을 수 없습니다. 기존 사진으로 계속할 수 있습니다.', 404); return job; };
  app.get('/live/api/camera/ai/jobs/:id', safe(async (req, res) => res.json(status(owned(req)))));
  app.get('/live/api/camera/ai/jobs/:id/image', safe(async (req, res) => { const job = owned(req); if (job.status !== 'done' || job.kind === 'frame') throw fail('결과 사진을 아직 준비하지 못했습니다.', 409); res.type('image/jpeg').sendFile(path.join(jobsDir, job.id + '.jpg')); }));
  app.post('/live/api/camera/ai/jobs/:id/cancel', safe(async (req, res) => {
    // 업로드·디코드보다 취소가 먼저 도착해도 늦은 접수가 API를 호출하지 않게 기록한다.
    if(idOK(req.params.id)&&!jobs.has(req.params.id))jobs.set(req.params.id,{id:req.params.id,owner:req.cameraOwner,kind:'',status:'cancelled',createdAt:Date.now()});
    const job = owned(req);
    if (job.kind !== 'frame' || job.status !== 'done') { job.status = 'cancelled'; active.get(job.id)?.controller.abort(); fs.rmSync(path.join(jobsDir, job.id + '.jpg'), { force: true }); }
    res.json(status(job));
  }));
  return { jobs, state, close() { clearInterval(sweep); for (const a of active.values()) a.controller.abort(); } };
}
module.exports = { mountCameraAI, generateWithGemini };
