'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { finished } = require('node:stream/promises');
const { google } = require('googleapis');

const DEFAULT_FOLDER = '1CvycMd8O3KTb7sFpMJj9IL6DUlWE5mzK';
const META_PREFIX = 'SIGNAGE_PHOTO_V1\n';
const FIELDS = 'id,name,mimeType,description,createdTime,parents,trashed,size,appProperties';
const REQUEST = { timeout: 60000, retry: false };

function atomicJSON(file, value) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function errorText(error) {
  const reason = error?.response?.data?.error?.errors?.[0]?.reason;
  if (reason === 'storageQuotaExceeded') return 'Google 드라이브 저장 공간 또는 계정 연결을 확인해 주세요.';
  if (error?.response?.data?.error === 'invalid_grant') return 'Google 계정 연결이 만료되었습니다. 다시 연결해 주세요.';
  if ([401, 403].includes(Number(error.code || error.response?.status))) return 'Google 계정 연결과 폴더의 편집 권한을 확인해 주세요.';
  if (Number(error.code || error.response?.status) === 404) return 'Google 드라이브 폴더 또는 파일에 접근할 수 없습니다.';
  // Never return a Google HTTP request/config or credentials to the browser/log.
  return '드라이브 처리에 실패했습니다. 잠시 후 자동으로 다시 시도합니다.';
}

class PhotoArchive {
  constructor({ dataDir, folderId = process.env.GDRIVE_PHOTO_FOLDER_ID || DEFAULT_FOLDER, drive = null, authMode = 'service-account' }) {
    if (!/^[\w-]+$/.test(folderId)) throw new Error('Invalid photo folder ID');
    this.folderId = folderId;
    this.root = path.resolve(dataDir, 'photo-archive');
    this.entries = path.join(this.root, 'entries');
    this.media = path.join(this.root, 'media');
    for (const dir of [this.entries, this.media]) fs.mkdirSync(dir, { recursive: true });
    this.records = new Map();
    for (const name of fs.readdirSync(this.entries).filter(n => n.endsWith('.json'))) {
      const record = JSON.parse(fs.readFileSync(path.join(this.entries, name), 'utf8'));
      if (!/^[\w-]{1,128}$/.test(record.id) || name !== record.id + '.json') throw new Error('Invalid photo archive record');
      this.records.set(record.id, record);
    }
    this.drive = drive;
    this.authMode = authMode;
    this.ready = false;
    this.error = '';
    this.folder = null;
    this.lastSync = 0;
    this.tail = Promise.resolve();
    this.oauthFile = path.join(this.root, 'google-oauth.json');
    this.clientId = process.env.GOOGLE_PHOTO_OAUTH_CLIENT_ID || '';
    this.clientSecret = process.env.GOOGLE_PHOTO_OAUTH_CLIENT_SECRET || '';
    this.redirectUri = (process.env.PUBLIC_BASE_URL || 'https://signage.yebom.org').replace(/\/$/, '') + '/api/photos/oauth/callback';
  }

  save(record) {
    atomicJSON(path.join(this.entries, record.id + '.json'), record);
    this.records.set(record.id, record);
  }

  localPath(record) {
    if (!record.localName || path.basename(record.localName) !== record.localName) return null;
    const file = path.join(this.media, record.localName);
    return fs.existsSync(file) ? file : null;
  }

  enqueue(photo, source, site) {
    const ext = path.extname(source).toLowerCase();
    if (!/^\.(jpe?g|png|gif|webp|heic|heif)$/.test(ext)) throw new Error('Invalid photo extension');
    const record = {
      id: photo.id, message: photo.message, ts: photo.ts, siteId: site.id, siteName: site.name,
      localName: photo.id + ext, mimeType: ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif' })[ext],
      name: new Date(photo.ts).toISOString().replace(/[:.]/g, '-') + '_' + photo.id.slice(0, 8) + ext,
      folderId: this.folderId, status: 'pending', attempts: 0, nextAttempt: 0
    };
    // Archive has its own copy: live expiry/clear can never erase an unsaved upload.
    fs.copyFileSync(source, path.join(this.media, record.localName));
    try { this.save(record); }
    catch (e) { fs.unlinkSync(path.join(this.media, record.localName)); throw e; }
    return record;
  }

  oauthClient() {
    if (!this.clientId || !this.clientSecret) throw new Error('Google OAuth 설정이 필요합니다.');
    return new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
  }

  async initialize() {
    if (!this.drive) {
      if (fs.existsSync(this.oauthFile) && this.clientId && this.clientSecret) {
        const auth = this.oauthClient();
        auth.setCredentials(JSON.parse(fs.readFileSync(this.oauthFile, 'utf8')));
        this.drive = google.drive({ version: 'v3', auth });
        this.authMode = 'oauth';
      } else {
        const keyPath = path.join(__dirname, 'credentials', 'service-account.json');
        const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || (fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf8') : '');
        if (!key) { this.error = 'Google 계정을 연결해 주세요.'; return; }
        this.drive = google.drive({ version: 'v3', auth: new google.auth.GoogleAuth({
          credentials: JSON.parse(key), scopes: ['https://www.googleapis.com/auth/drive']
        }) });
      }
    }
    await this.checkFolder();
  }

  async checkFolder(drive = this.drive, mode = this.authMode) {
    const { data } = await drive.files.get({ fileId: this.folderId, supportsAllDrives: true,
      fields: 'id,name,mimeType,driveId,trashed,capabilities(canAddChildren)' }, REQUEST);
    if (data.trashed || data.mimeType !== 'application/vnd.google-apps.folder') throw new Error('Invalid photo folder');
    if (drive !== this.drive) return data;
    this.folder = data;
    this.ready = !!data.capabilities?.canAddChildren && (mode === 'oauth' || !!data.driveId);
    this.error = this.ready ? '' : mode !== 'oauth' && !data.driveId
      ? '내 드라이브에 보관하려면 폴더 소유자의 Google 계정을 연결해 주세요. 서버 보관 사진은 연결 후 자동 전송됩니다.'
      : '사진 폴더의 편집 권한을 확인해 주세요.';
    return data;
  }

  async connect(code) {
    const auth = this.oauthClient();
    const { tokens } = await auth.getToken(code);
    if (!tokens.refresh_token) throw new Error('자동 보관 권한이 없습니다. Google 계정을 다시 연결해 주세요.');
    auth.setCredentials(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const folder = await this.checkFolder(drive, 'oauth');
    if (!folder.capabilities?.canAddChildren) throw new Error('선택한 Google 계정에 사진 폴더 편집 권한이 없습니다.');
    // Persist only the refresh token, never expose it through status/metadata APIs.
    atomicJSON(this.oauthFile, { refresh_token: tokens.refresh_token });
    this.drive = drive;
    this.authMode = 'oauth';
    this.folder = folder;
    this.ready = true;
    this.error = '';
    for (const r of this.records.values()) if (['pending', 'error', 'deleting'].includes(r.status)) { r.nextAttempt = 0; this.save(r); }
  }

  serialize(fn) {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }

  status() {
    const counts = { pending: 0, saved: 0, error: 0, deleting: 0 };
    for (const r of this.records.values()) if (r.folderId === this.folderId && r.status in counts) counts[r.status]++;
    return { folderId: this.folderId, folderName: this.folder?.name || '', ready: this.ready,
      authMode: this.authMode, oauthConfigured: !!(this.clientId && this.clientSecret),
      error: this.error, counts, lastSync: this.lastSync || null };
  }

  list({ date = '', offset = 0, limit = 40 } = {}) {
    const rows = [...this.records.values()].filter(r => r.folderId === this.folderId && !['deleted', 'missing'].includes(r.status))
      .filter(r => !date || new Date(r.ts + 9 * 3600000).toISOString().slice(0, 10) === date)
      .sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id));
    return { total: rows.length, photos: rows.slice(offset, offset + limit).map(r => ({
      id: r.id, message: r.message, ts: r.ts, siteName: r.siteName, name: r.name,
      status: r.status, error: r.error || '', url: '/api/photos/' + encodeURIComponent(r.id) + '/image'
    })) };
  }

  get(id) {
    const r = this.records.get(id);
    return r && r.folderId === this.folderId && !['deleted', 'missing', 'deleting'].includes(r.status) ? r : null;
  }

  async upload(r) {
    const file = this.localPath(r);
    if (!file) throw new Error('Missing local photo');
    if (!r.driveId) {
      const { data } = await this.drive.files.generateIds({ count: 1, space: 'drive', type: 'files' }, REQUEST);
      r.driveId = data.ids[0];
      this.save(r); // Persist generated ID before sending media, so retries cannot duplicate photos.
    }
    const metadata = { message: r.message, ts: r.ts, siteId: r.siteId, siteName: r.siteName };
    const body = fs.createReadStream(file);
    const closed = finished(body).catch(() => {});
    try {
      await this.drive.files.create({ supportsAllDrives: true, fields: 'id', requestBody: {
        id: r.driveId, name: r.name, parents: [this.folderId],
        description: META_PREFIX + JSON.stringify(metadata), appProperties: { signagePhotoId: r.id }
      }, media: { mimeType: r.mimeType, body } }, REQUEST);
    } catch (e) {
      if (Number(e.code || e.response?.status) !== 409) throw e;
      // A timed-out request may already have succeeded. Verify identity before accepting conflict.
      const { data } = await this.drive.files.get({ fileId: r.driveId, supportsAllDrives: true, fields: FIELDS }, REQUEST);
      if (data.trashed || !data.parents?.includes(this.folderId) || data.appProperties?.signagePhotoId !== r.id) throw e;
    } finally { body.destroy(); await closed; }
    const deleting = r.status === 'deleting';
    r.status = deleting ? 'deleting' : 'saved'; r.error = ''; r.attempts = 0; r.savedAt = Date.now();
    this.save(r);
    if (deleting) return this.trash(r);
    // Live keeps a separate copy. Saved archive media can be streamed from Drive.
    try { fs.unlinkSync(file); } catch {} // Remote save is already durable; cleanup failure is not upload failure.
  }

  markDelete(id) {
    const r = this.records.get(id);
    if (!r || r.folderId !== this.folderId || ['deleted', 'missing'].includes(r.status)) return false;
    r.status = 'deleting'; r.error = ''; r.nextAttempt = 0;
    this.save(r);
    return true;
  }

  async trash(r) {
    if (r.driveId) {
      if (!this.drive) throw new Error('No Drive connection');
      let data;
      try { ({ data } = await this.drive.files.get({ fileId: r.driveId, supportsAllDrives: true, fields: 'id,parents,trashed' }, REQUEST)); }
      catch (e) {
        // An allocated ID may never have been uploaded. For saved files, 404 can also mean
        // revoked permission; keep the tombstone pending instead of falsely claiming deletion.
        if (Number(e.code || e.response?.status) !== 404 || r.savedAt) throw e;
      }
      if (data && !data.trashed) {
        if (!data.parents?.includes(this.folderId)) throw new Error('Photo moved outside archive folder');
        await this.drive.files.update({ fileId: r.driveId, supportsAllDrives: true, requestBody: { trashed: true }, fields: 'id' }, REQUEST);
      }
    }
    r.status = 'deleted'; r.error = ''; this.save(r);
    const file = this.localPath(r);
    if (file) fs.unlinkSync(file);
  }

  async importFiles() {
    let pageToken;
    const files = [];
    do {
      const { data } = await this.drive.files.list({
        q: `'${this.folderId}' in parents and trashed = false and mimeType contains 'image/'`,
        pageSize: 1000, pageToken, fields: `nextPageToken,files(${FIELDS})`,
        supportsAllDrives: true, includeItemsFromAllDrives: true
      }, REQUEST);
      files.push(...(data.files || [])); pageToken = data.nextPageToken;
    } while (pageToken);
    const byDrive = new Map([...this.records.values()].map(r => [r.driveId, r]));
    const seen = new Set();
    for (const f of files) {
      seen.add(f.id);
      const existing = byDrive.get(f.id);
      if (existing) {
        // Local deletion tombstones win over eventual-consistency list results.
        if (existing.status === 'missing') { existing.status = 'saved'; this.save(existing); }
        continue;
      }
      let meta = {};
      if (f.description?.startsWith(META_PREFIX)) {
        try {
          const value = JSON.parse(f.description.slice(META_PREFIX.length));
          if (value && typeof value === 'object' && !Array.isArray(value)) meta = value;
        } catch {}
      }
      const candidate = f.appProperties?.signagePhotoId;
      const id = candidate && /^[\w-]{1,128}$/.test(candidate) && !this.records.has(candidate) ? candidate : 'drive_' + f.id;
      if (this.records.has(id)) continue;
      const ts = Number(meta.ts) || Date.parse(f.createdTime);
      const r = { id, driveId: f.id, folderId: this.folderId, name: f.name, mimeType: f.mimeType,
        message: String(meta.message ?? f.description ?? '').slice(0, 2000),
        ts: Number.isFinite(ts) && ts > 0 && ts < 8640000000000000 ? ts : Date.now(),
        siteId: String(meta.siteId || ''), siteName: String(meta.siteName || ''), status: 'saved', savedAt: Date.now() };
      this.save(r);
    }
    for (const r of this.records.values()) {
      if (r.folderId === this.folderId && r.status === 'saved' && !seen.has(r.driveId)) {
        r.status = 'missing'; this.save(r);
      }
    }
    this.lastSync = Date.now();
  }

  async cycle(force = false) {
    if (this.cycling) return this.cycling;
    this.cycling = this.serialize(async () => {
      try {
        await this.initialize();
        if (this.drive && (force || Date.now() - this.lastSync > 180000)) await this.importFiles();
      } catch (e) { this.ready = false; this.error = errorText(e); }
      const due = [...this.records.values()].filter(r => r.folderId === this.folderId && ['pending', 'error', 'deleting'].includes(r.status) && (force || !r.nextAttempt || r.nextAttempt <= Date.now())).slice(0, 10);
      for (const r of due) {
        if (r.status !== 'deleting' && !this.ready) continue;
        try {
          if (r.status === 'deleting') await this.trash(r); else await this.upload(r);
        } catch (e) {
          if (r.status !== 'deleting') r.status = 'error';
          r.error = errorText(e); r.attempts = (r.attempts || 0) + 1;
          r.nextAttempt = Date.now() + Math.min(1800000, 30000 * 2 ** Math.min(r.attempts - 1, 6));
          this.save(r);
        }
      }
    }).finally(() => { this.cycling = null; });
    return this.cycling;
  }

  start() {
    const tick = () => this.cycle().catch(() => { this.error = '서버 보관 상태를 확인해 주세요.'; });
    tick(); this.timer = setInterval(tick, 30000); this.timer.unref();
  }

  async image(id, res, download = false) {
    const r = this.get(id);
    if (!r) return res.status(404).json({ error: '사진을 찾을 수 없습니다.' });
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "sandbox; default-src 'none'");
    res.type(r.mimeType);
    if (download) res.attachment(r.name);
    const file = this.localPath(r);
    if (file) return res.sendFile(file);
    if (!this.drive || !r.driveId) return res.status(503).json({ error: '사진을 불러올 수 없습니다.' });
    try {
      const { data } = await this.drive.files.get({ fileId: r.driveId, supportsAllDrives: true, fields: 'id,parents,trashed' }, REQUEST);
      if (data.trashed || !data.parents?.includes(this.folderId)) return res.status(404).json({ error: '드라이브 폴더에 사진이 없습니다.' });
      const result = await this.drive.files.get({ fileId: r.driveId, alt: 'media', supportsAllDrives: true }, { ...REQUEST, responseType: 'stream' });
      result.data.on('error', () => res.destroy());
      res.on('close', () => result.data.destroy());
      result.data.pipe(res);
    } catch (e) { res.status(502).json({ error: errorText(e) }); }
  }
}

module.exports = { PhotoArchive, DEFAULT_FOLDER, META_PREFIX, atomicJSON, errorText };
