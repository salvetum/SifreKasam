// ─── SAYFA YÜKLEYİCİ ─────────────────────────────────────────────────────────
// Yükleme ekranı ve backend sayfalarının ana pencereye yüklenmesi; paketli
// uygulamada başlangıç kaynaklarının bütünlük kontrolü.

const { app } = require('electron');
const fs = require('fs');

const { PROTOCOL, HOST, resolvePath } = require('./config');
const rt = require('./runtime-state');

function resolveLoadingPagePath() {
  if (app.isPackaged) {
    return resolvePath('backend', '_internal', 'templates', 'loading.html');
  }
  return resolvePath('flask_app', 'templates', 'loading.html');
}

function verifyPackagedStartupResources() {
  if (!app.isPackaged) return;

  const backendBinary = process.platform === 'win32' ? 'SifreKasam.exe' : 'SifreKasam';
  const requiredFiles = [
    resolveLoadingPagePath(),
    resolvePath('backend', backendBinary),
  ];
  const missingFiles = requiredFiles.filter((filePath) => !fs.existsSync(filePath));
  if (missingFiles.length) {
    throw new Error(`Eksik paket dosyaları: ${missingFiles.join(', ')}`);
  }
}

async function loadBackendPage(pathname) {
  if (!rt.mainWindow || rt.mainWindow.isDestroyed()) {
    throw new Error('Ana pencere kullanılamıyor.');
  }
  try {
    const targetUrl = `${PROTOCOL}://${HOST}:${rt.PORT}${pathname}`;
    await rt.mainWindow.loadURL(targetUrl);
  } catch (err) {
    console.error('loadBackendPage failed:', pathname, err.message);
    throw err;
  }
}

module.exports = {
  resolveLoadingPagePath,
  verifyPackagedStartupResources,
  loadBackendPage,
};
