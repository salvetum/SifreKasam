// ─── ÖLÜMCÜL HATA RAPORLAMA ──────────────────────────────────────────────────
// Kullanıcı dostu hata diyalogları, tanılama günlüğü ve güvenli mod yeniden
// başlatması. Bu modül import edildiği anda süreç genelinde hata yakalayıcılar
// da devreye girer.

const { app, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

const SAFE_MODE_FLAG = '--sifrekasam-safe-mode';

let fatalErrorShown = false;

function createUserErrorCode(area, error) {
  const detail = error instanceof Error
    ? `${error.name}:${error.message}`
    : String(error || 'unknown');
  const suffix = crypto.createHash('sha256').update(`${area}:${detail}`).digest('hex').slice(0, 6).toUpperCase();
  return `SK-${area}-${suffix}`;
}

function getDataDir() {
  const configDir = process.platform === 'win32'
    ? process.env.APPDATA
    : process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config');
  if (!configDir) return null;
  return process.platform === 'win32'
    ? path.join(configDir, '.SifrekasamV2')
    : path.join(configDir, 'sifrekasam');
}

function getLogFilePath() {
  const dataDir = getDataDir();
  if (!dataDir) return null;
  const logsDir = path.join(dataDir, 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch (_) {}
  return path.join(logsDir, 'sifrekasam-errors.log');
}

function isRunningAsAdmin() {
  if (process.platform !== 'win32') return false;
  try {
    const netPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'net.exe');
    execSync(`"${netPath}" session`, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch (_) {
    return false;
  }
}

function writeFatalDiagnostic(code, error) {
  const logFile = getLogFilePath();
  if (!logFile) return;
  try {
    const detail = error instanceof Error ? (error.stack || error.message) : String(error || 'unknown');
    fs.appendFileSync(
      logFile,
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
    const logFile = getLogFilePath();
    const detail = `Hata kodu: ${code}\n\n${logFile ? 'Detaylar için Log Dosyasını Aç butonuna tıklayın.' : 'Lütfen bu kodu geliştiriciye bildirin.'}`;
    const buttons = logFile ? ['Log Dosyasını Aç', 'Tamam'] : ['Tamam'];
    const result = dialog.showMessageBoxSync({
      type: 'error',
      title: 'ŞifreKasam',
      message,
      detail,
      buttons,
      defaultId: 1,
      noLink: true,
    });
    if (result === 0 && logFile) {
      shell.openPath(logFile).catch(() => {});
    }
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

module.exports = {
  SAFE_MODE_FLAG,
  createUserErrorCode,
  getDataDir,
  getLogFilePath,
  isRunningAsAdmin,
  writeFatalDiagnostic,
  showFriendlyFatalError,
  relaunchInSafeMode,
};
