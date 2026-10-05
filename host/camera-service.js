'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const sharp = require('sharp');
const exifr = require('exifr');
const { atomicJSON, errorText } = require('./photo-archive');
const { targetInput, fail, FOLDER } = require('./drive-folders');
const MAX_BYTES = 50 * 1024 * 1024;
const ALLOWED = new Set(['jpg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'tif']);

function parsePhotoDate(value) {
  const text = String(value || '').replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(text)) return null;
  const ts = Date.parse(text + '+09:00');
  if (!Number.isFinite(ts) || new Date(ts + 9 * 3600000).toISOString().slice(0, text.length) !== text) return null;
  return ts;
}

function mountCameraService(app, { archive, auth, getConfig, getSites, publish, delivery, cancel, mail }) {
  const staging = path.join(archive.root, 'camera-staging');
  const receiptsDir = path.join(archive.root, 'camera-receipts');
  const liveOriginals = path.join(archive.root, 'camera-live-originals');
  fs.mkdirSync(staging, { recursive: true }); fs.mkdirSync(receiptsDir, { recursive: true });
  fs.mkdirSync(liveOriginals, { recursive: true });
  const secretFile = path.join(archive.root, 'camera-owner-key');
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
  const secret = fs.readFileSync(secretFile);
  const sign = value => crypto.createHmac('sha256', secret).update(value).digest('hex');
  const receipts = new Map(); const inflight = new Set();
  for (const filename of fs.readdirSync(receiptsDir).filter(n => /^[\w-]+\.json$/.test(n))) {
    const r = JSON.parse(fs.readFileSync(path.join(receiptsDir, filename), 'utf8')); receipts.set(r.id, r);
  }
  const save = r => { atomicJSON(path.join(receiptsDir, r.id + '.json'), r); receipts.set(r.id, r); };
  const cleanup = setInterval(() => {
    for (const filename of fs.readdirSync(staging)) {
      const file = path.join(staging, filename);
      try { if (fs.statSync(file).mtimeMs < Date.now() - 24 * 3600000) fs.unlinkSync(file); } catch {}
    }
    for (const r of receipts.values()) if (r.localName && (r.cancelled || Date.now() - r.ts > (getConfig().settings.photoTtlMin || 180) * 60000)) {
      try { fs.unlinkSync(path.join(liveOriginals, r.localName)); } catch {}
    }
  }, 3600000); cleanup.unref();
  const upload = multer({ storage: multer.diskStorage({ destination: staging,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + '.upload') }),
    limits: { fileSize: MAX_BYTES, files: 1, fields: 18, fieldSize: 16384 } });

  app.use('/live/api/camera', (req, res, next) => {
    if (!auth.check(req)) return res.status(401).json({ error: '촬영용 암호로 로그인해 주세요.' });
    if (!auth.sameOrigin(req)) return res.status(403).json({ error: '다른 사이트에서 보낸 요청입니다.' });
    res.set('Cache-Control', 'private, no-store');
    const cookie = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('camera_owner='))?.slice(13);
    const [id, signature] = String(cookie || '').split('.');
    req.cameraOwner = /^[a-f0-9]{64}$/.test(id || '') && signature === sign(id) ? id : crypto.randomBytes(32).toString('hex');
    if (req.cameraOwner !== id) res.cookie('camera_owner', req.cameraOwner + '.' + sign(req.cameraOwner), { httpOnly: true, secure: req.secure || /^https:/.test(process.env.PUBLIC_BASE_URL || ''), sameSite: 'strict', path: '/', maxAge: 365 * 24 * 3600000 });
    next();
  });
  const safe = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(error => res.status(error.status || 503).json({ error: errorText(error) }));
  app.get('/live/api/camera/config', (req, res) => res.json({ rootId: archive.folderId, year: new Date(Date.now() + 9 * 3600000).getUTCFullYear(),
    archiveEnabled: getConfig().archiveEnabled !== false, liveEnabled: getConfig().enabled, ready: archive.ready,
    archiveError: archive.error, sites: getSites(), maxBytes: MAX_BYTES, maxBatch: 30, cancelSec: getConfig().settings.cancelSec, mail: !!mail?.configured }));

  app.get('/live/api/camera/folders', safe(async (req, res) => {
    await archive.initialize();
    if (!archive.ready) throw fail(archive.error || '관리자에게 Google 드라이브 연결을 요청해 주세요.', 503);
    const years = (await archive.folders.children(archive.folderId)).filter(f => /^(19|20|21)\d{2}$/.test(f.name)).map(f => ({ id: f.id, name: f.name })).sort((a, b) => b.name.localeCompare(a.name));
    const year = String(req.query.year || '');
    if (!/^(19|20|21)\d{2}$/.test(year)) throw fail('연도를 확인해 주세요.');
    const ambiguous = !req.query.yearId && years.filter(y => y.name === year).length > 1;
    const selected = ambiguous ? null : await archive.folders.year(year, req.query.yearId);
    const events = selected ? (await archive.folders.children(selected.id)).map(f => ({ id: f.id, name: f.name, writable: f.capabilities?.canAddChildren !== false })).sort((a, b) => a.name.localeCompare(b.name, 'ko')) : [];
    res.json({ years, yearId: selected?.id || '', events, exists: !!selected, ambiguous });
  }));

  function row(r) {
    const record = archive.records.get(r.id);
    return { id: r.id, name: record?.name || r.originalName, ts: r.ts, mode: r.mode, target: record?.target || r.target,
      archive: r.mode === 'live' ? 'none' : record?.status || 'pending', archiveError: record?.error || '',
      live: r.live, liveError: r.liveError || '', delivery: delivery(r.id), mail: mail?.statusOf(r.id) || r.mail,
      canRetryDisplay: !r.cancelled && r.mode !== 'archive' && ['error', 'pending'].includes(r.live),
      canChangeTarget: !r.cancelled && record?.status === 'error' && !record.driveId,
      cancelled: !!r.cancelled, canCancel: !r.cancelled && Date.now() - r.ts < getConfig().settings.cancelSec * 1000 };
  }
  app.get('/live/api/camera/uploads', (req, res) => res.json({ uploads: [...receipts.values()].filter(r => r.owner === req.cameraOwner).sort((a, b) => b.ts - a.ts).slice(0, 60).map(row),
    state: { liveEnabled: getConfig().enabled, archiveEnabled: getConfig().archiveEnabled !== false, ready: archive.ready, archiveError: archive.error } }));
  app.post('/live/api/camera/uploads/:id/target', safe(async (req, res) => {
    const r = receipts.get(req.params.id);
    if (!r || r.owner !== req.cameraOwner) throw fail('본인이 올린 사진만 변경할 수 있습니다.', 404);
    const input = targetInput(req.body || {});
    await archive.serialize(async () => {
      if (!row(r).canChangeTarget) throw fail('Drive 전송 전 저장 위치 오류가 난 사진만 변경할 수 있습니다.', 409);
      await archive.initialize(); if (!archive.ready) throw fail(archive.error || 'Google 연결을 확인해 주세요.', 503);
      const target = await archive.folders.resolve(input), record = archive.records.get(r.id);
      Object.assign(record, { target, targetResolved: true, folderId: target.eventId, status: 'pending', error: '', nextAttempt: 0 });
      archive.save(record); r.target = target; save(r);
    });
    archive.cycle().catch(() => {}); res.status(202).json({ success: true });
  }));
  async function original(r) {
    const record = archive.get(r.id);
    if (record) {
      const local = archive.localPath(record); if (local) return fs.readFileSync(local);
      await archive.initialize(); if (!archive.drive) throw fail(archive.error || 'Google 연결을 확인해 주세요.', 503);
      await archive.folders.validateRecord(record);
      const { data: metadata } = await archive.drive.files.get({ fileId: record.driveId, supportsAllDrives: true, fields: 'id,parents,trashed' }, { timeout: 30000 });
      if (metadata.trashed || !metadata.parents?.includes(record.folderId)) throw fail('사진이 보관 폴더에서 이동·삭제되었습니다.', 409);
      const { data } = await archive.drive.files.get({ fileId: record.driveId, alt: 'media', supportsAllDrives: true }, { timeout: 30000, responseType: 'arraybuffer' });
      const bytes = Buffer.from(data); if (bytes.length > MAX_BYTES) throw fail('사진 크기 제한을 초과했습니다.'); return bytes;
    }
    if (r.localName && !r.cancelled && Date.now() - r.ts <= (getConfig().settings.photoTtlMin || 180) * 60000) return fs.readFileSync(path.join(liveOriginals, r.localName));
    throw fail('임시 사진 보관 기간이 지났습니다. 원본을 다시 선택해 주세요.', 410);
  }
  app.post('/live/api/camera/uploads/:id/display', safe(async (req, res) => {
    const r = receipts.get(req.params.id);
    if (!r || r.owner !== req.cameraOwner) throw fail('본인이 올린 사진만 표출할 수 있습니다.', 404);
    if (!row(r).canRetryDisplay) throw fail('표출 재시도 대상이 아닙니다.', 409);
    if (!getConfig().enabled) throw fail('모니터 표출 접수가 닫혀 있습니다.', 403);
    const site = getSites().find(s => s.id === r.siteId);
    if (!site) throw fail('기존 표출 모니터를 찾을 수 없습니다.', 409);
    if (inflight.has(r.id)) throw fail('사진을 처리하고 있습니다. 잠시 후 확인해 주세요.', 409);
    inflight.add(r.id);
    try {
      const bytes = await original(r);
      const image = await sharp(bytes, { limitInputPixels: 80000000 }).rotate().resize({ width: 3840, height: 3840, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
      if (!getConfig().enabled) throw fail('모니터 표출 접수가 닫혀 있습니다.', 403);
      r.live = 'pending'; save(r);
      r.screens = publish({ ...r, ts: Date.now() }, image, site); r.live = 'sent'; r.liveError = ''; save(r);
      res.json({ success: true, upload: row(r) });
    } finally { inflight.delete(r.id); }
  }));
  app.post('/live/api/camera/uploads/:id/retry', safe(async (req, res) => {
    const r = receipts.get(req.params.id);
    if (!r || r.owner !== req.cameraOwner) throw fail('본인이 올린 사진만 확인할 수 있습니다.', 404);
    const record = archive.get(r.id);
    if (!record || !['pending', 'error'].includes(record.status)) throw fail('재시도할 사진이 없습니다.', 409);
    record.nextAttempt = 0; archive.save(record); archive.cycle().catch(() => {}); res.status(202).json({ success: true });
  }));
  app.delete('/live/api/camera/uploads/:id', safe(async (req, res) => {
    const r = receipts.get(req.params.id);
    if (!r || r.owner !== req.cameraOwner) throw fail('본인이 올린 사진만 취소할 수 있습니다.', 404);
    if (r.cancelled) return res.json({ success: true });
    if (inflight.has(r.id)) throw fail('사진을 처리하고 있습니다. 잠시 후 취소해 주세요.', 409);
    if (Date.now() - r.ts >= getConfig().settings.cancelSec * 1000) throw fail('취소 가능 시간이 지났습니다. 관리자에게 요청해 주세요.', 410);
    archive.markDelete(r.id); cancel(r.id); mail?.remove(r.id); r.cancelled = true; save(r);
    if (r.localName) try { fs.unlinkSync(path.join(liveOriginals, r.localName)); } catch {}
    archive.cycle().catch(() => {});
    res.json({ success: true });
  }));

  app.post('/live/api/camera/photo', (req, res) => {
    upload.single('photo')(req, res, error => {
      if (error) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? '사진은 한 장당 50MB까지 올릴 수 있습니다.' : '사진 파일을 확인해 주세요.' });
      let source = req.file?.path, id, locked = false;
      (async () => {
        if (!source) throw fail('사진을 선택해 주세요.');
        const { fileTypeFromFile } = await import('file-type');
        const kind = await fileTypeFromFile(source);
        if (!kind || !ALLOWED.has(kind.ext)) throw fail('JPEG, PNG, GIF, WebP, HEIC, AVIF, TIFF 사진만 올릴 수 있습니다.');
        const renamed = source + '.' + kind.ext; fs.renameSync(source, renamed); source = renamed;
        const mode = String(req.body.mode || '');
        if (!['archive', 'live', 'both'].includes(mode)) throw fail('사용 목적을 선택해 주세요.');
        const target = mode === 'live' ? null : targetInput(JSON.parse(req.body.target || '{}'));
        const uploaderName = String(req.body.uploaderName || '').normalize('NFC').replace(/[\x00-\x1f\x7f]/g, '').trim();
        if (!uploaderName || [...uploaderName].length > 20) throw fail('업로더 이름을 1~20자로 입력해 주세요.');
        const requestId = String(req.body.requestId || '');
        if (!/^[\w-]{16,80}$/.test(requestId)) throw fail('전송 요청을 다시 시작해 주세요.');
        id = 'camera_' + crypto.createHash('sha256').update(req.cameraOwner + requestId).digest('hex');
        if (inflight.has(id)) throw fail('같은 사진을 처리하고 있습니다. 잠시 후 재시도해 주세요.', 409);
        inflight.add(id); locked = true;
        let capturedAt = parsePhotoDate(req.body.capturedAt), dateSource = capturedAt ? (req.body.dateSource === 'capture' ? 'capture' : 'user') : 'unknown';
        if (!capturedAt && req.body.capturedAt) throw fail('사진 날짜를 확인해 주세요.');
        if (!capturedAt || ['exif', 'fileModified'].includes(req.body.dateSource)) {
          try {
            const tags = await exifr.parse(source, { pick: ['DateTimeOriginal', 'CreateDate'], reviveValues: false });
            const exifDate = parsePhotoDate(tags?.DateTimeOriginal || tags?.CreateDate);
            if (exifDate) { capturedAt = exifDate; dateSource = 'exif'; }
            else if (req.body.dateSource === 'fileModified') { capturedAt = null; dateSource = 'unknown'; }
          } catch {}
        }
        const lastModified = Number(req.body.lastModified);
        if (!capturedAt && Number.isFinite(lastModified) && lastModified > 0 && lastModified < Date.now() + 86400000) { capturedAt = lastModified; dateSource = 'fileModified'; }
        const message = String(req.body.message || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 40);
        if (mode !== 'archive' && /(https?:\/\/|www\.|\b[\w-]+\.(com|net|org|kr|io|co|me|biz|info|shop|xyz)\b)/i.test(message)) throw fail('표출 문구에 링크·주소는 넣을 수 없습니다.');
        const fingerprint = crypto.createHash('sha256').update(fs.readFileSync(source)).update(JSON.stringify({ mode, target, uploaderName, capturedAt, message, siteId: req.body.siteId || '', email: req.body.email || '' })).digest('hex');
        const previous = receipts.get(id);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw fail('같은 전송 요청의 사진이나 설정이 달라졌습니다.', 409);
          return res.json({ success: true, replay: true, upload: row(previous) });
        }
        if (mode !== 'live' && getConfig().archiveEnabled === false) throw fail('지금은 사진 보관 접수가 닫혀 있습니다.', 403);
        const site = mode === 'archive' ? null : getSites().find(s => s.id === req.body.siteId);
        if (mode !== 'archive' && !site) throw fail('표출할 모니터를 선택해 주세요.');
        const email = mail?.configured ? require('./photo-mail').normalizeEmail(req.body.email) : '';
        if (email === null) throw fail('사진 받을 이메일 주소를 확인해 주세요.');
        // The deterministic record ID also recovers a crash between archive enqueue
        // and receipt persistence, without writing a second original.
        let record = archive.records.get(id);
        if (record && record.fingerprint !== fingerprint) throw fail('기존 접수 사진과 설정이 다릅니다.', 409);
        const photo = { id, ts: record?.ts || Date.now(), owner: req.cameraOwner, uploaderId: req.cameraOwner, uploaderName,
          capturedAt, dateSource, originalName: String(req.file.originalname).slice(0, 255), message, requestId, fingerprint,
          siteId: site?.id || '', siteName: site?.name || '', batchTotal: Math.min(30, Math.max(1, parseInt(req.body.batchTotal, 10) || 1)) };
        if (mode !== 'live' && !record) record = archive.enqueueCamera(photo, source, target);
        const receipt = { ...photo, mode, target, live: mode === 'archive' ? 'none' : 'pending' };
        if (mode === 'live') { receipt.localName = id + '.' + kind.ext; fs.copyFileSync(source, path.join(liveOriginals, receipt.localName)); }
        save(receipt); // Persist before the side effect: response loss never republishes.
        if (mode !== 'archive') {
          if (!getConfig().enabled) { receipt.live = 'error'; receipt.liveError = '모니터 표출 접수가 닫혀 있습니다.'; }
          else {
            try {
              const display = await sharp(source, { limitInputPixels: 80000000 }).rotate().resize({ width: 3840, height: 3840, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
              if (!getConfig().enabled) throw fail('모니터 표출 접수가 닫혀 있습니다.');
              receipt.live = 'sent'; receipt.screens = publish(photo, display, site);
            } catch (e) { receipt.live = 'error'; receipt.liveError = e.publicMessage || '이 사진을 모니터용 이미지로 변환하지 못했습니다. Drive 보관 상태를 확인해 주세요.'; }
          }
        }
        if (email) {
          try { receipt.mail = mail.enqueue({ photo, source, site: site || { name: target?.folderName || '교회사진' }, email, delayMs: getConfig().settings.cancelSec * 1000 }); }
          catch { receipt.mail = 'error'; }
        }
        save(receipt); if (record) archive.cycle().catch(() => {});
        res.json({ success: true, upload: row(receipt) });
      })().catch(error => res.status(error.status || 400).json({ error: error.publicMessage || '사진을 접수하지 못했습니다. 설정과 연결을 확인하고 다시 시도해 주세요.' }))
        .finally(() => { if (locked) inflight.delete(id); if (source) try { fs.unlinkSync(source); } catch {} });
    });
  });
}
module.exports = { mountCameraService, parsePhotoDate };
