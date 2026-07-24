/**
 * ŞifreKasam v2.5.9-beta.2 - Main JavaScript
 */

document.addEventListener('DOMContentLoaded', () => {

  // ─── SABİTLER & YARDIMCILAR ───────────────────────────────────────────────

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

  const hexToHsv = (hex) => {
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

  const hsvToHex = (hue, saturation, brightness) => {
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
    window.KASA_SET_RUNTIME_STYLE?.('appearance', `html:root {
      --accent: ${normalizedAccent};
      --accent-2: ${accent2};
      --accent-rgb: ${hexToRgb(normalizedAccent)};
      --accent-2-rgb: ${hexToRgb(accent2)};
    }`);
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
  let rendererResumeTimer = null;
  const powerSaveOverlay = document.querySelector('.power-save-overlay');
  const powerSaveTitle = powerSaveOverlay?.querySelector('[data-power-save-title]');
  const powerSaveSubtitle = powerSaveOverlay?.querySelector('[data-power-save-subtitle]');
  const pageShell = document.getElementById('kasa-page-shell');

  const setPowerSaveOverlay = (active, restoring = false) => {
    if (!powerSaveOverlay) return;
    if (powerSaveTitle) {
      powerSaveTitle.textContent = restoring
        ? window._('Tasarruf modundan çıkılıyor')
        : window._('Tasarruf modu');
    }
    if (powerSaveSubtitle) {
      powerSaveSubtitle.textContent = restoring
        ? window._('Kartlar ve arayüz yeniden hazırlanıyor.')
        : window._('ŞifreKasam arka planda kaynak kullanımını azaltıyor.');
    }
    powerSaveOverlay.classList.toggle('is-active', active);
    powerSaveOverlay.classList.toggle('is-restoring', active && restoring);
    powerSaveOverlay.setAttribute('aria-hidden', String(!active));
  };

  const forceRendererRepaint = () => {
    if (!pageShell) return;
    const repaintTargets = [
      document.getElementById('card-container'),
      document.getElementById('stats-bar'),
      document.querySelector('.sr-root'),
      document.querySelector('.settings-workspace'),
    ].filter(Boolean);

    repaintTargets.forEach(target => target.classList.add('kasa-repaint-hidden'));
    pageShell.classList.remove('kasa-renderer-repaint');
    void pageShell.offsetHeight;
    requestAnimationFrame(() => {
      repaintTargets.forEach(target => target.classList.remove('kasa-repaint-hidden'));
      pageShell.classList.add('kasa-renderer-repaint');
      window.dispatchEvent(new Event('resize'));
      requestAnimationFrame(() => pageShell.classList.remove('kasa-renderer-repaint'));
    });
  };

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
      clearTimeout(rendererResumeTimer);
      setPowerSaveOverlay(true, false);
    } else {
      idleLowPower = false;
      scheduleIdleLowPower();
    }
    applyRendererLowPower();
  };

  const resumeRenderer = () => {
    if (document.hidden) return;
    clearTimeout(rendererResumeTimer);
    setPowerSaveOverlay(true, true);
    systemLowPower = false;
    idleLowPower = false;
    applyRendererLowPower();
    scheduleIdleLowPower();
    requestAnimationFrame(() => requestAnimationFrame(forceRendererRepaint));
    rendererResumeTimer = window.setTimeout(() => {
      setPowerSaveOverlay(false, false);
    }, 420);
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
  window.KASA_RESUME_RENDERER = resumeRenderer;
  setRendererLowPower(document.hidden);
  sendHeartbeat();
  scheduleHeartbeat();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) setRendererLowPower(true);
    else resumeRenderer();
  });
  IDLE_ACTIVITY_EVENTS.forEach((eventName) => {
    window.addEventListener(eventName, resetIdleLowPower, { passive: true });
  });
  window.addEventListener('kasa:low-power-changed', scheduleHeartbeat);
  window.addEventListener('pagehide', () => {
    stopHeartbeat();
    stopIdleLowPowerTimer();
    clearTimeout(rendererResumeTimer);
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

  // ─── 2b. ÖZEL FORM KONTROLLERİ ───────────────────────────────────────────

  const customSelectStates = [];

  const syncCustomSelectDirection = (state) => {
    if (!state?.openRequested) return;
    const triggerRect = state.trigger.getBoundingClientRect();
    const boundaryRect = state.wrapper.closest('.modal-content')?.getBoundingClientRect();
    const boundaryTop = boundaryRect?.top ?? 0;
    const boundaryBottom = boundaryRect?.bottom ?? window.innerHeight;
    const menuHeight = Math.min(state.menu.scrollHeight, window.innerHeight * 0.38);
    const spaceAbove = triggerRect.top - boundaryTop;
    const spaceBelow = boundaryBottom - triggerRect.bottom;
    state.wrapper.classList.toggle(
      'opens-upward',
      spaceBelow < menuHeight + 10 && spaceAbove > spaceBelow,
    );
  };

  const closeCustomSelect = (state, restoreFocus = false) => {
    if (!state || (!state.openRequested && !state.wrapper.classList.contains('is-open'))) return;
    state.openRequested = false;
    state.wrapper.classList.remove('is-open');
    state.host?.classList.remove('has-open-select');
    state.trigger.setAttribute('aria-expanded', 'false');
    clearTimeout(state.closeTimer);
    state.closeTimer = setTimeout(() => {
      if (!state.wrapper.classList.contains('is-open')) {
        state.menu.hidden = true;
        state.wrapper.classList.remove('opens-upward');
        state.layerHosts.forEach((layerHost) => {
          if (!layerHost.querySelector('.kasa-custom-select.is-open')) {
            layerHost.classList.remove('has-open-select-layer');
          }
        });
      }
    }, 140);
    if (restoreFocus) state.trigger.focus({ preventScroll: true });
  };

  const closeCustomSelects = (exceptState = null) => {
    customSelectStates.forEach(state => {
      if (state !== exceptState) closeCustomSelect(state);
    });
  };

  document.querySelectorAll('select[data-custom-select]').forEach((select, index) => {
    if (select.dataset.customSelectReady === 'true') return;
    select.dataset.customSelectReady = 'true';

    const wrapper = document.createElement('div');
    wrapper.className = 'kasa-custom-select';
    ['settings-inline-select', 'settings-language-select'].forEach(className => {
      if (select.classList.contains(className)) wrapper.classList.add(className);
    });

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'kasa-custom-select-trigger';
    trigger.id = `${select.id || `custom-select-${index}`}-trigger`;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const labelledBy = select.getAttribute('aria-labelledby');
    const label = select.getAttribute('aria-label');
    if (labelledBy) trigger.setAttribute('aria-labelledby', labelledBy);
    else if (label) trigger.setAttribute('aria-label', label);

    const valueNode = document.createElement('span');
    valueNode.className = 'kasa-custom-select-value';
    const chevron = createIcon('fa-solid fa-chevron-down');
    chevron.setAttribute('aria-hidden', 'true');
    trigger.append(valueNode, chevron);

    const menu = document.createElement('div');
    menu.className = 'kasa-custom-select-menu';
    menu.id = `${trigger.id}-menu`;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-labelledby', trigger.id);
    menu.hidden = true;
    trigger.setAttribute('aria-controls', menu.id);

    const optionButtons = Array.from(select.options).map(option => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'kasa-custom-select-option';
      button.dataset.value = option.value;
      button.setAttribute('role', 'option');
      button.disabled = option.disabled;

      const optionText = document.createElement('span');
      optionText.textContent = option.textContent.trim();
      const check = createIcon('fa-solid fa-check');
      check.setAttribute('aria-hidden', 'true');
      button.append(optionText, check);
      menu.appendChild(button);
      return button;
    });

    select.before(wrapper);
    wrapper.append(select, trigger, menu);
    select.classList.add('kasa-custom-select-source');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    const state = {
      select,
      wrapper,
      trigger,
      menu,
      optionButtons,
      closeTimer: 0,
      openRequested: false,
      host: wrapper.closest('.glass-sm, .settings-appearance-card, .vault-field'),
      layerHosts: [
        wrapper.closest('.vault-form-panel'),
        wrapper.closest('.settings-panel'),
        wrapper.closest('.settings-body'),
      ].filter((layerHost, layerIndex, layerHosts) => (
        layerHost && layerHosts.indexOf(layerHost) === layerIndex
      )),
    };
    customSelectStates.push(state);

    const syncCustomSelect = () => {
      const selectedOption = select.selectedOptions[0] || select.options[0];
      valueNode.textContent = selectedOption?.textContent.trim() || '';
      trigger.disabled = select.disabled;
      wrapper.classList.toggle('is-disabled', select.disabled);
      optionButtons.forEach((button, optionIndex) => {
        const selected = select.options[optionIndex]?.selected === true;
        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-selected', String(selected));
      });
      if (select.disabled) closeCustomSelect(state);
    };

    const openCustomSelect = (focusSelected = false) => {
      if (select.disabled) return;
      if (wrapper.classList.contains('is-open')) {
        closeCustomSelect(state);
        return;
      }
      closeCustomSelects(state);
      clearTimeout(state.closeTimer);
      state.openRequested = true;
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      state.host?.classList.add('has-open-select');
      state.layerHosts.forEach(layerHost => layerHost.classList.add('has-open-select-layer'));
      requestAnimationFrame(() => {
        if (!state.openRequested) return;
        syncCustomSelectDirection(state);
        wrapper.classList.add('is-open');
        if (focusSelected) {
          (optionButtons.find(button => button.classList.contains('is-selected'))
            || optionButtons.find(button => !button.disabled))?.focus({ preventScroll: true });
        }
      });
    };

    trigger.addEventListener('click', () => openCustomSelect(false));
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openCustomSelect(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeCustomSelect(state);
      }
    });

    optionButtons.forEach((button, optionIndex) => {
      button.addEventListener('click', () => {
        if (button.disabled) return;
        select.value = select.options[optionIndex].value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        closeCustomSelect(state, true);
      });
      button.addEventListener('keydown', event => {
        const enabledOptions = optionButtons.filter(optionButton => !optionButton.disabled);
        const currentIndex = enabledOptions.indexOf(button);
        let nextIndex = currentIndex;
        if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % enabledOptions.length;
        else if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + enabledOptions.length) % enabledOptions.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = enabledOptions.length - 1;
        else if (event.key === 'Escape') {
          event.preventDefault();
          closeCustomSelect(state, true);
          return;
        } else {
          return;
        }
        event.preventDefault();
        enabledOptions[nextIndex]?.focus({ preventScroll: true });
      });
    });

    select.addEventListener('change', syncCustomSelect);
    wrapper.addEventListener('focusout', () => {
      setTimeout(() => {
        if (!wrapper.contains(document.activeElement)) closeCustomSelect(state);
      }, 0);
    });
    select.kasaSyncCustomSelect = syncCustomSelect;
    new MutationObserver(syncCustomSelect).observe(select, {
      attributes: true,
      attributeFilter: ['disabled'],
    });
    syncCustomSelect();
  });

  document.addEventListener('click', event => {
    if (!(event.target instanceof Element) || !event.target.closest('.kasa-custom-select')) {
      closeCustomSelects();
    }
  });

  const syncOpenCustomSelects = () => {
    customSelectStates.forEach(syncCustomSelectDirection);
  };
  window.addEventListener('resize', syncOpenCustomSelects, { passive: true });
  document.addEventListener('scroll', syncOpenCustomSelects, { passive: true, capture: true });

  document.querySelectorAll('.kasa-modal').forEach(modal => {
    modal.addEventListener('kasa:modal-closing', () => closeCustomSelects());
  });

  document.querySelectorAll('[data-number-stepper]').forEach(stepper => {
    const input = stepper.querySelector('input[type="number"]');
    if (!input) return;

    const clampInput = () => {
      const min = Number(input.min);
      const max = Number(input.max);
      const fallback = Number.isFinite(min) ? min : 0;
      const value = Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : fallback;
      input.value = String(Math.min(Number.isFinite(max) ? max : value, Math.max(fallback, value)));
    };

    stepper.querySelectorAll('[data-step-direction]').forEach(button => {
      button.addEventListener('click', () => {
        if (button.dataset.stepDirection === 'up') input.stepUp();
        else input.stepDown();
        clampInput();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
    input.addEventListener('change', clampInput);
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
  let glassQualitySyncFrame = 0;

  const syncGlassQualityVisibility = (enabled, animate = true) => {
    if (!glassQualityCard) return;
    animate = animate
      && document.documentElement.getAttribute('data-kasa-animations') !== 'off'
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const shouldShow = Boolean(enabled);
    cancelAnimationFrame(glassQualitySyncFrame);
    glassQualityCard.setAttribute('aria-hidden', String(!shouldShow));
    if (glassQualitySelect) {
      glassQualitySelect.disabled = !shouldShow;
      glassQualitySelect.tabIndex = glassQualitySelect.dataset.customSelectReady === 'true'
        ? -1
        : (shouldShow ? 0 : -1);
      glassQualitySelect.kasaSyncCustomSelect?.();
    }

    glassQualityCard.classList.toggle('is-no-transition', !animate);
    glassQualityCard.classList.toggle('is-collapsed', !shouldShow);
    if (!animate) {
      glassQualitySyncFrame = requestAnimationFrame(() => {
        glassQualityCard.classList.remove('is-no-transition');
      });
    }
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
  const interfaceAnimationsToggle = document.getElementById('interface-animations-toggle');
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
    interfaceAnimationsToggle,
    'data-kasa-animations',
    'kasa-interface-animations',
    'interface_animations_enabled'
  );
  setupThemeFeatureToggle(
    gradientsToggle,
    'data-kasa-gradient',
    'kasa-gradients',
    'gradients_enabled'
  );

  const accentInput = document.getElementById('accent-color-input');
  const accentTextInput = document.getElementById('accent-color-text');
  const accentColorPicker = document.getElementById('accent-color-picker');
  const accentColorTrigger = document.getElementById('accent-color-trigger');
  const accentColorPopover = document.getElementById('accent-color-popover');
  const accentColorScrim = document.getElementById('accent-color-scrim');
  const accentColorClose = document.getElementById('accent-color-close');
  const accentColorReset = document.getElementById('accent-color-reset');
  const accentColorTriggerValue = document.getElementById('accent-color-trigger-value');
  const accentColorPickerValue = document.getElementById('accent-color-picker-value');
  const accentColorRgb = document.getElementById('accent-color-rgb');
  const accentHueInput = document.getElementById('accent-hue-input');
  const accentSaturationInput = document.getElementById('accent-saturation-input');
  const accentBrightnessInput = document.getElementById('accent-brightness-input');
  const accentHueValue = document.getElementById('accent-hue-value');
  const accentSaturationValue = document.getElementById('accent-saturation-value');
  const accentBrightnessValue = document.getElementById('accent-brightness-value');
  const settingsModal = document.getElementById('settingsModal');
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
  let colorPickerCloseTimer = 0;
  let colorPickerState = hexToHsv(currentAppearance.accent);

  if (settingsModal && accentColorScrim && accentColorPopover) {
    settingsModal.append(accentColorScrim, accentColorPopover);
  }

  if (glassQualitySelect) {
    glassQualitySelect.value = normalizeGlassQuality(
      document.documentElement.getAttribute('data-glass-quality')
    );
    glassQualitySelect.kasaSyncCustomSelect?.();
    glassQualitySelect.addEventListener('change', () => {
      const glassQuality = applyGlassQuality(glassQualitySelect.value);
      glassQualitySelect.value = glassQuality;
      glassQualitySelect.kasaSyncCustomSelect?.();
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

  const setColorPickerOpen = (open) => {
    if (!accentColorPicker || !accentColorPopover || !accentColorTrigger) return;
    clearTimeout(colorPickerCloseTimer);
    accentColorTrigger.setAttribute('aria-expanded', String(open));

    if (open) {
      accentColorPopover.hidden = false;
      if (accentColorScrim) accentColorScrim.hidden = false;
      requestAnimationFrame(() => {
        accentColorPicker.classList.add('is-open');
        accentColorScrim?.classList.add('is-open');
        accentColorPopover.classList.add('is-open');
        accentHueInput?.focus({ preventScroll: true });
      });
      return;
    }

    accentColorPicker.classList.remove('is-open');
    accentColorScrim?.classList.remove('is-open');
    accentColorPopover.classList.remove('is-open');
    colorPickerCloseTimer = setTimeout(() => {
      accentColorPopover.hidden = true;
      if (accentColorScrim) accentColorScrim.hidden = true;
    }, 180);
  };

  const syncColorPickerControls = (accent, preservePickerState = false) => {
    if (!accentColorPicker) return;
    const normalizedAccent = normalizeHexColor(accent);
    const pickerColor = preservePickerState
      ? { ...colorPickerState }
      : hexToHsv(normalizedAccent);
    colorPickerState = pickerColor;
    const hueColor = hsvToHex(pickerColor.hue, 100, 100);
    const fullBrightnessColor = hsvToHex(pickerColor.hue, pickerColor.saturation, 100);

    if (accentHueInput) accentHueInput.value = String(pickerColor.hue);
    if (accentSaturationInput) accentSaturationInput.value = String(pickerColor.saturation);
    if (accentBrightnessInput) accentBrightnessInput.value = String(pickerColor.brightness);
    if (accentHueValue) accentHueValue.value = `${pickerColor.hue}°`;
    if (accentSaturationValue) accentSaturationValue.value = `${pickerColor.saturation}%`;
    if (accentBrightnessValue) accentBrightnessValue.value = `${pickerColor.brightness}%`;
    if (accentColorTriggerValue) accentColorTriggerValue.textContent = normalizedAccent;
    if (accentColorPickerValue) accentColorPickerValue.textContent = normalizedAccent;
    if (accentColorRgb) accentColorRgb.value = `RGB ${hexToRgb(normalizedAccent)}`;
    window.KASA_SET_RUNTIME_STYLE?.(
      'accent-color-picker',
      `#accent-color-picker, #accent-color-popover {
        --picker-color: ${normalizedAccent};
        --picker-hue: ${hueColor};
        --picker-full-brightness: ${fullBrightnessColor};
      }`
    );
  };

  const syncAppearanceControls = (accent, background, preservePickerState = false) => {
    if (accentInput) accentInput.value = normalizeHexColor(accent);
    if (accentTextInput) accentTextInput.value = normalizeHexColor(accent);
    if (accentHidden) accentHidden.value = normalizeHexColor(accent);
    if (backgroundSelect) {
      backgroundSelect.value = background;
      backgroundSelect.kasaSyncCustomSelect?.();
    }
    if (backgroundHidden) backgroundHidden.value = background;
    if (appearancePreview) {
      window.KASA_SET_RUNTIME_STYLE?.(
        'appearance-preview',
        `#appearance-preview { --preview-accent: ${normalizeHexColor(accent)}; }`
      );
      appearancePreview.dataset.previewBackground = background;
    }
    syncColorPickerControls(accent, preservePickerState);
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

  const updateAppearance = (accent, background, persist = true, preservePickerState = false) => {
    const next = applyAppearance(accent, background);
    syncAppearanceControls(next.accent, next.background, preservePickerState);
    queueAccentContrastWarning(next.accent);
    if (persist) {
      clearTimeout(appearanceSaveTimer);
      appearanceSaveTimer = setTimeout(() => {
        apiPost('/settings/appearance', {
          accent_color: next.accent,
          background_style: next.background,
          animated_backgrounds_enabled: motionToggle?.checked ?? themeFeatureEnabled('data-kasa-motion'),
          interface_animations_enabled: interfaceAnimationsToggle?.checked ?? themeFeatureEnabled('data-kasa-animations'),
          gradients_enabled: gradientsToggle?.checked ?? themeFeatureEnabled('data-kasa-gradient'),
        });
      }, 250);
    }
  };

  if (accentInput || accentTextInput || backgroundSelect) {
    syncAppearanceControls(currentAppearance.accent, currentAppearance.background);

    accentColorTrigger?.addEventListener('click', () => {
      setColorPickerOpen(accentColorTrigger.getAttribute('aria-expanded') !== 'true');
    });
    accentColorScrim?.addEventListener('click', () => setColorPickerOpen(false));
    accentColorClose?.addEventListener('click', () => setColorPickerOpen(false));
    accentColorReset?.addEventListener('click', () => {
      updateAppearance(
        accentColorReset.dataset.defaultAccent || '#7c6ff7',
        backgroundSelect?.value || currentAppearance.background
      );
    });
    [accentHueInput, accentSaturationInput, accentBrightnessInput].forEach(input => {
      input?.addEventListener('input', () => {
        colorPickerState = {
          hue: Number(accentHueInput?.value || 0),
          saturation: Number(accentSaturationInput?.value || 0),
          brightness: Number(accentBrightnessInput?.value || 0),
        };
        updateAppearance(
          hsvToHex(
            colorPickerState.hue,
            colorPickerState.saturation,
            colorPickerState.brightness
          ),
          backgroundSelect?.value || currentAppearance.background,
          true,
          true
        );
      });
    });
    accentTextInput?.addEventListener('input', () => {
      if (/^#?[0-9a-fA-F]{6}$/.test(accentTextInput.value.trim())) {
        updateAppearance(
          accentTextInput.value,
          backgroundSelect?.value || currentAppearance.background
        );
      }
    });
    accentTextInput?.addEventListener('change', () => {
      const fallback = accentInput?.value || currentAppearance.accent;
      updateAppearance(
        normalizeHexColor(accentTextInput.value, fallback),
        backgroundSelect?.value || currentAppearance.background
      );
    });
    backgroundSelect?.addEventListener('change', () =>
      updateAppearance(
        accentInput?.value || currentAppearance.accent,
        backgroundSelect.value,
        true,
        true
      )
    );

    accentPresetButtons.forEach(btn => {
      btn.addEventListener('click', () =>
        updateAppearance(btn.dataset.accentPreset, backgroundSelect?.value || currentAppearance.background)
      );
    });
    backgroundButtons.forEach(btn => {
      btn.addEventListener('click', () =>
        updateAppearance(
          accentInput?.value || currentAppearance.accent,
          btn.dataset.backgroundOption,
          true,
          true
        )
      );
    });
    settingsModal?.addEventListener('kasa:modal-closing', () => {
      setColorPickerOpen(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && accentColorTrigger?.getAttribute('aria-expanded') === 'true') {
        event.stopPropagation();
        setColorPickerOpen(false);
        accentColorTrigger.focus({ preventScroll: true });
      }
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
    if (lastToast.toastElement) {
      lastToast.toastElement.setAttribute('role', opts.role || 'status');
      lastToast.toastElement.setAttribute('aria-live', opts.role === 'alert' ? 'assertive' : 'polite');
    }
  };

  const TOAST_BASE = {
    duration: 2000, close: false,
    gravity: 'bottom', position: 'right', stopOnFocus: true,
  };

  const showSuccessToast = (text) => showToast({
    ...TOAST_BASE, text, className: 'kasa-toast kasa-toast-success',
  });

  const showWarningToast = (text) => showToast({
    ...TOAST_BASE, text, role: 'alert', className: 'kasa-toast kasa-toast-warning',
  });

  // Eski template scriptleri için tek ve tutarlı toast/API köprüsü.
  window.showToast = (options, type = '') => {
    const normalized = typeof options === 'string'
      ? { ...TOAST_BASE, text: options }
      : { ...TOAST_BASE, ...(options || {}) };
    if (type === 'error' || normalized.type === 'error') {
      normalized.role = 'alert';
      normalized.className = 'kasa-toast kasa-toast-warning';
    }
    showToast(normalized);
  };
  window.KASA_API_FETCH = apiFetch;
  window.KASA_SHOW_WARNING_TOAST = showWarningToast;
  window.KASA_TRIGGER_BLOB_DOWNLOAD = triggerBlobDownload;

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
      settingsPanels.forEach(panel => {
        const isActive = panel === nextPanel;
        panel.hidden = !isActive;
        panel.classList.toggle('active', isActive);
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
          glassQualitySelect.kasaSyncCustomSelect?.();
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

  const getOriginalCopyIconClassName = (iconEl) => {
    const classes = Array.from(iconEl?.classList || [])
      .map(className => className === 'fa-check' ? 'fa-copy' : className)
      .filter(className => !['copy-flash', 'text-success'].includes(className));

    if (!classes.includes('fa-copy')) classes.push('fa-copy');
    if (!classes.includes('fa-solid') && !classes.includes('fa-regular')) {
      classes.unshift('fa-solid');
    }

    return [...new Set(classes)].join(' ') || 'fa-solid fa-copy';
  };

  const resetCopyButtonIcon = (button) => {
    if (!button?.isConnected) return;
    const state = copyButtonStates.get(button);
    const icon = state?.icon?.isConnected ? state.icon : button.querySelector('i');
    if (icon) icon.className = state?.originalClassName || getOriginalCopyIconClassName(icon);
    delete button.dataset.copyResetAt;
    copyButtonStates.delete(button);
  };

  const resetStuckCopyButtons = () => {
    const now = Date.now();
    document.querySelectorAll('button[data-copy-reset-at]').forEach((button) => {
      const resetAt = Number(button.dataset.copyResetAt || 0);
      if (resetAt && now >= resetAt) {
        resetCopyButtonIcon(button);
      }
    });
  };

  const flashCopyIcon = (iconEl) => {
    const button = getCopyButton(iconEl);
    if (!button) return;

    const currentState = copyButtonStates.get(button);
    const icon = iconEl?.isConnected ? iconEl : button.querySelector('i');
    if (!icon) return;
    const originalClassName = currentState?.originalClassName || getOriginalCopyIconClassName(icon);
    clearTimeout(currentState?.timer);

    icon.className = originalClassName
      .split(/\s+/)
      .map(className => className === 'fa-copy' ? 'fa-check' : className)
      .filter(Boolean)
      .concat('text-success', 'copy-flash')
      .filter((className, index, classes) => classes.indexOf(className) === index)
      .join(' ');

    button.dataset.copyResetAt = String(Date.now() + COPY_ICON_RESET_MS + 250);
    const timer = setTimeout(() => resetCopyButtonIcon(button), COPY_ICON_RESET_MS);
    setTimeout(resetStuckCopyButtons, COPY_ICON_RESET_MS + 500);
    copyButtonStates.set(button, { icon, originalClassName, timer });

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
        textarea.className = 'kasa-clipboard-fallback';
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
    const visibleModals = Array.from(document.querySelectorAll('.kasa-modal.is-visible'))
      .filter(visibleModal => visibleModal !== modal);
    visibleModals.forEach(visibleModal => visibleModal.classList.remove('is-top-modal'));
    document.body.classList.add('kasa-modal-open');
    modal.classList.remove('is-closing', 'is-open', 'is-stacked-modal');
    modal.classList.toggle('is-stacked-modal', visibleModals.length > 0);
    modal.classList.add('is-top-modal');
    modal.classList.add('is-visible');
    modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => modal.classList.add('is-open'));
  };

  window.kasaModalKapat = (modalId) => {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.dispatchEvent(new CustomEvent('kasa:modal-closing'));
    const transitionsDisabled = document.documentElement.getAttribute('data-kasa-animations') === 'off'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    modal.classList.remove('is-open');
    modal.classList.add('is-closing');
    setTimeout(() => {
      modal.classList.remove('is-visible', 'is-closing', 'is-top-modal', 'is-stacked-modal');
      modal.setAttribute('aria-hidden', 'true');
      const remainingModals = Array.from(document.querySelectorAll('.kasa-modal.is-visible'));
      if (!remainingModals.length) {
        document.body.classList.remove('kasa-modal-open');
      } else {
        remainingModals.forEach(remainingModal => remainingModal.classList.remove('is-top-modal'));
        remainingModals[remainingModals.length - 1].classList.add('is-top-modal');
      }
    }, transitionsDisabled ? 0 : 280);
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
    { className: 'strength-level-0', text: 'Çok Zayıf' },
    { className: 'strength-level-1', text: 'Zayıf' },
    { className: 'strength-level-2', text: 'Orta' },
    { className: 'strength-level-3', text: 'Güçlü' },
    { className: 'strength-level-4', text: 'Çok Güçlü' },
  ];
  const STRENGTH_CLASS_NAMES = STRENGTH_LEVELS.map(level => level.className);

  window.updateStrengthMeter = async (password, barEl, labelEl) => {
    if (!barEl || !labelEl) return;
    barEl.classList.remove(...STRENGTH_CLASS_NAMES);
    if (!password) {
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

    barEl.classList.add(level.className);
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
      const syncLengthControl = () => {
        lengthDisplay.textContent = lengthEl.value;
        const min = Number(lengthEl.min) || 0;
        const max = Number(lengthEl.max) || 100;
        const value = Number(lengthEl.value) || min;
        const progress = max > min
          ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100))
          : 0;
        window.KASA_SET_RUNTIME_STYLE?.(
          `password-generator-range-${lengthEl.id}`,
          `#${lengthEl.id} { --generator-range-progress: ${progress}%; }`
        );
      };
      lengthEl.addEventListener('input', syncLengthControl);
      syncLengthControl();
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
  const GENERATED_RECORD_PASSWORD_KEY = 'kasa-generated-record-password';
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

    if (empty) empty.hidden = history.length > 0;
    if (clearBtn) clearBtn.hidden = history.length === 0;

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

  const pagePasswordInput = document.getElementById('page-password');
  if (pagePasswordInput) {
    let generatedPassword = '';
    try {
      generatedPassword = sessionStorage.getItem(GENERATED_RECORD_PASSWORD_KEY) || '';
      sessionStorage.removeItem(GENERATED_RECORD_PASSWORD_KEY);
    } catch {}
    if (generatedPassword) {
      pagePasswordInput.value = generatedPassword;
      pagePasswordInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

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

  document.getElementById('modal-create-record-from-password')?.addEventListener('click', () => {
    const modal = document.getElementById('passwordGeneratorModal');
    const output = document.getElementById('modal-generated-password-display');
    if (!output?.value) modalGeneratePassword?.();
    if (!output?.value || !modal?.dataset.createRecordUrl) return;
    try {
      sessionStorage.setItem(GENERATED_RECORD_PASSWORD_KEY, output.value);
      window.location.assign(modal.dataset.createRecordUrl);
    } catch {
      showWarningToast(window._('İşlem tamamlanamadı.'));
    }
  });

  // ─── 9. INDEX SAYFASI ─────────────────────────────────────────────────────

  if (document.getElementById('card-container')) {

    const cardContainer = document.getElementById('card-container');
    const searchInput   = document.getElementById('search-input');
    const categoryBtns  = document.querySelectorAll('#category-filter button');
    const filterEmptyState = document.getElementById('filter-empty-state');
    const paginationNav = document.getElementById('card-pagination');
    const paginationSummary = document.getElementById('card-pagination-summary');
    const pagePrevButton = document.getElementById('card-page-prev');
    const pageNextButton = document.getElementById('card-page-next');
    const pageNumbers = document.getElementById('card-page-numbers');
    const pageJumpInput = document.getElementById('card-page-input');
    const pageJumpButton = document.getElementById('card-page-go');
    const CARD_PAGE_SIZE = 50;
    let currentCardPage = 1;
    let currentCardPageCount = 1;
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

    const goToCardPage = (requestedPage) => {
      const normalizedPage = String(requestedPage ?? '').trim();
      const numericPage = Number(normalizedPage);
      const validPage = normalizedPage
        && Number.isInteger(numericPage)
        && numericPage >= 1
        && numericPage <= currentCardPageCount;
      if (!validPage) {
        pageJumpInput?.classList.add('kasa-field-invalid');
        pageJumpInput?.setAttribute('aria-invalid', 'true');
        pageJumpInput?.focus();
        pageJumpInput?.select();
        showWarningToast(
          `${window._('Geçersiz sayfa.')} ${window._('Geçerli sayfa aralığı:')} 1–${currentCardPageCount}.`
        );
        return;
      }

      currentCardPage = numericPage;
      if (pageJumpInput) {
        pageJumpInput.value = '';
        pageJumpInput.classList.remove('kasa-field-invalid');
        pageJumpInput.removeAttribute('aria-invalid');
      }
      filterCards({ preservePage: true, animate: true, scrollToGrid: true });
    };

    const setCardVisible = (wrapper, visible, animate = false) => {
      const wasHidden = wrapper.hidden;
      wrapper.hidden = !visible;

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
      button.addEventListener('click', () => goToCardPage(page));
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

      const shouldShow = matchedCount > CARD_PAGE_SIZE;
      paginationNav.hidden = !shouldShow;
      currentCardPageCount = pageCount;
      if (pageJumpInput) pageJumpInput.max = String(pageCount);
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
        const reduceMotion = document.documentElement.getAttribute('data-kasa-animations') === 'off'
          || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        document.getElementById('card-container')?.scrollIntoView({
          behavior: reduceMotion ? 'auto' : 'smooth',
          block: 'start',
        });
      }
    };

    const animateCategoryTransition = (activeButton) => {
      activeButton.classList.remove('filter-activating');
      void activeButton.offsetWidth;
      activeButton.classList.add('filter-activating');
      activeButton.addEventListener('animationend', () => {
        activeButton.classList.remove('filter-activating');
      }, { once: true });

      const motionDisabled = document.documentElement.dataset.kasaMotion === 'off'
        || document.documentElement.dataset.kasaAnimations === 'off'
        || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!cardContainer || motionDisabled) return;
      cardContainer.getAnimations().forEach(animation => animation.cancel());
      cardContainer.animate(
        [
          { opacity: 0.68, transform: 'translateY(5px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        { duration: 240, easing: 'cubic-bezier(0.16,1,0.3,1)' },
      );
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
      goToCardPage(currentCardPage - 1);
    });

    pageNextButton?.addEventListener('click', () => {
      goToCardPage(currentCardPage + 1);
    });

    const submitPageJump = () => goToCardPage(pageJumpInput?.value);
    pageJumpButton?.addEventListener('click', submitPageJump);
    pageJumpInput?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      submitPageJump();
    });
    pageJumpInput?.addEventListener('input', () => {
      pageJumpInput.classList.remove('kasa-field-invalid');
      pageJumpInput.removeAttribute('aria-invalid');
    });

    categoryBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('active')) return;
        categoryBtns.forEach(b => {
          b.classList.remove('active', 'btn-primary');
          b.classList.add('btn-outline-secondary');
          b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.remove('btn-outline-secondary');
        btn.classList.add('active', 'btn-primary');
        btn.setAttribute('aria-pressed', 'true');
        filterCards({ preservePage: false, animate: false });
        animateCategoryTransition(btn);
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
          data.forEach((item, index) => {
            const div = document.createElement('div');
            div.className = `list-group-item history-entry history-delay-${Math.min(index, 8)}`;

            const header = document.createElement('div');
            header.className = 'history-entry-header';
            const time = document.createElement('small');
            time.className = 'history-entry-time';
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
            toggleBtn.classList.add('history-icon-btn');
            toggleBtn.addEventListener('click', () => {
              const hidden = input.type === 'password';
              input.type = hidden ? 'text' : 'password';
              toggleBtn.querySelector('i').className =
                hidden ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
            });

            const copyBtn = createIconButton(window._('Kopyala'), 'fa-solid fa-copy');
            copyBtn.addEventListener('click', () => copyToClipboard(input.value, copyBtn.querySelector('i')));
            copyBtn.classList.add('history-icon-btn', 'copy-btn-history');

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
        popup.classList.add('kasa-swal-enter');
        container.classList.add('kasa-swal-container');
      },
      didOpen: (popup, container) => {
        void container.offsetHeight;
        popup.classList.add('is-open');
        container.classList.add('is-open');
      },
      willClose: (popup, container, done) => {
        popup.classList.add('is-closing');
        container.classList.add('is-closing');
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
        wrapper?.classList.add('is-removing');
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
            ...TOAST_BASE,
            text: window._('Kayıt başarıyla silindi.'),
            duration: 2500,
            className: 'kasa-toast kasa-toast-warning',
          });
        } catch {
          wrapper?.classList.remove('is-removing');
          showWarningToast(window._('Silme işlemi başarısız oldu.'));
        }
      });
    });

    // Pin Toggle
    document.querySelectorAll('.pin-form').forEach(form => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const icon = form.querySelector('.card-star-icon');
        const button = form.querySelector('.card-star-btn');
        const wrapper = form.closest('.card-wrapper');
        if (!icon || !button || !wrapper || form.dataset.pending === 'true') return;

        const originalPinned = wrapper.dataset.pinned === 'true';
        const applyPinnedState = (isPinned, animate = true) => {
          wrapper.dataset.pinned = String(isPinned);
          icon.className = isPinned
            ? 'fa-solid fa-star card-star-icon'
            : 'fa-regular fa-star card-star-icon card-star-unpinned';
          icon.classList.toggle('is-pinned', isPinned);
          button.setAttribute('aria-pressed', String(isPinned));
          button.classList.remove('is-favoriting', 'is-unfavoriting');
          if (animate) {
            void button.offsetWidth;
            button.classList.add(isPinned ? 'is-favoriting' : 'is-unfavoriting');
            window.setTimeout(() => {
              button.classList.remove('is-favoriting', 'is-unfavoriting');
            }, 560);
          }
          updateCachedCard(wrapper);
        };

        const refreshFavoritesFilter = () => {
          const activeButton = document.querySelector('#category-filter button.active');
          if (activeButton?.dataset.filter === 'favorites') {
            filterCards({ preservePage: true, animate: true });
          }
        };

        form.dataset.pending = 'true';
        applyPinnedState(!originalPinned);
        refreshFavoritesFilter();
        try {
          const response = await apiFetch(form.action, { method: 'POST' });
          if (!response?.ok) throw new Error('pin-failed');
        } catch {
          applyPinnedState(originalPinned, false);
          refreshFavoritesFilter();
          showWarningToast(window._('İşlem tamamlanamadı.'));
        } finally {
          delete form.dataset.pending;
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

      if (urlGroup)      urlGroup.hidden      = kayitTipiSelect.value !== 'Website';
      if (loginGroup)    loginGroup.hidden    = !config.showLogin;
      if (passwordGroup) passwordGroup.hidden = !config.showPassword;
      if (kategoriGroup) kategoriGroup.hidden = !config.showKategori;
      if (strengthCard)  strengthCard.hidden  = !config.showPassword;
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
