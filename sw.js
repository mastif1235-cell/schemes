// Блокнот-скан — atomic offline application shell. Release identity comes from version.json
// through the generated version.js bridge, so the cache name always matches the release.
importScripts('./version.js');
const CACHE_PREFIX = 'blocknot-shell-';
const RELEASE = String(self.__BLOCKNOT_VERSION__ || '').replace(/[^0-9A-Za-z.]/g, '');
if (!RELEASE) throw new Error('version.js did not provide a release version');
const CACHE = CACHE_PREFIX + 'v' + RELEASE;
const SHELL = [
  './', './index.html', './manifest.json', './icon.svg',
  './app-v3-manifest.json',
  './version.json', './version.js',
  './chunk1.txt', './chunk2.txt', './chunk3.txt', './chunk4.txt',
  './v3-sync.js', './v3-core.js', './v3-photos.js',
  './v3-camera.js', './v3-history.js', './v3-ui.js'
];

self.addEventListener('install', (e) => {
  // addAll is intentionally atomic at the Service Worker lifecycle level: if any
  // required file is unavailable, this worker never replaces the previous one.
  e.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(SHELL.map(url => new Request(new URL(url, self.location.href), {cache:'reload'})));
    const version = await (await c.match('./version.json')).json();
    const manifest = await (await c.match('./app-v3-manifest.json')).json();
    if (version.version !== RELEASE || manifest.version !== RELEASE || !Array.isArray(manifest.files)) {
      throw new Error('Mixed release in offline cache');
    }
    for (const entry of manifest.files) {
      const response = await c.match('./' + entry.path);
      if (!response) throw new Error('Incomplete offline cache');
      const bytes = new TextEncoder().encode((await response.text()).replace(/\r\n?/g, '\n'));
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2,'0')).join('');
      if (hash !== entry.sha256) throw new Error('Mixed runtime in offline cache: ' + entry.path);
    }
  }));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (e.request.mode === 'navigate' || url.pathname.endsWith('/index.html')) {
    e.respondWith(
      caches.open(CACHE).then(c => c.match('./index.html')).then(cached => cached || fetch(e.request, {cache:'no-store'}))
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
    caches.open(CACHE).then(c => c.match(normalized).then(cached => cached || c.match(e.request).then(exact =>
      exact || fetch(normalized, {cache:'no-store'})
    )))
  );
});
