/**
 * Zenith Mindful Health & Fitness Tracker — Service Worker (sw.js)
 * 100% Offline-First Cache-First Architecture for GitHub Pages & iOS Home Screen PWA
 */

const CACHE_NAME = 'zenith-v5';

// Strictly relative asset paths so deployment works seamlessly at root (/) or GitHub Pages subfolders (/repo-name/)
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache each core asset resiliently using relative URLs resolved against self.registration.scope
      const scopeUrl = self.registration ? self.registration.scope : self.location.href;
      const requests = CORE_ASSETS.map((relativePath) => {
        const resolvedUrl = new URL(relativePath, scopeUrl).toString();
        return new Request(resolvedUrl, { cache: 'reload' });
      });
      await Promise.allSettled(
        requests.map((req) =>
          fetch(req).then((response) => {
            if (response && response.ok) {
              return cache.put(req, response);
            }
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((staleCache) => caches.delete(staleCache))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(request.url);

  // Security guard: Only cache same-origin requests
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  // Handle navigation requests (HTML page loads / iOS Home Screen launches) with Cache-First + Offline Fallback
  if (request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const scopeUrl = self.registration ? self.registration.scope : self.location.href;
        const indexUrl = new URL('./index.html', scopeUrl).toString();
        const rootUrl = new URL('./', scopeUrl).toString();

        // 1. Check cache first for instant zero-latency offline startup
        const cachedPage =
          (await cache.match(request, { ignoreSearch: true })) ||
          (await cache.match(indexUrl)) ||
          (await cache.match(rootUrl));

        if (cachedPage) {
          // Opportunistically refresh cache in background when online
          event.waitUntil(
            fetch(request)
              .then((networkResponse) => {
                if (networkResponse && networkResponse.ok) {
                  return cache.put(indexUrl, networkResponse.clone());
                }
              })
              .catch(() => {})
          );
          return cachedPage;
        }

        // 2. If not in cache yet, try network and cache the response
        try {
          const networkResponse = await fetch(request);
          if (networkResponse && networkResponse.ok) {
            cache.put(indexUrl, networkResponse.clone());
          }
          return networkResponse;
        } catch (err) {
          // 3. Ultimate offline fallback
          const fallback = (await cache.match(indexUrl)) || (await cache.match(rootUrl));
          if (fallback) return fallback;
          return new Response(
            '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zenith Offline</title></head><body style="background:#040507;color:#F5F2EB;font-family:-apple-system,sans-serif;padding:2rem;text-align:center;"><h2>Zenith is ready offline</h2><p>Please reload once to initialize the local asset cache.</p></body></html>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        }
      })()
    );
    return;
  }

  // Cache-First strategy for all static assets (style.css, app.js, manifest.json, icons)
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cachedResponse = await cache.match(request, { ignoreSearch: true });
      if (cachedResponse) {
        return cachedResponse;
      }

      try {
        const networkResponse = await fetch(request);
        if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
          cache.put(request, networkResponse.clone());
        }
        return networkResponse;
      } catch (err) {
        // Return cached match without query string if available
        const fallback = await cache.match(requestUrl.pathname);
        if (fallback) return fallback;
        throw err;
      }
    })()
  );
});

// Listen for explicit skipWaiting or cache-verify messages from app.js
self.addEventListener('message', (event) => {
  if (!event.data || typeof event.data !== 'object') return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});