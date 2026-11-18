// Commander Life service worker: caches the app so it opens with no internet.
// When you upload a new version of the app, change VERSION so phones pick it up.
const VERSION = 'v66';
const CACHE = 'commander-life-' + VERSION;
const DOOM_CACHE = 'commander-doom-v4';   // bump this name whenever the doom/ files change
const FILES = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => (k.startsWith('commander-life-') && k !== CACHE) || (k.startsWith('commander-doom-') && k !== DOOM_CACHE)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache first (instant + offline), refresh the cache in the background for next time.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // The hidden Doom files are big: keep them in their own cache (survives app updates) and never re-download them.
  if (new URL(e.request.url).pathname.includes('/doom/')) {
    e.respondWith(caches.open(DOOM_CACHE).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(res => { if (res && res.ok && !/text\/html/i.test(res.headers.get('content-type') || '')) c.put(e.request, res.clone()); return res; }))));
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(cached => {
      const refresh = fetch(e.request).then(res => {
        if (res && res.ok && new URL(e.request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || refresh;
    })
  );
});
