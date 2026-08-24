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
import { initAppearanceSettings } from './appearance-settings.js';
import { initVaultIndex } from './vault-index.js';
import { initVaultForm } from './vault-form.js';
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
      window.KASA_SET_RUNTIME_STYLE?.('custom-background',
        isActive && !isVideo ? `#custom-bg-layer.is-active { background-image: url(${bgUrl}); }` : ''
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
          if (bgVideo.getAttribute('src') !== bgUrl) {
            bgVideo.setAttribute('src', bgUrl);
            bgVideo.play?.().catch(() => {});
          }
          bgVideo.classList.add('is-active');
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
    const refresh = () => {
      const dirty = snapshot() !== baseline;
      badge.hidden = !dirty;
      badge.setAttribute('aria-hidden', String(!dirty));
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

  document.querySelectorAll('[data-export-format]').forEach(exportButton => {
    exportButton.addEventListener('click', async (event) => {
      event.preventDefault();
      const exportFormat = exportButton.dataset.exportFormat || 'json';
      const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
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
    const panelExitTimers = new WeakMap();

    const activateSettingsTab = (tabName, focusTab = false) => {
      const nextTab = settingsTabs.find(tab => tab.dataset.settingsTab === tabName);
      const nextPanel = settingsPanels.find(panel => panel.dataset.settingsPanel === tabName);
      if (!nextTab || !nextPanel) return;

      // Sekme gecis tanilamasi (konsoldan __tabDiag ile okunur)
      try {
        const diag = {
          to: tabName,
          t: Math.round(performance.now()),
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          animDur: getComputedStyle(nextPanel).animationDuration
        };
        requestAnimationFrame(() => requestAnimationFrame(() => {
          try {
            const a = nextPanel.getAnimations()[0];
            diag.animAfter2f = a ? a.playState + '@' + Math.round(a.currentTime || 0) : 'none';
            diag.opAfter2f = +(+getComputedStyle(nextPanel).opacity).toFixed(2);
          } catch (_) {}
        }));
        window.__tabDiag = window.__tabDiag || [];
        window.__tabDiag.push(diag);
      } catch (_) {}

      settingsTabs.forEach(tab => {
        const isActive = tab === nextTab;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
        tab.tabIndex = isActive ? 0 : -1;
      });
      settingsPanels.forEach(panel => {
        const isActive = panel === nextPanel;
        if (!isActive && !panel.hidden && panel.classList.contains('active')) {
          panel.classList.add('is-exiting');
          panel.classList.remove('active');
          panelExitTimers.set(panel, setTimeout(() => {
            panelExitTimers.delete(panel);
            panel.hidden = true;
            panel.classList.remove('is-exiting');
          }, 180));
        } else if (isActive) {
          const pendingExit = panelExitTimers.get(panel);
          if (pendingExit) {
            clearTimeout(pendingExit);
            panelExitTimers.delete(panel);
          }
          panel.classList.remove('is-exiting');
          panel.hidden = false;
          panel.classList.add('active');
        } else {
          panel.hidden = true;
          panel.classList.remove('active');
        }
      });
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
          // Port her açılışta değiştiği için localStorage sıfırlanıyor; kalıcılık sunucuda.
          apiPost('/settings/appearance', { lan_warning_acknowledged: true });
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
        settingsFormSnapshot = getSettingsSnapshot();
        updateSettingsUnsavedBadge(settingsFormSnapshot);
        showSuccessToast(window._('Ayarlar kaydedildi.'));
        if (data.restart_required) {
          showSuccessToast(window._('Yeniden başlatılıyor...'));
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
  const supportedImportExtensions = new Set(['.json', '.kasa', '.txt']);

  const resetImportFile = () => {
    if (importFileInput) importFileInput.value = '';
    if (importFileName) importFileName.textContent = window._('Dosya seçilmedi');
    importDropZone?.classList.remove('has-file');
  };

  const useImportFile = (file) => {
    if (!file || !importFileInput) return false;
    const extensionIndex = file.name.lastIndexOf('.');
    const extension = extensionIndex >= 0 ? file.name.slice(extensionIndex).toLowerCase() : '';
    const maxBytes = Number(importDropZone?.dataset.maxBytes) || (5 * 1024 * 1024);

    if (!supportedImportExtensions.has(extension)) {
      resetImportFile();
      showWarningToast(window._('Yalnızca .kasa, .json veya .txt dosyaları içe aktarılabilir.'));
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

  const closeHeaderDropdowns = (except) => {
    headerDropdowns.forEach(dropdown => {
      if (dropdown === except) return;
      const trigger = dropdown.querySelector('.kasa-dropdown-trigger');
      const menu = dropdown.querySelector('.kasa-dropdown-menu');
      if (!menu) return;
      menu.classList.remove('is-open');
      trigger?.setAttribute('aria-expanded', 'false');
      clearTimeout(dropdown._kasaMenuHideTimeout);
      dropdown._kasaMenuHideTimeout = setTimeout(() => { menu.hidden = true; }, 120);
    });
  };

  headerDropdowns.forEach(dropdown => {
    const trigger = dropdown.querySelector('.kasa-dropdown-trigger');
    const menu = dropdown.querySelector('.kasa-dropdown-menu');
    if (!trigger || !menu) return;

    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (menu.hidden) {
        closeHeaderDropdowns(dropdown);
        clearTimeout(dropdown._kasaMenuHideTimeout);
        menu.hidden = false;
        requestAnimationFrame(() => menu.classList.add('is-open'));
        trigger.setAttribute('aria-expanded', 'true');
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
    if (!event.target.closest('[data-kasa-dropdown]')) closeHeaderDropdowns();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const hasVisibleModal = document.querySelector('.kasa-modal.is-visible:not(.is-closing)');
    if (hasVisibleModal) return;
    const openDropdown = headerDropdowns.find(dropdown => {
      const menu = dropdown.querySelector('.kasa-dropdown-menu');
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

  refreshStatsBar();
});
