// ─── PAKET BÜTÜNLÜK DOĞRULAMA ─────────────────────────────────────────────────
// Paketli uygulamada resources\backend klasörünün değiştirilmediğini doğrular.
// build-backend.js, paketlemeden önce backend_integrity.json (sha256 liste) ve
// backend_integrity.sig.json (Ed25519 imzası) üretir; özel imza anahtarı REPO
// DIŞINDA (SIFREKASAM_SIGN_KEY_PATH veya ~/.sifrekasam/sign_key.pem) tutulur.
//
// Politika:
//   - manifest YOKSA  -> imzasız/geliştirme paketi; doğrulama atlanır.
//   - manifest VAR     -> imza zorunludur; imza geçersiz = kurcalanmış.
//   - imza geçerli     -> hash'ler doğrulanır; uymayan dosya = kurcalanmış.
//
// Hız: spawn ÖNCESİ yalnızca kritik alt küme (exe + python + rust pyd) eşzamanlı
// doğrulanır (~100ms); tam ağaç eşzamansız tamamlanır, hata olursa süreç durdurulur.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAUcIKX9M1NjuVR2pdnx5ZtvRXugrFrh97UT9mqbiJTc0=
-----END PUBLIC KEY-----`;

const MANIFEST_FILE = 'backend_integrity.json';
const SIGNATURE_FILE = 'backend_integrity.sig.json';

// Spawn'dan önce eşzamanlı doğrulanan kritik dosyalar (backend binary'i tüm
// Python kodunu (PKG) içerir; bu DLL'ler de doğrudan çalıştırılabilir kod).
// Windows'ta bu dosyaların tümü doğrulanır; diğer platformlarda manifestte
// bulunmayan adaylar sessizce atlanır (Linux'ta .so uzantılıdır).
const CRITICAL_CANDIDATES = [
  process.platform === 'win32' ? 'SifreKasam.exe' : 'SifreKasam',
  path.join('_internal', 'python312.dll'),
  path.join('_internal', '_ssl.pyd'),
  path.join('_internal', 'libssl-3.dll'),
  path.join('_internal', 'libcrypto-3.dll'),
  path.join('_internal', 'cryptography', 'hazmat', 'bindings', '_rust.pyd'),
];

function publicKeyObject() {
  return crypto.createPublicKey({ key: PUBLIC_KEY_PEM, format: 'pem', type: 'spki' });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function loadManifest() {
  if (!process.resourcesPath) return null;
  const backendDir = path.join(process.resourcesPath, 'backend');
  const manifestPath = path.join(backendDir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) return null;
  const sigPath = path.join(backendDir, SIGNATURE_FILE);
  let manifest;
  let signatureFile;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (_) {
    return { status: 'tampered', message: 'manifest okunamıyor (bozuk/JSON değil)' };
  }
  try {
    if (fs.existsSync(sigPath)) {
      signatureFile = JSON.parse(fs.readFileSync(sigPath, 'utf8'));
    }
  } catch (_) {
    return { status: 'tampered', message: 'imza dosyası bozuk' };
  }
  return {
    status: signatureFile ? 'signed' : 'unsigned',
    manifest, signatureFile, manifestPath, backendDir,
  };
}

function verifySignature(manifestPath, signatureFile) {
  if (signatureFile.algorithm !== 'ed25519' || typeof signatureFile.signature !== 'string') {
    return false;
  }
  let signature;
  try {
    signature = Buffer.from(signatureFile.signature, 'base64');
  } catch (_) {
    return false;
  }
  const manifestBytes = fs.readFileSync(manifestPath);
  return crypto.verify(null, manifestBytes, publicKeyObject(), signature);
}

// Spawn ÖNCESİ: kritik kümenin varlık + hash doğrulaması (eşzamanlı, hızlı).
function verifyQuickIntegritySync() {
  const loaded = loadManifest();
  if (!loaded) {
    return { status: 'unsigned' };
  }
  if (loaded.status === 'tampered') {
    return loaded;
  }
  const { manifest, signatureFile, manifestPath, backendDir } = loaded;
  if (!signatureFile) {
    return { status: 'tampered', message: 'imza bulunamadı (imzalı pakette zorunlu)' };
  }
  if (!verifySignature(manifestPath, signatureFile)) {
    return { status: 'tampered', message: 'imza doğrulanamadı — paket değiştirilmiş olabilir' };
  }
  if (manifest.version !== 1 || manifest.algorithm !== 'sha256' || !manifest.files) {
    return { status: 'tampered', message: 'manifest sürümü tanınmıyor' };
  }
  const expected = manifest.files;
  for (const rel of CRITICAL_CANDIDATES) {
    const norm = rel.replace(/\\/g, '/');
    const expectedHash = expected[norm];
    if (!expectedHash) continue;
    const absPath = path.join(backendDir, norm);
    if (!fs.existsSync(absPath)) {
      return { status: 'tampered', message: `kritik dosya eksik: ${norm}` };
    }
    let actual;
    try {
      actual = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
    } catch (_) {
      return { status: 'tampered', message: `kritik dosya okunamıyor: ${norm}` };
    }
    if (actual !== expectedHash) {
      return { status: 'tampered', message: `kritik dosya HASH UYUMSUZ: ${norm}` };
    }
  }
  return { status: 'ok' };
}

// Spawn SONRASI: manifestteki tüm dosyaları eşzamansız hash'ler; uyumsuz liste döner.
async function verifyFullIntegrityAsync() {
  const loaded = loadManifest();
  if (!loaded) return { status: 'unsigned', mismatches: [] };
  if (loaded.status === 'tampered') return { status: 'tampered', mismatches: [loaded.message] };

  const { manifest, signatureFile, manifestPath, backendDir } = loaded;
  if (!signatureFile || !verifySignature(manifestPath, signatureFile)) {
    return { status: 'tampered', mismatches: ['imza geçersiz veya eksik'] };
  }

  const mismatches = [];
  const expected = manifest.files;
  const tasks = Object.keys(expected).map(async (norm) => {
    const absPath = path.join(backendDir, norm);
    if (!fs.existsSync(absPath)) {
      mismatches.push(`eksik: ${norm}`);
      return;
    }
    try {
      const actual = await sha256File(absPath);
      if (actual !== expected[norm]) mismatches.push(`hash uyumsuz: ${norm}`);
    } catch (_) {
      mismatches.push(`okunamıyor: ${norm}`);
    }
  });
  await Promise.all(tasks);
  return {
    status: mismatches.length ? 'tampered' : 'ok',
    mismatches,
  };
}

module.exports = {
  MANIFEST_FILE,
  SIGNATURE_FILE,
  PUBLIC_KEY_PEM,
  verifyQuickIntegritySync,
  verifyFullIntegrityAsync,
};