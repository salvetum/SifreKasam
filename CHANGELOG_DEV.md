# ŞifreKasam Geliştirme Changelog

Bu dosya, **2.7.0-beta.1** sürümünden itibaren geliştirme dalında (çalışma ağacında) yapılan ve henüz yayınlanmamış değişiklikleri izler. Yayınlanmış sürüm notları için `CHANGELOG.md` dosyasına bakın.

## Yayınlanmamış — 2.7.0-beta.2 üzeri

### ✨ Yeni Özellikler

- **Tasarruf Modu (power-save) anahtarı**: Görünüm ayarlarına açma/kapama eklendi. `power_save_enabled` veritabanında saklanıyor, `data-kasa-power-save` niteliği + localStorage ile eşitleniyor; heartbeat modülü MutationObserver ile anında tepki veriyor. Kapalıyken arka plan/idle düşük güç modu tamamen devre dışı.
- **Video arka plan desteği (WebM / MP4)**: Özel arka plan yükleme artık video kabul ediyor; `#custom-bg-video` oynatıcısı, video küçük resim önizlemeleri ve yüklendikten sonra yumuşak geçiş (`is-loaded`). `MAX_CONTENT_LENGTH` 20 MB → 64 MB, `CUSTOM_BACKGROUND_MAX_VIDEO_BYTES` limiti eklendi.
- **Yükleme hız sınırı**: `CUSTOM_BACKGROUND_UPLOAD_MAX_PER_WINDOW` + `CUSTOM_BACKGROUND_UPLOAD_WINDOW_SECONDS` ile özel arka plan yükleme pencereli hız sınırına alındı ("Çok fazla istek" uyarısı).
- **Görsel çözünürlük sınırı**: Özel arka plan için 24 MP ve maksimum kenar 8192 px sınırı net hata mesajıyla kullanıcıya bildiriliyor.
- **E-posta alanı**: Kayıtlara username/email/password ayrımı eklendi; ekle/düzenle formu, kart detayları, içe/dışa aktarma, raporlar, şifre gücü bağlamı ve çeviriler (tr/en) güncellendi. Kayıt tipine göre gösterim: CreditCard ve SecureNote'da e-posta gizli.
- **Ana Şifre (Tekrar) alanı**: İlk kurulumda ana şifre tekrarı isteniyor; eşleşme kontrolü ve canlı uyarı eklendi.
- **Özel arkaplan limit bilgi notu**: Arkaplan galerisinde "8 taneye kadar arkaplan ekleyebilirsiniz." açıklaması eklendi (tr/en çevirileriyle).

### 🐛 Hata Düzeltmeleri

- **Özel arka plan artık tüm sayfalarda yükleniyor**: Görünüm başlatma mantığı (`applyAppearance`) yalnızca görünüm kontrolleri olan sayfalarda (index) çalışıyordu; kayıt ekleme (`ekle`) ve şifre sağlığı (`saglik`) sayfalarında `is-loaded` hiç eklenmediği için özel arka plan `opacity: 0`'da kalıyordu. Başlangıç uygulaması `initAppearanceSettings` içinde koşulsuz çalışacak şekilde düzeltildi.
- **Dropdown açılır menüsü kayıt ekleme ekranında yanlış yöne açılıyordu**: Sınır hesaplaması `.vault-form-panel` (overflow görünür) gibi kısa sarmalayıcıyı clip konteyneri sayıyordu; gerçek overflow `auto/scroll/hidden` taşıyan atalara göre sınır belirlenmeye başlandı, menü artık viewport'ta aşağıda yer varken aşağı açılıyor.
- **"Not" (SecureNote) kayıt tipinde "Giriş Bilgileri" bölümü tamamen gizleniyor**: Alanlar tek tek gizleniyordu ama bölüm başlığı boş görünüyordu; artık `#login_password_row` bölümünün tamamı `showAccess` anahtarıyla gizleniyor.
- **Tasarruf modundan çıkışta beyaz yanıp sönme (flash) giderildi**: `forceRendererRepaint` görünürlük geçişi + reflow yerine `#kasa-page-shell` üzerinde yumuşak 300 ms opacity fade'i (`kasa-resume-fade`) uyguluyor; ekran düzgün şekilde "yeniden uyanıyor".
- **Özel arkaplan galerisi tooltip'i artık üstte takılı kalmıyor**: tooltip z-index'i yükseltildi, hover edilen küçük resim diğerlerinin üzerine çıkıyor.

### 🎨 Görünüm / Glass

- **Tasarruf Modu bildirimi köşeye taşındı**: Tam ekran kaplama yerine sağ altta kompakt toast kartı (sürüklenmeden kaybolan görünüm).
- **`kasa-glass-warning` kartı** buzlu cam efektine geçirildi (`backdrop-filter` eklendi).
- **Filtre belirme yanıp sönmesi düzeltildi**: `filterFadeIn` artık yalnızca opacity animasyonu (transform içermez) → kart cam buğusu iki aşamalı görünmüyor.
- **`settings-card` cam kalite seviyelerine eklendi**: glass normal/high/low/off ve açık temada kenar vurgusu/speküler tutarlılığı.
- **`settings-theme-card` yatay düzene geçirildi** (başlık + kontrol aynı satırda).
- **Varsayılan arka plan dokusu zenginleştirildi**: fraktal noise'a ek olarak accent renkli ışık lekeleri eklendi (cam altında renkli buzlanma hissi); "plain" arka planda yalnızca noise kalıyor.
- **Özel arka plan geçişi**: yüklendikten sonra 320 ms fade-in; `data-bg-type` ile resim/video ayrımı.
- **Küçük resim tooltip'i yeniden tasarlandı**: taşma yerine kart üzerinde yüzen bilgi balonu (`:has()` ile z-index yönetimi).
- **`custom-select` açılır menüsü**: doğal yüksekliğe sığan menülerde artık `max-height` kısıtı uygulanmıyor.
- **Fraktal grain kaldırıldı**: `#default-bg-texture` artık yalnızca yumuşak accent ışık lekeleri içeriyor; `plain` arka planda doku katmanı tamamen gizleniyor; `glass-grain` opaklıkları belirgin şekilde azaltıldı.
- **Varsayılan modda da buğu/toast efekti**: `#default-bg-texture`'a ekran ortasında iki yeni ışık lekesi eklendi (modallar, diyaloglar, toplu seç açılır menüleri/tostları cam blur'unu besliyor); doku opaklığı 0.16→0.20 (yüksek 0.24, açık tema 0.13) yükseltildi.
- **Butonlara güçlü buğu lensi**: yeni `--btn-vivid-blur` token'ı (varsayılan blur 14px + saturate 1.8; açık 12px/1.6; yüksek 18px/2.0; düşük kalitede yok) `.kasa-btn` (primary hariç), `.filter-btn`, `.icon-btn`, `.card-icon-btn`, `.kasa-close-btn` ve `.kasa-dropdown-trigger` üzerinde uygulanıyor.
- **Buton vibrance (yalnızca butonlar)**: koyu temada buton metinleri parlatıldı, danger kırmızı vurgusu güçlendirildi (metin `#ff7a7a`, zemin kırmızı sızması ≈2 kat, kenarlık 0.48/hover 0.60 + kırmızı dış parıltı); açık temada buton zemini daha saydam (0.72→0.62) ve metinler daha derin lacivert.
- **Ayarlar dropdown menüsü custom mod hissi varsayılan moda taşındı**: menü lensi `--btn-vivid-blur`'a alındı, üst parlamalı (sheen) cam malzeme + accent/accent-2 ışıltıları eklendi; dişli trigger hapı parlatıldı ve buğu lensine dahil edildi.
- **Cam kalitesi / RGB döngü süresi ayar kartları hizalandı**: glass kalite (ölçekler hariç) ve renk döngüsü süresi kartları tema kartı gibi yatay düzene geçirildi — başlık solda, açılır menü sağda; dar ekranda dikeye dönüyor.
- **Özel arkaplan galerisi görünümü**: "Aktif" rozeti küçük resmin altında tam genişlik şeride taşındı, silme butonu simgesi ortaladı.
- **Tarih seçici animasyonları**: takvim popup'ı artık `is-open` sınıfı + requestAnimationFrame ile yumuşak fade/scale ile açılıp kapanıyor (`hidden`/display geçişi transition'ı öldürdüğü için daha önce hiç animasyon yoktu); ay/yıl değişiminde başlık fade'i + gün ızgarasına yumuşak giriş (translateY + scale), seçili güne ölçekli pop, gezinme butonlarına basınç (press) animasyonu eklendi.
- **Şifre üretici (ekle sayfası)**: "Yeni Şifre Oluştur" sonrası şifre alanına uygulanan sert `shake` (sağa-sola sarsıntı) kaldırıldı; yerine modal üreticiyle aynı dilde yumuşak accent ışıltı pulse'ı (`generatorPasswordPulse`) geldi. Shake yalnızca hata/uyarı bağlamında kalıyor (ör. son karakter tipinin kilitlenmesi).
- **Modal şifre üretici seçenekleri**: `.generator-option-grid label` hover artık geçişli (border/background + yukarı kalkma) — ekle sayfasındaki seçeneklerle tutarlı hale getirildi.
- **Arama kutusu hover parıltısı**: `#search-input` hover/focus'ta accent dış ışıma (box-shadow halkası) eklendi (border-color zaten geçişliydi).
- **Varsayılan moda custom arkaplan cam efektleri taşındı**: `#default-bg-texture` artık yalnızca birkaç büyük yumuşak lekeye değil, tüm viewport'a dağılmış 26 renkli bokeh lekesine sahip (14 orta-boy + 12 ince; accent/accent-2/zümrüt/gül); böylece kartlar, butonlar, arama kutusu, filtre hapları ve dropdown menüleri gibi HER cam yüzeyin `backdrop-filter` blur'u custom görseldeki gibi "buzlu ve renkli" görünüyor (tek başına büyük lekeler blur'un bulanıklaştırabileceği detayı vermiyordu; ince lekeler blur yarıçapına yakın uzamsal frekans sağlar). Doku opaklığı 0.22→0.32 (yüksek 0.38, açık tema 0.18) yükseltildi.
- **Varsayılan moda custom perdesi (veil) taşındı**: yeni `#default-bg-veil` katmanı, custom moddaki `#custom-bg-layer::after`'ın birebir kopyası (koyu: %50 siyah + merkez radyal; açık: %42 beyaz + radyal). Arkaplanı koyulaştırıp cam yüzeylerin beyaz kenarlarını ve blur'unu custom'daki gibi belirginleştiriyor; custom/plain/glass-effects-off/düşük güç modlarında gizleniyor.
- **Metin gölgeleri genelleştirildi**: `data-kasa-background="custom"` koşulundan çıkarılıp tüm arkaplanlarda uygulanıyor (başlıklar + vault kart metinleri; koyu temada koyu, açık temada beyaz gölge; `#settingsModal` istisnası korunuyor).
- **Muted metin rengi genelleştirildi**: `.text-kasa-text-muted` artık custom koşuluna bağlı değil — koyu temada `#d8ddeb`, açık temada `#3a4a6b` her arkaplanda geçerli.
- **"Arayüz animasyonları" kapalıyken cam saydamlık hissi korundu**: `data-kasa-animations="off"` kill-switch'i artık tüm geçişleri değil yalnızca hareketi (transform/translate/scale/rotate/left/top/right/bottom → 0.001ms) öldürüyor; `opacity` geçişleri 150 ms yumuşak kalıyor. Böylece modal/paneller anında "patlamak" yerine saydamlaşarak beliriyor, cam blur'una (backdrop-filter) dokunulmuyor — cam efekti korunuyor.

### ⚡ Performans / CPU

- **LAN tarayıcı sıklığı azaltıldı**: LAN etkinken 5 s, boştayken 20 s (durum değişince yeniden planlanıyor).
- **Kromatik vurgu döngüsü**: 60 fps `requestAnimationFrame` yerine 200 ms `setTimeout`; pencere gizliyken tamamen duruyor.
- **Keep-alive bağlantı havuzu**: ana süreç backend istekleri en fazla 4 soketlik kalıcı `https.Agent` kullanıyor; sertifika sıfırlandığında havuz yenileniyor.
- **WSGI sunucusu**: Werkzeug yerine TLS destekli **Cheroot** (`requirements.txt`); kurulu değilse Werkzeug fallback korunuyor.

### 🛡️ Güvenlik / Bakım

- `security_lint.py`: `.style` kuralı `\.style\.cssText\b` ile daraltıldı (`.style.foo` atamaları yanlış pozitif vermiyor).
- Uninstall kayıt defteri temizliğine **2.7.0-beta.1** anahtarları eklendi.
- Service worker: özel arka plan API yanıtları için cache-first (`/api/background/current`, `/api/background/history/*`).

### 🧪 Testler

- `tests/test_kasa.py` kayıt formu / e-posta alanı ve özel arka plan senaryolarıyla genişletildi (103 test + 36 alt senaryo geçiyor).

### ⚙️ Diğer

- Sürüm **2.7.0-beta.2**'ye yükseltildi (`package.json` / `package-lock.json`).
- `base.css?v=70`, `sw.js` v83 sürümleri güncellendi.
- Tüm JS modülleri başlık yorumlarında **2.7.0-beta.2**'ye güncellendi.
- Cache sürümleri güncellendi: `base.css?v=71`, `background.css?v=77`, `glass.css?v=77`, `settings-modal.css?v=71`, `buttons.css?v=70`, `misc.css?v=69`, `theme-states.css?v=70`, `sw.js` assets-v89.
- Animasyon kill-switch düzeltmesiyle: `base.css?v=72`, `sw.js` assets-v94.
