const path = require('path');

const iconPath = path.resolve(__dirname, 'favicon.ico');
const installerLoadingGifPath = path.resolve(__dirname, 'assets', 'installer-loading.gif');
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
      /^\/preview($|\/)/,
      /^\/tests($|\/)/,
      /^\/.*\.md$/,
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
  plugins: []
};
