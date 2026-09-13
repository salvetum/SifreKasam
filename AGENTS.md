# AGENTS.md — ŞifreKasam (KasaUygV2)

Başka agent'ların projeyi hızlıca anlayıp doğru yerlerde değişiklik yapabilmesi
için. Bu dosya opencode gibi araçlar tarafından otomatik okunur.

Mcp Listesi: semgrep, github, sequential-thinking
Agent listesi: @frontend, @backend, @security-viewer
Frontend - Dizayn için: @frontend
Backend - Arka kod: @backend
Security reviewer - Güvenlik kontrolü(sürüm sonlara doğru yaklaştığında kullan): @security-viewer 

## Ne bu proje?

Masaüstü şifre yöneticisi (Electron + Flask). Ad: ŞifreKasam (sifrekasam),
sürüm 2.7.0-beta.3. Electron pencereyi açıyor; içerik bir yerel Flask uygulaması
tarafından servis ediliyor. Kayıtlar (Web/Uygulama/Kart/Not) Fernet (AES) ile
kasanın master şifresine bağlı bir anahtarla şifrelenir.

**Kullanıcı ana dili Türkçe.** Yeni metin/çeviri anahtarı eklerken Türkçe karşılığı
şart; UI metinleri Türkçe.

## Mimari (üstten alta)

- `main.js` — Electron ana süreci: Flask'ı çalıştırır, pencereyi açar.
- `preload.js` — Renderer ile Node arası köprü (contextBridge).
- `flask_app/` — Flask backend (Python). `app.py` tüm route'ları barındırır.
- `flask_app/templates/` — Jinja şablonlar. `base.html` ana iskelet; `partials/` içinde
  kartlar, dashboard-bar, modal, ayarlar, form parçaları; `partials/settings/`,
  `partials/modals/`, `partials/form/` alt klasörleri.
- `flask_app/static/` — vanilya JS + CSS. Modül JS'leri: `app.js`, `vault-index.js`,
  `vault-form.js`, `notifications.js`, `liquid-glass.js`, `reveal-copy.js`.
- `brand_icons.py` — `getBrandIcon()` marka/tip ikon üretici (satır içi SVG, sıfır ağ isteği).
- `backend/`, `src/` — legacy/kaynak klasörler; ana iş `flask_app/`'dedir.
- `tests/test_kasa.py` — pytest test paketi. 205+ test içerir.
- `scripts/security_lint.py` — güvenlik lint aracı.

## Komutlar (kritik)

- Tüm testleri çalıştır: `python -m pytest tests/test_kasa.py -q`
  (şu an 205 passed + 64 subtests hedefi; her değişiklik sonrası çalıştır.)
- Uygulamayı başlat (geliştirme): `npm start` → Electron açılır, Flask'ı başlatır.
  Uyarı: Hot-reload YOK. CSS/JS/HTML değişikliğinden sonra `npm start` ile yeniden başlat.
- Paketleme: `npm run package` / `npm run make` (make öncesi `build:backend` çalışır).
- Güvenlik lint: `python scripts/security_lint.py` (CSP, CSRF, TLS, brute-force kontrolleri).

## Kritik test bağımlılıkları (BOZMA!)

`tests/test_kasa.py` şu değerleri birebir doğrular (`test_asset_versions_bumped`):
- `cards.css ?v=73`, `theme-states.css ?v=74`, `utilities.css ?v=71`, `app.js ?v=9.29`
- `sw.js` / `scripts/sw-register.html` içinde `assets-v170`
- Ayrıca şablon Jinja/div dengesi, çeviri JSON geçerliliği denetlenir.

**Eğer bu asset'lerden birinin `?v=` değerini artırırsan, testteki aynı satırı da
güncelle** (ikisi eşzamanlı olmalı, yoksa test fail eder). `misc.css` ve `glass.css`
test tarafından assert edilmez ama değiştirirsen `base.html`'deki `?v=` yine artır.

## CSS yükleme sırası (cascade'de son yüklenen üstündür)

`base.html` head'inde:
`tailwind-lite → all.min.css (FontAwesome, YEREL) → tokens → base → vault-form → utilities
→ buttons → cards → modals → theme-states → responsive → background → custom-select
→ settings-modal → date-picker → theme-overrides → misc → glass`

Yani `glass.css` en sonda yüklenir → cascade'de üstündür; misc.css'te aynı isimde kural
varsa glass.css ezer. Cam ayarı yaparken bunu gözet.

## Cam (glass) sistemi

- `.glass` sınıfı cam dilini; `liquid-glass.js` bu elemanlara `backdrop-filter` (frost)
  uygular. `glass.css` genel stilleri verir, `tokens.css` --glass-* değerleri.
- Renk token'ları: `--accent`, `--accent-rgb`, `--accent-2`, `--text`, `--text-muted`,
  `--motion-fast`, `--speed`.
- Efekt kapalı modları: `html[data-glass-effects="off"]`, `data-glass-quality="low"`,
  `data-kasa-low-power="on"` — camı kapatır; bu varyantları da eklemeyi unutma.
- Navbar/Portal uyarısı: Navbar'a gerçek `backdrop-filter` verilince Chromium onu
  "backdrop root" yapar ve içindeki dropdown'ın kendi buğusunu iptal eder. Bu yüzden
  bildirim dropdown menüsü navbar DOM'unun DIŞINDA, `#kasa-portal-root` içinde taşınır
  (portal). `app.js`'deki `findMenu`/`positionDropdownMenu` menüyü `position:fixed` +
  trigger `getBoundingClientRect()` ile konumlandırır; scroll/resize'da `_repositionOnScroll`
  yeniden konumlar. Yeni portal dropdown eklerken bu mekanizmayı izle.

## Bildirim sistemi

- Bildirim menüsü `base.html`'de `#notifications-dropdown-menu` (portal-root içinde),
  `notifications.js` içeriği üretir.
- Kalıcılık backend'de: `Setting` tablosunda `notification_dismissed_ids` (JSON,
  max 100 ID). Endpoint'ler: `GET /api/notifications`, `POST /api/notifications/dismiss`,
  `POST /api/notifications/dismiss-all`, `DELETE /api/notifications`. Hepsi `@login_required`.
  Frontend localStorage'ı sadece fallback olarak kullanır.

## Marka ikonları (brand_icons.py)

- `getBrandIcon(title, domain, record_type)` → marka ikonu (satır içi SVG) döner.
  Marka eşleşmezse kayıt tipine göre ikon (Website→dünya, Application→masaüstü,
  CreditCard→kart, SecureNote→not); tip de bilinmiyorsa kilit ikonu (default).
- İkon kapsayıcısı kart başlığında `.vault-type-icon` (30x30 kutu, `overflow:hidden`,
  ikon `max-width/max-height:72%` ile kutuya sığar). `cards.css`'te `--brand-c` ile
  marka renkleri.

## FontAwesome — YEREL, eksik ikonlara dikkat!

FA yerel `all.min.css`'ten yüklenir (CDN değil). Bu dosyada olmayan bir ikon render
edilmez (boş görünür). Yeni bir `fa-solid fa-*` kullanmadan önce `all.min.css` içinde
varlığını kontrol et. Örnek: `fa-shield-exclamation` YOK, onun yerine
`fa-shield-halved` kullanılır. Kodda yeni ikon eklerken bu kontrolü atlama — yoksa
"simge görünmüyor" bug'ı oluşur.

## Düzen / kurallar

- Yeni görsel/UI metni eklerken `flask_app/translations/tr.json` VE `en.json`'a ekle
  (ikisi birden, alfabetik sıra). JSON geçerliliğini koru.
- Jinja blokları (`{% block %}`/`{% endblock %}`) ve `<div>` dengelerini bozma;
  değişiklik sonrası testteki denge denetimini çalıştır.
- Güvenlik: gizli/anahtar loglama yapma; `|safe` kullanımında dikkatli ol; CSP/CSRF
  header'larını koru. Değişiklik sonrası güvenlik lint'i çalıştır.
- commit/push YAPMA (kullanıcı istemedikçe).
- `base.html`'de static asset `?v=` cache-busting değerini değiştirdiysen, ilgili
  test satırını da güncelle (bkz. "Kritik test bağımlılıkları").

## Görsel değişikliklerde altın kural

Sub-agent'lar headless olduğu için görsel doğrulama yapamaz — render durumunu
göremezler. "Ekran görüntüsü koy, rengi düzelt, ikon şunu göstersin" gibi kesin görsel
hedef verildiğinde, kod tabanını (kök nedenleri) elle/somut inceleyerek teşhis et;
körü körüne sub-agent iterasyonu başarısız olabilir. Mevcut CSS/HTML'deki gerçek
durumu (ör. eksik FA ikonu, overflow, viewbox) doğrulayıp düzelt, sonra testleri çalıştır.