// lib/drive-storage.js — Drive-first storage layer
// ALL data is stored in Google Drive folder "rent-mng-datastorage".
// Structure:
//   rent-mng-datastorage/
//     meta.json         — { version, houses: [{id,name,config,members,ownerEmail}] }
//     rooms.json        — { rooms: [{id,houseId,code,representative,occupants,price,...}] }
//     meter-readings.json — { readings: [{id,houseId,roomId,period,reading,imageFileId,...}] }
//     payments.json     — { payments: [{id,houseId,roomId,period,rent,electricity,...}] }
//
// Local chrome.storage.local is used ONLY as a write-through cache for fast reads.
// Every write → save locally → push to Drive immediately.

import { Auth } from './auth.js';
import { getUserKeys } from './storage-keys.js';
import { getGeminiApiKey, getDriveApiKey } from './config.js';

const FOLDER_NAME  = 'rent-mng-datastorage';
const FILES = {
  meta:     'meta.json',
  rooms:    'rooms.json',
  meters:   'meter-readings.json',
  payments: 'payments.json'
};

// Keys fetched lazily per-user (namespaced by email)
async function K() { return getUserKeys(); }

// ── Utilities ────────────────────────────────────────────
function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Round amount UP to nearest 1000đ.
 * 10_000_200 → 10_001_000
 * 10_000_000 → 10_000_000 (already on boundary)
 */
/**
 * Làm tròn số tiền lên hàng nghìn gần nhất.
 * Chỉ làm tròn nếu có phần lẻ dưới 1000.
 * Ví dụ: 10.000.200 → 10.001.000, 3500 → 3500, 157500 → 158000
 */
export function roundUp1000(n) {
  const abs = Math.abs(n || 0);
  const rounded = abs % 1000 === 0 ? abs : Math.ceil(abs / 1000) * 1000;
  return n < 0 ? -rounded : rounded;
}

/**
 * Format số tiền theo định dạng Việt Nam. Không làm tròn - hiển thị đúng số đã lưu.
 */
export function fmtVND(n) {
  return Math.round(n || 0).toLocaleString('vi-VN') + 'đ';
}

// ── Token & Drive request ────────────────────────────────
// Dùng Auth.getToken() (từ auth.js) để tập trung logic lấy token,
// bao gồm fallback về cached token khi chrome.identity fail.

async function driveReq(buildReq, retried = false) {
  let token;
  try { token = await Auth.getToken(false); }
  catch (e) { throw new Error('Not authenticated: ' + e.message); }

  const { url, method = 'GET', headers = {}, body } = buildReq(token);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    ...(body !== undefined ? { body } : {})
  });

  if (res.status === 401 && !retried) {
    // Token hết hạn → refresh và retry
    try { await Auth.refreshToken(); } catch (_) {}
    return driveReq(buildReq, true);
  }
  return res;
}

// ── Folder management ────────────────────────────────────
let _folderId = null;
let _folderPromise = null; // mutex: prevent concurrent folder creation

async function getOrCreateFolder() {
  if (_folderId) return _folderId;
  // Return existing in-flight promise to prevent race condition
  if (_folderPromise) return _folderPromise;

  _folderPromise = (async () => {
    // Check local cache first
    const K_ = await K();
    const cached = await chrome.storage.local.get(K_.FOLDER_ID).catch(() => ({}));
    if (cached[K_.FOLDER_ID]) { _folderId = cached[K_.FOLDER_ID]; return _folderId; }

    // Search Drive
    const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const searchRes = await driveReq(tok => ({ url: `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)` }));
    if (!searchRes.ok) throw new Error(`Folder search failed: ${searchRes.status}`);
    const searchData = await searchRes.json();
    if (searchData.files?.[0]) {
      _folderId = searchData.files[0].id;
      chrome.storage.local.set({ [K_.FOLDER_ID]: _folderId }).catch(() => {});
      return _folderId;
    }

    // Create folder
    const createRes = await driveReq(tok => ({
      url: 'https://www.googleapis.com/drive/v3/files',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
    }));
    if (!createRes.ok) throw new Error(`Folder create failed: ${createRes.status}`);
    const folder = await createRes.json();
    _folderId = folder.id;
    chrome.storage.local.set({ [K_.FOLDER_ID]: _folderId }).catch(() => {});
    return _folderId;
  })().finally(() => { _folderPromise = null; });

  return _folderPromise;
}

// ── File cache: fileId per filename ──────────────────────
let _fileIds = {};

async function getFileId(filename) {
  if (_fileIds[filename]) return _fileIds[filename];
  const K_ = await K();
  const cached = await chrome.storage.local.get(K_.FILE_IDS);
  _fileIds = cached[K_.FILE_IDS] || {};
  return _fileIds[filename] || null;
}

async function setFileId(filename, id) {
  _fileIds[filename] = id;
  await chrome.storage.local.set({ [(await K()).FILE_IDS]: _fileIds });
}

// ── Read / Write JSON files in the folder ────────────────
async function readFile(filename) {
  try {
    const folderId = await getOrCreateFolder();
    let fileId = await getFileId(filename);

    if (!fileId) {
      const q = encodeURIComponent(`name='${filename}' and '${folderId}' in parents and trashed=false`);
      const res = await driveReq(tok => ({
        url: `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`
      }));
      if (!res.ok) return null;
      const data = await res.json();
      if (data.files?.[0]) {
        fileId = data.files[0].id;
        await setFileId(filename, fileId);
      }
    }

    if (!fileId) return null;

    const res = await driveReq(tok => ({
      url: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
    }));
    if (!res.ok) {
      if (res.status === 404) { _fileIds[filename] = null; return null; }
      return null; // any error → use cache/default
    }
    const data = await res.json();
    // Validate: must be an object with known structure, not just {id: 'fid'}
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  } catch (e) {
    console.warn(`[DriveStore] readFile(${filename}) failed:`, e.message);
    return null; // fallback to cache/default
  }
}

async function writeFile(filename, data) {
  const folderId = await getOrCreateFolder();
  let fileId = await getFileId(filename);
  const jsonBody = JSON.stringify(data);

  if (!fileId) {
    // Check Drive in case cache is stale
    const q = encodeURIComponent(`name='${filename}' and '${folderId}' in parents and trashed=false`);
    const searchRes = await driveReq(tok => ({
      url: `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`
    }));
    const searchData = await searchRes.json();
    if (searchData.files?.[0]) fileId = searchData.files[0].id;
  }

  const boundary = 'rmgr' + Date.now();
  const metaObj = fileId ? { name: filename, mimeType: 'application/json' }
                         : { name: filename, mimeType: 'application/json', parents: [folderId] };
  const bodyStr =
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` + JSON.stringify(metaObj) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` + jsonBody +
    `\r\n--${boundary}--`;

  const url = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`;

  const res = await driveReq(tok => ({
    url,
    method: fileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: bodyStr
  }));

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Write ${filename} failed: ${res.status} ${errText}`);
  }

  const result = await res.json();
  if (result.id) await setFileId(filename, result.id);
  return result;
}

// ── Local cache helpers ──────────────────────────────────
// Module-level in-memory cache: writes immediately visible in same session.
let _memCache = null;

async function readCache() {
  if (_memCache) return _memCache;
  const K_ = await K();
  const d = await chrome.storage.local.get(K_.CACHE);
  _memCache = d[K_.CACHE] || { meta: null, rooms: null, meters: null, payments: null };
  return _memCache;
}

async function writeCache(key, value) {
  if (!_memCache) _memCache = { meta: null, rooms: null, meters: null, payments: null };
  _memCache[key] = value;
  K().then(K_ => chrome.storage.local.set({ [K_.CACHE]: JSON.parse(JSON.stringify(_memCache)) })).catch(() => {});
}

function clearMemCache() { _memCache = null; }

// ── Public API ───────────────────────────────────────────

// ── Optimistic Drive write queue ──────────────────────────
// Writes are fire-and-forget. Failures are logged, not thrown.
// UI operations always succeed locally; Drive sync happens in background.
const _pendingWrites = new Map();

function scheduleDriveWrite(filename, data) {
  if (_pendingWrites.has(filename)) clearTimeout(_pendingWrites.get(filename));
  const snapshot = JSON.parse(JSON.stringify(data));
  const timer = setTimeout(async () => {
    _pendingWrites.delete(filename);
    try {
      await writeFile(filename, snapshot);
    } catch (e) {
      const msg = e.message || '';
      const isAuth = msg.includes('Not authenticated') || msg.includes('bad client') || msg.includes('401');
      if (isAuth) {
        // Retry with interactive auth (mở account chooser nếu cần)
        try {
          await Auth.getToken(true);
          await writeFile(filename, snapshot);
          return; // success after re-auth
        } catch (_) {}
      }
      console.warn(`[DriveStore] Write failed ${filename}:`, msg);
      try {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('rm-drive-write-error', {
            detail: { filename, error: msg }
          }));
        }
      } catch (_) {}
    }
  }, 400);
  _pendingWrites.set(filename, timer);
}

export const DriveStore = {

  // Settings (local only — theme)
  async getTheme() { const K_ = await K(); const d = await chrome.storage.local.get(K_.THEME); return d[K_.THEME] || 'auto'; },
  async setTheme(t) { const K_ = await K(); await chrome.storage.local.set({ [K_.THEME]: t }); },

  // API keys read from manifest.json (rm_config). Setters giữ no-op để
  // không vỡ code cũ. Để thay key, sửa manifest và reload extension.
  async getGeminiKey() { return getGeminiApiKey(); },
  async setGeminiKey(_) { /* no-op: key now in manifest */ },
  async getDriveApiKey() { return getDriveApiKey(); },
  async setDriveApiKey(_) { /* no-op: key now in manifest */ },

  // ── META (houses + config) ────────────────────────────
  async readMeta() {
    const cache = await readCache();
    if (cache.meta) return cache.meta;
    const data = await readFile(FILES.meta);
    const meta = data || { version: 3, houses: [], activeHouseId: null };
    await writeCache('meta', meta);
    return meta;
  },

  async saveMeta(meta) {
    meta.updatedAt = new Date().toISOString();
    await writeCache('meta', meta);
    scheduleDriveWrite(FILES.meta, meta);
  },

  // ── ROOMS ─────────────────────────────────────────────
  async readRooms() {
    const cache = await readCache();
    if (cache.rooms) return cache.rooms;
    const data = await readFile(FILES.rooms);
    const rooms = data || { rooms: [] };
    await writeCache('rooms', rooms);
    return rooms;
  },

  async saveRooms(roomsDoc) {
    roomsDoc.updatedAt = new Date().toISOString();
    await writeCache('rooms', roomsDoc); // update UI immediately
    scheduleDriveWrite(FILES.rooms, roomsDoc); // background, non-blocking
  },

  // ── METER READINGS ────────────────────────────────────
  async readMeters() {
    const cache = await readCache();
    if (cache.meters) return cache.meters;
    const data = await readFile(FILES.meters);
    const meters = data || { readings: [] };
    await writeCache('meters', meters);
    return meters;
  },

  async saveMeters(metersDoc) {
    metersDoc.updatedAt = new Date().toISOString();
    await writeCache('meters', metersDoc);
    scheduleDriveWrite(FILES.meters, metersDoc);
  },

  // ── PAYMENTS ──────────────────────────────────────────
  async readPayments() {
    const cache = await readCache();
    if (cache.payments) return cache.payments;
    const data = await readFile(FILES.payments);
    const payments = data || { payments: [] };
    await writeCache('payments', payments);
    return payments;
  },

  async savePayments(paymentsDoc) {
    paymentsDoc.updatedAt = new Date().toISOString();
    await writeCache('payments', paymentsDoc);
    scheduleDriveWrite(FILES.payments, paymentsDoc);
  },

  // ── Invalidate local cache (force re-read from Drive) ─
  async invalidateCache() {
    invalidateMemCache();
    const K_ = await K();
    await chrome.storage.local.remove(K_.CACHE).catch(() => {});
  },

  // ── Pull all from Drive (full refresh) ───────────────
  async pullAll() {
    // Smart pull: merge Drive data with local cache.
    // For each file, use whichever is newer (by updatedAt timestamp).
    // This prevents Drive data from overriding local changes when Drive sync failed.
    const K_ = await K();
    const localCached = await chrome.storage.local.get(K_.CACHE).catch(() => ({}));
    const local = localCached[K_.CACHE] || {};

    const [driveMeta, driveRooms, driveMeters, drivePayments] = await Promise.all([
      readFile(FILES.meta).catch(() => null),
      readFile(FILES.rooms).catch(() => null),
      readFile(FILES.meters).catch(() => null),
      readFile(FILES.payments).catch(() => null)
    ]);

    function pickNewer(localData, driveData, emptyFallback) {
      if (!driveData) return localData || emptyFallback;
      if (!localData) return driveData;
      // Compare updatedAt timestamps; local wins on tie or if drive is older
      const localTs = localData.updatedAt || '0';
      const driveTs = driveData.updatedAt || '0';
      return driveTs > localTs ? driveData : localData;
    }

    const meta     = pickNewer(local.meta,     driveMeta,     { version: 3, houses: [], activeHouseId: null });
    const rooms    = pickNewer(local.rooms,    driveRooms,    { rooms: [] });
    const meters   = pickNewer(local.meters,   driveMeters,   { readings: [] });
    const payments = pickNewer(local.payments, drivePayments, { payments: [] });

    invalidateMemCache();
    const cache = { meta, rooms, meters, payments };
    _memCache = cache;
    await chrome.storage.local.set({ [K_.CACHE]: cache }).catch(() => {});
    return cache;
  },

  // ── Image upload (meter photos) ───────────────────────
  /**
   * Upload ảnh đồng hồ lên Drive.
   * Trả về { id, webViewLink }. KHÔNG tạo base64 thumbnail nữa
   * (ảnh sẽ được lazy-load qua image-cache khi render).
   */
  async uploadMeterImage(houseName, blob, fileName) {
    const folderId = await getOrCreateFolder();
    const mimeType = blob.type || 'image/jpeg';
    const metadata = { name: fileName, parents: [folderId] };
    const boundary = 'rmgr' + Date.now();
    const metaPart = new TextEncoder().encode(
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` + JSON.stringify(metadata) +
      `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
    const buf = await blob.arrayBuffer();
    const body = new Uint8Array(metaPart.length + buf.byteLength + tail.length);
    body.set(metaPart, 0);
    body.set(new Uint8Array(buf), metaPart.length);
    body.set(tail, metaPart.length + buf.byteLength);

    const res = await driveReq(tok => ({
      url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    }));
    if (!res.ok) throw new Error(`Upload image failed: ${res.status}`);
    const file = await res.json();

    return {
      id:          file.id,
      webViewLink: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`
    };
  },

  async deleteFile(fileId) {
    try {
      await driveReq(tok => ({
        url: `https://www.googleapis.com/drive/v3/files/${fileId}`,
        method: 'DELETE'
      }));
    } catch (_) {}
  }
};


/**
 * Gọi khi sign out hoặc switch user để reset module-level cache.
 * Nếu không reset, user mới sẽ thấy data của user cũ từ _memCache.
 */
export function resetDriveSession() {
  _memCache   = null;
  _folderId   = null;
  _folderPromise = null;
  _fileIds    = {};
}

export { uid };
