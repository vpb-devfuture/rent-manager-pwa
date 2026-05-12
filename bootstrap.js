import './lib/platform.js';

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./service-worker.js').catch(err => {
    console.warn('[PWA] service worker registration failed:', err.message);
  });
}

import('./app.js');
