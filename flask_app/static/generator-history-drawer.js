/**
 * ŞifreKasam v2.7.0-beta.3 — Şifre Üretici Geçmiş Drawer modülü (ES Module)
 *
 * Sağdan süzülen geçmiş paneli: üretici modalının footer'ındaki "Geçmiş"
 * butonuyla açılır; scrim / kapat butonu / Escape ile kapanır.
 *
 * Escape yönetimi CAPTURE fazında yapılır: modal-system.js'in bubble
 * listener'ından ÖNCE çalışır → drawer açıkken Escape alttaki üretici
 * modalını kapatmaz (yalnızca drawer kapanır).
 *
 * Bağımlılık: password-generator.js'in bağladığı ID/class'lar
 * (.generator-history-card, .gen-history-toggle, #generator-history-list,
 * #generator-history-empty, #generator-history-clear) drawer içinde
 * korunur; bu modül yalnızca drawer'ın aç/kapa davranışını yönetir.
 */

export function initGeneratorHistoryDrawer() {
  const drawer = document.getElementById('generatorHistoryDrawer');
  if (!drawer) return;

  const panel = drawer.querySelector('.kasa-drawer-panel');
  const closeButtons = drawer.querySelectorAll('button[data-drawer-close]');
  const scrim = drawer.querySelector('.kasa-drawer-scrim');
  let lastTrigger = null;

  const motionOff = () =>
    document.documentElement.getAttribute('data-kasa-animations') === 'off' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const isOpen = () => drawer.classList.contains('is-open');

  const openDrawer = (trigger) => {
    if (isOpen()) return;
    drawer.classList.remove('is-closing');
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    lastTrigger = trigger;
    // Odak panel içine alınır (kapat butonu varsayılan hedef)
    const focusTarget = drawer.querySelector('button[data-drawer-close]');
    (focusTarget || panel)?.focus({ preventScroll: true });
  };

  const closeDrawer = () => {
    if (!isOpen()) return;
    drawer.classList.remove('is-open');
    drawer.classList.add('is-closing');
    drawer.setAttribute('aria-hidden', 'true');
    if (motionOff()) {
      drawer.classList.remove('is-closing');
    } else {
      setTimeout(() => drawer.classList.remove('is-closing'), 320);
    }
    if (lastTrigger && lastTrigger.isConnected) {
      lastTrigger.focus({ preventScroll: true });
    }
    lastTrigger = null;
  };

  // Açma tetikleyicileri: [data-drawer-open="generatorHistoryDrawer"]
  document.querySelectorAll('[data-drawer-open="generatorHistoryDrawer"]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      openDrawer(btn);
    });
  });

  // Kapama: kapat butonları + scrim
  closeButtons.forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      closeDrawer();
    });
  });
  scrim?.addEventListener('click', (event) => {
    event.preventDefault();
    closeDrawer();
  });

  // Escape: capture fazında — drawer açıkken alttaki modal kapanmaz
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || !isOpen()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeDrawer();
    },
    true
  );

  // Üretici modalı kapanırsa drawer da kapanır (güvenlik ağı)
  const generatorModal = document.getElementById('passwordGeneratorModal');
  generatorModal?.addEventListener('kasa:modal-closing', () => closeDrawer());
}

document.addEventListener('DOMContentLoaded', () => initGeneratorHistoryDrawer());