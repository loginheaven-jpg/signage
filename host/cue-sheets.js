'use strict';
// 이름 붙인 큐시트. 장소(사이트)마다 여러 개를 두고, 적용 시간 규칙과 수동 고정으로 지금 내보낼 하나를 고른다.
//  - sync(함께 넘기기): 한 줄의 A·B 파일을 두 모니터에 동시에 보여 주고 함께 넘긴다. 예전 편성표와 같은 형식.
//  - separate(따로 재생): A·B 모니터가 각자 목록을 따로 돈다. 모니터 1대인 장소는 A 목록만 쓴다.
const crypto = require('node:crypto');

const KST = 9 * 3600000;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const TRANSITIONS = ['fade', 'cut', 'slide', 'dissolve', 'wipe', 'flip', 'zoom'];
const fail = (message, status = 400) => Object.assign(new Error(message), { status, publicMessage: message });
const minutes = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
const isVideo = mime => String(mime || '').startsWith('video/');

// 한국 시간의 요일(0=일)·분·날짜
function kst(now) {
  const d = new Date(now + KST);
  return { day: d.getUTCDay(), minute: d.getUTCHours() * 60 + d.getUTCMinutes(), date: d.toISOString().slice(0, 10) };
}

function cleanRules(input) {
  return (Array.isArray(input) ? input : []).slice(0, 30).map(rule => {
    const from = String(rule?.from || ''), to = String(rule?.to || '');
    if (rule?.kind === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rule.date || '')) || Number.isNaN(Date.parse(rule.date))) throw fail('적용 날짜를 확인해 주세요.');
      if (!from && !to) return { kind: 'date', date: rule.date, from: '', to: '' };
      if (!TIME.test(from) || !TIME.test(to) || minutes(to) <= minutes(from)) throw fail('적용 시간은 시작이 끝보다 빨라야 합니다.');
      return { kind: 'date', date: rule.date, from, to };
    }
    const days = [...new Set((Array.isArray(rule?.days) ? rule.days : []).map(Number))].filter(d => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    if (!days.length) throw fail('적용할 요일을 하나 이상 골라 주세요.');
    if (!TIME.test(from) || !TIME.test(to) || minutes(to) <= minutes(from)) throw fail('적용 시간은 시작이 끝보다 빨라야 합니다.');
    return { kind: 'week', days, from, to };
  });
}

const seconds = value => Math.min(86400, Math.max(0, parseInt(value, 10) || 0));
const day = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? value : null;
const file = value => String(value || '').replace(/[\\/\x00-\x1f]/g, '').slice(0, 300);
const transition = value => TRANSITIONS.includes(value) ? value : 'fade';

function cleanRows(input) {
  return (Array.isArray(input) ? input : []).slice(0, 500).map(row => ({
    file1: file(row?.file1), file2: file(row?.file2), file1Mime: String(row?.file1Mime || ''), file2Mime: String(row?.file2Mime || ''),
    layoutType: row?.layoutType === 'split' ? 'split' : 'independent', duration: seconds(row?.duration),
    videoDuration: row?.videoDuration === 'custom' ? 'custom' : 'original', audio: ['left', 'right'].includes(row?.audio) ? row.audio : 'none',
    transition: transition(row?.transition), validFrom: day(row?.validFrom), validTo: day(row?.validTo), enabled: row?.enabled !== false
  })).filter(row => row.file1 || row.file2);
}

function cleanItems(input) {
  return (Array.isArray(input) ? input : []).slice(0, 500).map(item => ({
    file: file(item?.file), mime: String(item?.mime || ''), duration: seconds(item?.duration), sound: !!item?.sound,
    transition: transition(item?.transition), validFrom: day(item?.validFrom), validTo: day(item?.validTo), enabled: item?.enabled !== false
  })).filter(item => item.file);
}

class CueSheets {
  // data: schedule.json 의 내용. 예전 형식(entries 만 있음)이면 장소마다 '기본' 큐시트로 옮긴다.
  constructor(data, sites) {
    this.sheets = Array.isArray(data?.sheets) ? data.sheets : null;
    this.siteState = data?.siteState && typeof data.siteState === 'object' ? data.siteState : {};
    this.migrated = false;
    this.lastStamp = 0;
    this.sent = new Map();   // siteId → { signature, version }
    if (!this.sheets) {
      this.sheets = [];
      const bySite = new Map();
      for (const entry of data?.entries || []) {
        const siteId = entry.siteId || sites[0]?.id || '';
        if (!bySite.has(siteId)) bySite.set(siteId, []);
        bySite.get(siteId).push(entry);
      }
      for (const [siteId, entries] of bySite) {
        const sheet = { id: this.newId(), siteId, name: '기본', type: 'sync', rules: [], rows: cleanRows(entries), a: [], b: [], updatedAt: this.stamp() };
        this.sheets.push(sheet); this.siteState[siteId] = { defaultId: sheet.id, pinnedId: null };
      }
      this.migrated = (data?.entries || []).length > 0;
    }
  }

  newId() { return 'sheet_' + crypto.randomBytes(6).toString('hex'); }
  stamp() { this.lastStamp = Math.max(Date.now(), this.lastStamp + 1); return this.lastStamp; }
  ofSite(siteId) { return this.sheets.filter(sheet => sheet.siteId === siteId); }
  state(siteId) { return this.siteState[siteId] || (this.siteState[siteId] = { defaultId: null, pinnedId: null }); }

  // 저장 형식. entries 는 예전 서버로 되돌려도 화면이 비지 않도록 남기는 사본(장소별 기본 큐시트가 함께 넘기기일 때).
  toJSON() {
    const entries = [];
    for (const sheet of this.sheets) if (sheet.type === 'sync' && this.state(sheet.siteId).defaultId === sheet.id) for (const row of sheet.rows) entries.push({ siteId: sheet.siteId, ...row });
    return { version: this.lastStamp, sheets: this.sheets, siteState: this.siteState, entries };
  }

  // 지금 내보낼 큐시트: 수동 고정 > 특정 날짜 > 요일 반복(목록 위쪽 우선) > 기본 > 첫 큐시트
  active(siteId, now = Date.now(), ignorePin = false) {
    const sheets = this.ofSite(siteId), state = this.state(siteId);
    if (!sheets.length) return null;
    const pinned = !ignorePin && sheets.find(sheet => sheet.id === state.pinnedId);
    if (pinned) return pinned;
    const t = kst(now);
    const within = rule => !rule.from || (t.minute >= minutes(rule.from) && t.minute < minutes(rule.to));
    for (const kind of ['date', 'week']) for (const sheet of sheets) for (const rule of sheet.rules) {
      if (rule.kind === kind && (kind === 'date' ? rule.date === t.date : rule.days.includes(t.day)) && within(rule)) return sheet;
    }
    return sheets.find(sheet => sheet.id === state.defaultId) || sheets[0];
  }

  // 자동 전환이 다음에 일어나는 시각과 그때의 큐시트. 8일 안에 없으면 null.
  next(siteId, now = Date.now()) {
    const current = this.active(siteId, now, true);
    if (!current) return null;
    const start = Math.floor(now / 60000) * 60000 + 60000;
    for (let at = start; at < start + 8 * 86400000; at += 60000) {
      const then = this.active(siteId, at, true);
      if (then !== current) return { at, sheetId: then.id, name: then.name };
    }
    return null;
  }

  create(siteId, input) {
    const type = input?.type === 'separate' ? 'separate' : 'sync';
    const sheet = { id: this.newId(), siteId, name: this.nameOf(input?.name), type, rules: cleanRules(input?.rules),
      rows: type === 'sync' ? cleanRows(input?.rows) : [], a: type === 'separate' ? cleanItems(input?.a) : [], b: type === 'separate' ? cleanItems(input?.b) : [], updatedAt: this.stamp() };
    this.sheets.push(sheet);
    if (!this.state(siteId).defaultId) this.state(siteId).defaultId = sheet.id;
    return sheet;
  }

  update(id, input) {
    const sheet = this.sheets.find(s => s.id === id);
    if (!sheet) throw fail('큐시트를 찾을 수 없습니다. 화면을 새로 고쳐 주세요.', 404);
    const rules = cleanRules(input?.rules);   // 검증에 실패하면 아무것도 바꾸지 않는다
    if (input?.name !== undefined) sheet.name = this.nameOf(input.name);
    sheet.rules = rules;
    if (sheet.type === 'sync') sheet.rows = cleanRows(input?.rows);
    else { sheet.a = cleanItems(input?.a); sheet.b = cleanItems(input?.b); }
    sheet.updatedAt = this.stamp();
    return sheet;
  }

  remove(id) {
    const sheet = this.sheets.find(s => s.id === id);
    if (!sheet) throw fail('큐시트를 찾을 수 없습니다.', 404);
    const state = this.state(sheet.siteId);
    if (state.defaultId === id && this.ofSite(sheet.siteId).length > 1) throw fail('기본 큐시트는 지울 수 없습니다. 다른 큐시트를 기본으로 지정한 뒤 지워 주세요.');
    this.sheets = this.sheets.filter(s => s.id !== id);
    if (state.pinnedId === id) state.pinnedId = null;
    if (state.defaultId === id) state.defaultId = null;
    this.stamp();
  }

  setState(siteId, input) {
    const state = this.state(siteId), has = id => this.ofSite(siteId).some(sheet => sheet.id === id);
    if (input?.defaultId !== undefined) { if (!has(input.defaultId)) throw fail('큐시트를 찾을 수 없습니다.', 404); state.defaultId = input.defaultId; }
    if (input?.pinnedId !== undefined) { if (input.pinnedId !== null && !has(input.pinnedId)) throw fail('큐시트를 찾을 수 없습니다.', 404); state.pinnedId = input.pinnedId; }
    this.stamp();
    return state;
  }

  removeSite(siteId) { this.sheets = this.sheets.filter(sheet => sheet.siteId !== siteId); delete this.siteState[siteId]; this.sent.delete(siteId); this.stamp(); }

  nameOf(value) {
    const name = String(value || '').normalize('NFC').replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name) throw fail('큐시트 이름을 입력해 주세요.');
    return name;
  }

  // 플레이어에 보내는 형식. 내용이 바뀔 때만 version 이 바뀌므로, 재접속해 같은 큐시트를 다시 받은 플레이어는 처음부터 다시 틀지 않는다.
  payload(siteId, mediaMime, now = Date.now()) {
    const sheet = this.active(siteId, now), today = kst(now).date;
    const live = item => item.enabled !== false && !(item.validFrom && item.validFrom > today) && !(item.validTo && item.validTo < today);
    const body = { mode: sheet?.type === 'separate' ? 'separate' : 'sync', sheetId: sheet?.id || '', name: sheet?.name || '', entries: [], entriesB: [] };
    if (sheet?.type === 'separate') {
      const entry = item => {
        const mimeType = mediaMime(item.file, item.mime);
        // 영상 시간 0 = 영상 길이만큼 한 번. 사진은 0이면 10초.
        const duration = isVideo(mimeType) ? item.duration : item.duration || 10;
        return { filename: item.file, url: '/uploads/' + item.file, mimeType, filename2: '', url2: '', mimeType2: 'image/jpeg', duration,
          videoDuration: duration ? 'custom' : 'original', sound: item.sound && isVideo(mimeType) ? 'left' : 'none', transition: item.transition, layoutType: 'independent', active: true };
      };
      body.entries = sheet.a.filter(live).map(entry); body.entriesB = sheet.b.filter(live).map(entry);
    } else if (sheet) {
      for (const row of sheet.rows.filter(live)) {
        const primary = row.file1 || row.file2, primaryMime = mediaMime(primary, row.file1 ? row.file1Mime : row.file2Mime);
        const secondary = row.file1 && row.file2 ? row.file2 : '', secondaryMime = mediaMime(secondary, row.file2Mime);
        // 시간 0 = 그 줄의 영상이 끝날 때까지. A가 영상이면 예전 '원본'도 0으로 읽고, B만 영상이면 0을 직접 넣은 줄만 기다린다.
        let duration = row.duration;
        if (isVideo(primaryMime)) { if (row.videoDuration !== 'custom') duration = 0; }
        else if (!duration && !(secondary && isVideo(secondaryMime))) duration = 10;
        body.entries.push({ filename: primary, url: '/uploads/' + primary, mimeType: primaryMime, filename2: secondary, url2: secondary ? '/uploads/' + secondary : '', mimeType2: secondaryMime,
          duration, videoDuration: duration ? 'custom' : 'original', sound: row.audio, transition: row.transition, layoutType: row.layoutType, active: true });
      }
    }
    const signature = JSON.stringify(body), sent = this.sent.get(siteId);
    if (!sent || sent.signature !== signature) this.sent.set(siteId, { signature, version: this.stamp() });
    return { version: this.sent.get(siteId).version, ...body };
  }
}

module.exports = { CueSheets, cleanRules, kst };
