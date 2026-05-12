// lib/image-cache.js — In-memory cache cho ảnh từ Drive
//
// Vì ảnh đồng hồ điện không public, phải fetch qua OAuth token. Để tránh
// fetch lại mỗi lần render, cache blob URL theo fileId trong RAM. Bị
// flush khi reload extension.
//
// API:
//   getImageUrl(fileId)  → Promise<string> (blob URL)
//   prefetch(fileIds)    → preload bulk
//   revoke(fileId)       → giải phóng 1 ảnh
//   revokeAll()          → giải phóng hết (gọi khi unload)
//   hydrateImages(root)  → scan DOM, set src cho mọi <img data-img-fileid>

import { Auth } from './auth.js';

const MAX_CACHE = 100;
const _cache = new Map();   // fileId → { url, lastUsed }
const _inflight = new Map(); // fileId → Promise<string>

function touch(fileId) {
  const e = _cache.get(fileId);
  if (e) e.lastUsed = Date.now();
}

function evictIfNeeded() {
  if (_cache.size <= MAX_CACHE) return;
  // Tìm entry cũ nhất
  let oldestKey = null, oldestTime = Infinity;
  for (const [k, v] of _cache) {
    if (v.lastUsed < oldestTime) { oldestTime = v.lastUsed; oldestKey = k; }
  }
  if (oldestKey) {
    const e = _cache.get(oldestKey);
    try { URL.revokeObjectURL(e.url); } catch {}
    _cache.delete(oldestKey);
  }
}

export async function getImageUrl(fileId) {
  if (!fileId) return '';
  const cached = _cache.get(fileId);
  if (cached) { touch(fileId); return cached.url; }
  if (_inflight.has(fileId)) return _inflight.get(fileId);

  const p = (async () => {
    try {
      const token = await Auth.getToken(false);
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) throw new Error(`Drive fetch ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      _cache.set(fileId, { url, lastUsed: Date.now() });
      evictIfNeeded();
      return url;
    } finally {
      _inflight.delete(fileId);
    }
  })();
  _inflight.set(fileId, p);
  return p;
}

export async function prefetch(fileIds) {
  await Promise.allSettled((fileIds || []).filter(Boolean).map(id => getImageUrl(id)));
}

export function revoke(fileId) {
  const e = _cache.get(fileId);
  if (!e) return;
  try { URL.revokeObjectURL(e.url); } catch {}
  _cache.delete(fileId);
}

export function revokeAll() {
  for (const e of _cache.values()) {
    try { URL.revokeObjectURL(e.url); } catch {}
  }
  _cache.clear();
}

/**
 * Scan DOM root cho tất cả <img data-img-fileid="..."> và lazy load src.
 * Gọi sau mỗi render. Idempotent (bỏ qua img đã có src).
 *
 * State machine qua attribute data-img-loaded:
 *   chưa có      → đang chờ hydrate (CSS sẽ render shimmer)
 *   "loading"    → đang fetch
 *   "done"       → load xong (skeleton tắt)
 *   "error"      → fetch fail
 *
 * Cũng support <img data-img-fileid data-img-lightbox-from-fileid>: khi load
 * xong, set thuộc tính data-lightbox = blob URL để click mở full size.
 */
export function hydrateImages(root = document) {
  const imgs = root.querySelectorAll('img[data-img-fileid]');
  imgs.forEach(async img => {
    const fid = img.dataset.imgFileid;
    if (!fid) return;
    // Skip nếu đang loading hoặc đã xong (cho phép retry nếu error)
    if (img.dataset.imgLoaded === 'loading' || img.dataset.imgLoaded === 'done') return;
    img.dataset.imgLoaded = 'loading';
    try {
      const url = await getImageUrl(fid);
      img.src = url;
      // Lightbox dùng cùng blob URL
      if ('imgLightboxFromFileid' in img.dataset) {
        img.dataset.lightbox = url;
      }
      // Đợi browser decode xong rồi mới mark 'done' (để skeleton không nhấp nháy)
      if (img.complete && img.naturalWidth) {
        img.dataset.imgLoaded = 'done';
      } else {
        img.addEventListener('load',  () => { img.dataset.imgLoaded = 'done';  }, { once: true });
        img.addEventListener('error', () => { img.dataset.imgLoaded = 'error'; }, { once: true });
      }
    } catch (e) {
      img.dataset.imgLoaded = 'error';
      img.alt = 'Không tải được ảnh';
      console.warn('[image-cache] Failed to load', fid, e.message);
    }
  });
}
