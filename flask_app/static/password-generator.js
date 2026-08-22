/**
 * ŞifreKasam v2.7.0-beta.2 - Şifre Üretici modülü (ES Module)
 *
 * 8. ve 8b. bölümler: şifre üretici ve üretici geçmişi.
 * app.js (main modül) içindeki DOMContentLoaded sırasında
 * initPasswordGenerator ile çağrılır; dış bağımlılıklar
 * (showWarningToast, copyToClipboard, createIcon, createIconButton) parametre olarak verilir.
 */

export function initPasswordGenerator({
  showWarningToast,
  copyToClipboard,
  createIcon,
  createIconButton,
}) {
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
      }

      const modalBar   = $('strength-bar');
      const modalLabel = $('strength-label');
      if (modalBar && modalLabel && typeof window.updateStrengthMeter === 'function')
        window.updateStrengthMeter(password, modalBar, modalLabel);

      if (typeof addToGeneratorHistory === 'function') addToGeneratorHistory(password);

      const pulseTarget = containerId === 'pageGenerator' ? targetInput : container;
      if (pulseTarget) {
        clearTimeout(generatedAnimationTimer);
        pulseTarget.classList.remove('generator-generated');
        void pulseTarget.offsetWidth;
        pulseTarget.classList.add('generator-generated');
        generatedAnimationTimer = setTimeout(() => {
          pulseTarget.classList.remove('generator-generated');
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

    if (empty) {
      if (history.length > 0) empty.classList.remove('is-visible');
      else empty.classList.add('is-visible');
    }
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
}
