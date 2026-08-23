// ─── TERCİHLER (theme.json OKUMA) ─────────────────────────────────────────────
// Kullanıcı tercihlerini diskten okuyan saf yardımcılar. Yazma tarafı Flask
// tarafındadır; burada yalnızca okuma yapılır. nativeTheme yalnızca 'system'
// modunun çözümlenmesi için kullanılır.

const { nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');

const GLASS_EFFECTS_FALSY = new Set(['false', '0', 'off', 'disabled']);

function getConfigDir() {
  if (process.platform === 'win32') return process.env.APPDATA;
  return process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config');
}

function isFirstRun() {
  const configDir = getConfigDir();
  if (!configDir) return false;
  const dataDir = process.platform === 'win32'
    ? path.join(configDir, '.SifrekasamV2')
    : path.join(configDir, 'sifrekasam');
  try {
    return !fs.existsSync(path.join(dataDir, 'ssl', 'cert.pem'));
  } catch (_) {
    return false;
  }
}

function readThemeFile() {
  const configDir = getConfigDir();
  if (!configDir) return null;
  const dataDir = process.platform === 'win32'
    ? path.join(configDir, '.SifrekasamV2')
    : path.join(configDir, 'sifrekasam');
  const file = path.join(dataDir, 'theme.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function getSavedThemeMode() {
  try {
    const data = readThemeFile();
    return ['light', 'dark', 'system'].includes(data?.theme_mode) ? data.theme_mode : 'dark';
  } catch (_) { return 'dark'; }
}

function resolveEffectiveTheme() {
  const mode = getSavedThemeMode();
  if (mode === 'system') {
    return process.platform === 'darwin' || process.platform === 'win32'
      ? nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
      : 'dark';
  }
  return mode === 'light' ? 'light' : 'dark';
}

function getSavedGlassEffects() {
  try {
    const data = readThemeFile();
    return !GLASS_EFFECTS_FALSY.has(String(data?.glass_effects_enabled).toLowerCase());
  } catch (_) { return true; }
}

function getSavedHardwareAcceleration() {
  try {
    const data = readThemeFile();
    return !GLASS_EFFECTS_FALSY.has(String(data?.hardware_acceleration_enabled).toLowerCase());
  } catch (_) { return true; }
}

function getSavedGlassQuality() {
  try {
    const data = readThemeFile();
    return ['low', 'normal', 'high'].includes(data?.glass_quality)
      ? data.glass_quality
      : 'normal';
  } catch (_) { return 'normal'; }
}

function getSavedInterfaceAnimations() {
  try {
    const data = readThemeFile();
    return !GLASS_EFFECTS_FALSY.has(String(data?.interface_animations_enabled).toLowerCase());
  } catch (_) { return true; }
}

function getSavedLanguage() {
  try {
    const data = readThemeFile();
    return data?.language || 'tr';
  } catch (_) { return 'tr'; }
}

function getSavedAccentColor() {
  try {
    const data = readThemeFile();
    return /^#[0-9a-fA-F]{6}$/.test(data?.accent_color || '') ? data.accent_color : '#7c6ff7';
  } catch (_) { return '#7c6ff7'; }
}

function getSavedBackgroundStyle() {
  try {
    const data = readThemeFile();
    return ['aurora', 'midnight', 'mesh', 'plain'].includes(data?.background_style)
      ? data.background_style
      : 'aurora';
  } catch (_) { return 'aurora'; }
}

function getSavedWindowBackgroundColor() {
  if (resolveEffectiveTheme() === 'light') return '#eef2ff';
  switch (getSavedBackgroundStyle()) {
    case 'plain':
      return '#080912';
    case 'midnight':
      return '#101326';
    case 'mesh':
      return '#111827';
    default:
      return '#101326';
  }
}

module.exports = {
  getConfigDir,
  isFirstRun,
  readThemeFile,
  getSavedThemeMode,
  resolveEffectiveTheme,
  getSavedGlassEffects,
  getSavedHardwareAcceleration,
  getSavedGlassQuality,
  getSavedInterfaceAnimations,
  getSavedLanguage,
  getSavedAccentColor,
  getSavedBackgroundStyle,
  getSavedWindowBackgroundColor,
};
