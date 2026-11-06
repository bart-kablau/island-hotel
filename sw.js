// Keeps the app itself available without internet. The bookings are not cached here:
// Firestore keeps its own offline copy in the browser.
const VERSION = 'ih-8';
const SHELL = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'img/logo-192.png', 'img/logo-512.png',
  'js/app.js', 'js/logic.js', 'js/ops.js', 'js/config.js'];
const SDK = 'https://www.gstatic.com/firebasejs/11.10.0/';
const SDK_FILES = ['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js'].map(f => SDK + f);

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll([...SHELL, ...SDK_FILES])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const own = url.origin === location.origin;
  const cdn = url.href.startsWith(SDK) || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!own && !cdn) return; // Firestore, sign-in: straight to the network
  // Own files: network first (so an update arrives), cache when offline. CDN: cache first.
  e.respondWith(own
    ? fetch(e.request).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return r; })
        .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
    : caches.match(e.request).then(r => r || fetch(e.request).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return res; })));
});
