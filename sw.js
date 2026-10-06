/* Film Lab's static GitHub Pages app-shell service worker. */
'use strict';

// Cache-first, so the shell is only re-fetched when this name changes.
// Bump the version whenever index.html or any precached file changes, otherwise
// returning visitors keep seeing the copy they cached on their first visit.
const CACHE = 'filmlab-v12';
const APP_SCOPE = self.registration.scope;
const PRECACHE = [
  './',
  'index.html',
  'manifest.json',
  'social-tools.js',
  'color-grading.js',
  'timeline-module.js',
  'multi-timeline.js',
  'background-blur-worker.js',
  'mask-segmentation-worker.js',
  'mask-stack.js',
  'mask-pro-worker.mjs',
  'vendor/heic2any.min.js',
  'favicon.svg',
  'favicon.png',
  'favicon.ico',
  'icons/icon-192.png',
  'icons/icon-512.png',
].map(path => new URL(path, APP_SCOPE).href);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith('filmlab-') && key !== CACHE)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const path = url.pathname.toLowerCase();
  // Bundled on-device ML assets (ONNX Runtime and the selfie multiclass model) are
  // cached on first use so the Fast engine keeps working offline without forcing a
  // 30 MB download during install.
  if (url.origin === self.location.origin
    && (path.includes('onnxruntime-web') || path.includes('vendor/models/')
      || path.includes('mask-stack.js')
      || path.includes('mask-pro-worker.mjs'))) {
    event.respondWith(
      caches.open(CACHE).then(cache => cache.match(request, {ignoreSearch: true}).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response && response.ok && response.type === 'basic') cache.put(request, response.clone());
          return response;
        });
      }))
    );
    return;
  }
  // The FFmpeg core and MediaPipe/ML assets are intentionally left to the network.
  if (path.includes('ffmpeg') || path.includes('mediapipe') || path.includes('tflite')) return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request, {ignoreSearch: true})
      .then(cached => cached || fetch(request))
  );
});
