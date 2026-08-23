// ─── IMPORTS ──────────────────────────────────────────────────────────────────

const { app, dialog } = require('electron');

const {
  isRunningAsAdmin,
  showFriendlyFatalError,
} = require('./src/main/fatal-errors');
const { handleSquirrelEvent } = require('./src/main/squirrel');
const {
  isFirstRun,
  getSavedHardwareAcceleration,
  getSavedWindowBackgroundColor,
} = require('./src/main/preferences');
const { registerCertificateErrorHandler } = require('./src/main/certificates');
const {
  FLASK_TIMEOUT_MS,
  FLASK_TIMEOUT_FIRST_RUN_MS,
  safeModeRequested,
  resolvePath,
} = require('./src/main/config');
const rt = require('./src/main/runtime-state');
const {
  applyContentProtection,
  startFlaskServer,
  startLanReconciliation,
  stopFlaskServer,
  shutdownFlask,
  requestBackendJson,
  waitForBackendReady,
} = require('./src/main/backend-process');
const { createTray } = require('./src/main/tray');
const {
  loadBackendPage,
  verifyPackagedStartupResources,
} = require('./src/main/page-loader');
const { createWindow } = require('./src/main/window');

// ─── SQUIRREL KURULUM HANDLER (EN ÜSTTE OLMALI) ──────────────────────────────

if (process.platform === 'win32' && handleSquirrelEvent({ resolvePath })) process.exit(0);

app.commandLine.appendSwitch('disable-spell-checking');
app.commandLine.appendSwitch('log-level', '3');
if (safeModeRequested || !getSavedHardwareAcceleration()) {
  app.disableHardwareAcceleration();
}

// ─── TEK ÖRNEK KİLİDİ ────────────────────────────────────────────────────────

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!rt.mainWindow) return;
    if (rt.mainWindow.isMinimized()) rt.mainWindow.restore();
    if (!rt.mainWindow.isVisible())  rt.mainWindow.show();
    rt.mainWindow.focus();
    if (rt.mainWindow.webContents && !rt.mainWindow.webContents.isDestroyed()) {
      rt.mainWindow.webContents.send('kasa:second-instance');
    }
  });

  registerCertificateErrorHandler(HOST);

  app.whenReady()
    .then(onAppReady)
    .catch((err) => {
      showFriendlyFatalError('BAS', err);
    });
}

// ─── UYGULAMA HAZIR ───────────────────────────────────────────────────────────

async function onAppReady() {
  try {
    verifyPackagedStartupResources();
    rt.PORT = await findFreePort();
    await createWindow();
    createTray();

    let progressTimer = null;
    const showProgressMessage = () => {
      if (!rt.mainWindow || rt.mainWindow.isDestroyed()) return;
      rt.mainWindow.webContents.executeJavaScript(`
        (function () {
          var lang = document.documentElement.lang || 'tr';
          var msgs = {
            tr: 'Arka plan hizmeti başlatılıyor, bu biraz sürebilir…',
            en: 'Starting background service, this may take a while…'
          };
          var el = document.querySelector('.loading-status');
          if (el) el.textContent = msgs[lang] || msgs.tr;
        })();
      `).catch(() => {});
    };
    const clearProgressTimer = () => {
      if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
    };

    const flaskTimeoutMs = isFirstRun() ? FLASK_TIMEOUT_FIRST_RUN_MS : FLASK_TIMEOUT_MS;

    if (isRunningAsAdmin()) {
      await dialog.showMessageBox(rt.mainWindow, {
        type: 'warning',
        title: 'ŞifreKasam',
        message: 'ŞifreKasam yönetici (Administrator) olarak çalışıyor.',
        detail: 'Yönetici yetkileri güvenlik riski oluşturabilir. Gerekmiyorsa programı normal kullanıcı olarak çalıştırmanız önerilir.',
        buttons: ['Devam Et'],
        defaultId: 0,
        noLink: true,
      });
    }

    try {
      progressTimer = setTimeout(showProgressMessage, 12_000);
      await startFlaskServer(flaskTimeoutMs);
    } catch (firstErr) {
      clearProgressTimer();

      if (rt.mainWindow && !rt.mainWindow.isDestroyed()) {
        rt.mainWindow.webContents.executeJavaScript(`
          (function () {
            var lang = document.documentElement.lang || 'tr';
            var msgs = {
              tr: 'İlk kurulum güvenlik taraması sürebilir, tekrar deneniyor…',
              en: 'Initial security scan may take time, retrying…'
            };
            var el = document.querySelector('.loading-status');
            if (el) el.textContent = msgs[lang] || msgs.tr;
          })();
        `).catch(() => {});
      }

      await stopFlaskServer();

      try {
        progressTimer = setTimeout(showProgressMessage, 12_000);
        await startFlaskServer(flaskTimeoutMs);
      } catch (retryErr) {
        clearProgressTimer();

        const result = await dialog.showMessageBox(rt.mainWindow, {
          type: 'warning',
          title: 'ŞifreKasam',
          message: 'Arka plan hizmeti başlatılamadı',
          detail: `${retryErr.message}\n\nTekrar denemek ister misiniz?`,
          buttons: ['Tekrar Dene', 'Çıkış'],
          defaultId: 0,
          noLink: true,
        });

        if (result.response === 0) {
          try {
            progressTimer = setTimeout(showProgressMessage, 12_000);
            if (rt.flaskProcess) {
              await new Promise((resolve, reject) => {
                waitForBackendReady(resolve, reject);
              });
            } else {
              await startFlaskServer(flaskTimeoutMs);
            }
          } catch (retryErr2) {
            clearProgressTimer();
            await stopFlaskServer();
            throw retryErr2;
          }
        } else {
          await stopFlaskServer();
          app.exit(1);
          return;
        }
      }
    }

    clearProgressTimer();

    if (rt.mainWindow) {
      try {
        const loadingLanguage = await rt.mainWindow.webContents.executeJavaScript(
          "localStorage.getItem('kasa-lang') || ''",
          true
        );
        if (['tr', 'en'].includes(loadingLanguage)) {
          await requestBackendJson('/settings/language', {
            method: 'POST',
            body: { language: loadingLanguage },
          });
        }
      } catch (_) { /* Loading ekranı tercihi yoksa kayıtlı backend dili kullanılır. */ }
      try {
        await rt.mainWindow.webContents.executeJavaScript('transitionToApp()');
      } catch (_) { /* loading.html henüz yüklenmemiş olabilir */ }
      rt.mainWindow.setBackgroundColor(getSavedWindowBackgroundColor());
      applyContentProtection();
      await loadBackendPage('/login?entry=loading');
      startLanReconciliation();
    }
  } catch (err) {
    const isSquirrel = process.argv.some(arg => arg.startsWith('--squirrel-'));
    if (isSquirrel) app.exit(1);
    else showFriendlyFatalError('SRV', err, 'ŞifreKasam hizmeti başlatılamadı.');
  }
}

// ─── UYGULAMA OLAYLARI ────────────────────────────────────────────────────────

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  rt.isQuiting = true;
  shutdownFlask();
});

app.on('will-quit', () => {
  rt.isQuiting = true;
  shutdownFlask();
});
