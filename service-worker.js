const CACHE_NAME = 'rent-manager-pwa-v1';
const APP_SHELL = [
  './',
  './index.html',
  './app.html',
  './bootstrap.js',
  './app.js',
  './config.local.js',
  './manifest.webmanifest',
  './assets/style.css',
  './assets/app.css',
  './icons/icon16.png',
  './icons/icon32.png',
  './icons/icon48.png',
  './icons/icon128.png',
  './lib/platform.js',
  './lib/auth.js',
  './lib/config.js',
  './lib/storage-keys.js',
  './lib/drive-storage.js',
  './lib/store.js',
  './lib/ocr.js',
  './lib/sharing.js',
  './lib/image-cache.js',
  './lib/excel-import.js',
  './lib/xlsx.full.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).catch(() => null));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)).catch(() => null);
        return res;
      });
    })
  );
});
