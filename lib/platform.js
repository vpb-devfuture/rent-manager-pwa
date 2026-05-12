// lib/platform.js — Browser/PWA compatibility layer for code originally written for Chrome Extension.
// It provides the subset of chrome.* APIs used by the app, backed by Web APIs.

(function installPlatformShim() {
  if (typeof window === 'undefined') return;

  const readValue = (key) => {
    const raw = window.localStorage.getItem(key);
    if (raw === null || raw === undefined) return undefined;
    try { return JSON.parse(raw); } catch { return raw; }
  };

  const writeValue = (key, value) => {
    window.localStorage.setItem(key, JSON.stringify(value));
  };

  const removeValue = (key) => window.localStorage.removeItem(key);

  const storageLocal = {
    async get(keys) {
      if (keys === null || keys === undefined) {
        const all = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          all[key] = readValue(key);
        }
        return all;
      }

      if (typeof keys === 'string') {
        return { [keys]: readValue(keys) };
      }

      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map(k => [k, readValue(k)]));
      }

      if (typeof keys === 'object') {
        const out = {};
        for (const [key, defaultValue] of Object.entries(keys)) {
          const v = readValue(key);
          out[key] = v === undefined ? defaultValue : v;
        }
        return out;
      }

      return {};
    },

    async set(items) {
      for (const [key, value] of Object.entries(items || {})) writeValue(key, value);
    },

    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      list.filter(Boolean).forEach(removeValue);
    },

    async clear() {
      window.localStorage.clear();
    }
  };

  const runtime = {
    getURL(path) {
      return new URL(path, window.location.href).href;
    },
    getManifest() {
      const cfg = window.RENT_MANAGER_CONFIG || {};
      return {
        name: 'Rent Manager PWA',
        version: '2.0.0-pwa',
        rm_config: {
          gemini_api_key: cfg.gemini_api_key || '',
          drive_api_key: cfg.drive_api_key || ''
        },
        oauth2: {
          client_id: cfg.google_client_id || cfg.oauth2_client_id || ''
        }
      };
    },
    async sendMessage() {
      return null;
    }
  };

  const notifications = {
    async create(id, options = {}) {
      try {
        if (!('Notification' in window)) return id || String(Date.now());
        let permission = Notification.permission;
        if (permission === 'default') permission = await Notification.requestPermission();
        if (permission !== 'granted') return id || String(Date.now());
        new Notification(options.title || 'Rent Manager', {
          body: options.message || '',
          icon: options.iconUrl || 'icons/icon128.png'
        });
      } catch (e) {
        console.warn('[PWA notification] failed:', e.message);
      }
      return id || String(Date.now());
    }
  };

  window.chrome = window.chrome || {};
  window.chrome.storage = window.chrome.storage || {};
  window.chrome.storage.local = window.chrome.storage.local || storageLocal;
  window.chrome.runtime = window.chrome.runtime || runtime;
  window.chrome.notifications = window.chrome.notifications || notifications;
})();
