'use strict';
const el = id => document.getElementById(id);
const labels = { archive: '교회폴더에 저장', live: '보관없이 표출', both: '보관하고 표출' };
const archiveLabels = { saved: 'Drive 보관 완료', awaiting_original: '원본 전송 필요', awaiting_target: '원본 접수 완료 · 저장 위치 지정 필요', pending: '원본 접수 완료 · Drive 보관 대기', error: '원본 접수 완료 · Drive 재시도 대기', deleting: '삭제 처리 중', deleted: '삭제 완료', missing: 'Drive에서 사진을 찾을 수 없음' };
const kst = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' });
let config, settings, mode = 'both', selected = [], events = [], foldersReady = false, busy = false, folderSequence = 0;
let currentPage = 'purpose', navigation = { camera: true, page: 'purpose', depth: 0 }, siteSequence = 0, sitesReady = false;
let draftDb;
let cameraStream;
let shareBatch = null, shareUrls = [], sharing = false;
let uploadStates = new Map(), batchCancelling = false;
const folderRequests = new Map();
let originals = [], originalRunning = false, originalController, assigningLocation = false;
const MAIL_KEEP_MS = 10 * 60 * 1000;
const mailLabels = { queued: '발송 대기', sent: '발송 완료', failed: '발송 실패', error: '발송 예약 실패', sending: '발송 중', cancelled: '취소됨', limit: '오늘의 발송 한도 초과', off: '메일 발송 설정 필요' };
const MAIL_TYPOS = { 'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmaill.com': 'gmail.com', 'naver.co': 'naver.com', 'naver.con': 'naver.com', 'naver.cm': 'naver.com', 'nave.com': 'naver.com', 'naver.coom': 'naver.com', 'hanmail.ne': 'hanmail.net', 'hanmail.con': 'hanmail.net', 'daum.ne': 'daum.net', 'daum.nte': 'daum.net', 'nate.con': 'nate.com', 'kakao.con': 'kakao.com' };
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const storage = {
  get(key) { try { return JSON.parse(localStorage.getItem('camera.' + key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem('camera.' + key, JSON.stringify(value)); } catch {} }
};
function migrateLegacyState() {
  if (storage.get('legacyMigrated')) return;
  try {
    for (const [oldKey, newKey] of [['live.token', 'token'], ['live.uploaderName', 'name'], ['live.siteId', 'lastSite']]) {
      const value = localStorage.getItem(oldKey);
      if (value && !storage.get(newKey)) storage.set(newKey, value);
    }
    const address = localStorage.getItem('live.draftMail'), at = Number(localStorage.getItem('live.mailAt'));
    if (address && Date.now() - at < MAIL_KEEP_MS && !storage.get('email')) storage.set('email', { address, at, kept: !!localStorage.getItem('live.mailKept') });
    for (const key of ['live.draftMail', 'live.mailAt', 'live.mailKept']) localStorage.removeItem(key);
    storage.set('legacyMigrated', true);
  } catch {}
}
function notice(text, error = false) { el('notice').textContent = text; el('notice').classList.toggle('error', error); el('notice').hidden = !text; }
function node(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
function option(value, text) { const n = node('option', text); n.value = value; return n; }
function homeSummary() {
  el('resume').hidden = currentPage !== 'purpose' || !settings;
  if (settings) el('resumeSummary').textContent = destination(settings);
  el('draftCount').textContent = selected.length ? '대기 사진 ' + selected.length + '장 · 사진과 작업 설정을 유지하고 있습니다.' : originals.length ? '원본 전송 대기 ' + originals.length + '장 · 작업 이어가기에서 확인하세요.' : '마지막 작업 설정을 기억하고 있습니다.';
}
function view(name, push = true) {
  currentPage = name;
  for (const id of ['purpose', 'setup', 'work']) el(id).hidden = id !== name;
  homeSummary();
  if (push && (navigation.page !== name || navigation.mode !== mode)) {
    navigation = { camera: true, page: name, mode, depth: navigation.depth + 1 };
    history.pushState(navigation, '');
  }
  window.scrollTo({ top: 0 });
}
function goHome() {
  if (busy) return notice('사진을 접수하고 있습니다. 전송이 끝나면 홈으로 이동할 수 있습니다.');
  if (currentPage === 'setup') rememberNewTarget();
  persistDraft();
  if (navigation.depth) history.go(-navigation.depth);
  else view('purpose', false);
}
function openDialog(id) {
  navigation = { ...navigation, dialog: id, depth: navigation.depth + 1 };
  history.pushState(navigation, ''); el(id).showModal();
}
function closeDialog(id) { if (navigation.dialog === id) history.back(); else el(id).close(); }
window.addEventListener('popstate', event => {
  if (busy) {
    history.pushState(navigation, '');
    notice('사진 접수가 진행 중입니다. 전송이 끝날 때까지 기다려 주세요.'); return;
  }
  const next = event.state?.camera ? event.state : { camera: true, page: 'purpose', depth: 0 };
  navigation = next;
  for (const id of ['folderDialog', 'siteDialog', 'cameraDialog']) if (el(id).open && next.dialog !== id) el(id).close();
  if (next.page === 'work' && settings) showWork(false);
  else if (next.page === 'setup' && currentPage !== 'setup') openSetup(next.mode || mode, false);
  else view(next.page === 'work' ? 'purpose' : next.page, false);
  if (next.dialog && !el(next.dialog).open) el(next.dialog).showModal();
});
for (const id of ['folderDialog', 'siteDialog', 'cameraDialog']) {
  el(id).addEventListener('cancel', event => { event.preventDefault(); closeDialog(id); });
}
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, '0')).join(''); }
async function api(route, options = {}) {
  const params = new URLSearchParams(location.search);
  const legacyToken = params.get('t') || storage.get('token');
  if (params.get('t')) storage.set('token', params.get('t'));
  const { timeoutMs = route === 'photo' || route.endsWith('/original') ? 90000 : 15000, signal: externalSignal, ...fetchOptions } = options;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortExternal = () => controller.abort();
  externalSignal?.addEventListener('abort', abortExternal, { once: true });
  if (externalSignal?.aborted) controller.abort();
  try {
    const res = await fetch('/live/api/camera/' + route, { cache: 'no-store', ...fetchOptions, signal: controller.signal, headers: { ...(legacyToken ? { 'x-live-token': legacyToken } : {}), ...options.headers } });
    const data = await res.json().catch(error => { if (controller.signal.aborted) throw error; return {}; });
    if (res.status === 401) { location.replace('/login?role=camera'); throw new Error('다시 로그인해 주세요.'); }
    if (!res.ok) throw Object.assign(new Error(data.error || '연결을 확인하고 다시 시도해 주세요.'), { status: res.status });
    return data;
  } catch (error) {
    if (externalSignal?.aborted) throw Object.assign(new Error('원본 전송을 잠시 멈췄습니다.'), { paused: true });
    if (controller.signal.aborted) throw new Error('응답 시간이 초과되었습니다. 같은 요청으로 다시 시도해 주세요.');
    throw error;
  } finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', abortExternal); }
}
function destination(s) {
  const lines = [labels[s.mode], '업로더: ' + s.uploaderName];
  if (s.target) lines.push('보관: ' + s.target.year + ' / ' + (s.target.folderName || s.target.eventName));
  else if (s.mode === 'both') lines.push('보관: 저장 위치는 표출 후 지정할 수 있습니다.');
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
      tx.objectStore('drafts').put({ settings, entries: selected.map(({ url, ...r }) => r), originals, message: el('message').value, keepMessage: el('keepMessage').checked, shareBatch }, 'current');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    return true;
  } catch { notice('이 기기에 사진 대기 목록을 저장하지 못했습니다. 전송을 마칠 때까지 화면을 닫지 마세요.', true); return false; }
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
function rememberEmail(kept = false) {
  const address = el('email').value.trim();
  storage.set('email', address ? { address, at: Date.now(), kept } : null); renderEmail();
}
function clearEmail() { el('email').value = ''; storage.set('email', null); renderEmail(); }
function expireEmail() {
  if (!busy && !hasFrozen()) {
    const saved = storage.get('email');
    if (saved && Date.now() - saved.at >= MAIL_KEEP_MS) clearEmail();
  }
}
function renderEmail() {
  el('communication').hidden = mode === 'archive';
  el('email').disabled = busy || hasFrozen() || !config?.mail;
  el('clearEmail').disabled = busy || hasFrozen();
  el('emailAvailability').textContent = config?.mail ? '' : '현재 서버의 이메일 발송이 설정되어 있지 않습니다. 관리자에게 연결 확인을 요청해 주세요. 카카오톡 공유는 이용할 수 있습니다.';
  el('emailKeep').hidden = !el('email').value || !storage.get('email')?.kept;
  const address = el('email').value.trim(), at = address.lastIndexOf('@'), fixed = at > 0 ? MAIL_TYPOS[address.slice(at + 1).toLowerCase()] : '';
  el('emailSuggestion').hidden = !fixed;
  el('emailSuggestion').replaceChildren();
  if (fixed) {
    const button = node('button', address.slice(0, at + 1) + fixed + '로 수정할까요?', 'link'); button.type = 'button'; button.disabled = busy || hasFrozen();
    button.onclick = () => { el('email').value = address.slice(0, at + 1) + fixed; rememberEmail(); };
    el('emailSuggestion').append(button);
  }
}
async function sharingFile(file, id, maxEdge = 3840, quality = 0.9) {
  let image;
  try { image = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    const url = URL.createObjectURL(file);
    try { image = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = url; }); }
    finally { URL.revokeObjectURL(url); }
  }
  try {
    const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('share conversion');
    return new File([blob], 'photo_' + id.slice(-12) + '.jpg', { type: 'image/jpeg' });
  } finally { image.close?.(); }
}
function renderShare() {
  shareUrls.forEach(url => URL.revokeObjectURL(url)); shareUrls = [];
  const photos = shareBatch?.photos || [];
  el('shareResult').hidden = mode === 'archive' || !photos.length;
  el('shareSummary').textContent = photos.length ? kst.format(new Date(shareBatch.ts)) + ' · ' + shareBatch.siteName + ' · 접수한 사진 ' + photos.length + '장' : '';
  const files = photos.map(p => p.file);
  let supported = false;
  try { supported = !!navigator.share && !!navigator.canShare?.({ files }); } catch {}
  el('sharePhotos').hidden = !supported; el('sharePhotos').disabled = busy || sharing;
  el('sharePhotos').textContent = '카카오톡 등으로 사진 ' + photos.length + '장 보내기';
  el('shareHint').textContent = supported ? '휴대폰 공유창에서 카카오톡과 받는 분을 선택하세요. 공유창으로 사진을 전달하며 실제 메시지 전송 여부는 선택한 앱에서 확인해 주세요.' : '이 브라우저는 사진 공유창을 지원하지 않습니다. 아래 사진을 내려받은 뒤 카카오톡에 첨부하거나 이메일 발송을 이용해 주세요.';
  el('shareDownloads').replaceChildren(...photos.map((photo, index) => {
    const url = URL.createObjectURL(photo.file); shareUrls.push(url);
    const link = node('a', '사진 ' + (index + 1) + ' 내려받기'); link.href = url; link.download = photo.file.name; return link;
  }));
  for (const [id, flag] of [['cancelBatch', 'canCancel'], ['cancelBatchMail', 'canCancelMail'], ['withdrawBatch', 'canWithdraw']]) {
    const count = photos.filter(p => uploadStates.get(p.id)?.[flag]).length;
    el(id).hidden = !count; el(id).disabled = busy || batchCancelling;
    const archives = shareBatch?.mode === 'both' || photos.some(p => uploadStates.get(p.id)?.mode === 'both');
    el(id).textContent = flag === 'canCancelMail' ? '이번 이메일 ' + count + '장 모두 취소' : '이번 사진 ' + count + '장 ' + (flag === 'canWithdraw' ? '게시만 취소' : archives ? '게시·보관·메일 취소' : '게시·메일 취소');
  }
}
async function cancelBatch(mailOnly) {
  if (busy || batchCancelling || mode === 'archive') return;
  const photos = (shareBatch?.photos || []).filter(p => uploadStates.get(p.id)?.[mailOnly ? 'canCancelMail' : 'canCancel']);
  if (!photos.length) return;
  const archives = photos.some(p => uploadStates.get(p.id)?.mode === 'both');
  if (!mailOnly && !confirm('이번 사진 ' + photos.length + '장의 ' + (archives ? '보관과 모니터 표출' : '모니터 표출') + '을 취소할까요? ' + (archives ? 'Drive에 보관한 사진은 휴지통으로 이동하며 ' : '') + '대기 이메일도 취소합니다.')) return;
  batchCancelling = true; renderShare(); let cancelled = 0, lastError = '';
  try {
    for (const photo of photos) {
      try { await api('uploads/' + photo.id + (mailOnly ? '/mail' : ''), { method: 'DELETE' }); cancelled++; }
      catch (error) { lastError = error.message; }
    }
    if (cancelled) clearEmail();
    notice((mailOnly ? '이메일 ' : '사진 ') + cancelled + '장 취소' + (mailOnly ? ' · 사진 보관과 모니터 표출은 유지합니다.' : '했습니다.') + (lastError ? ' ' + lastError : ''), !!lastError);
  } finally { batchCancelling = false; await loadHistory(); renderShare(); }
}
el('cancelBatchMail').onclick = () => cancelBatch(true); el('cancelBatch').onclick = () => cancelBatch(false);
el('withdrawBatch').onclick = async () => {
  if (busy || batchCancelling) return;
  const photos = (shareBatch?.photos || []).filter(p => uploadStates.get(p.id)?.canWithdraw);
  if (!photos.length || !confirm('이번 사진 ' + photos.length + '장의 모니터 게시만 취소할까요? 원본 보관과 예약된 이메일은 유지합니다.')) return;
  batchCancelling = true; renderShare(); let failed = 0;
  try {
    for (const photo of photos) {
      try { await api('uploads/' + photo.id + '/withdraw', { method: 'DELETE' }); } catch { failed++; }
    }
    notice(failed ? failed + '장의 게시 취소에 실패했습니다. 내 업로드를 확인해 주세요.' : '모니터 게시를 취소했습니다. 원본 보관과 이메일은 유지합니다.', !!failed);
  } finally { batchCancelling = false; await loadHistory(); renderShare(); }
};
el('sharePhotos').onclick = async () => {
  if (busy || sharing || mode === 'archive' || !shareBatch?.photos.length) return;
  sharing = true; el('sharePhotos').disabled = true;
  try { await navigator.share({ files: shareBatch.photos.map(p => p.file) }); }
  catch (error) { if (error?.name !== 'AbortError') notice('공유창을 열지 못했습니다. 사진을 내려받아 첨부하거나 이메일 발송을 이용해 주세요.', true); }
  finally { sharing = false; renderShare(); }
};
function canEdit() {
  if (busy) return false;
  if (hasFrozen()) { notice('응답을 확인하지 못한 사진이 있습니다. 같은 설정으로 재시도하거나 대기 목록에서 제외한 뒤 설정을 변경해 주세요.', true); return false; }
  return true;
}
function rememberedTarget(year = el('year').value) { return storage.get('folderTargets')?.[year] || null; }
function rememberTarget(target) {
  if (!target) return;
  const targets = storage.get('folderTargets') || {};
  targets[target.year] = structuredClone(target);
  storage.set('folderTargets', targets); storage.set('lastTarget', target);
}
function formTarget() {
  const event = events.find(e => e.id === el('event').value);
  if (event) return { year: el('year').value, yearId: el('yearFolder').dataset.selected, eventId: event.id, eventName: event.name, folderName: event.name };
  if (el('event').value !== '__new__') return null;
  const eventName = el('eventName').value.normalize('NFC').replace(/\s+/g, ' ').trim(), eventDate = el('eventDate').value;
  return { year: el('year').value, yearId: el('yearFolder').dataset.selected, eventName, eventDate, folderName: eventDate ? eventDate.replace(/-/g, '') + ' ' + eventName : eventName };
}
function rememberNewTarget() {
  if (mode === 'both' && currentPage === 'work') return;
  const target = formTarget();
  if (mode !== 'live' && foldersReady && el('event').value === '__new__' && target?.eventName && [...target.eventName].length <= 80 &&
      !/[\\/\x00-\x1f\x7f]/.test(target.eventName) && !['.', '..'].includes(target.eventName) && (!target.eventDate || target.eventDate.startsWith(target.year + '-'))) rememberTarget(target);
}
function requestFolders(year, yearId = '', force = false) {
  const key = year + '/' + yearId, existing = folderRequests.get(key);
  if (existing?.pending || (!force && existing && Date.now() - existing.at < 30000)) return existing.promise;
  const entry = { at: Date.now(), pending: true };
  entry.promise = api('folders?' + new URLSearchParams({ year, ...(yearId ? { yearId } : {}), ...(force ? { refresh: '1' } : {}) }), { timeoutMs: 25000 })
    .then(data => { entry.pending = false; entry.at = Date.now(); return data; }, error => { folderRequests.delete(key); throw error; });
  folderRequests.set(key, entry); return entry.promise;
}
async function loadFolders(yearId = '', restoreEvent = '', recoverYear = true, force = false) {
  const seq = ++folderSequence; foldersReady = false; el('useSettings').disabled = mode === 'archive';
  el('folderState').textContent = '폴더 목록을 확인하고 있습니다…'; el('chooseFolder').disabled = true;
  el('reloadFolders').disabled = true;
  el('saveLocation').disabled = true;
  const started = Date.now(), progress = setInterval(() => {
    if (seq === folderSequence) el('folderState').textContent = '폴더 목록 확인 중 · ' + Math.floor((Date.now() - started) / 1000) + '초 (최대 25초)';
  }, 1000);
  try {
    const data = await requestFolders(el('year').value, yearId, force);
    if (seq !== folderSequence) return;
    el('yearOptions').replaceChildren(...[...new Set(data.years.map(y => y.name))].map(y => option(y, y)));
    const matches = data.years.filter(y => y.name === el('year').value);
    el('yearFolderLabel').hidden = matches.length < 2;
    el('yearFolder').replaceChildren(...(data.ambiguous ? [option('', '사용할 연도 폴더를 선택해 주세요')] : []), ...matches.map(y => option(y.id, y.name + ' · 폴더 ' + y.id.slice(-8))));
    el('yearFolder').value = data.yearId;
    el('yearFolder').dataset.selected = data.yearId;
    events = data.events;
    const missing = restoreEvent && restoreEvent !== '__new__' && !events.some(e => e.id === restoreEvent && e.writable);
    renderEvents(missing ? '' : restoreEvent);
    el('folderState').textContent = data.ambiguous ? '같은 연도 폴더가 여러 개입니다. 위에서 사용할 폴더를 선택해 주세요.' : data.exists ? '기존 연도 폴더의 행사 목록입니다.' : el('year').value + ' 연도 폴더는 첫 사진을 저장할 때 생성합니다.';
    if (missing) el('folderState').textContent = '최근 선택 폴더가 삭제되었거나 접근할 수 없습니다. 저장 폴더를 다시 선택해 주세요.';
    if (data.warning) el('folderState').textContent += ' ' + data.warning;
    if (data.checkedAt) el('folderState').textContent += ' · 확인: ' + kst.format(new Date(data.checkedAt));
    foldersReady = !data.ambiguous; el('chooseFolder').disabled = data.ambiguous; el('useSettings').disabled = mode === 'archive' && data.ambiguous;
  } catch (e) {
    if (seq !== folderSequence) return;
    // An old year ID may have been deleted or moved. Reload the list without
    // selecting a replacement folder or interpreting a failed query as absence.
    if (yearId && recoverYear && e.status === 409) {
      await loadFolders('', '', false, true);
      if (foldersReady) el('folderState').textContent = '최근 연도 폴더를 확인하지 못했습니다. 저장 폴더를 다시 선택해 주세요.';
      return;
    }
    events = []; el('event').value = ''; renderEvents(''); el('chooseFolder').disabled = true;
    el('folderState').textContent = e.message + ' 목록을 확인하기 전에는 새 폴더를 만들지 않습니다.';
  } finally { clearInterval(progress); if (seq === folderSequence) { el('reloadFolders').disabled = false; el('saveLocation').disabled = !foldersReady || assigningLocation; } }
}
function renderEvents(restore = el('event').value) {
  const search = el('eventSearch').value.trim().normalize('NFC').toLocaleLowerCase('ko');
  const recent = rememberedTarget();
  const recentId = recent?.yearId === el('yearFolder').dataset.selected ? recent.eventId || events.find(e => e.name === recent.folderName)?.id : '';
  const date = name => {
    const match = name.match(/^(\d{4})[-.]?(\d{2})[-.]?(\d{2})/);
    if (!match) return '';
    const iso = match[1] + '-' + match[2] + '-' + match[3];
    const ts = Date.parse(iso + 'T00:00:00Z');
    return Number.isFinite(ts) && new Date(ts).toISOString().slice(0, 10) === iso ? match.slice(1).join('') : '';
  };
  const filtered = events.filter(e => e.name.normalize('NFC').toLocaleLowerCase('ko').includes(search)).sort((a, b) =>
    Number(b.id === recentId) - Number(a.id === recentId) || date(b.name).localeCompare(date(a.name)) || a.name.localeCompare(b.name, 'ko', { numeric: true }) || a.id.localeCompare(b.id));
  const duplicates = name => events.filter(e => e.name === name).length > 1;
  el('event').value = restore === '__new__' || events.some(e => e.id === restore && e.writable) ? restore : '';
  el('folderList').replaceChildren(...filtered.map(e => {
    const button = node('button', undefined, 'selectionRow'); button.type = 'button'; button.dataset.folderId = e.id; button.disabled = !e.writable;
    button.setAttribute('aria-pressed', String(e.id === el('event').value));
    button.append(node('strong', e.name + (duplicates(e.name) ? ' · ' + e.id.slice(-8) : '')),
      node('small', [e.id === recentId ? '최근 선택 폴더' : '', e.id === el('event').value ? '현재 선택' : '', !e.writable ? '추가 권한 없음' : ''].filter(Boolean).join(' · ')));
    button.onclick = () => { el('event').value = e.id; if (mode !== 'both' || currentPage !== 'work') rememberTarget(formTarget()); renderEvents(); closeDialog('folderDialog'); };
    return button;
  }));
  if (!filtered.length) el('folderList').append(node('p', events.length ? '검색 결과가 없습니다.' : '저장 폴더가 없습니다. 새 폴더를 선택해 행사명을 입력하세요.', 'hint'));
  el('newEvent').hidden = el('event').value !== '__new__'; updateNewPath();
}
function updateNewPath() {
  const name = el('eventName').value.normalize('NFC').replace(/\s+/g, ' ').trim();
  const date = el('eventDate').value;
  const folderName = date ? date.replace(/-/g, '') + ' ' + name : name;
  const exact = events.find(e => e.name.normalize('NFC').replace(/\s+/g, ' ').trim() === folderName);
  el('newPath').textContent = '#교회사진영상 / ' + el('year').value + ' / ' + (folderName || '행사명') + (exact ? ' · 같은 이름의 기존 폴더를 사용합니다.' : ' · 첫 사진을 저장할 때 생성합니다.');
  const target = formTarget();
  el('folderButtonText').textContent = target ? target.year + ' / ' + (target.folderName || '새 폴더 · 행사명 입력') : '저장 폴더 선택';
}
function monitorStatus(site) {
  const span = node('span', undefined, 'monitorStatus');
  const dot = node('span', undefined, 'statusDot ' + (site.online ? 'online' : 'offline')); dot.setAttribute('aria-hidden', 'true');
  span.append(dot, node('span', site.online ? '연결됨' : '연결 끊김')); return span;
}
function renderSites() {
  const selectedSite = config.sites.find(s => s.id === el('site').value);
  el('siteButtonText').replaceChildren(selectedSite ? node('span', selectedSite.name) : node('span', '모니터 선택'));
  if (selectedSite) el('siteButtonText').append(monitorStatus(selectedSite));
  el('siteList').replaceChildren(...[...config.sites].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'ko')).map(site => {
    const button = node('button', undefined, 'selectionRow'); button.type = 'button'; button.dataset.siteId = site.id;
    button.setAttribute('aria-pressed', String(site.id === el('site').value));
    button.append(node('strong', site.name), monitorStatus(site));
    button.onclick = () => { el('site').value = site.id; storage.set('lastSite', site.id); renderSites(); closeDialog('siteDialog'); };
    return button;
  }));
  if (!config.sites.length) el('siteList').append(node('p', '등록된 모니터가 없습니다.', 'hint'));
  const dd = el('workSummary').querySelector('[data-monitor]');
  if (dd && settings) {
    dd.replaceChildren(node('span', settings.siteName));
    const site = config.sites.find(s => s.id === settings.siteId);
    if (site) dd.append(monitorStatus(site)); else dd.append(node('span', ' · 등록되지 않은 모니터'));
  }
}
async function refreshSites() {
  const seq = ++siteSequence; sitesReady = false; el('chooseSite').disabled = true;
  el('siteState').textContent = '모니터 연결 상태 확인 중…';
  try {
    const data = await api('config');
    if (seq !== siteSequence) return;
    Object.assign(config, data); sitesReady = true; renderSites(); updateWorkWarning();
    el('siteState').textContent = ''; el('siteDialogState').textContent = '';
  } catch (e) {
    if (seq !== siteSequence) return;
    el('siteState').textContent = e.message; el('siteDialogState').textContent = '연결 상태를 확인하지 못했습니다. 목록을 다시 열어 확인해 주세요.';
    const site = config.sites.find(s => s.id === el('site').value);
    el('siteButtonText').textContent = (site?.name || '모니터 선택') + ' · 상태 확인 불가';
    el('siteList').replaceChildren(node('p', '연결 상태를 확인한 뒤 모니터를 선택할 수 있습니다.', 'hint'));
    const dd = el('workSummary').querySelector('[data-monitor]');
    if (dd && settings) dd.textContent = settings.siteName + ' · 상태 확인 불가';
  } finally { if (seq === siteSequence) el('chooseSite').disabled = false; }
}
async function openSetup(nextMode, push = true) {
  mode = nextMode; view('setup', push); el('setupTitle').textContent = labels[mode];
  el('setupForm').insertBefore(el('archiveSetup'), el('liveSetup'));
  el('archiveSetup').hidden = mode !== 'archive'; el('archiveSetup').disabled = mode !== 'archive';
  el('liveSetup').hidden = mode === 'archive'; el('liveSetup').disabled = mode === 'archive';
  const s = settings || storage.get('settings') || {};
  el('uploader').value = s.uploaderName || storage.get('name') || '';
  const target = storage.get('lastTarget') || s.target;
  el('year').value = target?.year || config.year;
  el('eventName').value = target?.eventId ? '' : target?.eventName || '';
  el('eventDate').value = target?.eventId ? '' : target?.eventDate || '';
  el('eventSearch').value = '';
  el('site').value = storage.get('lastSite') || s.siteId || ''; renderSites();
  if (mode !== 'archive') refreshSites();
  if (mode === 'archive') await loadFolders(target?.yearId || '', target?.eventId || (target?.eventName ? '__new__' : ''));
  else { ++folderSequence; el('useSettings').disabled = false; }
}
function validatedTarget() {
  if (!foldersReady) throw new Error('폴더 목록을 먼저 확인해 주세요.');
  const target = formTarget();
  if (!target) throw new Error('행사를 선택하거나 새 행사명을 입력해 주세요.');
  if (!target.eventId) {
    if (!target.eventName || [...target.eventName].length > 80 || /[\\/\x00-\x1f\x7f]/.test(target.eventName) || ['.', '..'].includes(target.eventName)) throw new Error('행사명을 1~80자로 입력해 주세요. /와 \\는 사용할 수 없습니다.');
    if (target.eventDate && !target.eventDate.startsWith(target.year + '-')) throw new Error('행사 시작일과 저장 연도가 다릅니다.');
  }
  return target;
}
function applySettings(event) {
  event.preventDefault();
  if (!canEdit()) return;
  const uploaderName = el('uploader').value.normalize('NFC').trim();
  if (!uploaderName || [...uploaderName].length > 20) return notice('업로더 이름을 1~20자로 입력해 주세요.', true);
  let target = null;
  if (mode === 'both') target = storage.get('lastTarget') || null;
  if (mode === 'archive') {
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
  if (mode !== 'archive' && !sitesReady) return notice('모니터 목록을 다시 열어 연결 상태를 확인해 주세요.', true);
  if (mode !== 'archive' && !site) return notice('표출할 모니터를 선택해 주세요.', true);
  settings = { mode, uploaderName, target, siteId: site?.id || '', siteName: site?.name || '' };
  rememberTarget(target);
  if (site) storage.set('lastSite', site.id);
  storage.set('settings', settings); storage.set('name', uploaderName); persistDraft(); notice(''); showWork();
}
function showWork(push = true) {
  const entering = currentPage !== 'work' || el('archiveSetup').parentElement !== el('archiveLocationFields');
  mode = settings.mode; view('work', push); el('workTitle').textContent = labels[mode];
  const values = [['업로더', settings.uploaderName]];
  if (settings.target) values.push(['보관 위치', settings.target.year + ' / ' + (settings.target.folderName || settings.target.eventName)]);
  else if (mode === 'both') values.push(['보관 위치', '표출 후 지정 가능']);
  if (mode !== 'archive') values.push(['표출 모니터', settings.siteName]);
  el('workSummary').replaceChildren(...values.flatMap(([key, value]) => [node('dt', key), node('dd', value)]));
  if (mode !== 'archive') { el('workSummary').lastElementChild.dataset.monitor = ''; renderSites(); }
  el('workArchive').hidden = mode !== 'both';
  if (mode === 'both') {
    el('archiveLocationFields').append(el('archiveSetup')); el('archiveSetup').hidden = false; el('archiveSetup').disabled = false;
    if (entering) {
      const target = settings.target || storage.get('lastTarget');
      el('year').value = target?.year || config.year;
      el('eventName').value = target?.eventId ? '' : target?.eventName || ''; el('eventDate').value = target?.eventDate || '';
      loadFolders(target?.yearId || '', target?.eventId || (target?.eventName ? '__new__' : ''));
    }
  }
  renderOriginals();
  expireEmail(); updateWorkWarning(); renderReview(); renderShare(); loadHistory();
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
    if (!file.size) { notice(file.name + ': 사진 파일이 비어 있습니다. 저장을 마친 뒤 다시 선택해 주세요.', true); continue; }
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
  el('messageCount').textContent = el('message').value.length;
  renderEmail();
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
  el('send').textContent = mode === 'archive' ? '사진 ' + selected.length + '장 Drive에 저장' : '사진 ' + selected.length + '장 모니터에 먼저 게시';
}
function setBusy(value) {
  busy = value;
  for (const id of ['home', 'shoot', 'choose', 'changePurpose', 'changeSettings', 'send', 'discard', 'message', 'keepMessage', 'email']) el(id).disabled = value;
  if (hasFrozen()) for (const id of ['message', 'keepMessage', 'email']) el(id).disabled = true;
  renderReview(); renderShare();
}
async function sendPhotos() {
  if (busy || !selected.length) return;
  expireEmail();
  if (mode !== 'archive' && config.mail && el('email').value && !el('email').reportValidity()) return;
  setBusy(true); originalController?.abort(); let accepted = 0; const originalCount = selected.length;
  const batchKey = selected.find(r => r.submission)?.submission.batchKey || uuid();
  try {
    for (const r of [...selected]) {
      if (!r.submission) r.submission = { ...structuredClone(settings), fast: mode !== 'archive', message: mode === 'archive' ? '' : el('message').value.trim(), email: mode !== 'archive' && config.mail ? el('email').value.trim() : '', batchKey, batchTotal: originalCount, date: r.date, dateSource: r.dateSource };
      r.submission.batchKey ||= batchKey;
      if (!await persistDraft()) { r.error = '사진 대기 목록을 기기에 저장하지 못했습니다. 저장 공간을 확인해 주세요.'; break; }
      el('progress').textContent = (accepted + 1) + ' / ' + originalCount + ' · ' + r.file.name + ' 접수하는 중…';
      const s = r.submission, form = new FormData();
      for (const [key, value] of Object.entries({ mode: s.mode, target: JSON.stringify(s.target || {}), uploaderName: s.uploaderName,
        requestId: r.requestId, siteId: s.siteId, message: s.message, email: s.email, batchTotal: s.batchTotal,
        capturedAt: s.date, dateSource: s.dateSource, lastModified: r.file.lastModified || '' })) form.append(key, String(value ?? ''));
      try {
        if (s.fast && !r.previewFile) {
          try { r.previewFile = await sharingFile(r.file, r.requestId, 2048, 0.82); }
          catch { r.previewFile = r.file; notice('이 사진 형식은 기기에서 축소할 수 없어 원본 전송 후 표출합니다.', true); }
          if (!await persistDraft()) throw new Error('전송 대기 사진을 저장하지 못했습니다.');
        }
        const transfer = s.fast ? r.previewFile : r.file;
        form.append('originalName', r.file.name); form.append('photo', transfer, transfer.name);
        const result = await api(s.fast ? 'preview' : 'photo', { method: 'POST', body: form });
        if (s.fast && s.mode === 'both' && !result.upload.cancelled && !originals.some(p => p.id === result.upload.id)) originals.push({ id: result.upload.id, file: r.file, target: result.upload.target || s.target, error: '' });
        accepted++; URL.revokeObjectURL(r.url); selected = selected.filter(x => x !== r);
        if (s.mode !== 'archive') {
          if (shareBatch?.key !== s.batchKey) shareBatch = { key: s.batchKey, mode: s.mode, ts: Date.now(), siteName: s.siteName, photos: [] };
          if (!result.upload?.cancelled && !shareBatch.photos.some(p => p.id === result.upload.id)) {
            let file = r.previewFile; if (!file) { try { file = await sharingFile(r.file, result.upload.id); } catch { file = r.file; } }
            shareBatch.photos.push({ id: result.upload.id, file });
          }
        }
        if (result.upload?.target?.eventId && settings.target && s.target?.year === settings.target.year && (s.target.eventId === settings.target.eventId || (!settings.target.eventId && s.target.folderName === settings.target.folderName))) {
          settings.target = result.upload.target; rememberTarget(settings.target); storage.set('settings', settings);
        }
      } catch (e) { r.error = e.message; }
      await persistDraft();
    }
    el('progress').textContent = accepted + '장 서버 접수 완료' + (selected.length ? ' · ' + selected.length + '장 응답 확인 필요. 같은 설정으로 재시도해 주세요.' : ' · 같은 작업으로 계속 촬영하거나 사진을 선택하세요.');
    if (selected.length) notice('전송하지 못했거나 응답을 확인하지 못한 사진을 대기 목록에 남겼습니다. 재시도해도 중복 접수하지 않습니다.', true);
    else notice(accepted + '장 접수했습니다. 모니터 표시와 원본 보관 상태는 각각 확인하세요.');
    if (accepted && mode !== 'archive' && el('email').value) rememberEmail(true);
    if (!el('keepMessage').checked) el('message').value = '';
  } finally {
    if (!selected.length) { el('shootInput').value = ''; el('galleryInput').value = ''; }
    setBusy(false); await persistDraft(); renderOriginals(); runOriginals(); await loadHistory();
  }
}
function renderOriginals() {
  el('originalTransfers').hidden = !originals.length;
  el('originalTransferState').textContent = '원본 전송 대기 ' + originals.length + '장' + (originalRunning ? ' · 전송 중' : '');
  el('originalTransferList').replaceChildren(...originals.map(p => node('p', p.file.name + ' · ' + (p.error || '서버 원본 접수 대기'), 'hint')));
  el('retryOriginals').disabled = originalRunning || busy; homeSummary();
  const pending = [...uploadStates.values()].filter(r => r.pipeline && !r.cancelled && !r.target && r.mode === 'both').length;
  el('pendingLocation').textContent = (settings?.target ? '다음 사진 보관: ' + settings.target.year + ' / ' + (settings.target.folderName || settings.target.eventName) : '저장 위치를 지정해 주세요.') + (pending ? ' · 위치 지정 필요 ' + pending + '장' : '');
}
async function runOriginals() {
  if (originalRunning || busy || !originals.some(p => !p.error)) return;
  originalRunning = true; renderOriginals();
  try {
    while (!busy) {
      const entry = originals.find(p => !p.error); if (!entry) break;
      originalController = new AbortController();
      const body = new FormData(); body.append('photo', entry.file, entry.file.name);
      try {
        const result = await api('uploads/' + entry.id + '/original', { method: 'POST', body, signal: originalController.signal });
        if (result.upload.original !== 'received') throw new Error('원본 접수 상태를 확인하지 못했습니다.');
        originals = originals.filter(p => p !== entry);
      } catch (error) {
        if (error.paused) break;
        if (error.status === 410) originals = originals.filter(p => p !== entry);
        else entry.error = error.message;
      }
      await persistDraft(); renderOriginals();
    }
  } finally {
    originalController = null; originalRunning = false; await persistDraft(); renderOriginals(); loadHistory();
    if (!busy && originals.some(p => !p.error)) queueMicrotask(runOriginals);
  }
}
el('retryOriginals').onclick = () => { originals.forEach(p => p.error = ''); persistDraft(); runOriginals(); };
el('saveLocation').onclick = async () => {
  if (assigningLocation) return;
  let target; try { target = validatedTarget(); } catch (error) { return notice(error.message, true); }
  assigningLocation = true; el('saveLocation').disabled = true;
  // Snapshot IDs: changing the next-photo destination never retargets pictures
  // that already have a destination, or later photos from another task.
  const ids = [...new Set([...uploadStates.values()].filter(r => r.pipeline && r.mode === 'both' && !r.cancelled && !r.target).map(r => r.id).concat(originals.filter(p => !p.target).map(p => p.id)))];
  settings.target = target; rememberTarget(target); storage.set('settings', settings);
  const label = [...el('workSummary').querySelectorAll('dt')].find(n => n.textContent === '보관 위치');
  if (label) label.nextElementSibling.textContent = target.year + ' / ' + (target.folderName || target.eventName);
  let failed = 0;
  try {
    for (const id of ids) {
      try {
        await api('uploads/' + id + '/target', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target) });
        const local = originals.find(p => p.id === id); if (local) local.target = target;
      } catch { failed++; }
    }
    await persistDraft(); notice(failed ? failed + '장의 위치 지정에 실패했습니다. 내 업로드에서 확인해 주세요.' : '보관 위치를 지정했습니다. 다음 사진도 이 위치로 보관합니다.', !!failed);
  } finally { assigningLocation = false; el('saveLocation').disabled = false; await loadHistory(); renderOriginals(); }
};
async function loadHistory() {
  try {
    const data = await api('uploads');
    uploadStates = new Map(data.uploads.map(r => [r.id, r]));
    if (data.state) { Object.assign(config, data.state); updateWorkWarning(); }
    if (shareBatch) {
      const cancelled = new Set(data.uploads.filter(r => r.cancelled).map(r => r.id));
      if (shareBatch.photos.some(p => cancelled.has(p.id))) { shareBatch.photos = shareBatch.photos.filter(p => !cancelled.has(p.id)); persistDraft(); renderShare(); }
    }
    renderShare();
    el('history').replaceChildren(...data.uploads.map(r => {
      const wrap = node('div', undefined, 'historyRow'); wrap.append(node('strong', r.name), node('p', kst.format(new Date(r.ts)) + (r.target ? ' · ' + r.target.year + ' / ' + (r.target.folderName || r.target.eventName) : '')));
      const states = [];
      if (r.cancelled) states.push('취소 요청 완료');
      if (r.archive !== 'none') states.push(archiveLabels[r.archive] || r.archive);
      if (r.archiveError) states.push(r.archiveError);
      if (r.live !== 'none' && !r.cancelled) {
        const displayed = r.delivery.filter(d => d.status === 'displayed').length;
        states.push(r.live === 'withdrawn' ? '모니터 게시 취소' + (r.mode === 'both' ? ' · 보관은 유지' : '') : displayed ? '모니터 표시 확인 ' + displayed + '곳' : r.live === 'sent' ? '모니터 전달 요청 완료 · 표시 확인 대기' : r.live === 'pending' ? '모니터 처리 결과 미확인' : '모니터 표출 실패');
        if (r.delivery.some(d => d.status === 'image_error' || d.status === 'stopped')) states.push('일부 모니터에서 표시 오류');
        if (r.liveError) states.push(r.liveError);
      }
      if (r.mail) states.push('이메일: ' + (mailLabels[r.mail] || '발송 결과 확인 필요') + (r.mail === 'queued' ? ' · 취소 가능 시간이 지난 뒤 발송' : ''));
      wrap.append(node('p', states.join(' · ')));
      const actions = node('div', undefined, 'actions');
      if (r.canWithdraw) {
        const withdraw = node('button', '게시만 취소'); withdraw.dataset.withdraw = r.id;
        withdraw.onclick = async () => {
          if (!confirm('모니터 게시만 취소할까요? 원본 보관과 예약된 이메일은 유지합니다.')) return;
          withdraw.disabled = true;
          try { await api('uploads/' + r.id + '/withdraw', { method: 'DELETE' }); notice('모니터 게시를 취소했습니다. 원본 보관과 이메일은 유지합니다.'); }
          catch (error) { notice(error.message, true); }
          finally { await loadHistory(); }
        }; actions.append(withdraw);
      }
      if (r.canCancelMail && mode !== 'archive') {
        const cancelMail = node('button', '메일만 보내지 않기'); cancelMail.dataset.mailCancel = r.id;
        cancelMail.onclick = async () => {
          cancelMail.disabled = true;
          try { await api('uploads/' + r.id + '/mail', { method: 'DELETE' }); clearEmail(); notice('이메일 발송을 취소했습니다. 사진 보관과 모니터 표출은 유지합니다.'); }
          catch (e) { notice(e.message, true); }
          finally { await loadHistory(); }
        }; actions.append(cancelMail);
      }
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
        const left = Math.max(0, Math.ceil((r.ts + config.cancelSec * 1000 - Date.now()) / 1000));
        const cancel = node('button', (r.mode === 'archive' ? '보관 취소' : r.mode === 'both' ? '게시·보관·메일 취소' : '게시·메일 취소') + ' (' + left + '초)'); cancel.onclick = async () => {
          if (!confirm(r.mode === 'live' ? '이 사진의 모니터 게시와 대기 이메일을 취소할까요?' : '이 사진의 보관' + (r.mode === 'both' ? '과 모니터 표출' : '') + '을 취소할까요? 저장된 Drive 사진은 휴지통으로 이동합니다.')) return;
          cancel.disabled = true; try { await api('uploads/' + r.id, { method: 'DELETE' }); await loadHistory(); } catch (e) { notice(e.message, true); cancel.disabled = false; }
        }; actions.append(cancel);
      }
      wrap.append(actions); return wrap;
    }));
    if (!data.uploads.length) el('history').append(node('p', '아직 이 브라우저에서 접수한 사진이 없습니다.', 'hint'));
    const cancelledIds = new Set(data.uploads.filter(r => r.cancelled).map(r => r.id));
    if (originals.some(p => cancelledIds.has(p.id))) { originals = originals.filter(p => !cancelledIds.has(p.id)); await persistDraft(); }
    renderOriginals();
    // Follow the actual folder IDs once the first upload has created the hierarchy.
    const resolved = data.uploads.find(r => !r.cancelled && r.target?.eventId && settings?.target && r.target.year === settings.target.year && r.target.folderName === settings.target.folderName);
    if (resolved && !settings.target.eventId) {
      settings.target = resolved.target; rememberTarget(settings.target); storage.set('settings', settings); persistDraft();
      const label = [...el('workSummary').querySelectorAll('dt')].find(n => n.textContent === '보관 위치');
      if (label) label.nextElementSibling.textContent = settings.target.year + ' / ' + settings.target.folderName;
    }
    if (mode !== 'archive') await refreshSites();
  } catch (e) { el('history').textContent = e.message; }
}
document.querySelectorAll('[data-mode]').forEach(button => button.onclick = () => { if (canEdit()) openSetup(button.dataset.mode); });
el('setupForm').onsubmit = applySettings;
el('home').onclick = goHome;
el('backPurpose').onclick = goHome;
el('changePurpose').onclick = goHome;
el('changeSettings').onclick = () => { if (canEdit()) openSetup(settings.mode); };
el('year').onchange = () => {
  const target = rememberedTarget();
  el('eventSearch').value = ''; el('eventName').value = target?.eventId ? '' : target?.eventName || ''; el('eventDate').value = target?.eventId ? '' : target?.eventDate || '';
  loadFolders(target?.yearId || '', target?.eventId || (target?.eventName ? '__new__' : ''));
};
el('yearFolder').onchange = () => loadFolders(el('yearFolder').value);
el('reloadFolders').onclick = () => loadFolders(el('yearFolder').dataset.selected || '', el('event').value, true, true);
el('eventSearch').oninput = () => renderEvents();
el('chooseFolder').onclick = () => {
  if (!foldersReady) return notice('폴더 목록을 먼저 확인해 주세요.', true);
  el('eventSearch').value = ''; renderEvents(); el('folderDialogTitle').textContent = el('year').value + ' · 저장 폴더 선택'; openDialog('folderDialog');
  const current = [...el('folderList').querySelectorAll('button')].find(b => b.dataset.folderId === el('event').value);
  if (current) { current.focus(); current.scrollIntoView({ block: 'nearest' }); }
};
el('closeFolders').onclick = () => closeDialog('folderDialog');
el('createFolder').onclick = () => { el('event').value = '__new__'; renderEvents(); closeDialog('folderDialog'); };
el('folderDialog').addEventListener('close', () => { if (['setup', 'work'].includes(currentPage) && el('event').value === '__new__') el('eventName').focus(); });
el('chooseSite').onclick = async () => { await refreshSites(); if (currentPage === 'setup' && !el('siteDialog').open) openDialog('siteDialog'); };
el('closeSites').onclick = () => closeDialog('siteDialog');
el('eventName').oninput = () => { updateNewPath(); rememberNewTarget(); };
el('eventDate').onchange = () => { updateNewPath(); rememberNewTarget(); };
el('continueResume').onclick = () => { if (settings) showWork(); };
for (const [button, input] of [['shoot', 'shootInput'], ['choose', 'galleryInput']]) {
  el(button).onclick = async () => {
    if (busy) return;
    if (button === 'shoot' && !isMobile) {
      if (!navigator.mediaDevices?.getUserMedia) return notice('이 브라우저에서는 카메라를 사용할 수 없습니다. 사진 파일을 선택해 주세요.', true);
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
        if (currentPage !== 'work') { cameraStream.getTracks().forEach(track => track.stop()); cameraStream = null; return; }
        el('cameraVideo').srcObject = cameraStream; openDialog('cameraDialog');
      } catch { notice('카메라 연결과 브라우저의 카메라 허용 여부를 확인해 주세요. 사진 파일 선택도 사용할 수 있습니다.', true); }
      return;
    }
    storage.set('capturePending', true); el(input).value = ''; el(input).click();
  };
  el(input).onchange = () => addFiles(el(input).files);
  el(input).addEventListener('cancel', () => storage.set('capturePending', false));
}
el('closeCamera').onclick = () => closeDialog('cameraDialog');
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
    closeDialog('cameraDialog'); await addFiles([file], true);
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
el('message').oninput = () => { el('messageCount').textContent = el('message').value.length; persistDraft(); }; el('keepMessage').onchange = () => persistDraft();
el('email').oninput = () => rememberEmail(); el('clearEmail').onclick = clearEmail;
setInterval(expireEmail, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) expireEmail(); });
window.addEventListener('beforeunload', event => { if (busy || originals.length) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('online', () => { notice('인터넷에 다시 연결되었습니다. 대기 사진을 확인하고 전송해 주세요.'); originals.forEach(p => p.error = ''); runOriginals(); loadHistory(); });
window.addEventListener('offline', () => notice('인터넷 연결이 끊겼습니다. 선택한 사진은 대기 목록에 유지합니다.', true));
async function init() {
  try {
    migrateLegacyState();
    config = await api('config');
    const recentFolder = storage.get('lastTarget');
    requestFolders(String(recentFolder?.year || config.year), recentFolder?.yearId || '').catch(() => {});
    const draft = await readDraft();
    originals = draft?.originals || [];
    shareBatch = draft?.shareBatch || null;
    const savedEmail = storage.get('email');
    if (savedEmail && Date.now() - savedEmail.at < MAIL_KEEP_MS) el('email').value = savedEmail.address;
    else storage.set('email', null);
    settings = draft?.entries?.length ? draft.settings : storage.get('settings');
    if (settings && (!labels[settings.mode] || !settings.uploaderName || (settings.mode === 'archive' && !settings.target))) settings = null;
    if (draft?.entries?.length && settings) {
      selected = draft.entries.map(r => ({ ...r, url: URL.createObjectURL(r.file) }));
      el('message').value = draft.message || ''; el('keepMessage').checked = !!draft.keepMessage;
      notice('전송 대기 사진 ' + selected.length + '장을 복원했습니다. 같은 작업으로 계속해 주세요.');
    } else if (storage.get('capturePending')) { notice('촬영·사진 선택 중 화면이 다시 열렸습니다. 사진이 전달되지 않았다면 앨범에서 다시 선택해 주세요.', true); storage.set('capturePending', false); }
    if (settings?.target && !storage.get('lastTarget')) rememberTarget(settings.target);
    navigation = { camera: true, page: 'purpose', depth: 0 }; history.replaceState(navigation, ''); view('purpose', false);
    if (!isMobile) el('choose').textContent = '🖼 사진 파일 선택';
    if (!isMobile && !navigator.mediaDevices?.getUserMedia) { el('shoot').disabled = true; el('shoot').title = '카메라를 사용할 수 있는 기기에서 촬영해 주세요.'; }
    renderOriginals(); runOriginals();
  } catch (e) { notice(e.message, true); }
}
init();
setInterval(() => { if (!document.hidden && !el('work').hidden && !busy) loadHistory(); }, 5000);
