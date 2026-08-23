// ─── IMPORTS ──────────────────────────────────────────────────────────────────

const { app, BrowserWindow, shell, dialog, Tray, Menu } = require('electron');
const path   = require('path');
const fs     = require('fs');
const net    = require('net');
const https  = require('https');
const kill   = require('tree-kill');
const { spawn, spawnSync } = require('child_process');

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
const { createBackendNet } = require('./src/main/backend-net');
const {
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

// Backend ag katmani: sabitler/durum enjeksiyonu
const { requestBackendJson, waitForBackendReady, findFreePort } = createBackendNet({
  host: HOST,
  getToken: () => APP_TOKEN,
  getPort: () => rt.PORT,
  timeoutMs: FLASK_TIMEOUT_MS,
  retryIntervalMs: RETRY_INTERVAL_MS,
  probeTimeoutMs: BACKEND_PROBE_TIMEOUT_MS,
});

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

// ─── SİSTEM TEPSİSİ ───────────────────────────────────────────────────────────

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

// ─── FLASK AYARLARI SORGUSU ───────────────────────────────────────────────────

function checkMinimizeToTray() {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: HOST, port: rt.PORT, path: '/settings/tray',
        method: 'GET', headers: { 'X-App-Token': APP_TOKEN }, timeout: 1000,
        ...getPinnedHttpsOptions() },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try   { resolve(JSON.parse(data).minimize_to_tray === true); }
          catch { resolve(false); }
        });
      }
    );
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Ekran yakalama engeli yalnızca Windows/macOS native API'lerinde çalışır;
// Linux'ta setContentProtection no-op'tur, bu yüzden çağrıyı hiç yapmıyoruz.
async function applyContentProtection() {
  if (!rt.PORT) return;
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  try {
    const state = await requestBackendJson('/settings/content-protection');
    if (rt.mainWindow && !rt.mainWindow.isDestroyed()) {
      rt.mainWindow.setContentProtection(state.content_protection_enabled === true);
    }
  } catch (_) {
    /* Backend henüz hazır değilse sessizce atla; değişiklik hook'u tekrar dener. */
  }
}

// ─── FLASK SUNUCUSU ───────────────────────────────────────────────────────────

async function startFlaskServer(timeoutMs) {
  if (rt.flaskProcess) {
    await stopFlaskServer();
  }
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const backendBinary = isWin ? 'SifreKasam.exe' : 'SifreKasam';
    const flaskHost = rt.lanRuntimeEnabled ? '0.0.0.0' : HOST;
    const [command, args] = app.isPackaged
      ? [resolvePath(path.join('backend', backendBinary)), []]
      : [PYTHON_COMMAND, [path.join(__dirname, 'flask_app', 'app.py')]];

    console.log(`Flask baslatiliyor: ${command} ${args.join(' ')} (${flaskHost}:${rt.PORT})`);

    const spawnedProcess = spawn(command, args, {
      env: { ...process.env, APP_TOKEN,
             FLASK_SECRET_KEY: APP_TOKEN,
             APP_VERSION: app.getVersion(),
             FLASK_HOST: flaskHost,
             FLASK_PORT: String(rt.PORT), PORT: String(rt.PORT),
             KASA_RESET_LAN_ON_START: rt.resetSavedLanOnNextStart ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    rt.flaskProcess = spawnedProcess;
    rt.resetSavedLanOnNextStart = false;
    let startupComplete = false;
    let startupSettled = false;

    const failStartup = (error) => {
      if (startupSettled) return;
      startupSettled = true;
      reject(error);
    };
    const completeStartup = () => {
      if (startupSettled) return;
      startupSettled = true;
      startupComplete = true;
      resolve();
    };

    let stderrBuffer = '';
    spawnedProcess.stdout.on('data', () => {});
    spawnedProcess.stderr.on('data', (data) => {
      stderrBuffer += data.toString();
      if (stderrBuffer.length > 4096) stderrBuffer = stderrBuffer.slice(-4096);
    });

    spawnedProcess.on('error', (err) =>
      failStartup(new Error(`Flask baslatilamadi (spawn hatası): ${err.message}\nKomut: ${command}`))
    );
    spawnedProcess.on('exit', (code, signal) => {
      if (rt.flaskProcess === spawnedProcess) rt.flaskProcess = null;
      const exitDetail = `kod ${code ?? 'yok'}, sinyal ${signal || 'yok'}`;
      const error = new Error(`Flask beklenmedik cikis (${exitDetail}):\n${stderrBuffer}`);
      if (!startupComplete) {
        failStartup(error);
      } else if (!rt.isQuiting && !rt.isRestartingFlask) {
        showFriendlyFatalError('BCK', error, 'ŞifreKasam arka plan hizmeti beklenmedik şekilde durdu.');
      }
    });

    waitForBackendReady(completeStartup, failStartup, timeoutMs);
  });
}


async function syncLanRuntimeState() {
  if (!rt.PORT || rt.isRestartingFlask) return;
  try {
    const state = await requestBackendJson('/settings/runtime');
    // Yalnizca kayitli (istenen) degerle gercek runtime'i kiyasla.
    // rt.lanRuntimeEnabled onbellek degeri restart yarida kalirsa gercekten
    // kopabildigi icin kiyaslama olarak kullanilmaz; aksi halde her ayar
    // kaydinda gereksiz restart tetiklenip yukleme ekrani kalici olabilir.
    const desiredLanEnabled = state.lan_enabled === true;
    const actualLanEnabled = state.runtime_lan_enabled === true;
    if (rt.lanRuntimeEnabled !== desiredLanEnabled) {
      rt.lanRuntimeEnabled = desiredLanEnabled;
      startLanReconciliation();
    }
    if (desiredLanEnabled !== actualLanEnabled) {
      const now = Date.now();
      // Restart basarisiz olursa poller belirli araliklarla yeniden dener;
      // restart firtinasi olusmamasi icin iki deneme arasina minimum sure koy.
      if (now - rt.lastLanRestartAttempt < LAN_RESTART_MIN_INTERVAL_MS) return;
      rt.lastLanRestartAttempt = now;
      await restartFlaskServer(desiredLanEnabled);
    }
  } catch (err) {
    console.warn(`LAN runtime senkronizasyonu atlandi: ${err.message}`);
  }
}

// webRequest.onCompleted cekicisi bazi ortamlarda (paketli uygulama) saglikli
// tetiklenmeyebiliyor; LAN ayari kaydedildikten sonra sunucunun gercekten
// 0.0.0.0'a baglanmasi icin periyodik bir mutabakat poller'i calistirir.
// LAN kapaliyken her 3 sn'de TLS handshake + DB sorgusu yapmak gereksiz CPU
// harcar; bos durumda 20 sn, LAN acikken 5 sn'de bir kontrol yeterlidir.
function startLanReconciliation() {
  if (rt.lanReconciliationTimer) clearInterval(rt.lanReconciliationTimer);
  const interval = rt.lanRuntimeEnabled
    ? LAN_RECONCILE_ACTIVE_INTERVAL_MS
    : LAN_RECONCILE_IDLE_INTERVAL_MS;
  rt.lanReconciliationTimer = setInterval(() => {
    syncLanRuntimeState().catch(() => {});
  }, interval);
  if (rt.lanReconciliationTimer.unref) rt.lanReconciliationTimer.unref();
}

// ─── LAN FIREWALL (paketli uygulama) ─────────────────────────────────────────

function lanFirewallRuleName() {
  return 'SifreKasam LAN Erisimi';
}

function backendProcessPath() {
  const exe = process.platform === 'win32' ? 'SifreKasam.exe' : 'SifreKasam';
  return app.isPackaged ? resolvePath('backend', exe) : process.execPath;
}

function lanFirewallRuleExists(ruleName) {
  try {
    const result = spawnSync(
      'netsh',
      ['advfirewall', 'firewall', 'show', 'rule', `name=${ruleName}`],
      { encoding: 'utf8', timeout: 6000 }
    );
    if (result.status !== 0) return false;
    return /Ok\./.test(result.stdout) && !/No rules match/.test(result.stdout);
  } catch (_) {
    return false;
  }
}

function addLanFirewallRule(ruleName, program) {
  try {
    const result = spawnSync(
      'netsh',
      ['advfirewall', 'firewall', 'add', 'rule',
       `name=${ruleName}`,
       'dir=in',
       'action=allow',
       `program="${program}"`,
       'profile=private,public',
       'enable=yes'],
      { encoding: 'utf8', timeout: 10000 }
    );
    return result.status === 0 && /Ok\./.test(result.stdout);
  } catch (_) {
    return false;
  }
}

async function ensureLanFirewallRuleAndWarn() {
  if (process.platform !== 'win32') return;
  const ruleName = lanFirewallRuleName();
  if (lanFirewallRuleExists(ruleName)) return;
  const program = backendProcessPath();
  if (!program) return;
  if (addLanFirewallRule(ruleName, program)) return;
  try {
    await dialog.showMessageBox(rt.mainWindow, {
      type: 'warning',
      title: 'ŞifreKasam',
      message: 'LAN erişimi açıldı.',
      detail: 'Windows Güvenlik Duvarı bu uygulamanın ağdan erişimini engelleyebilir.\n\nTelefon hâlâ bağlanamıyorsa, yönetici olarak şu komutu çalıştırın:\n\nnetsh advfirewall firewall add rule name="SifreKasam LAN Erisimi" dir=in action=allow program="' + program + '" profile=private,public enable=yes',
      buttons: ['Tamam'],
      noLink: true,
    });
  } catch (_) {}
}

async function restartFlaskServer(nextLanEnabled) {
  rt.isRestartingFlask = true;
  try {
    if (rt.mainWindow && !rt.mainWindow.isDestroyed()) {
      rt.mainWindow.webContents.executeJavaScript(
        "document.body.classList.add('is-page-loading')"
      ).catch(() => {});
    }
    await stopFlaskServer();
    rt.lanRuntimeEnabled = nextLanEnabled;
    startLanReconciliation();
    // LAN açılışında sertifika LAN IP içerecek şekilde yeniden üretilmiş
    // olabilir; eskimiş pin önbelleğini temizle.
    resetPinnedCertificateCache();
    await startFlaskServer(60000); // LAN restart için uzun timeout
    if (nextLanEnabled) {
      await ensureLanFirewallRuleAndWarn();
    }
    // Flask başarıyla restart olduktan sonra, sayfayı yeniden yükle
    if (rt.mainWindow && !rt.mainWindow.isDestroyed()) {
      await loadBackendPage('/login?entry=loading');
    }
  } catch (err) {
    dialog.showErrorBox('Ağ Ayarı Uygulanamadı', err.message);
  } finally {
    rt.isRestartingFlask = false;
    if (rt.mainWindow && !rt.mainWindow.isDestroyed()) {
      rt.mainWindow.webContents.executeJavaScript(
        "document.body.classList.remove('is-page-loading')"
      ).catch(() => {});
    }
  }
}

function stopFlaskServer() {
  return new Promise((resolve) => {
    const proc = rt.flaskProcess;
    if (!proc) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (rt.flaskProcess === proc) rt.flaskProcess = null;
      resolve();
    };
    const onExit = () => {
      if (rt.flaskProcess === proc) rt.flaskProcess = null;
      finish();
    };

    proc.once('exit', onExit);
    proc.once('error', onExit);

    requestBackendJson('/shutdown', { method: 'POST', timeout: 800 }).catch(() => {});

    try {
      kill(proc.pid, 'SIGTERM', () => {});
    } catch (_) {
      finish();
      return;
    }

    // SIGTERM sonrası belirli bir süre içinde çıkmazsa SIGKILL'e yükselt.
    const killTimer = setTimeout(() => {
      if (settled) return;
      try { kill(proc.pid, 'SIGKILL'); } catch (_) { finish(); }
    }, 2000);

    // Güvenlik ağı: beklenmedik bir durumda promise asla asılı kalmaz.
    const fallbackTimer = setTimeout(finish, 5000);
    proc.once('exit', () => {
      clearTimeout(killTimer);
      clearTimeout(fallbackTimer);
    });
  });
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

function shutdownFlask() {
  if (!rt.flaskProcess) return;

  const pid = rt.flaskProcess.pid;
  rt.flaskProcess = null;

  const req = https.request({
    hostname: HOST, port: rt.PORT, path: '/shutdown',
    method: 'POST', headers: { 'X-App-Token': APP_TOKEN },
    ...getPinnedHttpsOptions(),
  });
  req.on('error', () => {});
  req.end();

  try {
    kill(pid, 'SIGTERM', (err) => {
      if (err) {
        try { kill(pid, 'SIGKILL'); } catch (_) {}
      }
    });
  } catch (_) {}
}
