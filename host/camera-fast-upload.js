'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const exifr = require('exifr');
const { targetInput, fail } = require('./drive-folders');
const ALLOWED = new Set(['jpg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'tif']);

function mountFastUpload(app, { archive, getConfig, getSites, publish, cancel, mail, upload,
  receipts, inflight, save, row, safe, liveOriginals, parsePhotoDate, wakeArchive }) {
  const owned = req => {
    const r = receipts.get(req.params.id);
    if (!r || r.owner !== req.cameraOwner) throw fail('본인이 올린 사진만 처리할 수 있습니다.', 404);
    return r;
  };
  const multipart = handler => (req, res) => upload.single('photo')(req, res, error => {
    let source = req.file?.path, id, locked = false;
    Promise.resolve().then(async () => {
      if (error) throw fail(error.code === 'LIMIT_FILE_SIZE' ? '사진은 한 장당 50MB까지 올릴 수 있습니다.' : '사진 파일을 확인해 주세요.');
      if (!source) throw fail('사진을 선택해 주세요.');
      const { fileTypeFromFile } = await import('file-type');
      const kind = await fileTypeFromFile(source);
      if (!kind || !ALLOWED.has(kind.ext)) throw fail('지원하는 사진 파일을 선택해 주세요.');
      const renamed = source + '.' + kind.ext; fs.renameSync(source, renamed); source = renamed;
      id = req.params.id || 'camera_' + crypto.createHash('sha256').update(req.cameraOwner + String(req.body.requestId || '')).digest('hex');
      if (inflight.has(id)) throw fail('같은 사진을 처리하고 있습니다. 잠시 후 재시도해 주세요.', 409);
      inflight.add(id); locked = true;
      return handler(req, res, { source, id, kind });
    }).catch(error => res.status(error.status || 400).json({ error: error.publicMessage || '사진 처리에 실패했습니다. 같은 요청으로 재시도해 주세요.' }))
      .finally(() => { if (locked) inflight.delete(id); if (source) try { fs.unlinkSync(source); } catch {} });
  });

  app.post('/live/api/camera/preview', multipart(async (req, res, { source, id, kind }) => {
    const mode = String(req.body.mode || '');
    if (!['live', 'both'].includes(mode)) throw fail('모니터 표출 목적을 선택해 주세요.');
    const requestId = String(req.body.requestId || '');
    if (!/^[\w-]{16,80}$/.test(requestId)) throw fail('전송 요청을 다시 시작해 주세요.');
    const uploaderName = String(req.body.uploaderName || '').normalize('NFC').replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (!uploaderName || [...uploaderName].length > 20) throw fail('업로더 이름을 1~20자로 입력해 주세요.');
    const target = mode === 'both' && req.body.target && req.body.target !== '{}' && req.body.target !== 'null' ? targetInput(JSON.parse(req.body.target)) : null;
    const capturedAt = parsePhotoDate(req.body.capturedAt);
    if (!capturedAt && req.body.capturedAt) throw fail('사진 날짜를 확인해 주세요.');
    const message = String(req.body.message || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 40);
    if (/(https?:\/\/|www\.|\b[\w-]+\.(com|net|org|kr|io|co|me|biz|info|shop|xyz)\b)/i.test(message)) throw fail('표출 문구에 링크·주소는 넣을 수 없습니다.');
    const email = mail?.configured ? require('./photo-mail').normalizeEmail(req.body.email) : '';
    if (email === null) throw fail('사진 받을 이메일 주소를 확인해 주세요.');
    const originalName = String(req.body.originalName || req.file.originalname).slice(0, 255);
    const fingerprint = crypto.createHash('sha256').update(fs.readFileSync(source)).update(JSON.stringify({ mode, target, capturedAt, uploaderName, message, siteId: req.body.siteId, email: req.body.email || '', originalName })).digest('hex');
    const previous = receipts.get(id);
    if (previous) {
      if (!previous.pipeline || previous.fingerprint !== fingerprint) throw fail('같은 전송 요청의 사진이나 설정이 달라졌습니다.', 409);
      return res.json({ success: true, replay: true, upload: row(previous) });
    }
    if (!getConfig().enabled) throw fail('모니터 표출 접수가 닫혀 있습니다.', 403);
    const site = getSites().find(s => s.id === req.body.siteId);
    if (!site) throw fail('표출할 모니터를 선택해 주세요.');
    // No Google calls or original archive enqueue on the display-critical path.
    let display;
    try { display = await sharp(source, { limitInputPixels: 80000000 }).rotate()
      .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer(); } catch {}
    const r = { id, ts: Date.now(), mode, pipeline: true, target, owner: req.cameraOwner, uploaderId: req.cameraOwner,
      uploaderName, capturedAt, dateSource: String(req.body.dateSource || 'unknown'), originalName,
      lastModified: Number(req.body.lastModified) || 0, requestId, fingerprint, message, siteId: site.id, siteName: site.name,
      batchTotal: Math.min(30, Math.max(1, parseInt(req.body.batchTotal, 10) || 1)), live: display ? 'pending' : 'error' };
    if (display) { r.previewName = id + '.preview.jpg'; fs.writeFileSync(path.join(liveOriginals, r.previewName), display); }
    else {
      r.localName = id + '.' + kind.ext; fs.copyFileSync(source, path.join(liveOriginals, r.localName));
      r.liveError = '모니터용 이미지로 변환하지 못했습니다.' + (mode === 'both' ? ' 원본 보관은 별도로 진행합니다.' : ' 다른 사진을 선택해 주세요.');
    }
    save(r); // Never automatically republish a receipt after a lost response.
    if (display) try {
      if (!getConfig().enabled) throw fail('모니터 표출 접수가 닫혀 있습니다.');
      r.screens = publish(r, display, site); r.live = 'sent';
    } catch (error) { r.live = 'error'; r.liveError = error.publicMessage || '모니터 전달을 다시 확인해 주세요.'; }
    save(r);
    if (email && display) {
      try { r.mail = mail.enqueue({ photo: r, source: path.join(liveOriginals, r.previewName), site, email, delayMs: getConfig().settings.cancelSec * 1000 }); }
      catch { r.mail = 'error'; }
    } else if (email) r.mail = 'error';
    else if (String(req.body.email || '').trim() && !mail?.configured) r.mail = 'off';
    save(r); res.json({ success: true, upload: row(r) });
  }));

  app.post('/live/api/camera/uploads/:id/original', (req, res, next) => {
    try { const r = owned(req); if (!r.pipeline || r.mode !== 'both' || r.cancelled) throw fail('원본 보관 대상이 아닙니다.', 410); next(); }
    catch (error) { res.status(error.status || 400).json({ error: error.publicMessage }); }
  }, multipart(async (req, res, { source }) => {
    const r = owned(req);
    if (r.cancelled) throw fail('취소한 사진입니다.', 410);
    if (getConfig().archiveEnabled === false) throw fail('사진 보관 접수가 닫혀 있습니다. 원본은 기기에서 재시도할 수 있습니다.', 403);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    const record = archive.records.get(r.id);
    if ((r.originalHash && r.originalHash !== hash) || (record?.originalHash && record.originalHash !== hash)) throw fail('이미 접수한 원본과 다릅니다.', 409);
    if (record) {
      if (['deleting', 'deleted', 'missing'].includes(record.status)) throw fail('삭제한 원본입니다.', 410);
      r.originalHash = hash; save(r);
      return res.json({ success: true, replay: true, upload: row(r) });
    }
    let capturedAt = r.capturedAt, dateSource = r.dateSource;
    if (!capturedAt || ['exif', 'fileModified'].includes(dateSource)) {
      try {
        const tags = await exifr.parse(source, { pick: ['DateTimeOriginal', 'CreateDate'], reviveValues: false });
        const exifDate = parsePhotoDate(tags?.DateTimeOriginal || tags?.CreateDate);
        if (exifDate) { capturedAt = exifDate; dateSource = 'exif'; }
      } catch {}
    }
    if (!capturedAt && r.lastModified > 0 && r.lastModified < Date.now() + 86400000) { capturedAt = r.lastModified; dateSource = 'fileModified'; }
    r.originalHash = hash; save(r);
    archive.enqueueCamera({ ...r, capturedAt, dateSource }, source, r.target, {
      status: r.target ? 'pending' : 'awaiting_target', splitUpload: true, originalHash: hash
    });
    // Durable local original receipt, not a claim of Google Drive completion.
    if (r.target) wakeArchive(r.id);
    res.json({ success: true, upload: row(r) });
  }));

  app.delete('/live/api/camera/uploads/:id/withdraw', safe(async (req, res) => {
    const r = owned(req);
    if (r.mode === 'archive') throw fail('모니터에 게시한 사진이 아닙니다.', 409);
    if (r.live !== 'withdrawn') { r.live = 'withdrawn'; r.liveError = ''; save(r); }
    cancel(r.id);
    res.json({ success: true, upload: row(r) });
  }));
}
module.exports = { mountFastUpload };
