// lib/config.js — PWA config read from config.local.js via window.RENT_MANAGER_CONFIG.
// Copy config.local.example.js to config.local.js and fill your Google OAuth/API values.

function getRmConfig() {
  return window.RENT_MANAGER_CONFIG || {};
}

export function getGoogleClientId() {
  const cfg = getRmConfig();
  return cfg.google_client_id || cfg.oauth2_client_id || '';
}

export function getGeminiApiKey() {
  return getRmConfig().gemini_api_key || '';
}

export function getDriveApiKey() {
  return getRmConfig().drive_api_key || '';
}

export function hasGeminiKey() { return !!getGeminiApiKey(); }
export function hasDriveKey()  { return !!getDriveApiKey();  }
