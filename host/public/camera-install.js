if ('serviceWorker' in navigator) navigator.serviceWorker.register('/camera-sw.js').catch(() => {});
const bar = document.createElement('div');
bar.style.cssText = 'padding-top:12px;font:13px system-ui;border-top:1px solid #dce3dc';
bar.innerHTML = '<button type="button" id="cameraInstall" style="padding:10px">홈 화면에 설치</button> <button type="button" id="cameraLogout" style="padding:10px">로그아웃</button><p id="cameraInstallHelp" style="margin-top:8px"></p>';
(document.getElementById('moreDialog') || document.body).append(bar);
let installPrompt;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });
document.getElementById('cameraInstall').onclick = async () => {
  if (installPrompt) { await installPrompt.prompt(); installPrompt = null; return; }
  document.getElementById('cameraInstallHelp').textContent = /iPad|iPhone|iPod/.test(navigator.userAgent)
    ? 'Safari의 공유 버튼 → 홈 화면에 추가를 선택하세요.'
    : '브라우저 메뉴에서 앱 설치 또는 홈 화면에 추가를 선택하세요. 카카오톡 안에서는 기본 브라우저로 먼저 열어 주세요.';
};
document.getElementById('cameraLogout').onclick = async () => {
  const response = await fetch('/auth/logout', { method: 'POST' });
  if (response.ok) location.replace('/login?role=camera');
};
