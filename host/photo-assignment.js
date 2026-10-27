'use strict';
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { fileIntegrity } = require('./photo-integrity');
const { fail, FOLDER } = require('./drive-folders');
const REQUEST = { timeout: 30000, retry: false };
function assignmentInput(body) {
  const { ids, folderId } = body || {};
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) || new Set(ids).size !== ids.length) throw fail('사진을 중복 없이 1~500개 선택해 주세요.');
  if (typeof folderId !== 'string' || !/^[\w-]{1,128}$/.test(folderId)) throw fail('기존 행사 폴더를 선택해 주세요.');
  return { ids, folderId };
}
async function assignmentTarget(archive, folderId) {
  await archive.initialize();
  if (!archive.ready) throw fail('Google 연결과 행사 폴더 권한을 확인해 주세요.', 503);
  const { data: event } = await archive.drive.files.get({ fileId: folderId, supportsAllDrives: true, fields: 'id,name,mimeType,parents,trashed,capabilities(canAddChildren)' }, REQUEST);
  if (event.trashed || event.mimeType !== FOLDER || event.parents?.length !== 1) throw fail('교회사진의 연도 아래에 있는 행사 폴더를 선택해 주세요.', 409);
  const year = await archive.folders.verify(event.parents[0], archive.folderId);
  if (!/^(19|20|21)\d{2}$/.test(year.name)) throw fail('교회사진의 연도 아래에 있는 행사 폴더를 선택해 주세요.', 409);
  return archive.folders.resolve({ year: year.name, yearId: year.id, eventId: event.id });
}
async function checkOriginal(archive, record) {
  const file = archive.localPath(record);
  if (!file) throw fail('서버 원본 파일이 없습니다. 원래 기기나 백업을 확인해 주세요.', 409);
  const integrity = await fileIntegrity(file);
  if (!integrity.size || (record.originalHash && integrity.sha256 !== record.originalHash)) throw fail('서버 원본의 크기·체크섬을 확인하지 못했습니다. 원본을 보존하고 백업을 확인해 주세요.', 409);
  if (record.mimeType?.startsWith('image/')) {
    try { await sharp(file, { limitInputPixels: 80000000 }).stats(); }
    catch { throw fail('사진 원본을 끝까지 읽지 못했습니다. 원본을 보존하고 백업을 확인해 주세요.', 409); }
  }
  return { file, integrity };
}
async function assignPhotos(archive, body, preview = false) {
  const { ids, folderId } = assignmentInput(body);
  return archive.serialize(async () => {
    const target = await assignmentTarget(archive, folderId), results = [];
    for (const id of ids) {
      try {
        const record = archive.records.get(id);
        // A lost HTTP response must not duplicate or retarget an already accepted assignment.
        if (record?.assignment?.folderId === folderId && record.target?.eventId === folderId && ['pending', 'error', 'saved'].includes(record.status)) {
          results.push({ id, status: 'already_assigned' }); continue;
        }
        if (!record || record.status !== 'awaiting_target' || record.target || record.driveId) throw fail('위치 미지정 상태의 원본만 배정할 수 있습니다.', 409);
        const { file, integrity } = await checkOriginal(archive, record);
        if (preview) { results.push({ id, status: 'eligible', size: integrity.size, sha256: integrity.sha256 }); continue; }
        // Preserve both the original and its pre-assignment journal. These copies
        // stay on the volume; they do not replace an independently stored backup.
        const backup = path.join(archive.root, 'assignment-backups', id);
        fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
        const copy = path.join(backup, record.localName);
        if (!fs.existsSync(copy)) {
          const temporary = copy + '.tmp';
          try {
            fs.copyFileSync(file, temporary);
            if ((await fileIntegrity(temporary)).sha256 !== integrity.sha256) throw fail('복구용 원본 사본을 확인하지 못했습니다.', 409);
            fs.renameSync(temporary, copy);
          } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        }
        if ((await fileIntegrity(copy)).sha256 !== integrity.sha256) throw fail('복구용 원본 사본을 확인하지 못했습니다. 배정을 중단했습니다.', 409);
        const entry = path.join(backup, 'before.json');
        if (!fs.existsSync(entry)) fs.writeFileSync(entry, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
        if (archive.records.get(id) !== record || record.status !== 'awaiting_target' || record.target || record.driveId) throw fail('사진 상태가 바뀌었습니다. 목록을 새로 확인해 주세요.', 409);
        const assigned = { ...record, target, targetResolved: true, targetSource: 'administrator', folderId,
          rootId: archive.folderId, status: 'pending', error: '', nextAttempt: 0,
          originalHash: integrity.sha256, assignment: { folderId, assignedAt: Date.now(), sha256: integrity.sha256, size: integrity.size } };
        archive.save(assigned);
        results.push({ id, status: 'assigned' });
      } catch (error) {
        results.push({ id, status: 'failed', error: error.publicMessage || '원본 확인 또는 배정 기록 저장에 실패했습니다. 원본은 삭제하지 않았습니다.' });
      }
    }
    return { target, results };
  });
}
module.exports = { assignPhotos, assignmentInput };
