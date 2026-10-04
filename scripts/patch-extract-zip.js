'use strict';

/*
 * @electron/packager (ve dolayısıyla `npm run make` / `npm run package`)
 * root `node_modules/extract-zip` (-> yauzl 2.10.0) uzerinden Electron zip'ini açar.
 * Node v26 + Windows'ta yauzl, buyuk zip'lerde ilk girdiden sonra sessizce
 * 'close' yayınlayip yalnizca 1 dosya cikariyor; packager electron.exe'yi
 * bulamiyor ve sonsuza dek bekliyor (30 dk+ takilma).
 *
 * Bu script, extract-zip'in index.js'ini Python stdlib zipfile'a devreden
 * drop-in yama ile değiştirir. Python bu projede zaten bagimlilik (Flask) ve
 * ayni zip'i 4 saniyede dogru şekilde acabildigi kanitlanmistir.
 *
 * npm install sonrasi yeniden uygulanmasi icin package.json'da
 * "postinstall": "node scripts/patch-extract-zip.js" tanimlidir.
 */

const fs = require('fs');
const path = require('path');

const NODE_MODULES_DIR = path.resolve(__dirname, '..', 'node_modules');
const EXTRACT_ZIP_INDEX = path.join(NODE_MODULES_DIR, 'extract-zip', 'index.js');
const CROSS_ZIP_INDEX = path.join(NODE_MODULES_DIR, 'cross-zip', 'index.js');
const MARKER = '// patched: python-extract';
const CROSS_ZIP_MARKER = '// patched: fs.rm (node 26)';

const PYTHON_CODE = [].join('\n') + String.raw`import sys, zipfile
zp, dest = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(zp)
try:
    for name in z.namelist():
        if '..' in name.replace('\\', '/').split('/'):
            raise RuntimeError('zip-slip path: ' + name)
    z.extractall(dest)
finally:
    z.close()
`;

const SHIM = `${MARKER}
'use strict';

// Drop-in replace for extract-zip: Node 26 + yauzl on large zips stalls
// after the first entry; delegate to Python stdlib instead.
//
// 🔴 PYTHON ÇÖZÜMLEYİCİ: 'python' PATH'te OLMAYABILIR (Windows kurulumlarında
// sık; bu makinede de yok, sadece 'py -3.12' var). Sabit 'python' çağırmak
// sessizce başarısız oluyor ve node_modules/electron/dist hiç oluşmuyor →
// npm start / package / make çalışmıyor. Projenin kendi çözümleyicisi
// (src/main/python-command.js → resolvePythonCommand) kullanılır; o da yoksa
// makul adaylar sırayla denenir.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const PYTHON_CODE = ${JSON.stringify(PYTHON_CODE)};

function pythonCandidates() {
  const out = [];
  try {
    const { resolvePythonCommand } = require('../src/main/python-command');
    const resolved = resolvePythonCommand();
    if (resolved && resolved.cmd) out.push([resolved.cmd, resolved.args || []]);
  } catch (_) { /* resolver yoksa aday listesine devam et */ }
  out.push(['python', []]);
  out.push(['py', ['-3']]);
  out.push(['py', ['-3.12']]);
  out.push(['python3', []]);
  return out;
}

async function runPython(zipPath, dest) {
  let lastError = null;
  for (const [cmd, args] of pythonCandidates()) {
    try {
      await execFileAsync(cmd, [...args, '-c', PYTHON_CODE, zipPath, dest]);
      return cmd;
    } catch (err) {
      lastError = err;
    }
  }
  const detail = (lastError && (lastError.stderr || '').toString()) || (lastError && lastError.message) || 'bilinmiyor';
  throw new Error('hicbir Python adayi calismadi (' +
    pythonCandidates().map(([c, a]) => c + ' ' + a.join(' ')).join(' | ') + '): ' + detail);
}

async function extractZIP(zipPath, opts) {
  const dir = opts.dir;
  if (!path.isAbsolute(dir)) {
    throw new Error('Target directory is expected to be absolute');
  }
  fs.mkdirSync(dir, { recursive: true });
  const canonicalDest = fs.realpathSync(dir);
  const used = await runPython(path.resolve(zipPath), canonicalDest);
  if (process.env.KASA_EXTRACT_VERBOSE) console.log('[extract-zip] ' + used + ' ile acildi: ' + zipPath);
}

module.exports = extractZIP;
module.exports.extractZIP = extractZIP;
`;

function patchCrossZip() {
  if (!fs.existsSync(CROSS_ZIP_INDEX)) {
    console.log('SKIP: node_modules/cross-zip/index.js not found');
    return;
  }
  const current = fs.readFileSync(CROSS_ZIP_INDEX, 'utf8');
  if (current.includes(CROSS_ZIP_MARKER) || current.includes("fs.rm(outPath, { recursive: true, force: true")) {
    if (!current.includes(CROSS_ZIP_MARKER)) {
      fs.writeFileSync(CROSS_ZIP_INDEX, CROSS_ZIP_MARKER + '\n' + current, 'utf8');
    }
    console.log('SKIP: cross-zip already patched');
    return;
  }
  const replaced = current
    .replace(/fs\.rmdir(outPath, \{ recursive: true, maxRetries: 3 \}, doZip2)/,
      'fs.rm(outPath, { recursive: true, force: true, maxRetries: 3 }, doZip2)')
    .replace(/fs\.rmdirSync(outPath, \{ recursive: true, maxRetries: 3 \})/,
      'fs.rmSync(outPath, { recursive: true, force: true, maxRetries: 3 })');
  if (replaced === current) {
    console.log('WARN: cross-zip.rj patterns not found, manual fix may be required');
    return;
  }
  fs.writeFileSync(CROSS_ZIP_INDEX, CROSS_ZIP_MARKER + '\n' + replaced, 'utf8');
  console.log('PATCHED: ' + CROSS_ZIP_INDEX);
}

function main() {
  if (!fs.existsSync(EXTRACT_ZIP_INDEX)) {
    console.error('SKIP: node_modules/extract-zip/index.js not found (' + EXTRACT_ZIP_INDEX + ')');
    process.exit(0);
  }
  const current = fs.readFileSync(EXTRACT_ZIP_INDEX, 'utf8');
  // Yalnız marker'a bakmak YETERSİZ: shim'in içeriği değiştiğinde (ör. python
  // çözümleyicisi düzeltmesi) marker aynı kalıp ESKİ hali yerinde kalıyordu.
  // Hedef içerikle birebir karşılaştır, farklıysa yaz.
  if (current.trim() === SHIM.trim()) {
    console.log('SKIP: extract-zip zaten guncel (icrik esit)');
  } else {
    const why = current.includes(MARKER)
      ? 'shim eski icerige sahip (marker var ama kod degismis)'
      : 'shim hic uygulanmamis';
    fs.writeFileSync(EXTRACT_ZIP_INDEX, SHIM, 'utf8');
    console.log('PATCHED: ' + EXTRACT_ZIP_INDEX + '  (' + why + ')');
  }
  patchCrossZip();
}

main();