/**
 * ŞifreKasam v2.6.3-beta.2 - Şifre Gücü modülü (ES Module)
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

  window.updateStrengthMeter = (password, barEl, labelEl, userInputs = []) => {
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
    const updatePagePasswordStrength = () => {
      const userInputs = strengthContextFields
        .map(field => field.value)
        .filter(Boolean);
      window.updateStrengthMeter(
        pagePassword.value,
        strengthBar,
        strengthText,
        userInputs,
      );
    };

    pagePassword.addEventListener('input', updatePagePasswordStrength);
    strengthContextFields.forEach(field => {
      field.addEventListener('input', () => {
        if (pagePassword.value) updatePagePasswordStrength();
      });
    });
    updatePagePasswordStrength();
  }
}