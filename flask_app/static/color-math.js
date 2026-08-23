/**
 * ŞifreKasam v2.7.0-beta.3 - Renk Matematiği modülü (ES Module)
 *
 * Hex renk ayrıştırma, RGB/HSV dönüşümleri ve accent karışımları.
 * Saf fonksiyonlar; DOM veya ağ erişimi yoktur. app.js ile base.html
 * pre-paint betiğindeki kopyaların referans uygulamasıdır.
 */

export const normalizeHexColor = (value, fallback = '#7c6ff7') => {
  const raw = String(value || '').trim();
  const hex = raw.startsWith('#') ? raw : `#${raw}`;
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : fallback;
};

export const hexToRgb = (hex) => {
  const clean = normalizeHexColor(hex).slice(1);
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ].join(', ');
};

export const hexToChannels = (hex) =>
  hexToRgb(hex).split(',').map(channel => Number(channel.trim()));

export const hexToHsv = (hex) => {
  const [red, green, blue] = hexToChannels(hex).map(channel => channel / 255);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;

  if (delta) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * (((blue - red) / delta) + 2);
    else hue = 60 * (((red - green) / delta) + 4);
  }

  if (hue < 0) hue += 360;
  return {
    hue: Math.round(hue),
    saturation: Math.round(max === 0 ? 0 : (delta / max) * 100),
    brightness: Math.round(max * 100),
  };
};

export const hsvToHex = (hue, saturation, brightness) => {
  const normalizedHue = ((Number(hue) % 360) + 360) % 360;
  const normalizedSaturation = Math.min(100, Math.max(0, Number(saturation))) / 100;
  const normalizedBrightness = Math.min(100, Math.max(0, Number(brightness))) / 100;
  const chroma = normalizedBrightness * normalizedSaturation;
  const match = normalizedBrightness - chroma;
  const section = normalizedHue / 60;
  const secondary = chroma * (1 - Math.abs((section % 2) - 1));
  const channels = section < 1 ? [chroma, secondary, 0]
    : section < 2 ? [secondary, chroma, 0]
      : section < 3 ? [0, chroma, secondary]
        : section < 4 ? [0, secondary, chroma]
          : section < 5 ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  return `#${channels
    .map(channel => Math.round((channel + match) * 255).toString(16).padStart(2, '0'))
    .join('')}`;
};

export const accentLooksTooLight = (hex) => {
  const [red, green, blue] = hexToChannels(hex);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  const nearWhite = red >= 235 && green >= 235 && blue >= 235;
  return nearWhite || luminance >= 0.9;
};

export const mixColor = (hex, targetHex = '#38bdf8', amount = 0.45) => {
  const first = normalizeHexColor(hex).slice(1);
  const second = normalizeHexColor(targetHex, '#38bdf8').slice(1);
  const channel = (start, end) =>
    Math.round(start + (end - start) * amount).toString(16).padStart(2, '0');
  return `#${channel(parseInt(first.slice(0, 2), 16), parseInt(second.slice(0, 2), 16))}`
    + `${channel(parseInt(first.slice(2, 4), 16), parseInt(second.slice(2, 4), 16))}`
    + `${channel(parseInt(first.slice(4, 6), 16), parseInt(second.slice(4, 6), 16))}`;
};
