'use strict';
const { fail, FOLDER } = require('./drive-folders');
const { errorText } = require('./photo-archive');

// Like CameraFolderCatalog: coalesce reads, serve a recent snapshot immediately,
// and bound the entire operation. Library search needs all years, so read their
// children with limited concurrency instead of waiting for every media file.
class PhotoFolderCatalog {
  constructor(archive, { timeoutMs = 20000, freshMs = 60000, retryMs = 30000, concurrency = 4, now = Date.now } = {}) {
    Object.assign(this, { archive, timeoutMs, freshMs, retryMs, concurrency, now });
    this.pending = null; this.retryAt = 0; this.checkedAt = null;
    this.generation = 0;
    this.drive = archive.drive; this.rootId = archive.folderId;
  }
  async get({ force = false, wait = false } = {}) {
    const { archive } = this;
    if (this.rootId !== archive.folderId) {
      this.controller?.abort(); this.pending = null; this.generation++;
      archive.folderCatalog = { rootId: archive.folderId, checkedAt: 0, years: [] };
      archive.folderError = '';
      this.rootId = archive.folderId; this.checkedAt = null; this.retryAt = 0;
    }
    if (this.drive !== archive.drive) { this.drive = archive.drive; this.checkedAt = null; this.retryAt = 0; }
    const cached = archive.folderCatalog.checkedAt > 0;
    const stale = this.now() - archive.folderCatalog.checkedAt >= this.freshMs;
    if (!force && cached && !stale) return archive.folderCatalog;
    if (cached && !wait) {
      if (force || this.now() >= this.retryAt) this.refresh().catch(() => {});
      return archive.folderCatalog;
    }
    if (!force && this.now() < this.retryAt && archive.folderError) throw fail(archive.folderError, 503);
    return this.refresh();
  }
  refresh() {
    if (this.pending) return this.pending;
    const controller = new AbortController(), rootId = this.archive.folderId, generation = ++this.generation;
    this.controller = controller;
    const options = { signal: controller.signal, timeout: this.timeoutMs };
    const check = () => {
      if (controller.signal.aborted || this.archive.folderId !== rootId || this.generation !== generation) throw fail('폴더 조회 시간이 초과되었습니다. 새로고침으로 다시 확인해 주세요.', 504);
    };
    let timer;
    const operation = (async () => {
      if (!this.archive.ready || this.checkedAt === null || this.now() - this.checkedAt >= this.freshMs) {
        await this.archive.initialize(options); check();
        if (!this.archive.ready) throw fail(this.archive.error || 'Google 드라이브 연결을 확인해 주세요.', 503);
        this.checkedAt = this.now(); this.drive = this.archive.drive;
      }
      const years = (await this.archive.folders.children(rootId, false, options))
        .filter(folder => folder.mimeType === FOLDER && /^(19|20|21)\d{2}$/.test(folder.name));
      check();
      const groups = new Array(years.length); let next = 0;
      const worker = async () => {
        while (next < years.length) {
          check(); const index = next++, year = years[index];
          const children = await this.archive.folders.children(year.id, false, options); check();
          groups[index] = { id: year.id, year: year.name, events: children.filter(folder => folder.mimeType === FOLDER).map(folder => ({ id: folder.id, name: folder.name })) };
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, years.length) }, worker)); check();
      const catalog = { rootId, checkedAt: this.now(), years: groups };
      this.archive.saveFolderCatalog(catalog);
      this.archive.folderError = ''; this.retryAt = 0;
      return catalog;
    })();
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(fail('폴더 조회 시간이 초과되었습니다. 새로고침으로 다시 확인해 주세요.', 504)); }, this.timeoutMs);
    });
    const bounded = Promise.race([operation, deadline]).catch(error => {
      controller.abort(); // Discard other workers and any transport that ignores abort.
      if (this.generation === generation) {
        this.archive.folderError = error.publicMessage || errorText(error);
        this.retryAt = this.now() + this.retryMs;
      }
      throw error;
    }).finally(() => {
      clearTimeout(timer);
      if (this.pending === bounded) this.pending = null;
    });
    this.pending = bounded;
    return bounded;
  }
}
module.exports = { PhotoFolderCatalog };
