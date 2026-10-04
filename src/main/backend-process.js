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
  FLASK_SECRET_KEY,
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
const { getPinnedHttpsOptions, resetPinnedCertificateCache, waitForPinnedCertificate, createPinnedCertificateMissingError } = require('./certificates');
const { showFriendlyFatalError } = require('./fatal-errors');
const { loadBackendPage } = require('./page-loader');
const { verifyQuickIntegritySync, verifyFullIntegrityAsync } = require('./integrity');
const bench = require('./startup-timing');
const { resolvePythonCommand } = require('./python-command');

const PYTHON = resolvePythonCommand();

// Backend ag katmani: sabitler/durum enjeksiyonu
const { requestBackendJson, waitForBackendReady } = createBackendNet({
  host: HOST,
  getToken: () => APP_TOKEN,
  getPort: () => rt.PORT,
  timeoutMs: FLASK_TIMEOUT_MS,
  retryIntervalMs: RETRY_INTERVAL_MS,
  probeTimeoutMs: BACKEND_PROBE_TIMEOUT_MS,
});

function checkMinimizeToTray() {
  // Port bildirilmediyse (başlatma yarıda kaldı) sorulacak backend de yoktur.
  if (!rt.PORT) return Promise.resolve(false);
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

// Port yarışı (TOCTOU) YOK: ana süreç port seçmez. FLASK_PORT=0 gönderilir,
// işletim sistemi boş portu seçer ve Flask `bind()`+`listen()` tamamlandıktan
// HEMEN SONRA gerçek portu stdout'a `KASA_PORT=<port>` satırı olarak yazar
// (bkz. flask_app/app.py: _report_bound_port). Böylece "portu seç, dinleyiciyi
// kapat, sonra Flask o porta bağlan" ayrışıklığı ve onun doğurduğu boşluk
// tamamen ortadan kalkar; port ile dinleyici aynı atomik bind() içinde
// birlikte doğar. Sertifika pini bu sıralamada ikinci savunma hattıdır
// (bkz. certificates.js) — port çalma imkânsız olsa bile, sahte bir sunucu
// Flask'ın sertifikasına sahip olamayacağı için geçerli yanıt üretemez.
//
// Bu, LAN modunda daha da kritikti: findFreePort() HER ZAMAN 127.0.0.1'e
// bağlanırken Flask 0.0.0.0'a bağlanıyordu. Windows 11'de ölçüldü: yerel bir
// süreç loopback'i alırken wildcard bind'i BAŞARIYLA tamamlayabiliyor
// (daha spesifik dinleyici yanıtlar) → Flask bind hatası vermiyor, retry
// tetiklenmiyor, ana süreç saldırganın sunucusuna bağlanıyordu.
//
// Yine de FLASK_PORT_BIND_RETRY_LIMIT döngüsü korunur: sabit port isteyen
// (FLASK_PORT=5000) geliştirici/kurulum senaryolarında bind hatası yine de
// mümkündür ve o zaman yeniden denemek doğru davranıştır.
const FLASK_PORT_BIND_RETRY_LIMIT = 3;
const _BIND_ERROR_PATTERN = /EADDRINUSE|address already in use|only one usage of each socket|10048|98:\s*Address/i;
// Werkzeug make_server bind hatasında "Port N is in use by another program" yazıp
// sys.exit(1) ile çıkar; mesajda 10048 yoktur, bu yüzden desen genişletildi.
const _BIND_ERROR_PATTERN_EXTRA = /is in use by another program/i;

function isPortBindFailure(error) {
  if (!error) return false;
  const message = error.message || String(error);
  return _BIND_ERROR_PATTERN.test(message) || _BIND_ERROR_PATTERN_EXTRA.test(message);
}

// Ana sürecin ayrıştırdığı tek satır biçimi. Backend'in kendi stdout çıktısı
// (`[INFO] ...` log satırları, Werkzeug banner'ı) bu desene uymaz; ayrıştırıcı
// satırın BAŞINDAN SONUNA kadar eşleşmesini şart koşar.
const _BOUND_PORT_LINE_PATTERN = /^KASA_PORT=(\d{1,5})$/;

function parseBoundPortLine(line) {
  const match = _BOUND_PORT_LINE_PATTERN.exec(line);
  if (!match) return 0;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535 ? port : 0;
}

async function startFlaskServer(timeoutMs) {
  let lastError = null;
  for (let attempt = 1; attempt <= FLASK_PORT_BIND_RETRY_LIMIT; attempt += 1) {
    if (attempt > 1) {
      console.warn(`Flask portu alinamadi (deneme ${attempt}/${FLASK_PORT_BIND_RETRY_LIMIT}); isletim sistemi yeni bir port secti.`);
    }
    try {
      return await startFlaskServerOnce(timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt >= FLASK_PORT_BIND_RETRY_LIMIT || !isPortBindFailure(error)) throw error;
    }
  }
  throw lastError || new Error('Flask baslatilamadi.');
}

async function startFlaskServerOnce(timeoutMs) {
  if (rt.flaskProcess) {
    await stopFlaskServer();
  }
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const backendBinary = isWin ? 'SifreKasam.exe' : 'SifreKasam';
    const flaskHost = rt.lanRuntimeEnabled ? '0.0.0.0' : HOST;
    const [command, args] = app.isPackaged
      ? [resolvePath(path.join('backend', backendBinary)), []]
      : [PYTHON.cmd, [...PYTHON.args, path.join(APP_ROOT, 'flask_app', 'app.py')]];

    if (app.isPackaged) {
      const quickIntegrity = verifyQuickIntegritySync();
      if (quickIntegrity.status === 'tampered') {
        console.error('[integrity] KRİTİK: ' + quickIntegrity.message);
        reject(new Error(`Backend bütünlük doğrulaması BAŞARISIZ.\n${quickIntegrity.message}\n\nPaket değiştirilmiş olabilir. Kurulumu yenileyin veya orijinal paketi kullanın.`));
        return;
      }
      if (quickIntegrity.status === 'ok') {
        console.log('[integrity] Kritik backend dosyaları doğrulandı (imza + hash).');
      }
    }

    console.log(`Flask baslatiliyor: ${command} ${args.join(' ')} (${flaskHost}, port isletim sisteminden)`);
    bench.mark('flask-spawn');

    // FLASK_PORT=0: "boş portu sen seç" -> port tahmin edilen bir sayı olmaktan
    // çıkar, bind() ile birlikte doğar. `rt.PORT` spawn anında 0'dır ve
    // `KASA_PORT=` satırı geldiğinde gerçek değerle güncellenir.
    const spawnedProcess = spawn(command, args, {
      env: { ...process.env, APP_TOKEN,
             FLASK_SECRET_KEY,
             APP_VERSION: app.getVersion(),
             FLASK_HOST: flaskHost,
             FLASK_PORT: '0', PORT: '0',
             KASA_RESET_LAN_ON_START: rt.resetSavedLanOnNextStart ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    rt.flaskProcess = spawnedProcess;
    rt.PORT = 0;
    rt.resetSavedLanOnNextStart = false;
    let startupComplete = false;
    let startupSettled = false;

    // TEK bütçe: port raporu + sertifika bekleme + hazır olma probu bu
    // deadline'dan paylaşır. Önceden üst üste binecek şekilde 15 sn (sertifika)
    // + timeoutMs (probu) kullanılıyordu; toplam bekleme sınırı aşılabiliyordu.
    const startupBudgetMs = timeoutMs || 15000;
    const startupDeadline = Date.now() + startupBudgetMs;
    const remainingMs = () => Math.max(1000, startupDeadline - Date.now());

    // Port raporu sözleşmesi: stdout'ta KASA_PORT=<port> görülene kadar rt.PORT
    // bilinmez. Bu kapı, hazır olma probunun YANLIŞ porta (0'a) gitmesini
    // engeller; ayrıca Flask süreci port raporlamadan ölürse bekleme sonsuza
    // kadar sürmesin diye 'exit' ve deadline üzerinden reddedilir.
    let resolveBoundPort;
    let rejectBoundPort;
    const boundPortPromise = new Promise((resolve, reject) => {
      resolveBoundPort = resolve;
      rejectBoundPort = reject;
    });

    const failStartup = (error) => {
      if (startupSettled) return;
      startupSettled = true;
      rejectBoundPort(error);
      reject(error);
    };
    const completeStartup = () => {
      if (startupSettled) return;
      startupSettled = true;
      startupComplete = true;
      bench.mark('flask-ready');
      resolve();
    };

    if (app.isPackaged) {
      // Tam ağaç bütünlük taraması spawn ile paralel ilerler; uyumsuzlukta arka
      // plan süreci durdurulur (veriler çalıştırılmadan önce değil, hızlı yol).
      verifyFullIntegrityAsync().then((result) => {
        if (result.status !== 'tampered') return;
        console.error('[integrity] Tam tarama uyumsuzlukları:', result.mismatches.slice(0, 20));
        try { kill(spawnedProcess.pid, 'SIGKILL', () => {}); } catch (_) {}
        if (rt.isQuiting) return;
        setTimeout(() => {
          showFriendlyFatalError(
            'INT',
            new Error((result.mismatches || []).slice(0, 8).join('\n')),
            'ŞifreKasam bütünlük doğrulaması başarısız oldu — paket değiştirilmiş olabilir.'
          );
        }, 250);
      });
    }

    let stdoutBuffer = '';
    let stderrBuffer = '';
    // stdout yalnızca port raporu için okunur. Bu modülün log handler'ı `[INFO] ...`
    // satırları basar, Werkzeug fallback'i banner yazar; ayrıştırıcı yalnızca tam
    // eşleşmeyi kabul ettiği için bunlar yutulur.
    spawnedProcess.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
      if (stdoutBuffer.length > 8192) stdoutBuffer = stdoutBuffer.slice(-8192);
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '').trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        const reportedPort = parseBoundPortLine(line);
        if (reportedPort) {
          rt.PORT = reportedPort;
          bench.mark('port-reported');
          resolveBoundPort(reportedPort);
        }
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    });
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

    // Port raporlanmazsa sonsuza kadar beklememek için deadline ayrıca bir
    // reddediş kaynağıdır (Flask çökmezse ama satırı da basmazsa).
    const portDeadlineTimer = setTimeout(() => {
      failStartup(new Error(
        `Flask ${Math.round(startupBudgetMs / 1000)}s icinde baglanan portu bildirmedi (KASA_PORT).`
      ));
    }, remainingMs());

    // Flask sertifikayı kendisi üretir (flask_app/app.py: _ensure_self_signed_cert,
    // import sırasında — sunucu bind edilmeden ÖNCE). Dosya hazır olana kadar
    // beklemek ilk kurulumda pin doğrulamasını mümkün kılar ve ek gecikme
    // yaratmaz (zaten hazır olma probu bekleniyor; timeout bütçesi aynı kalır,
    // bekleme süresi bu probu içinden düşülür).
    //
    // NOT: Buradaki geri çağırma bir microtask'te çalışır, Promise constructor'ı
    // onu YAKALAMAZ. try/catch olmadan bir throw "unhandled rejection" olur,
    // promise hiç settle olmaz ve startFlaskServer sonsuza kadar asılı kalır
    // (restartFlaskServer'ın catch'i de düşmez). Bu yüzden açıkça sarıyoruz.
    //
    // FAIL-CLOSED: pin deadline'da hâlâ yoksa backend'e HİÇBİR istek gönderilmez.
    // Önceden bu dal yalnızca uyarı basıp sessizce geçiyordu; sonraki tüm ana
    // süreç istekleri getPinnedHttpsOptions() -> rejectUnauthorized:false ile
    // doğrulamasız gidiyordu (yerel sahte sunucuya MITM imkânı). Artık net bir
    // hata üretilir; main.js bunu kullanıcıya "Arka plan hizmeti başlatılamadı"
    // diyaloğuyla gösterir.
    //
    // SIRA: önce port, sonra sertifika, sonra hazır olma probu. Port bilinmeden
    // proba denemek anlamsızdır (rt.PORT 0'dı) ve pin kontrolü port bilgisi
    // olmadan da anlamlıdır; yine de tek sıra, tek deadline.
    boundPortPromise
      .then(() => waitForPinnedCertificate({ timeoutMs: Math.min(remainingMs(), 15000) }))
      .then((hasPinnedCertificate) => {
        if (!hasPinnedCertificate) {
          failStartup(createPinnedCertificateMissingError());
          return;
        }
        try {
          waitForBackendReady(completeStartup, failStartup, remainingMs());
        } catch (error) {
          failStartup(error);
        }
      })
      .catch((error) => {
        failStartup(error);
      })
      .then(() => clearTimeout(portDeadlineTimer));
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

  // Port henuz bildirilmediyse (cok erken kapatma) /shutdown adresi bilinmiyor;
  // zaten SIGTERM ile kapatıyoruz, istek atmayı dene.
  if (rt.PORT) {
    const req = https.request({
      hostname: HOST, port: rt.PORT, path: '/shutdown',
      method: 'POST', headers: { 'X-App-Token': APP_TOKEN },
      ...getPinnedHttpsOptions(),
    });
    req.on('error', () => {});
    req.end();
  }

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
};
