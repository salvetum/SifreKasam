// ─── YEREL SERTİFİKA SABİTLEME ───────────────────────────────────────────────
// Self-signed localhost sertifikasının pin'lenmesi (Chromium/renderer kanalı
// dahil) ve backend'e giden istekler için keep-alive bağlantı havuzu.

const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');

const { getDataDir } = require('./fatal-errors');

let pinnedCertificatePem = null;
let pinnedCertificateDer = null;
let pinnedCertificateMtime = 0;
let warnedPinnedCertificateUnavailable = false;
let hasReportedLocalCertificateNoise = false;
let hasReportedRejectedCertificate = false;

function _normalizeCertToDer(certData) {
  if (!certData) return null;
  try {
    const buf = Buffer.isBuffer(certData) ? certData : Buffer.from(String(certData));
    const asUtf = buf.toString('utf8');
    if (asUtf.includes('-----BEGIN CERTIFICATE-----')) {
      return Buffer.from(new crypto.X509Certificate(asUtf).raw);
    }
    return Buffer.from(new crypto.X509Certificate(buf).raw);
  } catch (_) {
    return null;
  }
}

// Not: burada "görünen sertifikayı kabul et" (TOFU) mantığı BİLEREK YOKTUR.
// CN / self-signed / localhost SAN denetimleri yalnızca kimliği değil
// kimliğin DOĞRULANMIŞ olup olmadığını söylemez; aynı kullanıcı bağlamında
// çalışan bir saldırgan bu nitelikleri taklit eden kendi sertifikasını
// sunabilir. Tek güven kuralı: sunulan DER, diskteki pin ile bayt bayt
// eşleşmek zorundadır. Eşleşme yoksa bağlantı reddedilir.

// Chromium/renderer kanalı TAMAMEN fail-closed çalışır: sunulan sertifika
// diskteki pin ile DER düzeyinde birebir eşleşmiyorsa bağlantı reddedilir.
// Pin yoksa da reddedilir — kullanıcıya "gördüğünü kaydet / görmeden geç"
// seçeneği sunulmaz, çünkü o seçeneğin kendisi trust-on-first-use'dır ve ilk
// açılıştaki sahte sunucu senaryosunu yeniden içeri sokar.
//
// Renderer'ın pin'e güvenebilmesinin ön koşulu main.js'te zaten sağlanır:
// loadBackendPage() çağrısına geline kadar startFlaskServerOnce() içindeki
// waitForPinnedCertificate() pinin varlığını doğrulamış OLMALIDIR (aksi halde
// başlatma zaten başarısız olur). Bkz. page-loader.js:loadBackendPage.
function registerCertificateErrorHandler(host) {
  app.on('certificate-error', (event, _webContents, url, _error, certificate, callback) => {
    if (!url.startsWith(`https://${host}:`)) {
      callback(false);
      return;
    }

    event.preventDefault();
    // Dosya LAN restart'ta yeniden üretilebildiği için her olayda tazele.
    try { loadPinnedCertificate(); } catch (_) {}
    const presentedRaw = certificate && certificate.data ? Buffer.from(certificate.data) : null;
    const presented = _normalizeCertToDer(presentedRaw);

    // Pinned sertifika ile DER normalization sonrası tam eşleşiyorsa kabul et.
    if (pinnedCertificateDer && presented
        && presented.length === pinnedCertificateDer.length
        && presented.equals(pinnedCertificateDer)) {
      if (!hasReportedLocalCertificateNoise) {
        hasReportedLocalCertificateNoise = true;
        console.warn('Yerel self-signed SSL sertifikasi kabul edildi; tekrar eden Chromium sertifika loglari susturuldu.');
      }
      callback(true);
      return;
    }

    // Eşleşme yok. Nedeni ayırt et ama ikisinde de aynı kapıyı kapat: bağlantı
    // reddedilir, pin'e hiçbir şey yazılmaz.
    if (!hasReportedRejectedCertificate) {
      hasReportedRejectedCertificate = true;
      console.warn(pinnedCertificateDer
        ? 'Yerel SSL sertifikası pin ile eslesmedi; baglanti guvenlik geregi reddedildi. '
          + 'Sertifika yeniden uretilmis olabilir (LAN erisimi). Sorun surerse uygulamayi '
          + 'kapatip ssl klasorundeki sertifika dosyalarini silerek yeniden baslatin.'
        : 'Yerel SSL sertifika pini bulunamadi; baglanti guvenlik geregi reddedildi.');
    }
    callback(false);
  });
}

function loadPinnedCertificate() {
  try {
    const dataDir = getDataDir();
    const certPath = dataDir ? path.join(dataDir, 'ssl', 'cert.pem') : null;
    if (certPath && fs.existsSync(certPath)) {
      // Sertifika LAN açılışında LAN IP içerecek şekilde yeniden üretilebiliyor;
      // dosya değiştiğinde eski pin'in takılı kalmasın diye mtime'ı izle.
      const mtime = fs.statSync(certPath).mtimeMs;
      if (pinnedCertificatePem === null || mtime !== pinnedCertificateMtime) {
        pinnedCertificatePem = fs.readFileSync(certPath);
        pinnedCertificateDer = Buffer.from(new crypto.X509Certificate(pinnedCertificatePem).raw);
        pinnedCertificateMtime = mtime;
      }
      return true;
    }
  } catch (error) {
    if (!warnedPinnedCertificateUnavailable) {
      warnedPinnedCertificateUnavailable = true;
      console.warn('Yerel SSL sertifikasi okunamadi:', error.message);
    }
  }
  if (!warnedPinnedCertificateUnavailable) {
    warnedPinnedCertificateUnavailable = true;
    console.warn('Yerel SSL sertifikasi bulunamadi; backend istekleri guvenlik geregi reddedilecek (dogrulamasi yapilmadan baglanilmayacak).');
  }
  return false;
}

// Pin eksikliğinin tüketicilere gösterilecek tek hata metni. Hem ana akıştaki
// başlangıç kapısı (backend-process.js) hem de ağ katmanı için aynı kaynak.
const PINNED_CERT_MISSING_MESSAGE =
  'Yerel SSL sertifikasi (pin) bulunamadi. Guvenlik geregi backend\'e dogrulamasi '
  + 'yapilmayan bir baglanti kurulmaz. Lutfen uygulamayi tamamen kapatip yeniden '
  + 'baslatin.';

function createPinnedCertificateMissingError() {
  const error = new Error(PINNED_CERT_MISSING_MESSAGE);
  error.code = 'ERR_KASA_PINNED_CERT_MISSING';
  return error;
}

// Sabitlenmiş sertifika yokken ASLA dogrulamasiz baglanma.
//
// Once burada "guvensiz" bir pencere birakiliyordu: pin dosyasi yoksa
// rejectUnauthorized:false donduruluyordu. Ana surec portu tahmin edip
// dinleyicisini kapattigi ile Flask'in o porta bind oldugu arasindaki TOCTOU
// penceresinde yerel bir sahte sunucu bu dogrulamasiz akisi kullanarak araya
// girebiliyordu. O pencere artik yok (port OS tarafindan bind ile birlikte
// seciliyor, bkz. backend-process.js); pin yine de ASIL savunma hatti olarak
// kaliyor: sifreleme anahtari/elinde URL'si olan yerel bir surec Flask'in
// sertifikasina sahip olamaz, dolayisiyla gecerli bir yanit uretemez.
//
// DIKKAT: bu fonksiyon BILEREK throw ETMEZ. backend-net.js icindeki
// waitForBackendReady() -> retry() -> setTimeout(probe, ...) yolunda
// getPinnedHttpsOptions() bir setTimeout geri cagirmasi icinde cagrilir; orada
// throw "uncaught exception" olur ve fatal-errors.js sureci kapatir. Bunun
// yerine dogrulamanin KESIN basarisiz oldugu bir secenek dondurulur: TLS
// handshake reddedilir, istek hicbir zaman gonderilmez ve mevcut her tuketici
// zaten 'error' olayini yakaladigi icin sessizce basarisiz olur.
function getPinnedHttpsOptions() {
  if (loadPinnedCertificate()) {
    return { rejectUnauthorized: true, ca: pinnedCertificatePem };
  }
  // Pin yok: guven zincirini BOSS birak ve dogrulamayi zorunlu kil. Kendi
  // urettigimiz self-signed sertifika bu haliyle reddedilir (dogrulanmis:
  // DEPTH_ZERO_SELF_SIGNED_CERT), yani veri gonderilmeden hata doner.
  // hostname allowlist'i korunur.
  return {
    rejectUnauthorized: true,
    ca: [],
    checkServerIdentity: (hostname) => {
      const allowed = ['127.0.0.1', 'localhost', '::1'];
      if (!allowed.includes(hostname)) {
        return new Error(`Beklenmeyen hostname: ${hostname}`);
      }
    },
  };
}

// İlk kurulumda sertifika dosyası Flask tarafından üretilir (bkz.
// kasa_core/certificates.py: ensure_self_signed_cert). Ana süreç Flask'i
// zaten "hazır" olana kadar beklediği için bu bekleme EK MALİYET getirmez;
// buna karşılık getPinnedHttpsOptions() ilk çalıştırmadan itibaren gerçek
// pin ile (rejectUnauthorized: true) çalışabilir hale gelir.
//
// Not: kontrollü bekleme yapılsa bile dosya deadline'da hâlâ oluşmamışsa
// ESKİ gevşek davranışa düşülmez — artık fail-closed'dur: çağıran taraf
// (backend-process.js: startFlaskServerOnce) bu false sonucunu net bir hataya
// çevirip başlamayı reddeder, getPinnedHttpsOptions() da doğrulamasız
// bağlantı kurmayı reddeder. Çağıran bu boolean'ı yok saysa bile ağ katmanı
// doğrulanmamış sunucuya bağlanamaz (defans derinliği).
function waitForPinnedCertificate({ timeoutMs = 15000, intervalMs = 150 } = {}) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      if (loadPinnedCertificate()) { resolve(true); return; }
      if (Date.now() >= deadline) {
        console.warn('Yerel SSL sertifikati zamaninda hazir olmadi; pin dogrulamasi kullanilamiyor ve backend istekleri guvenlik geregi reddedilecek.');
        resolve(false);
        return;
      }
      setTimeout(attempt, intervalMs);
    };
    attempt();
  });
}

// Backend'e giden tekrarlanan istekler için yeniden kullanılabilir bağlantı
// havuzu. Her istekte yeni TLS handshake yapmak (özellikle LAN poller ve
// heartbeat) gereksiz CPU + gecikme üretir; keep-alive aynı socket'i
// yeniden kullanır. Sertifika yenilenince (LAN restart) havuz sıfırlanır.
let backendKeepAliveAgent = null;

function getBackendKeepAliveAgent() {
  if (!backendKeepAliveAgent) {
    backendKeepAliveAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 4,
      keepAliveMsecs: 1500,
    });
  }
  return backendKeepAliveAgent;
}

function resetBackendKeepAliveAgent() {
  if (backendKeepAliveAgent) {
    backendKeepAliveAgent.destroy();
    backendKeepAliveAgent = null;
  }
}

function resetPinnedCertificateCache() {
  pinnedCertificatePem = null;
  pinnedCertificateDer = null;
  pinnedCertificateMtime = 0;
  // Yeni sertifika üretimi yeni bir "başlangıç"tır: önceki nesil için
  // kilitlenen ret günlüğü bayrağı da sıfırlanır (yalnızca loglama).
  hasReportedRejectedCertificate = false;
  resetBackendKeepAliveAgent();
}

// Tekrar eden sertifika/gürültü uyarılarını bir kez bildirmek için paylaşılan
// bayrak. İlk çağrıda true döner ve bayrağı kilitler.
function markLocalCertificateNoiseReported() {
  const isFirst = !hasReportedLocalCertificateNoise;
  hasReportedLocalCertificateNoise = true;
  return isFirst;
}

module.exports = {
  registerCertificateErrorHandler,
  loadPinnedCertificate,
  waitForPinnedCertificate,
  getPinnedHttpsOptions,
  getBackendKeepAliveAgent,
  resetPinnedCertificateCache,
  markLocalCertificateNoiseReported,
  createPinnedCertificateMissingError,
};
