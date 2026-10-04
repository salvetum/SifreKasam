// ─── SAYFA YÜKLEYİCİ ─────────────────────────────────────────────────────────
// Yükleme ekranı ve backend sayfalarının ana pencereye yüklenmesi; paketli
// uygulamada başlangıç kaynaklarının bütünlük kontrolü.

const { app } = require('electron');
const fs = require('fs');

const { PROTOCOL, HOST, resolvePath } = require('./config');
const rt = require('./runtime-state');
const { loadPinnedCertificate, createPinnedCertificateMissingError } = require('./certificates');

function resolveLoadingPagePath() {
  if (app.isPackaged) {
    return resolvePath('backend', '_internal', 'templates', 'loading.html');
  }
  return resolvePath('flask_app', 'templates', 'loading.html');
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

// Renderer'ın backend URL'ine gitmesi, o sunucu "doğrulanmış" hale gelmeden
// YAPILMAZ.
//
// certificates.js'teki registerCertificateErrorHandler artık TOFU sezgisel
// kabulü tamamen kaldırdı: sunulan sertifika diskteki pin ile eşleşmezse
// Chromium bağlantıyı reddeder. Bu, renderer'ın https://127.0.0.1:<port>
// adresindeki sunucunun gerçekten bizim Flask'ımız olduğunu kanıtlamadan
// oturum çerezini/CSRF token'ını göndermesini imkânsız kılar — ama aynı
// zamanda pin henüz oluşmamışsa uygulamanın açılmamasına yol açardı.
//
// İkisi arasındaki dengeyi şu sıralama kurar (main.js):
//   1. startFlaskServerOnce()   -> Flask spawn edilir; FLASK_PORT=0 gönderilir,
//                                  OS boş portu seçer ve Flask app.py import
//                                  sırasında _ensure_self_signed_cert() ile
//                                  cert.pem'i bind'dan ÖNCE yazar
//   2. KASA_PORT=<port> satırı -> gerçek port rt.PORT'a yazılır
//   3. waitForPinnedCertificate()-> pinin varlığı doğrulanMADAN /heartbeat probu
//                                  (pinned TLS) denenmez; pin yoksa başlatma
//                                  hata verir
//   4. createWindow()              -> loadFile(loading.html) = file:// , backend
//                                     origin'ine hiç dokunmaz
//   5. loadBackendPage()           -> İLK ve TEK backend navigasyonu; pin çoktan
//                                     yüklenmiş olduğu için geçer
//
// Dolayısıyla aşağıdaki kapı, mevcut sıralamayı belgeli bir DEĞİŞMEZ HALine
// getirir: sıralama ileride bozulsa (ör. bir çağıran startFlaskServer'ı atlayıp
// doğrudan sayfa yüklemeye çalışırsa) hata mesajı belirsiz bir Chromium
// sertifika hatası yerine net ve teşhis edilebilir olur.
// async kalır: aşağıdaki senkron throw, reddedilmiş promise'e dönüşür. Aksi
// halde window.js'in `loadBackendPage(...).catch(...)` çağrısı istisnayı
// yakalayamaz (uncaught exception). Çağıran sözleşmesi: her zaman Promise.
async function loadBackendPage(pathname) {
  if (!rt.mainWindow || rt.mainWindow.isDestroyed()) {
    throw new Error('Ana pencere kullanılamıyor.');
  }
  // fail-closed: pin yoksa loadURL HİÇ çağrılmaz.
  if (!loadPinnedCertificate()) throw createPinnedCertificateMissingError();
  try {
    const targetUrl = `${PROTOCOL}://${HOST}:${rt.PORT}${pathname}`;
    await rt.mainWindow.loadURL(targetUrl);
  } catch (err) {
    console.error('loadBackendPage failed:', pathname, err.message);
    throw err;
  }
}

module.exports = {
  resolveLoadingPagePath,
  verifyPackagedStartupResources,
  loadBackendPage,
};
