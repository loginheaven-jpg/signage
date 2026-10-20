'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const fail = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, publicMessage: message, ...extra });
function safeName(name) {
  if (typeof name !== 'string' || !name || name !== path.posix.basename(name) || name !== path.win32.basename(name) || /[\x00-\x1f]/.test(name) || name === '.' || name === '..') throw fail('파일 경로를 확인해 주세요.');
  return name;
}

// 모든 장소의 미적용·사용 꺼짐·기간 종료 항목도 참조로 취급한다.
function contentUsage(sheets, sites, filename) {
  const found = [];
  for (const sheet of sheets) {
    const add = (items, field, monitor) => (items || []).forEach((item, i) => {
      if (item[field] === filename) found.push({ siteId: sheet.siteId, siteName: sites.find(s => s.id === sheet.siteId)?.name || sheet.siteId,
        sheetId: sheet.id, sheetName: sheet.name, monitor, row: i + 1, enabled: item.enabled !== false, validFrom: item.validFrom, validTo: item.validTo });
    });
    if (sheet.type === 'sync') { add(sheet.rows, 'file1', 'A'); add(sheet.rows, 'file2', 'B'); }
    else { add(sheet.a, 'file', 'A'); add(sheet.b, 'file', 'B'); }
  }
  return found;
}

class ContentLibrary {
  constructor({ dataDir, uploadsDir }) {
    this.uploadsDir = uploadsDir;
    this.dir = path.join(dataDir, 'content-trash');
    this.file = path.join(this.dir, 'index.json');
    this.blobs = path.join(this.dir, 'files');
    this.busy = new Map();
    fs.mkdirSync(this.blobs, { recursive: true });
    // 손상된 색인을 빈 휴지통으로 덮어쓰지 않는다. 삭제·동기화 제외 기록을 보존한다.
    const saved = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, items: [] };
    if (saved.version !== 1 || !Array.isArray(saved.items)) throw new Error('Invalid content trash index');
    this.records = new Map(saved.items.map(item => {
      safeName(item.filename);
      if (item.blob) safeName(item.blob);
      if (!['trash', 'active', 'deleting', 'deleted'].includes(item.status)) throw new Error('Invalid content trash state');
      return [item.id, item];
    }));
    // 메타데이터 기록 뒤 중단된 파일 정리를 재실행한다. 영구 삭제는 명시적으로 요청된 건만 이어간다.
    for (const record of this.records.values()) {
      if (record.status === 'trash') this.unlink(this.uploadPath(record.filename));
      if (record.status === 'active' && record.blob) {
        const blob = this.blobPath(record);
        if (!fs.existsSync(this.uploadPath(record.filename)) && fs.existsSync(blob)) fs.copyFileSync(blob, this.uploadPath(record.filename));
        this.unlink(blob);
      }
      if (record.status === 'deleting') {
        try { this.finishDelete(record); } catch (error) { console.error('[ContentTrash] 삭제 재시도 필요:', error.message); }
      }
    }
    // 메타데이터 기록 전에 중단된 복사본만 정리한다. 등록된 휴지통 파일에는 만료 처리가 없다.
    const referenced = new Set([...this.records.values()].filter(r => r.status === 'trash' || r.status === 'deleting').map(r => r.blob));
    for (const name of fs.readdirSync(this.blobs)) if (/^[\da-f-]{36}\.bin$/.test(name) && !referenced.has(name)) this.unlink(path.join(this.blobs, name));
    for (const name of fs.readdirSync(this.uploadsDir)) if (/\.[\da-f-]{36}\.restore$/.test(name)) this.unlink(path.join(this.uploadsDir, name));
  }
  uploadPath(filename) { return path.join(this.uploadsDir, safeName(filename)); }
  blobPath(record) { return path.join(this.blobs, safeName(record.blob)); }
  unlink(file) { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  commit(record) {
    const next = new Map(this.records); next.set(record.id, record);
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ version: 1, items: [...next.values()] }, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file); this.records = next;
  }
  isBusy(id) { return this.busy.has(id); }
  excludesDrive(id) { return this.records.has(id) || this.busy.has(id); }
  unavailable(filename) {
    return [...this.records.values()].some(r => r.filename === filename && r.status !== 'active') || [...this.busy.values()].some(r => r.filename === filename && r.operation !== 'restore');
  }
  visible(file) { const record = this.records.get(file.id); return !record || record.status === 'active'; }
  activeFiles() { return [...this.records.values()].filter(r => r.status === 'active' && fs.existsSync(this.uploadPath(r.filename))).map(r => ({ ...r.file, retainedLocal: true })); }
  list() {
    const items = [...this.records.values()].filter(r => r.status === 'trash' || r.status === 'deleting').map(r => ({
      ...r.file, trashedAt: r.trashedAt, deleting: r.status === 'deleting', url: `/api/content-trash/${encodeURIComponent(r.id)}/preview`
    })).sort((a, b) => b.trashedAt.localeCompare(a.trashedAt) || a.id.localeCompare(b.id));
    return { items, count: items.length, totalBytes: items.reduce((n, item) => n + (Number(item.size) || 0), 0) };
  }
  async locked(id, filename, operation, fn) {
    if (this.busy.has(id)) throw fail('이 파일을 처리 중입니다. 잠시 후 다시 시도해 주세요.', 409);
    this.busy.set(id, { filename, operation });
    try { return await fn(); } finally { this.busy.delete(id); }
  }
  async trash(file, getUsage) {
    if (this.isBusy(file.id)) throw fail('이 파일을 처리 중입니다. 잠시 후 다시 시도해 주세요.', 409);
    const existing = this.records.get(file.id);
    if (existing?.status === 'trash') return existing.file;
    return this.locked(file.id, file.filename, 'trash', async () => {
      const locations = getUsage(file.filename);
      if (locations.length) throw fail('큐시트에서 사용 중입니다. 먼저 해당 항목의 파일을 바꾸거나 해제해 주세요.', 409, { locations });
      const blob = crypto.randomUUID() + '.bin', target = path.join(this.blobs, blob);
      let committed = false;
      try {
        await fs.promises.copyFile(this.uploadPath(file.filename), target, fs.constants.COPYFILE_EXCL);
        const size = (await fs.promises.stat(target)).size;
        const again = getUsage(file.filename);
        if (again.length) throw fail('큐시트에서 사용 중입니다. 먼저 해제해 주세요.', 409, { locations: again });
        const record = { id: file.id, filename: file.filename, driveId: file.source === 'gdrive' ? file.id : null,
          status: 'trash', blob, trashedAt: new Date().toISOString(), file: { ...file, size } };
        this.commit(record); committed = true;
        try { this.unlink(this.uploadPath(file.filename)); } catch (error) { console.warn('[ContentTrash] 원래 경로 정리 재시도:', error.message); }
        return record.file;
      } finally { if (!committed) this.unlink(target); }
    });
  }
  async restore(id) {
    if (this.isBusy(id)) throw fail('이 파일을 처리 중입니다. 잠시 후 다시 시도해 주세요.', 409);
    const record = this.records.get(id);
    if (!record || record.status === 'deleted') throw fail('휴지통에서 파일을 찾을 수 없습니다.', 404);
    if (record.status === 'active') return { ...record.file, retainedLocal: true };
    if (record.status !== 'trash') throw fail('영구 삭제 중인 파일은 복원할 수 없습니다.', 409);
    return this.locked(id, record.filename, 'restore', async () => {
      const target = this.uploadPath(record.filename), tmp = target + '.' + crypto.randomUUID() + '.restore';
      try {
        await fs.promises.copyFile(this.blobPath(record), tmp);
        await fs.promises.rename(tmp, target);
        this.commit({ ...record, status: 'active' });
      } finally { this.unlink(tmp); }
      try { this.unlink(this.blobPath(record)); } catch (error) { console.warn('[ContentTrash] 복원 사본 정리 재시도:', error.message); }
      return { ...record.file, retainedLocal: true };
    });
  }
  finishDelete(record) {
    this.unlink(this.blobPath(record)); this.unlink(this.uploadPath(record.filename));
    this.commit({ id: record.id, filename: record.filename, driveId: record.driveId, status: 'deleted' });
  }
  async purge(id) {
    const record = this.records.get(id);
    if (record?.status === 'deleted') return;
    if (!record || record.status === 'active') throw fail('휴지통에서 파일을 찾을 수 없습니다.', 404);
    return this.locked(id, record.filename, 'delete', async () => {
      const deleting = { ...record, status: 'deleting' };
      this.commit(deleting); this.finishDelete(deleting);
    });
  }
  preview(id) {
    const record = this.records.get(id);
    if (!record || record.status !== 'trash') throw fail('휴지통에서 파일을 찾을 수 없습니다.', 404);
    return { path: this.blobPath(record), mimeType: record.file.mimeType };
  }
}
module.exports = { ContentLibrary, contentUsage };
