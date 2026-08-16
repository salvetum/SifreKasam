/**
 * ŞifreKasam v2.7.0-beta.2 - LAN Erişimi modülü (ES Module)
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

  const lanActiveOnLoad = Boolean(lanToggle && lanToggle.checked);

  async function fetchLanInfo() {
    if (!lanAddress) return;
    lanAddress.textContent = window._('Yükleniyor...');
    try {
      const data = await apiJson('/api/lan-info');
      if (Array.isArray(data.ips) && data.ips.length > 0) {
        lanAddress.textContent = `${data.ssl ? 'https://' : 'http://'}${data.ips[0]}:${data.port}`;
        return;
      }
      lanAddress.textContent = window._('Ağ bağlantısı bulunamadı');
    } catch {
      lanAddress.textContent = window._('Bilgi alınamadı');
    }
  }

  function showPending() {
    if (!lanInfoBox) return;
    lanInfoBox.classList.remove('hidden');
    if (lanAddressWrap) lanAddressWrap.classList.add('hidden');
    if (lanPendingNote) {
      lanPendingNote.classList.remove('hidden');
    } else if (lanAddress) {
      lanAddress.textContent = window._('Ağ bağlantısı bulunamadı');
    }
  }

  function showActive() {
    if (!lanInfoBox) return;
    lanInfoBox.classList.remove('hidden');
    if (lanAddressWrap) lanAddressWrap.classList.remove('hidden');
    if (lanPendingNote) lanPendingNote.classList.add('hidden');
    fetchLanInfo();
  }

  function hide() {
    lanInfoBox?.classList.add('hidden');
  }

  // LAN zaten kayıtlı ve çalışıyorken sayfa yüklendiyse adresi doğrudan göster.
  if (lanActiveOnLoad) {
    showActive();
  }

  return { lanToggle, lanInfoBox, lanAddress, fetchLanInfo, showPending, showActive, hide };

}
