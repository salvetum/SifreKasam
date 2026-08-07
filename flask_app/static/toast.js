/**
 * ŞifreKasam v2.6.3-beta.3 - Toast modülü (ES Module)
 *
 * 4. bölüm toast çekirdeği: showToast/showSuccessToast/showWarningToast,
 * legacy window köprüleri (showToast, KASA_API_FETCH, KASA_SHOW_WARNING_TOAST,
 * KASA_TRIGGER_BLOB_DOWNLOAD) ve kasa:vault-write-locked / onSecondInstance.
 * initToastSystem, app.js içindeki DOMContentLoaded sırasında çağrılır.
 */

let lastToast = null;
  export const showToast = (opts) => {
    lastToast?.hideToast();
    lastToast = Toastify(opts);
    lastToast.showToast();
    if (lastToast.toastElement) {
      lastToast.toastElement.setAttribute('role', opts.role || 'status');
      lastToast.toastElement.setAttribute('aria-live', opts.role === 'alert' ? 'assertive' : 'polite');
    }
  };

  export const TOAST_BASE = {
    duration: 3500, close: false,
    gravity: 'bottom', position: 'right', stopOnFocus: true,
  };

  export const showSuccessToast = (text) => showToast({
    ...TOAST_BASE, text, className: 'kasa-toast kasa-toast-success',
  });

  export const showWarningToast = (text) => showToast({
    ...TOAST_BASE, text, role: 'alert', className: 'kasa-toast kasa-toast-warning',
  });

  // Eski template scriptleri için tek ve tutarlı toast/API köprüsü.

export function initToastSystem({ apiFetch, triggerBlobDownload }) {
  window.showToast = (options, type = '') => {
    const normalized = typeof options === 'string'
      ? { ...TOAST_BASE, text: options }
      : { ...TOAST_BASE, ...(options || {}) };
    if (type === 'error' || normalized.type === 'error') {
      normalized.role = 'alert';
      normalized.className = 'kasa-toast kasa-toast-warning';
    }
    showToast(normalized);
  };
  window.KASA_API_FETCH = apiFetch;
  window.KASA_SHOW_WARNING_TOAST = showWarningToast;
  window.KASA_TRIGGER_BLOB_DOWNLOAD = triggerBlobDownload;

  window.addEventListener('kasa:vault-write-locked', (event) => {
    showWarningToast(
      event.detail?.message || window._('Ana \u015fifre de\u011fi\u015ftiriliyor, i\u015flem bitince tekrar deneyin.')
    );
  });

  window.kasaIpc?.onSecondInstance(() => {
    showWarningToast(window._('ŞifreKasam zaten çal\u0131\u015f\u0131yor.'));
  });
}
