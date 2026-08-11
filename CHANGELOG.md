# ŞifreKasam Changelog

## [2.7.0-beta.1] - 2026-08-11

Bu sürüm; `main` dalındaki v2.6.3-beta.1 (8acc2b2) commitinden itibaren ve `experimental` dalının oluşturulduğu tarihten itibaren biriken tüm değişiklikleri içerir.

### 🔐 Güvenlik
- **CSRF koruması** eklendi (tüm mutasyon isteklerinde).
- **Zayıf parola zorunluluğu**: ana parola güncellenirken zayıf parolalar reddediliyor.
- **Yerel sertifika sabitleme (cert pinning)**: sertifika güven iletişimi, parmak izi önbelleği, PEM normalizasyonu ve doğru dosya izinleri.
- `cryptography` 49.0.0'a güncellendi (CVE-2026-39892 düzeltmesi).
- `theme.json` kaydedilirken PermissionError'a karşı 3 denemeli atomik yazma, başarısızlıkta doğrudan yazma fallback'i.

### ✨ Yeni Özellikler
- **3 modlu tema**: Açık / Koyu / Sistem.
- **Donanım hızlandırma kapatma anahtarı**: başlangıçta devre dışı bırakma + uyarı bildirimi.
- **İçerik koruma (content protection) anahtarı**.
- **LAN erişimi onayı**: LAN etkinleştirilirken kullanıcı onayı isteniyor + "Bu programın yeniden başlatılması gerekebilir." notu.
- **Arka plan galerisi**: meta veri, aktif arka plan göstergesi, ARIA desteği, yarış koşulu kilidi; aktif arka plan silindiğinde geçmiş korunuyor.
- Yeni API: `/api/background/all`.
- **Kaydırma üzerine anında frost**: yeniden görünen kartlar anında buzlu cam efekti alıyor.
- Admin uyarı bildirimi.
- Ayarlar açılır menüsü ve görünüm ızgarası.

### 🎨 Görünüm / Glass
- `style.css` 16 kapsamlı modüle, `app.js` 11 ES modülüne bölündü (DI bağlantısı ile davranış korundu).
- Glass yüzeyleri `glass.css` içine ayrıştırıldı.
- Glass 3 katmanlı kalite zenginleştirme + kube.io SVG kırınımı.
- Glass v2 tüm yüzeylere uygulandı.
- Kart frostu glass gradyanına gömüldü (backdrop bağımsızlığı), hover transform ile kompozisyon artefaktı olmadan.
- Kromalı görünüm kilidi, `kasa-field`, kart sayfalama, filtre-boş durum, kasa güç/generatör panellerinde proje geneli frost.
- Arka plan ön yükleme ve Pillow başlık doğrulama.

### 🛠️ Hata Düzeltmeleri
- **LAN runtime senkronizasyonu**: kayıtlı değer ile gerçek çalışma zamanı değeri karşılaştırılıyor (eski önbellek değil) — her kayıtta yeniden başlatma fırtınası ve takılı yükleme ekranı önlendi.
- `theme.json` PermissionError yeniden deneme + Squirrel olay günlüğü.
- İkinci örnek IPC (ikinci açılışta ana pencereye odaklanma).
- Flask yaşam döngüsü sağlamlaştırıldı.
- Tümünü seç sıralaması ve açılır menü kapanma düzeltmesi.
- SSL handshake gürültüsü susturuldu (log-level 3).

### ⚙️ Diğer
- Sürüm **2.7.0-beta.1**'e yükseltildi.
- Eksik eski sürüm kaldırma anahtarları eklendi: `sifrekasam_v2.5.10`, `sifrekasam_v2.6.2-beta.2`.
- Test paketi `tests/test_kasa.py` içinde konsolide edildi.
- Build; önizleme, test, md, db ve sertifika dosyalarını hariç tutar.
- Geliştirici önizleme düzeneği: `glass-preview.html`.
