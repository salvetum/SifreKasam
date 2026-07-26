const { spawnSync } = require('child_process');
const { cpSync, existsSync, readFileSync, rmSync } = require('fs');
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

if (isWSL()) {
  console.log('\n[WSL] AppImage testi icin libfuse2 gerekli: sudo apt install libfuse2');
  console.log('[WSL] GUI icin WSLg destegi acik olmali.');
}
