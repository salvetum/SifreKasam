/**
 * ŞifreKasam v2.7.0-beta.4 - Bildirim merkezi modülü (ES Module)
 *
 * 7. bölüm: küresel yükleme çubuğu (KASA_PROGRESS), bildirim zili (badge + panel)
 * ve hatırlatma toast'ları. initNotifications, app.js içindeki DOMContentLoaded
 * sırasında çağrılır.
 *
 * Yeni özellikler:
 *  - Bildirim susturma / gizleme (backend API tabanlı, localStorage fallback)
 *  - Hepsini okundu olarak işaretle (POST /api/notifications/dismiss-all)
 *  - Tüm bildirimleri sil (POST /api/notifications/dismiss-all)
 *  - Her bildirim öğesinde gizle butonu
 *  - Cam efekti garanti backdrop-filter fallback'i
 */

import { showWarningToast } from './toast.js';

const TOASTED_KEY = 'kasa-notif-toasted';
const DISMISSED_FALLBACK_KEY = 'kasa-notif-dismissed';
const toastDate = () => new Date().toISOString().slice(0, 10);

export function initNotifications({ apiFetch }) {

  // ─── KÜRESEL YÜKLEME ÇUBUĞU ───────────────────────────────────────────────
  const progressBar = document.getElementById('kasa-progress-bar');
  const progressFill = progressBar?.querySelector('.kasa-progress-fill');
  let progressTimer = null;

  const progress = {
    start() {
      if (!progressBar || !progressFill) return;
      progressBar.classList.remove('is-done');
      progressBar.classList.add('is-active');
      progressFill.style.width = '8%';
    },
    set(pct) {
      if (!progressBar || !progressFill) return;
      const safe = Math.max(0, Math.min(100, Number(pct) || 0));
      progressFill.style.width = safe + '%';
      if (safe >= 100) {
        clearTimeout(progressTimer);
        progressBar.classList.add('is-active', 'is-done');
      }
    },
    done() {
      if (!progressBar) return;
      clearTimeout(progressTimer);
      progressBar.classList.add('is-active', 'is-done');
      progressFill.style.width = '100%';
      progressTimer = setTimeout(() => {
        progressBar.classList.remove('is-active', 'is-done');
        if (progressFill) progressFill.style.width = '0%';
      }, 500);
    },
  };
  window.KASA_PROGRESS = progress;

  // ─── BİLDİRİM YÖNETİMİ ────────────────────────────────────────────────────
  const listEl = document.getElementById('kasa-notif-list');
  const badgeEl = document.getElementById('kasa-notif-badge');
  const headSubEl = document.getElementById('kasa-notif-head-sub');
  const actionsEl = document.getElementById('kasa-notif-actions');
  const markAllBtn = document.getElementById('notif-mark-all-read');
  const deleteAllBtn = document.getElementById('notif-delete-all');
  if (listEl) listEl.replaceChildren();

  let currentReminders = [];

  // ── Boş panel görünümü: liste yoksa veya API başarısız olsa da metin göster ──
  const renderEmpty = () => {
    if (!listEl) return;
    const emptyIcon = document.createElement("i");
    emptyIcon.className = "fa-solid fa-circle-check";
    emptyIcon.setAttribute("aria-hidden", "true");
    const emptySpan = document.createElement("span");
    emptySpan.textContent = window._("Hiçbir bildirim bulunmamaktadır");
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "kasa-notif-empty";
    emptyDiv.append(emptyIcon, emptySpan);
    listEl.replaceChildren(emptyDiv);
    if (headSubEl) headSubEl.textContent = window._('Tümü tamam');
    if (badgeEl) badgeEl.hidden = true;
    if (actionsEl) actionsEl.hidden = true;
  };

  // ── Susturulmuş bildirim ID'leri (backend API, localStorage fallback) ────
  let dismissedIds = new Set();

  const saveDismissedFallback = () => {
    try {
      const arr = [...dismissedIds].slice(-100);
      localStorage.setItem(DISMISSED_FALLBACK_KEY, JSON.stringify(arr));
    } catch { /* yoksay */ }
  };

  const dismissId = async (id) => {
    const strId = String(id);
    dismissedIds.add(strId);
    saveDismissedFallback();

    try {
      const response = await apiFetch('/api/notifications/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: strId }),
      });
      if (response && response.ok) {
        const data = await response.json().catch(() => null);
        if (data && Array.isArray(data.dismissed)) {
          dismissedIds = new Set(data.dismissed.map(String));
        }
      }
    } catch { /* optimistic update zaten yapıldı */ }
    saveDismissedFallback();
  };

  const dismissAll = async () => {
    currentReminders.forEach(r => dismissedIds.add(String(r.id)));
    saveDismissedFallback();

    try {
      const response = await apiFetch('/api/notifications/dismiss-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (response && response.ok) {
        const data = await response.json().catch(() => null);
        if (data && Array.isArray(data.dismissed)) {
          dismissedIds = new Set(data.dismissed.map(String));
        }
      }
    } catch { /* optimistic update zaten yapıldı */ }
    saveDismissedFallback();
  };

  const isDismissed = (id) => {
    return dismissedIds.has(String(id));
  };

  // ── Dropdown kapatma yardimcisi (portal-uyumlu) ─────────────────────────
  // Menü artık navbar DOM'unda değil; root elementten [data-kasa-dropdown]
  // wrapper bulamaz. Portaled menü .kasa-dropdown-menu sınıfıyla eşleşir.
  const closeDropdown = (root) => {
    // Eski yol: dropdown wrapper içinde
    const dropdown = (root || document).closest('[data-kasa-dropdown]');
    // Yeni yol (portal): root'un üstündeki .kasa-dropdown-menu
    const portaledMenu = (root || document).closest('.kasa-dropdown-menu');
    const menu = portaledMenu || dropdown?.querySelector('.kasa-dropdown-menu');
    const trigger = portaledMenu
      ? document.querySelector(`[aria-controls="${portaledMenu.id}"]`)
      : dropdown?.querySelector('.kasa-dropdown-trigger');
    if (menu) {
      menu.classList.remove('is-open');
      setTimeout(() => { menu.hidden = true; }, 120);
    }
    trigger?.setAttribute('aria-expanded', 'false');
  };

  // ── Bildirim kopyası ──────────────────────────────────────────────────────
  const reminderCopy = (reminder) => {
    const base = {
      backup: {
        icon: 'fa-database',
        title: window._('Yedek almayı unutmayın'),
        cta: window._('Veri ve Yedekleme'),
      },
      breach: {
        icon: 'fa-shield-halved',
        title: window._('Sızıntı kontrolü zamanı'),
        cta: window._('Şifre Sağlığı'),
      },
    }[reminder.kind];
    let message;
    if (reminder.kind === 'backup') {
      message = reminder.never
        ? window._('Henüz yedek almadınız. Şifrelerinizi dışa aktararak güvence altına alın.')
        : window._('{days} gündür yedek alınmadı.').replace('{days}', reminder.days);
    } else {
      message = reminder.never
        ? window._('Henüz canlı sızıntı taraması yapılmadı.')
        : window._('{days} gündür şifre sızıntı kontrolü yapılmadı.').replace('{days}', reminder.days);
    }
    return { ...base, message };
  };

  // ── Zil子 kurucusu ─────────────────────────────────────────────────────────
  const renderBell = (reminders) => {
    if (!listEl) return;
    currentReminders = reminders;

    // Susturulmuş bildirimleri filtrele
    const active = reminders.filter(r => !isDismissed(r.id));

    if (!active.length) {
      renderEmpty();
      return;
    }

    // Badge güncelle
    if (badgeEl) {
      badgeEl.textContent = String(active.length);
      badgeEl.hidden = false;
    }
    if (headSubEl) headSubEl.textContent = window._('Hatırlatmalar');
    if (actionsEl) actionsEl.hidden = false;

    // Bildirim listesini oluştur
    // 🔴 innerHTML YASAK (security_lint + AGENTS.md): bildirim listesi
    // sunucu verisinden oluşturulsada DOM API ile kurulur.
    const gizleEtiketi = window._('Bu bildirimi gizle');
    listEl.replaceChildren(...active.map((reminder) => {
      const copy = reminderCopy(reminder);
      const cta = reminder.cta || {};
      const item = document.createElement('div');
      item.className = 'kasa-notif-item';
      item.dataset.notifId = reminder.id;

      const icon = document.createElement('span');
      icon.className = 'kasa-notif-item-icon';
      const iconI = document.createElement('i');
      iconI.className = 'fa-solid ' + copy.icon;
      iconI.setAttribute('aria-hidden', 'true');
      icon.append(iconI);

      const copySpan = document.createElement('span');
      copySpan.className = 'kasa-notif-item-copy';
      const title = document.createElement('strong');
      title.textContent = copy.title;
      const msg = document.createElement('span');
      msg.textContent = copy.message;
      copySpan.append(title, msg);

      const ctaBtn = document.createElement('button');
      ctaBtn.type = 'button';
      ctaBtn.className = 'kasa-btn kasa-btn-muted kasa-notif-cta';
      if (cta.action === 'settings') {
        ctaBtn.dataset.action = 'settings';
        ctaBtn.dataset.panel = cta.panel || 'data';
      } else {
        ctaBtn.dataset.action = 'navigate';
        ctaBtn.dataset.href = cta.url || '/saglik';
      }
      const ctaIcon = document.createElement('i');
      ctaIcon.className = 'fa-solid fa-arrow-right';
      ctaIcon.setAttribute('aria-hidden', 'true');
      ctaBtn.append(ctaIcon, document.createTextNode(' ' + copy.cta));

      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'kasa-notif-dismiss';
      dismiss.dataset.dismissId = reminder.id;
      dismiss.title = gizleEtiketi;
      dismiss.setAttribute('aria-label', gizleEtiketi);
      const xIcon = document.createElement('i');
      xIcon.className = 'fa-solid fa-xmark';
      xIcon.setAttribute('aria-hidden', 'true');
      dismiss.append(xIcon);

      item.append(icon, copySpan, ctaBtn, dismiss);
      return item;
    }));
  };

  // ── Hatırlatma toastları ───────────────────────────────────────────────────
  const runReminderToasts = (reminders) => {
    if (!reminders.length) return;
    let toasted = [];
    try { toasted = JSON.parse(sessionStorage.getItem(TOASTED_KEY) || '[]'); } catch (err) { toasted = []; }
    const today = toastDate();
    const due = reminders.filter(r => !toasted.includes(today + ':' + r.id));
    if (!due.length) return;
    try {
      sessionStorage.setItem(TOASTED_KEY, JSON.stringify(
        toasted.concat(due.map(r => today + ':' + r.id))
      ));
    } catch (err) { /* yoksay */ }
    due.forEach((reminder, index) => {
      const copy = reminderCopy(reminder);
      const text = copy.title + ' \u2014 ' + copy.message;
      setTimeout(() => showWarningToast(text), 600 + index * 900);
    });
  };

  // ── API'den bildirimleri yükle ────────────────────────────────────────────
  const loadNotifications = async () => {
    let response;
    try {
      response = await apiFetch('/api/notifications');
    } catch {
      renderEmpty();
      return;
    }
    if (!response || !response.ok) { renderEmpty(); return; }
    const data = await response.json().catch(() => null);
    if (!data || !Array.isArray(data.reminders)) { renderEmpty(); return; }

    // Backend'den gelen dismissed listesini önbelleğe al
    if (Array.isArray(data.dismissed)) {
      dismissedIds = new Set(data.dismissed.map(String));
      saveDismissedFallback();
    }

    renderBell(data.reminders);
    runReminderToasts(data.reminders);
  };

  // ── CTA tıklama (bildirime tıkla → ilgili sayfaya git) ────────────────────
  document.addEventListener('click', (event) => {
    // CTA butonu
    const cta = event.target.closest('.kasa-notif-cta');
    if (cta) {
      event.preventDefault();
      event.stopPropagation();
      closeDropdown(cta);
      const action = cta.getAttribute('data-action');
      if (action === 'settings') {
        if (typeof window.kasaModalAc === 'function') {
          window.kasaModalAc('settingsModal');
          const panel = cta.getAttribute('data-panel') || 'data';
          const tabBtn = document.querySelector('[data-settings-tab="' + panel + '"]');
          if (tabBtn) setTimeout(() => tabBtn.click(), 40);
        }
        return;
      }
      const href = cta.getAttribute('data-href');
      if (href) window.location.href = href;
      return;
    }

    // Gizle (sustur) butonu — tek bildirim
    const dismissBtn = event.target.closest('.kasa-notif-dismiss');
    if (dismissBtn) {
      event.preventDefault();
      event.stopPropagation();
      const id = dismissBtn.getAttribute('data-dismiss-id');
      if (id) {
        // Öğeyi animasyonlu olarak kaldır (optimistic update)
        const item = dismissBtn.closest('.kasa-notif-item');
        if (item) {
          item.style.transition = 'opacity 180ms ease, transform 180ms ease';
          item.style.opacity = '0';
          item.style.transform = 'translateX(20px)';
          setTimeout(() => {
            item.remove();
            renderBell(currentReminders);
          }, 180);
        } else {
          renderBell(currentReminders);
        }
        // Backend'e susturma isteği gönder
        dismissId(id);
      }
      return;
    }

    // Hepsini okundu olarak işaretle + Tüm bildirimleri sil
    // (her ikisi de aynı davranış: listeyi yeniden çiz + toplu sustur)
    if (event.target.closest('#notif-mark-all-read, #notif-delete-all')) {
      renderBell(currentReminders);
      dismissAll();
      return;
    }
  });

  // ── Bildirimleri yükle (boş durumda renderEmpty ile metin gösterilir) ──
  loadNotifications();
}
