/**
 * Whispering Hollow — service worker.
 *
 * Strategy, by resource type:
 *
 * - **Next.js build assets** (`/_next/static/**`) — cache-first, forever. These
 *   URLs contain a content hash, so a changed file is a changed URL and stale
 *   cache is impossible.
 * - **Navigations** (the HTML document) — network-first with a cache fallback.
 *   Always fresh when online; still opens when not.
 * - **Everything else same-origin** — stale-while-revalidate: serve the cached
 *   copy immediately, fetch a fresh one in the background for next time.
 *
 * Because the game generates every texture and every sound procedurally, an
 * offline install genuinely works — there are no assets left to be missing.
 */

const VERSION = 'v1';
const STATIC_CACHE = `wh-static-${VERSION}`;
const RUNTIME_CACHE = `wh-runtime-${VERSION}`;
const DOCUMENT_CACHE = `wh-documents-${VERSION}`;

/** Minimal shell precached on install. */
const PRECACHE = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) =>
        // Individually, so one 404 doesn't abort the whole install.
        Promise.allSettled(PRECACHE.map((url) => cache.add(url))),
      )
      // Activate immediately rather than waiting for every tab to close.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('wh-') && !key.endsWith(VERSION))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET is cacheable.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  /* Never touch Firebase or analytics traffic. Caching an auth token or a
   * presence write would be actively harmful. */
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: network-first.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(DOCUMENT_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached ?? caches.match('/')),
        ),
    );
    return;
  }

  // Hashed build assets: cache-first, and they never change.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
    return;
  }

  // Everything else: stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);

      return cached ?? network;
    }),
  );
});

/** Allows the page to trigger an immediate update. */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
