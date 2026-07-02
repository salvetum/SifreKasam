const path = require('path');

const iconPath = path.resolve(__dirname, 'favicon.ico');
const squirrelConfig = {
  name: 'SifreKasam',
  title: 'ŞifreKasam',
  authors: 'Salvetum',
  owners: 'Salvetum',
  exe: 'SifreKasam.exe',
  setupExe: 'SifreKasamSetup.exe',
  setupIcon: iconPath
};

if (process.env.SIFREKASAM_ICON_URL) {
  squirrelConfig.iconUrl = process.env.SIFREKASAM_ICON_URL;
}

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
