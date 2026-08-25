/**
 * ŞifreKasam v2.7.0-beta.3 — Ekle/Düzenle takvim + son kullanma modülü
 * A2: ekle.html içine gömülü ~200 satırlık script buraya çıkarıldı.
 * Sorumluluk: popup takvim, hidden expiry_date senkronu, yıl kısaltması.
 */

export function initFormCalendar() {
  const hiddenInput = document.getElementById('expiry_date');
  if (!hiddenInput) return;

    const MONTHS_TR = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
    const WEEKDAYS = ['Pzt','Sal','Çar','Per','Cum','Cmt','Paz'];
      const displayInput = document.getElementById('expiry_date_display');
    const wrapper = document.getElementById('expiry-calendar-wrapper');
    const popup = document.getElementById('expiry-calendar-popup');
    const titleEl = document.getElementById('expiry-calendar-title');
    const weekdaysEl = document.getElementById('expiry-calendar-weekdays');
    const gridEl = document.getElementById('expiry-calendar-grid');
    const expiryAy = document.getElementById('expiry_ay');
    const expiryYil = document.getElementById('expiry_yil');
    let viewYear, viewMonth;
    let popupCloseTimer = 0;

    function parseDate(val) {
        if (!val) return null;
        const parts = val.split('-');
        if (parts.length !== 3) return null;
        return new Date(+parts[0], +parts[1] - 1, +parts[2]);
    }

    function toISO(y, m, d) {
        return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    }

    function toDisplay(y, m, d) {
        return String(d).padStart(2, '0') + '.' + String(m + 1).padStart(2, '0') + '.' + y;
    }

    function syncDisplay() {
        const dt = parseDate(hiddenInput.value);
        displayInput.value = dt ? toDisplay(dt.getFullYear(), dt.getMonth(), dt.getDate()) : '';
    }

    function syncCardExpiryFromHidden() {
        const dt = parseDate(hiddenInput.value);
        if (expiryAy) expiryAy.value = dt ? String(dt.getMonth() + 1).padStart(2, '0') : '';
        if (expiryYil) expiryYil.value = dt ? String(dt.getFullYear()) : '';
    }

    function syncHiddenFromCardExpiry() {
        const ay = parseInt(expiryAy.value, 10);
        const yil = parseInt(expiryYil.value, 10);
        if (ay >= 1 && ay <= 12 && yil >= 2000 && yil <= 2100) {
            const lastDay = new Date(yil, ay, 0).getDate();
            hiddenInput.value = yil + '-' + String(ay).padStart(2, '0') + '-' + String(lastDay).padStart(2, '0');
        } else {
            hiddenInput.value = '';
        }
        syncDisplay();
    }

    window.KASA_SYNC_CARD_EXPIRY = syncCardExpiryFromHidden;
    window.KASA_CLOSE_EXPIRY_POPUP = closePopup;
    if (expiryAy) expiryAy.addEventListener('input', syncHiddenFromCardExpiry);
    if (expiryYil) expiryYil.addEventListener('input', syncHiddenFromCardExpiry);

    // 1-2 haneli yıl kısaltmasını tam yıla açar: "34" -> "2034".
    // blur'da çalışır (custom-controls'un min=2000 clamp'i change'de devreye
    // girdiğinden önce yakalanır); programatik set input event'i tetiklemediği
    // için gizli alan senkronu elle çağrılır.
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

    function render() {
        titleEl.textContent = MONTHS_TR[viewMonth] + ' ' + viewYear;
        titleEl.classList.remove('kasa-calendar-title-anim');
        void titleEl.offsetWidth;
        titleEl.classList.add('kasa-calendar-title-anim');
        while (gridEl.firstChild) gridEl.removeChild(gridEl.firstChild);
        const first = new Date(viewYear, viewMonth, 1);
        let startDay = first.getDay();
        startDay = startDay === 0 ? 6 : startDay - 1;
        const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
        const today = new Date();
        const selected = parseDate(hiddenInput.value);

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
            btn.addEventListener('click', function () {
                hiddenInput.value = toISO(viewYear, viewMonth, d);
                syncDisplay();
                syncCardExpiryFromHidden();
                closePopup();
            });
            gridEl.appendChild(btn);
        }
    }

    function openPopup() {
        clearTimeout(popupCloseTimer);
        const dt = parseDate(hiddenInput.value) || new Date();
        viewYear = dt.getFullYear();
        viewMonth = dt.getMonth();
        popup.hidden = false;
        displayInput.setAttribute('aria-expanded', 'true');
        const panel = wrapper.closest('.vault-form-panel');
        if (panel) panel.classList.add('has-open-select-layer');
        render();
        requestAnimationFrame(() => popup.classList.add('is-open'));
        const selected = gridEl.querySelector('.is-selected') || gridEl.querySelector('.kasa-calendar-day:not(.kasa-calendar-day-empty)');
        if (selected) {
            selected.setAttribute('tabindex', '0');
            selected.focus();
        }
    }

    function closePopup() {
        popup.classList.remove('is-open');
        displayInput.setAttribute('aria-expanded', 'false');
        const panel = wrapper.closest('.vault-form-panel');
        if (panel) panel.classList.remove('has-open-select-layer');
        popupCloseTimer = setTimeout(function () { popup.hidden = true; }, 180);
        displayInput.focus();
    }

    WEEKDAYS.forEach(function (w) {
        var span = document.createElement('span');
        span.className = 'kasa-calendar-weekday';
        span.textContent = w;
        weekdaysEl.appendChild(span);
    });

    displayInput.addEventListener('click', function () { if (popup.hidden) openPopup(); else closePopup(); });
    displayInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (popup.hidden) openPopup(); else closePopup(); }
        if (e.key === 'Escape') closePopup();
    });

    popup.addEventListener('click', function (e) { e.stopPropagation(); });

    wrapper.querySelector('.kasa-calendar-prev-month').addEventListener('click', function () { viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } render(); });
    wrapper.querySelector('.kasa-calendar-next-month').addEventListener('click', function () { viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } render(); });
    wrapper.querySelector('.kasa-calendar-prev-year').addEventListener('click', function () { viewYear--; render(); });
    wrapper.querySelector('.kasa-calendar-next-year').addEventListener('click', function () { viewYear++; render(); });
    wrapper.querySelector('.kasa-calendar-today-btn').addEventListener('click', function () {
        var now = new Date();
        viewYear = now.getFullYear();
        viewMonth = now.getMonth();
        hiddenInput.value = toISO(viewYear, viewMonth, now.getDate());
        syncDisplay();
        syncCardExpiryFromHidden();
        render();
    });
    wrapper.querySelector('.kasa-calendar-clear-btn').addEventListener('click', function () {
        hiddenInput.value = '';
        syncDisplay();
        syncCardExpiryFromHidden();
        closePopup();
    });

    popup.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closePopup();
    });

    gridEl.addEventListener('keydown', function (e) {
        const days = Array.from(gridEl.querySelectorAll('.kasa-calendar-day:not(.kasa-calendar-day-empty)'));
        const idx = days.indexOf(document.activeElement);
        if (idx < 0) return;
        const curDay = +days[idx].dataset.day;
        let target = null;

        if (e.key === 'ArrowRight') { target = curDay + 1; e.preventDefault(); }
        else if (e.key === 'ArrowLeft') { target = curDay - 1; e.preventDefault(); }
        else if (e.key === 'ArrowDown') { target = curDay + 7; e.preventDefault(); }
        else if (e.key === 'ArrowUp') { target = curDay - 7; e.preventDefault(); }
        else if (e.key === 'Home') { target = 1; e.preventDefault(); }
        else if (e.key === 'End') {
            target = new Date(viewYear, viewMonth + 1, 0).getDate();
            e.preventDefault();
        }
        else if (e.key === 'PageUp') {
            viewMonth--;
            if (viewMonth < 0) { viewMonth = 11; viewYear--; }
            render();
            var first = gridEl.querySelector('.kasa-calendar-day:not(.kasa-calendar-day-empty)');
            if (first) { first.tabIndex = 0; first.focus(); }
            e.preventDefault();
            return;
        }
        else if (e.key === 'PageDown') {
            viewMonth++;
            if (viewMonth > 11) { viewMonth = 0; viewYear++; }
            render();
            var first = gridEl.querySelector('.kasa-calendar-day:not(.kasa-calendar-day-empty)');
            if (first) { first.tabIndex = 0; first.focus(); }
            e.preventDefault();
            return;
        }
        else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            var sel = parseDate(hiddenInput.value);
            var active = document.activeElement;
            if (active && active.dataset.day) {
                hiddenInput.value = toISO(viewYear, viewMonth, +active.dataset.day);
                syncDisplay();
                syncCardExpiryFromHidden();
                closePopup();
            }
            return;
        }
        else return;

        var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
        if (target < 1) {
            viewMonth--;
            if (viewMonth < 0) { viewMonth = 11; viewYear--; }
            render();
            var newDays = Array.from(gridEl.querySelectorAll('.kasa-calendar-day:not(.kasa-calendar-day-empty)'));
            var focusDay = newDays[newDays.length - 1];
            if (focusDay) { focusDay.tabIndex = 0; focusDay.focus(); }
        } else if (target > daysInMonth) {
            viewMonth++;
            if (viewMonth > 11) { viewMonth = 0; viewYear++; }
            render();
            var newDays = Array.from(gridEl.querySelectorAll('.kasa-calendar-day:not(.kasa-calendar-day-empty)'));
            var focusDay = newDays[0];
            if (focusDay) { focusDay.tabIndex = 0; focusDay.focus(); }
        } else {
            days[idx].tabIndex = -1;
            var next = gridEl.querySelector('[data-day="' + target + '"]');
            if (next) { next.tabIndex = 0; next.focus(); }
        }
    });

    document.addEventListener('click', function (e) {
        if (!popup.hidden && !wrapper.contains(e.target)) closePopup();
    });

    syncDisplay();
    
}
