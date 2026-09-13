/**
 * ŞifreKasam v2.7.0-beta.3 — Ekle/Düzenle takvim + son kullanma modülü (v2)
 *
 * Takvim popup, hidden↔display input senkronu, kart ay/yıl steppers,
 * yıl kısaltması genişletme ve klavye navigasyonu.
 *
 * Global arayüz:
 *   window.KASA_SYNC_CARD_EXPIRY  — kart expiry stepper'larını hidden'dan senkronla
 *   window.KASA_CLOSE_EXPIRY_POPUP — takvim popup'ı programatik kapat
 */

export function initFormCalendar() {
  const hiddenInput = document.getElementById('expiry_date');
  if (!hiddenInput) return;

  const MONTHS_TR = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
  const WEEKDAYS  = ['Pzt','Sal','Çar','Per','Cum','Cmt','Paz'];

  const displayInput   = document.getElementById('expiry_date_display');
  const wrapper        = document.getElementById('expiry-calendar-wrapper');
  const popup          = document.getElementById('expiry-calendar-popup');
  const titleEl        = document.getElementById('expiry-calendar-title');
  const weekdaysEl     = document.getElementById('expiry-calendar-weekdays');
  const gridEl         = document.getElementById('expiry-calendar-grid');
  const expiryAy       = document.getElementById('expiry_ay');
  const expiryYil      = document.getElementById('expiry_yil');

  let viewYear, viewMonth;
  let popupCloseTimer  = 0;

  /* ── Yardımcılar ──────────────────────────────────────────────── */

  function parseDate(val) {
    if (!val) return null;
    const p = val.split('-');
    return p.length === 3 ? new Date(+p[0], +p[1] - 1, +p[2]) : null;
  }

  function toISO(y, m, d) {
    return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function toDisplay(y, m, d) {
    return String(d).padStart(2, '0') + '.' + String(m + 1).padStart(2, '0') + '.' + y;
  }

  /* ── Senkronizasyon ───────────────────────────────────────────── */

  function syncDisplay() {
    const dt = parseDate(hiddenInput.value);
    displayInput.value = dt ? toDisplay(dt.getFullYear(), dt.getMonth(), dt.getDate()) : '';
  }

  function syncCardExpiryFromHidden() {
    const dt = parseDate(hiddenInput.value);
    if (expiryAy)  expiryAy.value  = dt ? String(dt.getMonth() + 1).padStart(2, '0') : '';
    if (expiryYil) expiryYil.value = dt ? String(dt.getFullYear()) : '';
  }

  function syncHiddenFromCardExpiry() {
    const ay  = parseInt(expiryAy.value, 10);
    const yil = parseInt(expiryYil.value, 10);
    if (ay >= 1 && ay <= 12 && yil >= 2000 && yil <= 2100) {
      const lastDay = new Date(yil, ay, 0).getDate();
      hiddenInput.value = yil + '-' + String(ay).padStart(2, '0') + '-' + String(lastDay).padStart(2, '0');
    } else {
      hiddenInput.value = '';
    }
    syncDisplay();
  }

  /* ── Global arayüz ────────────────────────────────────────────── */

  window.KASA_SYNC_CARD_EXPIRY  = syncCardExpiryFromHidden;
  window.KASA_CLOSE_EXPIRY_POPUP = closePopup;

  if (expiryAy)  expiryAy.addEventListener('input', syncHiddenFromCardExpiry);
  if (expiryYil) expiryYil.addEventListener('input', syncHiddenFromCardExpiry);

  /* ── Yıl kısaltması: "34" → "2034" ────────────────────────────── */

  function expandYearShorthand() {
    if (!expiryYil) return;
    const raw = expiryYil.value.trim();
    if (!/^\d{1,2}$/.test(raw)) return;
    expiryYil.value = String(2000 + parseInt(raw, 10));
    syncHiddenFromCardExpiry();
  }

  if (expiryYil) expiryYil.addEventListener('blur', expandYearShorthand);
  const ekleForm = document.getElementById('ekle-form');
  if (ekleForm) ekleForm.addEventListener('submit', expandYearShorthand, true);

  /* ── Takvim render ────────────────────────────────────────────── */

  function render() {
    titleEl.textContent = MONTHS_TR[viewMonth] + ' ' + viewYear;
    titleEl.classList.remove('kasa-calendar-title-anim');
    void titleEl.offsetWidth;
    titleEl.classList.add('kasa-calendar-title-anim');

    gridEl.textContent = '';

    const firstDay   = new Date(viewYear, viewMonth, 1).getDay();
    const startDay   = firstDay === 0 ? 6 : firstDay - 1;
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const today      = new Date();
    const selected   = parseDate(hiddenInput.value);

    for (let i = 0; i < startDay; i++) {
      const empty = document.createElement('span');
      empty.className = 'kasa-calendar-day kasa-calendar-day-empty';
      gridEl.appendChild(empty);
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'kasa-calendar-day';
      btn.textContent = d;
      btn.dataset.day = d;
      btn.tabIndex = -1;

      if (selected && viewYear === selected.getFullYear() && viewMonth === selected.getMonth() && d === selected.getDate()) {
        btn.classList.add('is-selected');
        btn.tabIndex = 0;
      }
      if (viewYear === today.getFullYear() && viewMonth === today.getMonth() && d === today.getDate()) {
        btn.classList.add('is-today');
      }

      btn.addEventListener('click', () => {
        hiddenInput.value = toISO(viewYear, viewMonth, d);
        syncDisplay();
        syncCardExpiryFromHidden();
        closePopup();
      });

      gridEl.appendChild(btn);
    }
  }

  /* ── Popup açma / kapama ──────────────────────────────────────── */

  function openPopup() {
    clearTimeout(popupCloseTimer);
    const dt = parseDate(hiddenInput.value) || new Date();
    viewYear  = dt.getFullYear();
    viewMonth = dt.getMonth();

    popup.hidden = false;
    displayInput.setAttribute('aria-expanded', 'true');
    wrapper.closest('.vault-form-panel')?.classList.add('has-open-select-layer');
    render();

    requestAnimationFrame(() => popup.classList.add('is-open'));

    const target = gridEl.querySelector('.is-selected') || gridEl.querySelector('.kasa-calendar-day:not(.kasa-calendar-day-empty)');
    if (target) {
      target.tabIndex = 0;
      target.focus();
    }
  }

  function closePopup() {
    popup.classList.remove('is-open');
    displayInput.setAttribute('aria-expanded', 'false');
    wrapper.closest('.vault-form-panel')?.classList.remove('has-open-select-layer');
    popupCloseTimer = setTimeout(() => { popup.hidden = true; }, 180);
    displayInput.focus();
  }

  /* ── Klavye navigasyonu ───────────────────────────────────────── */

  function handleGridKeydown(e) {
    const days = Array.from(gridEl.querySelectorAll('.kasa-calendar-day:not(.kasa-calendar-day-empty)'));
    const idx  = days.indexOf(document.activeElement);
    if (idx < 0) return;

    const curDay    = +days[idx].dataset.day;
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    let target = null;

    switch (e.key) {
      case 'ArrowRight': target = curDay + 1; e.preventDefault(); break;
      case 'ArrowLeft':  target = curDay - 1; e.preventDefault(); break;
      case 'ArrowDown':  target = curDay + 7; e.preventDefault(); break;
      case 'ArrowUp':    target = curDay - 7; e.preventDefault(); break;
      case 'Home':       target = 1; e.preventDefault(); break;
      case 'End':        target = daysInMonth; e.preventDefault(); break;

      case 'PageUp':
        viewMonth--;
        if (viewMonth < 0) { viewMonth = 11; viewYear--; }
        render();
        focusFirstDay();
        e.preventDefault();
        return;

      case 'PageDown':
        viewMonth++;
        if (viewMonth > 11) { viewMonth = 0; viewYear++; }
        render();
        focusFirstDay();
        e.preventDefault();
        return;

      case 'Enter': case ' ':
        e.preventDefault();
        if (document.activeElement?.dataset.day) {
          hiddenInput.value = toISO(viewYear, viewMonth, +document.activeElement.dataset.day);
          syncDisplay();
          syncCardExpiryFromHidden();
          closePopup();
        }
        return;

      default: return;
    }

    if (target < 1) {
      viewMonth--;
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      render();
      const newDays = Array.from(gridEl.querySelectorAll('.kasa-calendar-day:not(.kasa-calendar-day-empty)'));
      const last = newDays[newDays.length - 1];
      if (last) { last.tabIndex = 0; last.focus(); }
    } else if (target > daysInMonth) {
      viewMonth++;
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      render();
      const first = gridEl.querySelector('.kasa-calendar-day:not(.kasa-calendar-day-empty)');
      if (first) { first.tabIndex = 0; first.focus(); }
    } else {
      days[idx].tabIndex = -1;
      const next = gridEl.querySelector('[data-day="' + target + '"]');
      if (next) { next.tabIndex = 0; next.focus(); }
    }
  }

  function focusFirstDay() {
    const first = gridEl.querySelector('.kasa-calendar-day:not(.kasa-calendar-day-empty)');
    if (first) { first.tabIndex = 0; first.focus(); }
  }

  /* ── Olay bağlama ─────────────────────────────────────────────── */

  WEEKDAYS.forEach(w => {
    const span = document.createElement('span');
    span.className = 'kasa-calendar-weekday';
    span.textContent = w;
    weekdaysEl.appendChild(span);
  });

  displayInput.addEventListener('click', () => {
    popup.hidden ? openPopup() : closePopup();
  });

  displayInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); popup.hidden ? openPopup() : closePopup(); }
    if (e.key === 'Escape') closePopup();
  });

  popup.addEventListener('click', e => e.stopPropagation());

  wrapper.querySelector('.kasa-calendar-prev-month').addEventListener('click', () => {
    viewMonth--;
    if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    render();
  });

  wrapper.querySelector('.kasa-calendar-next-month').addEventListener('click', () => {
    viewMonth++;
    if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    render();
  });

  wrapper.querySelector('.kasa-calendar-prev-year').addEventListener('click', () => { viewYear--; render(); });
  wrapper.querySelector('.kasa-calendar-next-year').addEventListener('click', () => { viewYear++; render(); });

  wrapper.querySelector('.kasa-calendar-today-btn').addEventListener('click', () => {
    const now = new Date();
    viewYear  = now.getFullYear();
    viewMonth = now.getMonth();
    hiddenInput.value = toISO(viewYear, viewMonth, now.getDate());
    syncDisplay();
    syncCardExpiryFromHidden();
    render();
  });

  wrapper.querySelector('.kasa-calendar-clear-btn').addEventListener('click', () => {
    hiddenInput.value = '';
    syncDisplay();
    syncCardExpiryFromHidden();
    closePopup();
  });

  popup.addEventListener('keydown', e => { if (e.key === 'Escape') closePopup(); });
  gridEl.addEventListener('keydown', handleGridKeydown);

  document.addEventListener('click', e => {
    if (!popup.hidden && !wrapper.contains(e.target)) closePopup();
  });

  syncDisplay();
}
