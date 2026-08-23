// ─── UYGULAMA SABİTLERİ ──────────────────────────────────────────────────────
// Ana süreç modülleri tarafından paylaşılan sabitler ve yol çözümleyici.
// APP_TOKEN modül önbelleği sayesinde süreç başına yalnızca bir kez üretilir.

const { app } = require('electron');
const crypto = require('crypto');
const path = require('path');

// Paketsiz geliştirme modunda proje kökü (src/main/config.js -> iki üst dizin).
const APP_ROOT = path.join(__dirname, '..', '..');

function resolvePath(...segments) {
  return app.isPackaged
    ? path.join(process.resourcesPath, ...segments)
    : path.join(APP_ROOT, ...segments);
}

const APP_TOKEN        = crypto.randomBytes(32).toString('hex');
const HOST             = '127.0.0.1';
const FLASK_TIMEOUT_MS = 60_000;
const FLASK_TIMEOUT_FIRST_RUN_MS = 90_000;
const RETRY_INTERVAL_MS = 500;
const BACKEND_PROBE_TIMEOUT_MS = 1_500;

const PROTOCOL            = 'https';
const HISTORY_NAVIGATION_KEYS = new Set(['BrowserBack', 'BrowserForward']);
const SSL_NOISE_PATTERNS = [
  'ERR_CERT_AUTHORITY_INVALID',
  'ERR_CERT_COMMON_NAME_INVALID',
  'ERR_CERT_DATE_INVALID',
  'ERR_CERT_INVALID',
  'certificate',
  'SSL',
];
const LAN_RECONCILE_IDLE_INTERVAL_MS = 20_000;
const LAN_RECONCILE_ACTIVE_INTERVAL_MS = 5_000;
const LAN_RESTART_MIN_INTERVAL_MS = 15_000;

module.exports = {
  APP_ROOT,
  resolvePath,
  APP_TOKEN,
  HOST,
  FLASK_TIMEOUT_MS,
  FLASK_TIMEOUT_FIRST_RUN_MS,
  RETRY_INTERVAL_MS,
  BACKEND_PROBE_TIMEOUT_MS,
  PROTOCOL,
  HISTORY_NAVIGATION_KEYS,
  SSL_NOISE_PATTERNS,
  LAN_RECONCILE_IDLE_INTERVAL_MS,
  LAN_RECONCILE_ACTIVE_INTERVAL_MS,
  LAN_RESTART_MIN_INTERVAL_MS,
};
