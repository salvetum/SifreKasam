// ─── ANA PENCERE ─────────────────────────────────────────────────────────────
// BrowserWindow kurulumu, loading.html'e ilk yükleme (tercihler query
// parametreleriyle) ve tüm webContents/session kancaları: harici link
// yönlendirme, sertifika gürültüsü susturma, token enjeksiyonu, ayar
// kayıtlarından sonra LAN/icerik-koruma senkronizasyonu, tepsiye küçültme.

const path = require('path');
const { app, BrowserWindow, shell } = require('electron');

const rt = require('./runtime-state');
const {
  APP_ROOT,
  APP_TOKEN,
  HOST,
  PROTOCOL,
  SSL_NOISE_PATTERNS,
  HISTORY_NAVIGATION_KEYS,
  safeModeRequested,
  resolvePath,
} = require('./config');
const {
  resolveEffectiveTheme,
  getSavedThemeMode,
  getSavedGlassEffects,
  getSavedGlassQuality,
  getSavedInterfaceAnimations,
  getSavedLanguage,
  getSavedAccentColor,
  getSavedBackgroundStyle,
  getSavedWindowBackgroundColor,
} = require('./preferences');
const { markLocalCertificateNoiseReported } = require('./certificates');
const { showFriendlyFatalError, relaunchInSafeMode } = require('./fatal-errors');
const { loadBackendPage, resolveLoadingPagePath } = require('./page-loader');
const {
  syncLanRuntimeState,
  applyContentProtection,
  checkMinimizeToTray,
} = require('./backend-process');
const { setRendererLowPower } = require('./tray');

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
      preload: path.join(APP_ROOT, 'preload.js'),
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

module.exports = { createWindow };
