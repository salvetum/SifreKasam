// ─── SİSTEM TEPSİSİ ──────────────────────────────────────────────────────────
// Tepsi ikonu, menüsü ve pencere görünürken renderer'ın düşük güç moduna
// alınması. Pencere gizliyken GPU çıktısı durdurulur; gösterimde devam eder.

const { app, Tray, Menu } = require('electron');

const rt = require('./runtime-state');
const { resolvePath } = require('./config');

function createTray() {
  try {
    const iconPath = process.platform === 'win32'
      ? resolvePath('favicon.ico')
      : resolvePath('assets', 'tray-icon.png');
    rt.tray = new Tray(iconPath);
    rt.tray.setToolTip('ŞifreKasam');
    rt.tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Göster', click: showMainWindow },
      { type: 'separator' },
      { label: 'Çıkış',  click: () => { rt.isQuiting = true; app.quit(); } },
    ]));
    rt.tray.on('click', showMainWindow);
  } catch (err) {
    console.error('Tray icon yuklenemedi, tray ozelligi atlaniyor:', err);
    rt.tray = null;
  }
}

function showMainWindow() {
  if (!rt.mainWindow) return;
  if (rt.mainWindow.isMinimized()) rt.mainWindow.restore();
  rt.mainWindow.setAlwaysOnTop(true);
  rt.mainWindow.show();
  setRendererLowPower(false);
  rt.mainWindow.focus();
  rt.mainWindow.setAlwaysOnTop(false);
}

function setRendererLowPower(enabled) {
  if (!rt.mainWindow || rt.mainWindow.isDestroyed()) return;
  const nextState = Boolean(enabled);
  const wasLowPower = rt.rendererLowPowerRequested;
  rt.rendererLowPowerRequested = nextState;

  if (!nextState && (wasLowPower || rt.mainWindow.isVisible())
      && typeof rt.mainWindow.webContents.invalidate === 'function') {
    rt.mainWindow.webContents.invalidate();
  }
  const script = nextState
    ? 'window.KASA_SET_LOW_POWER?.(true);'
    : 'window.KASA_RESUME_RENDERER?.();';
  rt.mainWindow.webContents
    .executeJavaScript(script, true)
    .catch(() => {});
}

module.exports = {
  createTray,
  showMainWindow,
  setRendererLowPower,
};
