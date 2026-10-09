/**
 * ŞifreKasam v2.7.0-beta.4 - Modal Sistemi modülü (ES Module)
 *
 * 6. bölüm: window.kasaModalAc / window.kasaModalKapat, kasa-modal
 * tıklama / kapatma davranışları ve Escape yönetimi.
 * initModalSystem, app.js içindeki DOMContentLoaded sırasında çağrılır.
 */

/**
 * Odaklanabilir öğeler. `disabled` gözden geçer: bir kartın içindeki
 * gizli alanlar `disabled` taşıyabilir ve odak sırasına girmemeli.
 * `aria-hidden="true"` altındakiler de alınmaz.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

const focusableWithin = (modal) => Array.from(
  modal.querySelectorAll(FOCUSABLE_SELECTOR)
).filter((el) => {
  if (el.hasAttribute('inert') || el.getAttribute('aria-hidden') === 'true') return false;
  if (el.closest('[aria-hidden="true"]')) return false;
  // `display:none`/gizli kapsayıcı odak sırasına katılmaz; offsetParent
  // `position:fixed` öğelerde null döndüğü için ek kontrol gerekiyor.
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
});

/**
 * 🔴 Odak tuzağı (focus trap). `aria-modal="true"` yalnızca ekran
 * okuyucuya "dışarısı inert" der; klavyeyi fiziksel olarak içeride
 * TUTMAZ. Tab ile odak modalin dışına kaçarsa kullanıcı arkadaki
 * sayfayı düzenlemeye başlar — bir şifre yöneticisinde bu hem kaza hem
 * veri kaybı demektir.
 *
 * Odak hedefi: `autofocus` → `data-autofocus` → ilk odaklanabilir →
 * modalın kendisi. `modal-system` her `.kasa-modal`'da `tabindex="-1"`
 * taşıdığı için son çare de çalışır.
 */
const trapModalFocus = (modal) => {
  if (!modal || modal.dataset.focusTrapped === 'on') return;
  modal.dataset.focusTrapped = 'on';
  modal.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusables = focusableWithin(modal);
    if (!focusables.length) {
      event.preventDefault();
      modal.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === modal)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });
};

/** Animasyonlar kapalı mı? Odak zamanlaması buna göre değişir. */
const transitionsDisabled = () =>
  document.documentElement.getAttribute('data-kasa-animations') === 'off'
  || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Modal açıldığında odak nereye gitsin? */
const focusModalTarget = (modal) => {
  const preferred =
    modal.querySelector('[autofocus], [data-autofocus]') || focusableWithin(modal)[0];
  (preferred || modal).focus?.();
};

export function initModalSystem({ customSelectStates, closeCustomSelect }) {

  window.kasaModalAc = (modalId) => {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    const visibleModals = Array.from(document.querySelectorAll('.kasa-modal.is-visible'))
      .filter(visibleModal => visibleModal !== modal);
    visibleModals.forEach(visibleModal => visibleModal.classList.remove('is-top-modal'));
    document.body.classList.add('kasa-modal-open');
    modal.classList.remove('is-closing', 'is-open', 'is-stacked-modal');
    modal.classList.toggle('is-stacked-modal', visibleModals.length > 0);
    modal.classList.add('is-top-modal');
    modal.classList.add('is-visible');
    modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => modal.classList.add('is-open'));
    trapModalFocus(modal);
    /* Odak, açılış animasyonu bitene kadar (190 ms) erteleniyor: henüz
       `display:none` olan öğelere odak vermek Chromium'da sessizce
       başarısız oluyor ve tuzak devreye girmiş olmadan odak kaçıyor. */
    setTimeout(() => focusModalTarget(modal), transitionsDisabled() ? 0 : 200);
    modal.dispatchEvent(new CustomEvent('kasa:modal-opened'));
  };

  window.kasaModalKapat = (modalId) => {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    /* Kapanan modal henüz .is-visible olduğu için, listeden çıkarılmış hâli
       "kaç modal açık kalacak" bilgisini verir. Dinleyiciler (ör. app.js'teki
       scrollbar telafisi) bu sayıyla DOM sorgusu yapmadan karar verebilir. */
    const remainingModalCount = Array.from(
      document.querySelectorAll('.kasa-modal.is-visible')
    ).filter(visibleModal => visibleModal !== modal).length;
    modal.dispatchEvent(new CustomEvent('kasa:modal-closing', {
      detail: { remainingModalCount },
    }));
    const animationsOff = transitionsDisabled();
    modal.classList.remove('is-open');
    modal.classList.add('is-closing');
    setTimeout(() => {
      modal.classList.remove('is-visible', 'is-closing', 'is-top-modal', 'is-stacked-modal');
      modal.setAttribute('aria-hidden', 'true');
      const remainingModals = Array.from(document.querySelectorAll('.kasa-modal.is-visible'));
      if (!remainingModals.length) {
        document.body.classList.remove('kasa-modal-open');
      } else {
        remainingModals.forEach(remainingModal => remainingModal.classList.remove('is-top-modal'));
        remainingModals[remainingModals.length - 1].classList.add('is-top-modal');
      }
    }, animationsOff ? 0 : 190);
    /* Kapanan modalin odagini, varsa ustteki moda geri veriyoruz; hicbir
       modal kalmadiysa odak `<body>`ye dustugu icin Tab ile kullanicinin
       basladigi yere (belki forma) donmus olur. */
    const remaining = Array.from(
      document.querySelectorAll('.kasa-modal.is-visible')
    ).filter(visibleModal => visibleModal !== modal);
    if (remaining.length) {
      setTimeout(() => focusModalTarget(remaining[remaining.length - 1]), animationsOff ? 0 : 200);
    } else if (document.activeElement === document.body) {
      const restoreTo = document.querySelector('[data-modal-focus-return]');
      restoreTo?.focus?.();
    }
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

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;

    const openSelectState = [...customSelectStates]
      .reverse()
      .find(state => state.openRequested || state.wrapper.classList.contains('is-open'));
    if (openSelectState) {
      event.preventDefault();
      closeCustomSelect(openSelectState, true);
      return;
    }

    const visibleModals = Array.from(
      document.querySelectorAll('.kasa-modal.is-visible:not(.is-closing)')
    );
    if (!visibleModals.length) return;

    const topModal = visibleModals.find(modal => modal.classList.contains('is-top-modal'))
      || visibleModals[visibleModals.length - 1];
    event.preventDefault();
    window.kasaModalKapat(topModal.id);
  });

}