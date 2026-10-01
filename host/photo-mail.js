'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicJSON } = require('./photo-archive');

const MAX_BYTES = 18 * 1024 * 1024; // Gmail refuses mail over 25MB after Base64 (about 18.7MB of files).
const MAX_PHOTOS = 12;
const MAX_ATTEMPTS = 6;
const SETTLE_MS = 2000; // Sent only after the uploader's cancel window has definitely closed.
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif' };

// '' when empty, null when it is not one plain address. Nothing that could add a header or a second recipient passes.
function normalizeEmail(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (s.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(s)) return null;
  const at = s.lastIndexOf('@');
  return s.slice(0, at) + '@' + s.slice(at + 1).toLowerCase();
}
function errorText(error) {
  if (error?.code === 'EAUTH') return '메일 계정 로그인에 실패했습니다. SMTP_USER와 앱 비밀번호를 확인해 주세요.';
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED'].includes(error?.code)) return '메일 서버에 연결하지 못했습니다.';
  if (error?.code === 'EENVELOPE' || Number(error?.responseCode) >= 500) return '메일 서버가 발송을 거절했습니다. 주소와 발송 한도를 확인해 주세요.';
  // Never return the SMTP conversation: it contains the recipient address.
  return '메일을 보내지 못했습니다. 잠시 후 자동으로 다시 시도합니다.';
}
const koreanDay = ts => new Date(ts + 9 * 3600000).toISOString().slice(0, 10);

class PhotoMail {
  constructor({ dataDir, env = process.env, transport = null, now = Date.now }) {
    this.root = path.resolve(dataDir, 'photo-mail');
    this.jobsDir = path.join(this.root, 'jobs');
    this.media = path.join(this.root, 'media');
    for (const dir of [this.jobsDir, this.media]) fs.mkdirSync(dir, { recursive: true });
    this.now = now;
    this.host = env.SMTP_HOST || 'smtp.gmail.com';
    this.port = Number(env.SMTP_PORT) || 465;
    this.user = env.SMTP_USER || '';
    this.pass = env.SMTP_PASS || '';
    this.fromName = (env.MAIL_FROM_NAME || '예봄교회').replace(/[\x00-\x1f"<>]/g, '').slice(0, 60);
    this.fromAddress = normalizeEmail(env.MAIL_FROM) || this.user;
    this.dailyLimit = Math.max(1, Number(env.MAIL_DAILY_LIMIT) || 300);
    this.transport = transport;
    this.configured = !!transport || !!(this.user && this.pass);
    this.jobs = new Map();
    for (const name of fs.readdirSync(this.jobsDir).filter(n => n.endsWith('.json'))) {
      const job = JSON.parse(fs.readFileSync(path.join(this.jobsDir, name), 'utf8'));
      if (!/^[\w-]{1,64}$/.test(job.id) || name !== job.id + '.json') throw new Error('Invalid photo mail job');
      this.jobs.set(job.id, job);
    }
    this.stateFile = path.join(this.root, 'state.json');
    try { this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; this.state = { day: '', sent: 0 }; }
    // A copy whose job was never saved (crash in between) belongs to no mail.
    const wanted = new Set([...this.jobs.values()].flatMap(j => j.photos.map(p => p.localName)));
    for (const name of fs.readdirSync(this.media)) if (!wanted.has(name)) try { fs.unlinkSync(path.join(this.media, name)); } catch {}
    this.results = new Map(); // photoId -> 'sent' | 'failed' | 'cancelled' (the address itself is not kept)
    this.sending = new Set();
    this.lastError = '';
  }

  save(job) {
    atomicJSON(path.join(this.jobsDir, job.id + '.json'), job);
    this.jobs.set(job.id, job);
  }

  // The address and the mail copies of the photos leave the server together with the job.
  drop(job, result) {
    for (const p of job.photos) {
      this.unlinkMedia(p);
      this.results.set(p.id, result);
    }
    while (this.results.size > 500) this.results.delete(this.results.keys().next().value);
    try { fs.unlinkSync(path.join(this.jobsDir, job.id + '.json')); } catch {}
    this.jobs.delete(job.id);
  }

  unlinkMedia(p) {
    if (path.basename(p.localName) !== p.localName) return;
    try { fs.unlinkSync(path.join(this.media, p.localName)); } catch {}
  }

  sentToday() {
    const day = koreanDay(this.now());
    if (this.state.day !== day) this.state = { day, sent: 0 };
    return this.state.sent;
  }

  enqueue({ photo, source, site, email, delayMs }) {
    if (!this.configured) return 'off';
    const ext = path.extname(source).toLowerCase();
    if (!TYPES[ext]) throw new Error('Invalid photo extension');
    const size = fs.statSync(source).size;
    // Photos one person sends to one address within the cancel window travel as one mail.
    let job = [...this.jobs.values()].find(j => !this.sending.has(j.id) && !j.attempts && j.email === email
      && j.uploaderId === photo.uploaderId && j.siteId === site.id && j.photos.length < MAX_PHOTOS
      && j.photos.reduce((sum, p) => sum + p.size, size) <= MAX_BYTES);
    if (!job) {
      if (this.sentToday() + this.jobs.size >= this.dailyLimit) return 'limit';
      job = { id: crypto.randomUUID(), email, uploaderId: photo.uploaderId, siteId: site.id, siteName: site.name,
        photos: [], attempts: 0, nextAttempt: 0, sendAfter: 0 };
    }
    const localName = photo.id + ext;
    // Own copy, like the archive: live expiry/clear must not empty a mail that was promised.
    fs.copyFileSync(source, path.join(this.media, localName));
    job.photos.push({ id: photo.id, localName, message: photo.message, ts: photo.ts, size });
    job.sendAfter = this.now() + delayMs + SETTLE_MS;
    try { this.save(job); }
    catch (e) { job.photos.pop(); this.unlinkMedia({ localName }); throw e; }
    this.results.delete(photo.id);
    const timer = setTimeout(() => this.cycle().catch(() => {}), delayMs + SETTLE_MS + 50);
    timer.unref();
    return 'queued';
  }

  jobOf(photoId) {
    for (const job of this.jobs.values()) if (job.photos.some(p => p.id === photoId)) return job;
    return null;
  }

  // Takes one photo out of a mail that has not left yet. A given uploaderId must own the mail.
  remove(photoId, uploaderId) {
    const job = this.jobOf(photoId);
    if (!job || this.sending.has(job.id)) return false;
    if (uploaderId !== undefined && job.uploaderId && job.uploaderId !== uploaderId) return false;
    const [photo] = job.photos.splice(job.photos.findIndex(p => p.id === photoId), 1);
    this.unlinkMedia(photo);
    this.results.set(photoId, 'cancelled');
    if (job.photos.length) this.save(job); else this.drop(job, 'cancelled');
    return true;
  }

  statusOf(photoId) {
    return this.results.get(photoId) || (this.jobOf(photoId) ? 'queued' : null);
  }

  status() {
    return { configured: this.configured, waiting: this.jobs.size, sentToday: this.sentToday(),
      dailyLimit: this.dailyLimit, error: this.lastError };
  }

  message(job) {
    const stamp = ts => new Date(ts + 9 * 3600000).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
    const when = new Date(job.photos[0].ts).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'long', timeStyle: 'short' });
    const words = [...new Set(job.photos.map(p => p.message).filter(Boolean))];
    return {
      from: { name: this.fromName, address: this.fromAddress },
      to: job.email,
      subject: `[${this.fromName}] 사진을 보내드립니다`,
      text: [
        '샬롬 ^^',
        '환영합니다.',
        `${this.fromName}에서 찍은 사진 ${job.photos.length}장을 보내드립니다.`,
        '',
        `등록 일시: ${when}`,
        ...words.map(w => `함께 올린 문구: ${w}`),
        '',
        '이 메일은 촬영 화면에 이 주소가 입력되어 자동으로 발송되었습니다.',
        '요청하지 않은 메일이라면 무시하셔도 됩니다. 입력된 주소는 발송 후 서버에서 삭제하며 다른 용도로 쓰지 않습니다.'
      ].join('\n'),
      attachments: job.photos.map((p, i) => ({
        filename: `photo_${stamp(p.ts)}_${i + 1}${path.extname(p.localName)}`,
        path: path.join(this.media, p.localName), contentType: TYPES[path.extname(p.localName)]
      }))
    };
  }

  async send(job) {
    job.photos = job.photos.filter(p => fs.existsSync(path.join(this.media, p.localName)));
    if (!job.photos.length) return this.drop(job, 'failed');
    if (!this.transport) {
      const secure = this.port === 465;
      this.transport = require('nodemailer').createTransport({
        host: this.host, port: this.port, secure,
        // The password must never cross the network in clear text, except to a local test server.
        requireTLS: !secure && !/^(localhost|127\.0\.0\.1)$/.test(this.host),
        auth: { user: this.user, pass: this.pass },
        connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 120000
      });
    }
    this.sending.add(job.id);
    try {
      await this.transport.sendMail(this.message(job));
      this.sentToday(); this.state.sent++;
      try { atomicJSON(this.stateFile, this.state); } catch {}
      this.lastError = '';
      this.drop(job, 'sent');
    } catch (e) {
      this.lastError = errorText(e);
      job.attempts++;
      if (job.attempts >= MAX_ATTEMPTS) return this.drop(job, 'failed');
      job.nextAttempt = this.now() + Math.min(1800000, 60000 * 2 ** (job.attempts - 1));
      this.save(job);
    } finally { this.sending.delete(job.id); }
  }

  cycle() {
    if (!this.cycling) this.cycling = (async () => {
      if (!this.configured) return;
      const now = this.now();
      for (const job of [...this.jobs.values()].filter(j => j.sendAfter <= now && j.nextAttempt <= now)) {
        // A mail emptied by cancellation while an earlier one was being sent is already gone.
        if (this.jobs.get(job.id) === job) await this.send(job);
      }
    })().finally(() => { this.cycling = null; });
    return this.cycling;
  }

  start() {
    const tick = () => this.cycle().catch(() => { this.lastError = '메일 발송 대기열을 확인해 주세요.'; });
    tick(); this.timer = setInterval(tick, 15000); this.timer.unref();
  }
}

module.exports = { PhotoMail, normalizeEmail, errorText };
