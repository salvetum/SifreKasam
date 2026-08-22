# ŞifreKasam Geliştirme Changelog

Bu dosya, **2.7.0-beta.1** sürümünden itibaren geliştirme dalında (çalışma ağacında) yapılan ve henüz yayınlanmamış değişiklikleri izler.

## Yayınlanmamış — 2.7.0-beta.2 — 23.08.2026

### ✨ Yeni Özellikler

- **Rastgele Renk seçici**: Renk seçici popover'ına "Rastgele" butonu eklendi (`fa-dice` ikonu). Her tıklamada rastgele Hue (0–360°), Doygunluk (65–89%) ve Parlaklık (55–84%) üreterek anında uygulanıyor — çok koyu veya çok açık olmayan pigmentli renkler üretir. HEX input + Reset butonunun yanına, code-row grid'i 3 sütuna genişletildi (mobilde tek sütuna düşmeye devam ediyor). (`index.html`, `appearance-settings.js`, `custom-select.css`, `en.json`)

- **Vault Accent Renk Toggle**: Görünüm ayarlarına "Kart Vurgu Rengi" anahtarı eklendi. `data-kasa-vault-accent` attribute + localStorage ile anında tepki veriyor; `/settings/appearance` endpoint'ine `vault_accent_enabled` POST ile sunucuda saklanıyor. Kapalıyken vault kartlarında accent radial-gradient, sheen accent ışıltısı ve gradient-off solid renkler tamamen kaldırılıyor; kartlar nötr cam yüzeye geçiyor (dark/light × glass-effects-off × gradient-off × low-power × low-quality tüm kombinasyonlar destekleniyor). Backend: `constants.py` (`DEFAULT_VAULT_ACCENT_ENABLED`), `appearance.py` (`get_vault_accent_enabled` / `save_vault_accent`), `app.py` (`/settings/appearance` GET/POST). Frontend: `index.html` toggle HTML, `appearance-settings.js` (`setupThemeFeatureToggle`), `app.js` (`applyThemeFeature`), `base.html` localStorage init, `cards.css` accent-off kuralları, `en.json` çevirileri.
- **Tasarruf Modu (power-save) anahtarı**: Görünüm ayarlarına açma/kapama eklendi. `power_save_enabled` veritabanında saklanıyor, `data-kasa-power-save` niteliği + localStorage ile eşitleniyor; heartbeat modülü MutationObserver ile anında tepki veriyor. Kapalıyken arka plan/idle düşük güç modu tamamen devre dışı.
- **Video arka plan desteği (WebM / MP4)**: Özel arka plan yükleme artık video kabul ediyor; `#custom-bg-video` oynatıcısı, video küçük resim önizlemeleri ve yüklendikten sonra yumuşak geçiş (`is-loaded`). `MAX_CONTENT_LENGTH` 20 MB → 64 MB, `CUSTOM_BACKGROUND_MAX_VIDEO_BYTES` limiti eklendi.
- **Yükleme hız sınırı**: `CUSTOM_BACKGROUND_UPLOAD_MAX_PER_WINDOW` + `CUSTOM_BACKGROUND_UPLOAD_WINDOW_SECONDS` ile özel arka plan yükleme pencereli hız sınırına alındı ("Çok fazla istek" uyarısı).
- **Görsel çözünürlük sınırı**: Özel arka plan için 24 MP ve maksimum kenar 8192 px sınırı net hata mesajıyla kullanıcıya bildiriliyor.
- **E-posta alanı**: Kayıtlara username/email/password ayrımı eklendi; ekle/düzenle formu, kart detayları, içe/dışa aktarma, raporlar, şifre gücü bağlamı ve çeviriler (tr/en) güncellendi. Kayıt tipine göre gösterim: CreditCard ve SecureNote'da e-posta gizli.
- **Ana Şifre (Tekrar) alanı**: İlk kurulumda ana şifre tekrarı isteniyor; eşleşme kontrolü ve canlı uyarı eklendi.
- **Özel arkaplan limit bilgi notu**: Arkaplan galerisinde "8 taneye kadar arkaplan ekleyebilirsiniz." açıklaması eklendi (tr/en çevirileriyle).
- **Kredi Kartı formuna kart alanları**: "Kart Üzerindeki İsim" alanı eklendi (yeni şifreli `card_holder` sütunu; DB açılışta otomatik `ALTER TABLE`, içe/dışa aktarmaya dahil). "Süre" paneli kart tipinde takvim yerine **Ay/Yıl** girişlerini gösteriyor; ay/yıl ve takvim aynı `expiry_date` alanına yazıyor (kart sonu → ayın son günü kaydedilir, süre rozeti erken dolmuş göstermez). Diğer tiplerde takvim aynen kalıyor.
- **Ekle/düzenle formu tip geçiş animasyonu**: Kayıt tipi değiştirilirken alanlar artık `max-height` + `opacity` ile yumuşak açılıp kapanıyor (280 ms giriş / 200 ms çıkış); sayfa doğal şekilde uzuyor/kısalıyor.
- **Tüm arkaplan modlarında tutarlı cam yüzey netliği**: `plain` modunda `body::before/after` blob'lar, `#default-bg-texture` (bokeh detayı) ve `#default-bg-veil` (koyulaştırıcı perde) gizliydi — kaldırıldı; artık `aurora/midnight/mesh/plain` hepsinde aynı cam efektleri görünür. `#default-bg-texture` opacity artırıldı (0.32→0.80 dark, 0.38→0.80 high-quality, 0.18→0.38 light) ve `#default-bg-veil` karartması güçlendirildi (lineer 0.50→0.62 siyah, radyal 0.16→0.26) — default moddaki cam yüzeyler (dropdown menü, toplu seç modalı, butonlar) artık custom arkaplandaki kadar buzlu ve belirgin görünüyor. (`background.css`, `base.html`, `sw.js` assets-v111)

### 🐛 Hata Düzeltmeleri

- **1200×800'de sayfalama butonları tıklanamıyordu**: `#bulk-toolbar` (`position: fixed; bottom: 1.5rem`) `opacity: 0` olmasına rağmen `pointer-events: none` içermediği için sayfalama alanının sol tarafını kaplıyor, click event'lerini yutuyordu. Düzeltme: `opacity: 0` iken `pointer-events: none`, `.is-visible` iken `pointer-events: auto` eklendi (`utilities.css`).
- **Sayfa geçişlerinde çift render flash**: `goToCardPage` çağrıldığında eski kartlar hâlâ görünürken yeni kartlar render ediliyordu. Düzeltme: sayfa geçişinde önce `vault-card-curtain` ekleniyor (`visibility: hidden`), `filterCards` synchronous olarak kartları değiştiriyor, çift `requestAnimationFrame` ile curtain kaldırılıyor — kartlar render bitmeden hiç görünmüyor (`vault-index.js`).

- **Vault glass çift render perdeleme (curtain) ile kökten çözüldü**: `glass-ready` bayrağı + `opacity:0` approach'u kaldırıldı; yerine `#card-container`'a `.vault-card-curtain` class'ı (`visibility:hidden`) ve ilk `filterCards()` sonrası `requestAnimationFrame` ile kaldırma eklendi. `visibility:hidden` layout'u koruduğu için Chromium backdrop-filter compositing'i ilk frame'de tamamlanıyor — kartlar görünür olduğunda cam buğu zaten hazır, hiçbir "pop" flash oluşmuyor. `liquid-glass.js` vault kartlarından tamamen çıkarıldı.
- **Vault glass sistemi sıfırdan yeniden yazıldı (cards.css)**: `glass.css`'teki tüm vault-specific kurallar kaldırıldı; `cards.css`'e dark/light × glass-effects-off × gradient-off × low-power × low-quality fallbackleri, sheen (`::before`), frame (`::after`), depth shadows ve accent-off kuralları birebir taşındı. Vault kartları artık `--glass-blur` (12px, diğer cam elemanlarıyla aynı) kullanıyor; `--glass-vivid-blur` (10px) yerine.
- **`setCardVisible` yeniden yazıldı**: `void wrapper.offsetWidth` (forced reflow → paint) kaldırıldı, `requestAnimationFrame` ile `card-animated` class ekleniyor; glass flash oluşmuyor.
- **`card-animated` vault kart wrapper'dan kaldırıldı**: CSS animasyon class'ı vault kartlarında composited layer oluşturup backdrop-filter compositing'i bozuyordu.
- **Kredi Kartı formu düzeltmeleri**: kart numarası placeholder alanı, `card_holder` grubunun doğru yere taşınması, süre spinner stepper, `en.json` çevirileri.
- **Eksik animasyonlar giderildi**: pagination navigasyon, LAN settings, galeri, şifre üretici, settings tab panel, bulk toolbar — tümü `is-visible` pattern ile yumuşak geçiş.
- **Vault accent toggle CSS attribute uyumsuzluğu düzeltildi**: `cards.css`'teki accent-off kuralları `data-vault-accent` kullanıyordu ama JS/base.html `data-kasa-vault-accent` set ediyordu — hiçbir CSS kuralı eşleşmiyordu. Tüm selector'lar `data-kasa-vault-accent` olarak düzeltildi.
- **Özel arka plan artık tüm sayfalarda yükleniyor**: Görünüm başlatma mantığı (`applyAppearance`) yalnızca görünüm kontrolleri olan sayfalarda (index) çalışıyordu; kayıt ekleme (`ekle`) ve şifre sağlığı (`saglik`) sayfalarında `is-loaded` hiç eklenmediği için özel arka plan `opacity: 0`'da kalıyordu. Başlangıç uygulaması `initAppearanceSettings` içinde koşulsuz çalışacak şekilde düzeltildi.
- **Dropdown açılır menüsü kayıt ekleme ekranında yanlış yöne açılıyordu**: Sınır hesaplaması `.vault-form-panel` (overflow görünür) gibi kısa sarmalayıcıyı clip konteyneri sayıyordu; gerçek overflow `auto/scroll/hidden` taşıyan atalara göre sınır belirlenmeye başlandı, menü artık viewport'ta aşağıda yer varken aşağı açılıyor.
- **"Not" (SecureNote) kayıt tipinde "Giriş Bilgileri" bölümü tamamen gizleniyor**: Alanlar tek tek gizleniyordu ama bölüm başlığı boş görünüyordu; artık `#login_password_row` bölümünün tamamı `showAccess` anahtarıyla gizleniyor.
- **Tasarruf modundan çıkışta beyaz yanıp sönme (flash) giderildi**: `forceRendererRepaint` görünürlük geçişi + reflow yerine `#kasa-page-shell` üzerinde yumuşak 300 ms opacity fade'i (`kasa-resume-fade`) uyguluyor; ekran düzgün şekilde "yeniden uyanıyor".
- **Özel arkaplan galerisi tooltip'i artık üstte takılı kalmıyor**: tooltip z-index'i yükseltildi, hover edilen küçük resim diğerlerinin üzerine çıkıyor.
- **LAN modu uyarı kartları ve şifre gösterimi düzeltildi**: LAN açıkken uyarı kartları (`lan-warning-card`) her zaman görünürdü, LAN kapatılınca bile kalıyordu — artık toggle ile senkronize gizleniyor/gösteriliyor (`lan-warning-cards` konteyneri + CSS geçişi). `lan-password-wrap` template'de `hidden` class taşıyordu ama JS `_showEl()` yalnızca `is-visible` ekliyordu — `hidden` kaldırıldı, CSS `opacity: 0; max-height: 0` ile gizlemeyi zaten yönetiyor. (`index.html`, `lan-settings.js`, `settings-modal.css`)
- **Özel arkaplan yüklerken toast'ta HTML kodu görünüyordu**: `appearance-settings.js`'de `escapeHTML: false` ile `<i>` spinner HTML'i gönderiliyor ama yerel `toastify.min.js` her zaman `textContent` kullanıyordu — HTML kodu düz metin olarak kısa süreliğine görünüyordu. `escapeHTML` ve HTML kaldırıldı, düz metin `window._('Yükleniyor...')` kullanılıyor. (`appearance-settings.js`)
- **KRİTİK — cheroot yoksa backend çöküyordu**: `except ImportError` fallback'i tanımsız `ssl_ctx` kullanıyordu → cheroot kurulu değilken `NameError` ile uygulama hiç açılmıyordu. Fallback'te `ssl_ctx = (CERT_FILE, KEY_FILE)` çifti geri getirildi. Cheroot kaldırılıp uygulama başlatılarak (Werkzeug HTTPS, hata yok) ve geri kurulup cheroot yolu (sessiz başlangıç) ile test edildi.
- **`app.spec` hiddenimports'larına `cheroot`, `cheroot.wsgi`, `cheroot.ssl.builtin` eklendi**: PyInstaller'ın cheroot'u pakete dahil etmesi garanti edildi. Gerçek build alınıp exe çalıştırıldı; PYZ arşivinde `cheroot.wsgi`/`cheroot.ssl.builtin` doğrulandı, exe dinliyor ve Werkzeug banner'ı yok (cheroot yolu aktif).
- **Glass çift render (patlayan buğu) giderildi**: `glass.css`'teki `--glass-vivid-blur` high-quality değerleri `liquid-glass.js` medium-tier değerleriyle eşleştirildi (dark: saturate 1.8→1.3, light: 1.6→1.3). Böylece CSS ilk paint'te doğru buğu değerini veriyor, JS devreye girdiğinde değer değişmediği için görünür "pop" kalkıyor.
- **Vault form tip geçiş hatası düzeltildi**: `vault-form.js`'deki fazla `}` karakteri `if (kayitTipiSelect)` bloğunu erken kapatıyordu; `toggleFormFields` fonksiyonu ve `change` event listener hiç tanımlanmıyordu → tip değiştirmek hiçbir şey yapmıyordu.
- **`animateToggle` basitleştirildi**: `max-height` animasyonu kaldırıldı, yalnızca `opacity` geçişi kalıyor (show: 220 ms, hide: 160 ms + 200 ms timeout ile `el.hidden=true`).
- **Glass çift render kök çözümü (glass-ready bayrağı)**: `liquid-glass.js` ilk `refreshAll()` sonrası `requestAnimationFrame` ile `<html>`'e `glass-ready` sınıfı ekliyor; `glass.css`'teki `html:not(.glass-ready) .vault-card-shell.glass { opacity: 0 }` kuralı kartları JS hazır olmadan gizliyor. Kartlar 250 ms opacity geçişiyle görünür oluyor — CSS→JS backdrop-filter "pop" flash'ı tamamen ortadan kalkıyor.
- **Glass flash arama/filtre/geçişlerde de giderildi**: `liquid-glass.js`'e `window.__kasaGlassApply(el)`暴露 edildi; `vault-index.js` `setCardVisible()` içinde kart görünür olduğunda `void wrapper.offsetWidth` (forced reflow → paint)）dan HEMEN ÖNCE çağrılıyor. Böylece tarayıcı ilk karede doğru backdrop-filter ile boyuyor, CSS→JS geçiş flash'ı oluşmuyor.
- **Filtre/kategori geçiş animasyonları yumuşatıldı**: `filterFadeIn` 0.22s → 0.3s (`cubic-bezier(0.16,1,0.3,1)` — ilk açılış efektiyle aynı eğri); kategori geçiş animasyonu 240ms → 300ms. Çift render olsa bile smooth opacity geçişi.
- **CVV alanı düzeltmeleri (Kredi Kartı)**: CVV girişine `maxLength=3`, `inputmode=numeric`, `pattern=[0-9]*` eklendi; şifre üretici butonu ve güç kartı kart tipinde gizleniyor; orijinal attributeler diğer tiplerde geri yükleniyor.
- **Kredi Kartı formunda takvim alanının tamamı gizleniyor**: Takvim inner container değil, tüm `vault-field` wrapper'ı (etiket + help text dahil) kart tipinde gizleniyor.
- **Özel arkaplan geçiş bug'ı düzeltildi**: Özel arkaplan aktifken varsayılan bir arkaplana geçildiğinde galeri artık yenileniyor; böylece "Aktif" rozeti doğru şekilde "Kayıtlı"'ya dönüşüyor ve eski durum kalmıyor.

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
- **Özel arkaplan aktifken hareketli arkaplan toggle'ı devre dışı**: `syncAppearanceControls` içinde `motionToggle.disabled` + kart `is-bg-locked` class'ı; gri opacity ve `::after` nokta göstergesi.
- **Galeri rozet mantığı**: Özel arkaplan modu (`data-kasa-background="custom"`) aktifken "Aktif", diğer modlarda "Kayıtlı" rozeti gösteriliyor; `.custom-bg-thumb-badge-saved` stili eklendi (koyu/açık tema).
- **Tarih seçici animasyonları**: takvim popup'ı artık `is-open` sınıfı + requestAnimationFrame ile yumuşak fade/scale ile açılıp kapanıyor (`hidden`/display geçişi transition'ı öldürdüğü için daha önce hiç animasyon yoktu); ay/yıl değişiminde başlık fade'i + gün ızgarasına yumuşak giriş (translateY + scale), seçili güne ölçekli pop, gezinme butonlarına basınç (press) animasyonu eklendi.
- **Şifre üretici (ekle sayfası)**: "Yeni Şifre Oluştur" sonrası şifre alanına uygulanan sert `shake` (sağa-sola sarsıntı) kaldırıldı; yerine modal üreticiyle aynı dilde yumuşak accent ışıltı pulse'ı (`generatorPasswordPulse`) geldi. Shake yalnızca hata/uyarı bağlamında kalıyor (ör. son karakter tipinin kilitlenmesi).
- **Modal şifre üretici seçenekleri**: `.generator-option-grid label` hover artık geçişli (border/background + yukarı kalkma) — ekle sayfasındaki seçeneklerle tutarlı hale getirildi.
- **Arama kutusu hover parıltısı**: `#search-input` hover/focus'ta accent dış ışıma (box-shadow halkası) eklendi (border-color zaten geçişliydi).
- **Varsayılan moda custom arkaplan cam efektleri taşındı**: `#default-bg-texture` artık yalnızca birkaç büyük yumuşak lekeye değil, tüm viewport'a dağılmış 26 renkli bokeh lekesine sahip (14 orta-boy + 12 ince; accent/accent-2/zümrüt/gül); böylece kartlar, butonlar, arama kutusu, filtre hapları ve dropdown menüleri gibi HER cam yüzeyin `backdrop-filter` blur'u custom görseldeki gibi "buzlu ve renkli" görünüyor (tek başına büyük lekeler blur'un bulanıklaştırabileceği detayı vermiyordu; ince lekeler blur yarıçapına yakın uzamsal frekans sağlar). Doku opaklığı 0.22→0.32 (yüksek 0.38, açık tema 0.18) yükseltildi.
- **Varsayılan moda custom perdesi (veil) taşındı**: yeni `#default-bg-veil` katmanı, custom moddaki `#custom-bg-layer::after`'ın birebir kopyası (koyu: %50 siyah + merkez radyal; açık: %42 beyaz + radyal). Arkaplanı koyulaştırıp cam yüzeylerin beyaz kenarlarını ve blur'unu custom'daki gibi belirginleştiriyor; custom/plain/glass-effects-off/düşük güç modlarında gizleniyor.
- **Metin gölgeleri genelleştirildi**: `data-kasa-background="custom"` koşulundan çıkarılıp tüm arkaplanlarda uygulanıyor (başlıklar + vault kart metinleri; koyu temada koyu, açık temada beyaz gölge; `#settingsModal` istisnası korunuyor).
- **Muted metin rengi genelleştirildi**: `.text-kasa-text-muted` artık custom koşuluna bağlı değil — koyu temada `#d8ddeb`, açık temada `#3a4a6b` her arkaplanda geçerli.
- **"Arayüz animasyonları" kapalıyken cam saydamlık hissi korundu**: `data-kasa-animations="off"` kill-switch'i artık tüm geçişleri değil yalnızca hareketi (transform/translate/scale/rotate/left/top/right/bottom → 0.001ms) öldürüyor; `opacity` geçişleri 150 ms yumuşak kalıyor. Böylece modal/paneller anında "patlamak" yerine saydamlaşarak beliriyor, cam blur'una (backdrop-filter) dokunulmuyor — cam efekti korunuyor.
- **Kart çift render (patlayan buğu) giderildi**: `fadeUp` animasyonundaki `transform: translateY(10px)` kaldırıldı, artık yalnızca opacity (filterFadeIn ile aynı desen). Animasyon sırasında `.card-wrapper` composited layer olup içindeki `.vault-card-shell`'in `backdrop-filter` örneklemesi boşalıyor ve kartın cam buğusu ilk karede kaybolup bitince geri geliyordu (iki kez boyama). Opacity-only reveal bu artefaktı tamamen önlüyor; kayma hareketi yalnızca 10px'lik subtle bir girişti.

### ⚡ Performans / CPU

- **LAN tarayıcı sıklığı azaltıldı**: LAN etkinken 5 s, boştayken 20 s (durum değişince yeniden planlanıyor).
- **Kromatik vurgu döngüsü**: 60 fps `requestAnimationFrame` yerine 200 ms `setTimeout`; pencere gizliyken tamamen duruyor.
- **Keep-alive bağlantı havuzu**: ana süreç backend istekleri en fazla 4 soketlik kalıcı `https.Agent` kullanıyor; sertifika sıfırlandığında havuz yenileniyor.
- **WSGI sunucusu**: Werkzeug yerine TLS destekli **Cheroot** (`requirements.txt`); kurulu değilse Werkzeug fallback korunuyor.
- **Boştayken CPU ~%20 → ~%1** (ölçüldü, sistemden sisteme değişebilir): Yük sebeplerinden biri, 3 arkaplan blob katmanının sonsuz `drift` animasyonuydu — smooth timing ile GPU süreci bir tam çekirdeğin ~%66-92'sini tüketiyordu. `steps(12, jump-none)` kademeli timing'ine geçildi: GPU süreci ~%4-5'e düştü (~%95 tasarruf), ana süreç zaten ~%0'dı. Görsel olarak 20 s döngüde adımlar ~1.7 s'de bir olduğu için ambient fark algılanmıyor; animasyon hâlâ çalışıyor (kill değil). Ölçümler: smooth 3 blob %82.7 / +no-blur %74.2 / 1 blob %56.6 / steps(12) %4.5 / steps(60) %12 / animasyon kapalı %0.1.

### 🛡️ Güvenlik / Bakım

- **SW arkaplan cache birikme sorunu düzeltildi**: Önceki sürümlerde SW, `/api/background/current` ve `/api/background/history/*` yanıtlarını `cache-first` ile kendi cache'ine alıyordu; silinen/replaced edilen arkaplan görselleri aynı cache bucket'ında birikiyor, depolama alanı tüketiyor ve stale görseller sunabiliyordu. Düzeltme: arkaplan görselleri SW cache'den çıkarıldı (sunucu `Cache-Control` header'ı ile tarayıcı HTTP cache'ini yönetiyor); `activate` handler'a mevcut cache'teki stale arkaplan entry'lerini temizleme eklendi; `sw.js` assets-v109→v110, `base.html` v96→v110 sürümleri senkronize edildi.

- **CİDDİ — LAN erişim şifresi sistemi**: LAN üzerinden erişim için şifre doğrulama eklendi; 7 yeni testle doğrulandı.
- **CİDDİ — Sertifika pin karşılaştırma düzeltmesi (30 diyalog)**: Electron `_certificate.data` (PEM) ile `pinnedCertificateDer` (DER) arasındaki format farkı `equals()`'ı her zaman `false` yaptırıyordu. `_normalizeCertToDer()` helper'ı eklendi; `_isExpectedLocalCertificate()` fallback olarak pin eşleşmediğinde çalışıyor; ilk açılışta otomatik pin kaydetme eklendi.
- **ORTA — Token enjeksiyonu / CSRF / pin / lockout düzeltmeleri**: Güvenlik açığı taramasında bulunan orta seviye açıklar giderildi.
- **Önemsiz — Güvenlik iyileştirmeleri**: `__Host-session` cookie prefix, `net.exe` yolu kısıtlaması, `_vault_keys` TTL süresi, `sandbox:true` iframe sandboxing, `max_length` input sınırlamaları eklendi.
- `security_lint.py`: `.style` kuralı `\.style\.cssText\b` ile daraltıldı (`.style.foo` atamaları yanlış pozitif vermiyor).
- Uninstall kayıt defteri temizliğine **2.7.0-beta.1** anahtarları eklendi.

### 🧪 Testler

- `tests/test_kasa.py` kayıt formu / e-posta alanı ve özel arka plan senaryolarıyla genişletildi (110 test + 36 alt senaryo geçiyor).

### ⚙️ Diğer

- Sürüm **2.7.0-beta.2**'ye yükseltildi (`package.json` / `package-lock.json`).
- `base.css?v=70`, `sw.js` v83 sürümleri güncellendi.
- Tüm JS modülleri başlık yorumlarında **2.7.0-beta.2**'ye güncellendi.
- Cache sürümleri güncellendi: `base.css?v=71`, `background.css?v=77`, `glass.css?v=77`, `settings-modal.css?v=71`, `buttons.css?v=70`, `misc.css?v=69`, `theme-states.css?v=70`, `sw.js` assets-v89.
- Animasyon kill-switch düzeltmesiyle: `base.css?v=72`, `sw.js` assets-v94.
- CPU / çift-render düzeltmeleriyle: `base.css?v=73`, `sw.js` assets-v95.
- Kart alanları (kart üzerindeki isim + ay/yıl) ile: `sw.js` assets-v96.
- Glass CSS + form animasyonu + özel arkaplan düzeltmeleriyle: `glass.css?v=78`, `utilities.css?v=70`, `background.css?v=78`, `sw.js` assets-v97.
- Vault form fix + glass-ready çift render çözümüyle: `glass.css?v=81`, `liquid-glass.js?v=6`, `sw.js` assets-v97.
- Glass arama/filtre flash düzeltmesiyle: `liquid-glass.js?v=7`, `sw.js` assets-v98.
- Vault glass v2 + curtain + accent toggle düzeltmeleriyle: `cards.css`, `glass.css` (vault kurulları temizlendi), `sw.js` assets-v106.
- "Kayıtlı" çevirisi eklendi (`en.json`, `tr.json`).
- Rastgele Renk seçici eklendi (`appearance-settings.js`, `custom-select.css`, `index.html`, `en.json`); `sw.js` assets-v110.
- Cam yüzey netliği tutarlılığı: `background.css?v=83`, `sw.js` assets-v111.
- LAN düzeltmeleri + toast düzeltmesi: `settings-modal.css`, `lan-settings.js`, `appearance-settings.js`, `sw.js` assets-v111.
- Heartbeat düzeltmesi: tarayıcı heartbeat'i X-App-Token göndermediği için 403 dönüyordu, `_last_heartbeat` hiç güncellenmiyordu; 120s sonra sunucu kapanıp session düşüyordu. Artık local+authenticated istekler de heartbeat'i günceller (`app.py`).
- LAN UI düzeltmeleri v2: `settings-modal.css`'te `#lan-info-box` ve `.lan-warning-cards-wrap` için `display: none !important` / `display: grid/flex !important` ile `!important` tabanlı görünürlük yönetimi eklendi; Tailwind `.hidden` class çakışması kökten çözüldü. `_showEl` artık `hidden` class'ını da kaldırıyor (`lan-settings.js`). Cache busting: `settings-modal.css?v=72`, `sw.js` assets-v112.
- LAN uyarıları yeniden yapılandırıldı: `.lan-warning-cards-wrap` her zaman görünür (toggle'dan bağımsız) ve tam genişlik; "yeniden başlatma" uyarısı toggle switch altına `#lan-restart-note` olarak taşındı. `lan-settings.js`'den `_showEl(lanWarningCards)` kaldırıldı. Cache: `settings-modal.css?v=73`, `sw.js` assets-v113.
- Otomatik yeniden başlatma: LAN ayarı değiştiğinde `save_settings` yanıtı `restart_required: true` döndürüyor; JS `/restart` çağırıyor, sunucu `os.execv` ile kendini yeniden başlatıyor (`app.py` `_deferred_restart`).