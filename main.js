// ─── IMPORTS ──────────────────────────────────────────────────────────────────

const { app, BrowserWindow, shell, dialog, Tray, Menu } = require('electron');
const path   = require('path');
const fs     = require('fs');
const net    = require('net');
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const kill   = require('tree-kill');
const { spawn, spawnSync } = require('child_process');

let fatalErrorShown = false;

function createUserErrorCode(area, error) {
  const detail = error instanceof Error
    ? `${error.name}:${error.message}`
    : String(error || 'unknown');
  const suffix = crypto.createHash('sha256').update(`${area}:${detail}`).digest('hex').slice(0, 6).toUpperCase();
  return `SK-${area}-${suffix}`;
}

function writeFatalDiagnostic(code, error) {
  try {
    const logsDir = app.getPath('logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const detail = error instanceof Error ? (error.stack || error.message) : String(error || 'unknown');
    fs.appendFileSync(
      path.join(logsDir, 'sifrekasam-errors.log'),
      `[${new Date().toISOString()}] ${code}\n${detail}\n\n`,
      'utf8'
    );
  } catch (_) {}
}

function showFriendlyFatalError(area, error, message = 'Kurulum veya başlatma işlemi tamamlanamadı.') {
  if (fatalErrorShown) return;
  fatalErrorShown = true;
  const code = createUserErrorCode(area, error);
  writeFatalDiagnostic(code, error);
  console.error(`[${code}]`, error);

  const showDialog = () => {
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'ŞifreKasam',
      message,
      detail: `Hata kodu: ${code}\n\nLütfen bu kodu geliştiriciye bildirin.`,
      buttons: ['Tamam'],
      defaultId: 0,
      noLink: true,
    });
    app.exit(1);
  };

  if (app.isReady()) showDialog();
  else app.whenReady().then(showDialog).catch(() => app.exit(1));
}

function relaunchInSafeMode(error) {
  const code = createUserErrorCode('GPU', error);
  writeFatalDiagnostic(code, error);
  console.error(`[${code}] Renderer crashed; restarting with hardware acceleration disabled.`);
  const args = process.argv.slice(1).filter((arg) => arg !== SAFE_MODE_FLAG);
  app.relaunch({ args: [...args, SAFE_MODE_FLAG] });
  app.exit(0);
}

process.on('uncaughtException', (error) => showFriendlyFatalError('UCP', error));
process.on('unhandledRejection', (reason) => showFriendlyFatalError('UPR', reason));

const CANONICAL_UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SifreKasam';
const LEGACY_UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SifreKasam',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ŞifreKasam',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SifrekasamV2.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.6.2-beta.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.6.2-beta.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.6.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.6.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.6.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.6.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.6.0',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.6.0',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.12',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.12',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.11',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.11',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.10-beta.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.10-beta.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.9-beta.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.9-beta.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.9-beta.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.9-beta.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.9-beta',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.9-beta',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.9',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.9',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.8',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.8',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.7',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.7',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.6',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.6',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.5',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.5',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.4',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.4',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.0',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.0',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.4.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.4.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.4.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.4.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.4.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.4.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.4.0',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.4.0',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.3.4',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.3.4',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.3.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.3.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.3.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.3.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.3.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.3.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.2',
];
const ALL_UNINSTALL_KEYS = [CANONICAL_UNINSTALL_KEY, ...LEGACY_UNINSTALL_KEYS];

// ─── SQUIRREL KURULUM HANDLER (EN ÜSTTE OLMALI) ──────────────────────────────

if (process.platform === 'win32' && handleSquirrelEvent()) process.exit(0);

function handleSquirrelEvent() {
  const squirrelEvent = process.argv.find(arg => arg.startsWith('--squirrel-'));
  if (!squirrelEvent) return false;

  const rootAtomFolder  = path.resolve(process.execPath, '..', '..');
  const updateDotExe    = path.join(rootAtomFolder, 'Update.exe');
  const exeName         = path.basename(process.execPath);

  const runUpdate = (args) => {
    try {
      spawnSync(updateDotExe, args, {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (_) {}
  };

  switch (squirrelEvent) {
    case '--squirrel-install':
    case '--squirrel-updated':
      runUpdate(['--createShortcut', exeName]);
      updateWindowsUninstallMetadata(rootAtomFolder);
      return true;
    case '--squirrel-uninstall':
      runUpdate(['--removeShortcut', exeName]);
      cleanupApplicationData(rootAtomFolder);
      return true;
    case '--squirrel-obsolete':
      return true;
  }
  return false;
}

function cleanupApplicationData(currentInstallRoot) {
  if (process.platform !== 'win32') return;

  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  const publicProfile = process.env.PUBLIC;

  const appDataNames = [
    '.SifrekasamV2',
  'sifrekasam',
  'SifreKasam',
  'sifrekasam-v2.6.2-beta.2',
  'sifrekasam-v2.6.1',
  'sifrekasam-v2.6.0',
  'sifrekasam-v2.5.12',
  'sifrekasam-v2.5.11',
    'sifrekasam-v2.5.10',
    'sifrekasam-v2.5.10-beta.1',
    'sifrekasam-v2.5.9-beta.3',
    'sifrekasam-v2.5.9-beta.2',
    'sifrekasam-v2.5.9-beta',
    'sifrekasam-v2.5.9',
    'sifrekasam-v2.5.8',
    'sifrekasam-v2.5.7',
    'sifrekasam-v2.5.6',
    'sifrekasam-v2.5.5',
    'sifrekasam-v2.5.4',
    'sifrekasam-v2.5.3',
    'sifrekasam-v2.5.2',
    'sifrekasam-v2.5.1',
    'sifrekasam-v2.5.0',
    'sifrekasam-v2.4.3',
    'sifrekasam-v2.4.2',
    'sifrekasam-v2.4.1',
    'sifrekasam-v2.4.0',
    'sifrekasam-v2.3.4',
    'ŞifreKasam',
    'sifrekasam-v2.3.3',
    'sifrekasam-v2.3.2',
    'sifrekasam-v2.3.1',
    'sifrekasam-v2.3',
    'sifrekasam-v2.2',
    'SifrekasamV2.1',
    'Kasa',
  ];

  const dataTargets = [
    ...appDataNames.flatMap(name => [
      appData && path.join(appData, name),
      localAppData && path.join(localAppData, name),
    ]),
    localAppData && path.join(localAppData, 'Programs', 'SifreKasam'),
    localAppData && path.join(localAppData, 'Programs', 'ŞifreKasam'),
    localAppData && path.join(localAppData, 'SifrekasamV2.1'),
  ].filter(Boolean);

  dataTargets.forEach(targetPath => {
    safeRemovePath(targetPath, [appData, localAppData], currentInstallRoot);
  });

  removeKnownShortcuts(appData, userProfile, publicProfile);
  removeKnownRegistryKeys();
}

function safeRemovePath(targetPath, allowedRoots, currentInstallRoot) {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return;

    const resolvedTarget = path.resolve(targetPath);
    const resolvedAllowedRoots = allowedRoots
      .filter(Boolean)
      .map(root => path.resolve(root));
    const targetLower = resolvedTarget.toLowerCase();
    const isAllowed = resolvedAllowedRoots.some(root => {
      const rootLower = root.toLowerCase();
      return targetLower === rootLower || targetLower.startsWith(rootLower + path.sep.toLowerCase());
    });
    if (!isAllowed) return;

    if (currentInstallRoot) {
      const installLower = path.resolve(currentInstallRoot).toLowerCase();
      if (targetLower === installLower || installLower.startsWith(targetLower + path.sep.toLowerCase())) {
        return;
      }
    }

    fs.rmSync(resolvedTarget, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  } catch (_) {}
}

function removeKnownShortcuts(appData, userProfile, publicProfile) {
  const shortcutDirs = [
    appData && path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    userProfile && path.join(userProfile, 'Desktop'),
    publicProfile && path.join(publicProfile, 'Desktop'),
  ].filter(Boolean);
  const shortcutNames = [
    'ŞifreKasam.lnk',
    'SifreKasam.lnk',
    'SifrekasamV2.1.lnk',
    'Kasa.lnk',
  ];

  shortcutDirs.forEach(dir => {
    shortcutNames.forEach(name => {
      try {
        const shortcutPath = path.join(dir, name);
        if (fs.existsSync(shortcutPath)) fs.rmSync(shortcutPath, { force: true });
      } catch (_) {}
    });
  });
}

function deleteRegistryKey(key) {
  try {
    spawnSync('reg.exe', ['delete', key, '/f'], { stdio: 'ignore', windowsHide: true });
  } catch (_) {}
}

function writeRegistryValue(key, name, value) {
  try {
    spawnSync(
      'reg.exe',
      ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'],
      { stdio: 'ignore', windowsHide: true }
    );
  } catch (_) {}
}

function removeKnownRegistryKeys() {
  ALL_UNINSTALL_KEYS.forEach(deleteRegistryKey);
}

function updateWindowsUninstallMetadata(installRoot) {
  if (process.platform !== 'win32') return;

  const iconFile = resolvePath('favicon.ico');
  const appIcon = fs.existsSync(iconFile) ? iconFile : `${process.execPath},0`;
  const updateExe = installRoot ? path.join(installRoot, 'Update.exe') : null;
  const values = [
    ['DisplayIcon', appIcon],
    ['DisplayName', 'ŞifreKasam'],
    ['Publisher', 'Salvetum'],
    ['DisplayVersion', app.getVersion()],
    ['InstallLocation', path.dirname(process.execPath)],
    ...(updateExe ? [
      ['UninstallString', `"${updateExe}" --uninstall -s`],
      ['QuietUninstallString', `"${updateExe}" --uninstall -s`],
    ] : []),
  ];

  LEGACY_UNINSTALL_KEYS.forEach(deleteRegistryKey);
  values.forEach(([name, value]) => {
    writeRegistryValue(CANONICAL_UNINSTALL_KEY, name, value);
  });
}

// ─── SABİTLER ─────────────────────────────────────────────────────────────────

const APP_TOKEN        = crypto.randomBytes(32).toString('hex');
const HOST             = '127.0.0.1';
const FLASK_TIMEOUT_MS = 60_000;
const FLASK_TIMEOUT_FIRST_RUN_MS = 90_000;
const RETRY_INTERVAL_MS = 500;
const BACKEND_PROBE_TIMEOUT_MS = 1_500;
const PYTHON_COMMAND = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const SAFE_MODE_FLAG = '--sifrekasam-safe-mode';
const safeModeRequested = process.argv.includes(SAFE_MODE_FLAG);

const PROTOCOL            = 'https';
const GLASS_EFFECTS_FALSY = new Set(['false', '0', 'off', 'disabled']);
const HISTORY_NAVIGATION_KEYS = new Set(['BrowserBack', 'BrowserForward']);
const SSL_NOISE_PATTERNS = [
  'ERR_CERT_AUTHORITY_INVALID',
  'ERR_CERT_COMMON_NAME_INVALID',
  'ERR_CERT_DATE_INVALID',
  'ERR_CERT_INVALID',
  'certificate',
  'SSL',
];

// ─── UYGULAMA DURUMU ──────────────────────────────────────────────────────────

let PORT         = 0;
let flaskProcess = null;
let mainWindow   = null;
let tray         = null;
let isQuiting    = false;
let lanRuntimeEnabled = false;
let resetSavedLanOnNextStart = true;
let isRestartingFlask = false;
let hasReportedLocalCertificateNoise = false;
let rendererLowPowerRequested = false;
let backendPageRecoveryAttempts = 0;

app.commandLine.appendSwitch('disable-spell-checking');
if (safeModeRequested) app.disableHardwareAcceleration();

// ─── TEK ÖRNEK KİLİDİ ────────────────────────────────────────────────────────

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible())  mainWindow.show();
    mainWindow.focus();
  });

  // Self-signed SSL sertifikasını kabul et
  app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
    if (url.startsWith(`https://${HOST}:`)) {
      event.preventDefault();
      if (!hasReportedLocalCertificateNoise) {
        hasReportedLocalCertificateNoise = true;
        console.warn('Yerel self-signed SSL sertifikası kabul edildi; tekrar eden Chromium sertifika logları susturuldu.');
      }
      callback(true);
    } else {
      callback(false);
    }
  });

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
    PORT = await findFreePort();
    await createWindow();
    createTray();

    let progressTimer = null;
    const showProgressMessage = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.executeJavaScript(`
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

    try {
      progressTimer = setTimeout(showProgressMessage, 12_000);
      await startFlaskServer(flaskTimeoutMs);
    } catch (firstErr) {
      clearProgressTimer();

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.executeJavaScript(`
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

        const result = await dialog.showMessageBox(mainWindow, {
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
            if (flaskProcess) {
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

    if (mainWindow) {
      try {
        const loadingLanguage = await mainWindow.webContents.executeJavaScript(
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
        await mainWindow.webContents.executeJavaScript('transitionToApp()');
      } catch (_) { /* loading.html henüz yüklenmemiş olabilir */ }
      mainWindow.setBackgroundColor(getSavedWindowBackgroundColor());
      await loadBackendPage('/login?entry=loading');
    }
  } catch (err) {
    const isSquirrel = process.argv.some(arg => arg.startsWith('--squirrel-'));
    if (isSquirrel) app.exit(1);
    else showFriendlyFatalError('SRV', err, 'ŞifreKasam hizmeti başlatılamadı.');
  }
}

// ─── PENCERE ──────────────────────────────────────────────────────────────────

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: resolvePath('favicon.ico'),
    backgroundColor: getSavedWindowBackgroundColor(),
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: !app.isPackaged,
      spellcheck: false,
      enableWebSQL: false,
      backgroundThrottling: false, // Arka planda düşük güç modunu kendimiz yönetiyoruz böylece siyah ekran problemi gidiyor (umarım).
    },
  });

  mainWindow.setMenu(null);
  let windowShown = false;
  const showWindow = () => {
    if (windowShown || !mainWindow || mainWindow.isDestroyed()) return;
    windowShown = true;
    mainWindow.show();
  };
  mainWindow.once('ready-to-show', showWindow);
  setTimeout(showWindow, 1_200);
  await mainWindow.loadFile(resolveLoadingPagePath(), {
    query: {
      theme:        getSavedTheme(),
      glassEffects: getSavedGlassEffects() ? 'on' : 'off',
      glassQuality: getSavedGlassQuality(),
      animations:   getSavedInterfaceAnimations() ? 'on' : 'off',
      lang:         getSavedLanguage(),
      accent:       getSavedAccentColor(),
      background:   getSavedBackgroundStyle(),
    },
  });

  // Harici linkleri sistem tarayıcısında aç
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
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
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (_) {
      event.preventDefault();
      return;
    }
    const isLocalAppUrl = parsedUrl.protocol === `${PROTOCOL}:`
      && parsedUrl.hostname === HOST
      && Number(parsedUrl.port) === PORT;
    if (isLocalAppUrl) return;

    event.preventDefault();
    if (['https:', 'http:', 'mailto:'].includes(parsedUrl.protocol)) {
      // .catch() zorunlu: Ayni nedenle setWindowOpenHandler'daki ile ayni.
      shell.openExternal(url).catch((err) => {
        console.warn(`Harici baglanti acilamadi (${url}): ${err.message}`);
      });
    }
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || !validatedURL?.startsWith(`https://${HOST}:`)) return;
    const description = String(errorDescription || '');
    const isCertificateNoise = errorCode === -202
      || errorCode === -201
      || SSL_NOISE_PATTERNS.some((pattern) => description.includes(pattern));
    if (isCertificateNoise && backendPageRecoveryAttempts < 2) {
      event.preventDefault();
      backendPageRecoveryAttempts += 1;
      if (!hasReportedLocalCertificateNoise) {
        hasReportedLocalCertificateNoise = true;
        console.warn(`Yerel self-signed SSL uyarısı için yeniden deneme yapılıyor (${errorCode}: ${description}).`);
      }
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
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

  mainWindow.webContents.on('did-finish-load', () => {
    backendPageRecoveryAttempts = 0;
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
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

  mainWindow.webContents.on('console-message', (event, _level, message, _line, sourceId) => {
    const text = String(message || '');
    const source = String(sourceId || '');
    const isLocalCertificateNoise = source.startsWith(`${PROTOCOL}://${HOST}:`)
      && SSL_NOISE_PATTERNS.some((pattern) => text.includes(pattern));
    if (!isLocalCertificateNoise) return;

    event.preventDefault();
    if (!hasReportedLocalCertificateNoise) {
      hasReportedLocalCertificateNoise = true;
      console.warn('Yerel self-signed SSL konsol uyarıları tekrar etmeyecek şekilde susturuldu.');
    }
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = input.key || '';
    const isHistoryKey = HISTORY_NAVIGATION_KEYS.has(key)
      || (input.alt && (key === 'ArrowLeft' || key === 'ArrowRight'));
    if (input.type === 'keyDown' && isHistoryKey) {
      event.preventDefault();
    }
  });

  // Her isteğe APP_TOKEN header'ı ekle
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: [`${PROTOCOL}://${HOST}:${PORT}/*`] },
    (details, callback) => {
      details.requestHeaders['X-App-Token'] = APP_TOKEN;
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  mainWindow.webContents.session.webRequest.onCompleted(
    { urls: [`${PROTOCOL}://${HOST}:${PORT}/save_settings`] },
    (details) => {
      if (details.method === 'POST' && details.statusCode >= 200 && details.statusCode < 300) {
        setTimeout(syncLanRuntimeState, 250);
      }
    }
  );

  // Kapat yerine gizle / tepside çalışmaya devam et
  mainWindow.on('close', (event) => {
    if (isQuiting) return;
    event.preventDefault();
    checkMinimizeToTray()
      .then((shouldMinimize) => {
        if (shouldMinimize) {
          setRendererLowPower(true);
          mainWindow.hide();
        } else {
          isQuiting = true;
          app.quit();
        }
      })
      .catch(() => {
        isQuiting = true;
        app.quit();
      });
  });

  mainWindow.on('hide', () => {
    setRendererLowPower(true);
  });
  mainWindow.on('show', () => setRendererLowPower(false));
  mainWindow.on('minimize', () => {
    setRendererLowPower(true);
  });
  mainWindow.on('restore', () => setRendererLowPower(false));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── SİSTEM TEPSİSİ ───────────────────────────────────────────────────────────

function createTray() {
  try {
    const iconPath = process.platform === 'win32'
      ? resolvePath('favicon.ico')
      : resolvePath('assets', 'tray-icon.png');
    tray = new Tray(iconPath);
    tray.setToolTip('ŞifreKasam');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Göster', click: showMainWindow },
      { type: 'separator' },
      { label: 'Çıkış',  click: () => { isQuiting = true; app.quit(); } },
    ]));
    tray.on('click', showMainWindow);
  } catch (err) {
    console.error('Tray icon yuklenemedi, tray ozelligi atlaniyor:', err);
    tray = null;
  }
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.show();
  setRendererLowPower(false);
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(false);
}

function setRendererLowPower(enabled) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const nextState = Boolean(enabled);
  const wasLowPower = rendererLowPowerRequested;
  rendererLowPowerRequested = nextState;

  if (!nextState && (wasLowPower || mainWindow.isVisible())
      && typeof mainWindow.webContents.invalidate === 'function') {
    mainWindow.webContents.invalidate();
  }
  const script = nextState
    ? 'window.KASA_SET_LOW_POWER?.(true);'
    : 'window.KASA_RESUME_RENDERER?.();';
  mainWindow.webContents
    .executeJavaScript(script, true)
    .catch(() => {});
}

// ─── FLASK AYARLARI SORGUSU ───────────────────────────────────────────────────

function checkMinimizeToTray() {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: HOST, port: PORT, path: '/settings/tray',
        method: 'GET', headers: { 'X-App-Token': APP_TOKEN }, timeout: 1000,
        rejectUnauthorized: false },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try   { resolve(JSON.parse(data).minimize_to_tray === true); }
          catch { resolve(true); }
        });
      }
    );
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ─── FLASK SUNUCUSU ───────────────────────────────────────────────────────────

function startFlaskServer(timeoutMs) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const backendBinary = isWin ? 'SifreKasam.exe' : 'SifreKasam';
    const flaskHost = lanRuntimeEnabled ? '0.0.0.0' : HOST;
    const [command, args] = app.isPackaged
      ? [resolvePath(path.join('backend', backendBinary)), []]
      : [PYTHON_COMMAND, [path.join(__dirname, 'flask_app', 'app.py')]];

    console.log(`Flask baslatiliyor: ${command} ${args.join(' ')} (${flaskHost}:${PORT})`);

    const spawnedProcess = spawn(command, args, {
      env: { ...process.env, APP_TOKEN,
             FLASK_SECRET_KEY: APP_TOKEN,
             APP_VERSION: app.getVersion(),
             FLASK_HOST: flaskHost,
             FLASK_PORT: String(PORT), PORT: String(PORT),
             KASA_RESET_LAN_ON_START: resetSavedLanOnNextStart ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    flaskProcess = spawnedProcess;
    resetSavedLanOnNextStart = false;
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
      if (flaskProcess === spawnedProcess) flaskProcess = null;
      const exitDetail = `kod ${code ?? 'yok'}, sinyal ${signal || 'yok'}`;
      const error = new Error(`Flask beklenmedik cikis (${exitDetail}):\n${stderrBuffer}`);
      if (!startupComplete) {
        failStartup(error);
      } else if (!isQuiting && !isRestartingFlask) {
        showFriendlyFatalError('BCK', error, 'ŞifreKasam arka plan hizmeti beklenmedik şekilde durdu.');
      }
    });

    waitForBackendReady(completeStartup, failStartup, timeoutMs);
  });
}

function requestBackendJson(pathname, { method = 'GET', body = null, timeout = 1200 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: HOST,
        port: PORT,
        path: pathname,
        method,
        timeout,
        rejectUnauthorized: false,
        headers: {
          'X-App-Token': APP_TOKEN,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Backend ${pathname} HTTP ${res.statusCode}`));
            return;
          }
          try { resolve(data ? JSON.parse(data) : {}); }
          catch (err) { reject(err); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`Backend ${pathname} zaman asimi`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function syncLanRuntimeState() {
  if (!PORT || isRestartingFlask) return;
  try {
    const state = await requestBackendJson('/settings/runtime');
    const nextLanEnabled = state.lan_enabled === true;
    if (nextLanEnabled !== lanRuntimeEnabled) {
      await restartFlaskServer(nextLanEnabled);
    }
  } catch (err) {
    console.warn(`LAN runtime senkronizasyonu atlandi: ${err.message}`);
  }
}

async function restartFlaskServer(nextLanEnabled) {
  isRestartingFlask = true;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(
        "document.body.classList.add('is-page-loading')"
      ).catch(() => {});
    }
    await stopFlaskServer();
    lanRuntimeEnabled = nextLanEnabled;
    await startFlaskServer();
  } catch (err) {
    dialog.showErrorBox('Ağ Ayarı Uygulanamadı', err.message);
  } finally {
    isRestartingFlask = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(
        "document.body.classList.remove('is-page-loading')"
      ).catch(() => {});
    }
  }
}

function stopFlaskServer() {
  return new Promise((resolve) => {
    const proc = flaskProcess;
    if (!proc) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      flaskProcess = null;
      resolve();
    };

    proc.once('exit', finish);
    requestBackendJson('/shutdown', { method: 'POST', timeout: 800 }).catch(() => {});

    setTimeout(() => {
      if (settled) return;
      try {
        kill(proc.pid, 'SIGTERM', () => {
          setTimeout(finish, 250);
        });
      } catch (_) {
        finish();
      }
    }, 1000);
  });
}

function waitForBackendReady(resolve, reject, timeoutMs) {
  const effectiveTimeout = timeoutMs || FLASK_TIMEOUT_MS;
  const deadline = Date.now() + effectiveTimeout;
  let lastError = 'HTTPS bağlantısı kurulamadı.';

  const retry = () => {
    if (Date.now() >= deadline) {
      reject(new Error(
        `Flask ${effectiveTimeout / 1000}s içinde HTTPS üzerinden hazır olmadı: ${lastError}`
      ));
      return;
    }
    setTimeout(probe, RETRY_INTERVAL_MS);
  };

  const probe = () => {
    let probeHandled = false;
    const retryProbe = (error) => {
      if (probeHandled) return;
      probeHandled = true;
      lastError = error instanceof Error ? error.message : String(error || lastError);
      retry();
    };

    const request = https.request({
      hostname: HOST,
      port: PORT,
      path: '/heartbeat',
      method: 'POST',
      timeout: BACKEND_PROBE_TIMEOUT_MS,
      rejectUnauthorized: false,
      headers: { 'X-App-Token': APP_TOKEN },
    }, (response) => {
      response.resume();
      if (response.statusCode >= 200 && response.statusCode < 300) {
        if (!probeHandled) {
          probeHandled = true;
          resolve();
        }
        return;
      }
      retryProbe(new Error(`Backend HTTP ${response.statusCode}`));
    });

    request.once('error', retryProbe);
    request.once('timeout', () => {
      request.destroy(new Error('Backend HTTPS kontrolü zaman aşımına uğradı.'));
    });
    request.end();
  };

  probe();
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() =>
        port ? resolve(port) : reject(new Error('Bos port bulunamadi.'))
      );
    });
  });
}

// ─── UYGULAMA OLAYLARI ────────────────────────────────────────────────────────

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  isQuiting = true;
  shutdownFlask();
});

function shutdownFlask() {
  if (!flaskProcess) return;

  const pid = flaskProcess.pid;
  flaskProcess = null;

  const req = https.request({
    hostname: HOST, port: PORT, path: '/shutdown',
    method: 'POST', headers: { 'X-App-Token': APP_TOKEN },
    rejectUnauthorized: false,
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

// ─── YARDIMCI FONKSİYONLAR ───────────────────────────────────────────────────

function resolvePath(...segments) {
  return app.isPackaged
    ? path.join(process.resourcesPath, ...segments)
    : path.join(__dirname, ...segments);
}

function resolveLoadingPagePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend', '_internal', 'templates', 'loading.html');
  }
  return path.join(__dirname, 'flask_app', 'templates', 'loading.html');
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
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Ana pencere kullanılamıyor.');
  }
  try {
    const targetUrl = `${PROTOCOL}://${HOST}:${PORT}${pathname}`;
    await mainWindow.loadURL(targetUrl);
  } catch (err) {
    console.error('loadBackendPage failed:', pathname, err.message);
    throw err;
  }
}

function getConfigDir() {
  if (process.platform === 'win32') return process.env.APPDATA;
  return process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config');
}

function isFirstRun() {
  const configDir = getConfigDir();
  if (!configDir) return false;
  const dataDir = process.platform === 'win32'
    ? path.join(configDir, '.SifrekasamV2')
    : path.join(configDir, 'sifrekasam');
  try {
    return !fs.existsSync(path.join(dataDir, 'cert.pem'));
  } catch (_) {
    return false;
  }
}

function readThemeFile() {
  const configDir = getConfigDir();
  if (!configDir) return null;
  const dataDir = process.platform === 'win32'
    ? path.join(configDir, '.SifrekasamV2')
    : path.join(configDir, 'sifrekasam');
  const file = path.join(dataDir, 'theme.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function getSavedTheme() {
  try {
    const data = readThemeFile();
    return data?.theme === 'light' ? 'light' : 'dark';
  } catch (_) { return 'dark'; }
}

function getSavedGlassEffects() {
  try {
    const data = readThemeFile();
    return !GLASS_EFFECTS_FALSY.has(String(data?.glass_effects_enabled).toLowerCase());
  } catch (_) { return true; }
}

function getSavedGlassQuality() {
  try {
    const data = readThemeFile();
    return ['low', 'normal', 'high'].includes(data?.glass_quality)
      ? data.glass_quality
      : 'normal';
  } catch (_) { return 'normal'; }
}

function getSavedInterfaceAnimations() {
  try {
    const data = readThemeFile();
    return !GLASS_EFFECTS_FALSY.has(String(data?.interface_animations_enabled).toLowerCase());
  } catch (_) { return true; }
}

function getSavedLanguage() {
  try {
    const data = readThemeFile();
    return data?.language || 'tr';
  } catch (_) { return 'tr'; }
}

function getSavedAccentColor() {
  try {
    const data = readThemeFile();
    return /^#[0-9a-fA-F]{6}$/.test(data?.accent_color || '') ? data.accent_color : '#7c6ff7';
  } catch (_) { return '#7c6ff7'; }
}

function getSavedBackgroundStyle() {
  try {
    const data = readThemeFile();
    return ['aurora', 'midnight', 'mesh', 'plain'].includes(data?.background_style)
      ? data.background_style
      : 'aurora';
  } catch (_) { return 'aurora'; }
}

function getSavedWindowBackgroundColor() {
  if (getSavedTheme() === 'light') return '#eef2ff';
  switch (getSavedBackgroundStyle()) {
    case 'plain':
      return '#080912';
    case 'midnight':
      return '#101326';
    case 'mesh':
      return '#111827';
    default:
      return '#101326';
  }
}
