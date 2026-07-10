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

const CANONICAL_UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SifreKasam';
const LEGACY_UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ŞifreKasam',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SifrekasamV2.1',
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

// Self-signed SSL sertifika hatalarını Chromium konsol log'undan gizle

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
const FLASK_TIMEOUT_MS = 20_000;
const RETRY_INTERVAL_MS = 500;

const PROTOCOL            = 'https';
const GLASS_EFFECTS_FALSY = new Set(['false', '0', 'off', 'disabled']);

// ─── UYGULAMA DURUMU ──────────────────────────────────────────────────────────

let PORT         = 0;
let flaskProcess = null;
let mainWindow   = null;
let tray         = null;
let isQuiting    = false;
let lanRuntimeEnabled = false;
let resetSavedLanOnNextStart = true;
let isRestartingFlask = false;

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
      callback(true);
    } else {
      callback(false);
    }
  });

  app.whenReady()
    .then(onAppReady)
    .catch((err) => {
      dialog.showErrorBox('Başlatma Hatası', err.message);
      app.quit();
    });
}

// ─── UYGULAMA HAZIR ───────────────────────────────────────────────────────────

async function onAppReady() {
  try {
    PORT = await findFreePort();
    createWindow();
    createTray();
    await startFlaskServer();

    if (mainWindow) {
      try {
        await mainWindow.webContents.executeJavaScript('transitionToApp()');
      } catch (_) { /* loading.html henüz yüklenmemiş olabilir */ }
      mainWindow.setBackgroundColor(getSavedWindowBackgroundColor());
      mainWindow.loadURL(`${PROTOCOL}://${HOST}:${PORT}/login?entry=loading`);
    }
  } catch (err) {
    const isSquirrel = process.argv.some(arg => arg.startsWith('--squirrel-'));
    if (!isSquirrel) dialog.showErrorBox('Sunucu Başlatılamadı', err.message);
    app.quit();
  }
}

// ─── PENCERE ──────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: resolvePath('favicon.ico'),
    backgroundColor: getSavedWindowBackgroundColor(),
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: true,
    },
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile(resolveLoadingPagePath(), {
    query: {
      theme:        getSavedTheme(),
      glassEffects: getSavedGlassEffects() ? 'on' : 'off',
      glassQuality: getSavedGlassQuality(),
      lang:         getSavedLanguage(),
      accent:       getSavedAccentColor(),
      background:   getSavedBackgroundStyle(),
    },
  }).catch(() => {});

  // Harici linkleri sistem tarayıcısında aç
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsedUrl = new URL(url);
      if (['https:', 'http:', 'mailto:'].includes(parsedUrl.protocol)) {
        shell.openExternal(url);
      }
    } catch (_) {}
    return { action: 'deny' };
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

  mainWindow.on('hide', () => setRendererLowPower(true));
  mainWindow.on('show', () => setRendererLowPower(false));
  mainWindow.on('minimize', () => setRendererLowPower(true));
  mainWindow.on('restore', () => setRendererLowPower(false));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── SİSTEM TEPSİSİ ───────────────────────────────────────────────────────────

function createTray() {
  tray = new Tray(resolvePath('favicon.ico'));
  tray.setToolTip('ŞifreKasam');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Göster', click: showMainWindow },
    { type: 'separator' },
    { label: 'Çıkış',  click: () => { isQuiting = true; app.quit(); } },
  ]));
  tray.on('click', showMainWindow);
}

function showMainWindow() {
  if (!mainWindow) return;
  setRendererLowPower(false);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.show();
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(false);
}

function setRendererLowPower(enabled) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const value = enabled ? 'true' : 'false';
  mainWindow.webContents
    .executeJavaScript(`window.KASA_SET_LOW_POWER?.(${value});`, true)
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

function startFlaskServer() {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const backendBinary = isWin ? 'SifreKasam.exe' : 'SifreKasam';
    const flaskHost = lanRuntimeEnabled ? '0.0.0.0' : HOST;
    const [command, args] = app.isPackaged
      ? [resolvePath(path.join('backend', backendBinary)), []]
      : ['python', [path.join(__dirname, 'flask_app', 'app.py')]];

    console.log(`Flask baslatiliyor: ${command} ${args.join(' ')} (${flaskHost}:${PORT})`);

    flaskProcess = spawn(command, args, {
      env: { ...process.env, APP_TOKEN,
             FLASK_SECRET_KEY: APP_TOKEN,
             APP_VERSION: app.getVersion(),
             FLASK_HOST: flaskHost,
             FLASK_PORT: String(PORT), PORT: String(PORT),
             KASA_RESET_LAN_ON_START: resetSavedLanOnNextStart ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    resetSavedLanOnNextStart = false;

    let stderrBuffer = '';
    flaskProcess.stdout.on('data', () => {});
    flaskProcess.stderr.on('data', (data) => {
      stderrBuffer += data.toString();
      if (stderrBuffer.length > 4096) stderrBuffer = stderrBuffer.slice(-4096);
    });

    flaskProcess.on('error', (err) =>
      reject(new Error(`Flask baslatilamadi (spawn hatası): ${err.message}\nKomut: ${command}`))
    );
    flaskProcess.on('exit', (code) => {
      if (code !== 0 && code !== null)
        reject(new Error(`Flask beklenmedik cikis (kod ${code}):\n${stderrBuffer}`));
    });

    waitForPort(resolve, reject);
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
      kill(proc.pid, 'SIGTERM', () => {
        setTimeout(finish, 250);
      });
    }, 1000);
  });
}

function waitForPort(resolve, reject) {
  const deadline = Date.now() + FLASK_TIMEOUT_MS;

  const tryConnect = () => {
    const client = net.createConnection({ host: HOST, port: PORT }, () => {
      client.destroy();
      resolve();
    });
    client.on('error', () => {
      client.destroy();
      if (Date.now() >= deadline)
        reject(new Error(`Flask ${FLASK_TIMEOUT_MS / 1000}s içinde baslamadi.`));
      else
        setTimeout(tryConnect, RETRY_INTERVAL_MS);
    });
  };

  tryConnect();
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

app.on('will-quit', shutdownFlask);

function shutdownFlask() {
  if (!flaskProcess) return;

  const req = https.request({
    hostname: HOST, port: PORT, path: '/shutdown',
    method: 'POST', headers: { 'X-App-Token': APP_TOKEN },
    rejectUnauthorized: false,
  });
  req.on('error', () => {});
  req.end();

  kill(flaskProcess.pid, 'SIGTERM', (err) => {
    if (err) kill(flaskProcess.pid, 'SIGKILL');
  });

  flaskProcess = null;
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

function getConfigDir() {
  if (process.platform === 'win32') return process.env.APPDATA;
  return process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config');
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
