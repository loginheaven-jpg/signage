'use strict';
// Camera videos: one upload, then a background conversion to a monitor-friendly MP4.
// The original goes to the archive untouched; monitors only ever receive the converted copy.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const multer = require('multer');
const { targetInput, fail } = require('./drive-folders');

const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 180;
const ALLOWED = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', '3gp']);
const LONG_SIDE = 1920;

function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { return require('@ffmpeg-installer/ffmpeg').path; } catch { return 'ffmpeg'; }
}

function run(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

// `ffmpeg -i` prints the container summary and exits non-zero; that summary is all we need.
async function probe(file) {
  const { stderr } = await run(['-i', file], 30000);
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const video = /Stream #[^\n]*Video: (\w+)[^\n]*?(\d{2,5})x(\d{2,5})[^\n]*/.exec(stderr);
  if (!duration || !video) return null;
  const bitrate = /Duration:[^\n]*bitrate: (\d+) kb\/s/.exec(stderr);
  const fps = /([\d.]+) fps/.exec(video[0]);
  return {
    seconds: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
    codec: video[1], width: Number(video[2]), height: Number(video[3]),
    eightBit: /yuvj?420p[,( ]/.test(video[0]), kbps: bitrate ? Number(bitrate[1]) : 0,
    fps: fps ? Number(fps[1]) : 0, audio: /Stream #[^\n]*Audio:/.test(stderr)
  };
}

// Phones record 4K, HEVC and 20 Mbps files that signage PCs cannot always decode or download
// in time. Already-light H.264 is only repackaged; everything else is re-encoded to 1080p.
async function convert(source, output, poster, info, muted) {
  const light = info.codec === 'h264' && info.eightBit && Math.max(info.width, info.height) <= LONG_SIDE && info.kbps > 0 && info.kbps <= 10000;
  const audio = muted || !info.audio ? ['-an'] : ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', '-ac', '2'];
  const filters = [`scale=w='if(gt(iw,ih),min(${LONG_SIDE},iw),-2)':h='if(gt(iw,ih),-2,min(${LONG_SIDE},ih))'`];
  if (info.fps > 31) filters.push('fps=30');
  const video = light ? ['-c:v', 'copy']
    : ['-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p'];
  const encoded = await run(['-y', '-i', source, '-map', '0:v:0', ...video, ...audio, '-movflags', '+faststart', '-f', 'mp4', output], 20 * 60000);
  if (encoded.code !== 0 || !fs.existsSync(output) || !fs.statSync(output).size) throw new Error('Video conversion failed');
  const at = Math.min(1, info.seconds / 2).toFixed(2);
  const still = await run(['-y', '-ss', at, '-i', output, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', '-f', 'image2', poster], 60000);
  if (still.code !== 0 || !fs.existsSync(poster)) throw new Error('Video poster failed');
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash));
  });
}

function mountVideoUpload(app, { archive, getConfig, getSites, publish, receipts, inflight, save, row, liveOriginals, staging, parsePhotoDate, videoJobs, requireArchiveSpace = () => {} }) {
  const upload = multer({ storage: multer.diskStorage({ destination: staging,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + '.upload') }),
    limits: { fileSize: MAX_VIDEO_BYTES, files: 1, fields: 18, fieldSize: 16384 } });
  let queue = Promise.resolve();

  // One conversion at a time: the display path must not starve the rest of the server.
  function enqueueDisplay(r) {
    if (videoJobs.has(r.id)) return;
    videoJobs.add(r.id);
    queue = queue.then(async () => {
      const work = path.join(liveOriginals, r.id + '.display.mp4'), poster = path.join(liveOriginals, r.id + '.poster.jpg');
      try {
        const source = path.join(liveOriginals, r.localName || '');
        if (!r.localName || !fs.existsSync(source)) throw fail('임시 영상 보관 기간이 지났습니다. 영상을 다시 선택해 주세요.');
        const info = await probe(source);
        if (!info) throw fail('이 영상을 모니터용으로 변환하지 못했습니다.');
        await convert(source, work, poster, info, r.muted !== false);
        if (r.cancelled || r.live === 'withdrawn') return;
        if (!getConfig().enabled) throw fail('모니터 표출 접수가 닫혀 있습니다.');
        const site = getSites().find(s => s.id === r.siteId);
        if (!site) throw fail('표출할 모니터를 찾을 수 없습니다.');
        r.screens = publish({ ...r, ts: Date.now() }, { video: work, poster, durationMs: Math.round(info.seconds * 1000), muted: r.muted !== false }, site);
        r.live = 'sent'; r.liveError = ''; save(r);
      } catch (error) {
        if (!r.cancelled && r.live !== 'withdrawn') { r.live = 'error'; r.liveError = error.publicMessage || '이 영상을 모니터용으로 변환하지 못했습니다.'; save(r); }
      } finally {
        videoJobs.delete(r.id);
        for (const file of [work, poster]) try { fs.unlinkSync(file); } catch {}
      }
    }).catch(() => {});
  }
  // A restart loses the in-memory queue; resume what was accepted but not yet shown.
  for (const r of receipts.values()) if (r.kind === 'video' && r.live === 'pending' && !r.cancelled && r.localName) enqueueDisplay(r);

  app.post('/live/api/camera/video', (req, res) => {
    upload.single('video')(req, res, error => {
      let source = req.file?.path, id, locked = false;
      (async () => {
        if (error) throw fail(error.code === 'LIMIT_FILE_SIZE' ? '영상은 500MB까지 올릴 수 있습니다.' : '영상 파일을 확인해 주세요.');
        if (!source) throw fail('영상을 선택해 주세요.');
        const { fileTypeFromFile } = await import('file-type');
        const kind = await fileTypeFromFile(source);
        if (!kind || !ALLOWED.has(kind.ext)) throw fail('MP4, MOV, WebM 영상만 올릴 수 있습니다.');
        const renamed = source + '.' + kind.ext; fs.renameSync(source, renamed); source = renamed;
        const mode = String(req.body.mode || '');
        if (!['archive', 'live', 'both'].includes(mode)) throw fail('사용 목적을 선택해 주세요.');
        const target = mode === 'live' || !req.body.target || ['{}', 'null'].includes(req.body.target) ? null : targetInput(JSON.parse(req.body.target));
        if (mode === 'archive' && !target) throw fail('저장할 폴더를 선택해 주세요.');
        if (mode !== 'live') requireArchiveSpace(archive.root);
        const uploaderName = String(req.body.uploaderName || '').normalize('NFC').replace(/[\x00-\x1f\x7f]/g, '').trim();
        if (!uploaderName || [...uploaderName].length > 20) throw fail('업로더 이름을 1~20자로 입력해 주세요.');
        const requestId = String(req.body.requestId || '');
        if (!/^[\w-]{16,80}$/.test(requestId)) throw fail('전송 요청을 다시 시작해 주세요.');
        id = 'camera_' + crypto.createHash('sha256').update(req.cameraOwner + requestId).digest('hex');
        if (inflight.has(id)) throw fail('같은 영상을 처리하고 있습니다. 잠시 후 재시도해 주세요.', 409);
        inflight.add(id); locked = true;
        let capturedAt = parsePhotoDate(req.body.capturedAt), dateSource = capturedAt ? (req.body.dateSource === 'capture' ? 'capture' : 'user') : 'unknown';
        if (!capturedAt && req.body.capturedAt) throw fail('영상 날짜를 확인해 주세요.');
        const lastModified = Number(req.body.lastModified);
        if (!capturedAt && Number.isFinite(lastModified) && lastModified > 0 && lastModified < Date.now() + 86400000) { capturedAt = lastModified; dateSource = 'fileModified'; }
        const message = String(req.body.message || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 40);
        if (mode !== 'archive' && /(https?:\/\/|www\.|\b[\w-]+\.(com|net|org|kr|io|co|me|biz|info|shop|xyz)\b)/i.test(message)) throw fail('표출 문구에 링크·주소는 넣을 수 없습니다.');
        const muted = req.body.muted !== '0';
        const fingerprint = (await hashFile(source)).update(JSON.stringify({ mode, target, uploaderName, capturedAt, message, siteId: req.body.siteId || '', muted })).digest('hex');
        const previous = receipts.get(id);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw fail('같은 전송 요청의 영상이나 설정이 달라졌습니다.', 409);
          return res.json({ success: true, replay: true, upload: row(previous) });
        }
        const info = await probe(source);
        if (!info) throw fail('재생할 수 있는 영상이 아닙니다. 다른 영상을 선택해 주세요.');
        if (info.seconds > MAX_VIDEO_SECONDS + 2) throw fail('영상은 3분까지 올릴 수 있습니다.');
        if (mode !== 'live' && getConfig().archiveEnabled === false) throw fail('지금은 사진 보관 접수가 닫혀 있습니다.', 403);
        const site = mode === 'archive' ? null : getSites().find(s => s.id === req.body.siteId);
        if (mode !== 'archive' && !site) throw fail('표출할 모니터를 선택해 주세요.');
        let record = archive.records.get(id);
        if (record && record.fingerprint !== fingerprint) throw fail('기존 접수 영상과 설정이 다릅니다.', 409);
        const photo = { id, ts: record?.ts || Date.now(), owner: req.cameraOwner, uploaderId: req.cameraOwner, uploaderName,
          capturedAt, dateSource, originalName: String(req.file.originalname).slice(0, 255), message, requestId, fingerprint,
          siteId: site?.id || '', siteName: site?.name || '', batchTotal: 1 };
        if (mode !== 'live' && !record) record = archive.enqueueCamera(photo, source, target, target ? {} : { status: 'awaiting_target', splitUpload: true });
        const receipt = { ...photo, mode, target, pipeline: mode === 'both', kind: 'video', muted, durationMs: Math.round(info.seconds * 1000), live: mode === 'archive' ? 'none' : 'pending' };
        if (mode !== 'archive') {
          if (!getConfig().enabled) { receipt.live = 'error'; receipt.liveError = '모니터 표출 접수가 닫혀 있습니다.'; }
          receipt.localName = id + '.' + kind.ext; fs.copyFileSync(source, path.join(liveOriginals, receipt.localName));
        }
        save(receipt);
        if (receipt.live === 'pending') enqueueDisplay(receipt);
        if (record) archive.cycle().catch(() => {});
        res.json({ success: true, upload: row(receipt) });
      })().catch(error => res.status(error.status || 400).json({ error: error.publicMessage || '영상을 접수하지 못했습니다. 설정과 연결을 확인하고 다시 시도해 주세요.', ...(error.backlog ? { backlog: true } : {}) }))
        .finally(() => { if (locked) inflight.delete(id); if (source) try { fs.unlinkSync(source); } catch {} });
    });
  });

  return { enqueueDisplay };
}

module.exports = { mountVideoUpload, probe, convert, MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS };
