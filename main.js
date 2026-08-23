// ─── IMPORTS ──────────────────────────────────────────────────────────────────

const { app, BrowserWindow, shell, dialog } = require('electron');
const path   = require('path');

const {
  SAFE_MODE_FLAG,
  getDataDir,
  isRunningAsAdmin,
  showFriendlyFatalError,
  relaunchInSafeMode,
} = require('./src/main/fatal-errors');
const { handleSquirrelEvent } = require('./src/main/squirrel');
const {
  registerCertificateErrorHandler,
  getPinnedHttpsOptions,
  getBackendKeepAliveAgent,
  resetPinnedCertificateCache,
  markLocalCertificateNoiseReported,
} = require('./src/main/certificates');
const {
  isFirstRun,
  resolveEffectiveTheme,
  getSavedThemeMode,
  getSavedGlassEffects,
  getSavedGlassQuality,
  getSavedInterfaceAnimations,
  getSavedLanguage,
  getSavedAccentColor,
  getSavedBackgroundStyle,
  getSavedHardwareAcceleration,
  getSavedWindowBackgroundColor,
} = require('./src/main/preferences');
const rt = require('./src/main/runtime-state');
const {
  checkMinimizeToTray,
  applyContentProtection,
  startFlaskServer,
  syncLanRuntimeState,
  startLanReconciliation,
  restartFlaskServer,
  stopFlaskServer,
  shutdownFlask,
  requestBackendJson,
  waitForBackendReady,
  findFreePort,
} = require('./src/main/backend-process');
const { createTray, setRendererLowPower } = require('./src/main/tray');
const {
  APP_TOKEN,
  HOST,
  FLASK_TIMEOUT_MS,
  FLASK_TIMEOUT_FIRST_RUN_MS,
    PROTOCOL,
  HISTORY_NAVIGATION_KEYS,
  SSL_NOISE_PATTERNS,
  resolvePath,
} = require('./src/main/config');
const {
  resolveLoadingPagePath,
  verifyPackagedStartupResources,
  loadBackendPage,
} = require('./src/main/page-loader');

// ─── SQUIRREL KURULUM HANDLER (EN ÜSTTE OLMALI) ──────────────────────────────

if (process.platform === 'win32' && handleSquirrelEvent({ resolvePath })) process.exit(0);

// ─── SABİTLER ─────────────────────────────────────────────────────────────────

const PYTHON_COMMAND = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const safeModeRequested = process.argv.includes(SAFE_MODE_FLAG);

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

// ─── PENCERE ──────────────────────────────────────────────────────────────────

async function createWindow() {
  rt.mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: resolvePath('favicon.ico'),
    backgroundColor: getSavedWindowBackgroundColor(),
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      devTools: !app.isPackaged,
      spellcheck: false,
      enableWebSQL: false,
      backgroundThrottling: false, // Arka planda düşük güç modunu kendimiz yönetiyoruz böylece siyah ekran problemi gidiyor (umarım).
    },
  });

  rt.mainWindow.setMenu(null);
  let windowShown = false;
  const showWindow = () => {
    if (windowShown || !rt.mainWindow || rt.mainWindow.isDestroyed()) return;
    windowShown = true;
    rt.mainWindow.show();
  };
  rt.mainWindow.once('ready-to-show', showWindow);
  setTimeout(showWindow, 1_200);
  await rt.mainWindow.loadFile(resolveLoadingPagePath(), {
    query: {
      theme:        resolveEffectiveTheme(),
      themeMode:    getSavedThemeMode(),
      glassEffects: getSavedGlassEffects() ? 'on' : 'off',
      glassQuality: getSavedGlassQuality(),
      animations:   getSavedInterfaceAnimations() ? 'on' : 'off',
      lang:         getSavedLanguage(),
      accent:       getSavedAccentColor(),
      background:   getSavedBackgroundStyle(),
    },
  });

  // Harici linkleri sistem tarayıcısında aç
  rt.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsedUrl = new URL(url);
      if (['https:', 'http:', 'mailto:'].includes(parsedUrl.protocol)) {
        // .catch() zorunlu: Sistemde varsayilan tarayici yoksa (orn. WSL/xdg-open basarisiz)
        // Promise reject olur. Bu durum app'i kapatmamali, sadece link acilmamis olur.
        shell.openExternal(url).catch((err) => {
          console.warn(`Harici baglanti acilamadi (${url}): ${err.message}`);
        });
      }
    } catch (_) {}
    return { action: 'deny' };
  });

  // Ana uygulama penceresinin yerel kasa arayüzünden ayrılmasını engelle.
  rt.mainWindow.webContents.on('will-navigate', (event, url) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (_) {
      event.preventDefault();
      return;
    }
    const isLocalAppUrl = parsedUrl.protocol === `${PROTOCOL}:`
      && parsedUrl.hostname === HOST
      && Number(parsedUrl.port) === rt.PORT;
    if (isLocalAppUrl) return;

    event.preventDefault();
    if (['https:', 'http:', 'mailto:'].includes(parsedUrl.protocol)) {
      // .catch() zorunlu: Ayni nedenle setWindowOpenHandler'daki ile ayni.
      shell.openExternal(url).catch((err) => {
        console.warn(`Harici baglanti acilamadi (${url}): ${err.message}`);
      });
    }
  });

  rt.mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || !validatedURL?.startsWith(`https://${HOST}:`)) return;
    const description = String(errorDescription || '');
    const isCertificateNoise = errorCode === -202
      || errorCode === -201
      || SSL_NOISE_PATTERNS.some((pattern) => description.includes(pattern));
    if (isCertificateNoise && rt.backendPageRecoveryAttempts < 2) {
      event.preventDefault();
      rt.backendPageRecoveryAttempts += 1;
      if (markLocalCertificateNoiseReported()) {
        console.warn(`Yerel self-signed SSL uyarısı için yeniden deneme yapılıyor (${errorCode}: ${description}).`);
      }
      setTimeout(() => {
        if (!rt.mainWindow || rt.mainWindow.isDestroyed()) return;
        loadBackendPage('/login?entry=loading').catch((error) => {
          showFriendlyFatalError('WEB', error, 'ŞifreKasam arayüzü başlatılamadı.');
        });
      }, 450);
      return;
    }

    showFriendlyFatalError(
      'WEB',
      new Error(`Yerel arayüz yüklenemedi (${errorCode}: ${description}). URL: ${validatedURL}`),
      'ŞifreKasam arayüzü başlatılamadı.'
    );
  });

  rt.mainWindow.webContents.on('did-finish-load', () => {
    rt.backendPageRecoveryAttempts = 0;
  });

  rt.mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const rendererError = new Error(
      `Renderer kapandı: ${details.reason} (çıkış kodu: ${details.exitCode ?? 'yok'})`
    );
    if (details.reason === 'crashed' && !safeModeRequested) {
      relaunchInSafeMode(rendererError);
      return;
    }
    showFriendlyFatalError(
      'RND',
      rendererError,
      'ŞifreKasam görsel bileşeni beklenmedik şekilde kapandı.'
    );
  });

  rt.mainWindow.webContents.on('console-message', (event, _level, message, _line, sourceId) => {
    const text = String(message || '');
    const source = String(sourceId || '');
    const isLocalCertificateNoise = source.startsWith(`${PROTOCOL}://${HOST}:`)
      && SSL_NOISE_PATTERNS.some((pattern) => text.includes(pattern));
    if (!isLocalCertificateNoise) return;

    event.preventDefault();
    if (markLocalCertificateNoiseReported()) {
      console.warn('Yerel self-signed SSL konsol uyarıları tekrar etmeyecek şekilde susturuldu.');
    }
  });

  rt.mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = input.key || '';
    const isHistoryKey = HISTORY_NAVIGATION_KEYS.has(key)
      || (input.alt && (key === 'ArrowLeft' || key === 'ArrowRight'));
    if (input.type === 'keyDown' && isHistoryKey) {
      event.preventDefault();
    }
  });

  // Yalnızca stateless API isteklerine (heartbeat, lan-info vb.) token ekle.
  // State-changing istekler (save_settings, add, edit vb.) X-CSRF-Token ile korunuyor;
  // tüm isteklere token enjekte etmek XSS durumunda CSRF korumasını baypas eder.
  const _TOKEN_INJECT_PATHS = new Set([
    '/heartbeat', '/shutdown', '/api/lan-info', '/settings/runtime',
  ]);
  rt.mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: [`${PROTOCOL}://${HOST}:${rt.PORT}/*`] },
    (details, callback) => {
      try {
        const { pathname } = new URL(details.url);
        if (_TOKEN_INJECT_PATHS.has(pathname)) {
          details.requestHeaders['X-App-Token'] = APP_TOKEN;
        }
      } catch (_) {}
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  rt.mainWindow.webContents.session.webRequest.onCompleted(
    { urls: [`${PROTOCOL}://${HOST}:${rt.PORT}/save_settings`] },
    (details) => {
      if (details.method === 'POST' && details.statusCode >= 200 && details.statusCode < 300) {
        setTimeout(syncLanRuntimeState, 250);
      }
    }
  );

  rt.mainWindow.webContents.session.webRequest.onCompleted(
    { urls: [`${PROTOCOL}://${HOST}:${rt.PORT}/settings/content-protection`] },
    (details) => {
      if (details.method === 'POST' && details.statusCode >= 200 && details.statusCode < 300) {
        setTimeout(applyContentProtection, 250);
      }
    }
  );

  // Kapat yerine gizle / tepside çalışmaya devam et
  rt.mainWindow.on('close', (event) => {
    if (rt.isQuiting) return;
    event.preventDefault();
    checkMinimizeToTray()
      .then((shouldMinimize) => {
        if (shouldMinimize) {
          setRendererLowPower(true);
          rt.mainWindow.hide();
        } else {
          rt.isQuiting = true;
          app.quit();
        }
      })
      .catch(() => {
        rt.isQuiting = true;
        app.quit();
      });
  });

  rt.mainWindow.on('hide', () => {
    setRendererLowPower(true);
  });
  rt.mainWindow.on('show', () => setRendererLowPower(false));
  rt.mainWindow.on('minimize', () => {
    setRendererLowPower(true);
  });
  rt.mainWindow.on('restore', () => setRendererLowPower(false));
  rt.mainWindow.on('closed', () => { rt.mainWindow = null; });
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
