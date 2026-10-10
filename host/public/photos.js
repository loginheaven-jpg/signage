'use strict';
const $ = id => document.getElementById(id);
let offset = 0;
let requestSequence = 0;
let toastTimer;
let lastGridSignature = '';
let connectionFailure = '';
const filterStorageKey = 'signage.photos.filters.v1';
const emptyFilters = () => ({ year: '', yearId: '', eventId: '', eventName: '', scope: '', kind: '', date: '' });
let filters = emptyFilters();
let folders = { years: [], rootTotal: 0, awaitingTotal: 0 };
let folderRequestSequence = 0, folderPollTimer, folderController;
function acceptFolders(incoming) {
  if ((incoming.checkedAt || 0) < (folders.checkedAt || 0)) return;
  folders = incoming;
}
async function loadFolders(force = false) {
  const seq = ++folderRequestSequence;
  clearTimeout(folderPollTimer); folderController?.abort();
  const controller = new AbortController(); folderController = controller;
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const data = await api('/api/photos/folders' + (force ? '?refresh=1' : ''), { signal: controller.signal });
    if (seq !== folderRequestSequence) return;
    const previousSelection = folderSelectionKey(), previousCheckedAt = folders.checkedAt || 0;
    acceptFolders(data); reconcileFolderSelection(); renderFolderFilters(); rememberFilters();
    // The first folder-only read can complete while the much larger media sync is still running.
    if (previousSelection !== folderSelectionKey() || (data.checkedAt || 0) > previousCheckedAt) await load();
    if (data.refreshing) folderPollTimer = setTimeout(() => loadFolders(), 1000);
  } catch (e) {
    if (seq !== folderRequestSequence) return;
    folders = { ...folders, refreshing: false, error: controller.signal.aborted ? '폴더 조회 시간이 초과되었습니다.' : e.message };
    renderFolderFilters();
  } finally { clearTimeout(timeout); }
}
try {
  const saved = JSON.parse(localStorage.getItem(filterStorageKey));
  if (saved && typeof saved === 'object') {
    if (/^(19|20|21)\d{2}$/.test(saved.year)) filters.year = saved.year;
    if (filters.year && typeof saved.yearId === 'string' && /^[\w-]{1,128}$/.test(saved.yearId)) filters.yearId = saved.yearId;
    if (['root', 'awaiting_target'].includes(saved.scope)) { filters.scope = saved.scope; filters.year = ''; filters.yearId = ''; }
    if (filters.year && typeof saved.eventId === 'string' && /^[\w-]{1,128}$/.test(saved.eventId)) {
      filters.eventId = saved.eventId; filters.eventName = typeof saved.eventName === 'string' ? saved.eventName : '';
    }
    if (['photo', 'video'].includes(saved.kind)) filters.kind = saved.kind;
    if (/^\d{4}-\d{2}-\d{2}$/.test(saved.date)) filters.date = saved.date;
  }
} catch { /* Browsing still works when local storage is unavailable. */ }
function rememberFilters() {
  try { localStorage.setItem(filterStorageKey, JSON.stringify(filters)); } catch { /* Optional preference. */ }
}
function changeFilters(changes) {
  filters = { ...filters, ...changes }; offset = 0;
  rememberFilters(); renderFolderFilters(); load();
}
function selectedYear() {
  if (filters.yearId) return folders.years.find(group => group.id === filters.yearId);
  const matches = folders.years.filter(group => group.year === filters.year);
  return matches.length === 1 ? matches[0] : null;
}
function reconcileFolderSelection() {
  const group = (filters.eventId && folders.years.find(group => group.events.some(event => event.id === filters.eventId))) || selectedYear();
  if (group) { filters.year = group.year; filters.yearId = group.id; }
}
function folderSelectionKey() { return JSON.stringify([filters.year, filters.yearId, filters.eventId]); }
function eventLabels(events) {
  const totals = new Map(), seen = new Map();
  for (const event of events) totals.set(event.name, (totals.get(event.name) || 0) + 1);
  return new Map(events.map(event => {
    seen.set(event.name, (seen.get(event.name) || 0) + 1);
    return [event.id, event.name + (totals.get(event.name) > 1 ? ' (동명 폴더 ' + seen.get(event.name) + ')' : '')];
  }));
}
function renderFolderFilters() {
  const options = [new Option('전체 연도', '')];
  const yearNames = eventLabels(folders.years.map(group => ({ id: group.id, name: group.year + '년' })));
  for (const group of folders.years) options.push(new Option(yearNames.get(group.id) + ' · ' + group.total + '개', group.id));
  if (filters.year && !selectedYear()) options.push(new Option(filters.year + '년 · 폴더 확인 필요', filters.yearId || '__year_' + filters.year));
  options.push(new Option('루트 폴더 자료 · ' + folders.rootTotal + '개', '__root__'));
  options.push(new Option('저장 위치 지정 필요 · ' + folders.awaitingTotal + '개', '__awaiting__'));
  const value = filters.scope === 'root' ? '__root__' : filters.scope === 'awaiting_target' ? '__awaiting__' : filters.yearId || (filters.year ? '__year_' + filters.year : '');
  // Keep the focused native select intact during background refreshes.
  const signature = JSON.stringify(options.map(option => [option.value, option.text]));
  if ($('year').dataset.signature !== signature) { $('year').replaceChildren(...options); $('year').dataset.signature = signature; }
  $('year').value = value;
  const events = selectedYear()?.events || [], labels = eventLabels(events);
  const selected = events.find(event => event.id === filters.eventId);
  if (selected) { filters.eventName = labels.get(selected.id); rememberFilters(); }
  $('chooseEvent').disabled = !filters.year;
  $('eventChoiceText').textContent = !filters.year ? '연도를 먼저 선택하세요' : filters.eventId ? (filters.eventName || '선택한 행사') + (selected ? '' : ' · 폴더 확인 필요') : '전체 행사';
  document.querySelectorAll('[data-kind]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.kind === filters.kind)));
  $('date').value = filters.date;
  $('dateSummary').textContent = filters.date ? '등록 날짜: ' + filters.date : '등록 날짜로 더 좁히기';
  if (filters.date) $('dateFilters').open = true;
  const path = $('folderPath'); path.replaceChildren();
  const addCrumb = (label, changes) => {
    if (path.childElementCount) path.append(node('span', 'separator', '›'));
    const crumb = node(changes ? 'button' : 'span', '', label);
    if (changes) crumb.addEventListener('click', () => changeFilters(changes));
    path.append(crumb);
  };
  addCrumb('사진 보관함', filters.year || filters.scope ? { year: '', yearId: '', eventId: '', eventName: '', scope: '' } : null);
  if (filters.scope) addCrumb(filters.scope === 'root' ? '루트 폴더 자료' : '저장 위치 지정 필요');
  else if (filters.year) {
    addCrumb(yearNames.get(filters.yearId)?.replace('년', '') || filters.year, filters.eventId ? { eventId: '', eventName: '' } : null);
    addCrumb(filters.eventId ? filters.eventName || '선택한 행사' : '전체 행사');
  } else addCrumb('전체 연도');
  $('folderSearch').placeholder = filters.year ? filters.year + '년 행사명 검색 (예: 소풍)' : '전체 연도에서 행사명 검색 (예: 소풍)';
  $('folderNotice').hidden = !!folders.checkedAt && !folders.error && !folders.refreshing;
  $('folderNotice').textContent = folders.error ? '폴더 목록을 갱신하지 못했습니다. ' + (folders.checkedAt ? '마지막으로 확인한 목록을 표시합니다. ' : '') + '새로고침으로 다시 확인해 주세요.' : folders.refreshing || !folders.checkedAt ? (folders.checkedAt ? '최근 폴더 목록을 표시하고 있습니다. 최신 목록을 확인 중입니다.' : 'Drive 폴더 목록을 불러오는 중입니다. 사진 목록은 먼저 볼 수 있습니다.') : '';
  renderFolderSearch();
}
function renderFolderSearch() {
  const query = $('folderSearch').value.normalize('NFC').trim().toLocaleLowerCase('ko');
  $('folderSearchResults').hidden = !query;
  if (!query) return;
  const matches = [];
  const yearNames = eventLabels(folders.years.map(group => ({ id: group.id, name: group.year })));
  for (const group of folders.years) {
    if (filters.yearId ? group.id !== filters.yearId : filters.year && group.year !== filters.year) continue;
    const labels = eventLabels(group.events);
    for (const event of group.events) if (event.name.normalize('NFC').toLocaleLowerCase('ko').includes(query)) matches.push({ group, event, label: labels.get(event.id) });
  }
  $('folderSearchSummary').textContent = (filters.year ? filters.year + '년' : '전체 연도') + ' · 행사폴더 ' + matches.length + '개';
  const list = $('folderSearchList'); list.replaceChildren();
  for (const { group, event, label } of matches) {
    const button = node('button', 'folder-result'); button.dataset.folderId = event.id;
    button.append(node('span', 'folder-result-path', yearNames.get(group.id) + ' › ' + label),
      node('span', 'folder-count', `사진 ${event.photos}장 · 영상 ${event.videos}개`));
    button.addEventListener('click', () => {
      $('folderSearch').value = '';
      changeFilters({ year: group.year, yearId: group.id, eventId: event.id, eventName: label, scope: '' });
      $('chooseEvent').focus();
    });
    list.append(button);
  }
  if (!matches.length) list.append(node('p', 'event-empty', folders.checkedAt ? '검색한 행사폴더가 없습니다. 연도 선택이나 검색어를 확인해 주세요.' : 'Drive 폴더 목록을 확인한 후 검색할 수 있습니다.'));
}
function renderEvents() {
  const events = selectedYear()?.events || [], labels = eventLabels(events);
  const query = $('eventSearch').value.normalize('NFC').trim().toLocaleLowerCase('ko');
  const list = $('eventList'); list.replaceChildren();
  const option = (id, name, total) => {
    const button = node('button', 'event-option'); button.dataset.eventId = id;
    button.setAttribute('aria-pressed', String(filters.eventId === id));
    button.append(node('span', '', name), node('span', 'folder-count', total + '개'));
    button.addEventListener('click', () => { $('eventDialog').close(); changeFilters({ eventId: id, eventName: id ? name : '' }); });
    list.append(button);
  };
  option('', '전체 행사', selectedYear()?.total || 0);
  const matches = events.filter(event => event.name.normalize('NFC').toLocaleLowerCase('ko').includes(query));
  for (const event of matches) option(event.id, labels.get(event.id), event.total);
  if (!matches.length) list.append(node('p', 'event-empty', query ? '검색한 행사가 없습니다.' : '이 연도에 행사폴더가 없습니다.'));
}
// 서버가 알려 주는 연결 실패 사유 — 사라지는 안내 대신 연결될 때까지 상태 상자에 남긴다.
const failures = {
  invalid_client: '서버에 입력한 Google OAuth 클라이언트 ID 또는 보안 비밀이 Google Cloud의 값과 다릅니다. 서버 변수 GOOGLE_PHOTO_OAUTH_CLIENT_ID, GOOGLE_PHOTO_OAUTH_CLIENT_SECRET을 다시 입력해 주세요.',
  unauthorized_client: '이 OAuth 클라이언트는 서버 연결용으로 쓸 수 없습니다. Google Cloud에서 ‘웹 애플리케이션’ 유형의 클라이언트인지 확인해 주세요.',
  redirect_uri_mismatch: 'Google Cloud에 등록한 리디렉션 주소가 서버 주소와 다릅니다. 승인된 리디렉션 URI와 서버 변수 PUBLIC_BASE_URL을 확인해 주세요.',
  invalid_grant: 'Google 로그인 확인이 만료되었거나 이미 사용되었습니다. Google 계정 연결을 다시 눌러 주세요.',
  invalid_request: 'Google이 연결 요청을 받아들이지 않았습니다. 서버의 Google OAuth 설정을 확인해 주세요.',
  access_denied: 'Google이 이 계정의 연결을 허용하지 않았습니다. 앱 게시 상태와 테스트 사용자 설정을 확인해 주세요.',
  no_refresh_token: 'Google이 자동 보관 권한을 주지 않았습니다. Google 계정의 타사 연결에서 이 앱을 삭제한 뒤 다시 연결해 주세요.',
  google_rejected: 'Google이 연결을 거절했습니다. 서버의 Google OAuth 설정을 확인해 주세요.',
  network: '서버가 Google에 접속하지 못했습니다. 잠시 후 다시 연결해 주세요.'
};
const labels = { saved: '드라이브 보관 완료', pending: '서버 보관 · 드라이브 전송 대기', awaiting_target: '원본 접수 완료 · 저장 위치 지정 필요', error: '서버 보관 · 전송 재시도 중', deleting: '삭제 처리 중' };
const dates = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}
async function api(url, options) {
  const res = await fetch(url, { cache: 'no-store', ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || '요청에 실패했습니다. 연결 상태를 확인해 주세요.');
  return body;
}
function node(tag, className, text) {
  const el = document.createElement(tag); if (className) el.className = className;
  if (text !== undefined) el.textContent = text; return el;
}
function renderStatus(status) {
  $('connection').classList.toggle('warn', !status.ready || status.counts.error > 0);
  $('connectionTitle').textContent = status.ready ? 'Google 드라이브 자동 보관' : 'Google 드라이브 연결이 필요합니다';
  const waiting = status.counts.pending + status.counts.error;
  $('connectionText').textContent = (status.error || `${status.folderName || '지정 폴더'} · 보관 완료 ${status.counts.saved}장${waiting ? ' · 전송 대기 ' + waiting + '장' : ''}`) + (status.counts.awaiting_target ? ' · 저장 위치 지정 필요 ' + status.counts.awaiting_target + '장' : '');
  if (connectionFailure && !status.ready) $('connectionText').textContent = '계정 연결 실패 — ' + connectionFailure;
  if (!status.ready && !status.oauthConfigured) $('connectionText').textContent += ' 개인 드라이브를 사용하려면 서버 관리자가 Google 계정 연결 설정을 먼저 완료해야 합니다.';
  $('connectionText').textContent += ' 이 연결은 교회 공용 서버 연결입니다. 관리자가 한 번 연결하면 촬영자는 Google 로그인 없이 이용합니다.';
  $('driveLink').href = 'https://drive.google.com/drive/folders/' + encodeURIComponent(status.folderId);
  $('connect').hidden = !status.oauthConfigured || (status.ready && status.authMode === 'service-account');
  $('connect').textContent = status.ready && status.authMode === 'oauth' ? '교회 보관 계정 변경' : '교회 보관 계정 연결 · 관리자 전용';
}
async function pngForClipboard(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('사진을 불러올 수 없습니다.');
  const blob = await response.blob();
  const src = URL.createObjectURL(blob);
  try {
    const img = new Image(); img.src = src; await img.decode();
    const scale = Math.min(1, 3840 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('사진 복사 준비에 실패했습니다.')), 'image/png'));
  } finally { URL.revokeObjectURL(src); }
}
function card(photo) {
  const wrap = node('article', 'card');
  const image = photo.status === 'deleting' ? node('div', 'preview') : node(photo.video ? 'video' : 'img', 'preview');
  if (photo.video && photo.status !== 'deleting') { image.controls = true; image.preload = 'none'; image.playsInline = true; image.style.cursor = 'auto'; }
  if (photo.status !== 'deleting') image.src = photo.url;
  image.alt = photo.message || '보관 사진'; image.loading = 'lazy'; image.decoding = 'async';
  if (!photo.video) image.addEventListener('click', () => { $('previewImage').src = photo.url; $('preview').showModal(); });
  image.addEventListener('error', () => { image.alt = '사진을 불러오지 못했습니다. 연결 후 새로고침해 주세요.'; });
  const details = node('div', 'details');
  details.append(node('p', 'caption', photo.message || '문구 없음'), node('div', 'meta', dates.format(new Date(photo.ts))), node('div', 'meta', photo.siteName || '드라이브 사진'));
  if (photo.eventName) details.append(node('div', 'meta', photo.year + ' / ' + photo.eventName));
  if (photo.uploaderName) details.append(node('div', 'meta', '업로더: ' + photo.uploaderName));
  if (photo.capturedAt) details.append(node('div', 'meta', '사진 날짜: ' + dates.format(new Date(photo.capturedAt))));
  details.append(node('span', 'badge ' + photo.status, labels[photo.status] || photo.status));
  if (photo.error) details.append(node('p', 'error-note', photo.error));
  const actions = node('div', 'actions');
  if (photo.status !== 'deleting') {
    const download = node('a', 'button', '다운로드'); download.href = photo.url + '?download=1'; download.download = photo.name;
    const copy = node('button', '', '사진 복사');
    copy.addEventListener('click', () => {
      if (!window.isSecureContext || !navigator.clipboard?.write || !window.ClipboardItem) {
        toast('이 브라우저에서는 사진 복사를 지원하지 않습니다. 다운로드를 이용해 주세요.'); return;
      }
      copy.disabled = true;
      // Start write inside the click, passing a promise so Safari keeps user activation.
      const png = pngForClipboard(photo.url);
      png.catch(() => {});
      try {
        navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
          .then(() => toast('사진을 복사했습니다. 원하는 앱에서 붙여넣기 하세요.'))
          .catch(() => toast('사진 복사가 허용되지 않았습니다. 브라우저 권한을 확인하거나 다운로드를 이용해 주세요.'))
          .finally(() => { copy.disabled = false; });
      } catch { copy.disabled = false; toast('이 브라우저에서는 사진 복사를 지원하지 않습니다.'); }
    });
    actions.append(download);
    if (!photo.video) actions.append(copy);
    if (photo.message) {
      const text = node('button', '', '문구 복사');
      text.addEventListener('click', () => {
        if (!navigator.clipboard?.writeText) return toast('이 브라우저는 복사를 지원하지 않습니다.');
        navigator.clipboard.writeText(photo.message).then(() => toast('문구를 복사했습니다.')).catch(() => toast('문구 복사가 허용되지 않았습니다.'));
      });
      actions.append(text);
    }
    const remove = node('button', 'danger', '삭제');
    remove.addEventListener('click', async () => {
      if (!confirm('이 사진을 보관함과 모니터에서 삭제할까요?\n드라이브에 저장된 파일은 휴지통으로 이동합니다.')) return;
      remove.disabled = true;
      try { await api('/api/photos/' + encodeURIComponent(photo.id), { method: 'DELETE' }); toast('삭제를 요청했습니다. 드라이브 처리 상태가 곧 갱신됩니다.'); await load(); }
      catch (e) { toast(e.message); remove.disabled = false; }
    });
    actions.append(remove);
  }
  details.append(actions); wrap.append(image, details); return wrap;
}
async function load() {
  const seq = ++requestSequence;
  try {
    $('grid').setAttribute('aria-busy', 'true');
    const selection = folderSelectionKey();
    const data = await api('/api/photos?' + new URLSearchParams({ date: filters.date, year: filters.year, yearId: filters.yearId, eventId: filters.eventId, scope: filters.scope, kind: filters.kind, offset }));
    if (seq !== requestSequence) return;
    if (offset && offset >= data.total) { offset = Math.max(0, Math.floor((data.total - 1) / 40) * 40); return load(); }
    renderStatus(data.status);
    acceptFolders(data.folders); reconcileFolderSelection(); renderFolderFilters();
    if (selection !== folderSelectionKey()) { offset = 0; rememberFilters(); return load(); }
    $('listError').hidden = true;
    const signature = JSON.stringify([data.photos, filters, offset]);
    if (signature !== lastGridSignature) {
      $('grid').replaceChildren(...data.photos.map(card));
      if (!data.photos.length) $('grid').append(node('div', 'empty', Object.values(filters).some(Boolean) ? '선택한 조건에 맞는 자료가 없습니다. 행사·종류·등록 날짜 필터를 확인해 주세요.' : '아직 보관된 자료가 없습니다. 휴대폰에서 올린 사진과 영상이 여기에 나타납니다.'));
      lastGridSignature = signature;
    }
    $('count').textContent = `사진 ${data.counts.photos}장 · 영상 ${data.counts.videos}개`;
    $('page').textContent = `${Math.floor(offset / 40) + 1} / ${Math.max(1, Math.ceil(data.total / 40))}`;
    $('prev').disabled = offset === 0; $('next').disabled = offset + 40 >= data.total;
  } catch (e) { if (seq === requestSequence) { $('listError').textContent = '목록을 불러오지 못했습니다. ' + e.message; $('listError').hidden = false; } }
  finally { if (seq === requestSequence) $('grid').setAttribute('aria-busy', 'false'); }
}
$('year').addEventListener('change', () => {
  const value = $('year').value;
  const group = folders.years.find(group => group.id === value);
  changeFilters({ year: group?.year || (value.startsWith('__year_') ? value.slice(7) : ''), yearId: group?.id || '', scope: value === '__root__' ? 'root' : value === '__awaiting__' ? 'awaiting_target' : '', eventId: '', eventName: '' });
});
$('folderSearch').addEventListener('input', renderFolderSearch);
$('clearFolderSearch').addEventListener('click', () => { $('folderSearch').value = ''; renderFolderSearch(); $('folderSearch').focus(); });
$('chooseEvent').addEventListener('click', () => {
  $('eventDialogTitle').textContent = filters.year + '년 행사 선택';
  $('eventSearch').value = ''; renderEvents(); $('eventDialog').showModal(); $('eventSearch').focus();
});
$('closeEvents').addEventListener('click', () => $('eventDialog').close());
$('eventSearch').addEventListener('input', renderEvents);
document.querySelectorAll('[data-kind]').forEach(button => button.addEventListener('click', () => changeFilters({ kind: button.dataset.kind })));
$('resetFilters').addEventListener('click', () => { $('dateFilters').open = false; $('folderSearch').value = ''; changeFilters(emptyFilters()); });
$('date').addEventListener('change', () => changeFilters({ date: $('date').value }));
$('all').addEventListener('click', () => changeFilters({ date: '' }));
$('prev').addEventListener('click', () => { offset = Math.max(0, offset - 40); load(); });
$('next').addEventListener('click', () => { offset += 40; load(); });
$('refresh').addEventListener('click', async () => {
  lastGridSignature = '';
  loadFolders(true);
  try { await api('/api/photos/sync', { method: 'POST' }); await load(); toast('드라이브와 동기화 중입니다. 완료되면 목록이 갱신됩니다.'); } catch (e) { toast(e.message); }
});
$('closePreview').addEventListener('click', () => $('preview').close());
const connection = new URLSearchParams(location.search).get('connection');
if (connection === 'select-folder') {
  $('folderSelection').hidden = false;
  toast('사진 보관 폴더를 선택해 연결을 마무리해 주세요.');
} else if (connection) {
  if (connection === 'failed') connectionFailure = failures[new URLSearchParams(location.search).get('reason')] || '자동 보관 권한과 Google 연결 설정을 확인해 주세요.';
  toast(({ success: 'Google 계정 연결 완료. 대기 사진을 자동 보관합니다.', cancelled: 'Google 계정 연결을 취소했습니다.', failed: '계정 연결에 실패했습니다. 자동 보관 권한과 Google 연결 설정을 확인해 주세요.', 'scope-required': '연도·행사 폴더 보관 권한으로 Google 계정을 다시 연결해 주세요.' })[connection] || '');
  history.replaceState(null, '', '/photos');
}
renderFolderFilters(); load(); loadFolders();
setInterval(() => { if (!document.hidden && !$('preview').open && !$('eventDialog').open && !document.querySelector('.actions button:disabled')) { load(); loadFolders(); } }, 15000);
