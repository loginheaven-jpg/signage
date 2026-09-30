const originalFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (response.status === 401) location.replace('/login?role=admin');
  return response;
};
const controls = document.createElement('div');
controls.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:99;padding:8px;background:white;border:1px solid #ddd;border-radius:10px;font-size:12px';
controls.innerHTML = '<button id="adminLogout">로그아웃</button> <button id="adminRevoke">관리 단말 전체 로그아웃</button>';
document.body.append(controls);
document.getElementById('adminLogout').onclick = async () => {
  if ((await fetch('/auth/logout', {method:'POST'})).ok) location.replace('/login?role=admin');
};
document.getElementById('adminRevoke').onclick = async () => {
  if (!confirm('이 브라우저를 포함한 모든 관리 단말에서 다시 로그인하도록 할까요? 설치형 모니터 재생은 유지됩니다.')) return;
  if ((await fetch('/auth/revoke', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:'admin'})})).ok) location.replace('/login?role=admin');
};
