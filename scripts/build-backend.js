const { spawnSync } = require('child_process');
const {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

function isWSL() {
  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

const flaskAppDir = path.join(projectRoot, 'flask_app');
const sourceDir = path.join(flaskAppDir, 'dist', 'SifreKasam');
const sourceExecutable = path.join(sourceDir, process.platform === 'win32' ? 'SifreKasam.exe' : 'SifreKasam');
const targetDir = path.join(projectRoot, 'backend');
const pythonCommand = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

const build = spawnSync(
  pythonCommand,
  ['-m', 'PyInstaller', 'app.spec', '--clean', '-y'],
  { cwd: flaskAppDir, stdio: 'inherit' }
);

if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status || 1);
if (!existsSync(sourceExecutable)) {
  throw new Error(`Backend executable was not produced: ${sourceExecutable}`);
}
if (path.dirname(targetDir) !== projectRoot) {
  throw new Error(`Refusing to replace backend outside project root: ${targetDir}`);
}

rmSync(targetDir, { recursive: true, force: true });
cpSync(sourceDir, targetDir, { recursive: true });
console.log(`Backend refreshed: ${targetDir}`);

signBackend(targetDir);

if (isWSL()) {
  console.log('\n[WSL] AppImage testi icin libfuse2 gerekli: sudo apt install libfuse2');
  console.log('[WSL] GUI icin WSLg destegi acik olmali.');
}

// ─── BÜTÜNLÜK MANIFEST + İMZA ─────────────────────────────────────────────────
// backend\ altındaki tüm dosyaların sha256 liste'sini üretir; imza anahtarı repo
// DIŞINDADIR. Anahtar bulunamazsa build'e devam eder ama manifest/çıktı yazılmaz
// (runtime "imzasız" sayar ve sessizce atlar). SIFREKASAM_SIGN_KEY_PATH ile
// açıkça yol verilebilir; varsayılan: ~/.sifrekasam/sign_key.pem
function resolveSignKeyPath() {
  if (process.env.SIFREKASAM_SIGN_KEY_PATH) return process.env.SIFREKASAM_SIGN_KEY_PATH;
  return path.join(os.homedir(), '.sifrekasam', 'sign_key.pem');
}

function walkDir(dir, base) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) {
      results.push(...walkDir(abs, base));
    } else {
      results.push(path.relative(base, abs).replace(/\\/g, '/'));
    }
  }
  return results;
}

function signBackend(dir) {
  const keyPath = resolveSignKeyPath();
  const privateKeyPem = existsSync(keyPath) ? readFileSync(keyPath, 'utf8') : null;
  if (!privateKeyPem) {
    console.warn(`\n[uyari] İmza anahtarı bulunamadı (${keyPath}) -> BU PAKET İMZASIZ olacak.`);
    console.warn('[uyari] Anahtarı üretmek için: node -e "crypto.generateKeyPairSync(\'ed25519\',{}).pem" vs.\n');
    return;
  }

  const files = walkDir(dir, dir).filter((rel) => rel !== 'backend_integrity.json' && rel !== 'backend_integrity.sig.json');
  const manifest = {
    version: 1,
    algorithm: 'sha256',
    files: {},
  };
  for (const rel of files) {
    manifest.files[rel] = crypto.createHash('sha256').update(readFileSync(path.join(dir, rel))).digest('hex');
  }

  const manifestPath = path.join(dir, 'backend_integrity.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  const manifestBytes = readFileSync(manifestPath);

  const privateKey = crypto.createPrivateKey({ key: privateKeyPem, format: 'pem', type: 'pkcs8' });
  const signature = crypto.sign(null, manifestBytes, privateKey);
  writeFileSync(
    path.join(dir, 'backend_integrity.sig.json'),
    JSON.stringify(
      { version: 1, algorithm: 'ed25519', signature: signature.toString('base64'), signedAt: new Date().toISOString() },
      null,
      2
    ),
    'utf8'
  );
  console.log(`Bütünlük manifesti imzalandı (${Object.keys(manifest.files).length} dosya): ${manifestPath}`);
}
