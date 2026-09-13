// ─── KULLANICI CACHE HİJYENİ ──────────────────────────────────────────────────
// Chromium, %APPDATA%\ŞifreKasam altında HTTP cache (Cache\), GPU/shader
// cachelari (GPUCache, Dawn*, GrShaderCache) ve JIT Code Cache biriktirir.
// Bu modül:
//   1. HTTP cache disk-cache-size switch'i ile sınırlanır (main.js).
//   2. Eşik aşan GPU/Dawn/Code cache dizinlerini başlangıçtan birkaç saniye
//      sonra siler (yeniden derlenirler; silmek güvenlidir).
// Service Worker CacheStorage'a (SW kayıtları/offline varlıklar) DOKUNULMAZ.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const PRUNE_THRESHOLD = 8 * 1024 * 1024; // 8 MB altı zararsız, dokunma
const CACHE_DIRS = [
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'Code Cache',
];

function dirSize(dir) {
  let total = 0;
  for (const file of fs.readdirSync(dir)) {
    const full = path.join(dir, file);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (_) {
      continue;
    }
    if (stat.isDirectory()) total += dirSize(full);
    else total += stat.size;
  }
  return total;
}

// Dışarıdan test için userData verilebilir; varsayılan app.getPath('userData').
function pruneUserCacheDirs(userDataDir = app.getPath('userData')) {
  let savedBytes = 0;
  for (const name of CACHE_DIRS) {
    const dir = path.join(userDataDir, name);
    if (!fs.existsSync(dir)) continue;
    let size = 0;
    try {
      size = dirSize(dir);
    } catch (_) {
      continue;
    }
    if (size <= PRUNE_THRESHOLD) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      savedBytes += size;
    } catch (_) {
      // Açık tutulan bir dosya nedeniyle silinemeyen kısım sonraki açılışta
      // tekrar denenir; sorun değil.
    }
  }
  if (savedBytes) {
    console.log(`[cache] birim cache budandi (-${(savedBytes / 1048576).toFixed(1)} MB): ${userDataDir}`);
  }
  return savedBytes;
}

module.exports = { pruneUserCacheDirs, PRUNE_THRESHOLD, CACHE_DIRS };