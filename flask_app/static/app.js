/**
 * ŞifreKasam v2.5.2 - Main JavaScript
 */

document.addEventListener('DOMContentLoaded', () => {

  // ─── SABİTLER & YARDIMCILAR ───────────────────────────────────────────────

  const glassEffectsEnabled = () =>
    document.documentElement.getAttribute('data-glass-effects') !== 'off';

  const scriptLoadCache = new Map();

  const loadScriptOnce = (src) => {
    if (!src) return Promise.reject(new Error('missing-script-src'));
    if (scriptLoadCache.has(src)) return scriptLoadCache.get(src);

    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing?.dataset.loaded === 'true') return Promise.resolve(existing);

    const promise = new Promise((resolve, reject) => {
      const script = existing || document.createElement('script');
      script.src = src;
      script.async = true;
      script.defer = true;
      script.onload = () => {
        script.dataset.loaded = 'true';
        resolve(script);
      };
      script.onerror = () => reject(new Error(`script-load-failed:${src}`));
      if (!existing) document.head.appendChild(script);
    });

    scriptLoadCache.set(src, promise);
    promise.catch(() => scriptLoadCache.delete(src));
    return promise;
  };

  const ensureZxcvbn = async () => {
    if (typeof zxcvbn !== 'undefined') return true;
    try {
      await loadScriptOnce(window.KASA_STATIC_URLS?.zxcvbn || '/static/zxcvbn.js');
      return typeof zxcvbn !== 'undefined';
    } catch (err) {
      console.error('zxcvbn load failed:', err);
      return false;
    }
  };

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
    try {
      const response = await fetch(path, {
        ...opts,
        credentials: 'same-origin',
        headers: { ...opts.headers },
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
    anchor.style.display = 'none';
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

  const createStatusNode = (message, className = 'p-3 text-center text-body-secondary', iconClass = '') => {
    const wrapper = document.createElement('div');
    wrapper.className = className;
    if (iconClass) {
      wrapper.append(createIcon(iconClass), ' ');
    }
    wrapper.append(document.createTextNode(message));
    return wrapper;
  };

  const normalizeHexColor = (value, fallback = '#7c6ff7') => {
    const raw = String(value || '').trim();
    const hex = raw.startsWith('#') ? raw : `#${raw}`;
    return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : fallback;
  };

  const hexToRgb = (hex) => {
    const clean = normalizeHexColor(hex).slice(1);
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ].join(', ');
  };

  const hexToChannels = (hex) =>
    hexToRgb(hex).split(',').map(channel => Number(channel.trim()));

  const accentLooksTooLight = (hex) => {
    const [red, green, blue] = hexToChannels(hex);
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    const nearWhite = red >= 235 && green >= 235 && blue >= 235;
    return nearWhite || luminance >= 0.9;
  };

  const mixColor = (hex, targetHex = '#38bdf8', amount = 0.45) => {
    const first = normalizeHexColor(hex).slice(1);
    const second = normalizeHexColor(targetHex, '#38bdf8').slice(1);
    const channel = (start, end) =>
      Math.round(start + (end - start) * amount).toString(16).padStart(2, '0');
    return `#${channel(parseInt(first.slice(0, 2), 16), parseInt(second.slice(0, 2), 16))}`
      + `${channel(parseInt(first.slice(2, 4), 16), parseInt(second.slice(2, 4), 16))}`
      + `${channel(parseInt(first.slice(4, 6), 16), parseInt(second.slice(4, 6), 16))}`;
  };

  const applyAppearance = (accent, background) => {
    const normalizedAccent = normalizeHexColor(accent);
    const normalizedBackground = ['aurora', 'midnight', 'mesh', 'plain'].includes(background)
      ? background
      : 'aurora';
    const accent2 = mixColor(normalizedAccent);
    document.documentElement.style.setProperty('--accent', normalizedAccent);
    document.documentElement.style.setProperty('--accent-2', accent2);
    document.documentElement.style.setProperty('--accent-rgb', hexToRgb(normalizedAccent));
    document.documentElement.style.setProperty('--accent-2-rgb', hexToRgb(accent2));
    document.documentElement.setAttribute('data-kasa-background', normalizedBackground);
    localStorage.setItem('kasa-accent', normalizedAccent);
    localStorage.setItem('kasa-background', normalizedBackground);
    window.KASA_APPEARANCE = { accent: normalizedAccent, background: normalizedBackground };
    return window.KASA_APPEARANCE;
  };

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

  // ─── 1. HEARTBEAT ─────────────────────────────────────────────────────────

  const HEARTBEAT_ACTIVE_INTERVAL_MS = 15000;
  const HEARTBEAT_LOW_POWER_INTERVAL_MS = 60000;
  const RENDERER_IDLE_LOW_POWER_MS = 45000;
  const IDLE_ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'input'];
  let rendererLowPower = null;
  let systemLowPower = document.hidden;
  let idleLowPower = false;
  let heartbeatTimer = null;
  let idleLowPowerTimer = null;

  const stopIdleLowPowerTimer = () => {
    if (!idleLowPowerTimer) return;
    clearTimeout(idleLowPowerTimer);
    idleLowPowerTimer = null;
  };

  const applyRendererLowPower = () => {
    const nextState = systemLowPower || idleLowPower;
    if (rendererLowPower === nextState) return;
    rendererLowPower = nextState;
    document.documentElement.setAttribute('data-kasa-low-power', nextState ? 'on' : 'off');
    window.dispatchEvent(new CustomEvent('kasa:low-power-changed', {
      detail: { enabled: nextState },
    }));
  };

  const scheduleIdleLowPower = () => {
    stopIdleLowPowerTimer();
    if (systemLowPower || document.hidden) return;
    idleLowPowerTimer = window.setTimeout(() => {
      idleLowPower = true;
      applyRendererLowPower();
    }, RENDERER_IDLE_LOW_POWER_MS);
  };

  const resetIdleLowPower = () => {
    if (systemLowPower || document.hidden) return;
    idleLowPower = false;
    applyRendererLowPower();
    scheduleIdleLowPower();
  };

  const setRendererLowPower = (enabled) => {
    systemLowPower = Boolean(enabled);
    if (systemLowPower) {
      stopIdleLowPowerTimer();
    } else {
      idleLowPower = false;
      scheduleIdleLowPower();
    }
    applyRendererLowPower();
  };

  const sendHeartbeat = () => apiFetch('/heartbeat', { method: 'POST' });

  const stopHeartbeat = () => {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  const scheduleHeartbeat = () => {
    stopHeartbeat();
    heartbeatTimer = window.setInterval(
      sendHeartbeat,
      rendererLowPower ? HEARTBEAT_LOW_POWER_INTERVAL_MS : HEARTBEAT_ACTIVE_INTERVAL_MS
    );
  };

  window.KASA_SET_LOW_POWER = setRendererLowPower;
  setRendererLowPower(document.hidden);
  sendHeartbeat();
  scheduleHeartbeat();

  document.addEventListener('visibilitychange', () => setRendererLowPower(document.hidden));
  IDLE_ACTIVITY_EVENTS.forEach((eventName) => {
    window.addEventListener(eventName, resetIdleLowPower, { passive: true });
  });
  window.addEventListener('kasa:low-power-changed', scheduleHeartbeat);
  window.addEventListener('pagehide', () => {
    stopHeartbeat();
    stopIdleLowPowerTimer();
    IDLE_ACTIVITY_EVENTS.forEach((eventName) => {
      window.removeEventListener(eventName, resetIdleLowPower);
    });
    window.removeEventListener('kasa:low-power-changed', scheduleHeartbeat);
  }, { once: true });

  // ─── 2. SAYFA GEÇİŞ OVERLAY ───────────────────────────────────────────────

  document.querySelectorAll('[data-loading-form]').forEach(form => {
    form.addEventListener('submit', () => {
      setPageLoading(true);
      form.querySelectorAll('button, input, select, textarea')
          .forEach(el => el.setAttribute('aria-disabled', 'true'));
    });
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

  // ─── 3. TEMA & EFEKT TOGGLE'LARI ──────────────────────────────────────────

  const themeToggleBtn = document.getElementById('theme-toggle');
  if (themeToggleBtn) {
    const currentTheme = document.documentElement.getAttribute('data-bs-theme') || 'dark';
    if (themeToggleBtn.type === 'checkbox') themeToggleBtn.checked = currentTheme === 'dark';

    const applyTheme = (theme) => {
      document.documentElement.setAttribute('data-bs-theme', theme);
      document.documentElement.classList.toggle('dark', theme === 'dark');
      if (themeToggleBtn.type === 'checkbox') themeToggleBtn.checked = theme === 'dark';
      localStorage.setItem('kasa-theme', theme);
      apiPost('/settings/theme', { theme });
    };

    themeToggleBtn.addEventListener(
      themeToggleBtn.type === 'checkbox' ? 'change' : 'click',
      () => applyTheme(
        document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark'
      )
    );
  }

  const glassToggle = document.getElementById('glass-effects-toggle');
  const glassQualityCard = document.getElementById('glass-quality-card');
  const glassQualitySelect = document.getElementById('glass-quality-select');
  let glassQualityAnimationTimer = null;

  const clearGlassQualityInlineStyles = () => {
    if (!glassQualityCard) return;
    glassQualityCard.style.maxHeight = '';
    glassQualityCard.style.opacity = '';
    glassQualityCard.style.transform = '';
  };

  const syncGlassQualityVisibility = (enabled, animate = true) => {
    if (!glassQualityCard) return;
    const shouldShow = Boolean(enabled);
    clearTimeout(glassQualityAnimationTimer);
    glassQualityCard.setAttribute('aria-hidden', String(!shouldShow));
    if (glassQualitySelect) {
      glassQualitySelect.disabled = !shouldShow;
      glassQualitySelect.tabIndex = shouldShow ? 0 : -1;
    }

    if (shouldShow) {
      glassQualityCard.hidden = false;
      glassQualityCard.classList.remove('is-leaving');
      if (!animate) {
        glassQualityCard.classList.remove('is-entering');
        clearGlassQualityInlineStyles();
        return;
      }
      glassQualityCard.classList.add('is-entering');
      glassQualityCard.style.maxHeight = '0px';
      glassQualityCard.style.opacity = '0';
      glassQualityCard.style.transform = 'translateY(-8px) scaleY(0.97)';
      requestAnimationFrame(() => {
        glassQualityCard.style.maxHeight = `${glassQualityCard.scrollHeight}px`;
        glassQualityCard.style.opacity = '1';
        glassQualityCard.style.transform = 'translateY(0) scaleY(1)';
      });
      glassQualityAnimationTimer = setTimeout(() => {
        glassQualityCard.classList.remove('is-entering');
        clearGlassQualityInlineStyles();
      }, 280);
      return;
    }

    glassQualityCard.classList.remove('is-entering');
    if (!animate || glassQualityCard.hidden) {
      glassQualityCard.hidden = true;
      glassQualityCard.classList.remove('is-leaving');
      return;
    }

    glassQualityCard.style.maxHeight = `${glassQualityCard.scrollHeight}px`;
    glassQualityCard.style.opacity = '1';
    glassQualityCard.style.transform = 'translateY(0) scaleY(1)';
    glassQualityCard.classList.add('is-leaving');
    requestAnimationFrame(() => {
      glassQualityCard.style.maxHeight = '0px';
      glassQualityCard.style.opacity = '0';
      glassQualityCard.style.transform = 'translateY(-8px) scaleY(0.97)';
    });
    glassQualityAnimationTimer = setTimeout(() => {
      glassQualityCard.hidden = true;
      glassQualityCard.classList.remove('is-leaving');
      clearGlassQualityInlineStyles();
    }, 260);
  };

  if (glassToggle) {
    glassToggle.checked =
      document.documentElement.getAttribute('data-glass-effects') !== 'off';
    syncGlassQualityVisibility(glassToggle.checked, false);

    glassToggle.addEventListener('change', () => {
      const value = glassToggle.checked ? 'on' : 'off';
      document.documentElement.setAttribute('data-glass-effects', value);
      localStorage.setItem('kasa-glass-effects', value);
      syncGlassQualityVisibility(glassToggle.checked);
      apiPost('/settings/glass-effects', { enabled: glassToggle.checked });
    });
  }

  const motionToggle = document.getElementById('animated-backgrounds-toggle');
  const gradientsToggle = document.getElementById('gradients-toggle');

  const setupThemeFeatureToggle = (toggle, attribute, storageKey, apiKey) => {
    if (!toggle) return;
    toggle.checked = themeFeatureEnabled(attribute);
    toggle.addEventListener('change', () => {
      applyThemeFeature(attribute, storageKey, toggle.checked);
      apiPost('/settings/appearance', { [apiKey]: toggle.checked });
    });
  };

  setupThemeFeatureToggle(
    motionToggle,
    'data-kasa-motion',
    'kasa-animated-backgrounds',
    'animated_backgrounds_enabled'
  );
  setupThemeFeatureToggle(
    gradientsToggle,
    'data-kasa-gradient',
    'kasa-gradients',
    'gradients_enabled'
  );

  const accentInput = document.getElementById('accent-color-input');
  const accentTextInput = document.getElementById('accent-color-text');
  const backgroundSelect = document.getElementById('background-style-select');
  const backgroundHidden = document.getElementById('background-style-hidden');
  const accentHidden = document.getElementById('accent-color-hidden');
  const appearancePreview = document.getElementById('appearance-preview');
  const backgroundButtons = document.querySelectorAll('[data-background-option]');
  const accentPresetButtons = document.querySelectorAll('[data-accent-preset]');
  const currentAppearance = window.KASA_APPEARANCE || {
    accent: localStorage.getItem('kasa-accent') || '#7c6ff7',
    background: localStorage.getItem('kasa-background') || 'aurora',
  };
  let appearanceSaveTimer = 0;
  let accentContrastWarningTimer = 0;
  let lightAccentWarningShown = false;

  if (glassQualitySelect) {
    glassQualitySelect.value = normalizeGlassQuality(
      document.documentElement.getAttribute('data-glass-quality')
    );
    glassQualitySelect.addEventListener('change', () => {
      const glassQuality = applyGlassQuality(glassQualitySelect.value);
      glassQualitySelect.value = glassQuality;
      apiPost('/settings/appearance', { glass_quality: glassQuality });
    });
  }

  const queueAccentContrastWarning = (accent) => {
    const normalizedAccent = normalizeHexColor(accent);
    clearTimeout(accentContrastWarningTimer);

    if (!accentLooksTooLight(normalizedAccent)) {
      lightAccentWarningShown = false;
      return;
    }

    accentContrastWarningTimer = setTimeout(() => {
      if (lightAccentWarningShown) return;
      lightAccentWarningShown = true;
      showWarningToast(window._('Bu renk yazıları veya simgeleri okunmaz yapabilir.'));
    }, 320);
  };

  const syncAppearanceControls = (accent, background) => {
    if (accentInput) accentInput.value = normalizeHexColor(accent);
    if (accentTextInput) accentTextInput.value = normalizeHexColor(accent);
    if (accentHidden) accentHidden.value = normalizeHexColor(accent);
    if (backgroundSelect) backgroundSelect.value = background;
    if (backgroundHidden) backgroundHidden.value = background;
    if (appearancePreview) {
      appearancePreview.style.setProperty('--preview-accent', normalizeHexColor(accent));
      appearancePreview.dataset.previewBackground = background;
    }
    backgroundButtons.forEach(btn => {
      const isActive = btn.dataset.backgroundOption === background;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
    });
    accentPresetButtons.forEach(btn => {
      const isActive = normalizeHexColor(btn.dataset.accentPreset) === normalizeHexColor(accent);
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
    });
  };

  const updateAppearance = (accent, background, persist = true) => {
    const next = applyAppearance(accent, background);
    syncAppearanceControls(next.accent, next.background);
    queueAccentContrastWarning(next.accent);
    if (persist) {
      clearTimeout(appearanceSaveTimer);
      appearanceSaveTimer = setTimeout(() => {
        apiPost('/settings/appearance', {
          accent_color: next.accent,
          background_style: next.background,
          animated_backgrounds_enabled: motionToggle?.checked ?? themeFeatureEnabled('data-kasa-motion'),
          gradients_enabled: gradientsToggle?.checked ?? themeFeatureEnabled('data-kasa-gradient'),
        });
      }, 250);
    }
  };

  if (accentInput || accentTextInput || backgroundSelect) {
    syncAppearanceControls(currentAppearance.accent, currentAppearance.background);

    accentInput?.addEventListener('input', () =>
      updateAppearance(accentInput.value, backgroundSelect?.value || currentAppearance.background)
    );
    accentTextInput?.addEventListener('change', () =>
      updateAppearance(accentTextInput.value, backgroundSelect?.value || currentAppearance.background)
    );
    backgroundSelect?.addEventListener('change', () =>
      updateAppearance(accentInput?.value || currentAppearance.accent, backgroundSelect.value)
    );

    accentPresetButtons.forEach(btn => {
      btn.addEventListener('click', () =>
        updateAppearance(btn.dataset.accentPreset, backgroundSelect?.value || currentAppearance.background)
      );
    });
    backgroundButtons.forEach(btn => {
      btn.addEventListener('click', () =>
        updateAppearance(accentInput?.value || currentAppearance.accent, btn.dataset.backgroundOption)
      );
    });
  }

  // ─── 3b. LAN ERİŞİMİ ─────────────────────────────────────────────────────

  const lanToggle = document.getElementById('lan-enabled-toggle');
  const lanInfoBox = document.getElementById('lan-info-box');
  const lanAddress = document.getElementById('lan-address');

  async function fetchLanInfo() {
    if (!lanAddress) return;
    lanAddress.textContent = window._('Yükleniyor...');
    try {
      const data = await apiJson('/api/lan-info');
      if (Array.isArray(data.ips) && data.ips.length > 0) {
        lanAddress.textContent = `${data.ssl ? 'https://' : 'http://'}${data.ips[0]}:${data.port}`;
        return;
      }
      lanAddress.textContent = window._('Ağ bağlantısı bulunamadı');
    } catch {
      lanAddress.textContent = window._('Bilgi alınamadı');
    }
  }

  if (lanToggle && lanInfoBox) {
    lanToggle.addEventListener('change', function () {
      if (lanToggle.checked) {
        lanInfoBox.classList.remove('hidden');
        fetchLanInfo();
      } else {
        lanInfoBox.classList.add('hidden');
      }
    });

    if (lanToggle.checked) {
      fetchLanInfo();
    }
  }

  // ─── 4. TOAST & PANO ──────────────────────────────────────────────────────

  let lastToast = null;
  const showToast = (opts) => {
    lastToast?.hideToast();
    lastToast = Toastify(opts);
    lastToast.showToast();
  };

  const TOAST_BASE = {
    duration: 2000, close: false,
    gravity: 'bottom', position: 'right', stopOnFocus: true,
    style: {
      borderRadius: '8px',
      fontFamily: "'Sora', sans-serif",
      fontWeight: '500',
    },
  };

  const showSuccessToast = (text) => showToast({
    ...TOAST_BASE, text,
    style: {
      ...TOAST_BASE.style,
      background: 'linear-gradient(to right, var(--success), #10b981)',
    },
  });

  const showWarningToast = (text) => showToast({
    ...TOAST_BASE, text,
    style: {
      ...TOAST_BASE.style,
      background:  'rgba(239, 68, 68, 0.14)',
      border:      '1px solid rgba(239, 68, 68, 0.28)',
      color:       '#fecaca',
    },
  });

  window.addEventListener('kasa:vault-write-locked', (event) => {
    showWarningToast(
      event.detail?.message || window._('Ana \u015fifre de\u011fi\u015ftiriliyor, i\u015flem bitince tekrar deneyin.')
    );
  });

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
      } catch (err) {
        console.error('Export failed:', err);
        showWarningToast(window._('Dışa aktarma başarısız oldu.'));
      } finally {
        exportButton.disabled = false;
      }
    });
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
      clearTimeout(appearanceSaveTimer);

      try {
        const data = await apiJson(settingsForm.action, {
          method: 'POST',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          body: new FormData(settingsForm),
        });
        if (data.accent_color || data.background_style) {
          updateAppearance(
            data.accent_color || accentInput?.value,
            data.background_style || backgroundSelect?.value,
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
        }
        if (typeof data.animated_backgrounds_enabled === 'boolean' && motionToggle) {
          motionToggle.checked = data.animated_backgrounds_enabled;
          applyThemeFeature('data-kasa-motion', 'kasa-animated-backgrounds', data.animated_backgrounds_enabled);
        }
        if (typeof data.gradients_enabled === 'boolean' && gradientsToggle) {
          gradientsToggle.checked = data.gradients_enabled;
          applyThemeFeature('data-kasa-gradient', 'kasa-gradients', data.gradients_enabled);
        }
        if (typeof data.lan_enabled === 'boolean' && lanToggle && lanInfoBox) {
          lanToggle.checked = data.lan_enabled;
          lanInfoBox.classList.toggle('hidden', !data.lan_enabled);
          if (data.lan_enabled) setTimeout(fetchLanInfo, 1200);
        }
        settingsFormSnapshot = getSettingsSnapshot();
        showSuccessToast(window._('Ayarlar kaydedildi.'));
      } catch {
        showWarningToast(window._('Ayarlar kaydedilemedi.'));
      } finally {
        setPageLoading(false);
        submitButton?.removeAttribute('aria-disabled');
        if (submitButton) submitButton.disabled = false;
      }
    });
  }

  const copyButtonStates = new WeakMap();
  const COPY_ICON_RESET_MS = 850;

  const getCopyButton = (iconEl) => iconEl?.closest?.('button') || iconEl;

  const getCopyIconSizeClasses = (iconEl) => Array.from(iconEl?.classList || [])
    .filter(className => (
      className !== 'text-success'
      && (className.startsWith('text-') || /^fa-(xs|sm|lg|xl|2x)$/.test(className))
    ));

  const buildCopyIconHtml = (iconEl) => {
    const classes = Array.from(iconEl?.classList || [])
      .map(className => className === 'fa-check' ? 'fa-copy' : className)
      .filter(className => !['copy-flash', 'text-success'].includes(className));

    if (!classes.includes('fa-copy')) classes.push('fa-copy');
    if (!classes.includes('fa-solid') && !classes.includes('fa-regular')) {
      classes.unshift('fa-solid');
    }

    const originalIcon = document.createElement('i');
    originalIcon.className = [...new Set(classes)].join(' ') || 'fa-solid fa-copy';
    return originalIcon.outerHTML;
  };

  const getCopyButtonOriginalHtml = (button, iconEl, currentState) => {
    if (button.dataset.copyOriginalHtml) return button.dataset.copyOriginalHtml;
    if (currentState?.originalHtml) return currentState.originalHtml;

    const iconIsFlashing = iconEl?.classList?.contains('fa-check')
      || iconEl?.classList?.contains('copy-flash')
      || iconEl?.classList?.contains('text-success');
    const originalHtml = iconIsFlashing ? buildCopyIconHtml(iconEl) : button.innerHTML;
    button.dataset.copyOriginalHtml = originalHtml;
    return originalHtml;
  };

  const resetCopyButtonIcon = (button, originalHtml) => {
    if (!button?.isConnected) return;
    button.innerHTML = originalHtml || button.dataset.copyOriginalHtml || '<i class="fa-solid fa-copy"></i>';
    delete button.dataset.copyResetAt;
    copyButtonStates.delete(button);
  };

  const resetStuckCopyButtons = () => {
    const now = Date.now();
    document.querySelectorAll('button[data-copy-original-html]').forEach((button) => {
      const resetAt = Number(button.dataset.copyResetAt || 0);
      if (resetAt && now >= resetAt && button.querySelector('i.fa-check')) {
        resetCopyButtonIcon(button);
      }
    });
  };

  const flashCopyIcon = (iconEl) => {
    const button = getCopyButton(iconEl);
    if (!button) return;

    const currentState = copyButtonStates.get(button);
    const originalHtml = getCopyButtonOriginalHtml(button, iconEl, currentState);
    clearTimeout(currentState?.timer);

    const checkIcon = document.createElement('i');
    checkIcon.className = ['fa-solid', 'fa-check', 'text-success', 'copy-flash', ...getCopyIconSizeClasses(iconEl)]
      .filter(Boolean)
      .join(' ');
    button.replaceChildren(checkIcon);

    button.dataset.copyResetAt = String(Date.now() + COPY_ICON_RESET_MS + 250);
    const timer = setTimeout(() => resetCopyButtonIcon(button, originalHtml), COPY_ICON_RESET_MS);
    setTimeout(resetStuckCopyButtons, COPY_ICON_RESET_MS + 500);
    copyButtonStates.set(button, { originalHtml, timer });

    try {
      showSuccessToast(window._('Kopyaland\u0131!'));
    } catch (err) {
      console.warn('Copy toast failed:', err);
    }
  };

  const copyToClipboard = async (text, iconEl) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = Object.assign(document.createElement('textarea'), {
          value: text,
          readOnly: true,
        });
        textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      flashCopyIcon(iconEl);
    } catch (err) {
      console.error('Copy failed:', err);
      showWarningToast(window._('Kopyalama başarısız oldu.'));
    }
  };

  // ─── 5. ŞİFRE GÖSTER / KOPYAla BUTONLARI ─────────────────────────────────

  const fetchRowPassword = async (row) => {
    const field = row?.querySelector('.password-field');
    const recordId = field?.dataset.id;
    if (!recordId) return '';
    try {
      const data = await apiJson(`/api/record/${encodeURIComponent(recordId)}/password`);
      return data.password || '';
    } catch {
      return '';
    }
  };

  document.querySelectorAll('.copy-password').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const text = await fetchRowPassword(btn.closest('.password-row'));
      if (text) copyToClipboard(text, btn.querySelector('i'));
    });
  });

  document.querySelectorAll('.copy-username').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      copyToClipboard(btn.dataset.username, btn.querySelector('i'));
    });
  });

  document.querySelectorAll('.toggle-password').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const field = btn.closest('.password-row')?.querySelector('.password-field');
      const icon  = btn.querySelector('i');
      if (!field) return;
      const hidden = field.dataset.visible !== 'true';
      const password = hidden ? await fetchRowPassword(btn.closest('.password-row')) : '';
      if (hidden && !password) return;
      field.textContent = hidden ? password : '••••••••';
      field.dataset.visible = hidden ? 'true' : 'false';
      icon.className    = hidden ? 'fa-solid fa-eye-slash text-warning' : 'fa-solid fa-eye';
    });
  });
  // ─── 6. MODAL SİSTEMİ ─────────────────────────────────────────────────────

  window.kasaModalAc = (modalId) => {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    document.body.style.overflow = 'hidden';
    modal.classList.remove('is-closing', 'is-open');
    modal.classList.add('is-visible');
    modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => modal.classList.add('is-open'));
  };

  window.kasaModalKapat = (modalId) => {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.remove('is-open');
    modal.classList.add('is-closing');
    setTimeout(() => {
      modal.classList.remove('is-visible', 'is-closing');
      modal.setAttribute('aria-hidden', 'true');
      if (!document.querySelector('.kasa-modal.is-visible'))
        document.body.style.overflow = '';
    }, 180);
  };

  document.querySelectorAll('.kasa-modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) kasaModalKapat(modal.id);
    });
  });

  document.querySelectorAll('[data-kasa-close]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const modal = btn.closest('.kasa-modal');
      if (modal) kasaModalKapat(modal.id);
    });
  });

  document.querySelectorAll('[data-kasa-modal]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      kasaModalAc(btn.dataset.kasaModal);
    });
  });

  // ─── 7. ŞİFRE GÜCÜ ───────────────────────────────────────────────────────

  const TIME_REPLACEMENTS = [
    [/less than\s+/gi,    ''],
    [/about\s+/gi,        'yaklaşık '],
    [/almost\s+/gi,       'neredeyse '],
    [/centuries?/gi,      'yüzyıl'],
    [/years?/gi,          'yıl'],
    [/months?/gi,         'ay'],
    [/weeks?/gi,          'hafta'],
    [/days?/gi,           'gün'],
    [/hours?/gi,          'saat'],
    [/minutes?/gi,        'dakika'],
    [/seconds?/gi,        'saniye'],
    [/instant(?:ly)?/gi,  'anında'],
    [/forever/gi,         'çok uzun süre'],
  ];

  const translateTime = (str) =>
    TIME_REPLACEMENTS
      .reduce((t, [p, r]) => t.replace(p, r), String(str || ''))
      .replace(/(\d)([A-Za-zğüşıöçĞÜŞİÖÇ])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();

  const STRENGTH_LEVELS = [
    { width: '20%',  color: '#ef4444', text: 'Çok Zayıf' },
    { width: '40%',  color: '#ef4444', text: 'Zayıf'     },
    { width: '60%',  color: '#f59e0b', text: 'Orta'      },
    { width: '80%',  color: '#22c55e', text: 'Güçlü'     },
    { width: '100%', color: '#38bdf8', text: 'Çok Güçlü' },
  ];

  window.updateStrengthMeter = async (password, barEl, labelEl) => {
    if (!barEl || !labelEl) return;
    if (!password) {
      barEl.style.width = '0%';
      barEl.style.backgroundColor = 'transparent';
      labelEl.innerText = '';
      return;
    }
    if (typeof zxcvbn === 'undefined') {
      labelEl.innerText = window._('Analiz hazırlanıyor…');
      const loaded = await ensureZxcvbn();
      if (!loaded) {
        labelEl.innerText = window._('Analiz kullanılamıyor');
        return;
      }
    }
    const { score, crack_times_display } = zxcvbn(password);
    const level     = STRENGTH_LEVELS[score];
    const crackTime = translateTime(crack_times_display.offline_slow_hashing_1e4_per_second);

    barEl.style.width           = level.width;
    barEl.style.backgroundColor = level.color;
    labelEl.innerText = crackTime
      ? `${level.text} · ${window._('tahmini dayanım:')} ${crackTime}`
      : level.text;
  };

  const pagePassword  = document.getElementById('page-password');
  const strengthBar   = document.getElementById('password-strength-bar');
  const strengthText  = document.getElementById('password-strength-text');
  if (pagePassword && strengthBar && strengthText) {
    pagePassword.addEventListener('input', () =>
      void window.updateStrengthMeter(pagePassword.value, strengthBar, strengthText));
    void window.updateStrengthMeter(pagePassword.value, strengthBar, strengthText);
  }

  // ─── 8. ŞİFRE ÜRETECİ ────────────────────────────────────────────────────

  const CHAR_SETS = {
    upper:   'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    lower:   'abcdefghijklmnopqrstuvwxyz',
    numbers: '0123456789',
    symbols: '!@#$%^&*()_+-=[]{}|;:,.<>?',
  };

  const secureRandomInt = (max) => {
    if (!Number.isFinite(max) || max <= 0) return 0;
    const cryptoApi = window.crypto || window.msCrypto;
    if (!cryptoApi?.getRandomValues) {
      throw new Error('Secure random API unavailable');
    }
    const array = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / max) * max;
    do {
      cryptoApi.getRandomValues(array);
    } while (array[0] >= limit);
    return array[0] % max;
  };

  const pickSecureChar = (charset) => charset[secureRandomInt(charset.length)];

  const secureShuffle = (items) => {
    for (let index = items.length - 1; index > 0; index--) {
      const swapIndex = secureRandomInt(index + 1);
      [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
    }
    return items;
  };

  function setupPasswordGenerator(containerId, prefixId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const $  = (id) => document.getElementById(`${prefixId}${id}`);
    const lengthEl      = $('length');
    const lengthDisplay = $('length-display');
    const generateBtn   = $('gen-now');
    const checkboxMap   = {
      upper:   $('include-uppercase'),
      lower:   $('include-lowercase'),
      numbers: $('include-numbers'),
      symbols: $('include-symbols'),
    };
    const targetInputId = container.dataset.targetInput || 'page-password';
    let generatedAnimationTimer = null;

    if (lengthEl && lengthDisplay) {
      lengthEl.addEventListener('input', () => {
        lengthDisplay.textContent = lengthEl.value;
      });
    }

    const generatePassword = () => {
      const length = parseInt(lengthEl?.value || '16');
      const selectedSets = Object.entries(checkboxMap)
        .filter(([, el]) => el?.checked ?? true)
        .map(([key]) => CHAR_SETS[key])
        .filter(Boolean);
      const safeSets = selectedSets.length ? selectedSets : [CHAR_SETS.lower, CHAR_SETS.numbers];
      const charset = safeSets.join('');
      const passwordChars = safeSets.map(pickSecureChar);

      while (passwordChars.length < length) {
        passwordChars.push(pickSecureChar(charset));
      }

      const password = secureShuffle(passwordChars).slice(0, length).join('');

      const targetInput = document.getElementById(targetInputId);
      if (targetInput) {
        targetInput.value = password;
        targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        targetInput.classList.add('shake');
        setTimeout(() => targetInput.classList.remove('shake'), 400);
      }

      const modalBar   = $('strength-bar');
      const modalLabel = $('strength-label');
      if (modalBar && modalLabel && typeof window.updateStrengthMeter === 'function')
        void window.updateStrengthMeter(password, modalBar, modalLabel);

      if (typeof addToGeneratorHistory === 'function') addToGeneratorHistory(password);
      if (containerId !== 'pageGenerator') {
        clearTimeout(generatedAnimationTimer);
        container.classList.remove('generator-generated');
        void container.offsetWidth;
        container.classList.add('generator-generated');
        generatedAnimationTimer = setTimeout(() => {
          container.classList.remove('generator-generated');
        }, 520);
      }
    };

    generateBtn?.addEventListener('click', () => {
      try {
        generatePassword();
      } catch (err) {
        console.error('Password generation failed:', err);
        showWarningToast(window._('Güvenli rastgele üretici kullanılamıyor.'));
      }
    });

    // En az 1 checkbox seçili kalmalı
    const allCheckboxes = Object.values(checkboxMap).filter(Boolean);
    allCheckboxes.forEach(cb => {
      cb.addEventListener('change', () => {
        if (!cb.checked && !allCheckboxes.some(c => c.checked)) {
          cb.checked = true;
          cb.classList.add('shake');
          setTimeout(() => cb.classList.remove('shake'), 300);
          showWarningToast(window._('En az bir karakter tipi seçilmelidir!'));
        }
      });
    });

    return generatePassword;
  }

  // ─── 8b. ÜRETİCİ GEÇMİŞİ ────────────────────────────────────────────────

  const GENERATOR_HISTORY_KEY = 'kasa-generator-history';
  const MAX_HISTORY = 50;

  const getGeneratorHistory = () => {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(GENERATOR_HISTORY_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(item => item && typeof item.password === 'string')
        .map(item => ({
          password: item.password,
          date: item.date || new Date().toISOString(),
          length: Number.isFinite(Number(item.length)) ? Number(item.length) : item.password.length,
        }));
    } catch { return []; }
  };

  const saveGeneratorHistory = (history) => {
    try {
      sessionStorage.setItem(GENERATOR_HISTORY_KEY, JSON.stringify(history));
    } catch (e) { console.error('Geçmiş kaydedilemedi:', e); }
  };

  const addToGeneratorHistory = (password) => {
    const history = getGeneratorHistory();
    history.unshift({
      password,
      date: new Date().toISOString(),
      length: password.length,
    });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    saveGeneratorHistory(history);
    renderGeneratorHistory();
  };

  const renderGeneratorHistory = () => {
    const list = document.getElementById('generator-history-list');
    const empty = document.getElementById('generator-history-empty');
    const clearBtn = document.getElementById('generator-history-clear');
    if (!list) return;

    const history = getGeneratorHistory();

    if (empty) empty.style.display = history.length ? 'none' : 'block';
    if (clearBtn) clearBtn.style.display = history.length ? 'inline-flex' : 'none';

    list.replaceChildren();
    history.forEach((item, index) => {
      const dateStr = new Date(item.date).toLocaleString('tr-TR', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });

      const div = document.createElement('div');
      div.className = 'gen-history-item';

      const info = document.createElement('div');
      info.className = 'gen-history-info';

      const pwRow = document.createElement('div');
      pwRow.className = 'gen-history-pw-row';

      const pwInput = Object.assign(document.createElement('input'), {
        type: 'password', readOnly: true, className: 'gen-history-pw',
        value: item.password,
      });

      const showBtn = createIconButton(
        window._('Göster/Gizle'),
        'fa-solid fa-eye',
        'gen-history-icon-btn'
      );
      showBtn.addEventListener('click', () => {
        const hidden = pwInput.type === 'password';
        pwInput.type = hidden ? 'text' : 'password';
        showBtn.querySelector('i').className = hidden ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
      });

      const copyBtn = createIconButton(
        window._('Kopyala'),
        'fa-solid fa-copy',
        'gen-history-icon-btn'
      );
      copyBtn.addEventListener('click', () => copyToClipboard(item.password, copyBtn.querySelector('i')));

      const delBtn = createIconButton(
        window._('Sil'),
        'fa-solid fa-trash-can',
        'gen-history-icon-btn gen-history-del-btn'
      );
      delBtn.addEventListener('click', () => {
        const history = getGeneratorHistory();
        history.splice(index, 1);
        saveGeneratorHistory(history);
        renderGeneratorHistory();
      });

      pwRow.append(pwInput, showBtn, copyBtn, delBtn);
      info.appendChild(pwRow);

      const meta = document.createElement('div');
      meta.className = 'gen-history-meta';
      const dateMeta = document.createElement('span');
      dateMeta.append(createIcon('fa-regular fa-clock'), ` ${dateStr}`);
      const lengthMeta = document.createElement('span');
      lengthMeta.textContent = `${item.length} ${window._('karakter')}`;
      meta.append(dateMeta, lengthMeta);

      div.append(info, meta);
      list.appendChild(div);
    });
  };

  const clearGeneratorHistory = () => {
    saveGeneratorHistory([]);
    renderGeneratorHistory();
  };

  document.getElementById('generator-history-clear')?.addEventListener('click', clearGeneratorHistory);
  document.querySelector('.gen-history-toggle')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    const card = button.closest('.generator-history-card');
    const collapsed = card?.classList.toggle('gen-history-collapsed') ?? false;
    button.setAttribute('aria-expanded', String(!collapsed));
  });

  const modalGeneratePassword = setupPasswordGenerator('passwordGeneratorModal', 'modal-');
  setupPasswordGenerator('pageGenerator', 'page-');

  document.querySelector('[data-kasa-modal="passwordGeneratorModal"]')?.addEventListener('click', () => {
    setTimeout(() => {
      const output = document.getElementById('modal-generated-password-display');
      if (!output?.value) {
        try {
          modalGeneratePassword?.();
        } catch (err) {
          console.error('Password generation failed:', err);
          showWarningToast(window._('Güvenli rastgele üretici kullanılamıyor.'));
        }
      } else {
        renderGeneratorHistory();
      }
    }, 50);
  });

  const modalCopyGenBtn = document.getElementById('modal-copy-generated-password-btn');
  modalCopyGenBtn?.addEventListener('click', () => {
    const val = document.getElementById('modal-generated-password-display')?.value;
    if (val) copyToClipboard(val, modalCopyGenBtn.querySelector('i'));
  });

  // ─── 9. INDEX SAYFASI ─────────────────────────────────────────────────────

  if (document.getElementById('card-container')) {

    const searchInput   = document.getElementById('search-input');
    const categoryBtns  = document.querySelectorAll('#category-filter button');
    const filterEmptyState = document.getElementById('filter-empty-state');
    const paginationNav = document.getElementById('card-pagination');
    const paginationSummary = document.getElementById('card-pagination-summary');
    const pagePrevButton = document.getElementById('card-page-prev');
    const pageNextButton = document.getElementById('card-page-next');
    const pageNumbers = document.getElementById('card-page-numbers');
    const CARD_PAGE_SIZE = 50;
    let currentCardPage = 1;
    let cardCache = [];
    const getCards = () => Array.from(document.querySelectorAll('.card-wrapper'));

    const normalizeSearchText = (value) =>
      String(value || '').toLocaleLowerCase(window.LANG || 'tr').trim();

    const createCardCacheItem = (wrapper) => ({
      wrapper,
      searchText: normalizeSearchText(wrapper.textContent),
      type: wrapper.dataset.type || '',
      pinned: wrapper.dataset.pinned === 'true',
    });

    const rebuildCardCache = () => {
      cardCache = getCards().map(createCardCacheItem);
    };

    const updateCachedCard = (wrapper) => {
      const index = cardCache.findIndex(item => item.wrapper === wrapper);
      if (index >= 0) cardCache[index] = createCardCacheItem(wrapper);
    };

    const setCardVisible = (wrapper, visible, animate = false) => {
      const wasHidden = wrapper.hidden || wrapper.style.display === 'none';
      wrapper.hidden = !visible;
      wrapper.style.display = visible ? 'block' : 'none';

      if (visible && animate && wasHidden) {
        wrapper.classList.remove('filter-reveal');
        void wrapper.offsetWidth;
        wrapper.classList.add('filter-reveal');
      } else if (!visible) {
        wrapper.classList.remove('filter-reveal');
      }
    };

    const createPageControl = (page, label = String(page), isActive = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `card-page-btn${isActive ? ' active' : ''}`;
      button.textContent = label;
      button.setAttribute('aria-label', `${window._('Sayfa')} ${page}`);
      button.setAttribute('aria-current', isActive ? 'page' : 'false');
      button.addEventListener('click', () => {
        currentCardPage = page;
        filterCards({ preservePage: true, animate: true, scrollToGrid: true });
      });
      return button;
    };

    const createPageDots = () => {
      const dots = document.createElement('span');
      dots.className = 'card-page-dots';
      dots.textContent = '…';
      return dots;
    };

    const renderPagination = (matchedCount, pageCount, startIndex, endIndex) => {
      if (!paginationNav || !paginationSummary || !pageNumbers) return;

      const shouldShow = cardCache.length > CARD_PAGE_SIZE && matchedCount > 0;
      paginationNav.hidden = !shouldShow;
      if (!shouldShow) return;

      paginationSummary.textContent = `${startIndex + 1}-${endIndex} / ${matchedCount} ${window._('kayıt gösteriliyor')}`;

      if (pagePrevButton) {
        pagePrevButton.disabled = currentCardPage <= 1;
        pagePrevButton.setAttribute('aria-disabled', String(currentCardPage <= 1));
      }
      if (pageNextButton) {
        pageNextButton.disabled = currentCardPage >= pageCount;
        pageNextButton.setAttribute('aria-disabled', String(currentCardPage >= pageCount));
      }

      pageNumbers.replaceChildren();
      const pages = new Set([1, pageCount]);
      for (let page = currentCardPage - 1; page <= currentCardPage + 1; page++) {
        if (page >= 1 && page <= pageCount) pages.add(page);
      }
      const orderedPages = Array.from(pages).sort((a, b) => a - b);
      orderedPages.forEach((page, index) => {
        if (index > 0 && page - orderedPages[index - 1] > 1) {
          pageNumbers.appendChild(createPageDots());
        }
        pageNumbers.appendChild(createPageControl(page, String(page), page === currentCardPage));
      });
    };

    const filterCards = ({ preservePage = false, animate = false, scrollToGrid = false } = {}) => {
      const term = normalizeSearchText(searchInput?.value || '');
      const activeBtn = document.querySelector('#category-filter button.active');
      const category  = activeBtn?.dataset.filter || 'all';
      const matchedCards = cardCache.filter(({ searchText, type, pinned }) => {
        const matchesSearch = !term || searchText.includes(term);
        const matchesCategory =
          category === 'all'       ? true :
          category === 'favorites' ? pinned :
                                     type === category;
        return matchesSearch && matchesCategory;
      });
      const pageCount = Math.max(1, Math.ceil(matchedCards.length / CARD_PAGE_SIZE));
      currentCardPage = preservePage ? Math.min(currentCardPage, pageCount) : 1;
      const startIndex = (currentCardPage - 1) * CARD_PAGE_SIZE;
      const endIndex = Math.min(startIndex + CARD_PAGE_SIZE, matchedCards.length);
      const visibleWrappers = new Set(
        matchedCards.slice(startIndex, endIndex).map(item => item.wrapper)
      );

      cardCache.forEach(({ wrapper }) =>
        setCardVisible(wrapper, visibleWrappers.has(wrapper), animate)
      );

      if (filterEmptyState) {
        const shouldShowEmptyState = cardCache.length > 0 && matchedCards.length === 0;
        filterEmptyState.hidden = !shouldShowEmptyState;
        filterEmptyState.classList.toggle('is-visible', shouldShowEmptyState);
      }

      renderPagination(matchedCards.length, pageCount, startIndex, endIndex);
      window.dispatchEvent(new CustomEvent('kasa:cards-page-changed'));
      if (scrollToGrid) {
        document.getElementById('card-container')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };

    rebuildCardCache();
    filterCards({ preservePage: false, animate: false });

    let searchTimeout;
    searchInput?.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => filterCards({ preservePage: false, animate: true }), 120);
    });

    pagePrevButton?.addEventListener('click', () => {
      if (currentCardPage <= 1) return;
      currentCardPage -= 1;
      filterCards({ preservePage: true, animate: true, scrollToGrid: true });
    });

    pageNextButton?.addEventListener('click', () => {
      currentCardPage += 1;
      filterCards({ preservePage: true, animate: true, scrollToGrid: true });
    });

    categoryBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        categoryBtns.forEach(b => {
          b.classList.remove('active', 'btn-primary');
          b.classList.add('btn-outline-secondary');
          b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.remove('btn-outline-secondary');
        btn.classList.add('active', 'btn-primary');
        btn.setAttribute('aria-pressed', 'true');
        filterCards({ preservePage: false, animate: true });
      });
    });

    // Geçmiş Modal
    const historyList = document.getElementById('history-list');
    document.querySelectorAll('.history-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const kayitId = btn.dataset.id;
        if (!kayitId) return;

        if (historyList) {
          historyList.replaceChildren(
            createStatusNode(window._('Yükleniyor...'), 'p-3 text-center text-body-secondary', 'fa-solid fa-spinner fa-spin me-2')
          );
        }
        kasaModalAc('historyModal');

        try {
          const data = await apiJson(`/gecmis/${encodeURIComponent(kayitId)}`);
          if (!historyList) return;
          if (!Array.isArray(data) || !data.length) {
            historyList.replaceChildren(
              createStatusNode(window._('Henüz geçmiş kaydı yok.'))
            );
            return;
          }

          const fragment = document.createDocumentFragment();
          data.forEach(item => {
            const div = document.createElement('div');
            div.className = 'list-group-item bg-transparent text-light border-secondary';

            const header = document.createElement('div');
            header.className = 'd-flex justify-content-between align-items-center mb-1';
            const time = document.createElement('small');
            time.className = 'text-info';
            time.append(createIcon('fa-regular fa-clock me-1'), document.createTextNode(item.date || ''));
            header.appendChild(time);

            const body = document.createElement('div');
            body.className = 'history-secret-row';

            const input = Object.assign(document.createElement('input'), {
              type: 'password',
              className: 'history-secret-input',
              value: item.password || '',
              readOnly: true,
            });

            const toggleBtn = createIconButton(window._('Göster/Gizle'), 'fa-solid fa-eye');
            toggleBtn.addEventListener('click', () => {
              const hidden = input.type === 'password';
              input.type = hidden ? 'text' : 'password';
              toggleBtn.querySelector('i').className =
                hidden ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
            });

            const copyBtn = createIconButton(window._('Kopyala'), 'fa-solid fa-copy');
            copyBtn.addEventListener('click', () => copyToClipboard(input.value, copyBtn.querySelector('i')));
            copyBtn.classList.add('copy-btn-history');

            body.append(input, toggleBtn, copyBtn);
            div.append(header, body);
            fragment.appendChild(div);
          });

          historyList.replaceChildren(fragment);
        } catch {
          if (historyList) {
            historyList.replaceChildren(
              createStatusNode(window._('Yükleme hatası oluştu.'), 'p-3 text-center text-danger')
            );
          }
        }
      });
    });

    // Silme Onayı (SweetAlert2)
    const SWAL_BASE = {
      heightAuto: false, scrollbarPadding: false,
      color: 'var(--text)', buttonsStyling: false,
      customClass: {
        popup: 'kasa-swal-popup', title: 'kasa-swal-title',
        htmlContainer: 'kasa-swal-text', actions: 'kasa-swal-actions',
        confirmButton: 'kasa-btn kasa-btn-danger',
        cancelButton: 'kasa-btn kasa-btn-muted',
      },
      willOpen: (popup, container) => {
        popup.style.cssText    += ';opacity:0;transform:scale(0.92) translateY(16px)';
        container.style.background = 'transparent';
      },
      didOpen: (popup, container) => {
        void container.offsetHeight;
        popup.style.transition = 'opacity 0.28s cubic-bezier(0.16,1,0.3,1), transform 0.28s cubic-bezier(0.16,1,0.3,1)';
        popup.style.opacity    = '1';
        popup.style.transform  = 'scale(1) translateY(0)';
        container.style.transition  = 'background 0.25s ease';
        container.style.background  = 'rgba(0,0,0,0.42)';
      },
      willClose: (popup, container, done) => {
        popup.style.transition = 'opacity 0.15s ease-in, transform 0.15s ease-in';
        popup.style.opacity    = '0';
        popup.style.transform  = 'scale(0.95) translateY(8px)';
        container.style.transition = 'background 0.15s ease-in';
        container.style.background = 'transparent';
        setTimeout(done, 150);
      },
    };

    document.querySelectorAll('.delete-form').forEach(form => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const { isConfirmed } = await Swal.fire({
          ...SWAL_BASE,
          title: window._('Emin misiniz?'),
          text: window._('Bu kayıt tamamen silinecek ve geri alınamaz!'),
          icon: 'warning',
          showCancelButton: true,
          confirmButtonText: window._('Evet, Sil!'),
          cancelButtonText: window._('İptal'),
        });
        if (!isConfirmed) return;
        const wrapper = form.closest('.card-wrapper');
        if (wrapper) {
          Object.assign(wrapper.style, {
            transition: 'all 0.3s ease', transform: 'scale(0.95)', opacity: '0',
          });
        }
        try {
          const response = await apiFetch(form.action, { method: 'POST' });
          if (!response?.ok) throw new Error('delete-failed');
          if (wrapper) {
            setTimeout(() => {
              wrapper.remove();
              rebuildCardCache();
              filterCards({ preservePage: true, animate: true });
            }, 300);
          }
          showToast({
            ...TOAST_BASE, text: window._('Kayıt başarıyla silindi.'), duration: 2500,
            style: {
              ...TOAST_BASE.style,
              background:    'rgba(239, 68, 68, 0.14)',
              border:        '1px solid rgba(239, 68, 68, 0.28)',
              backdropFilter: glassEffectsEnabled() ? 'blur(14px)' : 'none',
              borderRadius:  '12px',
              boxShadow:     '0 14px 36px rgba(0,0,0,0.28)',
              color:         '#fecaca',
            },
          });
        } catch {
          if (wrapper) Object.assign(wrapper.style, { transform: '', opacity: '1' });
          showWarningToast(window._('Silme işlemi başarısız oldu.'));
        }
      });
    });

    // Pin Toggle
    document.querySelectorAll('.pin-form').forEach(form => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const icon = form.querySelector('i');
        if (icon) {
          icon.style.transform = 'scale(1.2)';
          setTimeout(() => { icon.style.transform = 'scale(1)'; }, 200);
        }
        try {
          const response = await apiFetch(form.action, { method: 'POST' });
          if (!response?.ok) throw new Error('pin-failed');
          const wrapper  = form.closest('.card-wrapper');
          if (!wrapper || !icon) return;
          const isPinned = wrapper.dataset.pinned === 'true';
          wrapper.dataset.pinned = isPinned ? 'false' : 'true';
          if (isPinned) {
            icon.className = 'fa-regular fa-star card-star-icon card-star-unpinned';
            icon.style.color = '';
          } else {
            icon.className   = 'fa-solid fa-star card-star-icon';
            icon.style.color = '#f59e0b';
          }
          updateCachedCard(wrapper);
          const activeBtn = document.querySelector('#category-filter button.active');
          if (activeBtn?.dataset.filter === 'favorites') filterCards({ preservePage: true, animate: true });
        } catch {
          showWarningToast(window._('İşlem tamamlanamadı.'));
        }
      });
    });

    // Tepsi Ayarı
    const trayToggle = document.getElementById('setting-minimize-to-tray');
    if (trayToggle) {
      apiJson('/settings/tray')
        .then(data => { trayToggle.checked = data.minimize_to_tray; })
        .catch(() => {});

      trayToggle.addEventListener('change', () =>
        apiPost('/settings/tray', { minimize_to_tray: trayToggle.checked })
      );
    }
  }

  // ─── 10. EKLE / DÜZENLE SAYFASI ───────────────────────────────────────────

  const kayitTipiSelect = document.getElementById('kayit_tipi');
  if (kayitTipiSelect) {
    const _t = window._;
    const FIELD_CONFIGS = {
      CreditCard: {
        isim: _t('Kart Başlığı'), login: _t('Kart Numarası'), password: _t('CVV / Şifre'),
        comment: _t('Not / Son Kullanma Tarihi'),
        showLogin: true, showPassword: true, showKategori: true,
        commentRows: 3, commentPlaceholder: _t('Notlar…'), commentRequired: false,
      },
      SecureNote: {
        isim: _t('Not Başlığı'), comment: _t('Not İçeriği'),
        showLogin: false, showPassword: false, showKategori: true,
        commentRows: 7, commentPlaceholder: _t('Notunuzu buraya yazın…'), commentRequired: true,
      },
      default: {
        isim: _t('İsim / Başlık'), login: _t('Kullanıcı Adı'), password: _t('Şifre'),
        comment: _t('Not (İsteğe Bağlı)'),
        showLogin: true, showPassword: true, showKategori: true,
        commentRows: 3, commentPlaceholder: _t('Notlar…'), commentRequired: false,
      },
    };

    const el = (id) => document.getElementById(id);
    const urlGroup      = el('website_url_group');
    const loginGroup    = el('login_group');
    const passwordGroup = el('password_group');
    const kategoriGroup = el('kategori_group');
    const pageGenerator = el('pageGenerator');
    const generateBtn   = el('page-generate-btn');
    const strengthCard  = el('vault-strength-card');
    const commentInput  = el('comment');
    const isimLabel     = el('isim_label');
    const loginLabel    = el('login_label');
    const passwordLabel = el('password_label');
    const commentLabel  = el('comment_label');

    generateBtn?.addEventListener('click', () => {
      const isVisible = pageGenerator && !pageGenerator.classList.contains('is-collapsed');
      if (pageGenerator) {
        pageGenerator.classList.toggle('is-collapsed', Boolean(isVisible));
        pageGenerator.setAttribute('aria-hidden', String(Boolean(isVisible)));
        generateBtn.setAttribute('aria-expanded', String(!isVisible));
      }
      const icon = generateBtn.querySelector('i');
      if (icon) icon.className = isVisible
        ? 'fa-solid fa-wand-magic-sparkles fa-xs'
        : 'fa-solid fa-xmark fa-xs';
    });

    const toggleFormFields = () => {
      const config = FIELD_CONFIGS[kayitTipiSelect.value] || FIELD_CONFIGS.default;

      if (urlGroup)      urlGroup.style.display      = kayitTipiSelect.value === 'Website' ? '' : 'none';
      if (loginGroup)    loginGroup.style.display     = config.showLogin    ? '' : 'none';
      if (passwordGroup) passwordGroup.style.display  = config.showPassword ? '' : 'none';
      if (kategoriGroup) kategoriGroup.style.display  = config.showKategori ? '' : 'none';
      if (strengthCard)  strengthCard.style.display   = config.showPassword ? '' : 'none';
      if (pageGenerator) {
        pageGenerator.classList.add('is-collapsed');
        pageGenerator.setAttribute('aria-hidden', 'true');
        generateBtn?.setAttribute('aria-expanded', 'false');
      }

      const genIcon = generateBtn?.querySelector('i');
      if (genIcon) genIcon.className = 'fa-solid fa-wand-magic-sparkles fa-xs';

      if (isimLabel)     isimLabel.textContent    = config.isim;
      if (loginLabel    && config.login)    loginLabel.textContent    = config.login;
      if (passwordLabel && config.password) passwordLabel.textContent = config.password;
      if (commentLabel)  commentLabel.textContent  = config.comment;

      if (commentInput) {
        commentInput.rows        = config.commentRows || 3;
        commentInput.placeholder = config.commentPlaceholder || 'Notlar…';
        commentInput.required    = Boolean(config.commentRequired);
      }

      el('website_url') && (el('website_url').disabled = kayitTipiSelect.value !== 'Website');
      el('login')       && (el('login').disabled       = !config.showLogin);
      el('page-password') && (el('page-password').disabled = !config.showPassword);
    };

    toggleFormFields();
    kayitTipiSelect.addEventListener('change', toggleFormFields);
  }

});
