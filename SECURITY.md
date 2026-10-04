# ŞifreKasam — Güvenlik Durumu ve Yol Haritası

Son güncelleme: 2.7.0-beta.4 · Durum: **uzak saldırı yüzeyi kapandı**, kalanlar aşağıda gerekçesiyle listeli. 2026-10 turunda **port yarışı (TOCTOU)** (§1), **Electron fuse'ları** (§1) ve **LAN sır sızıntısı — ızgara + `/duzenle` formu + `/saglik` sağlık raporu** (§1) kapatıldı; **açık kalan güvenlik kalemi yok** — kod imzalama kullanıcı kararıyla bilerek yapılmıyor (§3.3), `/settings/language` yerel muafiyeti bilinçli kabul (§2.6).

Bu dosya iki işe yarar:

1. **Kapatılanları kayıt altına alır** — sonraki oturumlarda aynı bulgular yeniden araştırılmasın.
2. **Açık bırakılanları gerekçesiyle belgeler** — "neden yapılmadı?" sorusunun cevabı buradadır.

Kural: bir kalem buraya girdiyse, kapatıldığında **tarihiyle işaretlenip "Yapıldı" bölümüne taşınır**, silinmez.

---

## 0. Önce tehdit modeli (en önemli bölüm)

ŞifreKasam bir **masaüstü** uygulaması. Bu, güvenlik mimarisinin tamamını belirliyor:

| Saldırgan | Elimizde ne var? |
|---|---|
| Ağdaki cihaz (LAN istemcisi) | ✅ Kapatıldı — aşağıdaki tüm maddeler bunun için |
| Kullanıcının tarayıcısı / XSS | ✅ Kapatıldı (CSP nonce, `script-src-attr 'none'`, fail-closed Origin) |
| Kurulum sırasında yanlışlık | ✅ Kapatıldı (disk/izin ön kontrolü, geri alma) |
| **Aynı kullanıcı bağlamında çalışan kötücül kod** | ❌ **Çözülemez** |

Son satır önemli: aynı kullanıcı adına çalışan bir süreç bellekteki ana şifreyi okur, ana sürece hook atar, `sifreler.db`'yi kopyalar, `app.asar`'ı değiştirebilir. **Uygulama içi hiçbir önlem bunu durduramaz** — bu, masaüstü şifre yöneticilerinin doğasıdır ve hiçbir ürün bunu çözemez.

Bu yüzden kapatılan şeyler "saldırıyı durdur" değil, **"ucuz atlatılabilir yüzeyleri kapat"** idi. Buna göre okunmalı.

### Aktif saldırganın elde edemeyeceği tek şey: düz metin şifreler

Ferdernet/şifreleme katmanı sağlam. Aynı kullanıcı bağlamındaki saldırgan `sifreler.db`'yi kopyalayabilir ama içerik şifreli; anahtarı okumak için süreç belleğine erişmesi gerekir. Saldırganın kazandığı bu kadar.

---

## 1. ✅ Kapatılanlar (2026-09 turu)

Bu turda iki ajanla (Semgrep + probelarla ölçüm, ve bağımsız ikinci inceleme) taranmış, önem derecesine göre giderilmiş ve **her biri için doğrulama testi yazılmıştır**.

### Kimlik doğrulama / oturum

- **Ana şifre değişimi diğer oturumları düşürüyor.** Önce `_reencrypt_task` yalnız tetikleyen oturumun `vault_sid`'sini yeni anahtara bağlıyordu; diğer oturumlar **ölü anahtarla yazmaya devam ediyor** ve yazdıkları kayıt kalıcı olarak çözülemiyordu. Artık `_vault_keys` tamamen temizlenip tetikleyen yeniden ekleniyor. `vault_epoch` şeması bilinçli **yapılmadı** — program zaten tek kullanıcılık tasarımı ve aktif oturumları düşürmek yeterli.
- **Legacy PBKDF2 salt zorunlu geçiş.** `migrate_legacy_pbkdf2_salt()` her başarılı girişte koşulsuz çalışıyor; hata halinde giriş 500 ile durduruluyor. Testler eklendi (başarılı geçiş + geçiş hatasında engel).
- **Otomatik kilit artık sunucu tarafında da uygulanıyor.** Renderer çökerse/pencere kapanırsa anahtar 60 dk bellekte kalıyordu. Artık `before_request` seviyesinde `session['kasa_last_activity']` takip ediliyor. **Kritik ayrıntı:** heartbeat ve token istekleri sayaca *sayılmıyor* — `/heartbeat` 15 saniyede bir geliyor, sayılsa kilit hiç tetiklenmezdi.
- **CSRF belirteci kilit/çıkışta dönüyor** (`rotate=True`). Oturum çerezi imzalı olduğu için session fixation riski zaten yoktu; bu, "token hiç dönmüyor" standardını kapatıyor.
- **CSRF belirteci session temizliğinde silinmiyordu** — hatalı giriş/lock/logout sonrası ikinci istek kalıcı olarak 400 alıyordu (kullanıcıya "şifre çalışmıyor" gibi görünüyordu). `_reset_session_preserving_csrf()` eklendi, 6 noktaya uygulandı.

### LAN yüzeyi (asıl kazanım)

- **LAN varsayılanı salt okunur.** Kayıt ekleme/silme/düzenleme uzak istemciden reddedilir (403). "LAN oturumlarına tam yetki" anahtarı opt-in.
- **Dışa/içe aktarma ve yedekleme LAN'dan tamamen kapalı** — **tam yetki açık olsa bile**. Gerekçe: tam yetki "kayıt düzenleme" anlamına gelir; kasayı dosyaya dökmek başka bir yetenek. Uyarı kartları artık gerçeği anlatıyor.
- **LAN'da şifre gösterimi varsayılan KAPALI** (ayrı anahtar). Ağdaki cihaz başlıkları görür, şifreleri göremez.
- **Makine tercihleri (`settings_tray`, `settings_language`) salt okunur muafiyetinden çıkarıldı** — uzak istemci makinenin davranışını değiştiremiyor.
- **Kritik ayarlar (`lan_enabled`, `internet_kill_switch`, `live_breach_scan`, `auto_lock_enabled`, `auto_lock_timeout`, `lan_full_access_enabled`, `lan_reveal_passwords_enabled`, `content_protection_enabled`, `auto_backup_interval`, `hardware_acceleration_enabled`) yalnız bu bilgisayardan değiştirilebilir** (uzak → 403). Artık **form dışındaki JSON uçları da kapsamda**: `/settings/content-protection` ve `/settings/hardware-acceleration` gövdeyi JSON gönderdiği için `request.form` denetimi onları hiç görmüyordu.
- **Kısmi form sıfırlaması düzeltildi.** Önce her boolean `bool(request.form.get(...))` ile yazılıyordu → alan yoksa ayar `false` oluyordu, yani kısmi form tüm bayrakları sıfırlıyordu. Artık yalnız formda **mevcutsa** uygulanıyor; yerel tam form davranışı birebir korunuyor.

### LAN sır sızıntısı (ızgara + düzenleme formu + sağlık raporu) — ✅ KAPATILDI (2026-10 turu)

**Bulgu (bağımsız inceleme + kendi ölçümümüzle doğrulandı):** "LAN'da şifre gösterimi kapalıyken ağdaki cihaz sırları göremez" sözü **üç** yoldan deliniyordu. `SECURITY.md:51`'deki kontrol yalnız iki API ucunu (`get_record_password`, `get_gecmis`) kapsıyordu, `duzenle_sayfasi` listede değildi; ayrıca `_enforce_lan_read_only` yalnız `POST/PUT/PATCH/DELETE`'ye bakıp **`GET`'i muaf** bırakıyordu.

**2. tur (nihai tarama)** — ilk düzeltme iki kaçış bırakmıştı, ikisi de bağımsız inceleme tarafından bulundu ve kendi ölçümümle doğrulandı:

| Yol | Sızan alan | Neden | Düzeltme |
|---|---|---|---|
| `GET /` (ana ızgara) | tam **kart numarası**, **kart üstü isim**, **not metni**, **SecureNote içeriği** | `index()` bunları çözüp `detaylar`'a koyuyordu; `card-grid.html` `Kart Numarası`'nı **düz metin + kopyalama düğmesiyle** basıyordu. `Şifre`/`CVV` maskeliydi, bu satırlar değil. | `hide_secrets` ile alan **hiç oluşturulmuyor** (maske değil). Başlık/kullanıcı adı/e-posta/adres görünmeye devam ediyor. |
| `GET /duzenle/<id>` | **şifre**, kart no, kart ismi, not | View `Password`/`Card holder`/`Comment`'i şablona veriyor, `panel-access.html` `value="…"` basıyordu. | Uzak + gösterim kapalıyken **403** (`_LAN_REVEAL_FORM_GET_ENDPOINTS`). Yalnız **GET**; `POST` (tam yetki düzenlemesi) korunuyor — kullanıcı kararı. |
| `GET /saglik` | **tam kart numarası** (`data-pop-login`) | `reports.py` çözülmüş `login`'i `record_data`'ya koyuyor, `saglik.html` basıyordu. `index()`'i atlayan **ikinci render yolu**; `lan_full_access` gerekmiyordu (ölçüldü: 3/3 kart sızdı). | `_redact_health_for_lan()` — CreditCard kayıtlarının `login`'i boşaltılır. Bunun için `Record.type` SELECT'e ve `record_data`'ya eklendi (`getattr(record,'type',None)`: `rows` bir SQLAlchemy `Row`, eksik sütun `AttributeError` fırlatıyordu). Cache sözlükleri **mutasyon edilmiyor**, her render kendi kopyasını alıyor. |

**Bu turda düzeltmenin kendi yarattığı iki açık (regresyon — düzeltildi):**
- 🔴 **Kısmi `POST /duzenle/<id>` kaydı sessizce yok ediyordu.** `_record_from_form` her alan için `request.form.get(...)` kullanıyordu; alan yoksa `''` yazılıyordu. GET'i 403 yaptığımız için uzak istemci formu açamıyor ama POST'u atabiliyordu → yalnız CSRF gönderen bir istek kaydın **10 alanının tamamını** sıfırlıyor, `PasswordHistory` de yazılmıyordu (ölçüldü: geri dönüş yolu yok). Düzeltme: `_FORM_FIELD_TO_ATTR` haritasıyla **gönderilmeyen alanın mevcut değeri korunur** (`/ekle`'de bu yanlış olurdu, orada her alan formdan gelmeli). Ayrıca `_audit('kayit_guncellendi')` eklendi — önceden hiç iz bırakılmıyordu.
- 🟠 **Boş/form gövde savunma ayarını sıfırlıyordu.** `_reject_remote_critical_settings` "anahtar gönderildi mi" diye bakıyordu ama **yazma koşulsuzdu**: `str(None).lower()` == `'none'`, okuma tarafı `value == 'true'` → `{}` gövdesi ekran yakalama engelini sessizce kapatıyordu. Düzeltme: yazma **okuma ile aynı varlık koşuluna** bağlandı, anahtar yoksa `400`. Donanım hızlandırma ucu da aynı şekilde düzeltildi.

**Doğrulama:** 7 senaryo ayrı ayrı ölçüldü — LAN+gizli (ızgara/sağlık sızdırmıyor, `/duzenle` 403 + audit), **yerel → hepsi görünür**, gösterim **açık** → uzak tam-yetkili istemci eski yetkisini koruyor, **kısmi düzenleme sırları koruyor**, **tam düzenleme her alanı yazıyor**, uzak `POST /duzenle` hâlâ 302, boş/form gövde 400 + ayar korunuyor.


### Ağ / TLS

- **İki TLS kanalı da fail-closed.** `getPinnedHttpsOptions()` pin yokken `rejectUnauthorized: false` dönüyordu (tamamen doğrulamasız). Artık `rejectUnauthorized: true, ca: []` → istek hiç gönderilmeden reddediliyor.
- **Chromium kanalındaki trust-on-first-use tamamen kaldırıldı.** "CN=ŞifreKasam + self-signed + localhost SAN" görünce kabul ediliyordu — `127.0.0.1`'deki sahte sunucu bu üç niteliği taklit edip renderer trafiğini alabiliyordu. Artık kural: sunulan DER bayt bayt pin ile aynıysa kabul, **her koşulda değilse red**. Kullanıcıya "Güven ve Kaydet" diyaloğu artık hiç görünmüyor.
- **Ertelenmiş ilk açılış yarısı da sorun değildi:** Flask `cert.pem`'i import sırasında, bind'dan **önce** üretiyor; ana süreç zaten bekliyor. Ek gecikme ~0. Sertifika üretilemezse net bir hata veriyor (sessizce gevşemek yerine).

### Port yarışı (TOCTOU) — ✅ KAPATILDI (2026-10 turu)

**Sorun:** `findFreePort()` portu seçip dinleyiciyi **kapatıyor** (`server.close()`), sonra Flask o porta bağlanıyordu. Aradaki boşlukta yerel bir süreç portu çalabiliyordu. LAN modunda ayrıca **ölçülmüş bir DoS vardı:** `findFreePort` her zaman `127.0.0.1`'e bağlanırken Flask `0.0.0.0`'a bağlanıyordu; Windows 11'de ölçüldü ki `[('attacker-127.0.0.1',P),('flask-0.0.0.0',P)]` → **wildcard bind, 127.0.0.1 bind'i yanında BAŞARILI** (loopback bağlantılarını daha spesifik dinleyici yanıtlıyor). Yani saldırgan loopback'i çalarsa Flask bind'i **başarılı** olur → hata olmaz → **retry tetiklenmez** → ana süreç saldırganı dinler. Sertifika pini MITM'i durdurur ama uygulama açılmaz (60 sn sonra hata).

**Çözüm: "port seç → dinleyici aç" iki adımı TEK atomik `bind()`'e indirildi.** Ana süreç artık port **tahmin etmiyor**:

| Adım | Nerede | Ne oluyor |
|---|---|---|
| 1 | `src/main/backend-process.js` | `FLASK_PORT=0` gönderilir ("boş portu sen seç") |
| 2 | `flask_app/app.py:_report_bound_port` | Flask `bind()`+`listen()` **tamamlandıktan sonra** `print('KASA_PORT=<port>', flush=True)` |
| 3 | `src/main/backend-process.js` | stdout'tan satır ayrıştırılır (`^KASA_PORT=(\d{1,5})$`), `rt.PORT` yazılır, port kapısı açılır |

`findFreePort()` ve `isPortStillFree()` **tamamen silindi** — yarış imkânı kalmadı, alan tahmini de ortadan kalktı. `isPortBindFailure` + `_BIND_ERROR_PATTERN` **korundu** (sabit port isteyen geliştirici senaryoları için); Werkzeug'ın `sys.exit(1)` yolundaki *"is in use by another program"* mesajı için desen genişletildi.

**Yan fayda (kendiliğinden):** LAN modundaki `127.0.0.1` / `0.0.0.0` çakışması da çözüldü, çünkü artık **tek bir dinleyici** var ve o da Flask'ın kendi bind'idir.

**Ölçülenler (varsayım değil):**

| Ölçüm | Sonuç |
|---|---|
| cheroot 11.1.2, `bind_addr[1]` `port=0` iken gerçek portu veriyor mu? | ✅ `bind()` içinde `self.bind_addr = self.resolve_real_bind_addr(sock)`; kendi FIXME yorumu bunu teyit ediyor |
| Werkzeug fallback (`make_server(...).port`) | ✅ `serving.py`: *"If port was 0, this will record the bound port"*; cheroot engellenerek **uçtan uca ölçüldü** (`KASA_PORT=3326` + TCP bağlantı başarılı) |
| `print()` flush'suz pipe'a düşer mi? | ❌ YANLIŞ — 1.5 sn görünmüyor. `flush=True` zorunlu, konuldu |
| PyInstaller `console=False` (`runw.exe`) stdout pipe'ı keser mi? | ❌ YANLIŞ — **ölçüldü**: paketli `backend/SifreKasam.exe` stdout'a `KASA_PORT=23564` bastı, port TCP bağlantısı kabul etti, 1437 ms |
| stdout güvenli mi? | ✅ `flask_app/` altında **tek** `print(` var: kendi port raporumuz (`app.py:3725`). cheroot hiç yazmıyor. **Ölçüldü:** uygulamanın `log` handler'ı stdout'a `[INFO] Self-signed SSL sertifikasi olusturuldu…` gibi satırlar basıyor, Werkzeug fallback'i de banner basıyor — ayrıştırıcı **satır başından sona tam eşleşme** aradığı için bunları yutuyor, port satırını kaçırmıyor |
| `/api/lan-info` kullanıcıya ne gösteriyor? | ✅ `_get_public_port()` **gerçek bağlanan** portu okuyor, 0'ı **asla** göstermiyor (eskiden `safe_int(..., 1, 65535)` minimum'u yüzünden `FLASK_PORT=0` **port 1** gösterirdi) |

**Yan kapı bulundu ve kapatıldı:** `src/main/window.js` içinde **iki ayrı** `webRequest.onCompleted` kaydı vardı. Electron'da olay başına **yalnızca son eklenen dinleyici** kullanılır (`docs/api/web-request.md`: *"Only the last attached listener will be used"*; electron/electron#10478) → içerik koruması kaydı, `/save_settings` → LAN mutabakatı kaydını **siliyordu**, yani o kanca ölüydü. İki davranış tek `_onBackendCompleted` dinleyicisinde birleştirildi; port artık filtrelere gömülmüyor. Test: `window.js` içinde `webRequest.onCompleted(` sayısı tam olarak 1.

**Yan etkiler:** `app.py` PyInstaller paketinde (`integrity.js` `CRITICAL_CANDIDATES`) → `npm run build:backend` çalıştırıldı: *"Bütünlük manifesti imzalandı (272 dosya)"*. `__Host-session` çerezi **port'a değil host'a** bağlı → port değişince oturum düşmez. Port bekleme + sertifika bekleme + hazır olma probu artık **tek deadline** paylaşıyor (önceden 15 sn + `timeoutMs` üst üste binebiliyordu); port sözleşmesi `on('exit')` ile de reddediliyor (aksi halde Flask çökerse 60 sn beklenirdi).

**Doğrulanamayanlar:** yarış penceresinin istatistiksel ölçümü (pencere ~1-3 ms, güvenilir senkronizasyon gerektiriyor). `cheroot 10.x` (`requirements.txt` yalnız `>=10.0.0`) `IS_EPHEMERAL_PORT` davranışı doğrulanmadı — mitigasyon: port satırı hiç/0 gelirse **fail-closed** net hata, sessiz yanlış davranış olmaz. `127.0.0.1` ↔ `0.0.0.0` örtüşmesi yalnız Win11 build 26200'de ölçüldü (başka sürümde bind hatası verirse daha iyi — retry çalışır).

### Veri / dosya

- **`.kasaenc` içe aktarımı `MAX_IMPORT_RECORDS`'ı uygulamıyordu** (64 MB gövde × 10-20 amplifikasyon; restore yolunda `Record.query.delete()` sonrası çalışıyordu → uygulama donuyordu). Kırpma eklendi ve **kullanıcıya uyarı gösteriliyor** (sessiz eksik import yok).
- **`delete_backup` path traversal kontrolü eksikti.** `_is_managed` kontrolü `sifrekasam_otomatik_/../../x.kasaenc` biçimini geçiriyordu. `read_backup`'taki `resolve()` + `is_relative_to` deseni birebir uygulandı. (Not: HTTP katmanı zaten 400 döndürüyordu, yani sömürülebilir yol yoktu — savunma derinliği eksiği.)
- **`import_data` tüm hataları 400'e indiriyordu.** Disk dolması "geçersiz dosya" gibi görünüyordu ve log'da traceback yoktu. Artık `log.exception` + 500.
- **`_check_heartbeat` hata yutuyordu** → LAN açıkken gereksiz kapanma. `except → continue` + log.
- **`brand_icons.py` kaçışsız `Markup`** → `escape()` eklendi (61 olası değerin 0'ı değişiyor, çıktı byte-özdeş).

### Paketleme ve bütünlük

- **Electron fuse'ları çevrildi (2026-10 turu).** Altyapı zaten kuruluydu: packager `app.asar`'ın header SHA256'sını hesaplayıp `SifreKasam.exe` içine `ELECTRONASAR` PE resource'ı olarak yazıyordu (byte düzeyinde doğrulandı) — sorun fuse'un kapalı olması değil, **hash'in var olup doğrulanmaması**ydı. `forge.config.js` + `@electron/fuses` eklendi, 6 fuse açıldı: `RunAsNode=false`, `EnableCookieEncryption=true`, `NodeOptionsEnv=false`, `NodeCliInspect=false`, `EnableEmbeddedAsarIntegrityValidation=true`, `OnlyLoadAppFromAsar=true`.
  - **Sürüm tuzağı:** `@electron/fuses@2.1.3` **kullanılamadı** — `plugin-fuses@7.11.2` peer'ı `^1.0.0` istiyor, 2.x `npm ci`'ı ERESOLVE kırıyor. Kurulan sürüm **1.8.0**.
  - `GrantFileProtocolExtraPrivileges` **korundu** (`file://` ile `loading.html` yükleniyor). `strictlyRequireAllFuses` kullanılmadı (sürüm yükseltmesinde yeni fuse'lar build'i kırar).
  - **Doğrulama:** gerçek `npm run package` build'i üretildi, fuse wire okundu: `101100011` → `{"0":48,"1":49,"2":48,"3":48,"4":49,"5":49,"6":48,"7":49,"8":49}`. Bu satır **güncellendi**: bağımsız inceleme PE'nin `INTEGRITY/ELECTRONASAR` resource'undaki `value` alanını okuyup `asar.getRawHeader().headerString` SHA256'sıyla karşılaştırdı → **birebir eşleşiyor**. Yani `EnableEmbeddedAsarIntegrityValidation` gerçekten çalışır durumda; wire `010011011` (9 fuse) ve `forge.config.js`'teki 6 anahtarın altısı da doğru konumda → **6/6, "4/6" değil**.
  - 🔴 **Bu bir açık kapatma değil, "kaza ile bozulma" tespiti.** Maliyet sıfırdı, eklendi; ama imzasız pakette fuse koruması değildir. Asıl kök güven sorunu ve `integrity.js`'in neden daha güçlü olduğu §3.2'de kayıtlı.

### Diğer

- **`FLASK_SECRET_KEY` ile `APP_TOKEN` ayrıldı.** Token ele geçse artık oturum çerezi imzalayamıyor.
- **Kaynak kökeni yalıtımı:** `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `X-Permitted-Cross-Domain-Policies` eklendi.
- **`_same_origin_state_change` tam fail-closed:** durum değiştiren istekte `Origin`/`Referer` yoksa reddedilir.
- **Ekran yakalama engeli (`content protection`) sessizce ölü özellikti** — ana süreç isteği 302 alıp `catch` ile yutuyordu, yani kullanıcı anahtarı açık görse de koruma uygulanmıyordu. Canlandırıldı.
- **Anahtar doğrulama:** `secrets.compare_digest` (sabit zamanlı).
- **Paketleme:** `scripts/build-backend.js` çıplak `python` varsayıyordu → bu makinede PyInstaller hiç başlamıyordu. Paylaşılan `src/main/python-command.js` çözümleyicisi yazıldı.
- **`scripts/patch-extract-zip.js` shim'i de aynı hatayı taşıyordu** → `npm install` sonrası `node_modules/electron/dist` **hiç oluşmuyordu**, `npm start`/`package`/`make` üçü de ölü. Shim artık aynı `resolvePythonCommand()` çözümleyicisini kullanıyor, sonra `python → py -3 → py -3.12 → python3` adaylarını sırayla deniyor ve hepsi başarısızsa **hangi adayların denendiğini söyleyen** net hata veriyor (`KASA_EXTRACT_VERBOSE=1` ile loglar). İkinci hata: `main()` marker'a bakıyordu, shim'in içeriği değişse bile eskisini yerinde bırakıyordu → artık **içerik karşılaştırması** yapıyor.

### 🔴 Ölçüm tuzağı: fuse wire'ı `@electron/fuses` KÜTÜPHANESİYLE OKUNMAZ

`getCurrentFuseWire()` **güvenilmez**, iki kez yanlış sonuç verdi: `1.8.0` "10 fuse", `2.1.3` paketlenmiş exe için `9 fuse: 111111111` dedi (→ "FusesPlugin hiç çalışmamış" sanıldı). **İkisi de yanlıştı.** Gerçek format:

```
sentinel  : dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX
sonrası   : <fuse sürümü:1 byte> <fuse sayısı:1 byte> <wire karakterleri>
```

Ölçülen byte'lar (Forge 8 + Electron 44.5.1 build'i, `01 09` = sürüm 1, 9 fuse):

| | wire | durum |
|---|---|---|
| template `electron.exe` | `101100011` | fabrika |
| paketlenmiş `SifreKasam.exe` | **`010011011`** | ✅ hedef |

İlk 6 fuse tam olarak istenen: `RunAsNode=0`, `EnableCookieEncryption=1`, `EnableNodeOptionsEnvironmentVariable=0`, `EnableNodeCliInspectArguments=0`, `EnableEmbeddedAsarIntegrityValidation=1`, `OnlyLoadAppFromAsar=1`. Kalan 3 (`LoadBrowserProcessSpecificV8Snapshot=0`, `GrantFileProtocolExtraPrivileges=1`, `WasmTrapHandlers=1`) **dokunulmuyor** — `GrantFileProtocolExtraPrivileges` bilinçli korunuyor (`loading.html` `file://` ile yükleniyor). `WasmTrapHandlers` **yok**; "10 fuse" diyen okuma yanlıştı.

**Kural: fuse güvenlik ölçümü daima ham byte ile yapılır, kütüphaneye güvenilmez.**

### 🔴 Ölçüm tuzağı: `overrides` bloğu Forge 8'i kırıyor

`package.json`'daki global `"brace-expansion": "2.1.4"` sabitlemesi, Forge 8'in `minimatch@10.2.6`'sı (saf ESM, `brace-expansion: ^5.0.8` istiyor) ile çakıştı:

```
SyntaxError: Named export 'expand' not found in 'brace-expansion' (CJS)
→ minimatch/dist/esm/index.js:1
```

Sabitleme **kaldırıldı**; kalan override'lar `@xmldom/xmldom: 0.9.12`, `fast-uri: 3.1.7`. Forge 8 alt ağaçlarında artık `brace-expansion@5.0.12` (ESM) geliyor.

### Bağımlılıklar ve kalan `npm audit` uyarıları — bilerek yapılmayan (2026-10)

Güncel: `electron 44.5.1`, `@electron/fuses 2.1.3`, `@electron-forge/{cli,maker-squirrel,maker-zip,plugin-fuses} 8.0.1`. Forge 8'e geçişte `require(esm)` sayesinde `forge.config.js` **hiç değişmedi** (Node ≥ 22.12 `require()` ile ESM yükleyebiliyor).

**Electron 45 alpha bilerek alınmadı.** Ölçülen: Chromium 152 → 155 (+3), Node 24.21.0 aynı. Kırıcı değişiklikler arasında **ANGLE tüm platformlarda statik bağlanıyor** (GPU/ekran davranışı değişir — "Donanım Hızlandırma" ayarı ve `window.js`'deki siyah ekran notu bu risk alanında, headless doğrulanamaz) ve Electron ilk çalıştırmada kendini dinamik indiriyor. Ölçülen başlangıç yavaşlığı **Chromium sürümü değil, varlık ağırlığı** (21 render-blocking stylesheet, ~617 KB — bkz. §1 SW kaydı); yeni Chromium bunu değiştirmez. `@electron/fuses@2.1.3` hâlâ sadece `FuseVersion.V1` tanımlıyor → yeni fuse getirisi de yok.

`npm audit`: **36 → 13** (kritik 1, yüksek 11, orta 1). Kalanların **tamamı `devDependencies` ağacında** — `package.json`'ın `dependencies` bölümünde **tek paket** var: `tree-kill`. Ölçülen uçtan uca: paketlenmiş `app.asar` kökünde `\LICENSE, \assets, \favicon.ico, \main.js, \package.json, \preload.js, \src` var; `flask_app/` ve `backend/` asar'da yok; **13 advisory'nin hiçbiri paketlenmiş uygulamaya girmiyor.**

| paket | nereden | neden kabul |
|---|---|---|
| `tar` (kritik) | `@electron/node-gyp` → `make-fetch-happen` → `cacache` | yalnız **native modül derlemede**; projede node-gyp ile derlenecek native modül **yok** (backend PyInstaller) |
| `extract-zip` | `@electron/packager` | kurulum anında Electron zip'ini açar; kurulum bittikten sonra çalışmaz |
| `brace-expansion` | `minimatch` (glob) | build-time; sabitlemesi forge 8'i **kırdı** (yukarıda) |
| `undici`, `http-cache-semantics`, `cacache`, `make-fetch-happen` | forge CLI / node-gyp | build-time HTTP istemcisi, çalışma zamanında kullanılmıyor |

**`npm audit fix` bilerek çalıştırılmadı:** `brace-expansion` override'ını zaten kırdığı gösterildi; düzeltmenin forge 8'i yeniden bozup bozmayacağı headless ortamda **doğrulanamaz**, kazanacağı güvenlik değeri sıfır (paketlenmiş çıktıya girmiyor) olan bir değişiklik için risk alınmadı.
- **Güvenlik olay günlüğü** (`kasa_core/audit.py`): 11+ olay, konsol + `logs/guvenlik-olaylari.log` (döndürmeli 1 MiB × 3). **Varsayılan-red süzgeç:** izin listesinde olmayan alan olayın tamamını düşürür.

> **Süzgeçte başlangıçta gerçek bir sızıntı vardı.** Alt ajan alanları *red listesiyle* süzüyordu; deny listesinde olmayan alan adları geçiyordu ve probda `icerik="<parola>"` dosyaya düz yazıldı. "Parola asla yazılmaz" garantisi ancak izin listesiyle mümkün — düzeltildi ve regresyon testi eklendi.

---

## 2. ⏸️ Bilerek yapılmayanlar (gerekçesiyle)

### 2.1 `Cross-Origin-Embedder-Policy: require-corp` — YAPILMADI

**Gerekçe:** Projede `SharedArrayBuffer`, `.wasm` ve `crossOriginIsolated` **hiç kullanılmıyor**. COEP'in satın alacağı güvenlik faydası bu durumda **sıfır**. Buna karşılık `glass-grain` overlay'i `data:` URI SVG kullanıyor — `require-corp` bunu kırardı.

**Alternatif araştırıldı, daha iyisi yok.** COEP'nin anlamlı olduğu tek senaryo (cross-origin izolasyon gerektiren API'ler) bu projede mevcut değil. Gerçekten gerekirse `COEP: credentialless` denenebilir ama o da `data:` alt-kaynaklarını etkiler.

### 2.2 `Strict-Transport-Security` — YAPILMADI (ve YAPILMAMALI)

**Gerekçe:** HSTS, tarayıcıya "bu alan için sertifikayı **atla**" demektir. Bizim sertifikamız **kendinden imzalı** ve tarayıcı bypass edemez. Yani HSTS aktifleştirildiği anda mobil LAN istemcisi (telefon) kalıcı olarak erişilemez hale gelir — kullanıcı kasa erişimini tamamen kaybeder.

Bu, "güvenlik eklentisi" değil, **aktif olarak zararlı** bir başlıktır. `NOTES.md` içinde de bu bilinçli kabul olarak kayıtlı.

### 2.3 `loading.html`'i Flask'ın sunması — YAPILMADI

**Gerekçe:** Açılış ekranı `window.js:72`'de `loadFile()` ile yükleniyor — yani **Flask çalışmadan önce**, `file://` şemasıyla. Flask onu sunamaz; sunması için zaten çalışıyor olması gerekir ki o zaman ekrana ihtiyaç kalmaz.

Dosya iki bağlamda yaşıyor (`file://` + herkese açık `GET /loading`). İkinci bağlamda gerçek nonce'lu header CSP uygulanıyor; ilk bağlamda `loading.html`'e eklenen `<meta http-equiv="Content-Security-Policy">` devreye giriyor. Yeterli.

**Alternatif araştırıldı:** Ana sürecin önce `https://127.0.0.1:port/loading` denemesi, başarısız olursa `file://`'e düşmesi. Rejime kazandı — çünkü `file://` penceresi zaten Flask hazır olmadan açılıyor, koruma orada da meta CSP ile sağlanıyor. Ek karmaşıklık getirirdi, kazandırmadı.

### 2.4 Kalem 13 — 16 ayar anahtarının tabloya indirilmesi — KULLANICI KARARIYLA YAPILMADI

`save_settings` + `settings_appearance` + `appearance_state()` arasındaki tekrarı tek tabloya indirmek. **Bakım kolaylığı, görünür güvenlik faydası yok** — ve geçmişte `card_holder` veri kaybı tam olarak "bu kalıbı yanlış uygulama" hatasından çıkmıştı. `appearance_state()` okuma tarafında zaten tek tanım.

### 2.5 Audit günlüğü arayüzü — KULLANICI KARARI (geliştirici modu)

Olaylar konsola + dosyaya yazılıyor, arayüz yok. `read_audit_log()` yalnızca **aktif** dosyayı okur (rotasyon yedeklerini okumaz — en fazla ~4 MB olay korunur).

### 2.6 `/settings/language` için `_is_local_request()` muafiyeti — BİLEREK KORUNDU (2026-10)

**Bulgu (bağımsız inceleme):** `settings_language` `_PUBLIC_ENDPOINTS` içinde olduğu için `before_request` kimlik kapısını atlıyor; view'daki koşul `current_user.is_authenticated or _app_token_valid() or _is_local_request()`. Ölçüldü: **yerel + kimliksiz** `POST /settings/language` → **200**, dil kalıcı değişiyor; **uzak + kimliksiz** → 403 (doğru davranış).

**Önerilen "`_is_local_request()` dalını kaldır" düzeltmesi UYGULANMADI — giriş ekranını kırardı.** Dil seçici üç ekranda da çalışıyor ve üçü de **oturumsuz**:
- `templates/loading.html:119` — `loading.html` Electron'da **`file://` üzerinden** `loadFile()` ile yükleniyor (`src/main/window.js:72`), yani **hiç oturum çerezi yok**. Bu ekran ancak `_is_local_request()` ile çalışabilir.
- `templates/login.html:779` — giriş ekranı, kullanıcı henüz oturum açmamış.
- `templates/partials/modals/lock.html:224` — kilit ekranı.

**Bu ayrıcalık kapatılamaz, sadece "daha az kapatılabilir":** aynı makinedeki keyifsiz her süreç zaten `127.0.0.1`'e bağlanıp `Origin` başlığını taklit edebilir; şablona gömülen bir belirteç de yerel saldırgan tarafından `GET /login` ile okunabilir. Yani uygulama katmanında ayırt edilebilir bir "gerçek tarayıcı" ile "yerel script" **yoktur** — bu, §0'ın "aynı kullanıcı bağlamı çözülemez" sınırının bir örneğidir.

**Etki ölçüldü ve sınırlı:** yalnızca arayüz dili (`tr`/`en`) değişir. Kasa verisi, anahtar, oturum, makine davranışı **etkilenmez**; aynı makinedeki keyifsiz bir süreç zaten `sifreler.db` dosyasına doğrudan erişebilir. Bilinçli kabul olarak kaydedildi.

**Ek olarak:** `/api/background/current` de yerel-kimliksiz özel arka plan görüntüsüne izin verir (`app.py`), çünkü arka plan **giriş ekranında** görünmelidir. Tasarım gereği, düşük önem.


---

## 3. 🔧 Ertelenmiş kalemler

**3.1 (port yarışı / TOCTOU) ve 3.2 (asar fuse) KAPATILDI ve uygulandı.** Uygulama sonucu, ölçümler ve dayandığı kaynak kod kayıtları §1'e taşındı; aşağıda yalnız **kapanış notu** ve kapanışta işe yaramayan ölçümler kalıyor.

### 3.1 ⭐ Port yarışının (TOCTOU) kapatılması — ✅ YAPILDI → §1'e taşındı

Araştırma notu olarak burada bırakmaya değer iki bulgu:

**Reddedilen alternatif: named pipe.** Çalışıyor (ölçüldü) ama **önerilmedi** — `stdio:'pipe'` adlandırılamaz/keşfedilemez bir handle iken named pipe **tahmin edilebilir** isim gerektirir; ismi bilen yerel süreç `CreateFile` ile **kendi sahte portunu yazabilir**. Bugün olmayan bir saldırı yüzeyi (port enjeksiyonu) açılırdı.

**Windows'ta soket devri neden mümkün değil** (3 bağımsız mühür, hepsi ölçüldü):
1. Windows aynı addr/port için ikinci bind'i **reddeder** (`errno=10048`, her iki yönde 4/4) — Unix'teki `SO_REUSEPORT`/socket-activation eşdeğeri yok.
2. `socket.share()` **yok**; `os.dup` yalnız kendi sürecinde; `WSADuplicateSocket` ne Node ne Python stdlib'de.
3. cheroot `prepare()` kendi soketini **kendisi** bağlıyor — enjeksiyon noktası yok.

### 3.2 Asar bütünlüğü / Electron fuse — ✅ YAPILDI → §1'e taşındı

Kapanış notu: **fuse, imzasız pakette savunma değil, yalnızca "kaza ile bozulma" tespiti.** Maliyeti sıfırdı, eklendi. Aşağıdaki mimari içgörü **hâlâ geçerli ve en değerli olan**:

`integrity.js` **asar'ın İÇİNDE** (`src/main/integrity.js`). Doğrulayıcı, doğruladığı şeyin içinde. Asar'ı kendi içinden doğrulamak **döngüsel**. Yani:

> **`app.asar` tüm bütünlük garantilerinin kök güvenidir ve korumasızdır. Asar, süreç içi yolla korunamaz.** (Eski satır "bunu yalnız kod imzalama çözer" diyordu — **düzeltildi**: §0'taki "aynı kullanıcı bağlamı" modelinde Authenticode de çözüm değildir; §3.3'e bakın.)

Bu yüzden `integrity.js`'in backend için Ed25519 yaklaşımı (anahtar repo dışında → saldırgan sahte manifest **yazamaz**) fuse'dan **daha güçlü** bir savunmadır. Proje zaten doğru karşılaştırmalı modeli kurmuş durumda:

| | ASAR fuse | `integrity.js` (Ed25519) |
|---|---|---|
| Kapsam | `app.asar` (JS'in tamamı) | `resources/backend/` (45.6 MB, 272 dosya = Python/Flask'in tamamı) |
| Beklenen hash'in güvenliği | ⚠️ exe içinde, imzasız → değiştirilebilir | ✅ anahtar repo dışında → sahte manifest yazılamaz |
| Aktif saldırgana karşı | ❌ (imzasızsa savunma değil) | ✅ |

**Asar'ı `integrity.js` kapsamına almanın** (daha güçlü ama daha çok kod) ön koşulları: build tarafında manifest + imza üretimi, runtime'da asar'a özel aday listesi ve zamanlama. Manifest asar'ın **dışında** tutulursa döngü kırılır — ama o zaman saldırgan manifest'i bozabilir, `backend_integrity.json`'in Ed25519 imzası devreye girer. **Yani çalışır; bu bir tasarım önerisidir, kodla doğrulanmış çözüm değildir.**

**Korumasız kalan:** `favicon.ico` ve `assets/` — `resources/` altında ama `integrity.js` manifesti yalnız `resources/backend`'i tarıyor. Kod çalıştırmadığı için düşük risk; bilinçli bir kabul olabilir.

### 3.3 Kod imzalama (Authenticode) — ✅ KAPATILDI: bilerek yapılmıyor (2026-10 turu, kullanıcı kararı)

**Ölçülen durum (bu makine, `Get-AuthenticodeSignature`):**

| Dosya | Sonuç |
|---|---|
| `out/ŞifreKasam-win32-x64/SifreKasam.exe` (246 MB) | **NotSigned** |
| `backend/SifreKasam.exe` (9.969.984 byte) | **NotSigned** |
| `flask_app/dist/SifreKasam/SifreKasam.exe` | **NotSigned** |
| `node_modules/electron-winstaller/vendor/Setup.exe` (223.232 byte) | **NotSigned** |

`Setup.exe = vendor/Setup.exe` yalnızca yeniden adlandırılıyor (`squirrelConfig.setupExe`) → **kurulum sihirbazı da imzasız**.

**Altyapı hazır, yalnızca yapılandırma yok** (bu, kalemin "yapılamaz" değil "yapılmamış" olduğunun kanıtı): `maker-squirrel/src/MakerSquirrel.ts:57` `...this.config`'i doğrudan `electron-winstaller`'a geçiriyor; `lib/index.js:303-321` Squirrel'a `--signWithParams` veriyor (`certificateFile`/`certificatePassword`/`signWithParams`/`windowsSign`). `@electron/windows-sign@1.2.2` **kurulu** (dual sha1+sha256, varsayılan `timestampServer=http://timestamp.digicert.com`, `hookFunction`/`hookModulePath` ile bulut imzalayıcı). `vendor/signtool.exe` (237.392 byte) mevcut. Yani ileride sertifika alınırsa bu bir **yapılandırma değişikliği** olur, kod değişikliği değil.

**Neden bilerek yapılmıyor — asıl gerekçe (§0 ile tutarlı):** Authenticode, **derlenmiş ikilinin yayıncısını ve bütünlüğünü** doğrular (kaynak kodla ilgisi yoktur). §0'daki asıl tehdit modeli **"aktif saldırgan aynı kullanıcı bağlamında çalışıyor"** — bu senaryoda saldırgan imzayı kendi sertifikasıyla yeniden yazabilir veya ikiliyi kendi yerine koyabilir; Authenticode **hiçbir şey çözmez**. Aynı iş için projede zaten çalışan bir mekanizma var: `integrity.js` Ed25519 imzalı manifesti + Electron fuse'ları (§1 "Paketleme ve bütünlük"). İmzalama yalnızca **dağıtım/indirme manipülasyonu** senaryosuna katkı verirdi; bu §0'ın kapsamı dışında ve kullanıcı tarafından bilinçli olarak dışarıda bırakıldı.

**Eskiden yazılan iki hüküm 2026-10'da düzeltildi** (yanlış oldukları için kayıt altına alınmıyor):
- "OV ~$70-200/yıl" güncel değil: Microsoft dokümanı OV için **$150-300/yıl**, pazar **$215-400/yıl**, en ucuz gerçek yol Certum/aracı **~$99/yıl**. Yani "paranın çözmediği" doğru değildi — para engel değildi.
- **EV sertifikada 2024'ten beri anında SmartScreen bypass YOK**; "EV alıp SmartScreen'i çöz" tavsiyesi bayat, OV ve EV itibar açısından aynı. (SmartScreen reputation, **sabit yayıncı/kimlik** ile sürümler arasında birikir; yeni bir kimlik sıfırdan başlar → sertifika alınsa bile aylar boyunca uyarı çıkar.)
- Microsoft'un kendi dokümanına göre Azure Artifact Signing **~$9.99/ay** (5.000 imza) — ama **birey geliştiricilere yalnızca ABD/Kanada'da** açık (kurumlar ABD/Kanada/AB/BK + **en az 3 yıl doğrulanabilir vergi geçmişi**). Türkiye'deki birey bir geliştirici için bu yol kapalı.
- Teknik kısıt: Haziran 2023'ten itibaren (CA/B BR 6.2.7.4.2) kamuya açık kod-imzalama özel anahtarı **FIPS sertifikalı donanımda** (YubiKey/SafeNet) veya CA'nın bulut HSM'inde tutulmalı; çoğu CA indirilebilir `.pfx` **vermiyor**. Ayrıca 1 Mart 2026'dan itibaren sertifika geçerliliği **458-460 gün** ile sınırlı → **zaman damgası (`/tr`) zorunlu**, damgasız imza ~15 ayda düşer.

**`~/.sifrekasam/sign_key.pem` Authenticode sertifikası DEĞİL** — backend manifest imzası için.

---

## 4. Bilgilendirme (güvenlik etkisi yok, kayıt için)

- **Audit günlüğü okuma olaylarını da kaydediyor** (`sifre_gosterildi`, `sifre_gecmisi_gosterildi`, `kanal=uzak|yerel`). Kayıt kimliği ve şifre **asla** yazılmıyor (izin listesi reddediyor).
- **`ana_sifre_degistirildi` yalnız başarılı bitişte yazılıyor**; hata yolunda `_audit('ana_sifre_degistirme_basarisiz')` + `log.exception` var.
- **CSRF token `/lock` ve `/logout` sonrası dönüyor** — oturum çerezi imzalı ve sunucuda session id olmadığı için session fixation riski **yok**; bu yalnızca "token hiç dönmüyor" standardını kapatıyor.
- **`/api/health/export` LAN'dan engelli** — bilinçli; içeriği sadece istatistik, kasa verisi değil.
- **Test paketinde gizli izolasyon zayıflığı vardı** (bulundu, düzeltildi): `SecurityHardeningTests._reset_vault_state` ayar anahtarlarını siliyordu ama `Record`/`PasswordHistory` satırlarını silmiyordu. Sızma hata üretmiyor, **yanlış test sırasına** yol açıyordu (izole GEÇEN, tam koşuda FAIL). Kalıcı düzeltme yapıldı.
- **`test_lock_preserves_csrf_token` baştan beri boştu** (bulundu, düzeltildi): `/lock` oturum açık değilken 403 döndürüyor, yani kilit hiç oluşmuyor, belirteç de zaten değişmiyordu → test yanlış sebeple geçiyordu.

---

## 5. Test durumu (bu turun sonu)

```
py -3.12 -m pytest tests/test_kasa.py -q   →  416 passed, 97 subtests passed
py -3.12 scripts/security_lint.py          →  Security lint passed
```

**2026-10 güvenlik turu — 2. tur (nihai tarama) sonrası eklenen 7 test:** boş/form gövde içerik yakalamayı kapatamıyor, `content_protection_enabled` açıkça gönderilince `'false'` yazıyor (`'none'` gibi bozuk değer değil), `/saglik` uzak LAN'a kart numarası sızdırmıyor / yerelde sızdırıyor, kısmi düzenleme formu mevcut sırları **korumalı**, tam form her alanı yazıyor, uzak `POST /duzenle` hâlâ izinli (D1'in bilinçli kararının testi).

**Test paketinde bulunan ve düzeltilen ikinci izolasyon zayıflığı:** `SecurityHardeningTests._reset_vault_state` `RECORD_METADATA_SETTING` anahtarını temizlemiyordu. Bu yüzden sürecin **ilk** girişinde `migrate_plaintext_record_metadata` metadata'yı şifreliyor ve testin `encrypt_metadata` ile yazdığı `card_holder` çözülemez hale geliyordu → kart-ismi sızıntı assertion'ı **koşul bağımsız (vacuous)** kalıyordu. Bağımsız inceleme bunu mutasyon testiyle kanıtladı (kart-ismi gizlemesi kaldırıldığında test geçiyordu). Düzeltme: anahtar `_reset_vault_state` listesine eklendi, kayıtlar `_login()`'den sonra ekleniyor, `_seed_secret_carrier_records` tek kaynaklı hale getirildi (testler 6 yerine 3 kayıtla çalışıyor).

**2026-10 güvenlik turunda eklenen 7 LAN sızıntısı testi:** ızgara kart no / kart ismi / not sızdırmıyor, ızgara **yerel** kullanıcıya sır gizlemiyor, `/duzenle/<id>` GET uzak + gizliyken 403, aynı form gösterim açıkken uzak istemciye açık, uzak istemci `auto_lock_timeout` / `content_protection_enabled` / `hardware_acceleration_enabled` zayıflatamıyor. Ek olarak kaynak kökeni yalıtımı başlık denetimleri (`test_reveal_setting_cannot_be_changed_remotely`'nin sonunda gömülü, hiçbir `def` ile ayrılmamış haldeydi) **kendi testine** taşındı — bu, o dosyada önceden var olan bir yapısal hataydı.

**Bu turda çıkan iki mevcut test kırıldı ve niyetleri korunarak düzeltildi:** `test_lan_full_access_opt_in_restores_write` ve `test_remote_partial_form_does_not_reset_flags`, "uzak tam yetki yazabiliyor" sözleşmesini kanıtlamak için `auto_lock_timeout` alanını kullanıyordu. Alan artık yerel-only olduğu için ikisi de 403 alıyordu; alan `accent_color` ile değiştirildi, testlerin sınadığı davranış değişmedi.

**Bu turda eklenen 12 test (`BoundPortReportingTests`) — yalnız unit değil, gerçek ölçüm:**
`app.py`'nin **gerçek süreci** `FLASK_PORT=0` ile açılıyor, stdout'tan `KASA_PORT=<port>` satırı okunuyor ve portun **gerçekten bağlantı kabul ettiği** süreç ayaktayken ölçülüyor. Ayrıca: `_configured_port()` 0'ı kabul ediyor mu, `lan-info` gerçek portu veriyor mu / hiçbir koşulda 0 vermiyor mu, `_report_bound_port` geçersiz değerleri reddediyor mu, `findFreePort`/`isPortStillFree` tamamen kalktı mı, `webRequest.onCompleted` gerçekten tek kayıt mı. (Werkzeug fallback yolu ayrıca elle ölçüldü: cheroot import'u engellenerek `KASA_PORT=3326` + başarılı TCP bağlantı.)

**Test paketinin tarayıcı taklidi:** Werkzeug test istemcisi `Origin` göndermediği için yeni fail-closed kaynak denetimi tüm testleri kırardı. `_BrowserLikeClient` sarmalayıcısı eklendi (her istekte `HTTP_ORIGIN` + `HTTP_SEC_FETCH_SITE`). Werkzeug'un `get/post/put/...` kısayolları sarmalayıcıyı **atlıyordu** (iç istemcinin `open`'una doğrudan gidiyor) — bu yüzden kısayollar ayrı ayrı tanımlandı.

> ⚠️ Bu, test paketindeki bir gerçek risk: test istemcisi tarayıcı **değil**, ama artık tarayıcı gibi davranıyor. Gerçek tarayıcı davranışını doğrulamak için canlı test gerekir.
