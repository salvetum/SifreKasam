const path = require('path');
const fs = require('fs');

const iconPath = path.resolve(__dirname, 'favicon.ico');
const installerLoadingGifPath = path.resolve(__dirname, 'assets', 'installer-loading.gif');

// Chromium locale .pak dosyaları: arayüzümüz tamamen kendi Jinja/JS'si olduğu
// için yalnızca tr + en gerekli. Diğer ~52 locale paketi (~46 MB) budanır.
// Elektron, istenen locale dosyası yoksa otomatik en-US'e düşer.
const KEPT_LOCALES = new Set(['en-US.pak', 'en-GB.pak', 'tr.pak']);

function pruneUnusedLocales(appDir) {
  if (!fs.existsSync(appDir)) return;
  const localesDir = path.join(appDir, 'locales');
  if (!fs.existsSync(localesDir)) return;
  let removed = 0;
  let savedBytes = 0;
  for (const file of fs.readdirSync(localesDir)) {
    if (KEPT_LOCALES.has(file)) continue;
    const filePath = path.join(localesDir, file);
    try {
      savedBytes += fs.statSync(filePath).size;
      fs.unlinkSync(filePath);
      removed += 1;
    } catch (_) {}
  }
  if (removed) {
    console.log(`[locales] ${removed} kullanılmayan locale paketi budandı (-${(savedBytes / 1024 / 1024).toFixed(1)} MB): ${appDir}`);
  }
}
const squirrelConfig = {
  name: 'SifreKasam',
  title: 'ŞifreKasam',
  authors: 'Salvetum',
  owners: 'Salvetum',
  exe: 'SifreKasam.exe',
  setupExe: 'SifreKasamSetup.exe',
  iconUrl: process.env.SIFREKASAM_ICON_URL || 'https://raw.githubusercontent.com/salvetum/SifreKasam/main/favicon.ico',
  setupIcon: iconPath,
  loadingGif: installerLoadingGifPath
};

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: "SifreKasam",
    ignore: [
      /^\/\.git($|\/)/,
      /^\/\.gitattributes$/,
      /^\/\.gitignore$/,
      /^\/\.github($|\/)/,
      /^\/\.opencode($|\/)/,
      /^\/opencode\.json$/,
      /^\/\.pytest_cache($|\/)/,
      /^\/forge\.config\.js$/,
      /^\/_chk.*\.py$/,
      /^\/preview($|\/)/,
      /^\/tests($|\/)/,
      /^\/docs($|\/)/,
      /^\/scripts($|\/)/,
      /^\/.*\.md$/,
      // runtime asla flask_app'i okumaz (paketli modda kaynak: resources\backend)
      /^\/flask_app($|\/)/,
      // resources\backend (extraResource) olarak dışarıda duruyor; asar'da KOPYA
      // gitmesin (ÇİFTLEŞME: ~80MB kayıp). resolvePath paketli modda
      // process.resourcesPath'e çevrilir, yalnızca preload.js dosyası APP_ROOT'tan
      // okunur — asar kökündeki preload uygulamada korunur.
      /^\/backend($|\/)/,
      // node_modules'te yalnızca runtime ihtiyacı kalır: tree-kill (backend
      // süreç ağacı); forge/webpack vb. DEV araçları pakete girmez.
      /^\/node_modules\/(?!tree-kill($|\/))/,
      // assets: runtime sadece tray-icon.png + installer-loading.gif kullanır
      /^\/assets\/anasayfa_.*\.png$/,
      /^\/assets\/ayarlar_.*\.png$/,
      /^\/assets\/sifreolusturucu_.*\.png$/,
      /^\/flask_app\/.*\.(db|sqlite|sqlite3|pem|key|crt|cer|log)$/,
      /^\/flask_app\/(build|dist|__pycache__)($|\/)/
    ],
    extraResource: [
      "./backend",
      "./favicon.ico",
      "./assets"
    ],
    icon: iconPath,
    win32metadata: {
      CompanyName: "Salvetum",
      FileDescription: "ŞifreKasam",
      InternalName: "SifreKasam",
      OriginalFilename: "SifreKasam.exe",
      ProductName: "ŞifreKasam"
    }
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: squirrelConfig,
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32', 'linux'],
    },
    {
      name: '@reforged/maker-appimage',
      platforms: ['linux'],
      // WSL uzerinde test icin: sudo apt install libfuse2
      // WSLg ile GUI testi icin /etc/wsl.conf icinde [boot] systemd=true olmali
    },
  ],
  plugins: [],
  // Paketleme bitince kullanılmayan Chromium locale'lerini buda (paket boyutu)
  hooks: {
    postPackage: async (_forgeConfig, { outputPaths }) => {
      const paths = Array.isArray(outputPaths) ? outputPaths : [];
      for (const appDir of paths) {
        pruneUnusedLocales(appDir);
      }
    },
  },
};
