// No authenticated pages, API responses, photographs or credentials enter the cache.
const CACHE = 'camera-offline-v1';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.add('/camera-offline.html')).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('camera-offline-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
// 백그라운드 전송(교회폴더 대량 저장)이 끝나면 알림 문구만 바꾼다. 응답은 읽지 않는다 —
// 무엇이 접수됐는지는 앱이 서버에 물어 확인하고, 남은 사진은 앱이 이어서 올린다.
for (const type of ['backgroundfetchsuccess', 'backgroundfetchfail']) {
  self.addEventListener(type, event => {
    event.waitUntil(event.updateUI({ title: type === 'backgroundfetchsuccess' ? '교회사진 올리기를 마쳤습니다' : '교회사진 일부를 올리지 못했습니다 · 눌러서 이어 올리기' }).catch(() => {}));
  });
}
self.addEventListener('backgroundfetchclick', event => {
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then(windows => {
    const open = windows.find(client => new URL(client.url).origin === self.location.origin);
    return open ? open.focus() : self.clients.openWindow('/camera');
  }).catch(() => {}));
});
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate' || event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !['/', '/camera', '/m', '/m.html'].includes(url.pathname)) return;
  event.respondWith(fetch(event.request).catch(() => caches.match('/camera-offline.html')));
});
