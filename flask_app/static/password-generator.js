/**
 * ŞifreKasam v2.7.0-beta.3 - Şifre Üretici modülü (ES Module)
 *
 * 8. ve 8b. bölümler: şifre üretici ve üretici geçmişi.
 * app.js (main modül) içindeki DOMContentLoaded sırasında
 * initPasswordGenerator ile çağrılır; dış bağımlılıklar
 * (showWarningToast, copyToClipboard, createIcon, createIconButton) parametre olarak verilir.
 *
 * Revizyon: karakter tipi pill butonları, benzer karakter dışlama,
 * entropi + tahmini kırılma süresi, slot makinesi render animasyonu,
 * üret butonu sparkle, güç barı shimmer, geçmiş slide-in.
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

  // Benzer/karışıklık yaratan karakterler — seçiliyken charset'ten düşülür.
  const AMBIGUOUS_CHARS = {
    upper:   'IOZSGB',
    lower:   'lozsgb',
    numbers: '01258',
    symbols: '',
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

  const motionOff = () =>
    document.documentElement.getAttribute('data-kasa-animations') === 'off';

  const stripAmbiguous = (key) => {
    const set = CHAR_SETS[key] || '';
    const ambig = AMBIGUOUS_CHARS[key] || '';
    if (!ambig) return set;
    const ambigSet = new Set(ambig.split(''));
    return set.split('').filter((char) => !ambigSet.has(char)).join('');
  };

  const log2 = (value) => Math.log(value) / Math.LN2;

  // Tahmini kırılma süresi: 2^bit / 10.000 tahmin-saniyesi (zxcvbn standardı).
  const formatEstimate = (bits) => {
    if (!Number.isFinite(bits) || bits < 1) return window._('anında');
    const seconds = Math.pow(2, bits) / 10000;
    const minute = 60, hour = 3600, day = 86400, month = 86400 * 30, year = 86400 * 365;
    if (seconds < 1)     return window._('anında');
    if (seconds < 60)    return `${Math.ceil(seconds)} ${window._('saniye')}`;
    if (seconds < hour)  return `${Math.ceil(seconds / minute)} ${window._('dakika')}`;
    if (seconds < day)   return `${Math.ceil(seconds / hour)} ${window._('saat')}`;
    if (seconds < month) return `${Math.ceil(seconds / day)} ${window._('gün')}`;
    if (seconds < year)  return `${Math.ceil(seconds / month)} ${window._('ay')}`;
    if (seconds < year * 1000) return `${Math.ceil(seconds / year)} ${window._('yıl')}`;
    return window._('çok uzun süre');
  };

  // Slot makinesi: karakterler soldan sağa tek tek gerçek şifreye oturur.
  // Sadece görsel kare karışıklığı için Math.random; şifre kendisi kriptografik.
  const playSlotRoll = (input, finalPassword, done) => {
    if (!input) { done?.(); return null; }
    input.classList.add('is-rolling');
    const length = finalPassword.length;
    const frames = Math.max(6, Math.min(14, Math.round(length / 2) + 4));
    const noiseChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const randomNoise = () => noiseChars[Math.floor(Math.random() * noiseChars.length)];
    let frame = 0;
    const interval = setInterval(() => {
      frame++;
      const settled = Math.max(0, Math.floor((frame / frames) * length));
      let display = '';
      for (let index = 0; index < length; index++) {
        display += index < settled ? finalPassword[index] : randomNoise();
      }
      input.value = display;
      if (frame >= frames) {
        clearInterval(interval);
        input.classList.remove('is-rolling');
        input.value = finalPassword;
        done?.();
      }
    }, 28);
    return interval;
  };

  // Şifre alanına sığdır: uzun şifrelerde font, 32 karakter dahi tamamı
  // görünecek şekilde küçülür; kısa şifrelerde CSS clamp (max 1.45rem) geçerlidir.
  const fitPasswordFont = (input) => {
    if (!input || !input.classList.contains('generated-password-field')) return;
    if (!String(input.value ?? '').trim() || !input.clientWidth) {
      input.style.removeProperty('font-size');
      return;
    }
    const MAX = 1.45;
    const MIN = 0.6;
    input.style.fontSize = `${MAX}rem`;
    if (input.scrollWidth <= input.clientWidth + 2) return;
    let from = MIN;
    let to = MAX;
    for (let i = 0; i < 8; i++) {
      const mid = (from + to) / 2;
      input.style.fontSize = `${mid}rem`;
      if (input.scrollWidth <= input.clientWidth + 1) {
        from = mid;
      } else {
        to = mid;
      }
    }
    input.style.fontSize = `${Math.round(from * 100) / 100}rem`;
  };

  function setupPasswordGenerator(containerId, prefixId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const $  = (id) => document.getElementById(`${prefixId}${id}`);
    const lengthEl      = $('length');
    const lengthDisplay = $('length-display');
    const generateBtn   = $('gen-now');
    const ambiguousEl   = $('exclude-ambiguous');
    const entropyEl     = $('entropy-bits');
    const crackTimeEl   = $('crack-time');
    const strengthEmpty = $('strength-empty');
    const targetInputId = container.dataset.targetInput || 'page-password';
    let generatedAnimationTimer = null;
    let rollHandle = null;

    const charSetButtons = [...container.querySelectorAll('[data-char-set]')];
    const selectedSets = new Set(
      charSetButtons
        .filter((btn) => btn.classList.contains('is-active'))
        .map((btn) => btn.dataset.charSet),
    );

    const updateRangeFill = (rangeEl) => {
      if (!rangeEl) return;
      const min = Number(rangeEl.min) || 0;
      const max = Number(rangeEl.max) || 100;
      const value = Number(rangeEl.value) || min;
      const progress = max > min
        ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100))
        : 0;
      window.KASA_SET_RUNTIME_STYLE?.(
        `password-generator-range-${rangeEl.id}`,
        `#${rangeEl.id} { --generator-range-progress: ${progress}%; }`
      );
    };

    if (lengthEl && lengthDisplay) {
      const syncLengthControl = () => {
        lengthDisplay.textContent = lengthEl.value;
        updateRangeFill(lengthEl);
      };
      lengthEl.addEventListener('input', syncLengthControl);
      syncLengthControl();
    }

    const buildCharset = () => {
      const safeKeys = selectedSets.size ? [...selectedSets] : ['lower', 'numbers'];
      const exclude = Boolean(ambiguousEl?.checked);
      return safeKeys
        .filter((key) => CHAR_SETS[key])
        .map((key) => (exclude ? stripAmbiguous(key) : CHAR_SETS[key]))
        .filter(Boolean);
    };

    const estimateEntropyBits = () => {
      const length = Number(lengthEl?.value || '16');
      const charsetSize = buildCharset().reduce((sum, set) => sum + set.length, 0);
      return length * log2(Math.max(2, charsetSize));
    };

    const updateEntropyUI = () => {
      if (!entropyEl || !crackTimeEl) return;
      const bits = estimateEntropyBits();
      entropyEl.textContent = String(Math.round(bits));
      crackTimeEl.textContent = formatEstimate(bits);
    };

    const generatePasswordString = () => {
      const length = parseInt(lengthEl?.value || '16');
      const charsets = buildCharset();
      const safeSets = charsets.length ? charsets : [CHAR_SETS.lower, CHAR_SETS.numbers];
      const charset = safeSets.join('');
      const passwordChars = safeSets.map(pickSecureChar);

      while (passwordChars.length < length) {
        passwordChars.push(pickSecureChar(charset));
      }
      return secureShuffle(passwordChars).slice(0, length).join('');
    };

    const triggerStrengthShimmer = () => {
      ['modal-strength-bar', 'password-strength-bar'].forEach((barId) => {
        const bar = document.getElementById(barId);
        if (!bar) return;
        bar.classList.remove('strength-shimmer');
        void bar.offsetWidth;
        bar.classList.add('strength-shimmer');
        setTimeout(() => bar.classList.remove('strength-shimmer'), 720);
      });
    };

    const generatePassword = () => {
      const password = generatePasswordString();
      const targetInput = document.getElementById(targetInputId);
      const isModal = containerId === 'passwordGeneratorModal';

      clearInterval(rollHandle);
      rollHandle = null;
      if (generateBtn) {
        generateBtn.classList.remove('gen-spark');
        generateBtn.classList.remove('gen-icon-spin');
        void generateBtn.offsetWidth;
        generateBtn.classList.add('gen-spark');
        generateBtn.classList.add('gen-icon-spin');
      }

      const modalBar   = $('strength-bar');
      const modalLabel = $('strength-label');
      if (isModal && modalLabel) modalLabel.innerText = window._('Oluşturuluyor…');

      const commit = () => {
        if (targetInput) {
          targetInput.value = password;
          targetInput.dispatchEvent(new Event('input', { bubbles: true }));
          fitPasswordFont(targetInput);
        }
        if (isModal) {
          if (modalBar && modalLabel && typeof window.updateStrengthMeter === 'function')
            window.updateStrengthMeter(password, modalBar, modalLabel);
          if (strengthEmpty) strengthEmpty.hidden = true;
        }
        updateEntropyUI();
        if (typeof addToGeneratorHistory === 'function') addToGeneratorHistory(password);

        const pulseTarget = !isModal ? targetInput : container;
        if (pulseTarget) {
          clearTimeout(generatedAnimationTimer);
          pulseTarget.classList.remove('generator-generated');
          void pulseTarget.offsetWidth;
          pulseTarget.classList.add('generator-generated');
          generatedAnimationTimer = setTimeout(() => {
            pulseTarget.classList.remove('generator-generated');
          }, 520);
        }
        triggerStrengthShimmer();
        if (generateBtn) generateBtn.classList.remove('gen-spark');
      };

      try {
        if (!motionOff() && targetInput) {
          rollHandle = playSlotRoll(targetInput, password, commit);
        } else {
          commit();
        }
      } catch (err) {
        console.error('Password generation failed:', err);
        showWarningToast(window._('Güvenli rastgele üretici kullanılamıyor.'));
        if (generateBtn) {
          generateBtn.classList.remove('gen-spark');
          generateBtn.classList.remove('gen-icon-spin');
        }
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

    // İkon spin'i tam turu bitirince sınıf kendini temizler.
    generateBtn?.addEventListener('animationend', (e) => {
      if (e.animationName === 'genIconSpin') generateBtn.classList.remove('gen-icon-spin');
    });

    // Karakter tipi pill butonları — en az 1 tip seçili kalmalı
    charSetButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.charSet;
        if (selectedSets.has(key)) {
          if (selectedSets.size <= 1) {
            btn.classList.add('shake');
            setTimeout(() => btn.classList.remove('shake'), 300);
            showWarningToast(window._('En az bir karakter tipi seçilmelidir!'));
            return;
          }
          selectedSets.delete(key);
          btn.classList.remove('is-active');
          btn.setAttribute('aria-pressed', 'false');
        } else {
          selectedSets.add(key);
          btn.classList.add('is-active');
          btn.setAttribute('aria-pressed', 'true');
        }
        updateEntropyUI();
      });
    });

    // Entropi göstergesini kontrollerle canlı tut
    lengthEl?.addEventListener('input', () => updateEntropyUI());
    ambiguousEl?.addEventListener('change', () => updateEntropyUI());
    updateEntropyUI();

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
    renderGeneratorHistory(true);
  };

  const renderGeneratorHistory = (animateNew = false) => {
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
      if (animateNew && index === 0) div.classList.add('gen-history-in');

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