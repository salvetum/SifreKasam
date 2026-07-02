/**
 * ŞifreKasam v2.2 - Main JavaScript
 */

document.addEventListener('DOMContentLoaded', () => {

  // ─── SABİTLER & YARDIMCILAR ───────────────────────────────────────────────

  const glassEffectsEnabled = () =>
    document.documentElement.getAttribute('data-glass-effects') !== 'off';

  const apiFetch = (path, opts = {}) =>
    fetch(path, {
      ...opts,
      headers: { ...opts.headers },
    }).catch(() => {});

  const apiPost = (path, body) =>
    apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

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

  // ─── 1. HEARTBEAT ─────────────────────────────────────────────────────────

  const sendHeartbeat = () => apiFetch('/heartbeat', { method: 'POST' });
  sendHeartbeat();
  setInterval(sendHeartbeat, 5000);

  // ─── 2. SAYFA GEÇİŞ OVERLAY ───────────────────────────────────────────────

  document.querySelectorAll('[data-loading-form]').forEach(form => {
    form.addEventListener('submit', () => {
      document.body.classList.add('is-page-loading');
      form.querySelectorAll('button, input, select, textarea')
          .forEach(el => el.setAttribute('aria-disabled', 'true'));
    });
  });

  document.addEventListener('click', (e) => {
    const href = e.target.closest('a')?.getAttribute('href');
    if (!href) return;
    const isInternal = href !== '#'
      && !href.startsWith('javascript:')
      && !href.startsWith('http')
      && !e.target.closest('[data-no-loading]');
    if (isInternal) document.body.classList.add('is-page-loading');
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
  if (glassToggle) {
    glassToggle.checked =
      document.documentElement.getAttribute('data-glass-effects') !== 'off';

    glassToggle.addEventListener('change', () => {
      const value = glassToggle.checked ? 'on' : 'off';
      document.documentElement.setAttribute('data-glass-effects', value);
      localStorage.setItem('kasa-glass-effects', value);
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
      btn.classList.toggle('is-active', btn.dataset.backgroundOption === background);
    });
    accentPresetButtons.forEach(btn => {
      btn.classList.toggle(
        'is-active',
        normalizeHexColor(btn.dataset.accentPreset) === normalizeHexColor(accent)
      );
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

  function fetchLanInfo() {
    if (!lanAddress) return;
    lanAddress.textContent = window._('Yükleniyor...');
    fetch('/api/lan-info')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ips && data.ips.length > 0) {
          lanAddress.textContent = (data.ssl ? 'https://' : 'http://') + data.ips[0] + ':' + data.port;
        } else {
          lanAddress.textContent = window._('Ağ bağlantısı bulunamadı');
        }
      })
      .catch(function () {
        lanAddress.textContent = window._('Bilgi alınamadı');
      });
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

    settingsForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const nextSnapshot = getSettingsSnapshot();
      if (nextSnapshot === settingsFormSnapshot) {
        showSuccessToast(window._('Ayarlar zaten güncel.'));
        return;
      }

      const submitButton = settingsForm.querySelector('button[type="submit"]');
      document.body.classList.add('is-page-loading');
      submitButton?.setAttribute('aria-disabled', 'true');
      if (submitButton) submitButton.disabled = true;
      clearTimeout(appearanceSaveTimer);

      fetch(settingsForm.action, {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        body: new FormData(settingsForm),
      })
        .then((response) => {
          if (!response.ok) throw new Error('settings-save-failed');
          return response.json();
        })
        .then((data) => {
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
        })
        .catch(() => {
          showWarningToast(window._('Ayarlar kaydedilemedi.'));
        })
        .finally(() => {
          document.body.classList.remove('is-page-loading');
          submitButton?.removeAttribute('aria-disabled');
          if (submitButton) submitButton.disabled = false;
        });
    });
  }

  const flashCopyIcon = (iconEl) => {
    if (!iconEl) return;
    if (!iconEl.dataset.originalClass) {
      iconEl.dataset.originalClass = iconEl.className;
    }
    clearTimeout(Number(iconEl.dataset.copyTimer || 0));
    iconEl.className = 'fa-solid fa-check text-success';
    iconEl.classList.remove('copy-flash');
    void iconEl.offsetWidth;
    iconEl.classList.add('copy-flash');
    showSuccessToast(window._('Kopyalandı!'));
    iconEl.dataset.copyTimer = String(setTimeout(() => {
      iconEl.className = iconEl.dataset.originalClass || 'fa-solid fa-copy';
      iconEl.classList.remove('copy-flash');
      delete iconEl.dataset.copyTimer;
      delete iconEl.dataset.originalClass;
    }, 1200));
  };

  const copyToClipboard = async (text, iconEl) => {
    try {
      await navigator.clipboard.writeText(text);
      flashCopyIcon(iconEl);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  // ─── 5. ŞİFRE GÖSTER / KOPYAla BUTONLARI ─────────────────────────────────

  const fetchRowPassword = async (row) => {
    const field = row?.querySelector('.password-field');
    const recordId = field?.dataset.id;
    if (!recordId) return '';
    const response = await apiFetch(`/api/record/${encodeURIComponent(recordId)}/password`);
    if (!response || !response.ok) return '';
    const data = await response.json();
    return data.password || '';
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
    requestAnimationFrame(() => modal.classList.add('is-open'));
  };

  window.kasaModalKapat = (modalId) => {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.remove('is-open');
    modal.classList.add('is-closing');
    setTimeout(() => {
      modal.classList.remove('is-visible', 'is-closing');
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

  window.updateStrengthMeter = (password, barEl, labelEl) => {
    if (!barEl || !labelEl || typeof zxcvbn === 'undefined') return;
    if (!password) {
      barEl.style.width = '0%';
      barEl.style.backgroundColor = 'transparent';
      labelEl.innerText = '';
      return;
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
      window.updateStrengthMeter(pagePassword.value, strengthBar, strengthText));
    window.updateStrengthMeter(pagePassword.value, strengthBar, strengthText);
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
        window.updateStrengthMeter(password, modalBar, modalLabel);

      if (typeof addToGeneratorHistory === 'function') addToGeneratorHistory(password);
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

    if (containerId !== 'pageGenerator') {
      try {
        generatePassword();
      } catch (err) {
        console.error('Password generation failed:', err);
      }
    }
  }

  // ─── 8b. ÜRETİCİ GEÇMİŞİ ────────────────────────────────────────────────

  const GENERATOR_HISTORY_KEY = 'kasa-generator-history';
  const MAX_HISTORY = 50;

  const getGeneratorHistory = () => {
    try {
      return JSON.parse(sessionStorage.getItem(GENERATOR_HISTORY_KEY) || '[]');
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

    list.innerHTML = '';
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

      const showBtn = document.createElement('button');
      showBtn.type = 'button';
      showBtn.className = 'gen-history-icon-btn';
      showBtn.title = window._('Göster/Gizle');
      showBtn.innerHTML = '<i class="fa-solid fa-eye"></i>';
      showBtn.addEventListener('click', () => {
        const hidden = pwInput.type === 'password';
        pwInput.type = hidden ? 'text' : 'password';
        showBtn.querySelector('i').className = hidden ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
      });

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'gen-history-icon-btn';
      copyBtn.title = window._('Kopyala');
      copyBtn.innerHTML = '<i class="fa-solid fa-copy"></i>';
      copyBtn.addEventListener('click', () => copyToClipboard(item.password, copyBtn.querySelector('i')));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'gen-history-icon-btn gen-history-del-btn';
      delBtn.title = window._('Sil');
      delBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
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
      meta.innerHTML = `<span><i class="fa-regular fa-clock"></i> ${dateStr}</span><span>${item.length} ${window._('karakter')}</span>`;

      div.append(info, meta);
      list.appendChild(div);
    });
  };

  const clearGeneratorHistory = () => {
    saveGeneratorHistory([]);
    renderGeneratorHistory();
  };

  document.getElementById('generator-history-clear')?.addEventListener('click', clearGeneratorHistory);

  document.querySelector('[data-kasa-modal="passwordGeneratorModal"]')?.addEventListener('click', () => {
    setTimeout(renderGeneratorHistory, 50);
  });

  const genModalObserver = new MutationObserver(() => {
    const modal = document.getElementById('passwordGeneratorModal');
    if (modal?.classList.contains('is-visible')) renderGeneratorHistory();
  });
  const genModal = document.getElementById('passwordGeneratorModal');
  if (genModal) genModalObserver.observe(genModal, { attributes: true, attributeFilter: ['class'] });

  setupPasswordGenerator('passwordGeneratorModal', 'modal-');
  setupPasswordGenerator('pageGenerator', 'page-');

  const modalCopyGenBtn = document.getElementById('modal-copy-generated-password-btn');
  modalCopyGenBtn?.addEventListener('click', () => {
    const val = document.getElementById('modal-generated-password-display')?.value;
    if (val) copyToClipboard(val, modalCopyGenBtn.querySelector('i'));
  });

  // ─── 9. INDEX SAYFASI ─────────────────────────────────────────────────────

  if (document.getElementById('card-container')) {

    const searchInput   = document.getElementById('search-input');
    const categoryBtns  = document.querySelectorAll('#category-filter button');
    const cards         = document.querySelectorAll('.card-wrapper');

    const filterCards = () => {
      const term     = searchInput?.value.toLowerCase().trim() || '';
      const activeBtn = document.querySelector('#category-filter button.active');
      const category  = activeBtn?.dataset.filter || 'all';

      cards.forEach(wrapper => {
        const matchesSearch   = wrapper.textContent.toLowerCase().includes(term);
        const matchesCategory =
          category === 'all'       ? true :
          category === 'favorites' ? wrapper.dataset.pinned === 'true' :
                                     wrapper.dataset.type === category;
        wrapper.style.display = matchesSearch && matchesCategory ? 'block' : 'none';
      });
    };

    let searchTimeout;
    searchInput?.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(filterCards, 150);
    });

    categoryBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        categoryBtns.forEach(b => {
          b.classList.remove('active', 'btn-primary');
          b.classList.add('btn-outline-secondary');
        });
        btn.classList.remove('btn-outline-secondary');
        btn.classList.add('active', 'btn-primary');
        filterCards();
      });
    });

    // Geçmiş Modal
    const historyList = document.getElementById('history-list');
    document.querySelectorAll('.history-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const kayitId = btn.dataset.id;
        if (!kayitId) return;

        if (historyList)
          historyList.innerHTML =
            '<div class="p-3 text-center text-body-secondary">' +
            '<i class="fa-solid fa-spinner fa-spin me-2"></i>' + window._('Yükleniyor...') + '</div>';
        kasaModalAc('historyModal');

        apiFetch(`/gecmis/${kayitId}`)
          .then(r => r.json())
          .then(data => {
            if (!historyList) return;
            if (!data.length) {
              historyList.innerHTML =
                '<div class="p-3 text-center text-body-secondary">' + window._('Henüz geçmiş kaydı yok.') + '</div>';
              return;
            }

            const fragment = document.createDocumentFragment();
            data.forEach(item => {
              const div = document.createElement('div');
              div.className = 'list-group-item bg-transparent text-light border-secondary';

              const header = document.createElement('div');
              header.className = 'd-flex justify-content-between align-items-center mb-1';
              header.innerHTML =
                `<small class="text-info"><i class="fa-regular fa-clock me-1"></i>${item.date}</small>`;

              const body  = document.createElement('div');
              body.className = 'history-secret-row';

              const input = Object.assign(document.createElement('input'), {
                type: 'password', className: 'history-secret-input',
                value: item.password, readOnly: true,
              });

              const makeBtn = (title, iconClass, onClick) => {
                const b = Object.assign(document.createElement('button'), {
                  type: 'button', title,
                  className: 'card-icon-btn',
                  innerHTML: `<i class="${iconClass}"></i>`,
                });
                b.addEventListener('click', onClick);
                return b;
              };

              const toggleBtn = makeBtn(window._('Göster/Gizle'), 'fa-solid fa-eye', () => {
                const hidden = input.type === 'password';
                input.type = hidden ? 'text' : 'password';
                toggleBtn.querySelector('i').className =
                  hidden ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
              });

              const copyBtn = makeBtn(window._('Kopyala'), 'fa-solid fa-copy', () =>
                copyToClipboard(item.password, copyBtn.querySelector('i'))
              );
              copyBtn.className += ' copy-btn-history';

              body.append(input, toggleBtn, copyBtn);
              div.append(header, body);
              fragment.appendChild(div);
            });

            historyList.innerHTML = '';
            historyList.appendChild(fragment);
          })
          .catch(() => {
            if (historyList)
              historyList.innerHTML =
                '<div class="p-3 text-center text-danger">' + window._('Yükleme hatası oluştu.') + '</div>';
          });
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
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        Swal.fire({
          ...SWAL_BASE,
          title: window._('Emin misiniz?'),
          text: window._('Bu kayıt tamamen silinecek ve geri alınamaz!'),
          icon: 'warning',
          showCancelButton: true,
          confirmButtonText: window._('Evet, Sil!'),
          cancelButtonText: window._('İptal'),
        }).then(({ isConfirmed }) => {
          if (!isConfirmed) return;
          const wrapper = form.closest('.card-wrapper');
          if (wrapper) {
            Object.assign(wrapper.style, {
              transition: 'all 0.3s ease', transform: 'scale(0.95)', opacity: '0',
            });
          }
          apiFetch(form.action, { method: 'POST' })
            .then(() => {
              if (wrapper) setTimeout(() => { wrapper.remove(); filterCards(); }, 300);
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
            })
            .catch(() => {
              if (wrapper) Object.assign(wrapper.style, { transform: '', opacity: '1' });
            });
        });
      });
    });

    // Pin Toggle
    document.querySelectorAll('.pin-form').forEach(form => {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const icon = form.querySelector('i');
        if (icon) {
          icon.style.transform = 'scale(1.2)';
          setTimeout(() => { icon.style.transform = 'scale(1)'; }, 200);
        }
        apiFetch(form.action, { method: 'POST' })
          .then(() => {
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
            const activeBtn = document.querySelector('#category-filter button.active');
            if (activeBtn?.dataset.filter === 'favorites') filterCards();
          });
      });
    });

    // Tepsi Ayarı
    const trayToggle = document.getElementById('setting-minimize-to-tray');
    if (trayToggle) {
      apiFetch('/settings/tray')
        .then(r => r.json())
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
