/**
 * ŞifreKasam v2.7.0-beta.2 - Göster/Kopyala modülü (ES Module)
 *
 * Kopyalama sistemi (copyToClipboard, flashCopyIcon) ve 5. bölüm
 * (copy-password / copy-username / toggle-password butonları).
 * initRevealCopy, app.js içindeki DOMContentLoaded sırasında çağrılır.
 */

import { showSuccessToast, showWarningToast } from './toast.js';

  const copyButtonStates = new WeakMap();
  const COPY_ICON_RESET_MS = 850;

  const getCopyButton = (iconEl) => iconEl?.closest?.('button') || iconEl;

  const getOriginalCopyIconClassName = (iconEl) => {
    const classes = Array.from(iconEl?.classList || [])
      .map(className => className === 'fa-check' ? 'fa-copy' : className)
      .filter(className => !['copy-flash', 'text-success'].includes(className));

    if (!classes.includes('fa-copy')) classes.push('fa-copy');
    if (!classes.includes('fa-solid') && !classes.includes('fa-regular')) {
      classes.unshift('fa-solid');
    }

    return [...new Set(classes)].join(' ') || 'fa-solid fa-copy';
  };

  const resetCopyButtonIcon = (button) => {
    if (!button?.isConnected) return;
    const state = copyButtonStates.get(button);
    const icon = state?.icon?.isConnected ? state.icon : button.querySelector('i');
    if (icon) icon.className = state?.originalClassName || getOriginalCopyIconClassName(icon);
    delete button.dataset.copyResetAt;
    copyButtonStates.delete(button);
  };

  const resetStuckCopyButtons = () => {
    const now = Date.now();
    document.querySelectorAll('button[data-copy-reset-at]').forEach((button) => {
      const resetAt = Number(button.dataset.copyResetAt || 0);
      if (resetAt && now >= resetAt) {
        resetCopyButtonIcon(button);
      }
    });
  };

  const flashCopyIcon = (iconEl) => {
    const button = getCopyButton(iconEl);
    if (!button) return;

    const currentState = copyButtonStates.get(button);
    const icon = iconEl?.isConnected ? iconEl : button.querySelector('i');
    if (!icon) return;
    const originalClassName = currentState?.originalClassName || getOriginalCopyIconClassName(icon);
    clearTimeout(currentState?.timer);

    icon.className = originalClassName
      .split(/\s+/)
      .map(className => className === 'fa-copy' ? 'fa-check' : className)
      .filter(Boolean)
      .concat('text-success', 'copy-flash')
      .filter((className, index, classes) => classes.indexOf(className) === index)
      .join(' ');

    button.dataset.copyResetAt = String(Date.now() + COPY_ICON_RESET_MS + 250);
    const timer = setTimeout(() => resetCopyButtonIcon(button), COPY_ICON_RESET_MS);
    setTimeout(resetStuckCopyButtons, COPY_ICON_RESET_MS + 500);
    copyButtonStates.set(button, { icon, originalClassName, timer });

    try {
      showSuccessToast(window._('Kopyaland\u0131!'));
    } catch (err) {
      console.warn('Copy toast failed:', err);
    }
  };

  export const copyToClipboard = async (text, iconEl) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = Object.assign(document.createElement('textarea'), {
          value: text,
          readOnly: true,
        });
        textarea.className = 'kasa-clipboard-fallback';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      flashCopyIcon(iconEl);
    } catch (err) {
      console.error('Copy failed:', err);
      showWarningToast(window._('Kopyalama başarısız oldu.'));
    }
  };



export function initRevealCopy({ apiJson }) {
  const fetchRowPassword = async (row) => {
    const field = row?.querySelector('.password-field');
    const recordId = field?.dataset.id;
    if (!recordId) return '';
    try {
      const data = await apiJson(`/api/record/${encodeURIComponent(recordId)}/password`);
      return data.password || '';
    } catch {
      return '';
    }
  };

  document.querySelectorAll('.copy-password').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const text = await fetchRowPassword(btn.closest('.password-row'));
      if (text) copyToClipboard(text, btn.querySelector('i'));
    });
  });

  document.querySelectorAll('.copy-username').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      copyToClipboard(btn.dataset.username, btn.querySelector('i'));
    });
  });

  document.querySelectorAll('.toggle-password').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const field = btn.closest('.password-row')?.querySelector('.password-field');
      const icon  = btn.querySelector('i');
      if (!field) return;
      const hidden = field.dataset.visible !== 'true';
      const password = hidden ? await fetchRowPassword(btn.closest('.password-row')) : '';
      if (hidden && !password) return;
      field.textContent = hidden ? password : '••••••••';
      field.dataset.visible = hidden ? 'true' : 'false';
      icon.className    = hidden ? 'fa-solid fa-eye-slash text-warning' : 'fa-solid fa-eye';
    });
  });
}