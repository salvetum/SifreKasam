# NOTLAR

## Backend Analizi (kasa_core + app.py) — 16 Ağu 2026

Analiz salt-inceleme olarak yapıldı, hiçbir kod değişikliği uygulanmadı. Bulgular risk seviyesine göre üçe ayrıldı.

### 🟢 Bozmaz (güvenle yapılabilir)

1. **`app.py:98` — ölü import:** `_ensure_private_data_dir` içe aktarılmış ama hiç kullanılmıyor. Silinebilir.
2. **`app.py:64` — ölü import:** `RECORD_METADATA_PREFIX` app.py'de kullanılmıyor (yalnızca `kasa_core/crypto.py` içinde gerekiyor).
3. **`scripts/fix_cert.py` — ölü/tekrar script:** Tek seferlik, hardcoded path'li script. Aynı mantık artık `app.py` `_normalize_pem_files()` içinde başlangıçta otomatik çalışıyor. Silinebilir/arşivlenebilir.
4. **`validation.py:57` — tekrar eden fonksiyon:** `normalize_glass_effects` ile `normalize_theme_option(value, default=True)` aynı davranış; birleştirilebilir.
5. **`appearance.py` — boilerplate tekrarı:** ~10 `get_*`/`save_*` ikilisi aynı şablonu 20 kez kopyalıyor; data-driven tablo ile kısaltılabilir.
6. **`password_strength.py:95` ve `:128` — tekrar:** `character_class_count` hesabı iki yerde; helper'a çıkarılabilir.
7. **`app.py:1653` ve `:1716` — tekrar:** `Image.MAX_IMAGE_PIXELS` + PIL import'u `_validate_custom_background` ve `_optimize_custom_background`'da kopyalanmış.
8. **`app.py` — benzer silme döngüleri:** `_remove_old_custom_backgrounds` (1739) ve `_clear_custom_background_history` (1949); ortak helper çıkarılabilir.
9. **`app.py:1334` — gereksiz indirection:** `_parse_import_record` sadece `_parse_import_record_data(item, fernet, _('Bilinmeyen'))` çağırıyor; doğrudan çağrı yeterli.

### 🟡 Orta (dikkatli yapılmalı)

1. **`app.py:1476` vs `app.py:2336` — kopya kod:** `lan_info` route'u `_detect_lan_ips()` mantığını satır satır kopyalıyor; route'un helper'ı çağırması gerek.
2. **`app.py:1246 save_settings` vs `app.py:1534 settings_appearance` — örtüşme:** İki endpoint aynı ~14 toggle'ı kaydediyor; birleştirme JSON sözleşmelerini bozabilir, testlerle yapılmalı.
3. **`app.py:248-257` — iki ayrı `ALTER TABLE` bloğu:** `expiry_date` ve `email` için aynı try/except deseni. Döngüye almak cazip ama init-time DB migrasyonu; idempotent davranış korunmalı.
4. **`app.py:416 migrate_legacy_pbkdf2_salt` vs `app.py:2182 _reencrypt_task` — kısmi örtüşme:** İkisi de re-encryption döngüsü içeriyor; ortak helper riskli.

### 🔴 Kritik (değişiklik işlevi bozabilir)

1. **Re-encryption mantığına dokunmak:** `migrate_legacy_pbkdf2_salt` / `_reencrypt_task` anahtar dönüşümü yapan en hassas yollar; tek satırlık hata = kasada geri döndürülemez veri kaybı. Birebir kopyaları korumak doğru tercih. Ayrıca ikisinde de başarısızlıkta geri alma yolu yok (rollback yalnızca session). Dokunmadan önce dry-run decrypt simülasyon testi şart.
2. **`index` detaylar üretimi (1050-1083) vs `import_export.serialize_records` (39-57):** İkisi de aynı alanları decrypt edip dict üretiyor; ortak serialize fonksiyonu önerilmez, UI kart görünümü + yedek formatı tek noktada riske girer.
3. **`check_token_and_auth` / CSRF akışı (787-841):** Ölü kod yok ama `_PUBLIC_ENDPOINTS`/`_TOKEN_ENDPOINTS` setlerine endpoint eklenirken eksik kalırsa güvenlik kontrolü sessizce atlanır.

### Doğrulanan "sorun değil" durumlar

- `CUSTOM_BACKGROUND_MAX_DIM` (2560, optimize küçültme) vs `CUSTOM_BACKGROUND_MAX_DIMENSION` (8192, kabul sınırı): ikisi de kullanılıyor, çakışma değil.
- `security_lint.py` JS dosya listesi `static/*.js` ile eksiksiz eşleşiyor; `liquid-glass.js` ve vendor dosyaları (toastify/sweetalert) kasıtlı olarak listede yok.

## main.js Modülerleştirme Analizi — 16 Ağu 2026

Kök dizindeki `main.js` (1637 satır, ~62 KB) Electron ana süreci; `package.json` "main" girişi. Analiz salt-inceleme, uygulanmadı.

### Sonuç: Modülerleştirilebilir (orta riskli refactor)

- **Bundler gerekmez**: proje Electron main process'i CommonJS kullanıyor; `src/main/*.js` dosyaları `require` ile bölünebilir.
- **Paket uyumu**: `forge.config.js` `ignore` filtresi yalnızca `preview/`, `tests/`, `*.md` ve `flask_app` db/cert/build dosyalarını eliyor; tüm `.js` dosyaları paketleniyor (`asar: true`). Yeni `src/main/*.js` dosyaları da paketli sürümde çalışır.
- Önerilen yapı: `src/main/{diagnostics,state,paths,squirrel,certificates,backend,http,window,tray,lan,theme,app-events}.js`; kökteki `main.js` ince bir giriş noktası olarak kalır.

### 4 risk (orta seviye iş)

1. **`__dirname` değişimi**: `preload.js` yolu ve geliştirme ortamında backend yolu (`flask_app/app.py`) köke göreli. `main.js` kökte kalmalı; başka dizine taşınırsa pathler bozulur.
2. **Paylaşılan mutable state**: `mainWindow`, `flaskProcess`, `PORT` gibi değerler birçok closure'da kullanılıyor; `state.js` içinde tek noktaya toplanmalı.
3. **Sıralama kısıtları**: Squirrel handler en üstte çalışmalı, `requestSingleInstanceLock` boot akışını sarıyor, sertifika handler'ları `whenReady` öncesi kurulmalı → modül yükleme/çağrı sırası bozulursa davranış değişir.
4. **Test yok**: ana süreç için otomatik test altyapısı yok; doğrulama manuel (`npm start` + geliştirme testi).

### Not
- Uygulama kararı kullanıcıya bırakıldı; onay verilirse `package.json` "main" ve yukarıdaki risklerle birlikte ele alınacak.
