// sw.js — caches the app shell only. Audio lives in IndexedDB as blobs and is
// never fetched over the network, so it is never cached or requested here.
// VERSION is stamped by build_deploy.sh with a hash of the shipped files, so every
// deploy installs a fresh, complete, atomic snapshot of the shell.
const VERSION = 'abn-shell-faaedd2257c9';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './storage.js', './id3.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // cache: 'reload' bypasses the HTTP cache (GitHub Pages sends max-age=600),
    // so a new worker never precaches stale files. addAll is all-or-nothing.
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    // Users coming from the old stale-while-revalidate workers (v1/v2): replace it right away
    // (its cache may already be mixed). Later updates wait for the in-app prompt.
    if ((await caches.has('abn-shell-v1')) || (await caches.has('abn-shell-v2'))) await self.skipWaiting();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('abn-shell-') && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    // Cache-first from this version's snapshot only, so index.html, app.js and
    // storage.js always come from the same deploy. Updates arrive as a new worker.
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req.mode === 'navigate' ? './index.html' : req, { ignoreSearch: true });
    if (hit) return hit;
    try { return await fetch(req); }
    catch (_) { return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }); }
  })());
});
