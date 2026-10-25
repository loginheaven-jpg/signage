'use strict';
const el = id => document.getElementById(id);
const labels = { archive: '보관만 하기', live: '화면에만 올리기', both: '화면에 올리고 원본도 보관' };
const archiveLabels = { saved: 'Drive 보관 완료', awaiting_original: '원본 전송 필요', awaiting_target: '원본 접수 완료 · 저장 위치 지정 필요', pending: '원본 접수 완료 · Drive 보관 대기', error: '원본 접수 완료 · Drive 재시도 대기', deleting: '삭제 처리 중', deleted: '삭제 완료', missing: 'Drive에서 사진을 찾을 수 없음' };
const kst = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' });
let config, settings, mode = 'both', selected = [], events = [], foldersReady = false, busy = false, folderSequence = 0;
let currentPage = 'purpose', navigation = { camera: true, page: 'purpose', depth: 0 }, siteSequence = 0, sitesReady = false;
let draftDb, draftChain = Promise.resolve(), storedFiles = new Set();
const DRAFT_BUDGET = 300 * 1024 * 1024;   // 교회폴더 저장 대기 사진을 기기에 복사해 두는 한도
const REVIEW_PAGE = 40, ARCHIVE_PARALLEL = 3;
const BACKGROUND_MIN = 10;   // 이보다 적은 사진은 화면에서 바로 올린다
let reviewShown = REVIEW_PAGE, wakeLock = null, wakeLockPending = false, backgroundActive = false;
let cameraStream;
let workStage='capture',lastCompletion=null,registrationSending=false;
const cameraDialogs=['folderDialog','siteDialog','cameraDialog','beautyDialog','moreDialog','registrationDialog','locationDialog','optionsDialog','shareDialog','statusDialog'];
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
function notice(text, error = false, context = '') { el('notice').textContent = text; el('notice').classList.toggle('error', error); el('notice').hidden = !text; el('notice').dataset.context = context; }
function node(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
function option(value, text) { const n = node('option', text); n.value = value; return n; }
function homeSummary() {
  if (!selected.length && el('notice').dataset.context === 'draft') notice('');
  el('resume').hidden = currentPage !== 'work' || workStage!=='capture' || (!selected.length&&!originals.length);
  if (settings) el('resumeSummary').textContent = destination(settings);
  el('draftCount').textContent = selected.length ? (hasFrozen() ? '등록 확인이 필요한 사진 ' : '아직 올리지 않은 사진 ') + selected.length + '장' : originals.length ? '등록한 사진의 원본 전송 ' + originals.length + '장' : '';
  el('resumeHint').textContent = selected.length ? (hasFrozen() ? '등록 상태를 확인하거나 다시 시도하세요' : '확인하고 올리거나 삭제하세요') : '원본 전송 상태를 확인하세요';
  el('resumeAction').textContent=selected.length?'사진 보기 ›':'상태 보기 ›';
  el('continueResume').disabled=busy;
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
  renderFlow();
}
function goHome() {
  if (busy) return notice('사진을 접수하고 있습니다. 전송이 끝나면 홈으로 이동할 수 있습니다.');
  workStage='capture';persistDraft();
  if (navigation.depth) history.go(-navigation.depth);
  else showWork(false);
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
  const next = event.state?.camera ? event.state : { camera: true, page: 'work', depth: 0 };
  navigation = next;
  for (const id of cameraDialogs) if (el(id).open && next.dialog !== id) el(id).close();
  if (next.page === 'work' && settings) showWork(false);
  else if (next.page === 'setup' && currentPage !== 'setup') openSetup(next.mode || mode, false);
  else view(next.page === 'work' ? 'purpose' : next.page, false);
  if (next.dialog && !el(next.dialog).open) el(next.dialog).showModal();
});
for (const id of cameraDialogs) {
  el(id).addEventListener('cancel', event => { event.preventDefault(); closeDialog(id); });
}
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, '0')).join(''); }
async function api(route, options = {}) {
  const params = new URLSearchParams(location.search);
  const legacyToken = params.get('t') || storage.get('token');
  if (params.get('t')) storage.set('token', params.get('t'));
  const { timeoutMs = route === 'photo' || route.endsWith('/original') ? 90000 : 15000, signal: externalSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  let timer, rejectDeadline;
  const deadline = new Promise((resolve, reject) => { rejectDeadline = reject; });
  // Aborting fetch alone is insufficient if a browser or response-body reader
  // never settles. The UI must finish even when that transport ignores abort.
  timer = setTimeout(() => {
    rejectDeadline(Object.assign(new Error('응답 시간이 초과되었습니다. 같은 요청으로 다시 시도해 주세요.'), { status: 504 }));
    controller.abort();
  }, timeoutMs);
  const abortExternal = () => { rejectDeadline(Object.assign(new Error('원본 전송을 잠시 멈췄습니다.'), { paused: true })); controller.abort(); };
  externalSignal?.addEventListener('abort', abortExternal, { once: true });
  if (externalSignal?.aborted) abortExternal();
  try {
    return await Promise.race([(async () => {
      const res = await fetch('/live/api/camera/' + route, { cache: 'no-store', ...fetchOptions, signal: controller.signal, headers: { ...(legacyToken ? { 'x-live-token': legacyToken } : {}), ...options.headers } });
      const data = await res.json().catch(error => { if (controller.signal.aborted) throw error; return {}; });
      if (controller.signal.aborted) throw Object.assign(new Error('응답 시간이 초과되었습니다. 같은 요청으로 다시 시도해 주세요.'), { status: 504 });
      if (res.status === 401) { location.replace('/login?role=camera'); throw new Error('다시 로그인해 주세요.'); }
      if (!res.ok) throw Object.assign(new Error(data.error || '연결을 확인하고 다시 시도해 주세요.'), { status: res.status, backlog: !!data.backlog });
      return data;
    })(), deadline]);
  } catch (error) {
    if (externalSignal?.aborted) throw Object.assign(new Error('원본 전송을 잠시 멈췄습니다.'), { paused: true });
    if (controller.signal.aborted) throw Object.assign(new Error('응답 시간이 초과되었습니다. 같은 요청으로 다시 시도해 주세요.'), { status: 504 });
    throw error;
  } finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', abortExternal); }
}
function destination(s) {
  const lines = [labels[s.mode], '등록자: ' + (s.uploaderName||'첫 등록 때 입력')];
  if (s.target) lines.push('보관: ' + s.target.year + ' / ' + (s.target.folderName || s.target.eventName));
  else if (s.mode === 'both') lines.push('보관: 저장 위치는 표출 후 지정할 수 있습니다.');
  if (s.mode !== 'archive') lines.push('표출: ' + s.siteName);
  return lines.join('\n');
}
// 대기 목록은 설정·순서(drafts)와 사진 파일(files)을 따로 둔다. 사진을 한 장 보낼 때마다
// 남은 사진 전체를 다시 쓰지 않도록, 파일은 새로 생기거나 없어진 것만 넣고 뺀다.
async function openDb() {
  if (draftDb) return draftDb;
  draftDb = await new Promise((resolve, reject) => {
    const request = indexedDB.open('yebom-camera-drafts', 2);
    request.onupgradeneeded = () => {
      for (const name of ['drafts', 'files']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  return draftDb;
}
const settle = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const isArchiveEntry = r => (r.submission?.mode || mode) === 'archive';
// 여러 전송이 동시에 끝나도 저장은 한 번에 하나씩 순서대로 한다.
function persistDraft() { const run = draftChain.then(writeDraft); draftChain = run; return run; }
async function writeDraft() {
  try {
    const db = await openDb();
    const files = new Map(), entries = [];
    // 교회폴더 저장은 수백 장을 고를 수 있어 기기에 복사해 두는 양을 제한한다. 넘는 사진은 화면이
    // 꺼지면 다시 골라야 하지만, 이미 접수한 사진은 서버가 알아보고 다시 올리지 않는다.
    let archiveBytes = 0;
    for (const r of selected) if (r.kind !== 'video' && isArchiveEntry(r) && storedFiles.has(r.key)) archiveBytes += r.file.size + (r.beautyFile?.size || 0) + (r.aiFile?.size || 0);
    for (const r of selected) {
      if (r.kind === 'video') continue;
      const entryBytes = r.file.size + (r.beautyFile?.size || 0) + (r.aiFile?.size || 0);
      const keep = storedFiles.has(r.key) || !isArchiveEntry(r) || archiveBytes + entryBytes <= DRAFT_BUDGET;
      if (keep && isArchiveEntry(r) && !storedFiles.has(r.key)) archiveBytes += entryBytes;
      if (keep) { files.set(r.key, r.file); if (r.previewFile) files.set(r.key + ':p', r.previewFile); if (r.beautyFile) files.set(r.key + ':b', r.beautyFile); if(r.aiFile)files.set(r.key+':a',r.aiFile); if (r.thumb) files.set(r.key + ':t', r.thumb); }
      const { url, file, previewFile, beautyFile, aiFile, thumb, ...lean } = r; entries.push(lean);
    }
    for (const p of originals) files.set(p.key, p.file);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['drafts', 'files'], 'readwrite'), store = tx.objectStore('files');
      for (const [key, blob] of files) if (!storedFiles.has(key) || key.endsWith(':b') || key.endsWith(':a') || key.endsWith(':t')) store.put(blob, key);
      for (const key of storedFiles) if (!files.has(key)) store.delete(key);
      tx.objectStore('drafts').put({ version: 2, settings, entries, originals: originals.map(({ file, ...p }) => p), message: el('message').value, keepMessage: el('keepMessage').checked, shareBatch }, 'current');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    storedFiles = new Set(files.keys());
    return true;
  } catch { notice('이 기기에 사진 대기 목록을 저장하지 못했습니다. 전송을 마칠 때까지 화면을 닫지 마세요.', true); return false; }
}
async function readDraft() {
  try {
    const db = await openDb();
    const draft = await settle(db.transaction('drafts').objectStore('drafts').get('current'));
    if (!draft) return null;
    if (draft.version !== 2) {   // 이전 형식: 사진이 목록 안에 들어 있다. 다음 저장 때 새 형식으로 옮긴다.
      for (const r of draft.entries || []) r.key = r.requestId;
      for (const p of draft.originals || []) p.key = 'o:' + p.id;
      return draft;
    }
    const store = db.transaction('files').objectStore('files');
    storedFiles = new Set(await settle(store.getAllKeys()));
    const total = draft.entries.length;
    for (const r of draft.entries) if (storedFiles.has(r.key)) { r.file = await settle(store.get(r.key)); if (storedFiles.has(r.key + ':p')) r.previewFile = await settle(store.get(r.key + ':p')); if (storedFiles.has(r.key + ':b')) r.beautyFile = await settle(store.get(r.key + ':b')); if(storedFiles.has(r.key+':a'))r.aiFile=await settle(store.get(r.key+':a')); if (storedFiles.has(r.key + ':t')) r.thumb = await settle(store.get(r.key + ':t')); }
    for (const p of draft.originals) if (storedFiles.has(p.key)) p.file = await settle(store.get(p.key));
    draft.entries = draft.entries.filter(r => r.file); draft.originals = draft.originals.filter(p => p.file);
    draft.lost = total - draft.entries.length;
    return draft;
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
// 원본을 통째로 풀지 않고 긴 변 maxEdge 로 줄여 복호화한다(12MP 48MB, 50MP 200MB 순간 사용을 피함). 캔버스는 쓰고 바로 비운다.
async function sharingFile(file, id, maxEdge = 3840, quality = 0.9) {
  let image;
  try { image = await createImageBitmap(file, await window.CameraBeauty.bitmapOptions(file, maxEdge)); }
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
    canvas.width = canvas.height = 0;
    if (!blob) throw new Error('share conversion');
    return new File([blob], 'photo_' + id.slice(-12) + '.jpg', { type: 'image/jpeg' });
  } finally { image.close?.(); if (image instanceof HTMLImageElement) image.removeAttribute('src'); }
}
// 검토 목록용 작은 미리보기(긴 변 800px). 원본 대신 이것을 화면에 올려 사진이 쌓여도 메모리가 늘지 않게 한다.
async function makeThumb(file) {
  try { return await sharingFile(file, 'thumb', 800, 0.8); } catch { return null; }
}
// 미리보기 화면을 떠날 때(촬영·사진 추가·폰 카메라 앱 열기) 이미지 요소와 표시용 URL을 모두 거둔다.
function releaseReviewMedia() {
  for (const r of selected) if (r.url) { URL.revokeObjectURL(r.url); r.url = ''; }
  el('selectedPhotos').replaceChildren();
}
// 공유용 축소본은 기기 저장소에도 있으므로 메모리 사본을 저장소의 것으로 바꿔 둔다(공유창에서 읽을 때 디스크에서 온다).
async function offloadShareBatch() {
  if (!shareBatch?.photos.length) return;
  try {
    const db = await openDb(), stored = await settle(db.transaction('drafts').objectStore('drafts').get('current'));
    if (stored?.shareBatch?.key !== shareBatch.key) return;
    for (const photo of shareBatch.photos) { const saved = stored.shareBatch.photos.find(p => p.id === photo.id); if (saved?.file && saved.file.size === photo.file.size) photo.file = saved.file; }
  } catch {}
}
let beautyEntry = null, beautyPrepared = null, beautyLevel = 0, beautyEpoch = 0, beautyProcessing = false, beautyComparing = false;
let beautyRenderFrame = 0, beautyBase = null, beautyTab = 'skin', beautyEffects = { color: 'none', frame: 'none' };
let beautyComposition = null, beautyCompositionKey = '', beautyAbort = null;
let beautyFrameRenderTimer = null;
let beautyAIFile = null, beautyAIKind = '';
const beautyWarmup = new window.CameraBeautyWarmup();
const WARM_STREAK_LIMIT = 2;   // 뽀샤시를 열지 않은 연속 촬영이 이만큼 되면 미리 준비를 쉰다
let beautySkinJob = null;
let beautyWarmCandidate = null;
function resumeCapturedWarmup() {
  if (document.hidden || !beautyWarmCandidate) return;
  const { entry, at } = beautyWarmCandidate; beautyWarmCandidate = null;
  if (Date.now() - at < 60000 && currentPage === 'work' && workStage === 'review' && selected.at(-1) === entry && !busy && !beautyEntry && typeof Worker === 'function' && typeof OffscreenCanvas === 'function') beautyWarmup.start(entry.file);
}
const beautyStageText = { loading: '뽀샤시 준비 중…', face: '얼굴을 살펴보는 중…', skin: '피부를 살펴보는 중…', finishing: '거의 다 됐어요…' };
function watchBeautySkin(job, epoch) {
  job.subscribe(() => { if (epoch === beautyEpoch && job === beautySkinJob) renderBeauty(); });
  job.ready.then(prepared => {
    if (epoch !== beautyEpoch || job !== beautySkinJob) return;
    if (prepared) { beautyPrepared = prepared; releaseBeautyComposition(); }
    else if (job.error && beautyLevel) {
      beautyLevel = 0;
      el('beautyState').textContent = job.error.message?.includes('얼굴을 찾지') ? job.error.message : '뽀샤시를 준비하지 못했어요. 다시 조절하거나 원본으로 진행해 주세요.';
    }
    renderBeauty();
  });
}
function beginBeautySkin(retry = false) {
  if (!beautyEntry || !beautyBase || beautyPrepared || (beautySkinJob && (!retry || !beautySkinJob.error))) return;
  // 실패한 작업이 참조하던 사진 Canvas는 현재 편집창에서 계속 사용한다.
  if (beautySkinJob) { beautySkinJob.canvas = null; beautySkinJob.dispose(); }
  beautySkinJob = beautyWarmup.create(beautyAIFile || beautyEntry.file, beautyBase);
  beautyAbort = beautySkinJob.controller; watchBeautySkin(beautySkinJob, beautyEpoch); renderBeauty();
}
const aiEditor = new window.CameraAIEditor({
  api,
  async getBlob(url,signal){
    const token=new URLSearchParams(location.search).get('t')||storage.get('token');
    const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,20000);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try{const response=await fetch(url,{cache:'no-store',signal:controller.signal,headers:token?{'x-live-token':token}:{}});
      if(!response.ok)throw new Error('AI 결과를 불러오지 못했습니다. 기존 사진은 유지됩니다.');
      return await response.blob();
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  },
  getInput:()=>window.CameraBeauty.exportPhoto(el('beautyOriginal'),beautyEntry.file),
  async onResult(file,kind,isCurrent){await replaceBeautySource(file,kind,isCurrent);},
  async onDiscard(){
    if(!beautyEntry||beautyProcessing||aiEditor.busy)return;
    const epoch=beautyEpoch;beautyProcessing=true;renderBeauty();
    try{await replaceBeautySource(null,'',()=>epoch===beautyEpoch);el('aiState').textContent='AI 효과를 제거했습니다. 색감·프레임·꾸미기는 유지됩니다.';}
    catch{if(epoch===beautyEpoch)el('aiState').textContent='사진을 준비하지 못했습니다. 다시 시도해 주세요.';}
    finally{if(epoch===beautyEpoch){beautyProcessing=false;renderBeauty();}}
  },
  onFrame(id){if(!beautyEntry)return;beautyEffects.event ||= {title:'함께한 오늘',date:localDate(Date.now()).slice(0,10)};if(id)beautyEffects.event.templateId=id;else delete beautyEffects.event.templateId;beautyEffects.frame='event';beautyComparing=false;releaseBeautyComposition();},
  onRefresh(){if(beautyEntry)renderBeauty();}
});
async function replaceBeautySource(file,kind,isCurrent){
  const canvas=await window.CameraBeauty.decode(file||beautyEntry.file);
  if(!isCurrent()){canvas.width=canvas.height=1;return;}
  beautySkinJob?.dispose();beautySkinJob=null;
  releaseBeautyComposition();if(beautyBase)beautyBase.width=beautyBase.height=1;
  beautyPrepared=null;window.CameraBeauty.releaseDetector();beautyBase=canvas;
  beautyAIFile=file;beautyAIKind=kind;beautyLevel=0;beautyComparing=false;
}
const decorationEditor = new window.CameraDecorationEditor({
  canvas:el('decorationOverlay'),
  onChange(items,baseNeeded){beautyEffects.decorations=items;beautyComparing=false;if(baseNeeded)scheduleBeautyRender();},
  onMessage(text){el('beautyState').textContent=text;}
});
function releaseBeautyComposition() {
  if(beautyComposition)beautyComposition.width=beautyComposition.height=1;
  beautyComposition=null;beautyCompositionKey='';
}
function hasPhotoEffects() { return !!beautyAIFile || beautyLevel > 0 || beautyEffects.color !== 'none' || beautyEffects.frame !== 'none' || !!beautyEffects.decorations?.length; }
function renderedBeauty() {
  const key=JSON.stringify([beautyLevel,beautyEffects.color,beautyEffects.frame,beautyEffects.frame==='event'?beautyEffects.event:null]);
  if(beautyComposition&&beautyCompositionKey===key)return beautyComposition;
  releaseBeautyComposition();
  const base = beautyPrepared ? window.CameraBeauty.paint(beautyPrepared, beautyLevel) : beautyBase;
  if(!base)return null;
  beautyComposition=window.CameraBeauty.compose(base,{...beautyEffects,decorations:[],frameImage:aiEditor.frameId===beautyEffects.event?.templateId?aiEditor.frameImage:null});beautyCompositionKey=key;
  return beautyComposition;
}
async function exportEditorPhoto() {
  const canvas=renderedBeauty();
  const items=window.CameraBeauty.normalizeEffects(beautyEffects).decorations;
  if(items?.length)window.CameraBeauty.drawDecorations(canvas.getContext('2d'),items,{x:0,y:0,width:canvas.width,height:canvas.height});
  try{return await window.CameraBeauty.exportPhoto(canvas,beautyEntry.file);}
  finally{if(items?.length)releaseBeautyComposition();}
}
function savedBeautyStrength(entry) { return entry.beautyScale === 100 ? entry.beautyLevel : ({ 1: 35, 2: 70 }[entry.beautyLevel] || 0); }
function scheduleBeautyRender() {
  if (!beautyRenderFrame) beautyRenderFrame = requestAnimationFrame(renderBeauty);
}
function renderBeauty() {
  cancelAnimationFrame(beautyRenderFrame); beautyRenderFrame = 0;
  const locked=beautyProcessing||aiEditor.busy||aiEditor.loadingFrame;
  for (const tab of document.querySelectorAll('[data-photo-tab]')) {
    const active = tab.dataset.photoTab === beautyTab;
    tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    el(tab.getAttribute('aria-controls')).hidden = !active;
  }
  for (const key of ['color', 'frame']) for (const button of document.querySelectorAll('[data-photo-' + key + ']')) {
    button.setAttribute('aria-pressed', String(button.dataset[key === 'color' ? 'photoColor' : 'photoFrame'] === beautyEffects[key])); button.disabled = locked;
  }
  el('eventFrameFields').hidden=beautyEffects.frame!=='event';
  for(const [id,key] of [['frameEventTitle','title'],['frameEventDate','date']]){
    el(id).disabled=locked;
    if(document.activeElement!==el(id))el(id).value=beautyEffects.event?.[key]||'';
  }
  el('applyBeauty').disabled = locked || !beautyEntry || (beautyLevel > 0 && !beautyPrepared) || (hasPhotoEffects() && !beautyPrepared && !beautyBase) || (beautyEffects.frame==='event'&&!!beautyEffects.event?.templateId&&aiEditor.frameId!==beautyEffects.event.templateId);
  el('beautyStrength').disabled = locked || !beautyEntry;
  el('beautyStrength').value = beautyLevel;
  el('beautyStrength').setAttribute('aria-valuetext', beautyLevel ? '뽀샤시 ' + beautyLevel + '%' : '뽀샤시 없음');
  el('beautyStrengthValue').textContent = beautyLevel;
  const preparing = beautySkinJob && !beautySkinJob.prepared && !beautySkinJob.error && !beautySkinJob.controller.signal.aborted;
  el('beautyProgress').hidden = !preparing;
  el('beautyProgressText').textContent = beautyStageText[beautySkinJob?.stage] || '뽀샤시 준비 중…';
  el('beautyProgress').setAttribute('aria-busy', String(!!preparing));
  if (!beautyProcessing && beautySkinJob && !beautySkinJob.error) el('beautyState').textContent = preparing
    ? '강도를 미리 골라도 돼요. 준비되면 바로 적용돼요.'
    : beautyLevel ? '뽀샤시 ' + beautyLevel : '뽀샤시 준비 완료 · 강도를 골라 보세요.';
  el('compareBeauty').disabled = beautyProcessing || !hasPhotoEffects();
  el('compareBeauty').setAttribute('aria-pressed', String(beautyComparing));
  el('compareBeauty').textContent = beautyComparing ? '효과 보기' : '원본 비교';
  const showCorrection = !!(beautyPrepared || beautyBase) && hasPhotoEffects() && !beautyComparing;
  el('beautyOriginal').hidden = showCorrection; el('beautyCanvas').hidden = !showCorrection;
  if (showCorrection) {
    const canvas = renderedBeauty(), preview = el('beautyCanvas');
    if(preview.width!==canvas.width)preview.width=canvas.width;
    if(preview.height!==canvas.height)preview.height=canvas.height;
    preview.getContext('2d').clearRect(0,0,preview.width,preview.height);preview.getContext('2d').drawImage(canvas, 0, 0);
  }
  decorationEditor.refresh({visible:!!beautyEffects.decorations?.length&&!beautyComparing&&showCorrection,active:beautyTab==='decorate'&&!locked&&!beautyComparing&&!!beautyBase,image:beautyComposition||beautyBase});
  aiEditor.refresh({locked:beautyProcessing,photoReady:!!beautyBase,applied:!!beautyAIFile});
}
function openBeauty(entry) {
  if (busy || entry.submission || entry.kind === 'video') return;
  beautySkinJob?.dispose();
  beautyEpoch++; beautyEntry = entry; beautyPrepared = null; beautyLevel = savedBeautyStrength(entry); beautyProcessing = false; beautyComparing = false;
  releaseBeautyComposition();const epoch=beautyEpoch;
  beautyBase = null; beautyTab = 'skin';
  beautyAIFile=entry.aiFile||null;beautyAIKind=entry.aiKind||'';
  storage.set('warmStreak', 0);   // 뽀샤시를 썼으니 다음 촬영부터 다시 미리 준비한다
  beautySkinJob = beautyWarmup.take(beautyAIFile || entry.file);
  if (beautySkinJob) { beautyAbort = beautySkinJob.controller; watchBeautySkin(beautySkinJob, epoch); }
  const effects=window.CameraBeauty.normalizeEffects(entry.photoEffects);
  beautyEffects={...effects,event:effects.event||{title:(settings?.target?.eventName||settings?.target?.folderName||'').replace(/^\d{4}[-.]?\d{2}[-.]?\d{2}[\s_-]*/,'').slice(0,32)||'함께한 오늘',date:/^\d{4}-\d{2}-\d{2}/.test(entry.date||'')?entry.date.slice(0,10):localDate(Date.now()).slice(0,10)}};
  beautyEffects.decorations=decorationEditor.reset(effects.decorations);
  el('beautyState').textContent = '강도 0은 뽀샤시 없음 · 색감과 프레임을 함께 적용할 수 있습니다.';
  el('beautyDestination').textContent = mode === 'both' ? '꾸민 사진을 모니터에 표출하고, 원본은 교회폴더에 보관합니다.' : mode === 'archive' ? '효과를 적용하면 꾸민 사진을 교회폴더에 저장합니다.' : '꾸민 사진을 모니터에 표출합니다.';
  renderBeauty(); openDialog('beautyDialog');
  aiEditor.open(beautyEffects.event?.templateId||'');
  loadBeautyBase().then(()=>{if(epoch===beautyEpoch&&beautyBase)beginBeautySkin();});
}
async function loadBeautyBase() {
  if (beautyProcessing || !beautyEntry || beautyPrepared || beautyBase) return;
  const epoch = beautyEpoch, file = beautyAIFile||beautyEntry.file, originalFile=beautyEntry.file;
  beautyProcessing = true; el('beautyState').textContent = '사진을 준비하고 있습니다…'; renderBeauty();
  try {
    const canvas = beautySkinJob ? await beautySkinJob.base : await window.CameraBeauty.decode(file);
    if (epoch !== beautyEpoch){canvas.width=canvas.height=1;return;}
    beautyBase = canvas;
    const originalCanvas=beautyAIFile?await window.CameraBeauty.decode(originalFile):canvas;
    if(epoch!==beautyEpoch){if(originalCanvas!==canvas)originalCanvas.width=originalCanvas.height=1;return;}
    const original=el('beautyOriginal');original.width=originalCanvas.width;original.height=originalCanvas.height;
    if (!beautyAIFile && beautyPrepared) original.getContext('2d').putImageData(beautyPrepared.source,0,0);
    else original.getContext('2d').drawImage(originalCanvas,0,0);
    if(originalCanvas!==canvas)originalCanvas.width=originalCanvas.height=1;
    el('beautyState').textContent = '효과를 함께 고른 뒤 원본과 비교해 보세요.';
  } catch {
    if (epoch !== beautyEpoch) return;
    beautyEffects = { color: 'none', frame: 'none' };
    el('beautyState').textContent = '이 사진은 꾸미기를 지원하지 않습니다. 원본으로 진행해 주세요.';
  } finally { if (epoch === beautyEpoch) { beautyProcessing = false; renderBeauty(); } }
}
async function chooseBeauty(level) {
  if (!beautyEntry || beautyProcessing || aiEditor.busy) return;
  level = Math.max(0, Math.min(100, Math.round((Number(level) || 0) / 5) * 5));
  beautyComparing = false;
  beautyLevel = level;
  if (level && !beautyPrepared) beginBeautySkin(true);
  scheduleBeautyRender();
}
for (const tab of document.querySelectorAll('[data-photo-tab]')) {
  tab.onclick = () => { beautyTab = tab.dataset.photoTab; renderBeauty(); };
  tab.onkeydown = event => {
    const tabs = [...document.querySelectorAll('[data-photo-tab]')], index = tabs.indexOf(tab);
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return; event.preventDefault(); tabs[next].click(); tabs[next].focus();
  };
}
for (const key of ['color', 'frame']) for (const button of document.querySelectorAll('[data-photo-' + key + ']')) button.onclick = async () => {
  if (beautyProcessing || aiEditor.busy || aiEditor.loadingFrame) return;
  beautyEffects[key] = button.dataset[key === 'color' ? 'photoColor' : 'photoFrame']; beautyComparing = false;
  await loadBeautyBase(); scheduleBeautyRender();
};
for(const [id,key] of [['frameEventTitle','title'],['frameEventDate','date']])el(id).oninput=()=>{
  if(beautyProcessing||aiEditor.busy||aiEditor.loadingFrame)return;
  beautyEffects.event[key]=el(id).value;beautyComparing=false;
  clearTimeout(beautyFrameRenderTimer);beautyFrameRenderTimer=setTimeout(scheduleBeautyRender,150);
};
el('beautyStrength').oninput = () => chooseBeauty(Number(el('beautyStrength').value));
el('closeBeauty').onclick = () => closeDialog('beautyDialog');
el('compareBeauty').onclick = () => { beautyComparing = !beautyComparing; renderBeauty(); };
el('beautyDialog').addEventListener('close', () => {
  cancelAnimationFrame(beautyRenderFrame); beautyRenderFrame = 0;
  clearTimeout(beautyFrameRenderTimer);decorationEditor.close();
  aiEditor.close();beautyAIFile=null;beautyAIKind='';
  beautyAbort?.abort();beautyAbort=null;releaseBeautyComposition();
  beautySkinJob?.dispose();beautySkinJob=null;
  if(beautyBase)beautyBase.width=beautyBase.height=1;
  beautyEpoch++; beautyEntry = null; beautyPrepared = null; beautyBase = null; beautyProcessing = false;
  window.CameraBeauty.releaseDetector();el('beautyOriginal').width=el('beautyOriginal').height=1;
  el('beautyCanvas').width = el('beautyCanvas').height = 1;
});
el('applyBeauty').onclick = async () => {
  if (!beautyEntry || beautyProcessing || aiEditor.busy || aiEditor.loadingFrame || el('applyBeauty').disabled || busy || beautyEntry.submission) return;
  const entry = beautyEntry, epoch = beautyEpoch, level = beautyLevel;
  beautyProcessing = true; el('beautyState').textContent = '사진을 준비하고 있습니다…'; renderBeauty();
  try {
    const effects = window.CameraBeauty.normalizeEffects(beautyEffects);
    const edited=!!beautyAIFile||level>0||effects.color!=='none'||effects.frame!=='none'||!!effects.decorations?.length;
    const file = edited ? await exportEditorPhoto() : null;
    if (epoch !== beautyEpoch || !selected.includes(entry)) return;
    if (entry.url) URL.revokeObjectURL(entry.url); entry.url = ''; entry.beautyFile = file; entry.beautyLevel = level; entry.beautyScale = 100; entry.photoEffects = effects; delete entry.previewFile;
    entry.aiFile=beautyAIFile;entry.aiKind=beautyAIKind;
    entry.thumb = await makeThumb(file || entry.file); entry.error = '';
    await persistDraft(); renderReview(); closeDialog('beautyDialog');
  } catch { if (epoch === beautyEpoch) el('beautyState').textContent = '보정 사진을 준비하지 못했습니다. 다시 시도하거나 원본을 선택해 주세요.'; }
  finally { if (epoch === beautyEpoch) { beautyProcessing = false; renderBeauty(); } }
};
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
  if (hasFrozen()) { notice('응답을 확인하지 못한 사진이 있습니다. 같은 설정으로 재시도하거나 목록에서 뺀 뒤 설정을 변경해 주세요.', true, 'draft'); return false; }
  return true;
}
function targetDefault() {
  const personal=storage.get('lastTarget');
  if(personal)return {target:personal,targetSource:'device'};
  if(config?.currentEvent)return {target:structuredClone(config.currentEvent),targetSource:'common'};
  return {target:null,targetSource:''};
}
function refreshCommonTarget(){
  if(!settings||selected.length||hasFrozen()||settings.targetSource==='device'||storage.get('lastTarget'))return;
  Object.assign(settings,targetDefault());storage.set('settings',settings);
}
function renderFlow(){
  if (currentPage !== 'work' || workStage !== 'review') beautyWarmCandidate = null;
  if (beautyWarmup.cached && (currentPage !== 'work' || workStage !== 'review' || !selected.some(entry => entry.file === beautyWarmup.cached.file))) beautyWarmup.clear();
  if(!config||!settings)return;
  el('cameraSteps').hidden=currentPage!=='work';
  for(const step of document.querySelectorAll('[data-step]')){if(step.dataset.step===workStage)step.setAttribute('aria-current','step');else step.removeAttribute('aria-current');}
  el('captureHome').hidden=workStage!=='capture';
  el('review').hidden=workStage!=='review'||!selected.length;
  el('completePanel').hidden=workStage!=='done';
  el('workTitle').textContent=mode==='archive'?'사진을 찍거나 골라 보관하세요':'사진을 찍어 화면에 올려보세요';
  el('captureHint').textContent='촬영하고, 확인한 뒤 '+(mode==='archive'?'보관':'등록')+'하면 끝!';
  el('capturePolicy').textContent=mode==='both'?'원본도 함께 보관합니다.':mode==='live'?'선택한 화면에만 올립니다. 원본은 장기 보관하지 않습니다.':'선택한 행사 폴더에 보관합니다.';
  el('archiveOnly').textContent=mode==='archive'?'화면에도 올리기':'보관만 하기';
  el('quickMonitor').hidden=mode==='archive';el('quickEvent').hidden=mode==='live';
  const site=config.sites.find(s=>s.id===settings.siteId);
  el('quickMonitor').replaceChildren(node('span',site?.name||'보낼 화면 선택'));
  if(site&&sitesReady)el('quickMonitor').append(monitorStatus(site));
  else if(site)el('quickMonitor').append(node('span','확인 필요'));
  el('quickMonitor').append(node('span','⌄'));
  el('quickEvent').textContent=(settings.target?(settings.targetSource==='common'?'공통 · ':'')+(settings.target.folderName||settings.target.eventName):'보관할 행사 · 나중에 선택')+' ⌄';
  for(const term of el('workSummary').querySelectorAll('dt')){if(term.textContent==='등록자')term.nextElementSibling.textContent=settings.uploaderName||'첫 등록 때 입력';if(term.textContent==='보관 위치')term.nextElementSibling.textContent=settings.target?settings.target.year+' / '+(settings.target.folderName||settings.target.eventName):'등록 후 행사 선택';}
  for(const id of ['home','quickMonitor','quickEvent','moreMenu','archiveOnly','reviewOptions','reviewAdd','reviewRetake','nextCapture'])el(id).disabled=busy;
  el('reviewRetake').textContent=selected.length>1?'촬영 화면으로':'다시 촬영';
  el('reviewRetake').disabled=busy||hasFrozen();
  el('reviewOptions').disabled=busy||hasFrozen();
  const pending=[...uploadStates.values()].filter(r=>r.pipeline&&r.mode==='both'&&!r.cancelled&&!r.target).length;
  const waiting=Math.max(pending,originals.filter(p=>!p.target).length);
  el('locationNotice').hidden=!waiting;el('locationNotice').textContent='원본 '+waiting+'장 · 보관할 행사를 선택해 주세요';
  el('transferNotice').hidden=!originals.length;
  el('transferNotice').textContent='원본 '+originals.length+'장 '+(originals.some(p=>p.error)?'전송 확인 필요':'전송 중 · 상태 보기');
  const completion=lastCompletion;
  el('completeTitle').textContent=completion?.mode==='archive'?'보관을 접수했어요':'등록을 접수했어요';
  const batch=completion?.shareKey&&shareBatch?.key===completion.shareKey?shareBatch:null;
  const rows=(batch?.photos||[]).map(p=>uploadStates.get(p.id)).filter(Boolean);
  const displayed=rows.filter(r=>r.delivery?.some(d=>d.status==='displayed')).length;
  const failed=rows.some(r=>r.live==='error'||r.delivery?.some(d=>['image_error','stopped'].includes(d.status)));
  const completeText=completion?.mode==='archive'?'원본 보관 상태는 내 사진에서 확인할 수 있습니다.':failed?'화면 표시를 확인해 주세요. 내 사진에서 다시 시도할 수 있습니다.':rows.length&&displayed===rows.length?'모니터 표시를 확인했습니다.':'모니터 표시 확인 중입니다.';
  el('completeState').textContent=(completion?.count?completion.count+'개 · ':'')+completeText;
  el('showShare').hidden=!batch?.photos.length;
  el('withdrawLatest').hidden=!rows.some(r=>r.canWithdraw);
  el('menuShare').hidden=!shareBatch?.photos?.length;
}
async function leaveDialog(id,action){
  if(!el(id).open)return action();
  const closed=new Promise(resolve=>el(id).addEventListener('close',resolve,{once:true}));closeDialog(id);await closed;return action();
}
async function openLocation(){
  if(!canEdit())return;
  el('archiveLocationFields').append(el('archiveSetup'));el('archiveSetup').hidden=false;el('archiveSetup').disabled=false;
  const target=settings.target||targetDefault().target;
  el('year').value=target?.year||config.year;el('eventName').value=target?.eventId?'':target?.eventName||'';el('eventDate').value=target?.eventDate||'';el('eventSearch').value='';
  el('locationSource').textContent=settings.targetSource==='common'?'관리자 공통 행사를 사용 중입니다. 여기서 선택하면 이 폰의 최근 행사로 기억합니다.':'이 폰에서 선택한 행사를 우선 사용합니다. 선택이 없으면 관리자 공통 행사를 사용합니다.';
  el('locationError').textContent='';openDialog('locationDialog');
  await loadFolders(target?.yearId||'',target?.eventId||(target?.eventName?'__new__':''));
}
function registrationReady(){
  if(hasFrozen())return true;
  const site=config.sites.find(s=>s.id===settings.siteId);
  if(settings.uploaderName&&(mode==='archive'||(site&&sitesReady)))return true;
  el('registrationName').value=settings.uploaderName||storage.get('name')||'';
  el('registrationName').closest('label').hidden=!!settings.uploaderName;
  el('registrationSiteLabel').hidden=mode==='archive'||!!(site&&sitesReady);el('registrationSite').disabled=mode==='archive';
  el('registrationSite').replaceChildren(option('','보낼 화면을 선택하세요'),...config.sites.map(s=>option(s.id,s.name+' · '+(s.online?'연결됨':'연결 끊김'))));
  el('registrationSite').value=settings.siteId||'';
  el('registrationError').textContent=sitesReady||mode==='archive'?'': '모니터 목록을 다시 확인해 주세요.';
  el('confirmRegistration').disabled=mode!=='archive'&&!sitesReady;
  el('registrationRetry').hidden=mode==='archive'||sitesReady;
  registrationSending=true;openDialog('registrationDialog');return false;
}
el('registrationForm').onsubmit=async event=>{
  event.preventDefault();if(busy||hasFrozen())return;
  const name=el('registrationName').value.normalize('NFC').trim(),site=config.sites.find(s=>s.id===el('registrationSite').value);
  if(!name||[...name].length>20){el('registrationError').textContent='등록자 이름을 1~20자로 입력해 주세요.';return;}
  if(mode!=='archive'&&(!site||!sitesReady)){el('registrationError').textContent='보낼 화면을 선택하고 연결 상태를 확인해 주세요.';el('registrationRetry').hidden=false;return;}
  Object.assign(settings,{uploaderName:name,siteId:site?.id||'',siteName:site?.name||''});
  storage.set('name',name);if(site)storage.set('lastSite',site.id);storage.set('settings',settings);el('uploader').value=name;el('site').value=settings.siteId;
  await persistDraft();const send=registrationSending;registrationSending=false;
  await leaveDialog('registrationDialog',()=>{renderFlow();if(send)return sendPhotos();});
};
el('registrationDialog').addEventListener('close',()=>registrationSending=false);
el('registrationRetry').onclick=async()=>{await refreshSites();if(el('registrationDialog').open){const sending=registrationSending;el('registrationSite').replaceChildren(option('','보낼 화면을 선택하세요'),...config.sites.map(s=>option(s.id,s.name+' · '+(s.online?'연결됨':'연결 끊김'))));el('registrationSite').value=settings.siteId||'';el('confirmRegistration').disabled=!sitesReady;el('registrationError').textContent=sitesReady?'':'모니터 연결 상태를 확인하지 못했습니다.';registrationSending=sending;}};
for(const button of document.querySelectorAll('[data-close-dialog]'))button.onclick=()=>closeDialog(button.dataset.closeDialog);
el('moreMenu').onclick=()=>{if(!busy)openDialog('moreDialog');};
el('menuShare').onclick=()=>leaveDialog('moreDialog',()=>openDialog('shareDialog'));
el('menuOptions').onclick=()=>leaveDialog('moreDialog',()=>{if(canEdit())openDialog('optionsDialog');});
el('quickMonitor').onclick=async()=>{if(!canEdit())return;el('site').value=settings.siteId||'';openDialog('siteDialog');await refreshSites();};
el('quickEvent').onclick=openLocation;el('locationNotice').onclick=openLocation;el('openLocationFromStatus').onclick=()=>leaveDialog('statusDialog',openLocation);
el('menuEvent').onclick=()=>leaveDialog('moreDialog',openLocation);
el('menuHistory').onclick=()=>leaveDialog('moreDialog',()=>{openDialog('statusDialog');loadHistory();});
for(const id of ['openHistory','showStatus','transferNotice'])el(id).onclick=()=>{openDialog('statusDialog');loadHistory();};
el('showShare').onclick=()=>openDialog('shareDialog');el('withdrawLatest').onclick=()=>el('withdrawBatch').click();
el('reviewOptions').onclick=()=>{if(canEdit())openDialog('optionsDialog');};
el('reviewAdd').onclick=()=>{workStage='capture';renderReview();};
el('reviewRetake').onclick=()=>{if(!canEdit())return;if(selected.length===1){URL.revokeObjectURL(selected[0].url);selected=[];persistDraft();}workStage='capture';renderReview();if(!selected.length)el('shoot').click();};
el('nextCapture').onclick=()=>{workStage='capture';refreshCommonTarget();renderReview();el('shoot').click();};
el('archiveOnly').onclick=()=>{if(!canEdit())return;mode=mode==='archive'?'both':'archive';settings.mode=mode;if(!settings.target)Object.assign(settings,targetDefault());if(mode==='both'&&!settings.siteId){settings.siteId=storage.get('lastSite')||(config.sites.length===1?config.sites[0].id:'');settings.siteName=config.sites.find(s=>s.id===settings.siteId)?.name||'';}workStage='capture';storage.set('settings',settings);persistDraft();showWork();};
el('backHomeFromPurpose').onclick=goHome;
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
function requestFolders(year, yearId = '', force = false) {
  const key = year + '/' + yearId, existing = folderRequests.get(key);
  if (existing?.pending || (!force && existing && Date.now() - existing.at < 30000)) return existing.promise;
  const entry = { at: Date.now(), pending: true };
  entry.promise = api('folders?' + new URLSearchParams({ year, ...(yearId ? { yearId } : {}), ...(force ? { refresh: '1' } : {}) }), { timeoutMs: 25000 })
    .then(data => { entry.pending = false; entry.at = Date.now(); return data; }, error => { if (folderRequests.get(key) === entry) folderRequests.delete(key); throw error; });
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
    el('folderState').textContent = e.message + ' 목록을 확인하기 전에는 새 폴더를 만들지 않습니다.';
    events = []; el('event').value = ''; renderEvents(''); el('chooseFolder').disabled = true;
  } finally { clearInterval(progress); if (seq === folderSequence) { el('reloadFolders').disabled = false; el('saveLocation').disabled = !foldersReady || assigningLocation; } }
}
function renderEvents(restore = el('event').value) {
  const search = el('eventSearch').value.trim().normalize('NFC').toLocaleLowerCase('ko');
  const recent = rememberedTarget();
  const recentId = events.some(e=>e.id===restore)?restore:recent?.yearId && recent.yearId === el('yearFolder').dataset.selected ? recent.eventId || events.find(e => e.name === recent.folderName)?.id : '';
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
    button.onclick = () => { el('event').value = e.id;renderEvents(); closeDialog('folderDialog'); };
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
    button.onclick = () => { el('site').value = site.id; storage.set('lastSite', site.id);if(currentPage==='work'&&settings&&!hasFrozen()){settings.siteId=site.id;settings.siteName=site.name;storage.set('settings',settings);persistDraft();} renderSites();renderFlow(); closeDialog('siteDialog'); };
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
  const seq = ++siteSequence; el('chooseSite').disabled = true;
  el('siteState').textContent = '모니터 연결 상태 확인 중…';
  try {
    const data = await api('config');
    if (seq !== siteSequence) return;
    Object.assign(config, data); sitesReady = true;refreshCommonTarget(); renderSites(); updateWorkWarning();renderFlow();
    el('siteState').textContent = ''; el('siteDialogState').textContent = '';
  } catch (e) {
    if (seq !== siteSequence) return;
    sitesReady=false;
    el('siteState').textContent = e.message; el('siteDialogState').textContent = '연결 상태를 확인하지 못했습니다. 목록을 다시 열어 확인해 주세요.';
    const site = config.sites.find(s => s.id === el('site').value);
    el('siteButtonText').textContent = (site?.name || '모니터 선택') + ' · 상태 확인 불가';
    el('siteList').replaceChildren(node('p', '연결 상태를 확인한 뒤 모니터를 선택할 수 있습니다.', 'hint'));
    const dd = el('workSummary').querySelector('[data-monitor]');
    if (dd && settings) dd.textContent = settings.siteName + ' · 상태 확인 불가';
  } finally { if (seq === siteSequence){el('chooseSite').disabled = false;if(el('registrationDialog').open){el('confirmRegistration').disabled=mode!=='archive'&&!sitesReady;el('registrationRetry').hidden=mode==='archive'||sitesReady;if(sitesReady&&el('registrationError').textContent==='모니터 목록을 다시 확인해 주세요.')el('registrationError').textContent='';}renderFlow();} }
}
async function openSetup(nextMode, push = true) {
  mode = nextMode; view('setup', push); el('setupTitle').textContent = labels[mode];
  el('setupForm').insertBefore(el('archiveSetup'), el('liveSetup'));
  el('archiveSetup').hidden = mode !== 'archive'; el('archiveSetup').disabled = mode !== 'archive';
  el('liveSetup').hidden = mode === 'archive'; el('liveSetup').disabled = mode === 'archive';
  const s = settings || storage.get('settings') || {};
  el('uploader').value = s.uploaderName || storage.get('name') || '';
  const target = storage.get('lastTarget') || s.target || config.currentEvent;
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
  if (mode === 'both') target = targetDefault().target;
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
  settings = { mode, uploaderName, target, targetSource:mode==='archive'?'device':targetDefault().targetSource, siteId: site?.id || '', siteName: site?.name || '' };
  if(settings.targetSource==='device')rememberTarget(target);
  if (site) storage.set('lastSite', site.id);
  storage.set('settings', settings); storage.set('name', uploaderName); persistDraft(); notice('');workStage=selected.length?'review':'capture'; showWork();
}
function showWork(push = true) {
  const entering = currentPage !== 'work' || el('archiveSetup').parentElement !== el('archiveLocationFields');
  mode = settings.mode; view('work', push); el('workTitle').textContent = labels[mode];
  const values = [['등록자', settings.uploaderName||'첫 등록 때 입력']];
  if (settings.target) values.push(['보관 위치', settings.target.year + ' / ' + (settings.target.folderName || settings.target.eventName)]);
  else if (mode === 'both') values.push(['보관 위치', '표출 후 지정 가능']);
  if (mode !== 'archive') values.push(['표출 모니터', settings.siteName]);
  el('workSummary').replaceChildren(...values.flatMap(([key, value]) => [node('dt', key), node('dd', value)]));
  if (mode !== 'archive') { el('workSummary').lastElementChild.dataset.monitor = ''; renderSites(); }
  el('workArchive').hidden = mode !== 'both';
  if (mode !== 'live') {
    el('archiveLocationFields').append(el('archiveSetup')); el('archiveSetup').hidden = false; el('archiveSetup').disabled = false;
    if (entering) {
      const target = settings.target || targetDefault().target;
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
  if (mode !== 'live' && !config.ready) warnings.push('교회 보관함 연결에 관리자 확인이 필요합니다. 접수한 원본은 서버에서 보관 대기하며, 촬영·모니터 표출은 계속할 수 있습니다.');
  if (mode !== 'archive' && !config.liveEnabled) warnings.push('모니터 표출 접수가 닫혀 있습니다.');
  if (mode === 'live') warnings.push('모니터 전용 사진은 장기 보관하지 않습니다.');
  el('workWarning').textContent = warnings.join(' ');
}
function localDate(ts) { return new Date(ts + 9 * 3600000).toISOString().slice(0, 19); }
// 기기가 읽을 수 있는 영상이면 길이(초)를 알려 준다. 읽지 못하면 0 — 길이 제한은 서버가 다시 확인한다.
function videoSeconds(file) {
  return new Promise(resolve => {
    const video = document.createElement('video'), url = URL.createObjectURL(file);
    const done = seconds => { clearTimeout(timer); URL.revokeObjectURL(url); video.removeAttribute('src'); resolve(Number.isFinite(seconds) ? seconds : 0); };
    const timer = setTimeout(() => done(0), 8000);
    video.preload = 'metadata'; video.muted = true;
    video.onloadedmetadata = () => done(video.duration); video.onerror = () => done(0);
    video.src = url;
  });
}
function hasVideo() { return selected.some(r => r.kind === 'video'); }
// 영상은 수백 MB라 진행률이 필요하다. fetch 는 업로드 진행률을 알려 주지 않아 XHR 을 쓴다.
function uploadVideo(form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/live/api/camera/video');
    const legacyToken = new URLSearchParams(location.search).get('t') || storage.get('token');
    if (legacyToken) xhr.setRequestHeader('x-live-token', legacyToken);
    xhr.timeout = 30 * 60000;
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    xhr.onload = () => {
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 401) { location.replace('/login?role=camera'); return reject(new Error('다시 로그인해 주세요.')); }
      if (xhr.status < 200 || xhr.status >= 300) return reject(Object.assign(new Error(data.error || '연결을 확인하고 다시 시도해 주세요.'), { status: xhr.status, backlog: !!data.backlog }));
      resolve(data);
    };
    xhr.onerror = () => reject(new Error('연결이 끊겼습니다. 같은 영상으로 다시 시도해 주세요.'));
    xhr.ontimeout = () => reject(new Error('응답 시간이 초과되었습니다. 같은 요청으로 다시 시도해 주세요.'));
    xhr.send(form);
  });
}
async function addFiles(files, captured = false) {
  beautyWarmCandidate = null;
  beautyWarmup.clear();
  clearCapturePending(); clearTimeout(captureReturnTimer);
  // 모니터에 표출하는 목적은 30장, 교회폴더에 저장만 하는 목적은 한 번에 수백 장까지 받는다.
  const limit = mode === 'archive' ? (config.maxArchiveBatch || 500) : (config.maxBatch || 30);
  const slots = limit - selected.length;
  if (files.length > slots) notice('한 번에 ' + limit + '장까지 가능합니다. 초과 사진은 추가하지 않았습니다.', true);
  else if (files.length > REVIEW_PAGE) notice('사진 ' + files.length + '장을 확인하고 있습니다…');
  const added = [];
  for (const file of [...files].slice(0, slots)) {
    if (!file.size) { notice(file.name + ': 사진 파일이 비어 있습니다. 저장을 마친 뒤 다시 선택해 주세요.', true); continue; }
    const isVideo = /^video\//.test(file.type) || /\.(mp4|mov|m4v|webm|mkv|3gp)$/i.test(file.name);
    if (isVideo && file.size > (config.maxVideoBytes || 500 * 1024 * 1024)) { notice(file.name + ': 영상은 500MB까지 가능합니다.', true); continue; }
    if (!isVideo && file.size > config.maxBytes) { notice(file.name + ': 한 장당 50MB까지 가능합니다.', true); continue; }
    if (selected.some(r => r.file.name === file.name && r.file.size === file.size && r.file.lastModified === file.lastModified)) continue;
    let date = '', dateSource = 'unknown';
    if (isVideo) {
      const seconds = await videoSeconds(file);
      if (seconds > (config.maxVideoSeconds || 180) + 2) { notice(file.name + ': 영상은 3분까지 가능합니다. (' + Math.round(seconds) + '초)', true); continue; }
      date = localDate(file.lastModified || Date.now()); dateSource = captured ? 'capture' : 'fileModified';
      const requestId = uuid();
      selected.push({ file, kind: 'video', seconds, requestId, key: requestId, date, dateSource, url: '', error: '' });
      continue;
    }
    try {
      const tags = await window.exifr?.parse(file, { pick: ['DateTimeOriginal', 'CreateDate'], reviveValues: false });
      const raw = String(tags?.DateTimeOriginal || tags?.CreateDate || '').replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw)) { date = raw; dateSource = 'exif'; }
    } catch {}
    if (!date && file.lastModified) { date = localDate(file.lastModified); dateSource = captured ? 'capture' : 'fileModified'; }
    const requestId = uuid();
    const entry = { file, requestId, key: requestId, date, dateSource, url: '', error: '', thumb: await makeThumb(file) };
    selected.push(entry); added.push(entry);
  }
  if (files.length > REVIEW_PAGE && files.length <= slots) notice('사진 ' + selected.length + '장을 선택했습니다.');
  await persistDraft(); renderReview();
  if (selected.length) el('review').scrollIntoView({ behavior: 'smooth', block: 'start' });
  workStage='review';renderReview();
  // 폰 기본 카메라에서 확인을 눌러 돌아온 사진 한 장만 미리 준비한다.
  // 뽀샤시를 열지 않고 연달아 찍고 있으면(연속 촬영) 준비를 쉰다. 메모리가 적은 기기도 쉰다. 뽀샤시를 열면 다시 준비한다.
  if (captured && added.length === 1 && files.length === 1 && selected.at(-1) === added[0]) {
    const streak = storage.get('warmStreak') || 0;
    if (streak < WARM_STREAK_LIMIT && !(navigator.deviceMemory && navigator.deviceMemory <= 4)) {
      storage.set('warmStreak', streak + 1);
      beautyWarmCandidate = { entry: added[0], at: Date.now() }; resumeCapturedWarmup();
    }
  }
}
function renderReview() {
  el('review').hidden = !selected.length;
  renderReviewText();
  // 검토 화면이 아니면(촬영 화면, 폰 카메라 앱이 뜬 동안) 사진 이미지는 그리지 않고 거둔다.
  if (workStage !== 'review') { releaseReviewMedia(); renderFlow(); homeSummary(); return; }
  for (const r of selected) if (!r.url) r.url = URL.createObjectURL(r.kind === 'video' ? r.file : (r.thumb || r.beautyFile || r.file));
  // 수백 장을 한꺼번에 그리면 휴대폰 메모리가 부족해지므로 앞에서부터 일부만 그린다.
  if (!selected.length) reviewShown = REVIEW_PAGE;
  el('selectedPhotos').classList.toggle('singlePhoto',selected.length===1);
  el('selectedPhotos').replaceChildren(...selected.slice(0, reviewShown).map(r => {
    const card = node('div', undefined, 'photoCard'); const img = node(r.kind === 'video' ? 'video' : 'img'); img.src = r.url; img.alt = r.file.name;
    if (r.kind !== 'video') { img.loading = 'lazy'; img.decoding = 'async'; }
    if (r.kind === 'video') { img.muted = true; img.playsInline = true; img.preload = 'metadata'; img.controls = true; }
    const caption = node('p', r.file.name); const state = node('p', r.error || (r.kind === 'video' ? '영상 ' + (r.seconds ? Math.round(r.seconds) + '초 · ' : '') : '원본 ') + (r.file.size / 1024 / 1024).toFixed(1) + 'MB');
    img.onerror = () => { img.hidden = true; caption.textContent = r.file.name + ' · 이 기기에서 미리보기를 열지 못했습니다. 원본 보관은 가능합니다.';caption.classList.add('photoError');card.prepend(caption); };
    const label = node('label', (r.kind === 'video' ? '영상' : '사진') + ' 날짜 (한국 시간)'); const input = node('input'); input.type = 'datetime-local'; input.step = '1'; input.value = r.date; input.disabled = !!r.submission || busy;
    input.onchange = () => { r.date = input.value; r.dateSource = 'user'; persistDraft(); }; label.append(input);
    const dateInfo = node('p', ({ exif: '사진 촬영정보', capture: '방금 촬영한 날짜', fileModified: '파일 수정일시 — 필요하면 수정하세요', user: '직접 지정', unknown: '날짜미상' })[r.dateSource]);
    const remove = node('button', r.submission ? '목록에서 빼기' : '삭제', 'photoRemove'); remove.type = 'button'; remove.disabled = busy;
    remove.setAttribute('aria-label', r.file.name + (r.submission ? ' 목록에서 빼기' : ' 삭제'));
    remove.onclick = () => removeDraftEntries([r]);
    card.append(img);
    if(r.error)card.append(node('p',r.error,'photoError'));
    const actions = node('div', undefined, 'photoActions');
    if (r.kind !== 'video') {
      const edit = node('button', '사진 꾸미기', 'beautyEdit'); edit.type = 'button'; edit.disabled = busy || !!r.submission;
      edit.onclick = () => openBeauty(r); actions.append(edit);
    }
    actions.append(remove); card.append(actions);
    if (r.beautyFile) card.append(node('p', mode === 'both' ? '꾸민 사진 표출 · 원본 보관' : mode === 'archive' ? '꾸민 사진 저장' : '꾸민 사진 표출', 'beautyApplied'));
    const details=node('details',undefined,'photoDetails');details.append(node('summary','촬영 날짜·파일 정보'),caption,state,label,dateInfo);card.append(details);return card;
  }));
  if (selected.length > reviewShown) {
    const more = node('button', '나머지 ' + (selected.length - reviewShown) + '장 중 ' + Math.min(REVIEW_PAGE, selected.length - reviewShown) + '장 더 보기'); more.type = 'button'; more.id = 'moreReview'; more.disabled = busy;
    more.onclick = () => { reviewShown += REVIEW_PAGE; renderReview(); };
    el('selectedPhotos').append(node('p', '목록에는 ' + reviewShown + '장만 표시합니다. 표시하지 않은 사진도 함께 전송합니다.', 'hint'), more);
  }
  if(!selected.length&&workStage==='review')workStage='capture';
  renderFlow();homeSummary();
}
// 검토 화면의 글·입력칸 상태. 사진 이미지와 달리 어느 단계에서든 맞춰 둔다(옵션 창이 따로 열리므로).
function renderReviewText() {
  const videos = selected.filter(r => r.kind === 'video').length, photos = selected.length - videos;
  const countText = [photos ? '사진 ' + photos + '장' : '', videos ? '영상 ' + videos + '개' : ''].filter(Boolean).join(' · ');
  el('reviewTitle').textContent = countText;
  el('muteLabel').hidden = !videos || mode === 'archive'; el('muteVideo').disabled = busy;
  el('reviewDestination').textContent = mode==='archive'?(settings.target?.folderName||settings.target?.eventName||'행사 선택 필요')+'에 보관':(settings.siteName||'등록할 때 보낼 화면 선택')+(mode==='both'?' · 원본도 보관':' · 화면에만 등록');
  el('messageLabel').hidden = mode === 'archive'; el('keepMessageLabel').hidden = mode === 'archive';
  el('messageCount').textContent = el('message').value.length;
  renderMessageChips();
  renderEmail();
  el('send').textContent = (selected.length>1?countText+' ':'')+(mode==='archive'?'이 사진 보관하기':'화면에 올리기');
  el('discard').textContent = hasFrozen() ? '목록 비우기' : '전체 삭제';
}
// 화면 문구 고르기: 교회 공용 문구(서버 설정), 이 기기에서 보낸 최근 문구, 지금 행사 이름을 단추로 보여 준다.
// 누르면 입력칸에 들어가고 그대로 고쳐 쓸 수 있다. 최근 문구는 이 기기에만 남는다(이름이 든 문구도 있어 서버에 보내지 않음).
const RECENT_MESSAGES = 6;
function eventPhrase() {
  const name = settings?.target?.folderName || settings?.target?.eventName || '';
  return name.replace(/^\s*(\d{8}|\d{4}[-.]\d{2}[-.]\d{2})\s*/, '').trim().slice(0, 40);
}
function rememberMessage(text) {
  text = String(text || '').trim();
  if (!text || (config?.phrases || []).includes(text)) return;
  storage.set('recentMessages', [text, ...(storage.get('recentMessages') || []).filter(m => m !== text)].slice(0, RECENT_MESSAGES));
}
function useMessage(text) {
  if (el('message').disabled) return;
  el('message').value = text; el('messageCount').textContent = text.length;
  persistDraft(); renderMessageChips();
}
function renderMessageChips() {
  const common = (config?.phrases || []).filter(Boolean);
  const recent = (storage.get('recentMessages') || []).filter(m => !common.includes(m));
  const event = eventPhrase(), current = el('message').value.trim(), disabled = el('message').disabled;
  const chip = text => {
    const button = node('button', text, 'messageChip'); button.type = 'button'; button.disabled = disabled;
    button.setAttribute('aria-pressed', String(text === current)); button.onclick = () => useMessage(text);
    return button;
  };
  const group = (title, items) => { const box = node('div'); box.append(node('p', title)); const row = node('div', undefined, 'chipRow'); row.append(...items); box.append(row); return box; };
  const groups = [];
  if (common.length) groups.push(group('교회 공용 문구', common.map(chip)));
  if (recent.length) groups.push(group('최근에 쓴 문구', recent.map(text => {
    const wrap = node('span', undefined, 'recentChip'), remove = node('button', '×', 'chipRemove');
    remove.type = 'button'; remove.disabled = disabled; remove.setAttribute('aria-label', '최근 문구 지우기: ' + text);
    remove.onclick = () => { storage.set('recentMessages', (storage.get('recentMessages') || []).filter(m => m !== text)); renderMessageChips(); };
    wrap.append(chip(text), remove); return wrap;
  })));
  if (event && !common.includes(event) && !recent.includes(event)) groups.push(group('행사명 넣기', [chip(event)]));
  el('messageChips').replaceChildren(...groups);
  el('messageChips').hidden = mode === 'archive' || !groups.length;
}
// ── 촬영 ──
// 폰의 기본 촬영은 폰 카메라 앱이다. 다만 카메라 앱을 여는 동안 메모리가 모자라면 휴대폰이 이 화면을 닫아 버리고,
// 그러면 찍은 사진을 받을 곳이 없어 사라진다(카메라 앱이 앱에 넘겨주려고 찍은 사진은 앨범에도 남지 않는다).
// 그런 일이 생겼을 때만 보조카메라(화면 안 카메라)를 권한다. 화면을 떠나지 않으므로 찍자마자 대기 목록에 남는다.
let cameraFacing = 'environment';
const auxCameraAvailable = () => isMobile && !!navigator.mediaDevices?.getUserMedia;
async function openAuxCamera() {
  if (await openInPageCamera()) return;
  // 권한 창을 거치면 '사용자가 누른 동작'이 끝나 파일 창을 바로 열 수 없으므로 단추로 이어 준다.
  notice('보조카메라를 열지 못했습니다. 브라우저 설정에서 이 사이트의 카메라 권한을 확인해 주세요. 지금은 폰 카메라로 다시 찍을 수 있습니다.', true, 'capture');
  noticeActions([['다시 촬영', () => el('shoot').click(), true]]);
}
async function openInPageCamera() {
  try {
    cameraStream?.getTracks().forEach(track => track.stop());
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: cameraFacing }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
    if (currentPage !== 'work') { cameraStream.getTracks().forEach(track => track.stop()); cameraStream = null; return true; }
    el('cameraVideo').srcObject = cameraStream;
    el('cameraVideo').classList.toggle('mirrored', cameraFacing === 'user');
    el('flipCamera').hidden = !isMobile; el('nativeCamera').hidden = !isMobile; el('cameraTitle').textContent = isMobile ? '보조카메라' : '사진 촬영';
    if (!el('cameraDialog').open) openDialog('cameraDialog');
    return true;
  } catch { cameraStream = null; return false; }
}
// 폰 카메라 앱·앨범을 열기 직전에 미리보기 이미지와 공유용 메모리 사본을 거둬, 뒤로 가는 이 화면이 가볍게 남게 한다.
function nativeCapture(input) {
  releaseReviewMedia(); offloadShareBatch();
  const at = Date.now();
  storage.set('capturePending', { input, at });
  try { sessionStorage.setItem('camera.captureSession', String(at)); } catch {}   // 같은 탭이 다시 열린 것인지 가리는 표시
  storage.set('captureCount', (storage.get('captureCount') || 0) + 1);
  el(input).value = ''; el(input).click();
}
function clearCapturePending() { storage.set('capturePending', false); try { sessionStorage.removeItem('camera.captureSession'); } catch {} }
// 카메라 앱·앨범에서 돌아왔는데 몇 초가 지나도 사진이 오지 않으면 취소한 것으로 본다.
// 브라우저가 취소(cancel) 신호를 주지 않는 기기에서 표시가 남아 다음에 열 때 엉뚱한 안내가 뜨지 않게 한다.
let captureReturnTimer = null;
function watchCaptureReturn() {
  clearTimeout(captureReturnTimer);
  const pending = storage.get('capturePending');
  if (!pending || typeof pending !== 'object' || Date.now() - pending.at < 1000) return;
  captureReturnTimer = setTimeout(() => {
    const still = storage.get('capturePending');
    if (still && still.at === pending.at) { logCapture('cancelled', still, Date.now() - still.at, false); clearCapturePending(); }
  }, 5000);
}
// 촬영 중단 기록(이 기기에만). kind: discarded(브라우저가 메모리 부족으로 닫았다고 표시) · reloaded(같은 탭이 다시 열림) · reopened(앱을 새로 엶) · stale(10분 넘은 표시) · cancelled(사진 없이 돌아옴)
function logCapture(kind, pending, elapsed, discarded) {
  let navigation = ''; try { navigation = performance.getEntriesByType('navigation')[0]?.type || ''; } catch {}
  const row = { at: Date.now(), kind, input: pending.input, elapsed: elapsed === null ? null : Math.round(elapsed / 1000), discarded: !!discarded, navigation,
    photos: selected.length, memory: navigator.deviceMemory || null, heap: Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576) || null,
    browser: /SamsungBrowser\/(\d+)/.exec(navigator.userAgent) ? '삼성 인터넷 ' + /SamsungBrowser\/(\d+)/.exec(navigator.userAgent)[1] : /Chrome\/(\d+)/.exec(navigator.userAgent) ? 'Chrome ' + /Chrome\/(\d+)/.exec(navigator.userAgent)[1] : /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone Safari' : '기타',
    standalone: matchMedia('(display-mode: standalone)').matches };
  storage.set('captureLog', [row, ...(storage.get('captureLog') || [])].slice(0, 20));
}
const CAPTURE_KIND_LABEL = { discarded: '메모리 부족으로 화면이 닫힘(브라우저 표시)', reloaded: '같은 화면이 다시 열림(메모리 표시 없음)', reopened: '촬영이 끝나기 전에 앱이 닫힘', stale: '오래된 표시 정리', cancelled: '사진 없이 돌아옴(취소)' };
const CAPTURE_INPUT_LABEL = { shootInput: '사진 촬영', videoInput: '영상 촬영', galleryInput: '갤러리 선택' };
function renderCaptureLog() {
  const log = storage.get('captureLog') || [], count = storage.get('captureCount') || 0;
  el('captureLogSection').hidden = !log.length && !count;
  const incidents = log.filter(r => ['discarded', 'reloaded', 'reopened'].includes(r.kind)).length;
  el('captureLogSummary').textContent = '이 기기에서 카메라 앱·갤러리를 연 ' + count + '회 중 화면이 다시 열린 경우 ' + incidents + '회';
  el('captureLogList').replaceChildren(...log.map(r => node('p', kst.format(new Date(r.at)) + ' · ' + (CAPTURE_INPUT_LABEL[r.input] || r.input) + ' · ' + (CAPTURE_KIND_LABEL[r.kind] || r.kind) +
    (r.elapsed !== null && r.elapsed !== undefined ? ' · 연 지 ' + r.elapsed + '초' : '') + ' · 대기 사진 ' + r.photos + '장' + (r.memory ? ' · RAM ' + r.memory + 'GB' : '') + (r.heap ? ' · 스크립트 ' + r.heap + 'MB' : '') +
    ' · ' + r.browser + (r.standalone ? '(설치형)' : '') + (r.navigation ? ' · ' + r.navigation : ''), 'hint')));
}
// 화면이 열렸을 때 카메라 앱·갤러리를 열었던 표시가 남아 있으면, 왜 다시 열렸는지 가려서 알린다.
function checkCaptureInterrupted() {
  const raw = storage.get('capturePending');
  if (!raw) return;
  const pending = typeof raw === 'object' ? raw : { input: raw, at: 0 };
  const elapsed = pending.at ? Date.now() - pending.at : null;
  let sameSession = false; try { sameSession = sessionStorage.getItem('camera.captureSession') === String(pending.at); } catch {}
  const discarded = !!document.wasDiscarded;
  const kind = discarded ? 'discarded' : elapsed !== null && elapsed > 10 * 60000 ? 'stale' : sameSession ? 'reloaded' : 'reopened';
  logCapture(kind, pending, elapsed, discarded); clearCapturePending();
  if (kind !== 'stale') captureLostNotice(pending.input, kind);
}
// 사진기 품질의 정지 사진(ImageCapture)을 먼저 쓰고, 지원하지 않거나 기기 회전 정보 때문에 방향이 화면과 다르면
// 화면에 보이는 그대로 찍는다(잘못 돌아간 사진보다 낫다). 셀카도 저장은 좌우를 뒤집지 않은 사진으로 한다.
async function takeStill(video) {
  const track = cameraStream?.getVideoTracks()[0];
  if (track && 'ImageCapture' in window) {
    try {
      const blob = await new ImageCapture(track).takePhoto();
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const sameShape = (bitmap.width >= bitmap.height) === (video.videoWidth >= video.videoHeight); bitmap.close();
      if (sameShape && blob.size) return blob;
    } catch {}
  }
  const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
}
// 알림 아래에 바로 누를 수 있는 단추를 붙인다. actions: [이름, 동작, 강조]
function noticeActions(actions) {
  const row = node('div', undefined, 'noticeActions');
  for (const [label, run, primary] of actions) {
    const button = node('button', label, primary ? 'primary' : undefined); button.type = 'button';
    button.onclick = () => { notice(''); run(); }; row.append(button);
  }
  el('notice').append(row);
}
// 폰 카메라 앱·앨범을 다녀오는 사이 화면이 다시 열린 경우. 받지 못한 것은 되찾을 수 없으니 곧바로 다시 하게 한다.
// reason: discarded(메모리 부족이 확인됨) · reloaded(같은 탭이 다시 열림, 메모리 표시 없음) · reopened(앱을 새로 엶 — 지난번 촬영 중단)
function captureLostNotice(kind, reason = 'discarded') {
  const past = reason === 'reopened';
  if (kind === 'galleryInput') {
    notice(past ? '지난번에 갤러리에서 고르던 중 앱이 닫혔습니다. 갤러리의 사진은 그대로 있으니 다시 골라 주세요.' : '사진을 고르는 동안 휴대폰이 이 화면을 다시 열었습니다. 다시 골라 주세요. 갤러리의 사진은 그대로 있습니다.', true, 'capture');
    return noticeActions([['갤러리에서 다시 고르기', () => el('choose').click(), true]]);
  }
  const video = kind === 'videoInput', what = video ? '영상' : '사진', aux = !video && !past && auxCameraAvailable();
  const why = reason === 'discarded' ? '카메라 앱을 다녀오는 동안 휴대폰 메모리가 부족해 이 화면이 다시 열렸고, 방금 찍은 ' + what + '을 받지 못했습니다.'
    : reason === 'reloaded' ? '카메라 앱을 다녀오는 동안 이 화면이 새로 열렸습니다(메모리 부족 표시는 없음). 방금 찍은 ' + what + '이 목록에 없으면 받지 못한 것입니다.'
    : '지난번 촬영이 끝나기 전에 앱이 닫혔습니다. 그때 찍은 ' + what + '이 목록에 없으면 받지 못한 것입니다. 카메라에서 취소만 했다면 무시해도 됩니다.';
  notice(why + ' 카메라 앱으로 찍은 ' + what + '은 갤러리에 저장되지 않으니 다시 찍어 주세요.' +
    (past ? '' : ' 카메라 앱을 12MP 기본 모드로 두면 메모리를 덜 써서 이런 일이 줄어듭니다.') + (aux ? ' 같은 일이 반복되면 보조카메라로 찍으세요. 이 화면 안에서 찍어 사진이 사라지지 않습니다.' : ''), true, 'capture');
  noticeActions([['다시 촬영', () => el(video ? 'shootVideo' : 'shoot').click(), true], ...(aux ? [['보조카메라로 찍기', openAuxCamera]] : [])]);
}
function removeDraftEntries(entries, all = false) {
  if (busy || !entries.length) return;
  const frozen = entries.some(r => r.submission);
  if (frozen) {
    if (!confirm('이미 서버에 접수된 사진이 있을 수 있습니다. 이 기기의 목록에서만 뺄까요?\n이미 등록한 사진은 취소되지 않습니다. 등록 취소는 내 사진에서 할 수 있습니다.')) return;
  } else if (all && !confirm('아직 올리지 않은 사진·영상 ' + entries.length + '개를 모두 삭제할까요?\n휴대폰 앨범과 이미 등록한 사진은 삭제하지 않습니다.')) return;
  for (const r of entries) URL.revokeObjectURL(r.url);
  selected = selected.filter(r => !entries.includes(r));
  if (!selected.length) for (const id of ['shootInput', 'videoInput', 'galleryInput']) el(id).value = '';
  el('progress').textContent = '';
  if (beautyWarmCandidate && entries.includes(beautyWarmCandidate.entry)) beautyWarmCandidate = null;
  if (el('notice').dataset.context === 'draft') notice('');
  persistDraft(); renderReview();
}
function setBusy(value) {
  busy = value;
  for (const id of ['home', 'shoot', 'shootVideo', 'choose', 'changePurpose', 'changeSettings', 'send', 'discard', 'message', 'keepMessage', 'email']) el(id).disabled = value;
  if (hasFrozen()) for (const id of ['message', 'keepMessage', 'email']) el(id).disabled = true;
  renderReview(); renderShare(); syncWakeLock();
}
// 올리는 동안에는 화면이 자동으로 꺼지지 않게 한다. 화면이 꺼지면 브라우저가 전송을 멈춘다.
async function syncWakeLock() {
  if (wakeLockPending || !navigator.wakeLock) return;
  const need = wakeNeeded();
  wakeLockPending = true;
  try {
    if (need && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    else if (!need && wakeLock) { const lock = wakeLock; wakeLock = null; await lock.release(); }
  } catch { wakeLock = null; }
  finally { wakeLockPending = false; }
  if (need !== wakeNeeded()) syncWakeLock();
}
// 백그라운드 전송 중에는 브라우저가 화면과 무관하게 올리므로 화면을 켜 둘 필요가 없다.
function wakeNeeded() { return ((busy && !backgroundActive) || originalRunning) && !document.hidden; }
// 안드로이드 Chrome의 백그라운드 전송(Background Fetch). 브라우저가 사진을 넘겨받아 다른 앱을 쓰거나
// 화면을 꺼도 계속 올리고, 알림에 진행률을 보여 준다. 지원하지 않는 기기(아이폰 등)는 null → 화면에서 올린다.
// 응답은 읽지 않는다. 무엇이 접수됐는지는 서버(known)에 물어 확인하므로 실패해도 화면 전송으로 이어진다.
async function backgroundTransfer(items) {
  try {
    if (!crypto.subtle || !('serviceWorker' in navigator) || !('BackgroundFetchManager' in window)) return null;
    const worker = await Promise.race([navigator.serviceWorker.ready, sleep(3000)]);
    if (!worker?.backgroundFetch) return null;
    const saved = storage.get('bgFetch');
    if (saved) {   // 앱을 닫았다 연 경우: 진행 중인 전송에 다시 붙는다.
      const live = await worker.backgroundFetch.get(saved.id);
      if (live && !live.result) return { worker, id: saved.id, registration: live };
      storage.set('bgFetch', null);
    }
    if (items.length < BACKGROUND_MIN || (await navigator.permissions.query({ name: 'background-fetch' })).state !== 'granted') return null;
    const legacyToken = new URLSearchParams(location.search).get('t') || storage.get('token');
    const requests = items.map(r => {
      const form = submissionForm(r);
      if (r.kind === 'video') { form.append('muted', '1'); form.append('video', r.file, r.file.name); }
      else { const file = r.beautyFile || r.file; form.append('originalName', file.name); form.append('photo', file, file.name); }
      return new Request('/live/api/camera/' + (r.kind === 'video' ? 'video' : 'photo'), { method: 'POST', body: form, headers: legacyToken ? { 'x-live-token': legacyToken } : {} });
    });
    const id = 'camera-archive-' + uuid();
    const registration = await Promise.race([worker.backgroundFetch.fetch(id, requests, { title: '교회사진 ' + items.length + '장 올리는 중', icons: [{ src: '/camera-icon-192.png', sizes: '192x192', type: 'image/png' }] }), sleep(10000)]);
    if (!registration) return null;
    storage.set('bgFetch', { id }); return { worker, id, registration };
  } catch { return null; }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// 인터넷이 끊겼거나 화면이 가려진 동안 실패했다면, 다시 보이고 연결될 때까지 기다린다.
function untilActive() {
  const active = () => !document.hidden && navigator.onLine !== false;
  if (active()) return Promise.resolve();
  return new Promise(resolve => {
    const check = () => { if (!active()) return; document.removeEventListener('visibilitychange', check); window.removeEventListener('online', check); resolve(); };
    document.addEventListener('visibilitychange', check); window.addEventListener('online', check);
  });
}
function submissionForm(r) {
  const s = r.submission, form = new FormData();
  for (const [key, value] of Object.entries({ mode: s.mode, target: JSON.stringify(s.target || {}), uploaderName: s.uploaderName,
    requestId: r.requestId, siteId: s.siteId, message: s.message, email: s.email, batchTotal: s.batchTotal,
    capturedAt: s.date, dateSource: s.dateSource, lastModified: r.file.lastModified || '' })) form.append(key, String(value ?? ''));
  return form;
}
// 첫 사진이 폴더를 만들면 그 뒤로는 실제 폴더 ID를 따라간다.
function followTarget(result, s) {
  if (result.upload?.target?.eventId && settings.target && s.target?.year === settings.target.year && (s.target.eventId === settings.target.eventId || (!settings.target.eventId && s.target.folderName === settings.target.folderName))) {
    settings.target = result.upload.target; if(settings.targetSource!=='common')rememberTarget(settings.target); storage.set('settings', settings);
  }
}
// 교회폴더 저장의 요청 ID는 사진과 설정으로 정한다. 같은 사진을 같은 곳에 다시 보내면 서버가 같은 접수로 본다.
async function archiveRequestId(r, s) {
  if (!crypto.subtle) return r.requestId;
  // 폴더는 연도와 이름으로만 본다. 첫 사진이 폴더를 만든 뒤 붙는 폴더 ID 때문에 ID가 달라지지 않게 한다.
  const effects=window.CameraBeauty.normalizeEffects(r.photoEffects);
  const hasExtraEffects=effects.color!=='none'||effects.frame!=='none'||!!effects.decorations?.length;
  const recipe=effects.decorations?{...effects,decorations:effects.decorations.map(({id,...visual})=>visual)}:effects;
  const text = JSON.stringify([r.kind || 'photo', r.file.name, r.file.size, r.file.lastModified, ...(r.beautyFile ? [r.beautyLevel, r.beautyFile.size, ...(hasExtraEffects ? [recipe] : []), ...(r.aiFile?[r.aiKind,r.aiFile.size,r.aiFile.lastModified]:[])] : []), s.target?.year, s.target?.folderName || s.target?.eventName, s.uploaderName, s.date]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return 'a-' + [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 48);
}
// 교회폴더에 저장: 모니터 순서와 무관하므로 여러 장을 동시에 올리고, 끊기면 스스로 다시 시도한다.
async function sendArchive(auto = false) {
  setBusy(true); const total = selected.length; let accepted = 0, skipped = 0, waiting = '';
  const batchKey = selected.find(r => r.submission)?.submission.batchKey || uuid();
  const progress = () => { el('progress').textContent = (accepted + skipped) + ' / ' + total + ' 접수 완료 · ' + (waiting || '올리는 중… 화면을 켜 두면 끝까지 올라갑니다.'); };
  const finish = async r => { URL.revokeObjectURL(r.url); selected = selected.filter(x => x !== r); progress(); await persistDraft(); };
  try {
    for (const r of selected) {
      if (!auto) { r.error = ''; r.fatal = false; }
      if (r.submission || auto) continue;
      r.submission = { ...structuredClone(settings), fast: false, message: '', email: '', batchKey, batchTotal: total, date: r.date, dateSource: r.dateSource };
      if (r.kind === 'video') r.submission.muted = true;
      r.requestId = await archiveRequestId(r, r.submission);
    }
    await persistDraft(); progress();
    // 이미 접수한 사진은 다시 올리지 않는다. 취소했거나 Drive에서 지운 사진은 새 접수로 다시 올린다.
    try {
      const { known } = await api('known', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestIds: selected.map(r => r.requestId) }) });
      for (const r of [...selected]) {
        const done = known[r.requestId]; if (!done) continue;
        if (done.cancelled || ['deleted', 'deleting', 'missing'].includes(done.archive)) r.requestId = uuid();
        else { skipped++; await finish(r); }
      }
    } catch {}
    const sendOne = async r => {
      for (let attempt = 0; ; attempt++) {
        try {
          const s = r.submission, form = submissionForm(r);
          let result;
          if (r.kind === 'video') { form.append('muted', '1'); form.append('video', r.file, r.file.name); result = await uploadVideo(form, () => {}); }
          else { const file = r.beautyFile || r.file; form.append('originalName', file.name); form.append('photo', file, file.name); result = await api('photo', { method: 'POST', body: form }); }
          waiting = ''; accepted++; followTarget(result, s); await finish(r); return;
        } catch (e) {
          if (e.backlog) { waiting = '서버가 Drive로 옮기는 중입니다. 잠시 후 이어서 올립니다.'; progress(); await sleep(20000); attempt--; continue; }
          const transient = !e.status || e.status >= 500 || e.status === 409;
          if (transient && (document.hidden || navigator.onLine === false)) { waiting = '연결을 기다리는 중입니다. 화면을 다시 열면 이어서 올립니다.'; progress(); await untilActive(); waiting = ''; progress(); attempt = -1; continue; }
          if (transient && attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
          r.error = e.message; r.fatal = !!e.status && e.status < 500; return;
        }
      }
    };
    const pending = () => selected.filter(r => r.submission && !(auto && r.fatal));
    let aborted = false;
    const background = await backgroundTransfer(pending());
    if (background) {
      backgroundActive = true; syncWakeLock();
      try {
        for (;;) {
          // 끝났는지를 먼저 읽고 서버에 확인한다. 순서가 반대면 마지막 사진을 놓칠 수 있다.
          const live = await background.worker.backgroundFetch.get(background.id).catch(() => null);
          const ended = !live || !!live.result || !!background.registration.result;
          aborted = (live || background.registration).failureReason === 'aborted';
          try {
            const { known } = await api('known', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestIds: pending().map(r => r.requestId) }) });
            for (const r of pending()) if (known[r.requestId] && !known[r.requestId].cancelled) { accepted++; await finish(r); }
          } catch {}
          if (ended || !pending().length) break;
          waiting = '백그라운드로 올리는 중입니다. 다른 앱을 쓰거나 화면을 꺼도 계속 올라갑니다.'; progress();
          await sleep(3000);
        }
      } finally { backgroundActive = false; waiting = ''; storage.set('bgFetch', null); syncWakeLock(); }
    }
    // 백그라운드 전송이 없거나 일부를 남기고 끝났으면 화면에서 이어서 올린다. 알림에서 직접 취소했으면 남겨 둔다.
    const queue = aborted ? [] : pending(), photos = queue.filter(r => r.kind !== 'video'), videos = queue.filter(r => r.kind === 'video');
    let cursor = 0;
    await Promise.all(Array.from({ length: ARCHIVE_PARALLEL }, async () => { while (cursor < photos.length) await sendOne(photos[cursor++]); }));
    for (const r of videos) await sendOne(r);
    el('progress').textContent = accepted + '장 서버 접수 완료' + (skipped ? ' · 이미 올린 사진 ' + skipped + '장은 건너뜀' : '') + (selected.length ? ' · ' + selected.length + '장은 올리지 못했습니다. 전송을 다시 눌러 주세요.' : ' · 같은 작업으로 계속 촬영하거나 사진을 선택하세요.');
    if(!selected.length&&(accepted||skipped)){lastCompletion={mode:'archive',count:accepted+skipped};workStage='done';}
    if (selected.length) notice('올리지 못한 사진이 있습니다. 사진을 확인하고 다시 시도해 주세요. 다시 전송해도 중복 접수하지 않습니다.', true, 'draft');
    else notice(skipped?'이미 보관한 사진 '+skipped+'장은 건너뛰었습니다.':'');
  } finally {
    if (!selected.length) { el('shootInput').value = ''; el('videoInput').value = ''; el('galleryInput').value = ''; }
    setBusy(false); await persistDraft(); renderOriginals(); runOriginals(); await loadHistory();
  }
}
// 화면이 다시 보이거나 인터넷이 돌아오면, 접수하다 끊긴 교회폴더 저장을 버튼 없이 이어서 보낸다.
function resumeArchive() {
  if (mode === 'archive' && !busy && currentPage === 'work' && !document.hidden && navigator.onLine !== false && selected.some(r => r.submission && !r.fatal)) sendArchive(true);
}
async function sendPhotos() {
  if (busy || !selected.length) return;
  if(!registrationReady())return;
  if(mode==='archive'&&!settings.target){openLocation();return;}
  expireEmail();
  if (mode !== 'archive' && config.mail && el('email').value && !el('email').checkValidity()){openDialog('optionsDialog');el('email').reportValidity();return;}
  if (mode === 'archive') return sendArchive();
  setBusy(true); originalController?.abort(); let accepted = 0; const originalCount = selected.length;
  const batchKey = selected.find(r => r.submission)?.submission.batchKey || uuid();
  try {
    for (const r of [...selected]) {
      if (!r.submission) r.submission = { ...structuredClone(settings), fast: mode !== 'archive', message: mode === 'archive' ? '' : el('message').value.trim(), email: mode !== 'archive' && config.mail ? el('email').value.trim() : '', batchKey, batchTotal: originalCount, date: r.date, dateSource: r.dateSource };
      r.submission.batchKey ||= batchKey;
      if (!await persistDraft()) { r.error = '사진 대기 목록을 기기에 저장하지 못했습니다. 저장 공간을 확인해 주세요.'; break; }
      el('progress').textContent = (accepted + 1) + ' / ' + originalCount + ' · ' + r.file.name + ' 접수하는 중…';
      const s = r.submission, form = submissionForm(r);
      try {
        if (r.kind === 'video') {
          // 영상은 한 번에 올리고, 서버가 모니터용으로 변환해 게시한다. 미리보기·원본 분리 전송과 공유 묶음은 쓰지 않는다.
          s.muted ??= el('muteVideo').checked;
          form.append('muted', s.muted ? '1' : '0'); form.append('video', r.file, r.file.name);
          const label = (accepted + 1) + ' / ' + originalCount + ' · ' + r.file.name;
          await uploadVideo(form, ratio => { el('progress').textContent = label + (ratio < 1 ? ' 올리는 중 ' + Math.floor(ratio * 100) + '% · 화면을 닫지 마세요' : ' 서버에서 확인하는 중…'); });
          accepted++; rememberMessage(s.message); URL.revokeObjectURL(r.url); selected = selected.filter(x => x !== r);
          await persistDraft(); continue;
        }
        if (s.fast && !r.previewFile) {
          try { r.previewFile = await sharingFile(r.beautyFile || r.file, r.requestId, 2048, 0.82); }
          catch { r.previewFile = r.beautyFile || r.file; notice('이 사진 형식은 기기에서 축소할 수 없어 원본 전송 후 표출합니다.', true); }
          if (!await persistDraft()) throw new Error('전송 대기 사진을 저장하지 못했습니다.');
        }
        const transfer = s.fast ? r.previewFile : r.file;
        form.append('originalName', r.file.name); form.append('photo', transfer, transfer.name);
        const result = await api(s.fast ? 'preview' : 'photo', { method: 'POST', body: form });
        if (s.fast && s.mode === 'both' && !result.upload.cancelled && !originals.some(p => p.id === result.upload.id)) originals.push({ id: result.upload.id, key: r.key, file: r.file, target: result.upload.target || s.target, error: '' });
        accepted++; rememberMessage(s.message); URL.revokeObjectURL(r.url); selected = selected.filter(x => x !== r);
        if (s.mode !== 'archive') {
          if (shareBatch?.key !== s.batchKey) shareBatch = { key: s.batchKey, mode: s.mode, ts: Date.now(), siteName: s.siteName, photos: [] };
          if (!result.upload?.cancelled && !shareBatch.photos.some(p => p.id === result.upload.id)) {
            let file = r.previewFile; if (!file) { try { file = await sharingFile(r.file, result.upload.id); } catch { file = r.file; } }
            shareBatch.photos.push({ id: result.upload.id, file });
          }
        }
        followTarget(result, s);
      } catch (e) { r.error = e.message; }
      await persistDraft();
    }
    el('progress').textContent = accepted + '장 서버 접수 완료' + (selected.length ? ' · ' + selected.length + '장 응답 확인 필요. 같은 설정으로 재시도해 주세요.' : ' · 같은 작업으로 계속 촬영하거나 사진을 선택하세요.');
    if(!selected.length&&accepted){lastCompletion={mode,shareKey:shareBatch?.key===batchKey?batchKey:null,count:accepted};workStage='done';}
    if (selected.length) notice('전송하지 못했거나 응답을 확인하지 못한 사진을 대기 목록에 남겼습니다. 재시도해도 중복 접수하지 않습니다.', true, 'draft');
    else notice('');
    if (accepted && mode !== 'archive' && el('email').value) rememberEmail(true);
    if (!el('keepMessage').checked) el('message').value = '';
  } finally {
    if (!selected.length) { el('shootInput').value = ''; el('videoInput').value = ''; el('galleryInput').value = ''; }
    setBusy(false); await persistDraft(); renderOriginals(); runOriginals(); await loadHistory();
  }
}
function renderOriginals() {
  renderCaptureLog();
  el('originalTransfers').hidden = !originals.length;
  el('originalTransferState').textContent = '원본 전송 대기 ' + originals.length + '장' + (originalRunning ? ' · 전송 중' : '');
  el('originalTransferList').replaceChildren(...originals.map(p => node('p', p.file.name + ' · ' + (p.error || '서버 원본 접수 대기'), 'hint')));
  el('retryOriginals').disabled = originalRunning || busy; homeSummary();
  const pending = [...uploadStates.values()].filter(r => r.pipeline && !r.cancelled && !r.target && r.mode === 'both').length;
  el('pendingLocation').textContent = (settings?.target ? '다음 사진 보관: ' + settings.target.year + ' / ' + (settings.target.folderName || settings.target.eventName) : '저장 위치를 지정해 주세요.') + (pending ? ' · 위치 지정 필요 ' + pending + '장' : '');
  renderFlow();
}
async function runOriginals() {
  if (originalRunning || busy || !originals.some(p => !p.error)) return;
  originalRunning = true; renderOriginals(); syncWakeLock();
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
    originalController = null; originalRunning = false; syncWakeLock(); await persistDraft(); renderOriginals(); loadHistory();
    if (!busy && originals.some(p => !p.error)) queueMicrotask(runOriginals);
  }
}
el('retryOriginals').onclick = () => { originals.forEach(p => p.error = ''); persistDraft(); runOriginals(); };
el('saveLocation').onclick = async () => {
  if (assigningLocation) return;
  let target; try { target = validatedTarget(); } catch (error) {el('locationError').textContent=error.message;return;}
  assigningLocation = true; el('saveLocation').disabled = true;
  // Snapshot IDs: changing the next-photo destination never retargets pictures
  // that already have a destination, or later photos from another task.
  const ids = [...new Set([...uploadStates.values()].filter(r => r.pipeline && r.mode === 'both' && !r.cancelled && !r.target).map(r => r.id).concat(originals.filter(p => !p.target).map(p => p.id)))];
  settings.target = target;settings.targetSource='device'; rememberTarget(target); storage.set('settings', settings);
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
    if(!failed&&el('locationDialog').open)closeDialog('locationDialog');
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
        states.push(r.live === 'withdrawn' ? '모니터 게시 취소' + (r.mode === 'both' ? ' · 보관은 유지' : '') : displayed ? '모니터 표시 확인 ' + displayed + '곳' : r.live === 'sent' ? '모니터 전달 요청 완료 · 표시 확인 대기' : r.live === 'pending' ? (r.kind === 'video' ? '모니터용 영상으로 변환 중 · 끝나면 자동 게시' : '모니터 처리 결과 미확인') : '모니터 표출 실패');
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
      settings.target = resolved.target; if(settings.targetSource!=='common')rememberTarget(settings.target); storage.set('settings', settings); persistDraft();
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
el('changePurpose').onclick = () => leaveDialog('moreDialog',()=>{if(canEdit())view('purpose');});
el('changeSettings').onclick = () => leaveDialog('moreDialog',()=>{if(canEdit())openSetup(settings.mode);});
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
el('eventName').oninput = updateNewPath;
el('eventDate').onchange = updateNewPath;
el('continueResume').onclick = () => { if (settings) {workStage=selected.length?'review':'capture'; showWork();if(!selected.length)openDialog('statusDialog'); if (storage.get('bgFetch')) resumeArchive(); } };
for (const [button, input] of [['shoot', 'shootInput'], ['shootVideo', 'videoInput'], ['choose', 'galleryInput']]) {
  el(button).onclick = async () => {
    if (busy) return;
    beautyWarmCandidate = null;
    beautyWarmup.clear();
    // 폰은 항상 폰 카메라 앱으로 찍는다. PC에는 카메라 앱이 없으므로 화면 안 카메라를 연다.
    if (button === 'shoot' && !isMobile) {
      if (!navigator.mediaDevices?.getUserMedia) return notice('이 브라우저에서는 카메라를 사용할 수 없습니다. 사진 파일을 선택해 주세요.', true);
      if (!await openInPageCamera()) notice('카메라 연결과 브라우저의 카메라 허용 여부를 확인해 주세요. 사진 파일 선택도 사용할 수 있습니다.', true);
      return;
    }
    nativeCapture(input);
  };
  el(input).onchange = () => addFiles(el(input).files, input === 'videoInput' || input === 'shootInput');
  el(input).addEventListener('cancel', () => clearCapturePending());
}
el('closeCamera').onclick = () => closeDialog('cameraDialog');
el('flipCamera').onclick = async () => {
  cameraFacing = cameraFacing === 'environment' ? 'user' : 'environment';
  if (!await openInPageCamera()) notice('다른 쪽 카메라를 열지 못했습니다.', true);
};
// 파일 창은 누른 동작 안에서 먼저 연 뒤 카메라 화면을 닫는다.
el('nativeCamera').onclick = () => { nativeCapture('shootInput'); closeDialog('cameraDialog'); };
el('cameraDialog').addEventListener('close', () => { cameraStream?.getTracks().forEach(track => track.stop()); cameraStream = null; el('cameraVideo').srcObject = null; });
el('snap').onclick = async () => {
  const video = el('cameraVideo');
  if (!video.videoWidth) return notice('카메라가 준비되면 다시 촬영해 주세요.', true);
  el('snap').disabled = true;
  try {
    const blob = await takeStill(video);
    if (!blob) throw new Error('capture');
    const file = new File([blob], '촬영_' + Date.now() + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
    const closed = new Promise(resolve => el('cameraDialog').addEventListener('close', resolve, { once: true }));
    closeDialog('cameraDialog'); await closed; await addFiles([file], true);
  } catch { notice('사진을 만들지 못했습니다. 다시 촬영해 주세요.', true); }
  finally { el('snap').disabled = false; }
};
window.addEventListener('pagehide', () => { beautyWarmCandidate = null; beautyWarmup.clear(); cameraStream?.getTracks().forEach(track => track.stop()); });
el('send').onclick = () => { beautyWarmCandidate = null; beautyWarmup.clear(); return sendPhotos(); };
el('discard').onclick = () => removeDraftEntries([...selected], true);
el('refreshHistory').onclick = loadHistory;
el('message').oninput = () => { el('messageCount').textContent = el('message').value.length; persistDraft(); renderMessageChips(); }; el('keepMessage').onchange = () => persistDraft();
el('email').oninput = () => rememberEmail(); el('clearEmail').onclick = clearEmail;
setInterval(expireEmail, 30000);
document.addEventListener('visibilitychange', () => { syncWakeLock(); if (document.hidden) beautyWarmup.clear(); else { watchCaptureReturn(); resumeCapturedWarmup(); expireEmail(); resumeArchive(); } });
el('clearCaptureLog').onclick = () => { storage.set('captureLog', []); storage.set('captureCount', 0); renderCaptureLog(); };
for (const event of ['pointerdown', 'keydown', 'input']) document.addEventListener(event, () => beautyWarmup.touch(), { passive: true });
window.addEventListener('beforeunload', event => { if ((busy && !backgroundActive) || originals.length) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('online', () => { notice('인터넷에 다시 연결되었습니다. 대기 사진을 확인하고 전송해 주세요.'); originals.forEach(p => p.error = ''); runOriginals(); loadHistory(); resumeArchive(); });
window.addEventListener('offline', () => notice('인터넷 연결이 끊겼습니다. 선택한 사진은 대기 목록에 유지합니다.', true));
async function init() {
  try {
    migrateLegacyState();
    config = await api('config');
    sitesReady=true;
    const recentFolder = storage.get('lastTarget')||config.currentEvent;
    requestFolders(String(recentFolder?.year || config.year), recentFolder?.yearId || '').catch(() => {});
    const draft = await readDraft();
    originals = draft?.originals || [];
    shareBatch = draft?.shareBatch || null;
    const savedEmail = storage.get('email');
    if (savedEmail && Date.now() - savedEmail.at < MAIL_KEEP_MS) el('email').value = savedEmail.address;
    else storage.set('email', null);
    const previous=storage.get('settings')||{};
    if(previous.target&&previous.targetSource!=='common'&&!storage.get('lastTarget'))rememberTarget(previous.target);
    const siteId=storage.get('lastSite')||previous.siteId||(config.sites.length===1?config.sites[0].id:'');
    settings=draft?.entries?.length&&labels[draft.settings?.mode]?draft.settings:{mode:'both',uploaderName:previous.uploaderName||storage.get('name')||'',...targetDefault(),siteId,siteName:config.sites.find(s=>s.id===siteId)?.name||''};
    if(settings.target&&!settings.targetSource)settings.targetSource='device';
    mode=settings.mode;el('uploader').value=settings.uploaderName||'';el('site').value=settings.siteId||'';
    if (draft?.entries?.length && settings) {
      selected = draft.entries.map(r => ({ ...r, url: '' }));   // 표시용 URL 은 검토 화면을 그릴 때 만든다
      el('message').value = draft.message || ''; el('keepMessage').checked = !!draft.keepMessage;
      // 복원 안내는 실제 목록을 보여주는 resume 버튼 하나로 제공한다.
      // 일반 notice에 장수를 남겨 두면 삭제 후에도 오래된 안내가 남는다.
      if (draft.lost) notice('저장하지 못한 사진 ' + draft.lost + '장은 다시 선택해 주세요. 이미 올라간 사진은 다시 올리지 않습니다.', true);
    } else if (draft?.lost) { notice('화면이 닫혀 올리던 사진 ' + draft.lost + '장이 대기 목록에서 빠졌습니다. 같은 사진을 다시 선택하면 이미 올라간 사진은 건너뛰고 나머지만 올립니다.', true);
    }
    // 대기 사진이 있어도 알린다. 사진이 도착했다면 addFiles 가 이 표시를 지웠을 것이다.
    checkCaptureInterrupted();
    if (settings?.target && settings.targetSource==='device'&&!storage.get('lastTarget')) rememberTarget(settings.target);
    storage.set('settings',settings);
    workStage='capture';navigation = { camera: true, page: 'work', depth: 0 }; history.replaceState(navigation, '');showWork(false);
    if (!isMobile) el('choose').textContent = '사진·영상 파일 선택';
    if (!isMobile && !navigator.mediaDevices?.getUserMedia) { el('shoot').disabled = true; el('shoot').title = '카메라를 사용할 수 있는 기기에서 촬영해 주세요.'; }
    renderOriginals(); runOriginals();
    // 앱을 닫은 사이에도 백그라운드 전송이 이어지고 있으면 알려 준다.
    const saved = storage.get('bgFetch');
    if (saved && 'serviceWorker' in navigator) Promise.race([navigator.serviceWorker.ready, sleep(3000)]).then(async worker => {
      const live = await worker?.backgroundFetch?.get(saved.id);
      if (live && !live.result) notice('백그라운드로 사진을 올리고 있습니다. 작업 이어가기에서 진행 상황을 볼 수 있습니다.');
      else storage.set('bgFetch', null);
    }).catch(() => {});
  } catch (e) { notice(e.message, true); }
}
init();
setInterval(() => { if (!document.hidden && !el('work').hidden && !busy) loadHistory(); }, 5000);
