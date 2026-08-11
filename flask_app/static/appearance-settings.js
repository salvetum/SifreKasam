/**
 * ŞifreKasam v2.7.0-beta.1 - Görünüm Ayarları modülü (ES Module)
 *
 * 3. bölüm: tema/efekt toggle'ları, glass kalitesi, vurgu rengi seçici,
 * chroma akcent, özel arka plan yükleme/galeri.
 * initAppearanceSettings, app.js içindeki DOMContentLoaded sırasında çağrılır;
 * ayarlar formu (bölüm 4) için gerekli referansları döndürür.
 */

export function initAppearanceSettings({
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
  initialChromaAccentEnabled,
  initialChromaAccentSpeed,
  showToast,
  showWarningToast,
  showSuccessToast,
  TOAST_BASE,
}) {
  let chromaAccentEnabled = initialChromaAccentEnabled;
  let chromaAccentSpeed = initialChromaAccentSpeed;

  const themeModeSelect = document.getElementById('theme-mode-select');
  const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const VALID_THEME_MODES = ['light', 'dark', 'system'];

  const resolveEffectiveTheme = (mode) => {
    if (mode === 'system') return systemThemeQuery.matches ? 'dark' : 'light';
    return mode === 'light' ? 'light' : 'dark';
  };

  const applyEffectiveTheme = (mode) => {
    const effective = resolveEffectiveTheme(mode);
    document.documentElement.setAttribute('data-bs-theme', effective);
    localStorage.setItem('kasa-theme', effective);
    return effective;
  };

  if (themeModeSelect) {
    let initialMode = themeModeSelect.value;
    if (!VALID_THEME_MODES.includes(initialMode)) {
      initialMode = document.documentElement.getAttribute('data-theme-mode') || 'dark';
    }
    themeModeSelect.value = initialMode;
    themeModeSelect.kasaSyncCustomSelect?.();
    applyEffectiveTheme(initialMode);
    localStorage.setItem('kasa-theme-mode', initialMode);

    themeModeSelect.addEventListener('change', () => {
      const mode = themeModeSelect.value;
      applyEffectiveTheme(mode);
      localStorage.setItem('kasa-theme-mode', mode);
      apiPost('/settings/theme-mode', { theme_mode: mode });
    });

    const syncSystemTheme = () => {
      if (themeModeSelect.value === 'system') applyEffectiveTheme('system');
    };
    if (systemThemeQuery.addEventListener) {
      systemThemeQuery.addEventListener('change', syncSystemTheme);
    } else {
      systemThemeQuery.addListener(syncSystemTheme);
    }
  }

  const glassToggle = document.getElementById('glass-effects-toggle');
  const glassQualityCard = document.getElementById('glass-quality-card');
  const glassQualitySelect = document.getElementById('glass-quality-select');
  const glassScalesCard = document.getElementById('glass-scales-card');
  let glassQualitySyncFrame = 0;

  const syncGlassQualityVisibility = (enabled, animate = true) => {
    if (!glassQualityCard) return;
    animate = animate
      && document.documentElement.getAttribute('data-kasa-animations') !== 'off'
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const shouldShow = Boolean(enabled);
    cancelAnimationFrame(glassQualitySyncFrame);
    glassQualityCard.setAttribute('aria-hidden', String(!shouldShow));
    if (glassScalesCard) {
      glassScalesCard.setAttribute('aria-hidden', String(!shouldShow));
      glassScalesCard.classList.toggle('is-no-transition', !animate);
      glassScalesCard.classList.toggle('is-collapsed', !shouldShow);
    }
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
        glassScalesCard?.classList.remove('is-no-transition');
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
  const cardSheenToggle = document.getElementById('card-sheen-toggle');
  const cardFrameToggle = document.getElementById('card-frame-toggle');
  const cardDepthToggle = document.getElementById('card-depth-toggle');
  const hardwareAccelerationToggle = document.getElementById('hardware-acceleration-toggle');

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
  setupThemeFeatureToggle(
    cardSheenToggle,
    'data-kasa-card-sheen',
    'kasa-card-sheen',
    'card_sheen_enabled'
  );
  setupThemeFeatureToggle(
    cardFrameToggle,
    'data-kasa-card-frame',
    'kasa-card-frame',
    'card_frame_enabled'
  );
  setupThemeFeatureToggle(
    cardDepthToggle,
    'data-kasa-card-depth',
    'kasa-card-depth',
    'card_depth_enabled'
  );

  if (hardwareAccelerationToggle) {
    hardwareAccelerationToggle.addEventListener('change', () => {
      const enabled = hardwareAccelerationToggle.checked;
      apiPost('/settings/hardware-acceleration', {
        hardware_acceleration_enabled: enabled,
      });
      const message = enabled
        ? window._('Donanım hızlandırma açıldı. Değişiklik yeniden başlatmada uygulanır.')
        : window._('Donanım hızlandırma kapatıldı. Görsel ve performans sorunları yaşayabilirsiniz. Değişiklik yeniden başlatmada uygulanır.');
      if (enabled) showSuccessToast(message);
      else showWarningToast(message);
    });
  }

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
  const appearanceCard = document.querySelector('.settings-appearance-card');
  const backgroundHidden = document.getElementById('background-style-hidden');
  const accentHidden = document.getElementById('accent-color-hidden');
  const chromaToggle = document.getElementById('chroma-accent-toggle');
  const chromaSpeedCard = document.getElementById('chroma-speed-card');
  const chromaSpeedSelect = document.getElementById('chroma-speed-select');
  const appearancePreview = document.getElementById('appearance-preview');
  const backgroundButtons = document.querySelectorAll('[data-background-option]');
  const accentPresetButtons = document.querySelectorAll('[data-accent-preset]');
  const currentAppearance = window.KASA_APPEARANCE || {
    accent: localStorage.getItem('kasa-accent') || '#7c6ff7',
    background: localStorage.getItem('kasa-background') || 'aurora',
  };
  const getCurrentBackground = () =>
    backgroundHidden?.value || window.KASA_APPEARANCE?.background || currentAppearance.background;
  let appearanceSaveTimer = 0;
  let accentContrastWarningTimer = 0;
  let lightAccentWarningShown = false;
  let colorPickerCloseTimer = 0;
  let chromaSpeedSyncFrame = 0;
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

  const glassBlurRange = document.getElementById('glass-blur-range');
  const glassVeilRange = document.getElementById('glass-veil-range');
  const glassBlurOutput = document.getElementById('glass-blur-output');
  const glassVeilOutput = document.getElementById('glass-veil-output');
  let glassScaleSaveTimer = 0;
  let glassScaleSyncFrame = 0;

  const clampGlassScale = (pct, max) => Math.min(max, Math.max(0, pct));

  const syncGlassScaleProgress = (range) => {
    if (!range) return;
    const min = Number(range.min) || 0;
    const max = Number(range.max) || 100;
    const value = clampGlassScale(Number(range.value) || 0, max);
    const progress = max > min ? ((value - min) / (max - min)) * 100 : 0;
    range.style.setProperty('--kasa-range-progress', progress.toFixed(1) + '%');
  };

  const updateGlassScaleBoost = (blurPct, veilPct) => {
    glassBlurOutput?.classList.toggle('is-over-boost', blurPct > 100);
    glassVeilOutput?.classList.toggle('is-over-boost', veilPct > 100);
  };

  const syncGlassScales = () => {
    const blur = clampGlassScale(Number(glassBlurRange?.value ?? 100), 150) / 100;
    const veil = clampGlassScale(Number(glassVeilRange?.value ?? 100), 200) / 100;
    document.documentElement.setAttribute('data-glass-blur', String(blur));
    document.documentElement.setAttribute('data-glass-veil', String(veil));
    document.documentElement.style.setProperty('--glass-blur-scale', String(blur));
    document.documentElement.style.setProperty('--glass-veil-scale', String(veil));
    localStorage.setItem('kasa-glass-blur', String(blur));
    localStorage.setItem('kasa-glass-veil', String(veil));
    document.dispatchEvent(new CustomEvent('kasa:glass-refresh'));
  };

  const flushGlassScaleSave = () => {
    if (glassBlurRange && glassVeilRange) {
      const blur = clampGlassScale(Number(glassBlurRange.value ?? 100), 150) / 100;
      const veil = clampGlassScale(Number(glassVeilRange.value ?? 100), 200) / 100;
      clearTimeout(glassScaleSaveTimer);
      return apiPost('/settings/appearance', { glass_blur: blur, glass_veil: veil });
    }
    return undefined;
  };

  if (glassBlurRange || glassVeilRange) {
    const readGlassScalePct = (attribute, max) => {
      const raw = document.documentElement.getAttribute(attribute);
      const number = (raw === null || raw === '') ? 1 : Number(raw);
      const normalized = Number.isFinite(number) ? number : 1;
      return clampGlassScale(Math.round(normalized * 100), max);
    };
    const initialBlurPct = readGlassScalePct('data-glass-blur', 150);
    const initialVeilPct = readGlassScalePct('data-glass-veil', 200);
    if (glassBlurRange) glassBlurRange.value = String(initialBlurPct);
    if (glassVeilRange) glassVeilRange.value = String(initialVeilPct);
    if (glassBlurOutput) glassBlurOutput.textContent = initialBlurPct + '%';
    if (glassVeilOutput) glassVeilOutput.textContent = initialVeilPct + '%';
    syncGlassScaleProgress(glassBlurRange);
    syncGlassScaleProgress(glassVeilRange);
    updateGlassScaleBoost(initialBlurPct, initialVeilPct);

    const onGlassScaleInput = () => {
      const blurPct = clampGlassScale(Number(glassBlurRange?.value ?? 100), 150);
      const veilPct = clampGlassScale(Number(glassVeilRange?.value ?? 100), 200);
      if (glassBlurOutput) glassBlurOutput.textContent = Math.round(blurPct) + '%';
      if (glassVeilOutput) glassVeilOutput.textContent = Math.round(veilPct) + '%';
      updateGlassScaleBoost(blurPct, veilPct);
      syncGlassScaleProgress(glassBlurRange);
      syncGlassScaleProgress(glassVeilRange);
      syncGlassScales();
      clearTimeout(glassScaleSaveTimer);
      glassScaleSaveTimer = setTimeout(flushGlassScaleSave, 400);
    };
    glassBlurRange?.addEventListener('input', onGlassScaleInput);
    glassVeilRange?.addEventListener('input', onGlassScaleInput);
    syncGlassScales();
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

  let appearanceSavePromise = null;

  const queueAppearanceSave = (accent, background) => {
    clearTimeout(appearanceSaveTimer);
    appearanceSaveTimer = setTimeout(() => {
      appearanceSavePromise = apiPost('/settings/appearance', {
        accent_color: accent,
        background_style: background,
        chroma_accent_enabled: chromaAccentEnabled,
        chroma_accent_speed: chromaAccentSpeed,
        animated_backgrounds_enabled: motionToggle?.checked ?? themeFeatureEnabled('data-kasa-motion'),
        interface_animations_enabled: interfaceAnimationsToggle?.checked ?? themeFeatureEnabled('data-kasa-animations'),
        gradients_enabled: gradientsToggle?.checked ?? themeFeatureEnabled('data-kasa-gradient'),
        card_sheen_enabled: cardSheenToggle?.checked ?? themeFeatureEnabled('data-kasa-card-sheen'),
        card_frame_enabled: cardFrameToggle?.checked ?? themeFeatureEnabled('data-kasa-card-frame'),
        card_depth_enabled: cardDepthToggle?.checked ?? themeFeatureEnabled('data-kasa-card-depth'),
      }).finally(() => { appearanceSavePromise = null; });
    }, 250);
  };

  const flushAppearanceSave = () => {
    clearTimeout(appearanceSaveTimer);
    if (appearanceSavePromise) return appearanceSavePromise;
    const accent = accentInput?.value || currentAppearance.accent;
    const background = backgroundHidden?.value || currentAppearance.background;
    appearanceSavePromise = apiPost('/settings/appearance', {
      accent_color: accent,
      background_style: background,
      chroma_accent_enabled: chromaAccentEnabled,
      chroma_accent_speed: chromaAccentSpeed,
      animated_backgrounds_enabled: motionToggle?.checked ?? themeFeatureEnabled('data-kasa-motion'),
      interface_animations_enabled: interfaceAnimationsToggle?.checked ?? themeFeatureEnabled('data-kasa-animations'),
      gradients_enabled: gradientsToggle?.checked ?? themeFeatureEnabled('data-kasa-gradient'),
      card_sheen_enabled: cardSheenToggle?.checked ?? themeFeatureEnabled('data-kasa-card-sheen'),
      card_frame_enabled: cardFrameToggle?.checked ?? themeFeatureEnabled('data-kasa-card-frame'),
      card_depth_enabled: cardDepthToggle?.checked ?? themeFeatureEnabled('data-kasa-card-depth'),
    }).finally(() => { appearanceSavePromise = null; });
    return appearanceSavePromise;
  };

  const cancelPendingAppearanceSave = () => {
    clearTimeout(appearanceSaveTimer);
    clearTimeout(glassScaleSaveTimer);
  };

  const syncChromaSpeedVisibility = (enabled, animate = true) => {
    if (!chromaSpeedCard) return;
    const shouldAnimate = animate
      && document.documentElement.getAttribute('data-kasa-animations') !== 'off'
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const shouldShow = Boolean(enabled);
    cancelAnimationFrame(chromaSpeedSyncFrame);
    chromaSpeedCard.setAttribute('aria-hidden', String(!shouldShow));

    if (chromaSpeedSelect) {
      chromaSpeedSelect.disabled = !shouldShow;
      chromaSpeedSelect.tabIndex = chromaSpeedSelect.dataset.customSelectReady === 'true'
        ? -1
        : (shouldShow ? 0 : -1);
      chromaSpeedSelect.kasaSyncCustomSelect?.();
    }

    chromaSpeedCard.classList.toggle('is-no-transition', !shouldAnimate);
    chromaSpeedCard.classList.toggle('is-collapsed', !shouldShow);
    if (!shouldAnimate) {
      chromaSpeedSyncFrame = requestAnimationFrame(() => {
        chromaSpeedCard.classList.remove('is-no-transition');
      });
    }
  };

  const setChromaAccentPreference = (enabled, speed = chromaAccentSpeed, persist = true, animate = true) => {
    const next = window.KASA_SET_CHROMA_ACCENT?.(enabled, speed) || {
      enabled: Boolean(enabled),
      speed: normalizeChromaSpeed(speed),
    };
    chromaAccentEnabled = next.enabled;
    chromaAccentSpeed = next.speed;

    if (chromaToggle) chromaToggle.checked = next.enabled;
    if (chromaSpeedSelect) {
      chromaSpeedSelect.value = String(next.speed);
      chromaSpeedSelect.kasaSyncCustomSelect?.();
    }
    syncChromaSpeedVisibility(next.enabled, animate);

    if (appearanceCard) {
      appearanceCard.classList.toggle('is-chroma-locked', next.enabled);
      accentPresetButtons.forEach(btn => { btn.disabled = next.enabled; });
      if (accentColorTrigger) accentColorTrigger.disabled = next.enabled;
      if (next.enabled) setColorPickerOpen(false);
    }

    if (persist) {
      queueAppearanceSave(
        accentInput?.value || currentAppearance.accent,
        getCurrentBackground()
      );
    }
  };

  const updateAppearance = (accent, background, persist = true, preservePickerState = false) => {
    const next = applyAppearance(accent, background);
    syncAppearanceControls(next.accent, next.background, preservePickerState);
    queueAccentContrastWarning(next.accent);
    if (persist) queueAppearanceSave(next.accent, next.background);
  };

  if (accentInput || accentTextInput || backgroundHidden || backgroundButtons.length) {
    syncAppearanceControls(currentAppearance.accent, currentAppearance.background);
    applyAppearance(currentAppearance.accent, currentAppearance.background, false);
    setChromaAccentPreference(chromaAccentEnabled, chromaAccentSpeed, false, false);

    chromaToggle?.addEventListener('change', () => {
      setChromaAccentPreference(chromaToggle.checked, chromaSpeedSelect?.value);
    });
    chromaSpeedSelect?.addEventListener('change', () => {
      setChromaAccentPreference(chromaToggle?.checked ?? chromaAccentEnabled, chromaSpeedSelect.value);
    });

    appearanceCard?.addEventListener('click', (event) => {
      if (!appearanceCard.classList.contains('is-chroma-locked')) return;
      if (event.target.closest('.settings-card-head')) return;
      event.preventDefault();
      showWarningToast(window._('Önce Chroma RGB efektini kapatın'));
    });

    accentColorTrigger?.addEventListener('click', () => {
      setColorPickerOpen(accentColorTrigger.getAttribute('aria-expanded') !== 'true');
    });
    accentColorScrim?.addEventListener('click', () => setColorPickerOpen(false));
    accentColorClose?.addEventListener('click', () => setColorPickerOpen(false));
    accentColorReset?.addEventListener('click', () => {
      updateAppearance(
        accentColorReset.dataset.defaultAccent || '#7c6ff7',
        getCurrentBackground()
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
          getCurrentBackground(),
          true,
          true
        );
      });
    });
    accentTextInput?.addEventListener('input', () => {
      if (/^#?[0-9a-fA-F]{6}$/.test(accentTextInput.value.trim())) {
        updateAppearance(
          accentTextInput.value,
          getCurrentBackground()
        );
      }
    });
    accentTextInput?.addEventListener('change', () => {
      const fallback = accentInput?.value || currentAppearance.accent;
      updateAppearance(
        normalizeHexColor(accentTextInput.value, fallback),
        getCurrentBackground()
      );
    });
    accentPresetButtons.forEach(btn => {
      btn.addEventListener('click', () =>
        updateAppearance(btn.dataset.accentPreset, getCurrentBackground())
      );
    });
    backgroundButtons.forEach(btn => {
      if (btn.id === 'custom-bg-btn') return;
      btn.addEventListener('click', () =>
        updateAppearance(
          accentInput?.value || currentAppearance.accent,
          btn.dataset.backgroundOption,
          true,
          true
        )
      );
    });

    // ── Özel Arka Plan Yükleme ──
    const customBgBtn = document.getElementById('custom-bg-btn');
    const customBgInput = document.getElementById('custom-bg-input');
    if (customBgBtn && customBgInput) {
      customBgBtn.addEventListener('click', () => customBgInput.click());
      customBgInput.addEventListener('change', async () => {
        const file = customBgInput.files?.[0];
        if (!file) return;
        const formData = new FormData();
        formData.append('file', file);
        customBgBtn.disabled = true;
        showToast({
          ...TOAST_BASE,
          text: '<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> ' + window._('Yükleniyor...'),
          escapeHTML: false,
          duration: 30000,
          className: 'kasa-toast kasa-toast-info',
        });
        try {
          const resp = await apiFetch('/api/background/upload', { method: 'POST', body: formData });
          if (!resp || !resp.ok) {
            const data = await resp?.json?.().catch(() => ({}));
            showWarningToast(window._(data?.error || 'Yükleme başarısız oldu.'));
            return;
          }
          const data = await resp.json();
          const customLayer = document.getElementById('custom-bg-layer');
          const applyUploaded = () => {
            if (customLayer && data.url) {
              customLayer.setAttribute('data-bg-url', data.url);
              if (data.is_gif) customLayer.setAttribute('data-animated', 'true');
              else customLayer.removeAttribute('data-animated');
              customLayer.classList.add('is-active');
            }
            updateAppearance(accentInput?.value || currentAppearance.accent, 'custom', true, true);
            showSuccessToast(window._('Arka plan güncellendi.'));
            refreshCustomBgGallery();
          };
          if (customLayer && data.url) {
            const preloadImg = new Image();
            preloadImg.onload = applyUploaded;
            preloadImg.onerror = applyUploaded;
            preloadImg.src = data.url;
          } else {
            applyUploaded();
          }
        } catch {
          showWarningToast(window._('Yükleme başarısız oldu.'));
        } finally {
          customBgBtn.disabled = false;
          customBgInput.value = '';
        }
      });
    }

    // ── Özel Arka Plan Galerisi ──
    const customBgGallery = document.getElementById('custom-bg-gallery');
    const customBgGalleryGrid = document.getElementById('custom-bg-gallery-grid');
    const customBgGalleryClear = document.getElementById('custom-bg-gallery-clear');

    const refreshCustomBgGallery = async () => {
      if (!customBgGallery || !customBgGalleryGrid) return;
      const resp = await apiFetch('/api/background/history');
      if (!resp?.ok) {
        customBgGallery.classList.add('hidden');
        return;
      }
      const data = await resp.json();
      const entries = Array.isArray(data.entries) ? data.entries : [];

      if (entries.length === 0) {
        customBgGallery.classList.add('hidden');
        return;
      }
      customBgGallery.classList.remove('hidden');
      customBgGalleryGrid.replaceChildren();

      const formatBytes = (bytes) => {
        if (!Number.isFinite(bytes) || bytes <= 0) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      };

      const makeThumb = (item) => {
        const wrap = document.createElement('div');
        wrap.className = 'custom-bg-thumb' + (item.is_active ? ' is-active' : '');
        wrap.setAttribute('role', 'button');
        wrap.setAttribute('tabindex', '0');
        wrap.setAttribute('aria-label', item.is_active
          ? window._('Aktif')
          : window._('Bu arkaplanı aktifleştir'));

        const photo = document.createElement('div');
        photo.className = 'custom-bg-thumb-photo';
        wrap.appendChild(photo);

        const img = document.createElement('img');
        img.src = item.url;
        img.alt = '';
        img.loading = 'lazy';
        photo.appendChild(img);

        const fileTypeLabel = (mime) => {
          const map = {
            'image/jpeg': 'JPEG',
            'image/png': 'PNG',
            'image/webp': 'WebP',
            'image/gif': 'GIF',
          };
          return map[mime] || (mime ? String(mime).split('/').pop().toUpperCase() : '');
        };

        const label = document.createElement('div');
        label.className = 'custom-bg-thumb-label';

        const tooltipText = [
          fileTypeLabel(item.mime),
          formatBytes(item.size),
          item.width && item.height ? item.width + '×' + item.height : '',
        ].filter(Boolean).join(' · ');
        if (tooltipText) {
          const tooltip = document.createElement('span');
          tooltip.className = 'custom-bg-thumb-tooltip';
          tooltip.textContent = tooltipText;
          label.appendChild(tooltip);
        }

        if (item.is_active) {
          const badge = document.createElement('span');
          badge.className = 'custom-bg-thumb-badge';
          badge.textContent = window._('Aktif');
          label.appendChild(badge);
        }
        wrap.appendChild(label);

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'custom-bg-thumb-del';
        del.setAttribute('aria-label', window._('Bu arkaplanı sil'));
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-xmark';
        del.appendChild(icon);
        photo.appendChild(del);

        const activate = async () => {
          if (!item.is_active) {
            const actResp = await apiFetch(
              `/api/background/history/${encodeURIComponent(item.id)}/activate`,
              { method: 'POST' }
            );
            if (!actResp?.ok) {
              showWarningToast(window._('Arkaplan aktifleştirilmedi.'));
              return;
            }
            const actData = await actResp.json();
            const layer = document.getElementById('custom-bg-layer');
            if (layer && actData.url) {
              const applyActivated = () => {
                layer.setAttribute('data-bg-url', actData.url);
                if (actData.is_gif) layer.setAttribute('data-animated', 'true');
                else layer.removeAttribute('data-animated');
                layer.classList.add('is-active');
                updateAppearance(accentInput?.value || currentAppearance.accent, 'custom', true, true);
                showSuccessToast(window._('Arkaplan aktifleştirildi.'));
              };
              const preloadImg = new Image();
              preloadImg.onload = applyActivated;
              preloadImg.onerror = applyActivated;
              preloadImg.src = actData.url;
            } else {
              showSuccessToast(window._('Arkaplan aktifleştirildi.'));
            }
          }
          refreshCustomBgGallery();
        };

        const remove = async () => {
          const delResp = item.is_active
            ? await apiFetch('/api/background', { method: 'DELETE' })
            : await apiFetch(`/api/background/history/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
          if (!delResp?.ok) {
            showWarningToast(window._('Silme işlemi başarısız oldu.'));
            return;
          }
          const layer = document.getElementById('custom-bg-layer');
          if (item.is_active) {
            if (layer) {
              layer.removeAttribute('data-bg-url');
              layer.removeAttribute('data-animated');
              layer.classList.remove('is-active');
            }
            updateAppearance(accentInput?.value || currentAppearance.accent, 'aurora', true, true);
          } else {
            showSuccessToast(window._('Arkaplan silindi.'));
          }
          refreshCustomBgGallery();
        };

        const handleClick = (event) => {
          if (event.target.closest('.custom-bg-thumb-del')) return;
          activate();
        };
        wrap.addEventListener('click', handleClick);
        wrap.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleClick(event);
          }
        });
        del.addEventListener('click', (event) => {
          event.stopPropagation();
          remove();
        });

        return wrap;
      };

      entries.forEach(entry => {
        customBgGalleryGrid.appendChild(makeThumb({
          id: entry.id,
          url: entry.url,
          is_gif: entry.is_gif,
          is_active: entry.is_active,
          width: entry.width,
          height: entry.height,
          size: entry.size,
          mime: entry.mime,
        }));
      });
    };

    if (customBgGalleryClear) {
      customBgGalleryClear.addEventListener('click', async () => {
        const resp = await apiFetch('/api/background/all', { method: 'DELETE' });
        if (!resp?.ok) {
          showWarningToast(window._('Silme işlemi başarısız oldu.'));
          return;
        }
        const layer = document.getElementById('custom-bg-layer');
        if (layer) {
          layer.removeAttribute('data-bg-url');
          layer.removeAttribute('data-animated');
          layer.classList.remove('is-active');
        }
        updateAppearance(accentInput?.value || currentAppearance.accent, 'aurora', true, true);
        showSuccessToast(window._('Arkaplan silindi.'));
        refreshCustomBgGallery();
      });
    }

    refreshCustomBgGallery();

    settingsModal?.addEventListener('kasa:modal-closing', () => {
      flushAppearanceSave();
      flushGlassScaleSave();
      setColorPickerOpen(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && accentColorTrigger?.getAttribute('aria-expanded') === 'true') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setColorPickerOpen(false);
        accentColorTrigger.focus({ preventScroll: true });
      }
    });
  }

  return {
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
    hardwareAccelerationToggle,
    updateAppearance,
    cancelPendingAppearanceSave,
  };

}