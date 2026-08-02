/**
 * ŞifreKasam v2.6.3-beta.2 - LAN Erişimi modülü (ES Module)
 *
 * 3b. bölüm: LAN toggle / bilgi kutusu ve fetchLanInfo.
 * initLanSettings, app.js içindeki DOMContentLoaded sırasında çağrılır;
 * ayarlar formu lanToggle / lanInfoBox / fetchLanInfo kullandığı için döndürülür.
 */

export function initLanSettings({ apiJson }) {

  const lanToggle = document.getElementById('lan-enabled-toggle');
  const lanInfoBox = document.getElementById('lan-info-box');
  const lanAddress = document.getElementById('lan-address');

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

  if (lanToggle && lanInfoBox) {
    lanToggle.addEventListener('change', function () {
      if (lanToggle.checked) {
        lanInfoBox.classList.remove('hidden');
        fetchLanInfo();
      } else {
        lanInfoBox.classList.add('hidden');
      }
    });

    if (lanToggle.checked) {
      fetchLanInfo();
    }
  }

  return { lanToggle, lanInfoBox, fetchLanInfo };

}