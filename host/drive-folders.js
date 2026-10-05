'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,parents,trashed,capabilities(canAddChildren)';
const REQUEST = { timeout: 30000, retry: false };
const fail = (message, status = 400) => Object.assign(new Error(message), { status, publicMessage: message });
const normalized = value => String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
function targetInput(value) {
  const year = String(value.year || '');
  if (!/^(19|20|21)\d{2}$/.test(year)) throw fail('연도를 네 자리로 입력해 주세요. (1900~2199)');
  for (const key of ['yearId', 'eventId']) if (value[key] && !/^[\w-]{1,128}$/.test(value[key])) throw fail('폴더 선택을 다시 확인해 주세요.');
  const eventName = normalized(value.eventName);
  const eventDate = String(value.eventDate || '');
  const date = new Date(eventDate + 'T00:00:00Z');
  if (eventDate && (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== eventDate || !eventDate.startsWith(year + '-'))) throw fail('행사 날짜와 저장 연도를 확인해 주세요.');
  if (!value.eventId && (!eventName || [...eventName].length > 80 || /[\\/\x00-\x1f\x7f]/.test(eventName) || ['.', '..'].includes(eventName))) throw fail('행사명을 1~80자로 입력해 주세요. /와 \\는 사용할 수 없습니다.');
  return { year, yearId: value.yearId || '', eventId: value.eventId || '', eventName, eventDate,
    folderName: eventDate ? eventDate.replace(/-/g, '') + ' ' + eventName : eventName };
}

// Call mutations through PhotoArchive.serialize: the journal also survives ambiguous
// Drive responses and process restarts. One persistent writer per DATA_DIR is required.
class DriveFolders {
  constructor(archive) {
    this.archive = archive;
    this.file = path.join(archive.root, 'folder-journal.json');
    this.journal = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
  }
  save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.journal), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  async children(parent, images = false, options = {}) {
    const files = []; let pageToken;
    do {
      const { data } = await this.archive.drive.files.list({
        q: `'${parent}' in parents and trashed = false and ${images ? "mimeType contains 'image/'" : "mimeType = '" + FOLDER + "'"}`,
        pageSize: 1000, pageToken, fields: `nextPageToken,files(${images ? 'id,name,mimeType,description,createdTime,parents,trashed,size,appProperties' : FIELDS})`,
        supportsAllDrives: true, includeItemsFromAllDrives: true
      }, { ...REQUEST, ...options });
      files.push(...(data.files || [])); pageToken = data.nextPageToken;
    } while (pageToken);
    return files;
  }
  async verify(id, parent, name) {
    const { data } = await this.archive.drive.files.get({ fileId: id, fields: FIELDS, supportsAllDrives: true }, REQUEST);
    if (data.trashed || data.mimeType !== FOLDER || !data.parents?.includes(parent) || (name && data.name !== name)) throw fail('선택한 폴더가 이동·삭제되었거나 연도가 다릅니다. 저장 위치를 다시 선택해 주세요.', 409);
    return data;
  }
  async year(year, yearId) {
    if (yearId) return this.verify(yearId, this.archive.folderId, year);
    const matches = (await this.children(this.archive.folderId)).filter(f => f.name === year);
    if (matches.length > 1) throw fail('같은 연도 폴더가 여러 개입니다. 사용할 폴더를 선택해 주세요.', 409);
    return matches[0] || null;
  }
  async ensure(parent, name) {
    const matches = (await this.children(parent)).filter(f => /^\d{4}$/.test(name) ? f.name === name : normalized(f.name) === normalized(name));
    if (matches.length > 1) throw fail('같은 이름의 폴더가 여러 개입니다. 기존 폴더를 선택해 주세요.', 409);
    if (matches.length === 1) return this.verify(matches[0].id, parent);
    const key = createHash('sha256').update(parent + '\n' + name).digest('hex');
    let entry = this.journal[key];
    if (entry?.complete) throw fail('이전에 만든 폴더가 이동·삭제되었습니다. 저장 위치를 다시 선택해 주세요.', 409);
    if (!entry) {
      const { data } = await this.archive.drive.files.generateIds({ count: 1, space: 'drive', type: 'files' }, REQUEST);
      entry = this.journal[key] = { id: data.ids[0], parent, name, complete: false }; this.save();
    }
    try {
      await this.archive.drive.files.create({ supportsAllDrives: true, fields: 'id', requestBody: {
        id: entry.id, name, mimeType: FOLDER, parents: [parent], appProperties: { cameraFolderKey: key }
      } }, REQUEST);
    } catch (error) {
      if (Number(error.code || error.response?.status) !== 409) throw error;
    }
    const folder = await this.verify(entry.id, parent, name);
    entry.complete = true; this.save(); return folder;
  }
  async resolve(input) {
    const target = targetInput(input);
    const year = await this.year(target.year, target.yearId) || await this.ensure(this.archive.folderId, target.year);
    const event = target.eventId ? await this.verify(target.eventId, year.id) : await this.ensure(year.id, target.folderName);
    if (event.capabilities?.canAddChildren === false) throw fail('선택한 행사 폴더에 사진을 추가할 권한이 없습니다.', 403);
    return { ...target, yearId: year.id, eventId: event.id, eventName: event.name, folderName: event.name };
  }
  async validateRecord(record) {
    if (!record.target) return;
    const year = await this.verify(record.target.yearId, record.rootId, record.target.year);
    await this.verify(record.folderId, year.id);
  }
}
module.exports = { DriveFolders, targetInput, normalized, fail, FOLDER };
