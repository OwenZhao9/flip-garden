// Service worker: caches ONLY this page's own static shell so the app opens offline and installs to the home screen.
// It never touches another origin (the Monad RPC, Kuru Flow, the explorer) and never caches a POST, so no RPC answer,
// quote or balance is ever stored or replayed. VERSION is stamped at build time (web/build-dist.mjs) from the bundle's
// hash, so a new deploy gets a new cache and the old one is deleted.
const VERSION = '__VERSION__';
const CACHE = `flip-garden-${VERSION}`;
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'garden3d.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('flip-garden-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // everything else goes straight to the network
  // network first, so a deploy shows up at once; the cache answers only when offline. 'no-cache' makes the browser ask the
  // server (a cheap 304 when unchanged) instead of reusing its own HTTP cache, which on GitHub Pages kept the previous
  // app.js for up to ten minutes after a deploy.
  e.respondWith(
    fetch(req.url, { cache: 'no-cache' }) // by URL: a navigation Request cannot be re-sent with options
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))),
  );
});
