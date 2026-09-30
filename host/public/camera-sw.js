// No authenticated pages, API responses, photographs or credentials enter the cache.
const CACHE = 'camera-offline-v1';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.add('/camera-offline.html')).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('camera-offline-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate' || event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !['/', '/camera', '/m', '/m.html'].includes(url.pathname)) return;
  event.respondWith(fetch(event.request).catch(() => caches.match('/camera-offline.html')));
});
