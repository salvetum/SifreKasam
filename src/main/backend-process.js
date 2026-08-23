// ─── BACKEND SÜREÇ YÖNETİMİ ──────────────────────────────────────────────────
// Flask sunucusunun başlatılması/durdurulması/yeniden başlatılması, LAN
// çalışma zamanı mutabakatı, Windows güvenlik duvarı kuralı ve backend'den
// okunan pencere davranışı ayarları (tepsiyi küçült, içerik koruması).

const path = require('path');
const { app, dialog } = require('electron');
const { spawn, spawnSync } = require('child_process');
const https = require('https');
const kill = require('tree-kill');

const rt = require('./runtime-state');
const {
  APP_ROOT,
  APP_TOKEN,
  HOST,
  FLASK_TIMEOUT_MS,
  RETRY_INTERVAL_MS,
  BACKEND_PROBE_TIMEOUT_MS,
  resolvePath,
  LAN_RECONCILE_IDLE_INTERVAL_MS,
  LAN_RECONCILE_ACTIVE_INTERVAL_MS,
  LAN_RESTART_MIN_INTERVAL_MS,
} = require('./config');
const { createBackendNet } = require('./backend-net');
const { getPinnedHttpsOptions, resetPinnedCertificateCache } = require('./certificates');
const { showFriendlyFatalError } = require('./fatal-errors');
const { loadBackendPage } = require('./page-loader');

const PYTHON_COMMAND = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

// Backend ag katmani: sabitler/durum enjeksiyonu
const { requestBackendJson, waitForBackendReady, findFreePort } = createBackendNet({
  host: HOST,
  getToken: () => APP_TOKEN,
  getPort: () => rt.PORT,
  timeoutMs: FLASK_TIMEOUT_MS,
  retryIntervalMs: RETRY_INTERVAL_MS,
  probeTimeoutMs: BACKEND_PROBE_TIMEOUT_MS,
});

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
      : [PYTHON_COMMAND, [path.join(APP_ROOT, 'flask_app', 'app.py')]];

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

module.exports = {
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
};
