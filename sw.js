// Блокнот-скан v3.0.3 — integrated app shell
const CACHE = 'blocknot-shell-v7';
const SHELL = [
  './', './index.html', './manifest.json', './icon.svg',
  './chunk1.txt', './chunk2.txt', './chunk3.txt', './chunk4.txt',
  './v3-enhancements.txt'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Для самого приложения сначала проверяем сеть, чтобы новые версии не
  // застревали в старом кэше. При отсутствии сети остаётся офлайн-копия.
  if (e.request.mode === 'navigate' || url.pathname.endsWith('/index.html')) {
    e.respondWith(
      fetch(e.request).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return resp;
      }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});