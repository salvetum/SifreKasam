/**
 * ŞifreKasam v2.7.0-beta.3 - Veri ve Yedekleme paneli modülü (ES Module)
 *
 * Otomatik yedek listesini yükler, "Şimdi Yedek Al" / geri yükle / sil
 * eylemlerini bağlar ve hatırlatma sıklığı seçicilerini backend değerleriyle
 * senkronize eder. initDataPanel, app.js içindeki DOMContentLoaded sırasında
 * çağrılır. Kilitli/bakımlı durumlarda 409 (vault-write-locked) yanıtı
 * kasa:notify-vault-lock mesajını tetikler.
 */

import { showSuccessToast, showWarningToast } from './toast.js';

export function initDataPanel({ apiFetch }) {

  const listEl = document.getElementById('auto-backup-list');
  const lastEl = document.getElementById('auto-backup-last');
  const maxCountEl = document.getElementById('auto-backup-max-count');
  const backupNowBtn = document.getElementById('auto-backup-now-btn');
  const backupFreqSelect = document.getElementById('backup-reminder-frequency');
  const breachFreqSelect = document.getElementById('breach-reminder-frequency');
  const intervalEl = document.getElementById('auto-backup-interval');
  const nextEl = document.getElementById('auto-backup-next');

  if (!listEl && !backupNowBtn && !backupFreqSelect && !breachFreqSelect) return;

  const formatSize = (bytes) => {
    if (!Number.isFinite(bytes)) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (iso) => {
    try {
      const date = new Date(iso);
      return date.toLocaleString(undefined, {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return String(iso ?? '');
    }
  };

  const renderBackups = (backups) => {
    if (!listEl) return;
    listEl.textContent = '';
    if (!backups || backups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'auto-backup-empty';
      empty.innerHTML = '<i class="fa-solid fa-inbox" aria-hidden="true"></i>';
      empty.appendChild(document.createTextNode(' ' + window._('Henüz yedek alınmadı')));
      listEl.appendChild(empty);
      return;
    }
    backups.forEach((backup, index) => {
      const item = document.createElement('div');
      item.className = 'auto-backup-item';
      item.style.setProperty('--i', String(index));

      const icon = document.createElement('span');
      icon.className = 'auto-backup-item-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = '<i class="fa-solid fa-file-shield"></i>';
      item.append(icon);

      const copy = document.createElement('div');
      copy.className = 'auto-backup-item-copy';
      copy.dataset.tooltip = backup.filename || '';
      const strong = document.createElement('strong');
      strong.textContent = backup.filename || '';
      strong.title = backup.filename || '';
      const small = document.createElement('small');
      small.textContent = `${formatDate(backup.created_at)} · ${formatSize(backup.size)}`;
      copy.append(strong, small);
      item.append(copy);

      const actions = document.createElement('div');
      actions.className = 'auto-backup-item-actions';

      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'auto-backup-item-btn is-restore';
      restoreBtn.setAttribute('aria-label', window._('Geri Yükle'));
      restoreBtn.title = window._('Geri Yükle');
      restoreBtn.dataset.tooltip = window._('Geri Yükle');
      restoreBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i>';
      restoreBtn.addEventListener('click', () => restoreBackup(backup, restoreBtn));

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'auto-backup-item-btn is-delete';
      deleteBtn.setAttribute('aria-label', window._('Sil'));
      deleteBtn.title = window._('Sil');
      deleteBtn.dataset.tooltip = window._('Sil');
      deleteBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
      deleteBtn.addEventListener('click', () => deleteBackup(backup, deleteBtn));

      actions.append(restoreBtn, deleteBtn);
      item.append(actions);
      listEl.appendChild(item);
    });
  };

  const setLastBackup = (iso) => {
    if (!lastEl) return;
    lastEl.textContent = iso ? formatDate(iso) : window._('Henüz yedek alınmadı');
  };

  const refreshBackups = async () => {
    try {
      const response = await apiFetch('/api/backups', { headers: { Accept: 'application/json' } });
      if (!response?.ok) throw new Error('backups-list-failed');
      const data = await response.json().catch(() => null);
      if (!data || data.status !== 'ok') throw new Error('backups-list-invalid');
      renderBackups(data.backups || []);
      setLastBackup(data.last_backup);
      if (maxCountEl && data.max_count) maxCountEl.textContent = String(data.max_count);
      if (intervalEl && data.auto_backup_interval) {
        const current = intervalEl.options[intervalEl.selectedIndex]?.value;
        if (current !== data.auto_backup_interval) {
          intervalEl.value = data.auto_backup_interval;
          intervalEl.dispatchEvent(new Event('change', { bubbles: true }));
          intervalEl.kasaSyncCustomSelect?.();
        }
      }
      if (nextEl && data.auto_backup_interval) {
        if (data.auto_backup_interval === 'off') {
          nextEl.textContent = window._('Otomatik yedekleme kapalı.');
        } else if (data.next_auto_backup_at) {
          nextEl.textContent = window._('Sıradaki otomatik yedek: {date}')
            .replace('{date}', formatDate(data.next_auto_backup_at));
        } else {
          nextEl.textContent = `${window._('Sıradaki otomatik yedek')}: —`;
        }
        nextEl.hidden = false;
      }
    } catch {
      if (listEl) {
        listEl.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'auto-backup-empty';
        empty.textContent = window._('Yedek listesi yüklenemedi.');
        listEl.appendChild(empty);
      }
    }
  };

  const setBusy = (btn, busy) => {
    if (!btn) return;
    btn.disabled = busy;
    btn.setAttribute('aria-busy', String(busy));
    if (busy) btn.style.pointerEvents = 'none';
    else btn.style.pointerEvents = '';
  };

  const confirmDialog = (title, text, confirmText) => {
    if (typeof Swal === 'undefined') return Promise.resolve({ isConfirmed: false });
    return Swal.fire({
      title,
      text,
      icon: 'warning',
      showCancelButton: true,
      heightAuto: false,
      scrollbarPadding: false,
      confirmButtonText: confirmText,
      cancelButtonText: window._('İptal'),
      color: 'var(--text)',
      buttonsStyling: false,
      customClass: {
        popup: 'kasa-swal-popup', title: 'kasa-swal-title',
        htmlContainer: 'kasa-swal-text', actions: 'kasa-swal-actions',
        confirmButton: 'kasa-btn kasa-btn-danger',
        cancelButton: 'kasa-btn kasa-btn-muted',
      },
    });
  };

  const restoreBackup = async (backup, btn) => {
    const { isConfirmed } = await confirmDialog(
      window._('Yedeği Geri Yükle'),
      window._('Mevcut tüm kayıtlar seçilen yedek ile değiştirilecek. Bu işlem geri alınamaz!'),
      window._('Evet, Geri Yükle'),
    );
    if (!isConfirmed) return;
    setBusy(btn, true);
    try {
      const response = await apiFetch('/api/backups/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: backup.filename, confirm: true }),
      });
      if (response?.status === 423 || response?.status === 409) {
        let message = '';
        const data = await response.json().catch(() => null);
        if (data?.message) message = data.message;
        window.dispatchEvent(new CustomEvent('kasa:vault-write-locked', {
          detail: { message },
        }));
        return;
      }
      if (!response?.ok) throw new Error('restore-failed');
      const data = await response.json().catch(() => null);
      const count = data?.restored;
      window.dispatchEvent(new CustomEvent('kasa:dirty-vault'));
      showSuccessToast(
        count != null
          ? window._('{count} kayıt geri yüklendi.').replace('{count}', String(count))
          : window._('Yedek geri yüklendi.')
      );
      refreshBackups();
    } catch {
      showWarningToast(window._('Yedek geri yüklenemedi.'));
    } finally {
      setBusy(btn, false);
    }
  };

  const deleteBackup = async (backup, btn) => {
    const { isConfirmed } = await confirmDialog(
      window._('Yedeği Sil'),
      window._('Bu yedek kalıcı olarak silinecek. Bu işlem geri alınamaz!'),
      window._('Evet, Sil'),
    );
    if (!isConfirmed) return;
    setBusy(btn, true);
    try {
      const response = await apiFetch('/api/backups/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: backup.filename }),
      });
      if (response?.status === 423 || response?.status === 409) {
        const data = await response.json().catch(() => null);
        window.dispatchEvent(new CustomEvent('kasa:vault-write-locked', {
          detail: { message: data?.message || '' },
        }));
        return;
      }
      if (!response?.ok) throw new Error('delete-failed');
      showSuccessToast(window._('Yedek silindi.'));
      refreshBackups();
    } catch {
      showWarningToast(window._('Yedek silinemedi.'));
    } finally {
      setBusy(btn, false);
    }
  };

  backupNowBtn?.addEventListener('click', async () => {
    setBusy(backupNowBtn, true);
    try {
      const response = await apiFetch('/api/backups/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (response?.status === 423 || response?.status === 409) {
        const data = await response.json().catch(() => null);
        if (data?.message) showWarningToast(data.message);
        return;
      }
      if (!response?.ok) throw new Error('backup-create-failed');
      showSuccessToast(window._('Yedek oluşturuldu.'));
      refreshBackups();
    } catch {
      showWarningToast(window._('Yedek oluşturulamadı.'));
    } finally {
      setBusy(backupNowBtn, false);
    }
  });

  const syncFrequencySelects = (payload) => {
    const applyValue = (select, value) => {
      if (!select) return;
      const current = select.options[select.selectedIndex]?.value;
      if (value && current !== value) {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        select.kasaSyncCustomSelect?.();
      }
    };
    applyValue(backupFreqSelect, payload.backup_reminder_frequency);
    applyValue(breachFreqSelect, payload.breach_reminder_frequency);
  };

  const fetchFrequencyState = async () => {
    try {
      const response = await apiFetch('/api/notifications', { headers: { Accept: 'application/json' } });
      if (!response?.ok) return;
      const payload = await response.json().catch(() => null);
      if (payload) syncFrequencySelects(payload);
    } catch {
      // Hatırlatma sıklığı alınamazsa seçiciler varsayılan (off) kalır.
    }
  };

  refreshBackups();
  fetchFrequencyState();

  document.addEventListener('kasa:modal-opened', (event) => {
    if (event.target?.id === 'settingsModal') refreshBackups();
  });

}