'use strict';
const { fail } = require('./drive-folders');
const { errorText, connectReason } = require('./photo-archive');

// Read-only browsing cache. Uploads and folder creation still validate the live
// hierarchy through DriveFolders.resolve; an unsuccessful read is never absence.
class CameraFolderCatalog {
  constructor(archive, { timeoutMs = 20000, freshMs = 60000, staleMs = 300000, now = Date.now, log = entry => console.warn('[camera-folders]', JSON.stringify(entry)) } = {}) {
    Object.assign(this, { archive, timeoutMs, freshMs, staleMs, now, log });
    this.cache = new Map(); this.pending = new Map(); this.checkedAt = null;
    this.drive = archive.drive; this.rootId = archive.folderId;
  }
  async get(year, yearId = '', force = false) {
    if (!/^(19|20|21)\d{2}$/.test(year) || (yearId && !/^[\w-]{1,128}$/.test(yearId))) throw fail('연도와 폴더 선택을 확인해 주세요.');
    const { archive } = this;
    if (this.drive !== archive.drive || this.rootId !== archive.folderId) {
      this.cache.clear(); this.checkedAt = null; this.drive = archive.drive; this.rootId = archive.folderId;
    }
    const key = year + '/' + yearId, cached = this.cache.get(key);
    const age = cached ? this.now() - cached.checkedAt : Infinity;
    if (!force && age < this.freshMs) return { ...cached.data, checkedAt: cached.checkedAt, cached: true };
    if (!force && age < this.staleMs) {
      this.refresh(key, year, yearId).catch(() => {});
      return { ...cached.data, checkedAt: cached.checkedAt, cached: true, refreshing: true,
        warning: cached.error || '최근 확인한 목록입니다. 최신 목록을 백그라운드에서 확인합니다.' };
    }
    return this.refresh(key, year, yearId);
  }
  refresh(key, year, yearId) {
    if (this.pending.has(key)) return this.pending.get(key);
    const started = this.now(), controller = new AbortController();
    let phase = 'root', timer;
    const operation = (async () => {
      if (!this.archive.ready || this.checkedAt === null || this.now() - this.checkedAt >= this.freshMs) {
        await this.archive.initialize({ signal: controller.signal, timeout: this.timeoutMs });
        if (controller.signal.aborted) throw fail('폴더 조회 시간이 초과되었습니다. 목록 다시 확인을 눌러 주세요.', 504);
        if (!this.archive.ready) throw fail(this.archive.error || '관리자에게 Google 드라이브 연결을 요청해 주세요.', 503);
        this.checkedAt = this.now(); this.drive = this.archive.drive;
      }
      phase = 'years';
      const options = { signal: controller.signal, timeout: this.timeoutMs };
      const years = (await this.archive.folders.children(this.archive.folderId, false, options))
        .filter(f => /^(19|20|21)\d{2}$/.test(f.name)).map(f => ({ id: f.id, name: f.name })).sort((a, b) => b.name.localeCompare(a.name));
      if (controller.signal.aborted) throw fail('폴더 조회 시간이 초과되었습니다. 목록 다시 확인을 눌러 주세요.', 504);
      const matches = years.filter(y => y.name === year);
      const ambiguous = !yearId && matches.length > 1;
      const selected = yearId ? matches.find(y => y.id === yearId) : ambiguous ? null : matches[0];
      if (yearId && !selected) throw fail('선택한 연도 폴더가 이동·삭제되었습니다. 저장 폴더를 다시 선택해 주세요.', 409);
      phase = 'events';
      const events = selected ? (await this.archive.folders.children(selected.id, false, options))
        .map(f => ({ id: f.id, name: f.name, writable: f.capabilities?.canAddChildren !== false })).sort((a, b) => a.name.localeCompare(b.name, 'ko')) : [];
      if (controller.signal.aborted) throw fail('폴더 조회 시간이 초과되었습니다. 목록 다시 확인을 눌러 주세요.', 504);
      const data = { years, yearId: selected?.id || '', events, exists: !!selected, ambiguous };
      const checkedAt = this.now(); this.cache.set(key, { data, checkedAt });
      return { ...data, checkedAt, cached: false };
    })();
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => { reject(fail('폴더 조회 시간이 초과되었습니다. 인터넷 연결을 확인하고 목록 다시 확인을 눌러 주세요.', 504)); controller.abort(); }, this.timeoutMs);
    });
    const bounded = Promise.race([operation, deadline]).catch(error => {
      const status = Number(error.code || error.response?.status || error.status) || 503;
      const reason = connectReason(error);
      if ([401, 403, 404, 409].includes(status) || reason === 'invalid_grant') this.cache.delete(key);
      else if (this.cache.has(key)) this.cache.get(key).error = errorText(error);
      this.log({ phase, status, reason, elapsedMs: this.now() - started });
      error.status = error.status || ([400, 401, 403, 404, 409, 504].includes(status) ? status : 503);
      error.publicMessage = errorText(error).replace('잠시 후 자동으로 다시 시도합니다.', '목록 다시 확인을 눌러 주세요.') + ' [FOLDERS_' + phase.toUpperCase() + '_' + error.status + ']';
      throw error;
    }).finally(() => {
      clearTimeout(timer);
      if (this.pending.get(key) === bounded) this.pending.delete(key);
    });
    this.pending.set(key, bounded);
    // A timed-out auth/Drive call may never settle. Release the failed request
    // at the deadline so a retry can start; abort guards discard late results.
    return bounded;
  }
}
module.exports = { CameraFolderCatalog };
