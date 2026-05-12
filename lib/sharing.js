// lib/sharing.js — Nhà trọ sharing via Drive public file
//
// Flow:
//   Chủ (Owner):
//     1. shareHouse(houseId) → upload snapshot JSON lên Drive (public reader)
//                            → trả về shareCode (base64 của fileId)
//     2. Khi data thay đổi, updateSharedSnapshot(houseId) → update file đó
//
//   Người được share (Guest):
//     1. joinByCode(shareCode) → decode fileId → fetch file từ Drive
//                              → lưu vào sharedHouses local
//     2. refreshSharedHouse(entry) → fetch lại file → cập nhật data

import { DriveStore, uid } from './drive-storage.js';
import { Auth } from './auth.js';
import { getUserKeys } from './storage-keys.js';

const SHARED_KEY   = 'rm_shared_houses';   // chrome.storage.local
const SHARE_PREFIX = 'RMS1:';              // version prefix trong share code

// ── Encode / Decode share code ────────────────────────────
function encodeShareCode(fileId) {
  // SHARE_PREFIX + base64(fileId) → URL-safe string ngắn để copy/paste
  const b64 = btoa(fileId).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return SHARE_PREFIX + b64;
}

function decodeShareCode(code) {
  const stripped = code.trim().toUpperCase().startsWith(SHARE_PREFIX.toUpperCase())
    ? code.trim().slice(SHARE_PREFIX.length)
    : code.trim();
  // Restore base64 padding
  const padded = stripped.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - padded.length % 4) % 4;
  return atob(padded + '='.repeat(padding));
}

// ── Build snapshot object từ data hiện tại ────────────────
async function buildSnapshot(houseId) {
  const [meta, roomsDoc, metersDoc, paymentsDoc] = await Promise.all([
    DriveStore.readMeta(),
    DriveStore.readRooms(),
    DriveStore.readMeters(),
    DriveStore.readPayments()
  ]);
  const house = meta.houses.find(h => h.id === houseId);
  if (!house) throw new Error('House not found');

  const profile = await Auth.getProfile();

  return {
    _type:      'rent-manager-shared-house',
    _version:   1,
    _exportedAt: new Date().toISOString(),
    _ownerEmail: profile?.email || house.ownerEmail || '',
    house: {
      id:   house.id,
      name: house.name,
      config: house.config,
      ownerEmail: house.ownerEmail
    },
    rooms:    roomsDoc.rooms.filter(r => r.houseId === houseId),
    meters:   metersDoc.readings.filter(m => m.houseId === houseId),
    payments: paymentsDoc.payments.filter(p => p.houseId === houseId)
  };
}

// ── Drive helpers ─────────────────────────────────────────
async function driveReqWithToken(buildReq) {
  // Dùng Auth.getToken() để thống nhất token flow với drive-storage.js.
  // Web app client KHÔNG hỗ trợ chrome.identity.getAuthToken trực tiếp.
  const token = await Auth.getToken(false);
  const { url, method = 'GET', headers = {}, body } = buildReq(token);
  return fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    ...(body !== undefined ? { body } : {})
  });
}

async function getOrCreateShareFolder() {
  const K_ = await getUserKeys();
  const cached = await chrome.storage.local.get(K_.SHARE_FOLDER);
  if (cached[K_.SHARE_FOLDER]) return cached[K_.SHARE_FOLDER];

  const FOLDER_NAME = 'rent-mng-shared';
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const searchRes = await driveReqWithToken(tok => ({
    url: `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`
  }));
  const searchData = await searchRes.json();
  if (searchData.files?.[0]) {
    const id = searchData.files[0].id;
    await chrome.storage.local.set({ [(await getUserKeys()).SHARE_FOLDER]: id });
    return id;
  }

  const createRes = await driveReqWithToken(tok => ({
    url: 'https://www.googleapis.com/drive/v3/files',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
  }));
  const folder = await createRes.json();
  await chrome.storage.local.set({ [(await getUserKeys()).SHARE_FOLDER]: folder.id });
  return folder.id;
}

async function writeJsonFile(fileId, folderId, filename, data) {
  const jsonBody = JSON.stringify(data);
  const boundary = 'rmshr' + Date.now();
  const metaObj = fileId
    ? { name: filename, mimeType: 'application/json' }
    : { name: filename, mimeType: 'application/json', parents: [folderId] };
  const bodyStr =
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` + JSON.stringify(metaObj) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` + jsonBody +
    `\r\n--${boundary}--`;

  const url = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`;

  const res = await driveReqWithToken(tok => ({
    url, method: fileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: bodyStr
  }));
  if (!res.ok) throw new Error(`Drive write failed: ${res.status}`);
  return res.json();
}

async function makePublicReader(fileId) {
  const res = await driveReqWithToken(tok => ({
    url: `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'anyone', role: 'reader' })
  }));
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Không set được quyền public cho file (${res.status}): ${txt.slice(0, 200)}`);
  }
}

// ── Public API ────────────────────────────────────────────
export const Sharing = {

  // ── OWNER SIDE ────────────────────────────────────────

  /**
   * Lần đầu share nhà trọ:
   * Upload snapshot lên Drive → set public reader → trả về shareCode
   */
  async shareHouse(houseId) {
    const snapshot  = await buildSnapshot(houseId);
    const folderId  = await getOrCreateShareFolder();
    const filename  = `shared-house-${houseId}.json`;

    // Check xem đã có file share chưa
    const meta    = await DriveStore.readMeta();
    const house   = meta.houses.find(h => h.id === houseId);
    let shareFileId = house?.shareFileId || null;

    const result = await writeJsonFile(shareFileId, folderId, filename, snapshot);
    const newFileId = result.id || shareFileId;

    // Set public reader — throw nếu fail (đừng để file private mà vẫn trả shareCode)
    await makePublicReader(newFileId);

    // Lưu shareFileId vào meta
    if (!house.shareFileId || house.shareFileId !== newFileId) {
      house.shareFileId = newFileId;
      await DriveStore.saveMeta(meta);
    }

    return { shareCode: encodeShareCode(newFileId), shareFileId: newFileId };
  },

  /**
   * Verify rằng file share thật sự download được bằng API key.
   * Owner gọi sau shareHouse để chắc chắn guest sẽ join được.
   * Throw nếu fail.
   */
  async verifySharedFile(fileId) {
    const apiKey = await DriveStore.getDriveApiKey();
    if (!apiKey) {
      throw new Error('Chưa cấu hình Drive API Key trong Settings — chưa thể verify');
    }
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`File chưa public hoặc API key sai (${res.status})`);
    }
    return true;
  },

  /**
   * Cập nhật snapshot khi data thay đổi (gọi sau mỗi write quan trọng)
   */
  async updateSharedSnapshot(houseId) {
    const meta  = await DriveStore.readMeta();
    const house = meta.houses.find(h => h.id === houseId);
    if (!house?.shareFileId) return; // chưa share → skip

    try {
      const snapshot = await buildSnapshot(houseId);
      const folderId = await getOrCreateShareFolder();
      await writeJsonFile(house.shareFileId, folderId, `shared-house-${houseId}.json`, snapshot);
    } catch (e) {
      console.warn('[Sharing] updateSharedSnapshot failed:', e.message);
    }
  },

  /**
   * Hủy share: xóa file Drive + xóa shareFileId
   */
  async unshareHouse(houseId) {
    const meta  = await DriveStore.readMeta();
    const house = meta.houses.find(h => h.id === houseId);
    if (!house?.shareFileId) return;

    try {
      await driveReqWithToken(tok => ({
        url: `https://www.googleapis.com/drive/v3/files/${house.shareFileId}`,
        method: 'DELETE'
      }));
    } catch (_) {}

    delete house.shareFileId;
    await DriveStore.saveMeta(meta);
  },

  isShared(house) { return !!house?.shareFileId; },

  getShareCode(house) {
    return house?.shareFileId ? encodeShareCode(house.shareFileId) : null;
  },

  // ── GUEST SIDE ────────────────────────────────────────

  /**
   * Đọc dữ liệu shared houses từ local storage
   */
  async getSharedHouses() {
    const K_ = await getUserKeys();
    const d = await chrome.storage.local.get(K_.SHARED_HOUSES);
    return d[K_.SHARED_HOUSES] || [];
  },

  /**
   * Tham gia nhà trọ bằng share code.
   * Fetch file từ Drive → lưu vào local shared list.
   */
  async joinByCode(rawCode) {
    let fileId;
    try {
      fileId = decodeShareCode(rawCode);
      if (!fileId || fileId.length < 10) throw new Error('invalid');
    } catch {
      throw new Error('Mã share không hợp lệ. Kiểm tra lại mã bạn nhận được.');
    }

    const snapshot = await this.fetchSnapshot(fileId);
    if (!snapshot || snapshot._type !== 'rent-manager-shared-house') {
      throw new Error('File không hợp lệ hoặc không phải dữ liệu nhà trọ.');
    }

    const shared = await this.getSharedHouses();

    // Tránh trùng
    const existingIdx = shared.findIndex(s => s.fileId === fileId);
    const entry = {
      id:          existingIdx >= 0 ? shared[existingIdx].id : uid('sh_'),
      fileId,
      shareCode:   rawCode.trim(),
      houseName:   snapshot.house.name,
      ownerEmail:  snapshot._ownerEmail || snapshot.house.ownerEmail,
      addedAt:     existingIdx >= 0 ? shared[existingIdx].addedAt : new Date().toISOString(),
      lastSyncAt:  new Date().toISOString(),
      snapshot
    };

    if (existingIdx >= 0) shared[existingIdx] = entry;
    else shared.push(entry);

    const K_ = await getUserKeys();
    await chrome.storage.local.set({ [K_.SHARED_HOUSES]: shared });
    return entry;
  },

  /**
   * Fetch snapshot từ Drive (file đã public reader).
   *
   * QUAN TRỌNG: Không thể fetch bằng OAuth token với scope drive.file,
   * vì Google trả 404 cho file mà current user không phải owner/opener
   * (kể cả khi file đã public). Phải dùng API Key của Cloud project
   * (giống thư viện client của Google).
   *
   * User cần tạo API Key tại Cloud Console → Credentials → Create → API Key,
   * sau đó paste vào Settings → "Drive API Key".
   */
  async fetchSnapshot(fileId) {
    const apiKey = await DriveStore.getDriveApiKey();
    if (!apiKey) {
      throw new Error(
        'Chưa cấu hình Drive API Key.\n\n' +
        'Vào Settings → "Drive API Key" → paste API key từ Google Cloud Console.\n' +
        'Hướng dẫn lấy key: Credentials → + Create Credentials → API Key.'
      );
    }
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      if (res.status === 404) {
        throw new Error('File không tồn tại hoặc chưa được set quyền public. Liên hệ chủ nhà trọ để cấp lại mã share.');
      }
      if (res.status === 403) {
        throw new Error(
          'API Key không hợp lệ hoặc Drive API chưa được bật.\n\n' +
          'Kiểm tra:\n' +
          '1. Cloud Console → APIs & Services → Library → Google Drive API → Enable\n' +
          '2. Settings → "Drive API Key" có đúng key không\n' +
          '3. Nếu key có restriction, đảm bảo cho phép Drive API'
        );
      }
      throw new Error(`Không tải được dữ liệu (${res.status}): ${txt.slice(0, 200)}`);
    }
    return res.json();
  },

  /**
   * Refresh dữ liệu nhà trọ được share
   */
  async refreshSharedHouse(entryId) {
    const shared = await this.getSharedHouses();
    const idx    = shared.findIndex(s => s.id === entryId);
    if (idx < 0) throw new Error('Không tìm thấy nhà trọ được share');

    const entry    = shared[idx];
    const snapshot = await this.fetchSnapshot(entry.fileId);
    if (!snapshot || snapshot._type !== 'rent-manager-shared-house') {
      throw new Error('Dữ liệu không hợp lệ');
    }

    shared[idx] = {
      ...entry,
      houseName:  snapshot.house.name,
      ownerEmail: snapshot._ownerEmail || snapshot.house.ownerEmail,
      lastSyncAt: new Date().toISOString(),
      snapshot
    };
    const K_2 = await getUserKeys();
    await chrome.storage.local.set({ [K_2.SHARED_HOUSES]: shared });
    return shared[idx];
  },

  /**
   * Xóa nhà trọ được share khỏi danh sách
   */
  async leaveSharedHouse(entryId) {
    const shared = await this.getSharedHouses();
    const filtered = shared.filter(s => s.id !== entryId);
    const K_3 = await getUserKeys();
    await chrome.storage.local.set({ [K_3.SHARED_HOUSES]: filtered });
  }
};
