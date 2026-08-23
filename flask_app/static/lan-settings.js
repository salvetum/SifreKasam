/**
 * ŞifreKasam v2.7.0-beta.3 - LAN Erişimi modülü (ES Module)
 *
 * 3b. bölüm: LAN bilgi kutusu durumları (bekliyor / aktif) ve fetchLanInfo.
 * initLanSettings, app.js içindeki DOMContentLoaded sırasında çağrılır.
 * Toggle değişim olayı ve LAN uyarı modalı app.js tarafından yönetilir.
 *
 * Durumlar:
 * - Aktif: LAN kayıtlı ve sunucu 0.0.0.0'a bağlıyken sayfa yüklendiyse adres
 *   doğrudan gösterilir.
 * - Bekliyor: Kullanıcı toggle'ı açtı ama henüz kaydetmedi. Gerçek adres
 *   kayıt + sunucu yeniden başlatmasından sonra gösterilir; ondan önce
 *   "kaydetmeniz gerekiyor" notu gösterilir.
 */

export function initLanSettings({ apiJson }) {

  const lanToggle = document.getElementById('lan-enabled-toggle');
  const lanInfoBox = document.getElementById('lan-info-box');
  const lanAddressWrap = document.getElementById('lan-address-wrap');
  const lanAddress = document.getElementById('lan-address');
  const lanPendingNote = document.getElementById('lan-pending-note');
  const lanPasswordWrap = document.getElementById('lan-password-wrap');
  const lanPassword = document.getElementById('lan-password');

  const lanActiveOnLoad = Boolean(lanToggle && lanToggle.checked);

  function _showEl(el) { if (el) { el.classList.remove('hidden'); el.classList.add('is-visible'); } }
  function _hideEl(el) { if (el) el.classList.remove('is-visible'); }

  async function fetchLanInfo() {
    if (!lanAddress) return;
    lanAddress.textContent = window._('Yükleniyor...');
    try {
      const data = await apiJson('/api/lan-info');
      if (Array.isArray(data.ips) && data.ips.length > 0) {
        lanAddress.textContent = `${data.ssl ? 'https://' : 'http://'}${data.ips[0]}:${data.port}`;
      } else {
        lanAddress.textContent = window._('Ağ bağlantısı bulunamadı');
      }
      if (lanPasswordWrap && lanPassword) {
        if (data.lan_password) {
          lanPassword.textContent = data.lan_password;
          _showEl(lanPasswordWrap);
        } else {
          _hideEl(lanPasswordWrap);
        }
      }
      return;
    } catch {
      lanAddress.textContent = window._('Bilgi alınamadı');
    }
  }

  function showPending() {
    if (!lanInfoBox) return;
    _showEl(lanInfoBox);
    _hideEl(lanAddressWrap);
    _hideEl(lanPasswordWrap);
    if (lanPendingNote) {
      _showEl(lanPendingNote);
    } else if (lanAddress) {
      lanAddress.textContent = window._('Ağ bağlantısı bulunamadı');
    }
  }

  function showActive() {
    if (!lanInfoBox) return;
    _showEl(lanInfoBox);
    _showEl(lanAddressWrap);
    _hideEl(lanPendingNote);
    fetchLanInfo();
  }

  function hide() {
    _hideEl(lanInfoBox);
  }

  // LAN zaten kayıtlı ve çalışıyorken sayfa yüklendiyse adresi doğrudan göster.
  if (lanActiveOnLoad) {
    showActive();
  }

  document.querySelectorAll('.lan-copy-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetId = btn.getAttribute('data-copy-target');
      const target = document.getElementById(targetId);
      if (!target || !target.textContent) return;
      try {
        await navigator.clipboard.writeText(target.textContent);
        btn.classList.add('copied');
        btn.querySelector('i').className = 'fa-solid fa-check';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.querySelector('i').className = 'fa-regular fa-copy';
        }, 1200);
      } catch (_) {}
    });
  });

  return { lanToggle, lanInfoBox, lanAddress, fetchLanInfo, showPending, showActive, hide };

}
