/**
 * ŞifreKasam v2.6.3-beta.3 - Şifre Gücü modülü (ES Module)
 *
 * 7. bölüm: window.updateStrengthMeter ve sayfa şifresi güç göstergesi.
 * initPasswordStrength, app.js içindeki DOMContentLoaded sırasında çağrılır.
 */

export function initPasswordStrength({ apiJson }) {

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
    { className: 'strength-level-0', textKey: 'Çok Zayıf' },
    { className: 'strength-level-1', textKey: 'Zayıf' },
    { className: 'strength-level-2', textKey: 'Orta' },
    { className: 'strength-level-3', textKey: 'Güçlü' },
    { className: 'strength-level-4', textKey: 'Çok Güçlü' },
  ];
  const STRENGTH_CLASS_NAMES = STRENGTH_LEVELS.map(level => level.className);
  const STRENGTH_REQUIREMENT_LABELS = {
    min_length: 'en az 12 karakter',
    lowercase: 'küçük harf',
    uppercase: 'büyük harf',
    number: 'sayı',
    symbol: 'sembol',
  };
  const strengthMeterStates = new WeakMap();

  window.updateStrengthMeter = (password, barEl, labelEl, userInputs = [], options = {}) => {
    if (!barEl || !labelEl) return;
    const previousState = strengthMeterStates.get(labelEl);
    if (previousState?.timer) clearTimeout(previousState.timer);
    const requestId = (previousState?.requestId || 0) + 1;
    barEl.classList.remove(...STRENGTH_CLASS_NAMES);
    if (!password) {
      labelEl.innerText = '';
      strengthMeterStates.set(labelEl, { requestId, timer: 0 });
      return;
    }

    labelEl.innerText = window._('Analiz hazırlanıyor…');
    const timer = setTimeout(async () => {
      try {
        const result = await apiJson('/api/password-strength', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            password,
            user_inputs: Array.isArray(userInputs) ? userInputs : [],
          }),
        });
        if (strengthMeterStates.get(labelEl)?.requestId !== requestId) return;
        if (typeof options.onResult === 'function') options.onResult();

        const score = Math.max(0, Math.min(4, Number(result.score) || 0));
        const level = STRENGTH_LEVELS[score];
        const rawCrackTime = String(result.crack_time || '');
        const crackTime = window.LANG === 'tr'
          ? translateTime(rawCrackTime)
          : rawCrackTime;
        const missingRequirements = Array.isArray(result.missing_requirements)
          ? result.missing_requirements
            .map(requirement => STRENGTH_REQUIREMENT_LABELS[requirement])
            .filter(Boolean)
          : [];

        barEl.classList.add(level.className);
        if (missingRequirements.length && score < 3) {
          const missingLabels = missingRequirements
            .map(requirement => window._(requirement))
            .join(', ');
          labelEl.innerText = `${window._(level.textKey)} · ${window._('Eksik:')} ${missingLabels}`;
        } else {
          labelEl.innerText = crackTime
            ? `${window._(level.textKey)} · ${window._('tahmini dayanım:')} ${crackTime}`
            : window._(level.textKey);
        }
      } catch {
        if (strengthMeterStates.get(labelEl)?.requestId !== requestId) return;
        labelEl.innerText = window._('Analiz kullanılamıyor');
      }
    }, 120);

    strengthMeterStates.set(labelEl, { requestId, timer });
  };

  const pagePassword  = document.getElementById('page-password');
  const strengthBar   = document.getElementById('password-strength-bar');
  const strengthText  = document.getElementById('password-strength-text');
  if (pagePassword && strengthBar && strengthText) {
    const strengthContextFields = ['isim', 'login', 'website_url']
      .map(fieldId => document.getElementById(fieldId))
      .filter(Boolean);

    const CONTEXT_TOKEN_SPLIT = /[^0-9A-Za-zÇĞİÖŞÜçğıöş]+/;

    const contextVariants = (value) => {
      const text = String(value || '').trim().slice(0, 200);
      if (!text) return [];
      const variants = new Set([text]);
      const raw = text.includes('://') ? text : `//${text}`;
      let hostname = '';
      try {
        hostname = new URL(raw, 'http://base.invalid').hostname || '';
      } catch (e) { /* keep empty */ }
      if (hostname) {
        variants.add(hostname);
        for (const part of hostname.split('.')) variants.add(part);
      }
      const atIndex = text.indexOf('@');
      if (atIndex !== -1) {
        const local = text.slice(0, atIndex);
        const domain = text.slice(atIndex + 1);
        if (local) variants.add(local);
        if (domain) variants.add(domain);
      }
      for (const token of text.split(CONTEXT_TOKEN_SPLIT)) {
        if (token.length >= 3) variants.add(token);
      }
      return [...variants];
    };

    const contextMatchesPassword = (password, value) => {
      const foldedPassword = password.toLowerCase();
      return contextVariants(value).some(
        variant => variant.toLowerCase() && foldedPassword.includes(variant.toLowerCase()),
      );
    };

    const contextInputs = () =>
      strengthContextFields
        .map(field => field.value)
        .filter(Boolean);

    const contextHasMatch = (password) =>
      contextInputs().some(value => contextMatchesPassword(password, value));

    let lastContextMatched = false;
    let lastAppliedKey = '';

    const updatePagePasswordStrength = (skipIfUnchanged = false) => {
      const password = pagePassword.value;
      const userInputs = contextInputs();
      const inputKey = userInputs.slice().sort().join('\u0001');
      const strengthKey = password + '\u0001' + inputKey;
      if (lastAppliedKey && strengthKey === lastAppliedKey) return;
      const matched = contextHasMatch(password);
      if (skipIfUnchanged && !matched && !lastContextMatched) {
        return;
      }
      window.updateStrengthMeter(
        password,
        strengthBar,
        strengthText,
        userInputs,
        {
          onResult: () => {
            lastContextMatched = matched;
            lastAppliedKey = strengthKey;
          },
        },
      );
    };

    pagePassword.addEventListener('input', () => updatePagePasswordStrength(false));
    strengthContextFields.forEach(field => {
      field.addEventListener('input', () => {
        if (pagePassword.value) updatePagePasswordStrength(true);
      });
    });
    updatePagePasswordStrength();
  }
}