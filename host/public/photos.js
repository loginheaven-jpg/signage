'use strict';
const $ = id => document.getElementById(id);
let offset = 0;
let requestSequence = 0;
let toastTimer;
let lastGridSignature = '';
const labels = { saved: '드라이브 보관 완료', pending: '서버 보관 · 드라이브 전송 대기', error: '서버 보관 · 전송 재시도 중', deleting: '삭제 처리 중' };
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
  $('connectionText').textContent = status.error || `${status.folderName || '지정 폴더'} · 보관 완료 ${status.counts.saved}장${waiting ? ' · 전송 대기 ' + waiting + '장' : ''}`;
  if (!status.ready && !status.oauthConfigured) $('connectionText').textContent += ' 개인 드라이브를 사용하려면 서버 관리자가 Google 계정 연결 설정을 먼저 완료해야 합니다.';
  if (status.oauthConfigured && status.pickerConfigured === false) $('connectionText').textContent += ' Google 폴더 선택 기능 설정이 필요합니다.';
  $('driveLink').href = 'https://drive.google.com/drive/folders/' + encodeURIComponent(status.folderId);
  $('connect').hidden = !status.oauthConfigured || status.pickerConfigured === false || (status.ready && status.authMode === 'service-account');
  $('connect').textContent = status.authMode === 'oauth' ? 'Google 계정 다시 연결' : 'Google 계정 연결';
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
  const image = photo.status === 'deleting' ? node('div', 'preview') : node('img', 'preview');
  if (photo.status !== 'deleting') image.src = photo.url;
  image.alt = photo.message || '보관 사진'; image.loading = 'lazy'; image.decoding = 'async';
  image.addEventListener('click', () => { $('previewImage').src = photo.url; $('preview').showModal(); });
  image.addEventListener('error', () => { image.alt = '사진을 불러오지 못했습니다. 연결 후 새로고침해 주세요.'; });
  const details = node('div', 'details');
  details.append(node('p', 'caption', photo.message || '문구 없음'), node('div', 'meta', dates.format(new Date(photo.ts))), node('div', 'meta', photo.siteName || '드라이브 사진'));
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
    actions.append(download, copy);
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
    const data = await api('/api/photos?' + new URLSearchParams({ date: $('date').value, offset }));
    if (seq !== requestSequence) return;
    if (offset && offset >= data.total) { offset = Math.max(0, Math.floor((data.total - 1) / 40) * 40); return load(); }
    renderStatus(data.status);
    const signature = JSON.stringify([data.photos, $('date').value, offset]);
    if (signature !== lastGridSignature) {
      $('grid').replaceChildren(...data.photos.map(card));
      if (!data.photos.length) $('grid').append(node('div', 'empty', $('date').value ? '이 날짜에 등록한 사진이 없습니다.' : '아직 보관된 사진이 없습니다. 휴대폰에서 올린 사진이 여기에 나타납니다.'));
      lastGridSignature = signature;
    }
    $('count').textContent = `사진 ${data.total}장`;
    $('page').textContent = `${Math.floor(offset / 40) + 1} / ${Math.max(1, Math.ceil(data.total / 40))}`;
    $('prev').disabled = offset === 0; $('next').disabled = offset + 40 >= data.total;
  } catch (e) { if (seq === requestSequence) { $('connectionTitle').textContent = '목록을 불러오지 못했습니다'; $('connectionText').textContent = e.message; } }
}
$('date').addEventListener('change', () => { offset = 0; load(); });
$('all').addEventListener('click', () => { $('date').value = ''; offset = 0; load(); });
$('prev').addEventListener('click', () => { offset = Math.max(0, offset - 40); load(); });
$('next').addEventListener('click', () => { offset += 40; load(); });
$('refresh').addEventListener('click', async () => {
  lastGridSignature = '';
  try { await api('/api/photos/sync', { method: 'POST' }); await load(); toast('드라이브와 동기화 중입니다. 완료되면 목록이 갱신됩니다.'); } catch (e) { toast(e.message); }
});
$('closePreview').addEventListener('click', () => $('preview').close());
const connection = new URLSearchParams(location.search).get('connection');
if (connection === 'select-folder') {
  $('folderSelection').hidden = false;
  toast('사진 보관 폴더를 선택해 연결을 마무리해 주세요.');
} else if (connection) {
  toast(({ success: 'Google 계정 연결 완료. 대기 사진을 자동 보관합니다.', cancelled: 'Google 계정 연결을 취소했습니다.', failed: '계정 연결에 실패했습니다. 자동 보관 권한과 Google 연결 설정을 확인해 주세요.', 'scope-required': 'Google 계정에서 이 앱의 기존 접근 권한을 해제한 뒤 사진 전용 권한으로 다시 연결해 주세요.' })[connection] || '');
  history.replaceState(null, '', '/photos');
}
load();
setInterval(() => { if (!document.hidden && !$('preview').open && !document.querySelector('.actions button:disabled')) load(); }, 15000);
