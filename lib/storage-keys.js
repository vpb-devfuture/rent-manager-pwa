// lib/storage-keys.js — Storage key factory, namespaced by user email

function makePrefix(email) {
  if (!email) return null;
  return 'rm_' + btoa(email).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) + '_';
}

function makeKeys(prefix) {
  return {
    CACHE:         prefix + 'cache',
    FOLDER_ID:     prefix + 'folder_id',
    FILE_IDS:      prefix + 'file_ids',
    THEME:         prefix + 'theme',
    REMINDER:      prefix + 'reminder',
    SHARED_HOUSES: prefix + 'shared',
    SHARE_FOLDER:  prefix + 'share_folder_id',
    TOKEN:         'rm_access_token',
    USER_PROFILE:  'rm_user_profile'
  };
}

let _cachedEmail = null;
let _cachedKeys  = null;

export async function getUserKeys() {
  const d     = await chrome.storage.local.get('rm_user_profile');
  const email = d.rm_user_profile?.email || '';
  if (email !== _cachedEmail) {
    _cachedEmail = email;
    const prefix = makePrefix(email);
    _cachedKeys  = makeKeys(prefix || 'rm_tmp_');
  }
  return _cachedKeys;
}

export function resetKeyCache() {
  _cachedEmail = null;
  _cachedKeys  = null;
}

export async function clearUserData(email) {
  if (!email) return;
  const prefix = makePrefix(email);
  if (!prefix) return;
  const all = await chrome.storage.local.get(null).catch(() => ({}));
  const keys = Object.keys(all).filter(k => k.startsWith(prefix));
  if (keys.length) await chrome.storage.local.remove(keys).catch(() => {});
  if (_cachedEmail === email) { _cachedEmail = null; _cachedKeys = null; }
}
