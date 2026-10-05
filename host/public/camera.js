'use strict';
const el = id => document.getElementById(id);
const labels = { archive: '구글드라이브에 보관', live: '실시간 모니터에 표출', both: '보관하고 모니터에 표출' };
const archiveLabels = { saved: 'Drive 보관 완료', pending: '서버 접수 완료 · Drive 보관 대기', error: '서버 접수 완료 · Drive 재시도 대기', deleting: '삭제 처리 중', deleted: '삭제 완료', missing: 'Drive에서 사진을 찾을 수 없음' };
const kst = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' });
let config, settings, mode = 'archive', selected = [], events = [], foldersReady = false, busy = false, folderSequence = 0;
let draftDb;
let cameraStream;
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const storage = {
  get(key) { try { return JSON.parse(localStorage.getItem('camera.' + key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem('camera.' + key, JSON.stringify(value)); } catch {} }
};
function notice(text, error = false) { el('notice').textContent = text; el('notice').classList.toggle('error', error); el('notice').hidden = !text; }
function node(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
function option(value, text) { const n = node('option', text); n.value = value; return n; }
function view(name) { for (const id of ['resume', 'purpose', 'setup', 'work']) el(id).hidden = id !== name; }
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, '0')).join(''); }
async function api(route, options = {}) {
  const params = new URLSearchParams(location.search);
  const legacyToken = params.get('t') || storage.get('token');
  if (params.get('t')) storage.set('token', params.get('t'));
  const res = await fetch('/live/api/camera/' + route, { cache: 'no-store', ...options, headers: { ...(legacyToken ? { 'x-live-token': legacyToken } : {}), ...options.headers } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { location.replace('/login?role=camera'); throw new Error('다시 로그인해 주세요.'); }
  if (!res.ok) throw new Error(data.error || '연결을 확인하고 다시 시도해 주세요.');
  return data;
}
function destination(s) {
  const lines = [labels[s.mode], '업로더: ' + s.uploaderName];
  if (s.target) lines.push('보관: ' + s.target.year + ' / ' + (s.target.folderName || s.target.eventName));
  if (s.mode !== 'archive') lines.push('표출: ' + s.siteName);
  return lines.join('\n');
}
async function openDb() {
  if (draftDb) return draftDb;
  draftDb = await new Promise((resolve, reject) => {
    const request = indexedDB.open('yebom-camera-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  return draftDb;
}
async function persistDraft() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite');
      tx.objectStore('drafts').put({ settings, entries: selected.map(({ url, ...r }) => r), message: el('message').value, keepMessage: el('keepMessage').checked }, 'current');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } catch { notice('이 기기에 사진 대기 목록을 저장하지 못했습니다. 전송을 마칠 때까지 화면을 닫지 마세요.', true); }
}
async function readDraft() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').get('current');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  } catch { return null; }
}
function hasFrozen() { return selected.some(r => r.submission); }
function canEdit() {
  if (busy) return false;
  if (hasFrozen()) { notice('응답을 확인하지 못한 사진이 있습니다. 같은 설정으로 재시도하거나 대기 목록에서 제외한 뒤 설정을 변경해 주세요.', true); return false; }
  return true;
}
async function loadFolders(yearId = '', restoreEvent = '') {
  const seq = ++folderSequence; foldersReady = false; el('useSettings').disabled = true;
  el('folderState').textContent = '폴더 목록을 확인하고 있습니다…'; el('event').disabled = true;
  try {
    const data = await api('folders?' + new URLSearchParams({ year: el('year').value, ...(yearId ? { yearId } : {}) }));
    if (seq !== folderSequence) return;
    el('yearOptions').replaceChildren(...[...new Set(data.years.map(y => y.name))].map(y => option(y, y)));
    const matches = data.years.filter(y => y.name === el('year').value);
    el('yearFolderLabel').hidden = matches.length < 2;
    el('yearFolder').replaceChildren(...(data.ambiguous ? [option('', '사용할 연도 폴더를 선택해 주세요')] : []), ...matches.map(y => option(y.id, y.name + ' · 폴더 ' + y.id.slice(-8))));
    el('yearFolder').value = data.yearId;
    el('yearFolder').dataset.selected = data.yearId;
    events = data.events; renderEvents(restoreEvent);
    el('folderState').textContent = data.ambiguous ? '같은 연도 폴더가 여러 개입니다. 위에서 사용할 폴더를 선택해 주세요.' : data.exists ? '기존 연도 폴더의 행사 목록입니다.' : el('year').value + ' 연도 폴더는 첫 사진을 저장할 때 생성합니다.';
    foldersReady = !data.ambiguous; el('event').disabled = data.ambiguous; el('useSettings').disabled = data.ambiguous;
  } catch (e) {
    if (seq !== folderSequence) return;
    events = []; el('event').replaceChildren(option('', '목록을 다시 확인해 주세요')); el('newEvent').hidden = true;
    el('folderState').textContent = e.message + ' 목록을 확인하기 전에는 새 폴더를 만들지 않습니다.';
  }
}
function renderEvents(restore = el('event').value) {
  const search = el('eventSearch').value.trim().normalize('NFC');
  const filtered = events.filter(e => e.name.normalize('NFC').includes(search) || e.id === restore);
  const duplicates = name => events.filter(e => e.name === name).length > 1;
  el('event').replaceChildren(option('', '행사를 선택해 주세요'), ...filtered.map(e => {
    const n = option(e.id, e.name + (duplicates(e.name) ? ' · ' + e.id.slice(-8) : '') + (!e.writable ? ' (추가 권한 없음)' : '')); n.disabled = !e.writable; return n;
  }), option('__new__', '＋ 새 행사 만들기'));
  el('event').value = restore === '__new__' || filtered.some(e => e.id === restore) ? restore : '';
  el('newEvent').hidden = el('event').value !== '__new__'; updateNewPath();
}
function updateNewPath() {
  const name = el('eventName').value.normalize('NFC').replace(/\s+/g, ' ').trim();
  const date = el('eventDate').value;
  const folderName = date ? date.replace(/-/g, '') + ' ' + name : name;
  const exact = events.find(e => e.name.normalize('NFC').replace(/\s+/g, ' ').trim() === folderName);
  el('newPath').textContent = '#교회사진영상 / ' + el('year').value + ' / ' + (folderName || '행사명') + (exact ? ' · 같은 이름의 기존 폴더를 사용합니다.' : ' · 첫 사진을 저장할 때 생성합니다.');
}
async function openSetup(nextMode) {
  mode = nextMode; view('setup'); el('setupTitle').textContent = labels[mode];
  el('archiveSetup').hidden = mode === 'live'; el('archiveSetup').disabled = mode === 'live';
  el('liveSetup').hidden = mode === 'archive'; el('liveSetup').disabled = mode === 'archive';
  const s = settings || storage.get('settings') || {};
  el('uploader').value = s.uploaderName || storage.get('name') || '';
  el('year').value = s.target?.year || config.year;
  el('eventName').value = s.target?.eventId ? '' : s.target?.eventName || '';
  el('eventDate').value = s.target?.eventId ? '' : s.target?.eventDate || '';
  el('eventSearch').value = '';
  el('site').replaceChildren(option('', '모니터를 선택해 주세요'), ...config.sites.map(s => option(s.id, s.name + (s.online ? ' · 연결됨' : ' · 연결 대기'))));
  el('site').value = s.siteId || '';
  if (mode !== 'live') await loadFolders(s.target?.yearId || '', s.target?.eventId || (s.target?.eventName ? '__new__' : ''));
  else { ++folderSequence; el('useSettings').disabled = false; }
}
function applySettings(event) {
  event.preventDefault();
  const uploaderName = el('uploader').value.normalize('NFC').trim();
  if (!uploaderName || [...uploaderName].length > 20) return notice('업로더 이름을 1~20자로 입력해 주세요.', true);
  let target = null;
  if (mode !== 'live') {
    if (!foldersReady) return notice('폴더 목록을 먼저 확인해 주세요.', true);
    const selectedEvent = events.find(e => e.id === el('event').value);
    if (selectedEvent) target = { year: el('year').value, yearId: el('yearFolder').dataset.selected, eventId: selectedEvent.id, eventName: selectedEvent.name, folderName: selectedEvent.name };
    else if (el('event').value === '__new__') {
      const eventName = el('eventName').value.normalize('NFC').replace(/\s+/g, ' ').trim();
      const eventDate = el('eventDate').value;
      if (!eventName || [...eventName].length > 80 || /[\\/\x00-\x1f\x7f]/.test(eventName) || ['.', '..'].includes(eventName)) return notice('행사명을 1~80자로 입력해 주세요. /와 \\는 사용할 수 없습니다.', true);
      if (eventDate && !eventDate.startsWith(el('year').value + '-')) return notice('행사 시작일과 저장 연도가 다릅니다. 연도 또는 날짜를 변경해 주세요.', true);
      target = { year: el('year').value, yearId: el('yearFolder').dataset.selected, eventName, eventDate, folderName: eventDate ? eventDate.replace(/-/g, '') + ' ' + eventName : eventName };
    } else return notice('행사를 선택하거나 새 행사명을 입력해 주세요.', true);
  }
  const site = config.sites.find(s => s.id === el('site').value);
  if (mode !== 'archive' && !site) return notice('표출할 모니터를 선택해 주세요.', true);
  settings = { mode, uploaderName, target, siteId: site?.id || '', siteName: site?.name || '' };
  storage.set('settings', settings); storage.set('name', uploaderName); persistDraft(); notice(''); showWork();
}
function showWork() {
  mode = settings.mode; view('work'); el('workTitle').textContent = labels[mode];
  const values = [['업로더', settings.uploaderName]];
  if (settings.target) values.push(['보관 위치', settings.target.year + ' / ' + (settings.target.folderName || settings.target.eventName)]);
  if (mode !== 'archive') values.push(['표출 모니터', settings.siteName]);
  el('workSummary').replaceChildren(...values.flatMap(([key, value]) => [node('dt', key), node('dd', value)]));
  updateWorkWarning(); renderReview(); loadHistory();
}
function updateWorkWarning() {
  if (!settings) return;
  const warnings = [];
  if (mode !== 'live' && !config.archiveEnabled) warnings.push('사진 보관 접수가 닫혀 있습니다.');
  if (mode !== 'live' && !config.ready) warnings.push('Drive 연결 확인이 필요합니다. 접수한 원본은 서버에서 보관하며 연결 후 전송합니다.');
  if (mode !== 'archive' && !config.liveEnabled) warnings.push('모니터 표출 접수가 닫혀 있습니다.');
  if (mode === 'live') warnings.push('모니터 전용 사진은 장기 보관하지 않습니다.');
  el('workWarning').textContent = warnings.join(' ');
}
function localDate(ts) { return new Date(ts + 9 * 3600000).toISOString().slice(0, 19); }
async function addFiles(files, captured = false) {
  storage.set('capturePending', false);
  const slots = 30 - selected.length;
  if (files.length > slots) notice('한 번에 30장까지 가능합니다. 초과 사진은 추가하지 않았습니다.', true);
  for (const file of [...files].slice(0, slots)) {
    if (file.size > config.maxBytes) { notice(file.name + ': 한 장당 50MB까지 가능합니다.', true); continue; }
    if (selected.some(r => r.file.name === file.name && r.file.size === file.size && r.file.lastModified === file.lastModified)) continue;
    let date = '', dateSource = 'unknown';
    try {
      const tags = await window.exifr?.parse(file, { pick: ['DateTimeOriginal', 'CreateDate'], reviveValues: false });
      const raw = String(tags?.DateTimeOriginal || tags?.CreateDate || '').replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw)) { date = raw; dateSource = 'exif'; }
    } catch {}
    if (!date && file.lastModified) { date = localDate(file.lastModified); dateSource = captured ? 'capture' : 'fileModified'; }
    selected.push({ file, requestId: uuid(), date, dateSource, url: URL.createObjectURL(file), error: '' });
  }
  await persistDraft(); renderReview();
  if (selected.length) el('review').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderReview() {
  el('review').hidden = !selected.length;
  el('reviewTitle').textContent = '사진 ' + selected.length + '장';
  el('reviewDestination').textContent = settings ? destination(settings).replace(/\n/g, ' · ') : '';
  el('messageLabel').hidden = mode === 'archive'; el('keepMessageLabel').hidden = mode === 'archive';
  el('emailLabel').hidden = !config?.mail;
  el('selectedPhotos').replaceChildren(...selected.map(r => {
    const card = node('div', undefined, 'photoCard'); const img = node('img'); img.src = r.url; img.alt = r.file.name;
    const caption = node('p', r.file.name); const state = node('p', r.error || '원본 ' + (r.file.size / 1024 / 1024).toFixed(1) + 'MB');
    img.onerror = () => { img.hidden = true; caption.textContent = r.file.name + ' · 미리보기 불가, 원본 보관 가능'; };
    const label = node('label', '사진 날짜 (한국 시간)'); const input = node('input'); input.type = 'datetime-local'; input.step = '1'; input.value = r.date; input.disabled = !!r.submission || busy;
    input.onchange = () => { r.date = input.value; r.dateSource = 'user'; persistDraft(); }; label.append(input);
    const dateInfo = node('p', ({ exif: '사진 촬영정보', capture: '방금 촬영한 날짜', fileModified: '파일 수정일시 — 필요하면 수정하세요', user: '직접 지정', unknown: '날짜미상' })[r.dateSource]);
    const remove = node('button', '제외'); remove.disabled = busy;
    remove.onclick = () => { if (r.submission && !confirm('서버에 접수되었을 수 있는 사진입니다. 대기 목록에서 제외해도 이미 접수된 사진은 취소되지 않습니다. 제외할까요?')) return; URL.revokeObjectURL(r.url); selected = selected.filter(x => x !== r); persistDraft(); renderReview(); };
    card.append(img, caption, state, label, dateInfo, remove); return card;
  }));
  el('send').textContent = mode === 'archive' ? '사진 ' + selected.length + '장 Drive에 저장' : mode === 'live' ? '사진 ' + selected.length + '장 모니터에 표출' : '사진 ' + selected.length + '장 저장하고 표출';
}
function setBusy(value) {
  busy = value;
  for (const id of ['shoot', 'choose', 'changePurpose', 'changeSettings', 'send', 'discard', 'message', 'keepMessage', 'email']) el(id).disabled = value;
  if (hasFrozen()) for (const id of ['message', 'keepMessage', 'email']) el(id).disabled = true;
  renderReview();
}
async function sendPhotos() {
  if (busy || !selected.length) return;
  if (el('email').value && !el('email').reportValidity()) return;
  setBusy(true); let accepted = 0; const originalCount = selected.length;
  try {
    for (const r of [...selected]) {
      if (!r.submission) r.submission = { ...structuredClone(settings), message: mode === 'archive' ? '' : el('message').value.trim(), email: el('email').value.trim(), batchTotal: originalCount, date: r.date, dateSource: r.dateSource };
      await persistDraft();
      el('progress').textContent = (accepted + 1) + ' / ' + originalCount + ' · ' + r.file.name + ' 접수하는 중…';
      const s = r.submission, form = new FormData();
      for (const [key, value] of Object.entries({ mode: s.mode, target: JSON.stringify(s.target || {}), uploaderName: s.uploaderName,
        requestId: r.requestId, siteId: s.siteId, message: s.message, email: s.email, batchTotal: s.batchTotal,
        capturedAt: s.date, dateSource: s.dateSource, lastModified: r.file.lastModified || '' })) form.append(key, String(value ?? ''));
      form.append('photo', r.file, r.file.name);
      try {
        const result = await api('photo', { method: 'POST', body: form });
        accepted++; URL.revokeObjectURL(r.url); selected = selected.filter(x => x !== r);
        if (result.upload?.target?.eventId && settings.target && s.target?.year === settings.target.year && (s.target.eventId === settings.target.eventId || (!settings.target.eventId && s.target.folderName === settings.target.folderName))) {
          settings.target = result.upload.target; storage.set('settings', settings);
        }
      } catch (e) { r.error = e.message; }
      await persistDraft();
    }
    el('progress').textContent = accepted + '장 서버 접수 완료' + (selected.length ? ' · ' + selected.length + '장 응답 확인 필요. 같은 설정으로 재시도해 주세요.' : ' · 같은 작업으로 계속 촬영하거나 사진을 선택하세요.');
    if (selected.length) notice('전송하지 못했거나 응답을 확인하지 못한 사진을 대기 목록에 남겼습니다. 재시도해도 중복 접수하지 않습니다.', true);
    else notice(accepted + '장 접수했습니다. 내 업로드에서 Drive 보관과 모니터 표시 결과를 확인하세요.');
    el('email').value = ''; if (!el('keepMessage').checked) el('message').value = '';
  } finally {
    if (!selected.length) { el('shootInput').value = ''; el('galleryInput').value = ''; }
    setBusy(false); await persistDraft(); await loadHistory();
  }
}
async function loadHistory() {
  try {
    const data = await api('uploads');
    if (data.state) { Object.assign(config, data.state); updateWorkWarning(); }
    el('history').replaceChildren(...data.uploads.map(r => {
      const wrap = node('div', undefined, 'historyRow'); wrap.append(node('strong', r.name), node('p', kst.format(new Date(r.ts)) + (r.target ? ' · ' + r.target.year + ' / ' + (r.target.folderName || r.target.eventName) : '')));
      const states = [];
      if (r.cancelled) states.push('취소 요청 완료');
      if (r.archive !== 'none') states.push(archiveLabels[r.archive] || r.archive);
      if (r.archiveError) states.push(r.archiveError);
      if (r.live !== 'none' && !r.cancelled) {
        const displayed = r.delivery.filter(d => d.status === 'displayed').length;
        states.push(displayed ? '모니터 표시 확인 ' + displayed + '곳' : r.live === 'sent' ? '모니터 전달 요청 완료 · 표시 확인 대기' : r.live === 'pending' ? '모니터 처리 결과 미확인' : '모니터 표출 실패');
        if (r.delivery.some(d => d.status === 'image_error' || d.status === 'stopped')) states.push('일부 모니터에서 표시 오류');
        if (r.liveError) states.push(r.liveError);
      }
      if (r.mail) states.push('이메일: ' + ({ queued: '발송 대기', sent: '발송 완료', error: '발송 실패', sending: '발송 중', cancelled: '취소됨' })[r.mail]);
      wrap.append(node('p', states.join(' · ')));
      const actions = node('div', undefined, 'actions');
      if (!r.cancelled && ['pending', 'error'].includes(r.archive)) {
        const retry = node('button', 'Drive 전송 재시도'); retry.onclick = async () => { retry.disabled = true; try { await api('uploads/' + r.id + '/retry', { method: 'POST' }); await loadHistory(); } catch (e) { notice(e.message, true); retry.disabled = false; } }; actions.append(retry);
      }
      if (r.canRetryDisplay) {
        const retry = node('button', '모니터 표출 재시도'); retry.onclick = async () => {
          retry.disabled = true; try { await api('uploads/' + r.id + '/display', { method: 'POST' }); await loadHistory(); } catch (e) { notice(e.message, true); retry.disabled = false; }
        }; actions.append(retry);
      }
      if (r.canChangeTarget && settings?.target) {
        const change = node('button', '현재 행사로 저장 위치 변경'); change.onclick = async () => {
          if (!confirm('이 사진을 현재 선택한 ' + settings.target.year + ' / ' + (settings.target.folderName || settings.target.eventName) + ' 행사에 저장할까요?')) return;
          change.disabled = true;
          try { await api('uploads/' + r.id + '/target', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings.target) }); await loadHistory(); }
          catch (e) { notice(e.message, true); change.disabled = false; }
        }; actions.append(change);
      }
      if (r.canCancel) {
        const cancel = node('button', '업로드 취소'); cancel.onclick = async () => {
          if (!confirm('이 사진의 보관과 모니터 표출을 취소할까요? 저장된 Drive 사진은 휴지통으로 이동합니다.')) return;
          cancel.disabled = true; try { await api('uploads/' + r.id, { method: 'DELETE' }); await loadHistory(); } catch (e) { notice(e.message, true); cancel.disabled = false; }
        }; actions.append(cancel);
      }
      wrap.append(actions); return wrap;
    }));
    if (!data.uploads.length) el('history').append(node('p', '아직 이 브라우저에서 접수한 사진이 없습니다.', 'hint'));
    // Follow the actual folder IDs once the first upload has created the hierarchy.
    const resolved = data.uploads.find(r => !r.cancelled && r.target?.eventId && settings?.target && r.target.year === settings.target.year && r.target.folderName === settings.target.folderName);
    if (resolved && !settings.target.eventId) { settings.target = resolved.target; storage.set('settings', settings); persistDraft(); }
  } catch (e) { el('history').textContent = e.message; }
}
document.querySelectorAll('[data-mode]').forEach(button => button.onclick = () => openSetup(button.dataset.mode));
el('setupForm').onsubmit = applySettings;
el('backPurpose').onclick = () => view('purpose');
el('changePurpose').onclick = () => { if (canEdit()) view('purpose'); };
el('changeSettings').onclick = () => { if (canEdit()) openSetup(settings.mode); };
el('year').onchange = () => { el('eventSearch').value = ''; el('eventName').value = ''; el('eventDate').value = ''; loadFolders(); };
el('yearFolder').onchange = () => loadFolders(el('yearFolder').value);
el('reloadFolders').onclick = () => loadFolders(el('yearFolder').dataset.selected || '', el('event').value);
el('eventSearch').oninput = () => renderEvents();
el('event').onchange = () => { el('newEvent').hidden = el('event').value !== '__new__'; updateNewPath(); };
el('eventName').oninput = updateNewPath; el('eventDate').onchange = updateNewPath;
el('continueResume').onclick = () => { if (settings) showWork(); };
el('startNew').onclick = () => { if (canEdit()) view('purpose'); };
for (const [button, input] of [['shoot', 'shootInput'], ['choose', 'galleryInput']]) {
  el(button).onclick = async () => {
    if (busy) return;
    if (button === 'shoot' && !isMobile) {
      if (!navigator.mediaDevices?.getUserMedia) return notice('이 브라우저에서는 카메라를 사용할 수 없습니다. 사진 파일을 선택해 주세요.', true);
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
        el('cameraVideo').srcObject = cameraStream; el('cameraDialog').showModal();
      } catch { notice('카메라 연결과 브라우저의 카메라 허용 여부를 확인해 주세요. 사진 파일 선택도 사용할 수 있습니다.', true); }
      return;
    }
    storage.set('capturePending', true); el(input).value = ''; el(input).click();
  };
  el(input).onchange = () => addFiles(el(input).files);
  el(input).addEventListener('cancel', () => storage.set('capturePending', false));
}
el('closeCamera').onclick = () => el('cameraDialog').close();
el('cameraDialog').addEventListener('close', () => { cameraStream?.getTracks().forEach(track => track.stop()); cameraStream = null; el('cameraVideo').srcObject = null; });
el('snap').onclick = async () => {
  const video = el('cameraVideo');
  if (!video.videoWidth) return notice('카메라가 준비되면 다시 촬영해 주세요.', true);
  el('snap').disabled = true;
  try {
    const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    if (!blob) throw new Error('capture');
    const file = new File([blob], '촬영_' + Date.now() + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
    el('cameraDialog').close(); await addFiles([file], true);
  } catch { notice('사진을 만들지 못했습니다. 다시 촬영해 주세요.', true); }
  finally { el('snap').disabled = false; }
};
window.addEventListener('pagehide', () => { cameraStream?.getTracks().forEach(track => track.stop()); });
el('send').onclick = sendPhotos;
el('discard').onclick = () => {
  if (busy) return;
  if (hasFrozen() && !confirm('이미 접수된 사진이 있을 수 있습니다. 대기 목록만 비울까요? 실제 사진 취소는 내 업로드에서 할 수 있습니다.')) return;
  selected.forEach(r => URL.revokeObjectURL(r.url)); selected = []; persistDraft(); renderReview();
};
el('refreshHistory').onclick = loadHistory;
el('message').oninput = () => persistDraft(); el('keepMessage').onchange = () => persistDraft();
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('online', () => { notice('인터넷에 다시 연결되었습니다. 대기 사진을 확인하고 전송해 주세요.'); loadHistory(); });
window.addEventListener('offline', () => notice('인터넷 연결이 끊겼습니다. 선택한 사진은 대기 목록에 유지합니다.', true));
async function init() {
  try {
    config = await api('config');
    const draft = await readDraft();
    settings = draft?.entries?.length ? draft.settings : storage.get('settings');
    if (settings && (!labels[settings.mode] || !settings.uploaderName || (settings.mode !== 'live' && !settings.target))) settings = null;
    if (draft?.entries?.length && settings) {
      selected = draft.entries.map(r => ({ ...r, url: URL.createObjectURL(r.file) }));
      el('message').value = draft.message || ''; el('keepMessage').checked = !!draft.keepMessage;
      notice('전송 대기 사진 ' + selected.length + '장을 복원했습니다. 같은 작업으로 계속해 주세요.');
    } else if (storage.get('capturePending')) { notice('촬영·사진 선택 중 화면이 다시 열렸습니다. 사진이 전달되지 않았다면 앨범에서 다시 선택해 주세요.', true); storage.set('capturePending', false); }
    if (settings) { el('resumeSummary').textContent = destination(settings); view('resume'); }
    else view('purpose');
    if (!isMobile) el('choose').textContent = '🖼 사진 파일 선택';
    if (!isMobile && !navigator.mediaDevices?.getUserMedia) { el('shoot').disabled = true; el('shoot').title = '카메라를 사용할 수 있는 기기에서 촬영해 주세요.'; }
  } catch (e) { notice(e.message, true); }
}
init();
setInterval(() => { if (!document.hidden && !el('work').hidden && !busy) loadHistory(); }, 5000);
