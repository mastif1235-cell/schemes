// Блокнот-скан v3.3.9 — integrated app shell
const CACHE = 'blocknot-shell-v30';
const SHELL = [
  './', './index.html', './manifest.json', './icon.svg',
  './chunk1.txt', './chunk2.txt', './chunk3.txt', './chunk4.txt',
  './v3-enhancements.txt', './v3-sync.js', './v3-fixes.js', './v3-hotfix.js', './v3-collab.js', './v3-ux323.js', './v3-auditfix.js', './v3-polish326.js', './v3-crop327.js', './v3-ui328.js', './v3-history329.js', './v3-viewer331.js', './v3-member332.js', './v3-history333.js', './v3-orientation334.js', './v3-hotfix337.js', './v3-cover338.js'
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

  if (e.request.mode === 'navigate' || url.pathname.endsWith('/index.html')) {
    e.respondWith(
      fetch(e.request, {cache:'no-store'}).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put('./index.html', copy));
        return resp;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  if (url.searchParams.has('v') || url.searchParams.has('appv') || url.searchParams.has('_refresh')) {
    e.respondWith(fetch(e.request, {cache:'no-store'}).catch(() => {
      const clean = new Request(url.origin + url.pathname, {credentials:'same-origin'});
      return caches.match(clean).then(r => r || caches.match(e.request));
    }));
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
    caches.match(normalized).then(cached => cached || caches.match(e.request).then(exact => exact || fetch(e.request)))
  );
});
