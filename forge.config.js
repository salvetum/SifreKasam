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
    extraResource: [
      "./backend",
      "./favicon.ico"
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
  ],
  plugins: []
};
