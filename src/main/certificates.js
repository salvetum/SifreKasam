// ─── YEREL SERTİFİKA SABİTLEME ───────────────────────────────────────────────
// Self-signed localhost sertifikasının pin'lenmesi, sertifika hatası
// diyaloğu ve backend'e giden istekler için keep-alive bağlantı havuzu.

const { app, dialog } = require('electron');
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

const _temporaryTrustedFingerprints = new Set();

function _fpHex(buf) {
  try { return crypto.createHash('sha256').update(buf).digest('hex'); } catch (_) { return null; }
}

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

function _isExpectedLocalCertificate(certBuffer) {
  if (!certBuffer) return false;
  try {
    const pemOrBuffer = Buffer.isBuffer(certBuffer) ? certBuffer : Buffer.from(String(certBuffer));
    const cert = new crypto.X509Certificate(pemOrBuffer);
    const subject = cert.subject || '';
    const issuer = cert.issuer || '';
    const san = cert.subjectAltName || '';
    const matchesAppName = subject.includes('CN=ŞifreKasam') || subject.includes('CN=SifreKasam');
    const isSelfSigned = subject === issuer;
    const hasLocalHosts = san.includes('DNS:localhost') || san.includes('IP Address:127.0.0.1') || san.includes('IP Address:::1');
    return Boolean(matchesAppName && isSelfSigned && hasLocalHosts);
  } catch (_) {
    return false;
  }
}

function _readPresentedPem(presentedRaw) {
  let presentedPem = null;
  if (presentedRaw) {
    const asUtf = presentedRaw.toString('utf8');
    if (asUtf.includes('-----BEGIN CERTIFICATE-----')) {
      presentedPem = asUtf;
    } else {
      const certBase64 = presentedRaw.toString('base64');
      const chunks = certBase64.match(/.{1,64}/g) || [certBase64];
      presentedPem = `-----BEGIN CERTIFICATE-----\n${chunks.join('\n')}\n-----END CERTIFICATE-----\n`;
    }
  }
  return presentedPem;
}

function _persistPinnedCertificate(certPath, pem, fallbackDer) {
  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  fs.writeFileSync(certPath, pem, { encoding: 'utf8' });
  pinnedCertificatePem = fs.readFileSync(certPath);
  try {
    pinnedCertificateDer = Buffer.from(new crypto.X509Certificate(pinnedCertificatePem).raw);
  } catch (_) {
    pinnedCertificateDer = fallbackDer;
  }
  pinnedCertificateMtime = fs.statSync(certPath).mtimeMs;
}

// Self-signed SSL sertifikasını kabul et
// Not: birden fazla kaynak için aynı sertifika hatası tekrar tekrar gelebilir. Bu yüzden
// - aynı sertifikayı geçici olarak güvenmek için fingerprint önbelleği tutuyoruz,
// - yalnızca bilinmeyen sertifikalar için kullanıcıya prompt gösteriyoruz.
function registerCertificateErrorHandler(host) {
  app.on('certificate-error', (event, _webContents, url, _error, certificate, callback) => {
    if (!url.startsWith(`https://${host}:`)) {
      callback(false);
      return;
    }

    event.preventDefault();
    try { loadPinnedCertificate(); } catch (_) {}
    const presentedRaw = certificate && certificate.data ? Buffer.from(certificate.data) : null;
    const presented = _normalizeCertToDer(presentedRaw);
    const presentedFp = presentedRaw ? _fpHex(presentedRaw) : null;

    // Aynı sertifikayı daha önce geçici olarak kabul ettiysek direkt kabul et
    if (presentedFp && _temporaryTrustedFingerprints.has(presentedFp)) {
      callback(true);
      return;
    }

    // Pinned sertifika ile DER normalization sonrası tam eşleşiyorsa kabul et
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

    // Pin mevcut ama eşleşmiyor (sertifika yeniden üretilmiş) VEYASE pin hiç yok
    // (ilk açılış) — sertifika uygulamanın kendi ürettiği self-signed sertifikası
    // ise otomatik kabul et. Eşzamanlı isteklerin hepsine tek tek diyalog
    // göstermemek için kritik. Heuristic geçerse pin'i güncelle.
    if (_isExpectedLocalCertificate(presentedRaw)) {
      if (presentedFp) _temporaryTrustedFingerprints.add(presentedFp);
      if (presented && !pinnedCertificateDer) {
        try {
          const dataDir = getDataDir();
          const certPath = dataDir ? path.join(dataDir, 'ssl', 'cert.pem') : null;
          if (certPath) {
            const asUtf = presentedRaw.toString('utf8');
            const presentedPem = asUtf.includes('-----BEGIN CERTIFICATE-----') ? asUtf : null;
            if (presentedPem) {
              _persistPinnedCertificate(certPath, presentedPem, presented);
            }
          }
        } catch (_) { /* Pin güncellenemezse geçici güven yeterli */ }
      }
      callback(true);
      return;
    }

    // Sunulan sertifikayı PEM formatına dönüştür (kullanıcıya göstermek ve kaydetmek için)
    const presentedPem = _readPresentedPem(presentedRaw);

    const message = pinnedCertificateDer
      ? 'Sunulan yerel SSL sertifikası beklenenle eşleşmiyor.'
      : 'Yerel SSL sertifikası bulunamadı.';
    const detail = 'Bu uygulamanın arka plan hizmeti self-signed bir sertifika kullanıyor. Sertifikayı kabul etmek güvenli olabilir ancak yalnızca cihazınızda çalıştığınıza emin olun. İsterseniz sertifikayı kalıcı olarak kaydedebilirsiniz (daha sonra otomatik olarak doğrulanır), yalnızca bu oturum için geçici olarak kabul edebilir veya bağlantıyı reddedebilirsiniz.';
    const buttons = presentedPem ? ['Güven ve Kaydet', 'Geçici Güven', 'Reddet'] : ['Geçici Güven', 'Reddet'];

    dialog.showMessageBox({
      type: 'warning',
      title: 'ŞifreKasam - Sertifika Doğrulama',
      message,
      detail,
      buttons,
      defaultId: 0,
      noLink: true,
    }).then(({ response }) => {
      // 0 = Güven ve Kaydet, 1 = Geçici Güven, 2 = Reddet
      if (presentedPem && response === 0) {
        try {
          const dataDir = getDataDir();
          const certPath = dataDir ? path.join(dataDir, 'ssl', 'cert.pem') : null;
          if (certPath) {
            _persistPinnedCertificate(certPath, presentedPem, presented);
            console.warn('Yerel sertifika kaydedildi ve pin güncellendi.');
            callback(true);
            return;
          }
        } catch (err) {
          console.warn('Sertifika kaydedilemedi, geçici güven veriliyor:', err.message);
          if (presentedFp) _temporaryTrustedFingerprints.add(presentedFp);
          callback(true);
          return;
        }
      }

      const tempTrustIndex = presentedPem ? 1 : 0;
      if (response === tempTrustIndex) {
        if (presentedFp) _temporaryTrustedFingerprints.add(presentedFp);
        console.warn('Kullanıcı sertifikayı geçici olarak kabul etti. (kaydedilmedi)');
        callback(true);
        return;
      }

      callback(false);
    }).catch((err) => {
      console.warn('Sertifika onay diyaloğu açılamadı, bağlantı reddediliyor:', err.message);
      callback(false);
    });
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
    console.warn('Yerel SSL sertifikasi bulunamadi; ana istekler sertifika dogrulamasi olmadan yapilacak.');
  }
  return false;
}

function getPinnedHttpsOptions() {
  if (loadPinnedCertificate()) {
    return { rejectUnauthorized: true, ca: pinnedCertificatePem };
  }
  // Pin yokken yalnızca localhost'a bağlanmayı zorla (ilk kurulum penceresi).
  return {
    rejectUnauthorized: false,
    checkServerIdentity: (hostname) => {
      const allowed = ['127.0.0.1', 'localhost', '::1'];
      if (!allowed.includes(hostname)) {
        return new Error(`Beklenmeyen hostname: ${hostname}`);
      }
    },
  };
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
  getPinnedHttpsOptions,
  getBackendKeepAliveAgent,
  resetPinnedCertificateCache,
  markLocalCertificateNoiseReported,
};
