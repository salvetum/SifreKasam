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

## Çift Render (Glass Flash) Kök Analizi — 19 Ağu 2026

Vault kartlarında cam buğu (backdrop-filter) "çift render" sorunu analiz edildi. Vault kartları, glass sistemindeki **tek** iki katmanlı (wrapper + shell) elemandır.

### Kök Nedenler

**A) Wrapper/Shell Opacity Desenkronizasyonu:**
- Wrapper (`.card-wrapper`) `card-animated` CSS animasyonuyla T=0'da fadeUp'a başlar (240ms).
- Shell (`.vault-card-shell.glass`) `html:not(.glass-ready) { opacity: 0 !important }` ile T=30-60ms'e kadar görünmez.
- Sonuç: wrapper dolmuşken shell hâlâ geçişte → son %16'da "pop" (T=240→310ms).

**B) Gölge-Önce-Glass Safhası:**
- İlk 30-60ms'de wrapper box-shadow'u görünür ama shell görünmez → "yüzen gölge" artefaktı.

### Diğer Glass Elemanlarından Farkı

| Özellik | Vault Kartları | Diğer Glass Elemanlar |
|---------|---------------|----------------------|
| Wrapper + Shell iki katman | Evet | Hayır (tek element) |
| `card-animated` CSS animasyonu | Evet | Hayır |
| `html:not(.glass-ready)` opacity gate | Evet | Hayır |
| JS tier blur (CSS'ten farklı) | Evet | CSS blur yeterli |

### Çözüm Yönleri Karşılaştırması

| | Görünüm | Performans | Uygulama | Risk |
|--|---------|-----------|----------|------|
| 1. Wrapper gecikme (glass-ready'den sonra fadeUp) | ★★★★★ | ★★★★★ | Kolay (3 satır JS) | Sıfır |
| 2. Shell kaldır (glass'ı wrapper'a taşı) | ★★★★ | ★★☆ | Orta | Yüksek (compositing artifact) |
| 3. Gate kaldır (CSS blur = JS blur) | ★★★ | ★★★★ | Zor (tier eşleşme) | Orta |
| 4. Wrapper+shell senkronize başlat | ★★★★ | ★★★ | Orta | Düşük |

**Seçim: Seçenek 1** — Wrapper `card-animated` animasyonu `glass-ready` event'inden sonra başlatılacak. En iyi görünüm + en iyi performans + sıfır risk.

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

## Güvenlik Denetimi — 17 Ağu 2026

Kapsamlı tarama (backend + Electron + şablonlar + statik JS, `security_lint` GEÇTİ, `sifreler.db`/`build/` git dışı doğrulandı). Default (LAN kapalı) yapılandırmada uzaktan istismar edilebilir kritik açık bulunamadı. Bulgular üç seviyede:

### 🔴 Ciddi
1. **LAN modunda ana şifre self-signed TLS üzerinden ağda taşınıyor (TOFU/MITM).** Sertifika parmak izi pin'i yok; ilk bağlantıyı kesen aynı LAN'daki saldırgan kendi sertifikasını sunup master şifreyi yakalayabilir → tüm kasa offline ele geçirilebilir. **Durum: ÇÖZÜLDÜ** (17 Ağu 2026): ayrı rastgele "LAN erişim şifresi"; master şifre ağa gönderilmiyor; kasa anahtarı `lan_vault_wrap` ile sarmalı; LAN kapatılınca temizlenir, açılınca döner; ana şifre değişince sarmal yenilenir; LAN'dan ilk kurulum engelli. Testler: `LanAccessPasswordTests` (7 test) + 110 test + security_lint geçti.
2. **`certificate-error` auto-accept + heuristic → yerel süreç kimliğe bürünebilir.** Electron, CN=ŞifreKasam + self-signed + SAN localhost görünümlü her sertifikayı port kontrolü olmadan otomatik kabul ediyor. **Durum: ÇÖZÜLDÜ** (17 Ağu 2026): pin eşleşmesi DER-normalizasyonu ile düzeltildi (PEM/DER karşılaştırma hatası giderildi); heuristic yalnızca pin eşleşmediğinde fallback olarak kullanılıyor (sertifika yeniden üretilmişse otomatik kabul + pin güncelleme); bilinmeyen sertifikalarda diyalog gösteriliyor.

### 🟡 Orta
3. **X-App-Token'e tam güven (CSRF bay-pass) + tüm renderer isteklerine otomatik enjeksiyon.** Herhangi bir XSS tüm backend'i bay-pass eder. Vendored JS (swal2/toastify) CSP `'self'` kapsamında → tek başarı noktası. **Durum: ÇÖZÜLDÜ** (17 Ağu 2026): token enjeksiyonu yalnızca stateless API uçlarına (`_TOKEN_INJECT_PATHS`) daraltıldı; state-changing istekler `X-CSRF-Token` ile korunuyor; middleware tüm kimlik doğrulanmış isteklerde CSRF kontrolü yapıyor; local oturum açmış istemciler token olmadan erişebilir (CSRF yukarıda uygulandı).
4. **`getPinnedHttpsOptions` → pin yokken `rejectUnauthorized:false`.** **Durum: ÇÖZÜLDÜ** (17 Ağu 2026): pin yokken `checkServerIdentity` ile yalnızca localhost hostname'e izin veriliyor.
5. **LAN oturumlarında CSRF bypass (`_TOKEN_ENDPOINTS`).** `/settings/tray`, `/settings/content-protection`, `/settings/hardware-acceleration` token'sız geçer. **Durum: ÇÖZÜLDÜ** (17 Ağu 2026): state-changing uçlar `_TOKEN_ENDPOINTS`'ten çıkarıldı; `_TOKEN_INJECT_PATHS` güncellendi; `apiFetch` zaten `X-CSRF-Token` gönderiyor.
6. **Login kilit: per-IP + in-memory** (IP rotasyonu/NAT DoS; restart'ta sıfırlanır). **Durum: ÇÖZÜLDÜ** (17 Ağu 2026): lockout durumu `login_lockout.json`'a perziste ediliyor; restart'ta korunuyor. Per-IP sınırlaması masaüstü uygulama için yeterli (CİDDİ-1 LAN şifresi ayrı; NAT/rotasyon yalnızca LAN erişiminde anlamlı).

### 🟢 Önemsiz
7. Session cookie `__Host-` prefix yok; HSTS yok. **Durum: ÇÖZÜLDÜ** (17 Ağu 2026): `SESSION_COOKIE_NAME='__Host-session'` eklendi. HSTS gerekli değil (masaüstü uygulama, self-signed localhost). 8. `execSync('net session')` PATH üzerinden çözülüyor. **Durum: ÇÖZÜLDÜ** (17 Ağu 2026): tam yol `System32\net.exe` kullanılıyor. 9. Windows'ta `chmod 0o700` no-op (ACL önerisi). **Durum: kabul** (veri dizini APPDATA altında, OS düzeyinde korumalı; ACL eklemek karmaşıklık getirir). 10. `_vault_keys` session expire'da temizlenmiyor. **Durum: ÇÖZÜLDÜ** (17 Ağu 2026): TTL tabanlı (60dk) periyodik daemon thread + `_get_vault_key`'de lazy temizlik. 11. Explicit `sandbox:true` yok (default true). **Durum: ÇÖZÜLDÜ** (17 Ağu 2026): `sandbox: true` eklendi. 12. `_record_from_form` şifre alanı max_length'sız; `_login_attempts` LAN'da büyüyebilir. **Durum: ÇÖZÜLDÜ** (17 Ağu 2026): password/comment `max_length=10000` eklendi; `_save_login_lockout` süresi dolmuş girişleri temizliyor.

### Güçlü yönler (doğrulandı)
CSP nonce'lı + `unsafe-inline` yok + `frame-ancestors 'none'`; session HTTPOnly+Secure+SameSite=Strict+60dk+per-run secret; Fernet + 600k PBKDF2; upload magic-byte+uuid+rate limit+SVG yasak; import 5000+64MB; SQL parametrize; şablon autoescape+tojson; DOM createElement/textContent; normalize_url http/https whitelist; nodeIntegration:false + contextIsolation:true; `/shutdown`/`/heartbeat` token+local zorunlu; `save_settings` CSRF token'lı (muaf değil).
