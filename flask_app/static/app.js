/**
 * ŞifreKasam v2.7.0-beta.3 - Main JavaScript
 */

import { initPasswordGenerator } from './password-generator.js';
import { initToastSystem, showToast, TOAST_BASE, showSuccessToast, showWarningToast } from './toast.js';
import { initRevealCopy, copyToClipboard } from './reveal-copy.js';
import { initPasswordStrength } from './password-strength.js';
import { initCustomControls } from './custom-controls.js';
import { initLanSettings } from './lan-settings.js';
import { initModalSystem } from './modal-system.js';
import { initHeartbeat } from './heartbeat.js';
import { initNotifications } from './notifications.js?v=9.3';
import { initScanSession } from './scan-session.js';
import { initAppearanceSettings } from './appearance-settings.js';
import { initVaultIndex } from './vault-index.js';
import { initVaultForm } from './vault-form.js';
import { initFormCalendar } from './form-calendar.js';
import { initDataPanel } from './data-panel.js';
import {
  normalizeHexColor,
  hexToRgb,
  hexToHsv,
  hsvToHex,
  accentLooksTooLight,
  mixColor,
} from './color-math.js';

document.addEventListener('DOMContentLoaded', () => {

  // ─── SABİTLER & YARDIMCILAR ───────────────────────────────────────────────

  const notifyVaultWriteLocked = async (response) => {
    if (!response || ![409, 423].includes(response.status)) return;

    let message = window._('Ana \u015fifre de\u011fi\u015ftiriliyor, i\u015flem bitince tekrar deneyin.');
    try {
      const data = await response.clone().json();
      if (data?.error) message = data.error;
    } catch (err) {
      // Non-JSON locked responses use the default warning message.
    }

    window.dispatchEvent(new CustomEvent('kasa:vault-write-locked', {
      detail: { message },
    }));
  };

  const apiFetch = async (path, opts = {}) => {
    const method = String(opts.method || 'GET').toUpperCase();
    const headers = { ...opts.headers };
    if (window.KASA_CSRF_TOKEN && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      headers['X-CSRF-Token'] = window.KASA_CSRF_TOKEN;
    }
    try {
      const response = await fetch(path, {
        ...opts,
        credentials: 'same-origin',
        headers,
      });
      await notifyVaultWriteLocked(response);
      return response;
    } catch (err) {
      console.error('API request failed:', err);
      return null;
    }
  };

  const apiJson = async (path, opts = {}) => {
    const response = await apiFetch(path, opts);
    if (!response?.ok) throw new Error(`request-failed:${path}`);
    return response.json();
  };

  const apiPost = (path, body) =>
    apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const filenameFromDisposition = (header, fallback) => {
    const disposition = header || '';
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1].replace(/"/g, ''));

    const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
    return plainMatch?.[1] || fallback;
  };

  const triggerBlobDownload = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const anchor = Object.assign(document.createElement('a'), {
      href: url,
      download: filename,
    });
    anchor.className = 'kasa-download-anchor';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const downloadFromEndpoint = async (path, fallbackFilename) => {
    const response = await apiFetch(path);
    if (!response?.ok) throw new Error(`download-failed:${path}`);
    const blob = await response.blob();
    const filename = filenameFromDisposition(
      response.headers.get('Content-Disposition'),
      fallbackFilename
    );
    triggerBlobDownload(blob, filename);
  };

  const refreshStatsBar = () => {
    fetch('/api/stats')
      .then(r => r.json())
      .then(data => {
        const el = (id, val) => {
          const node = document.getElementById(id);
          if (node) node.textContent = val;
        };
        el('stat-toplam', data.toplam);
        el('stat-pinned', data.pinned);
        el('stat-zayif', data.zayif);
        el('stat-eski', data.eski);
        el('stat-expired', data.expired);
      })
      .catch(() => {});
  };

  const createIcon = (className) => {
    const icon = document.createElement('i');
    icon.className = className;
    return icon;
  };

  const createIconButton = (title, iconClass, className = 'card-icon-btn') => {
    const button = Object.assign(document.createElement('button'), {
      type: 'button',
      title,
      className,
    });
    button.setAttribute('aria-label', title);
    button.appendChild(createIcon(iconClass));
    return button;
  };

  const createStatusNode = (message, className = 'p-3 text-center text-kasa-text-muted', iconClass = '') => {
    const wrapper = document.createElement('div');
    wrapper.className = className;
    if (iconClass) {
      wrapper.append(createIcon(iconClass), ' ');
    }
    wrapper.append(document.createTextNode(message));
    return wrapper;
  };

  const KASA_BG_POS_KEY = 'kasa-bg-video-pos';
  const readBgVideoPos = (url) => {
    try {
      const raw = localStorage.getItem(KASA_BG_POS_KEY);
      if (!raw) return 0;
      const saved = JSON.parse(raw);
      if (!saved || saved.url !== url) return 0;
      return Number(saved.t) || 0;
    } catch (e) { return 0; }
  };
  const writeBgVideoPos = (url, t) => {
    try {
      localStorage.setItem(KASA_BG_POS_KEY, JSON.stringify({ url, t: Number(t) || 0 }));
    } catch (e) { /* localStorage dolu/erişilemez */ }
  };
  const clearBgVideoPos = () => {
    try { localStorage.removeItem(KASA_BG_POS_KEY); } catch (e) { /* yoksay */ }
  };
  const KASA_BG_FRAME_KEY = 'kasa-bg-frame';
  const writeBgVideoFrame = (url, t, poster) => {
    try {
      localStorage.setItem(KASA_BG_FRAME_KEY, JSON.stringify({ url, t: Number(t) || 0, poster }));
    } catch (e) { /* kota/ağ erişimi yok — yoksay */ }
  };
  const captureBgVideoFrame = (v, url, t) => {
    try {
      const w = v.videoWidth || 0;
      const h = v.videoHeight || 0;
      if (!w || !h || !v.currentTime || v.readyState < 2) return false;
      const MAX_W = 1280;
      const scale = Math.min(1, MAX_W / w);
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const cv = document.createElement('canvas');
      cv.width = cw;
      cv.height = ch;
      cv.getContext('2d').drawImage(v, 0, 0, cw, ch);
      const poster = cv.toDataURL('image/jpeg', 0.7);
      writeBgVideoFrame(url, typeof t === 'number' ? t : v.currentTime, poster);
      return true;
    } catch (e) {
      return false;
    }
  };
  const restoreBgFrame = (url) => {
    try {
      const raw = localStorage.getItem(KASA_BG_FRAME_KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (!saved || saved.url !== url || !saved.poster || Number(saved.t) <= 1) return null;
      return saved;
    } catch (e) { return null; }
  };
  const installBgVideoPositionTracking = () => {
    const activeVideoInfo = () => {
      const layer = document.getElementById('custom-bg-layer');
      const v = document.getElementById('custom-bg-video');
      return { v, url: layer ? layer.getAttribute('data-bg-url') : null };
    };
    let lastWrite = 0;
    let lastFrame = 0;
    /* timeupdate yükselmez (bubble yok) → yakalamalı (capture) dinleyici. */
    document.addEventListener('timeupdate', (e) => {
      if (e.target !== document.getElementById('custom-bg-video')) return;
      const { v, url } = activeVideoInfo();
      if (!v || !url || v.paused || !v.classList.contains('is-active')) return;
      const now = performance.now();
      if (now - lastWrite < 2000) return;
      lastWrite = now;
      writeBgVideoPos(url, v.currentTime);
      if (now - lastFrame < 20000) return;
      lastFrame = now;
      captureBgVideoFrame(v, url, v.currentTime);
    }, true);
    /* Son kare pagehide'da saklanır: pozisyon hızlı/yalnız oynarken yazılıp
       kare (devam karesi) sonraki sayfanın ilk boyasına poster olur. */
    window.addEventListener('pagehide', () => {
      const { v, url } = activeVideoInfo();
      if (!v || !url || !v.classList.contains('is-active')) return;
      if (!v.paused) writeBgVideoPos(url, v.currentTime);
      captureBgVideoFrame(v, url, v.currentTime);
    });
  };
  installBgVideoPositionTracking();

  const applyAppearance = (accent, background) => {
    const normalizedAccent = normalizeHexColor(accent);
    const normalizedBackground = ['aurora', 'midnight', 'mesh', 'plain', 'custom'].includes(background)
      ? background
      : 'aurora';
    const accent2 = mixColor(normalizedAccent);
    window.KASA_SET_RUNTIME_STYLE?.('appearance', `html:root {
      --accent: ${normalizedAccent};
      --accent-2: ${accent2};
      --accent-rgb: ${hexToRgb(normalizedAccent)};
      --accent-2-rgb: ${hexToRgb(accent2)};
    }`);
    document.documentElement.setAttribute('data-kasa-background', normalizedBackground);
    const lowPowerMode = document.documentElement.getAttribute('data-kasa-low-power') === 'on';
    const customLayer = document.getElementById('custom-bg-layer');
    if (customLayer) {
      const bgUrl = customLayer.getAttribute('data-bg-url');
      const isActive = normalizedBackground === 'custom' && bgUrl;
      const isVideo = customLayer.getAttribute('data-bg-type') === 'video';
      const markLoaded = () => customLayer.classList.add('is-loaded');
      customLayer.classList.toggle('is-active', isActive);
      if (!isActive) {
        customLayer.classList.remove('is-loaded');
      }
      const frameForVideo = isActive && isVideo ? restoreBgFrame(bgUrl) : null;
      window.KASA_SET_RUNTIME_STYLE?.('custom-background',
        isActive && !isVideo ? `#custom-bg-layer.is-active { background-image: url(${bgUrl}); }`
          : isActive && isVideo && frameForVideo ? `#custom-bg-layer.is-active { background-image: url(${frameForVideo.poster}); }`
          : ''
      );
      if (isActive && !isVideo) {
        const probe = new Image();
        probe.onload = markLoaded;
        probe.onerror = markLoaded;
        probe.src = bgUrl;
      }
      const bgVideo = document.getElementById('custom-bg-video');
      if (bgVideo) {
        if (isActive && isVideo) {
          const markPlayed = () => {
            if (bgVideo.dataset.kasaPosterCleared) return;
            bgVideo.dataset.kasaPosterCleared = '1';
            /* Poster karesi (devam karesiyle aynı) kullanılınca kuralı kaldır —
               video artık canlı. */
            window.KASA_SET_RUNTIME_STYLE?.('custom-background', '');
            captureBgVideoFrame(bgVideo, bgUrl, bgVideo.currentTime);
          };
          if (bgVideo.getAttribute('src') !== bgUrl) {
            bgVideo.setAttribute('src', bgUrl);
            bgVideo.autoplay = !lowPowerMode;
          }
          const onVideoError = () => {
            if (bgVideo.dataset.kasaErrorToast) return;
            bgVideo.dataset.kasaErrorToast = '1';
            showWarningToast(window._('Arka plan videosu oynatılamadı. Video codec türü desteklenmiyor olabilir.'));
          };
          const startVideo = () => {
            if (bgVideo.dataset.kasaResumeDone) return;
            bgVideo.dataset.kasaResumeDone = '1';
            if (lowPowerMode) {
              /* Güç tasarrufu: oynatmadan gerçek kareye al — statik poster
                 (0'da bırakmak kara zemin üretiyordu). */
              if (bgVideo.paused) {
                try { bgVideo.currentTime = 0.05; } catch (e) { /* kare henüz yüklü değil */ }
              }
              captureBgVideoFrame(bgVideo, bgUrl, 0.05);
              return;
            }
            const resumeAt = readBgVideoPos(bgUrl);
            try {
              if (resumeAt > 0.5 && Number.isFinite(bgVideo.duration) && resumeAt < bgVideo.duration - 0.75) {
                bgVideo.currentTime = resumeAt;
              }
            } catch (e) { /* süre henüz bilinmiyor */ }
            if (!bgVideo.dataset.kasaPosterHook) {
              bgVideo.dataset.kasaPosterHook = '1';
              /* Video devam karesine seek edilip oynayınca poster karesi
                 (aynı kare — göze batmaz) temizlenir. */
              bgVideo.addEventListener('seeked', markPlayed, { once: true });
              bgVideo.addEventListener('playing', markPlayed, { once: true });
            }
            bgVideo.play?.().catch(() => {});
          };
          bgVideo.classList.add('is-active');
          /* Oynat/durdur politikasını her seferinde uygula: aynı sayfada
             tasarruf açılırsa video donsun (poster), kapatılırsa devam etsin. */
          if (lowPowerMode) {
            if (!bgVideo.paused) bgVideo.pause?.();
          } else if (bgVideo.paused && bgVideo.readyState >= 2 && bgVideo.getAttribute('src')) {
            bgVideo.play?.().catch(() => {});
          }
          bgVideo.removeEventListener('loadedmetadata', startVideo);
          if (bgVideo.readyState >= 2) {
            startVideo();
          } else {
            bgVideo.addEventListener('loadedmetadata', startVideo, { once: true });
          }
          bgVideo.removeEventListener('error', onVideoError);
          bgVideo.addEventListener('error', onVideoError);
          bgVideo.removeEventListener('loadeddata', markLoaded);
          bgVideo.removeEventListener('error', markLoaded);
          if (bgVideo.readyState >= 2) {
            markLoaded();
          } else {
            bgVideo.addEventListener('loadeddata', markLoaded, { once: true });
            bgVideo.addEventListener('error', markLoaded, { once: true });
          }
        } else {
          bgVideo.classList.remove('is-active');
          if (bgVideo.getAttribute('src')) {
            bgVideo.removeAttribute('src');
            bgVideo.load();
          }
        }
      }
    }
    localStorage.setItem('kasa-accent', normalizedAccent);
    localStorage.setItem('kasa-background', normalizedBackground);
    window.KASA_APPEARANCE = Object.assign(window.KASA_APPEARANCE || {}, {
      accent: normalizedAccent,
      background: normalizedBackground,
    });
    return window.KASA_APPEARANCE;
  };

  const CHROMA_SPEED_OPTIONS = new Set([8, 15, 30, 60]);
  /* rAF ile kare başına 1 kez, en fazla ~200ms'de bir güncelleme:
     `--accent` değişimi tüm DOM'da style recalc tetiklediği için daha sık
     güncellemek CPU israfıdır; 15sn'lik döngüde hue 200ms'de 4.8° kayar,
     görsel olarak ayırt edilemez. Sekme görünmezken rAF zaten tetiklenmez
     → boşta CPU tasarrufu. */
  const CHROMA_UPDATE_INTERVAL_MS = 200;
  const normalizeChromaSpeed = (value) => {
    const speed = Number(value);
    return CHROMA_SPEED_OPTIONS.has(speed) ? speed : 15;
  };

  const chromaRoot = document.documentElement;
  let chromaAccentEnabled = chromaRoot.getAttribute('data-kasa-chroma-accent') === 'on';
  let chromaAccentSpeed = normalizeChromaSpeed(
    chromaRoot.getAttribute('data-kasa-chroma-speed')
  );
  let chromaElapsedMs = 0;
  let chromaStartedAt = 0;
  let chromaRafId = 0;

  const chromaCanAnimate = () => (
    chromaAccentEnabled
    && !document.hidden
    && chromaRoot.getAttribute('data-kasa-animations') !== 'off'
    && chromaRoot.getAttribute('data-kasa-low-power') !== 'on'
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  const applyChromaAccent = (accent) => {
    const normalizedAccent = normalizeHexColor(accent);
    const accent2 = mixColor(normalizedAccent);
    window.KASA_SET_RUNTIME_STYLE?.(
      'chroma-accent',
      `html:root {
        --accent: ${normalizedAccent};
        --accent-2: ${accent2};
        --accent-rgb: ${hexToRgb(normalizedAccent)};
        --accent-2-rgb: ${hexToRgb(accent2)};
      }
      #appearance-preview { --preview-accent: ${normalizedAccent}; }`
    );
  };

  const clearChromaAccent = () => {
    window.KASA_SET_RUNTIME_STYLE?.('chroma-accent', '');
  };

  const stopChromaCycle = () => {
    if (chromaRafId) clearTimeout(chromaRafId);
    chromaRafId = 0;
    if (chromaStartedAt) {
      chromaElapsedMs = Math.max(0, performance.now() - chromaStartedAt);
      chromaStartedAt = 0;
    }
  };

  const renderChromaAccent = () => {
    const cycleMs = chromaAccentSpeed * 1000;
    const hue = ((chromaElapsedMs % cycleMs) / cycleMs) * 360;
    applyChromaAccent(hsvToHex(hue, 84, 96));
  };

  const refreshChromaCycle = () => {
    stopChromaCycle();
    if (!chromaCanAnimate()) return;

    chromaStartedAt = performance.now() - chromaElapsedMs;
    const tick = () => {
      if (!chromaCanAnimate()) {
        stopChromaCycle();
        return;
      }
      chromaElapsedMs = performance.now() - chromaStartedAt;
      renderChromaAccent();
      chromaRafId = setTimeout(tick, CHROMA_UPDATE_INTERVAL_MS);
    };
    chromaRafId = setTimeout(tick, CHROMA_UPDATE_INTERVAL_MS);
  };

  const setChromaAccent = (enabled, speed = chromaAccentSpeed) => {
    const wasEnabled = chromaAccentEnabled;
    const previousCycleMs = chromaAccentSpeed * 1000;
    stopChromaCycle();

    chromaAccentEnabled = Boolean(enabled);
    chromaAccentSpeed = normalizeChromaSpeed(speed);
    if (!wasEnabled && chromaAccentEnabled) {
      const staticAccent = window.KASA_APPEARANCE?.accent || '#7c6ff7';
      chromaElapsedMs = (hexToHsv(staticAccent).hue / 360) * chromaAccentSpeed * 1000;
    } else if (wasEnabled && chromaAccentEnabled && previousCycleMs) {
      const progress = (chromaElapsedMs % previousCycleMs) / previousCycleMs;
      chromaElapsedMs = progress * chromaAccentSpeed * 1000;
    }

    chromaRoot.setAttribute('data-kasa-chroma-accent', chromaAccentEnabled ? 'on' : 'off');
    chromaRoot.setAttribute('data-kasa-chroma-speed', String(chromaAccentSpeed));
    localStorage.setItem('kasa-chroma-accent', chromaAccentEnabled ? 'on' : 'off');
    localStorage.setItem('kasa-chroma-speed', String(chromaAccentSpeed));

    if (!chromaAccentEnabled) {
      clearChromaAccent();
      return { enabled: false, speed: chromaAccentSpeed };
    }

    refreshChromaCycle();
    return { enabled: true, speed: chromaAccentSpeed };
  };

  window.KASA_SET_CHROMA_ACCENT = setChromaAccent;
  window.KASA_REFRESH_CHROMA_ACCENT = refreshChromaCycle;
  document.addEventListener('visibilitychange', refreshChromaCycle);
  new MutationObserver(refreshChromaCycle).observe(chromaRoot, {
    attributes: true,
    attributeFilter: ['data-kasa-animations', 'data-kasa-low-power'],
  });
  setChromaAccent(chromaAccentEnabled, chromaAccentSpeed);

  const applyThemeFeature = (attribute, storageKey, enabled) => {
    const value = enabled ? 'on' : 'off';
    document.documentElement.setAttribute(attribute, value);
    localStorage.setItem(storageKey, value);
    return value;
  };

  const themeFeatureEnabled = (attribute) =>
    document.documentElement.getAttribute(attribute) !== 'off';

  const GLASS_QUALITY_OPTIONS = new Set(['low', 'normal', 'high']);
  const normalizeGlassQuality = (quality) =>
    GLASS_QUALITY_OPTIONS.has(quality) ? quality : 'normal';

  const applyGlassQuality = (quality) => {
    const normalizedQuality = normalizeGlassQuality(quality);
    document.documentElement.setAttribute('data-glass-quality', normalizedQuality);
    localStorage.setItem('kasa-glass-quality', normalizedQuality);
    return normalizedQuality;
  };

  const pageLoadingOverlay = document.querySelector('.page-loading-overlay');
  const pageLoadingTitle = pageLoadingOverlay?.querySelector('.page-loading-title');
  const pageLoadingSubtitle = pageLoadingOverlay?.querySelector('.page-loading-subtitle');
  const defaultLoadingCopy = {
    title: pageLoadingTitle?.textContent || '',
    subtitle: pageLoadingSubtitle?.textContent || '',
  };
  const setPageLoading = (isLoading, copy = {}) => {
    if (pageLoadingTitle) {
      pageLoadingTitle.textContent = isLoading && copy.title
        ? copy.title
        : defaultLoadingCopy.title;
    }
    if (pageLoadingSubtitle) {
      pageLoadingSubtitle.textContent = isLoading && copy.subtitle
        ? copy.subtitle
        : defaultLoadingCopy.subtitle;
    }
    document.body.classList.toggle('is-page-loading', isLoading);
    pageLoadingOverlay?.setAttribute('aria-hidden', String(!isLoading));
  };
  window.KASA_SET_PAGE_LOADING = setPageLoading;

  // ─── 1. HEARTBEAT (heartbeat.js) ────────────────────────────────────────
  initHeartbeat({ apiFetch });

  // ─── 2. SAYFA GEÇİŞ OVERLAY ───────────────────────────────────────────────

  document.querySelectorAll('[data-loading-form]').forEach(form => {
    form.addEventListener('submit', () => {
      setPageLoading(true);
      form.querySelectorAll('button, input, select, textarea')
          .forEach(el => el.setAttribute('aria-disabled', 'true'));
    });
  });

  // ─── KAYDEDİLMEMİŞ DEĞİŞİKLİK ROZETİ (form[data-unsaved-track]) ─────────
  // Form yüklendiği andaki değerleri baseline alır; değişen her alanda
  // badge görünür, submit ile sıfırlanır. Programatik kayıtlar (örn. saat
  // alanının adım butonu) gerçek input/change olayı yaydığı için yakalanır.
  document.querySelectorAll('form[data-unsaved-track]').forEach(form => {
    // Baseline, tum init modulleri (custom-controls/vault-form/appearance)
    // alan degerlerini hallettikten SONRA alinmali; aksi halde ilk kurulumda
    // degisen bir alan kalici "kirli" gorunur.
    setTimeout(() => {
    const badge = form.querySelector('[data-unsaved-badge]');
    if (!badge) return;

    const fields = () => Array.from(
      form.querySelectorAll('input[name], select[name], textarea[name]')
    ).filter(field => !field.disabled);

    const snapshot = () => JSON.stringify(
      fields().map(field => {
        if (field.type === 'checkbox' || field.type === 'radio') {
          return field.checked ? '1' : '0';
        }
        return String(field.value ?? '').trim();
      })
    );

    let baseline = snapshot();
    const submitBtn = form.querySelector('button[type="submit"]');
    const refresh = () => {
      const dirty = snapshot() !== baseline;
      badge.hidden = !dirty;
      badge.setAttribute('aria-hidden', String(!dirty));
      submitBtn?.classList.toggle('kasa-btn-unsaved', dirty);
    };

    form.addEventListener('input', refresh);
    form.addEventListener('change', refresh);
    form.addEventListener('submit', () => {
      baseline = snapshot();
      if (!badge.hidden) refresh();
    });
    }, 0);
  });

  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    const link = e.target.closest('a');
    const href = link?.getAttribute('href');
    if (!href) return;
    // Diğer dinleyiciler gezinmeyi iptal ettiyse (örn. sağlık ekranının
    // navbar geri düğmesi detay kapatırken preventDefault yapar) overlay'i
    // gösterme; aksi halde ekran sonsuz yükleme görünümünde kilitlenir.
    if (e.defaultPrevented) return;
    const isDownload = link.hasAttribute('download')
      || link.target === '_blank'
      || link.hasAttribute('data-no-loading')
      || href.startsWith('blob:')
      || href.includes('/export');
    const isInternal = href !== '#'
      && !href.startsWith('javascript:')
      && !href.startsWith('http')
      && !isDownload;
    if (isInternal) setPageLoading(true);
  });

  // ─── 2b. ÖZEL FORM KONTROLLERİ (custom-controls.js) ─────────────────
  const { customSelectStates, closeCustomSelect } = initCustomControls({ createIcon });

  // ─── 3. TEMA & EFEKT TOGGLE'LARI (appearance-settings.js) ────────────────
  const {
    accentInput,
    getCurrentBackground,
    setChromaAccentPreference,
    glassToggle,
    syncGlassQualityVisibility,
    glassQualitySelect,
    motionToggle,
    interfaceAnimationsToggle,
    gradientsToggle,
    cardSheenToggle,
    cardFrameToggle,
    cardDepthToggle,
    vaultAccentToggle,
    hardwareAccelerationToggle,
    powerSaveToggle,
    updateAppearance,
    cancelPendingAppearanceSave,
  } = initAppearanceSettings({
    apiPost,
    apiFetch,
    themeFeatureEnabled,
    applyThemeFeature,
    normalizeGlassQuality,
    applyGlassQuality,
    normalizeHexColor,
    hexToRgb,
    hexToHsv,
    hsvToHex,
    accentLooksTooLight,
    applyAppearance,
    normalizeChromaSpeed,
    initialChromaAccentEnabled: chromaAccentEnabled,
    initialChromaAccentSpeed: chromaAccentSpeed,
    showToast,
    showWarningToast,
    showSuccessToast,
    TOAST_BASE,
  });

  // ─── 3b. LAN ERİŞİMİ (lan-settings.js) ─────────────────────────────────
  const { lanToggle, lanInfoBox, showPending, showActive, hide } = initLanSettings({ apiJson });

  // ─── 4. TOAST & PANO ──────────────────────────────────────────────────────

  // ─── 4a. TOAST SİSTEMİ (toast.js) ────────────────────────────────────
  initToastSystem({ apiFetch, triggerBlobDownload });
  initNotifications({ apiFetch });
  initScanSession({ apiFetch });
  initDataPanel({ apiFetch });

  document.querySelectorAll('[data-export-format]').forEach(exportButton => {
    exportButton.addEventListener('click', async (event) => {
      event.preventDefault();
      const exportFormat = exportButton.dataset.exportFormat || 'json';
      const exportKind = exportButton.dataset.exportKind || '';
      const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

      // Şifreli yedek: iki adımlı akış — PREPARE (şifre üret + dosya hazır),
      // sonra kullanıcıya tek seferlik şifreyi göster.
      if (exportKind === 'encrypted') {
        const url = exportButton.dataset.exportUrl || '/api/export/encrypted';
        try {
          const prepareResp = await window.KASA_API_FETCH(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
          if (!prepareResp || !prepareResp.ok) throw new Error('encrypted-prepare-failed');
          const prepareData = await prepareResp.json().catch(() => null);
          if (!prepareData || prepareData.status !== 'ok' || !prepareData.token) {
            throw new Error('encrypted-prepare-invalid');
          }

          const reveal = document.getElementById('encrypted-export-reveal');
          const pwdEl = document.getElementById('encrypted-export-password');
          const dlBtn = document.getElementById('encrypted-export-download-btn');
          if (reveal && pwdEl && dlBtn) {
            pwdEl.textContent = prepareData.password || '';
            reveal.hidden = false;
            // İndirme butonuna token'ı bağla — tek kullanımlık.
            dlBtn.dataset.downloadToken = prepareData.token;
            dlBtn.dataset.downloadFilename =
              (prepareData.filename || 'sifrekasam_guvenli_yedek') + '.kasaenc';
            reveal.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        } catch (err) {
          console.error('Encrypted export prepare failed:', err);
          showWarningToast(window._('Şifreli yedek oluşturulamadı.'));
        }
        return;
      }

      exportButton.disabled = true;
      try {
        await downloadFromEndpoint(
          exportButton.dataset.exportUrl || `/export?format=${encodeURIComponent(exportFormat)}`,
          `sifrekasam_yedek_${dateStamp}.${exportFormat}`
        );
        window.kasaModalKapat?.('exportModal');
        window.kasaModalKapat?.('settingsModal');
      } catch (err) {
        console.error('Export failed:', err);
        showWarningToast(window._('Dışa aktarma başarısız oldu.'));
      } finally {
        exportButton.disabled = false;
      }
    });
  });

  // Şifreli yedek: şifreyi kopyala + dosyayı indir + vazgeç.
  const bindEncryptedExportActions = () => {
    const copyBtn = document.getElementById('encrypted-export-copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const pwdEl = document.getElementById('encrypted-export-password');
        const pwd = pwdEl?.textContent || '';
        if (!pwd) return;
        try {
          await navigator.clipboard.writeText(pwd);
          showSuccessToast(window._('Şifre kopyalandı.'));
        } catch {
          showWarningToast(window._('Kopyalanamadı.'));
        }
      });
    }

    const dlBtn = document.getElementById('encrypted-export-download-btn');
    if (dlBtn) {
      dlBtn.addEventListener('click', async () => {
        const token = dlBtn.dataset.downloadToken;
        if (!token) return;
        const filename = dlBtn.dataset.downloadFilename || 'sifrekasam_guvenli_yedek.kasaenc';
        dlBtn.disabled = true;
        try {
          const resp = await window.KASA_API_FETCH(`/export/encrypted/${token}`);
          if (!resp || !resp.ok) {
            showWarningToast(window._('İndirme bağlantısı süresi doldu veya kullanıldı.'));
            return;
          }
          const blob = await resp.blob();
          window.KASA_TRIGGER_BLOB_DOWNLOAD?.(blob, filename);
          window.kasaModalKapat?.('exportModal');
          window.kasaModalKapat?.('settingsModal');
        } catch (err) {
          console.error('Encrypted export download failed:', err);
          showWarningToast(window._('Dışa aktarma başarısız oldu.'));
        } finally {
          dlBtn.disabled = false;
        }
      });
    }

    const cancelBtn = document.getElementById('encrypted-export-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        const reveal = document.getElementById('encrypted-export-reveal');
        if (reveal) reveal.hidden = true;
      });
    }
  };
  bindEncryptedExportActions();

  const validationMessageFor = (field) => {
    if (field.validity.valueMissing) return window._('Lütfen bu alanı doldurun.');
    if (field.validity.typeMismatch || field.validity.badInput) {
      return window._('Lütfen geçerli bir değer girin.');
    }
    if (field.validity.patternMismatch) {
      return window._('Lütfen istenen biçime uygun bir değer girin.');
    }
    return window._('Bu alanı kontrol edin.');
  };

  const clearValidationState = (field) => {
    field.classList.remove('kasa-field-invalid');
    field.removeAttribute('aria-invalid');
  };

  // Native doğrulama balonları yerine temayla uyumlu toast ve alan vurgusu kullan.
  document.querySelectorAll('form:not([data-native-validation])').forEach(form => {
    form.noValidate = true;
  });
  document.addEventListener('invalid', event => event.preventDefault(), true);
  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.dataset.nativeValidation === 'true') return;
    const fields = Array.from(form.elements).filter(field =>
      typeof field.checkValidity === 'function' && !field.disabled
    );
    const invalidField = fields.find(field => !field.checkValidity());
    if (!invalidField) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    invalidField.classList.add('kasa-field-invalid');
    invalidField.setAttribute('aria-invalid', 'true');
    invalidField.focus({ preventScroll: true });
    const reduceMotion = document.documentElement.getAttribute('data-kasa-animations') === 'off'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    invalidField.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    showWarningToast(validationMessageFor(invalidField));
  }, true);
  document.addEventListener('input', event => {
    const field = event.target;
    if (field instanceof HTMLElement && field.classList.contains('kasa-field-invalid')) {
      if (typeof field.checkValidity !== 'function' || field.checkValidity()) clearValidationState(field);
    }
  });
  document.addEventListener('change', event => {
    const field = event.target;
    if (field instanceof HTMLElement && field.classList.contains('kasa-field-invalid')) {
      if (typeof field.checkValidity !== 'function' || field.checkValidity()) clearValidationState(field);
    }
  });

  const updateCheckButton = document.getElementById('update-check-btn');
  const updateCheckStatus = document.getElementById('update-check-status');
  const updateCheckResult = document.getElementById('update-check-result');

  const setUpdateCheckResult = (title, detail, state, releaseUrl = '') => {
    if (!updateCheckResult) return;

    const copy = document.createElement('div');
    const strong = document.createElement('strong');
    const span = document.createElement('span');
    strong.textContent = title;
    span.textContent = detail;
    copy.append(strong, span);

    updateCheckResult.className = `update-check-result ${state}`;
    updateCheckResult.replaceChildren(copy);

    if (releaseUrl) {
      const link = Object.assign(document.createElement('a'), {
        href: releaseUrl,
        target: '_blank',
        rel: 'noopener noreferrer',
        textContent: window._('GitHub’da Aç'),
      });
      updateCheckResult.appendChild(link);
    }
  };

  updateCheckButton?.addEventListener('click', async () => {
    updateCheckButton.disabled = true;
    updateCheckButton.classList.add('is-loading');
    updateCheckResult?.classList.add('hidden');
    if (updateCheckStatus) updateCheckStatus.textContent = window._('Güncelleme kontrol ediliyor...');

    try {
      const data = await apiJson('/api/update-check');
      const currentVersion = `v${data.current_version}`;
      const latestVersion = `v${data.latest_version}`;

      if (data.status === 'disabled') {
        if (updateCheckStatus) updateCheckStatus.textContent = window._('Güncelleme kontrolü kapalı.');
        setUpdateCheckResult(
          window._('İnternet Kill-Switch açık'),
          window._('Güncelleme kontrolü çevrimdışı.'),
          'is-current'
        );
        return;
      }

      if (data.has_update) {
        if (updateCheckStatus) {
          updateCheckStatus.textContent = `${window._('Yeni sürüm bulundu.')}: ${latestVersion}`;
        }
        setUpdateCheckResult(
          window._('Yeni sürüm bulundu.'),
          `${window._('Mevcut')}: ${currentVersion} • ${window._('En son')}: ${latestVersion}`,
          'is-update',
          data.release_url
        );
      } else {
        if (updateCheckStatus) {
          updateCheckStatus.textContent = `${window._('Mevcut sürüm')}: ${currentVersion}`;
        }
        setUpdateCheckResult(
          window._('Son sürümdesiniz.'),
          `${window._('Mevcut')}: ${currentVersion} • ${window._('En son')}: ${latestVersion}`,
          'is-current',
          data.release_url
        );
      }
    } catch (err) {
      console.error('Update check failed:', err);
      if (updateCheckStatus) updateCheckStatus.textContent = window._('Güncelleme bilgisi alınamadı.');
      setUpdateCheckResult(
        window._('Güncelleme bilgisi alınamadı.'),
        window._('İnternet bağlantınızı kontrol edip tekrar deneyin.'),
        'is-error'
      );
    } finally {
      updateCheckButton.disabled = false;
      updateCheckButton.classList.remove('is-loading');
    }
  });

  const settingsForm = document.querySelector('[data-settings-form]');
  if (settingsForm) {
    const settingsTabs = Array.from(settingsForm.querySelectorAll('[data-settings-tab]'));
    const settingsPanels = Array.from(settingsForm.querySelectorAll('[data-settings-panel]'));

    // ── Sekme geçiş motoru v2: Web Animations API ──────────────────────
    // CSS class/kareframe dansının (restart yarışları, setTimeout senkronu)
    // yerine programatik animasyon: her geçişte GARANTİ başlar, bitişi
    // promise ile senkronlanır. Yön duyarlıdır: aşağı giderken içerik
    // sağdan, yukarı gelirken soldan süzülür.
    const WAAI_SWIFT = 'cubic-bezier(0.22, 1, 0.36, 1)';
    const WAAI_EXIT = 'cubic-bezier(0.4, 0, 0.2, 1)';
    let activeSettingsPanel = settingsPanels.find(panel => panel.classList.contains('active')) || null;

    const motionDisabled = () => document.documentElement.getAttribute('data-kasa-animations') === 'off'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const activateSettingsTab = (tabName, focusTab = false) => {
      const nextTab = settingsTabs.find(tab => tab.dataset.settingsTab === tabName);
      const nextPanel = settingsPanels.find(panel => panel.dataset.settingsPanel === tabName);
      if (!nextTab || !nextPanel) return;

      settingsTabs.forEach(tab => {
        const isActive = tab === nextTab;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
        tab.tabIndex = isActive ? 0 : -1;
      });

      if (nextPanel === activeSettingsPanel) {
        if (focusTab) nextTab.focus();
        return;
      }

      const prevPanel = activeSettingsPanel;
      activeSettingsPanel = nextPanel;
      const goingDown = prevPanel
        ? settingsPanels.indexOf(nextPanel) > settingsPanels.indexOf(prevPanel)
        : true;

      // Sekme gecis tanilamasi (konsoldan __tabDiag ile okunur)
      try {
        const diag = {
          to: tabName,
          dir: goingDown ? 'down' : 'up',
          t: Math.round(performance.now()),
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          engine: 'waapi'
        };
        requestAnimationFrame(() => requestAnimationFrame(() => {
          try {
            diag.opAfter2f = +(+getComputedStyle(nextPanel).opacity).toFixed(2);
          } catch (_) {}
        }));
        window.__tabDiag = window.__tabDiag || [];
        window.__tabDiag.push(diag);
      } catch (_) {}

      const reduced = motionDisabled();
      // Cam yüzey tespiti: backdrop-filter'li bir elementin opakligini
      // animate etmek, animasyon bitince ornekleme tam guce gecirken TON
      // sicramasi yaratir (kullanicinin "hafif accent" algisi). Bu yuzden
      // cam yuzeyler YALNIZCA transform ile kayar — hep tam opak.
      const isGlass = (el) => {
        try { return getComputedStyle(el).backdropFilter !== 'none'; } catch (_) { return false; }
      };
      const collectTargets = (panel) => {
        const targets = [];
        Array.from(panel.children).forEach(child => {
          if (child.classList.contains('settings-action-grid')) {
            // Sarmalayici saydam: icindeki kartlar tek tek girer
            Array.from(child.querySelectorAll(':scope > .settings-action-card')).forEach(card => {
              targets.push({ el: card, glass: true });
            });
          } else {
            targets.push({ el: child, glass: isGlass(child) });
          }
        });
        return targets;
      };

      // 1) ÇIKIŞ: eski panelin öğeleri söner; CAM olanlar kayarak çıkar
      // (opaklık yok → ton sıçraması yok).
      if (prevPanel && !prevPanel.hidden) {
        prevPanel._kasaExiting = true;
        const prevTargets = collectTargets(prevPanel);
        if (reduced) {
          prevPanel._kasaExiting = false;
          prevPanel.classList.remove('active');
          prevPanel.hidden = true;
        } else {
          const exitAnims = prevTargets.map(({ el, glass }) => el.animate(
            glass
              ? [
                  { transform: 'none' },
                  { transform: `translateX(${goingDown ? -26 : 26}px)` },
                ]
              : [
                  { opacity: 1, transform: 'none' },
                  { opacity: 0, transform: `translateX(${goingDown ? -12 : 12}px)` },
                ],
            { duration: 190, easing: WAAI_EXIT, fill: 'forwards' }
          ));
          Promise.allSettled(exitAnims.map(a => a.finished)).then(() => {
            if (!prevPanel._kasaExiting) return; // bu sürede geri dönüldü
            prevPanel._kasaExiting = false;
            prevPanel.classList.remove('active');
            prevPanel.hidden = true;
            prevTargets.forEach(t => t.el.getAnimations().forEach(a => a.cancel()));
          });
        }
      }

      // 2) GİRİŞ: cam olmayanlar fade+slide, CAM olanlar yalnız slide
      // (tam opak — bitişte hiçbir ton değişimi olmaz).
      nextPanel._kasaExiting = false;
      Array.from(nextPanel.children).forEach(child => {
        child.getAnimations().forEach(a => a.cancel());
      });
      nextPanel.hidden = false;
      nextPanel.classList.add('active');

      if (!reduced) {
        const dirX = goingDown ? 22 : -22;
        // Giris ~90ms gecikmeli: cikan panelin cikisi once TAM olarak
        // gorunur, sonra yenisi iceri süzülür. CAM hedeflerde opaklik
        // animasyona girmez (ton sicramasi yok), yalnizca kayar.
        collectTargets(nextPanel).forEach(({ el, glass }, index) => {
          el.animate(
            glass
              ? [
                  { transform: `translateX(${dirX}px)` },
                  { transform: 'none' },
                ]
              : [
                  { opacity: 0, transform: `translateX(${Math.round(dirX * 0.6)}px)` },
                  { opacity: 1, transform: 'none' },
                ],
            {
              duration: glass ? 300 : 250,
              delay: 90 + Math.min(index, 8) * 26,
              easing: WAAI_SWIFT,
              fill: 'backwards',
            }
          );
        });
      }

      if (focusTab) nextTab.focus();
    };

    settingsTabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activateSettingsTab(tab.dataset.settingsTab));
      tab.addEventListener('keydown', event => {
        const keyOffsets = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
        let nextIndex = index;
        if (event.key in keyOffsets) {
          nextIndex = (index + keyOffsets[event.key] + settingsTabs.length) % settingsTabs.length;
        } else if (event.key === 'Home') {
          nextIndex = 0;
        } else if (event.key === 'End') {
          nextIndex = settingsTabs.length - 1;
        } else {
          return;
        }
        event.preventDefault();
        activateSettingsTab(settingsTabs[nextIndex].dataset.settingsTab, true);
      });
    });

    const getSettingsSnapshot = () => {
      const entries = [];
      settingsForm.querySelectorAll('input[name], select[name], textarea[name]').forEach((field) => {
        if (field.disabled) return;
        let value = field.value;
        if (field.type === 'checkbox' || field.type === 'radio') {
          value = field.checked ? '1' : '0';
        } else if (field.type === 'color') {
          value = normalizeHexColor(value);
        } else {
          value = String(value ?? '').trim();
        }
        entries.push([field.name, value]);
      });
      return JSON.stringify(entries.sort(([left], [right]) => left.localeCompare(right)));
    };

    let settingsFormSnapshot = getSettingsSnapshot();

    // Kaydedilmemiş değişiklik rozeti.
    const settingsUnsavedBadge = document.getElementById('settings-unsaved-badge');
    const settingsSaveBtn = settingsForm?.querySelector('.modal-footer button[type="submit"]');
    const APPEARANCE_AUTOSAVE_FIELDS = new Set([
      'accent_color', 'background_style', 'chroma_accent_enabled', 'chroma_accent_speed',
      'animated_backgrounds_enabled', 'interface_animations_enabled', 'gradients_enabled',
      'card_sheen_enabled', 'card_frame_enabled', 'card_depth_enabled',
      'vault_accent_enabled', 'power_save_enabled',
    ]);
    const updateSettingsUnsavedBadge = (nextSnapshot) => {
      if (!settingsUnsavedBadge) return;
      const dirty = nextSnapshot !== undefined
        ? nextSnapshot !== settingsFormSnapshot
        : getSettingsSnapshot() !== settingsFormSnapshot;
      settingsUnsavedBadge.hidden = !dirty;
      settingsUnsavedBadge.setAttribute('aria-hidden', String(!dirty));
      settingsSaveBtn?.classList.toggle('kasa-btn-unsaved', dirty);
    };
    const settingsFormDirtyListen = () => {
      settingsForm.querySelectorAll('input[name], select[name], textarea[name]')
        .forEach(field => field.addEventListener('input', () => updateSettingsUnsavedBadge()));
      settingsForm.addEventListener('change', () => updateSettingsUnsavedBadge());
      // Otomatik kaydedilen görünüm ayarları (appearance-settings.js) alanı
      // değiştirince badge yanmasın; YALNIZCA otomatik kaydedilen alanlar
      // baseline'a katılır — diğer bekleyen değişiklikler kirli kalır.
      window.addEventListener('kasa:appearance-saved', () => {
        try {
          const previous = new Map(JSON.parse(settingsFormSnapshot));
          const merged = JSON.parse(getSettingsSnapshot()).map(([fieldName, value]) => [
            fieldName,
            APPEARANCE_AUTOSAVE_FIELDS.has(fieldName)
              ? value
              : (previous.has(fieldName) ? previous.get(fieldName) : value),
          ]);
          merged.sort(([leftName], [rightName]) => leftName.localeCompare(rightName));
          settingsFormSnapshot = JSON.stringify(merged);
        } catch (_) {
          settingsFormSnapshot = getSettingsSnapshot();
        }
        updateSettingsUnsavedBadge();
      });
    };
    settingsFormDirtyListen();
    // Init modulleri alanlari hallettikten sonra baseline'i tazele.
    setTimeout(() => {
      settingsFormSnapshot = getSettingsSnapshot();
      updateSettingsUnsavedBadge(settingsFormSnapshot);
    }, 0);

    // İnternet Kill-Switch ve Canlı Sızıntı Taraması: durum notlarını
    // toggle'a göre göster/gizle (ayar formundaki diğer kutularla aynı).
    const killSwitchToggle = document.getElementById('internet-kill-switch-toggle');
    const liveScanToggle = document.getElementById('live-breach-scan-toggle');
    const syncNetworkPolicyNotes = () => {
      const activeNote = document.getElementById('kill-switch-active-note');
      if (activeNote) activeNote.hidden = !killSwitchToggle?.checked;
      const conflictNote = document.getElementById('live-scan-kill-switch-note');
      if (conflictNote) conflictNote.hidden = !(liveScanToggle?.checked && killSwitchToggle?.checked);
    };
    killSwitchToggle?.addEventListener('change', syncNetworkPolicyNotes);
    liveScanToggle?.addEventListener('change', syncNetworkPolicyNotes);

    // LAN uyarısı: toggle açılırken gösterilir (kayıt anında değil).
    // "Bir daha gösterme" seçimi localStorage'da tutulur.
    const LAN_WARNING_DISMISS_KEY = 'kasa-lan-warning-dismissed';
    if (lanToggle && lanInfoBox) {
      const lanWasEnabled = () => {
        try {
          return JSON.parse(settingsFormSnapshot)
            .some(([name, value]) => name === 'lan_enabled' && value === '1');
        } catch (_) { return false; }
      };

      lanToggle.addEventListener('change', async function () {
        if (!lanToggle.checked) {
          hide();
          return;
        }
        // LAN zaten kayıtlı + aktifse adresi doğrudan göster, uyarı gösterme.
        if (lanWasEnabled()) {
          showActive();
          return;
        }
        if (localStorage.getItem(LAN_WARNING_DISMISS_KEY)) {
          showPending();
          return;
        }

        let dontShowAgain = false;
        let rememberCheckbox = null;
        const confirmation = await Swal.fire({
          title: window._('LAN Erişimi'),
          icon: 'warning',
          html: `<p class="kasa-swal-msg">${window._('LAN modu açıkken aynı ağdaki cihazlar giriş yapmayı deneyebilir. Yalnızca güvendiğiniz ağlarda kullanın; bu özelliği açarak riski kabul etmiş olursunuz.')}</p>
                 <label class="kasa-swal-remember">
                   <input type="checkbox" class="kasa-checkbox" id="lan-warning-remember">
                   <span>${window._('Bu uyarıyı bir daha gösterme')}</span>
                 </label>`,
          showCancelButton: true,
          heightAuto: false,
          scrollbarPadding: false,
          confirmButtonText: window._('Evet, Aç'),
          cancelButtonText: window._('Vazgeç'),
          color: 'var(--text)',
          buttonsStyling: false,
          customClass: {
            popup: 'kasa-swal-popup', title: 'kasa-swal-title',
            htmlContainer: 'kasa-swal-text', actions: 'kasa-swal-actions',
            confirmButton: 'kasa-btn kasa-btn-primary',
            cancelButton: 'kasa-btn kasa-btn-muted',
          },
          willOpen: (popup, container) => {
            popup.classList.add('kasa-swal-enter');
            container.classList.add('kasa-swal-container');
          },
          didOpen: (popup, container) => {
            void container.offsetHeight;
            popup.classList.add('is-open');
            container.classList.add('is-open');
            rememberCheckbox = document.getElementById('lan-warning-remember');
          },
          willClose: (popup, container, done) => {
            popup.classList.add('is-closing');
            container.classList.add('is-closing');
            setTimeout(done, 150);
          },
          preConfirm: () => {
            dontShowAgain = rememberCheckbox ? rememberCheckbox.checked : false;
            return true;
          },
        });
        if (!confirmation.isConfirmed) {
          lanToggle.checked = false;
          hide();
          return;
        }
        if (dontShowAgain) {
          localStorage.setItem(LAN_WARNING_DISMISS_KEY, '1');
        }
        showPending();
      });
    }

    settingsForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const nextSnapshot = getSettingsSnapshot();
      if (nextSnapshot === settingsFormSnapshot) {
        showSuccessToast(window._('Ayarlar zaten güncel.'));
        return;
      }

      const submitButton = settingsForm.querySelector('button[type="submit"]');

      setPageLoading(true);
      submitButton?.setAttribute('aria-disabled', 'true');
      if (submitButton) submitButton.disabled = true;
      cancelPendingAppearanceSave?.();

      try {
        const data = await apiJson(settingsForm.action, {
          method: 'POST',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          body: new FormData(settingsForm),
        });
        if (data.accent_color || data.background_style) {
          updateAppearance(
            data.accent_color || accentInput?.value,
            data.background_style || getCurrentBackground(),
            false
          );
        }
        if (typeof data.chroma_accent_enabled === 'boolean') {
          setChromaAccentPreference(
            data.chroma_accent_enabled,
            data.chroma_accent_speed,
            false,
            false
          );
        }
        if (typeof data.glass_effects_enabled === 'boolean' && glassToggle) {
          glassToggle.checked = data.glass_effects_enabled;
          const value = data.glass_effects_enabled ? 'on' : 'off';
          document.documentElement.setAttribute('data-glass-effects', value);
          localStorage.setItem('kasa-glass-effects', value);
          syncGlassQualityVisibility(data.glass_effects_enabled, false);
        }
        if (data.glass_quality && glassQualitySelect) {
          glassQualitySelect.value = applyGlassQuality(data.glass_quality);
          glassQualitySelect.kasaSyncCustomSelect?.();
        }
        if (typeof data.glass_blur === 'number' || typeof data.glass_veil === 'number') {
          const blur = typeof data.glass_blur === 'number'
            ? Math.min(1.5, Math.max(0, data.glass_blur)) : null;
          const veil = typeof data.glass_veil === 'number'
            ? Math.min(2, Math.max(0, data.glass_veil)) : null;
          const glassBlurRange = document.getElementById('glass-blur-range');
          const glassVeilRange = document.getElementById('glass-veil-range');
          const glassBlurOutput = document.getElementById('glass-blur-output');
          const glassVeilOutput = document.getElementById('glass-veil-output');
          if (blur !== null && glassBlurRange) {
            glassBlurRange.value = String(Math.round(blur * 100));
            if (glassBlurOutput) glassBlurOutput.textContent = Math.round(blur * 100) + '%';
            glassBlurOutput?.classList.toggle('is-over-boost', blur > 1);
          }
          if (veil !== null && glassVeilRange) {
            glassVeilRange.value = String(Math.round(veil * 100));
            if (glassVeilOutput) glassVeilOutput.textContent = Math.round(veil * 100) + '%';
            glassVeilOutput?.classList.toggle('is-over-boost', veil > 1);
          }
          document.documentElement.setAttribute('data-glass-blur', String(blur ?? 1));
          document.documentElement.setAttribute('data-glass-veil', String(veil ?? 1));
          document.documentElement.style.setProperty('--glass-blur-scale', String(blur ?? 1));
          document.documentElement.style.setProperty('--glass-veil-scale', String(veil ?? 1));
          localStorage.setItem('kasa-glass-blur', String(blur ?? 1));
          localStorage.setItem('kasa-glass-veil', String(veil ?? 1));
          document.dispatchEvent(new CustomEvent('kasa:glass-refresh'));
        }
        if (typeof data.animated_backgrounds_enabled === 'boolean' && motionToggle) {
          motionToggle.checked = data.animated_backgrounds_enabled;
          applyThemeFeature('data-kasa-motion', 'kasa-animated-backgrounds', data.animated_backgrounds_enabled);
        }
        if (typeof data.interface_animations_enabled === 'boolean' && interfaceAnimationsToggle) {
          interfaceAnimationsToggle.checked = data.interface_animations_enabled;
          applyThemeFeature('data-kasa-animations', 'kasa-interface-animations', data.interface_animations_enabled);
        }
        if (typeof data.gradients_enabled === 'boolean' && gradientsToggle) {
          gradientsToggle.checked = data.gradients_enabled;
          applyThemeFeature('data-kasa-gradient', 'kasa-gradients', data.gradients_enabled);
        }
        if (typeof data.card_sheen_enabled === 'boolean' && cardSheenToggle) {
          cardSheenToggle.checked = data.card_sheen_enabled;
          applyThemeFeature('data-kasa-card-sheen', 'kasa-card-sheen', data.card_sheen_enabled);
        }
        if (typeof data.card_frame_enabled === 'boolean' && cardFrameToggle) {
          cardFrameToggle.checked = data.card_frame_enabled;
          applyThemeFeature('data-kasa-card-frame', 'kasa-card-frame', data.card_frame_enabled);
        }
        if (typeof data.card_depth_enabled === 'boolean' && cardDepthToggle) {
          cardDepthToggle.checked = data.card_depth_enabled;
          applyThemeFeature('data-kasa-card-depth', 'kasa-card-depth', data.card_depth_enabled);
        }
        if (typeof data.vault_accent_enabled === 'boolean' && vaultAccentToggle) {
          vaultAccentToggle.checked = data.vault_accent_enabled;
          applyThemeFeature('data-kasa-vault-accent', 'kasa-vault-accent', data.vault_accent_enabled);
        }
        if (typeof data.hardware_acceleration_enabled === 'boolean' && hardwareAccelerationToggle) {
          hardwareAccelerationToggle.checked = data.hardware_acceleration_enabled;
        }
        if (typeof data.power_save_enabled === 'boolean' && powerSaveToggle) {
          powerSaveToggle.checked = data.power_save_enabled;
          applyThemeFeature('data-kasa-power-save', 'kasa-power-save', data.power_save_enabled);
        }
        if (typeof data.lan_enabled === 'boolean' && lanToggle && lanInfoBox) {
          lanToggle.checked = data.lan_enabled;
          if (data.lan_enabled) showActive(); else hide();
        }
        if (typeof data.internet_kill_switch_enabled === 'boolean' && killSwitchToggle) {
          killSwitchToggle.checked = data.internet_kill_switch_enabled;
        }
        if (typeof data.live_breach_scan_enabled === 'boolean' && liveScanToggle) {
          liveScanToggle.checked = data.live_breach_scan_enabled;
        }
        syncNetworkPolicyNotes();
        settingsFormSnapshot = getSettingsSnapshot();
        updateSettingsUnsavedBadge(settingsFormSnapshot);
        showSuccessToast(window._('Ayarlar kaydedildi.'));
        if (data.restart_required) {
          showSuccessToast(window._('Yeniden başlatılıyor...'));
          // Electron'a anında haber ver: poll döngüsünü beklemeden LAN
          // mutabakatı başlasın (webRequest kancası güvenilir değil).
          try { window.kasaIpc?.notifyLanSaved?.(); } catch (_) {}
        }
      } catch {
        showWarningToast(window._('Ayarlar kaydedilemedi.'));
      } finally {
        setPageLoading(false);
        submitButton?.removeAttribute('aria-disabled');
        if (submitButton) submitButton.disabled = false;
      }
    });
  }
  const importForm = document.getElementById('import-form');
  const importSubmitButton = document.getElementById('import-submit');
  const importFileInput = document.getElementById('import-file');
  const importDropZone = document.getElementById('import-drop-zone');
  const importFileName = document.getElementById('import-file-name');
  const importPasswordWrap = document.getElementById('import-password-wrap');
  const importFilePassword = document.getElementById('import-file-password');
  const supportedImportExtensions = new Set(['.json', '.kasaenc', '.txt']);

  const setImportPasswordVisibility = (isEncrypted) => {
    if (importPasswordWrap) importPasswordWrap.hidden = !isEncrypted;
    if (isEncrypted && importFilePassword) {
      importFilePassword.setAttribute('required', '');
      importFilePassword.setAttribute('aria-required', 'true');
    } else if (importFilePassword) {
      importFilePassword.removeAttribute('required');
      importFilePassword.removeAttribute('aria-required');
      importFilePassword.value = '';
    }
  };
  setImportPasswordVisibility(false);

  const resetImportFile = () => {
    if (importFileInput) importFileInput.value = '';
    if (importFileName) importFileName.textContent = window._('Dosya seçilmedi');
    importDropZone?.classList.remove('has-file');
    setImportPasswordVisibility(false);
  };

  const useImportFile = (file) => {
    if (!file || !importFileInput) return false;
    const extensionIndex = file.name.lastIndexOf('.');
    const extension = extensionIndex >= 0 ? file.name.slice(extensionIndex).toLowerCase() : '';
    const maxBytes = Number(importDropZone?.dataset.maxBytes) || (5 * 1024 * 1024);

    if (!supportedImportExtensions.has(extension)) {
      resetImportFile();
      showWarningToast(window._('Yalnızca .json, .kasaenc veya .txt dosyaları içe aktarılabilir.'));
      return false;
    }
    if (file.size > maxBytes) {
      resetImportFile();
      showWarningToast(window._('Dosya boyutu 5 MB sınırını aşıyor.'));
      return false;
    }

    if (importFileInput.files?.[0] !== file) {
      try {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        importFileInput.files = transfer.files;
      } catch {
        showWarningToast(window._('Dosya seçilemedi. Lütfen seçim düğmesini kullanın.'));
        return false;
      }
    }

    if (importFileName) {
      const fileSize = file.size < 1024 * 1024
        ? `${Math.max(1, Math.round(file.size / 1024))} KB`
        : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
      importFileName.textContent = `${file.name} · ${fileSize}`;
    }
    importDropZone?.classList.add('has-file');
    setImportPasswordVisibility(extension === '.kasaenc');
    return true;
  };

  importFileInput?.addEventListener('change', () => {
    const file = importFileInput.files?.[0];
    if (file) useImportFile(file);
    else resetImportFile();
  });
  importDropZone?.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      importFileInput?.click();
    }
  });
  ['dragenter', 'dragover'].forEach(eventName => {
    importDropZone?.addEventListener(eventName, event => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      importDropZone.classList.add('is-dragging');
    });
  });
  importDropZone?.addEventListener('dragleave', event => {
    if (!importDropZone.contains(event.relatedTarget)) {
      importDropZone.classList.remove('is-dragging');
    }
  });
  importDropZone?.addEventListener('drop', event => {
    event.preventDefault();
    importDropZone.classList.remove('is-dragging');
    useImportFile(event.dataTransfer.files?.[0]);
  });

  importForm?.addEventListener('submit', (event) => {
    if (importForm.dataset.submitting === 'true') {
      event.preventDefault();
      return;
    }

    importForm.dataset.submitting = 'true';
    importForm.setAttribute('aria-busy', 'true');
    if (importSubmitButton) {
      const spinner = document.createElement('i');
      spinner.className = 'fa-solid fa-spinner fa-spin mr-2';
      importSubmitButton.disabled = true;
      importSubmitButton.setAttribute('aria-disabled', 'true');
      importSubmitButton.replaceChildren(
        spinner,
        document.createTextNode(window._('İçe aktarılıyor…')),
      );
    }
  });

  // ─── 5. ŞİFRE GÖSTER / KOPYALA BUTONLARI (reveal-copy.js) ────────────
  initRevealCopy({ apiJson });
  // ─── 6. MODAL SİSTEMİ (modal-system.js) ─────────────────────────────────
  initModalSystem({ customSelectStates, closeCustomSelect });

  // ─── 6b. BAŞLIK DROPDOWN (Ayarlar) ──────────────────────────────────────
  const headerDropdowns = Array.from(document.querySelectorAll('[data-kasa-dropdown]'));

  /* Portal-aware menu bulucu: menü artık dropdown wrapper içinde olmayabilir
     (navbar blur'den bağımsız cam için DOM'dan taşındı). aria-controls ile
     ID üzerinden bulur; bulamazsa eski querySelector fallback'i çalışır. */
  const findMenu = (dropdown) => {
    const trigger = dropdown.querySelector('.kasa-dropdown-trigger');
    const menuId = trigger?.getAttribute('aria-controls');
    if (menuId) {
      const el = document.getElementById(menuId);
      if (el) return el;
    }
    return dropdown.querySelector('.kasa-dropdown-menu');
  };

  /* Portal dropdown konumlandırma: trigger'ın altına position:fixed ile yerleştirir.
     Viewport taşması hemen (synchronous) kontrol edilir — rAF.flash önleme
     için konum + overflow tek frame'de tamamlanır. */
  const positionDropdownMenu = (trigger, menu) => {
    const rect = trigger.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${rect.bottom + 8}px`;
    menu.style.left = `${rect.left}px`;
    const mRect = menu.getBoundingClientRect();
    if (mRect.right > window.innerWidth - 8) {
      menu.style.left = `${Math.max(8, window.innerWidth - mRect.width - 8)}px`;
    }
    if (mRect.bottom > window.innerHeight - 8) {
      menu.style.top = `${Math.max(8, rect.top - mRect.height - 8)}px`;
    }
  };

  const resetDropdownMenuPosition = (menu) => {
    menu.style.position = '';
    menu.style.top = '';
    menu.style.left = '';
  };

  /* ── Scroll/resize sırasında açık dropdown'ı trigger'a sabit tut ── */
  let _activeDropdownTrigger = null;
  let _activeDropdownMenu = null;

  const _repositionOnScroll = () => {
    if (_activeDropdownTrigger && _activeDropdownMenu && !_activeDropdownMenu.hidden) {
      positionDropdownMenu(_activeDropdownTrigger, _activeDropdownMenu);
    }
  };

  const _attachDropdownPositionListeners = (trigger, menu) => {
    _detachDropdownPositionListeners();
    _activeDropdownTrigger = trigger;
    _activeDropdownMenu = menu;
    window.addEventListener('scroll', _repositionOnScroll, { passive: true });
    window.addEventListener('resize', _repositionOnScroll, { passive: true });
  };

  const _detachDropdownPositionListeners = () => {
    window.removeEventListener('scroll', _repositionOnScroll);
    window.removeEventListener('resize', _repositionOnScroll);
    _activeDropdownTrigger = null;
    _activeDropdownMenu = null;
  };

  const closeHeaderDropdowns = (except) => {
    headerDropdowns.forEach(dropdown => {
      if (dropdown === except) return;
      const trigger = dropdown.querySelector('.kasa-dropdown-trigger');
      const menu = findMenu(dropdown);
      if (!menu) return;
      menu.classList.remove('is-open');
      trigger?.setAttribute('aria-expanded', 'false');
      clearTimeout(dropdown._kasaMenuHideTimeout);
      dropdown._kasaMenuHideTimeout = setTimeout(() => {
        menu.hidden = true;
        resetDropdownMenuPosition(menu);
      }, 120);
    });
    // Menü kapandığında scroll/resize listener'larını temizle
    _detachDropdownPositionListeners();
  };

  headerDropdowns.forEach(dropdown => {
    const trigger = dropdown.querySelector('.kasa-dropdown-trigger');
    const menu = findMenu(dropdown);
    if (!trigger || !menu) return;

    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (menu.hidden) {
        closeHeaderDropdowns(dropdown);
        clearTimeout(dropdown._kasaMenuHideTimeout);
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        _attachDropdownPositionListeners(trigger, menu);
        /* Flash'sız açılış: double-rAF ile konum hesaplanır, sonra is-open eklenir.
           İlk rAF: layout hesaplanır + konum + overflow kontrolü.
           İkinci rAF: is-open eklenir → opacity transition tetiklenir. */
        requestAnimationFrame(() => {
          positionDropdownMenu(trigger, menu);
          requestAnimationFrame(() => menu.classList.add('is-open'));
        });
      } else {
        closeHeaderDropdowns();
      }
    });

    dropdown.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    menu.addEventListener('click', (event) => {
      if (event.target.closest('.kasa-dropdown-item')) closeHeaderDropdowns();
    });
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-kasa-dropdown]') &&
        !event.target.closest('.kasa-dropdown-menu')) closeHeaderDropdowns();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const hasVisibleModal = document.querySelector('.kasa-modal.is-visible:not(.is-closing)');
    if (hasVisibleModal) return;
    const openDropdown = headerDropdowns.find(dropdown => {
      const menu = findMenu(dropdown);
      return menu && !menu.hidden;
    });
    if (openDropdown) {
      event.preventDefault();
      closeHeaderDropdowns();
      openDropdown.querySelector('.kasa-dropdown-trigger')?.focus({ preventScroll: true });
    }
  });

  // ─── 7. ŞİFRE GÜCÜ (password-strength.js) ─────────────────────────────
  initPasswordStrength({ apiJson });

  // ─── 8+8b. ŞİFRE ÜRETECİ & GEÇMİŞİ (password-generator.js) ─────────────────
  initPasswordGenerator({
    showWarningToast,
    copyToClipboard,
    createIcon,
    createIconButton,
  });

  // ─── 9. INDEX SAYFASI (vault-index.js) ───────────────────────────────────
  initVaultIndex({
    apiFetch,
    apiJson,
    apiPost,
    showToast,
    showWarningToast,
    TOAST_BASE,
    createStatusNode,
    createIcon,
    createIconButton,
    copyToClipboard,
    kasaModalAc,
    refreshStatsBar,
  });

  // ─── 10. EKLE / DÜZENLE SAYFASI (vault-form.js) ───────────────────────────
  initVaultForm();
  initFormCalendar();

  refreshStatsBar();
});
