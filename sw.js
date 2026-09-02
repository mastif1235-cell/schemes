// Блокнот-скан v3.4.1 — atomic offline application shell.
const CACHE_PREFIX = 'blocknot-shell-';
const CACHE = CACHE_PREFIX + 'v341-stable-2';
const SHELL = [
  './', './index.html', './manifest.json', './icon.svg',
  './app-v3-manifest.json',
  './chunk1.txt', './chunk2.txt', './chunk3.txt', './chunk4.txt',
  './v3-enhancements.txt', './v3-sync.js', './v3-core.js', './v3-photos.js',
  './v3-camera.js', './v3-history.js', './v3-ui.js'
];

self.addEventListener('install', (e) => {
  // addAll is intentionally atomic at the Service Worker lifecycle level: if any
  // required file is unavailable, this worker never replaces the previous one.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (e.request.mode === 'navigate' || url.pathname.endsWith('/index.html')) {
    e.respondWith(
      caches.match('./index.html').then(cached => cached || fetch(e.request, {cache:'no-store'}))
    );
    return;
  }

  const normalized = new Request(url.origin + url.pathname, {
    method: 'GET',
    headers: e.request.headers,
    mode: 'same-origin',
    credentials: e.request.credentials,
    redirect: e.request.redirect
  });

  e.respondWith(
    caches.match(normalized).then(cached => cached || caches.match(e.request).then(exact =>
      exact || fetch(normalized, {cache:'no-store'})
    ))
  );
});
