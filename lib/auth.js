// lib/auth.js — Google OAuth for browser/PWA using Google Identity Services.
// For PWA, create/use a Google OAuth Client of type "Web application" and add
// your deployed URL to Authorized JavaScript origins.

import { getGoogleClientId } from './config.js';

const USER_KEY    = 'rm_user_profile';
const TOKEN_KEY   = 'rm_access_token';
const EXPIRES_KEY = 'rm_token_expires_at'; // epoch ms

const SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/drive.file'
].join(' ');

export class AuthConfigError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.name = 'AuthConfigError';
    this.hint = hint;
    this.isConfigError = true;
  }
}

function getClientId() {
  return getGoogleClientId();
}

function getRedirectUri() {
  return window.location.origin;
}

let gisPromise = null;
function loadGoogleIdentityServices() {
  if (window.google?.accounts?.oauth2) return Promise.resolve(window.google);
  if (gisPromise) return gisPromise;

  gisPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-google-identity-services]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.google));
      existing.addEventListener('error', () => reject(new Error('Không tải được Google Identity Services')));
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.dataset.googleIdentityServices = 'true';
    script.onload = () => window.google?.accounts?.oauth2
      ? resolve(window.google)
      : reject(new Error('Google Identity Services chưa sẵn sàng'));
    script.onerror = () => reject(new Error('Không tải được Google Identity Services'));
    document.head.appendChild(script);
  });
  return gisPromise;
}

function classifyOAuthError(err) {
  const code = String(err?.type || err?.error || err?.message || '').toLowerCase();
  if (code.includes('popup') || code.includes('cancel') || code.includes('closed')) {
    return new Error('Đăng nhập bị hủy');
  }
  if (code.includes('origin') || code.includes('redirect') || code.includes('client')) {
    return new AuthConfigError(
      'OAuth Client chưa cấu hình đúng cho PWA',
      `Google Cloud Console → OAuth Client (Web application) → Authorized JavaScript origins → thêm: ${getRedirectUri()}`
    );
  }
  return new Error(err?.message || err?.error || 'Không đăng nhập được Google');
}

async function launchFlow(selectAccount = true) {
  const clientId = getClientId();
  if (!clientId) {
    throw new AuthConfigError(
      'Chưa cấu hình Google OAuth Client ID',
      'Mở file config.local.js và điền google_client_id của OAuth Client loại Web application.'
    );
  }

  const google = await loadGoogleIdentityServices();

  return new Promise((resolve, reject) => {
    let settled = false;
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      include_granted_scopes: true,
      prompt: selectAccount ? 'consent select_account' : '',
      callback: (resp) => {
        if (settled) return;
        settled = true;
        if (resp?.error) return reject(classifyOAuthError(resp));
        if (!resp?.access_token) return reject(new Error('Không nhận được access token'));
        const expires = Number(resp.expires_in || 3600);
        resolve({ token: resp.access_token, expiresAt: Date.now() + (expires - 60) * 1000 });
      },
      error_callback: (err) => {
        if (settled) return;
        settled = true;
        reject(classifyOAuthError(err));
      }
    });

    try {
      tokenClient.requestAccessToken({ prompt: selectAccount ? 'consent select_account' : '' });
    } catch (e) {
      settled = true;
      reject(classifyOAuthError(e));
    }
  });
}

async function fetchProfile(token) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('Không lấy được thông tin tài khoản');
  return res.json();
}

async function revokeToken(token) {
  if (!token) return;
  try {
    await loadGoogleIdentityServices();
    if (window.google?.accounts?.oauth2?.revoke) {
      await new Promise(resolve => window.google.accounts.oauth2.revoke(token, resolve));
      return;
    }
  } catch (_) {}

  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }).catch(() => {});
}

async function resetModules() {
  try { const { resetKeyCache } = await import('./storage-keys.js'); resetKeyCache(); } catch {}
  try { const { resetDriveSession } = await import('./drive-storage.js'); resetDriveSession(); } catch {}
}

async function clearOldUser(email) {
  if (!email) return;
  try { const { clearUserData } = await import('./storage-keys.js'); await clearUserData(email); } catch {}
}

async function saveSession(token, expiresAt, profile) {
  await chrome.storage.local.set({
    [TOKEN_KEY]: token,
    [EXPIRES_KEY]: expiresAt,
    [USER_KEY]: profile
  });
}

async function clearSession() {
  await chrome.storage.local.remove([USER_KEY, TOKEN_KEY, EXPIRES_KEY]).catch(() => {});
}

export const Auth = {
  async signIn() {
    const { token, expiresAt } = await launchFlow(true);
    const profile = await fetchProfile(token);
    await saveSession(token, expiresAt, profile);
    await resetModules();
    return { token, profile };
  },

  async switchAccount() {
    const oldProfile = await this.getProfile();
    const { [TOKEN_KEY]: oldToken } = await chrome.storage.local.get(TOKEN_KEY);
    await revokeToken(oldToken);
    await clearSession();
    await clearOldUser(oldProfile?.email);
    await resetModules();

    const { token, expiresAt } = await launchFlow(true);
    const profile = await fetchProfile(token);
    await saveSession(token, expiresAt, profile);
    await resetModules();
    return { token, profile };
  },

  async getToken(interactive = false) {
    const d = await chrome.storage.local.get([TOKEN_KEY, EXPIRES_KEY]);
    const token = d[TOKEN_KEY];
    const expiresAt = d[EXPIRES_KEY] || 0;

    if (token && Date.now() < expiresAt) return token;

    try {
      const r = await launchFlow(false);
      await chrome.storage.local.set({ [TOKEN_KEY]: r.token, [EXPIRES_KEY]: r.expiresAt });
      return r.token;
    } catch (e) {
      if (!interactive) throw new Error('Token expired, silent refresh failed: ' + e.message);
      const r = await launchFlow(true);
      const profile = await fetchProfile(r.token);
      await saveSession(r.token, r.expiresAt, profile);
      return r.token;
    }
  },

  async refreshToken() {
    const r = await launchFlow(false);
    await chrome.storage.local.set({ [TOKEN_KEY]: r.token, [EXPIRES_KEY]: r.expiresAt });
    return r.token;
  },

  async getProfile() {
    const d = await chrome.storage.local.get(USER_KEY);
    return d[USER_KEY] || null;
  },

  async isSignedIn() {
    return !!(await this.getProfile());
  },

  async signOut() {
    const profile = await this.getProfile();
    const { [TOKEN_KEY]: token } = await chrome.storage.local.get(TOKEN_KEY);
    await revokeToken(token);
    await clearSession();
    await clearOldUser(profile?.email);
    await resetModules();
  },

  getRedirectUri() {
    return getRedirectUri();
  }
};
