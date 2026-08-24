/**
 * ŞifreKasam v2.7.0-beta.3 - Modal Sistemi modülü (ES Module)
 *
 * 6. bölüm: window.kasaModalAc / window.kasaModalKapat, kasa-modal
 * tıklama / kapatma davranışları ve Escape yönetimi.
 * initModalSystem, app.js içindeki DOMContentLoaded sırasında çağrılır.
 */

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
  };

  window.kasaModalKapat = (modalId) => {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.dispatchEvent(new CustomEvent('kasa:modal-closing'));
    const transitionsDisabled = document.documentElement.getAttribute('data-kasa-animations') === 'off'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
    }, transitionsDisabled ? 0 : 190);
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