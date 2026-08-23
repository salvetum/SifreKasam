// ─── SQUIRREL KURULUM/KALDIRMA İŞLEMLERİ ─────────────────────────────────────
// Squirrel.Windows olayları, kurulum temizliği (eski veri klasörleri,
// kısayollar, kayıt defteri anahtarları) ve uninstall metadata güncellemesi.

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { spawnSync } = require('child_process');

const { writeFatalDiagnostic } = require('./fatal-errors');

const CANONICAL_UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SifreKasam';
const LEGACY_UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ŞifreKasam',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SifrekasamV2.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.7.0-beta.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.7.0-beta.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.7.0-beta.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.7.0-beta.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.6.3-beta.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.6.3-beta.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.6.3-beta.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.6.3-beta.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.6.3-beta.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.6.3-beta.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.6.2-beta.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.6.2-beta.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.6.2-beta.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.6.2-beta.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.6.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.6.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.6.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.6.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.6.0',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.6.0',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.12',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.12',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.11',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.11',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.10',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.10',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.10-beta.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.10-beta.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.9-beta.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.9-beta.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.9-beta.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.9-beta.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.9-beta',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.9-beta',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.9',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.9',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.8',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.8',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.7',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.7',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.6',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.6',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.5',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.5',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.4',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.4',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.5.0',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.5.0',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.4.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.4.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.4.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.4.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.4.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.4.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.4.0',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.4.0',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.3.4',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.3.4',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.3.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.3.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.3.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.3.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.3.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.3.1',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.3',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam_v2.2',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\sifrekasam-v2.2',
];
const ALL_UNINSTALL_KEYS = [CANONICAL_UNINSTALL_KEY, ...LEGACY_UNINSTALL_KEYS];

function cleanupApplicationData(currentInstallRoot) {
  if (process.platform !== 'win32') return;

  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  const publicProfile = process.env.PUBLIC;

  const appDataNames = [
    '.SifrekasamV2',
    'sifrekasam',
    'SifreKasam',
    'sifrekasam-v2.6.1',
    'sifrekasam-v2.6.0',
    'sifrekasam-v2.5.12',
    'sifrekasam-v2.5.11',
    'sifrekasam-v2.5.10',
    'sifrekasam-v2.5.10-beta.1',
    'sifrekasam-v2.5.9-beta.3',
    'sifrekasam-v2.5.9-beta.2',
    'sifrekasam-v2.5.9-beta',
    'sifrekasam-v2.5.9',
    'sifrekasam-v2.5.8',
    'sifrekasam-v2.5.7',
    'sifrekasam-v2.5.6',
    'sifrekasam-v2.5.5',
    'sifrekasam-v2.5.4',
    'sifrekasam-v2.5.3',
    'sifrekasam-v2.5.2',
    'sifrekasam-v2.5.1',
    'sifrekasam-v2.5.0',
    'sifrekasam-v2.4.3',
    'sifrekasam-v2.4.2',
    'sifrekasam-v2.4.1',
    'sifrekasam-v2.4.0',
    'sifrekasam-v2.3.4',
    'ŞifreKasam',
    'sifrekasam-v2.3.3',
    'sifrekasam-v2.3.2',
    'sifrekasam-v2.3.1',
    'sifrekasam-v2.3',
    'sifrekasam-v2.2',
    'SifrekasamV2.1',
    'Kasa',
  ];

  const dataTargets = [
    ...appDataNames.flatMap(name => [
      appData && path.join(appData, name),
      localAppData && path.join(localAppData, name),
    ]),
    localAppData && path.join(localAppData, 'Programs', 'SifreKasam'),
    localAppData && path.join(localAppData, 'Programs', 'ŞifreKasam'),
    localAppData && path.join(localAppData, 'SifrekasamV2.1'),
  ].filter(Boolean);

  dataTargets.forEach(targetPath => {
    safeRemovePath(targetPath, [appData, localAppData], currentInstallRoot);
  });

  removeKnownShortcuts(appData, userProfile, publicProfile);
  removeKnownRegistryKeys();
}

function safeRemovePath(targetPath, allowedRoots, currentInstallRoot) {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return;

    const resolvedTarget = path.resolve(targetPath);
    const resolvedAllowedRoots = allowedRoots
      .filter(Boolean)
      .map(root => path.resolve(root));
    const targetLower = resolvedTarget.toLowerCase();
    const isAllowed = resolvedAllowedRoots.some(root => {
      const rootLower = root.toLowerCase();
      return targetLower === rootLower || targetLower.startsWith(rootLower + path.sep.toLowerCase());
    });
    if (!isAllowed) return;

    if (currentInstallRoot) {
      const installLower = path.resolve(currentInstallRoot).toLowerCase();
      if (targetLower === installLower || installLower.startsWith(targetLower + path.sep.toLowerCase())) {
        return;
      }
    }

    fs.rmSync(resolvedTarget, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  } catch (_) {}
}

function removeKnownShortcuts(appData, userProfile, publicProfile) {
  const shortcutDirs = [
    appData && path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    userProfile && path.join(userProfile, 'Desktop'),
    publicProfile && path.join(publicProfile, 'Desktop'),
  ].filter(Boolean);
  const shortcutNames = [
    'ŞifreKasam.lnk',
    'SifreKasam.lnk',
    'SifrekasamV2.1.lnk',
    'Kasa.lnk',
  ];

  shortcutDirs.forEach(dir => {
    shortcutNames.forEach(name => {
      try {
        const shortcutPath = path.join(dir, name);
        if (fs.existsSync(shortcutPath)) fs.rmSync(shortcutPath, { force: true });
      } catch (_) {}
    });
  });
}

function deleteRegistryKey(key) {
  try {
    spawnSync('reg.exe', ['delete', key, '/f'], { stdio: 'ignore', windowsHide: true });
  } catch (_) {}
}

function writeRegistryValue(key, name, value) {
  try {
    spawnSync(
      'reg.exe',
      ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'],
      { stdio: 'ignore', windowsHide: true }
    );
  } catch (_) {}
}

function removeKnownRegistryKeys() {
  ALL_UNINSTALL_KEYS.forEach(deleteRegistryKey);
}

function updateWindowsUninstallMetadata(installRoot, resolvePath) {
  if (process.platform !== 'win32') return;

  const iconFile = resolvePath('favicon.ico');
  const appIcon = fs.existsSync(iconFile) ? iconFile : `${process.execPath},0`;
  const updateExe = installRoot ? path.join(installRoot, 'Update.exe') : null;
  const values = [
    ['DisplayIcon', appIcon],
    ['DisplayName', 'ŞifreKasam'],
    ['Publisher', 'Salvetum'],
    ['DisplayVersion', app.getVersion()],
    ['InstallLocation', path.dirname(process.execPath)],
    ...(updateExe ? [
      ['UninstallString', `"${updateExe}" --uninstall -s`],
      ['QuietUninstallString', `"${updateExe}" --uninstall -s`],
    ] : []),
  ];

  LEGACY_UNINSTALL_KEYS.forEach(deleteRegistryKey);
  values.forEach(([name, value]) => {
    writeRegistryValue(CANONICAL_UNINSTALL_KEY, name, value);
  });
}

function handleSquirrelEvent({ resolvePath }) {
  const squirrelEvent = process.argv.find(arg => arg.startsWith('--squirrel-'));
  if (!squirrelEvent) return false;

  const rootAtomFolder  = path.resolve(process.execPath, '..', '..');
  const updateDotExe    = path.join(rootAtomFolder, 'Update.exe');
  const exeName         = path.basename(process.execPath);

  const runUpdate = (args) => {
    try {
      const result = spawnSync(updateDotExe, args, { stdio: 'pipe', windowsHide: true });
      if (result.error) {
        writeFatalDiagnostic('SQUIRREL_UPD', result.error);
      } else if (result.status !== 0) {
        writeFatalDiagnostic('SQUIRREL_UPD', new Error(`Update.exe exit code ${result.status}: ${result.stderr?.toString().slice(0, 500)}`));
      }
    } catch (err) {
      writeFatalDiagnostic('SQUIRREL_UPD', err);
    }
  };

  switch (squirrelEvent) {
    case '--squirrel-install':
    case '--squirrel-updated':
      runUpdate(['--createShortcut', exeName]);
      updateWindowsUninstallMetadata(rootAtomFolder, resolvePath);
      return true;
    case '--squirrel-uninstall':
      runUpdate(['--removeShortcut', exeName]);
      cleanupApplicationData(rootAtomFolder);
      return true;
    case '--squirrel-obsolete':
      return true;
  }
  return false;
}

module.exports = { handleSquirrelEvent };
