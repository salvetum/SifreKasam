const { spawnSync } = require('child_process');
const { cpSync, existsSync, rmSync } = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const flaskAppDir = path.join(projectRoot, 'flask_app');
const sourceDir = path.join(flaskAppDir, 'dist', 'SifreKasam');
const sourceExecutable = path.join(sourceDir, 'SifreKasam.exe');
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
