'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const sharp = require('sharp');
const exifr = require('exifr');
const { atomicJSON, cameraErrorText: errorText } = require('./photo-archive');
const { targetInput, fail } = require('./drive-folders');
const { CameraFolderCatalog } = require('./camera-folder-catalog');
const { mountVideoUpload, MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS } = require('./camera-video');
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_BATCH = 500;

// 원본은 Drive 저장을 확인할 때까지 서버 디스크에 머문다. 올리는 속도가 Drive 전송보다 빨라
// 디스크가 차면 새 접수를 잠시 미루고, 휴대폰은 backlog 응답을 받으면 기다렸다가 이어서 보낸다.
function requireArchiveSpace(root, minFree = Number(process.env.CAMERA_MIN_FREE_BYTES) || 1024 * 1024 * 1024) {
  let free;
  try { const stat = fs.statfsSync(root); free = stat.bavail * stat.bsize; } catch { return; }
  if (free < minFree) throw Object.assign(fail('서버가 앞서 받은 사진을 Drive로 옮기고 있습니다. 잠시 후 자동으로 이어서 올립니다.', 503), { backlog: true });
}
const ALLOWED = new Set(['jpg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'tif']);

function parsePhotoDate(value) {
  const text = String(value || '').replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(text)) return null;
  const ts = Date.parse(text + '+09:00');
  if (!Number.isFinite(ts) || new Date(ts + 9 * 3600000).toISOString().slice(0, text.length) !== text) return null;
  return ts;
}

function mountCameraService(app, { archive, auth, getConfig, getSites, publish, delivery, cancel, mail }) {
  const folderCatalog = new CameraFolderCatalog(archive);
  const staging = path.join(archive.root, 'camera-staging');
  const receiptsDir = path.join(archive.root, 'camera-receipts');
  const liveOriginals = path.join(archive.root, 'camera-live-originals');
  fs.mkdirSync(staging, { recursive: true }); fs.mkdirSync(receiptsDir, { recursive: true });
  fs.mkdirSync(liveOriginals, { recursive: true });
  const secretFile = path.join(archive.root, 'camera-owner-key');
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
  const secret = fs.readFileSync(secretFile);
  const sign = value => crypto.createHmac('sha256', secret).update(value).digest('hex');
  const receipts = new Map(); const inflight = new Set(); const videoJobs = new Set();
  for (const filename of fs.readdirSync(receiptsDir).filter(n => /^[\w-]+\.json$/.test(n))) {
    const r = JSON.parse(fs.readFileSync(path.join(receiptsDir, filename), 'utf8')); receipts.set(r.id, r);
    const record = archive.records.get(r.id);
    if (r.pipeline && !r.cancelled && r.target && record?.status === 'awaiting_target') {
      Object.assign(record, { target: targetInput(r.target), status: 'pending', nextAttempt: 0 }); archive.save(record);
    }
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
    for (const r of receipts.values()) if (r.previewName && (r.cancelled || Date.now() - r.ts > (getConfig().settings.photoTtlMin || 180) * 60000)) {
      try { fs.unlinkSync(path.join(liveOriginals, r.previewName)); } catch {}
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
    archiveError: archive.error ? errorText({ publicMessage: archive.error }) : '', sites: getSites(), maxBytes: MAX_BYTES, maxVideoBytes: MAX_VIDEO_BYTES, maxVideoSeconds: MAX_VIDEO_SECONDS, maxBatch: 30, maxArchiveBatch: MAX_ARCHIVE_BATCH, cancelSec: getConfig().settings.cancelSec, mail: !!mail?.configured }));

  // 교회폴더 저장은 사진마다 내용·설정으로 요청 ID를 만든다. 앱이 꺼진 뒤 같은 사진을 다시 골라도
  // 이미 접수한 사진은 여기서 알려 주어 다시 올리지 않는다(본인 기기의 접수만 확인).
  app.post('/live/api/camera/known', (req, res) => {
    const known = {};
    for (const requestId of (Array.isArray(req.body?.requestIds) ? req.body.requestIds : []).slice(0, MAX_ARCHIVE_BATCH + 100)) {
      if (!/^[\w-]{16,80}$/.test(String(requestId))) continue;
      const r = receipts.get('camera_' + crypto.createHash('sha256').update(req.cameraOwner + requestId).digest('hex'));
      if (r && r.owner === req.cameraOwner) known[requestId] = { id: r.id, cancelled: !!r.cancelled, archive: row(r).archive };
    }
    res.json({ known });
  });

  app.get('/live/api/camera/folders', safe(async (req, res) => {
    res.json(await folderCatalog.get(String(req.query.year || ''), String(req.query.yearId || ''), req.query.refresh === '1'));
  }));

  function row(r) {
    const record = archive.records.get(r.id);
    const mailState = mail?.statusOf(r.id) || r.mail;
    return { id: r.id, name: record?.name || r.originalName, ts: r.ts, mode: r.mode, target: record?.target || r.target,
      kind: r.kind || 'photo', converting: videoJobs.has(r.id),
      archive: r.mode === 'live' ? 'none' : record?.status || (r.cancelled ? 'deleted' : r.pipeline ? 'awaiting_original' : 'pending'), archiveError: record?.error ? errorText({ publicMessage: record.error }) : '',
      original: r.mode === 'live' || (r.cancelled && !record) ? 'none' : record ? 'received' : 'pending', pipeline: !!r.pipeline,
      live: r.live, liveError: r.liveError || '', delivery: delivery(r.id), mail: mailState,
      canCancelMail: !r.cancelled && r.mode !== 'archive' && mailState === 'queued',
      canRetryDisplay: !r.cancelled && r.mode !== 'archive' && ['error', 'pending'].includes(r.live) && !videoJobs.has(r.id),
      canWithdraw: !r.cancelled && r.mode !== 'archive' && r.live !== 'withdrawn',
      canChangeTarget: !r.cancelled && ((r.pipeline && r.mode === 'both' && (!record || record.status === 'awaiting_target')) || (record?.status === 'error' && !record.driveId)),
      cancelled: !!r.cancelled, canCancel: !r.cancelled && Date.now() - r.ts < getConfig().settings.cancelSec * 1000 };
  }
  const wakeArchive = id => archive.cycle().then(() => {
    if (archive.ready && archive.records.get(id)?.status === 'pending') return archive.cycle();
  }).catch(() => {});
  app.get('/live/api/camera/uploads', (req, res) => res.json({ uploads: [...receipts.values()].filter(r => r.owner === req.cameraOwner).sort((a, b) => b.ts - a.ts).filter((r, index) => index < 60 || (r.pipeline && r.mode === 'both' && !r.cancelled && (!archive.records.has(r.id) || archive.records.get(r.id).status === 'awaiting_target'))).map(row),
    state: { liveEnabled: getConfig().enabled, archiveEnabled: getConfig().archiveEnabled !== false, ready: archive.ready, archiveError: archive.error ? errorText({ publicMessage: archive.error }) : '' } }));
  app.post('/live/api/camera/uploads/:id/target', safe(async (req, res) => {
    const r = receipts.get(req.params.id);
    if (!r || r.owner !== req.cameraOwner) throw fail('본인이 올린 사진만 변경할 수 있습니다.', 404);
    if (r.mode === 'live') throw fail('보관없이 표출한 사진에는 저장 위치를 지정할 수 없습니다.', 409);
    if (['deleted', 'deleting', 'missing'].includes(archive.records.get(r.id)?.status)) throw fail('삭제한 사진입니다.', 410);
    const input = targetInput(req.body || {});
    if (r.pipeline && !r.cancelled && r.target && archive.records.get(r.id)?.status !== 'error' && JSON.stringify(targetInput(r.target)) === JSON.stringify(input)) return res.status(202).json({ success: true, upload: row(r) });
    if (r.pipeline && (!archive.records.has(r.id) || archive.records.get(r.id).status === 'awaiting_target')) {
      if (r.cancelled) throw fail('취소한 사진입니다.', 410);
      // Waiting-for-location records are excluded from the Drive worker, so the
      // initial assignment never waits behind Google. Original upload reads this
      // durable receipt if the location is assigned before it arrives.
      r.target = input; save(r);
      const record = archive.records.get(r.id);
      if (record && record.status === 'awaiting_target') {
        Object.assign(record, { target: input, status: 'pending', error: '', nextAttempt: 0 }); archive.save(record);
        wakeArchive(r.id);
      }
      return res.status(202).json({ success: true, upload: row(r) });
    }
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
    if (r.previewName && !r.cancelled) {
      const preview = path.join(liveOriginals, r.previewName);
      if (fs.existsSync(preview)) return fs.readFileSync(preview);
    }
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
    if (r.kind === 'video') {
      // Conversion runs in the background; the row reports the result.
      r.live = 'pending'; r.liveError = ''; save(r); video.enqueueDisplay(r);
      return res.status(202).json({ success: true, upload: row(r) });
    }
    inflight.add(r.id);
    try {
      const bytes = await original(r);
      const image = await sharp(bytes, { limitInputPixels: 80000000 }).rotate().resize({ width: 3840, height: 3840, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
      if (r.live === 'withdrawn' || r.cancelled) throw fail('게시를 취소한 사진입니다.', 410);
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
  app.delete('/live/api/camera/uploads/:id/mail', safe(async (req, res) => {
    const r = receipts.get(req.params.id);
    if (!r || r.owner !== req.cameraOwner) throw fail('본인이 예약한 이메일만 취소할 수 있습니다.', 404);
    if (r.mail === 'cancelled') return res.json({ success: true });
    if (!row(r).canCancelMail || !mail?.remove(r.id, req.cameraOwner)) throw fail('이미 발송을 시작했거나 취소할 이메일이 없습니다.', 410);
    r.mail = 'cancelled'; save(r); res.json({ success: true });
  }));
  app.delete('/live/api/camera/uploads/:id', safe(async (req, res) => {
    const r = receipts.get(req.params.id);
    if (!r || r.owner !== req.cameraOwner) throw fail('본인이 올린 사진만 취소할 수 있습니다.', 404);
    if (r.cancelled) return res.json({ success: true });
    if (inflight.has(r.id)) throw fail('사진을 처리하고 있습니다. 잠시 후 취소해 주세요.', 409);
    if (Date.now() - r.ts >= getConfig().settings.cancelSec * 1000) throw fail('취소 가능 시간이 지났습니다. 관리자에게 요청해 주세요.', 410);
    archive.markDelete(r.id); cancel(r.id); mail?.remove(r.id); r.cancelled = true; save(r);
    if (r.localName) try { fs.unlinkSync(path.join(liveOriginals, r.localName)); } catch {}
    if (r.previewName) try { fs.unlinkSync(path.join(liveOriginals, r.previewName)); } catch {}
    archive.cycle().catch(() => {});
    res.json({ success: true });
  }));

  const video = mountVideoUpload(app, { archive, getConfig, getSites, publish, receipts, inflight, save, row,
    liveOriginals, staging, parsePhotoDate, videoJobs, requireArchiveSpace });

  require('./camera-fast-upload').mountFastUpload(app, { archive, getConfig, getSites, publish, cancel, mail,
    upload, receipts, inflight, save, row, safe, liveOriginals, parsePhotoDate, wakeArchive });

  app.post('/live/api/camera/photo', (req, res) => {
    upload.single('photo')(req, res, error => {
      if (error) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? '사진은 한 장당 50MB까지 올릴 수 있습니다.' : '사진 파일을 확인해 주세요.' });
      let source = req.file?.path, mailSource, id, locked = false;
      (async () => {
        if (!source) throw fail('사진을 선택해 주세요.');
        const { fileTypeFromFile } = await import('file-type');
        const kind = await fileTypeFromFile(source);
        if (!kind || !ALLOWED.has(kind.ext)) throw fail('JPEG, PNG, GIF, WebP, HEIC, AVIF, TIFF 사진만 올릴 수 있습니다.');
        const renamed = source + '.' + kind.ext; fs.renameSync(source, renamed); source = renamed;
        const mode = String(req.body.mode || '');
        if (!['archive', 'live', 'both'].includes(mode)) throw fail('사용 목적을 선택해 주세요.');
        if (mode !== 'live') requireArchiveSpace(archive.root);
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
        const email = mode !== 'archive' && mail?.configured ? require('./photo-mail').normalizeEmail(req.body.email) : '';
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
        let display;
        if (mode !== 'archive') {
          if (!getConfig().enabled) { receipt.live = 'error'; receipt.liveError = '모니터 표출 접수가 닫혀 있습니다.'; }
          else {
            try {
              display = await sharp(source, { limitInputPixels: 80000000 }).rotate().resize({ width: 3840, height: 3840, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
              if (receipt.live === 'withdrawn') throw fail('게시를 취소한 사진입니다.', 410);
              if (!getConfig().enabled) throw fail('모니터 표출 접수가 닫혀 있습니다.');
              receipt.live = 'sent'; receipt.screens = publish(photo, display, site);
            } catch (e) { if (receipt.live !== 'withdrawn') { receipt.live = 'error'; receipt.liveError = e.publicMessage || '이 사진을 모니터용 이미지로 변환하지 못했습니다. Drive 보관 상태를 확인해 주세요.'; } }
          }
        }
        if (email) {
          try {
            // Preserve the archived original while retaining the previous compact,
            // widely supported JPEG email attachment (including HEIC/AVIF input).
            display ||= await sharp(source, { limitInputPixels: 80000000 }).rotate().resize({ width: 3840, height: 3840, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
            mailSource = source + '.mail.jpg'; fs.writeFileSync(mailSource, display);
            receipt.mail = mail.enqueue({ photo, source: mailSource, site, email, delayMs: getConfig().settings.cancelSec * 1000 });
          }
          catch { receipt.mail = 'error'; }
        } else if (mode !== 'archive' && String(req.body.email || '').trim() && !mail?.configured) receipt.mail = 'off';
        save(receipt); if (record) archive.cycle().catch(() => {});
        res.json({ success: true, upload: row(receipt) });
      })().catch(error => res.status(error.status || 400).json({ error: error.publicMessage || '사진을 접수하지 못했습니다. 설정과 연결을 확인하고 다시 시도해 주세요.', ...(error.backlog ? { backlog: true } : {}) }))
        .finally(() => { if (locked) inflight.delete(id); for (const file of [source, mailSource]) if (file) try { fs.unlinkSync(file); } catch {} });
    });
  });
}
module.exports = { mountCameraService, parsePhotoDate, requireArchiveSpace };
