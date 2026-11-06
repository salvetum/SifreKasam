# ŞifreKasam 2.7.0-beta.4

Beta.3 ve beta.4 **aynı anda** yayımlanıyor — ikisi de GitHub'a etiketlenmemişti.

## Öne çıkanlar

**Beta.3** — tasarım ve altyapı dönüşümü: yenilenen arayüz ve animasyonlar, küçük
modüllere ayrılmış backend, paket başına modülerleşme, otomatik yedekleme ve
şifreli `.kasaenc` dışa aktarma, canlı parola sızıntısı taraması, şifre sağlığı
raporu araçları.

**Beta.4** — iki dönem:

*4 Ekim:* Electron 44.5.1, Forge 8, yapılandırılmış bütünlük doğrulaması, LAN
erişiminin sertleştirilmesi, 30 güvenlik bulgusunun kapatılması, giriş ve yükleme
ekranının yeniden tasarımı.

*9 Ekim:* kayıt başına etiketler ve özel alanlar, üçüncü parti içe aktarma
(Bitwarden, LastPass, Chrome, Firefox, 1Password, KeePass), arama alanı filtresi,
kayıt sıralaması, toplu düzenleme, pano otomatik temizleme, klavye kısayolları,
kayda dosya eki, kart banka işaretleri, düşük güç modunda opak yedek, Electron 44.7.0.

## Bu sürümde düzeltilen gerçek hatalar

- `.json` / `.txt` içe aktarımı kayıtları ekleyip kaydettikten sonra **500** dönüyordu
  (`UnboundLocalError`) — kullanıcı "başarısız" görüyor, verisi eklenmiş oluyordu.
- Normal arka plan modlarında cam **yarı saydam** görünüyordu; perde kaymıştı.
- Tasarruf modu camın arka plan dokusunu siliyordu — ölçülen enerji kazancı sıfırdı.
- Giriş ekranı 45 saniye sonra tasarruf moduna giriyordu.
- Kart bankası listesi web sitesi markalarını listeliyordu ("Visa seç" sessizce boş dönüyordu).
- Toplu etiket ekleme, eklediği etiketi aynı adımda siliyordu.
- **Kartlar hiç renderlanmıyordu**: `const` arrow fonksiyon tanımından önce
  çağrıldığı için TDZ `ReferenceError` veriyor, kart perde perdesi hiç kalkmıyordu.
- Modal içindeki açılır menüler çok küçük açılıyordu.
- `"İş"` ile `"iş"` iki farklı etiket sayılıyordu (Türkçe katlama).

## Bilinen sınırlamalar

- Kart ağı işaretleri (Visa, Mastercard…) **ticari marka oldukları için
  kopyalanmıyor**; ağların görsel diline uygun özgün işaretler üretiliyor.
- Tasarruf modunda paneller opak zemine geçiyor, cam geçmişi tam olarak korunmuyor.
- 2FA / TOTP desteği kapsam dışı; üçüncü parti içe aktarımdaki TOTP alanları
  şifreli özel alana yazılıyor.

## Doğrulama

`679 passed` + `114 subtests`, güvenlik lint temiz.


---

## [2.7.0-beta.4] - 2026-10-09

### Eklendi

- **Üçüncü parti içe aktarma.** Bitwarden, LastPass, Chrome, Firefox,
- **Etiketler.** Kayıt başına 20 etikete kadar. Etiketler `category` ile aynı
- **Özel alanlar.** Kayıt başına 30 alana kadar; her alan ayrıca "gizli"
- **Etiket filtresi.** Çubuk üzerinden çoklu etiket seçimi; kart rozetlerine
- **Arama alanı seçici.** Arama kutusunun solunda alan seçici: Tümü, Başlık,
- **Kayıt sıralaması.** Yedi seçenek (son değiştirilme, eklenme, başlık A-Z
- **Toplu düzenleme.** Seçili kayıtlara topluca favori ekleme/çıkarma, etiket
- **Pano otomatik temizleme.** Ayarlanabilir süre (10–600 sn), varsayılan
- **Klavye kısayolları.** Arama (`Ctrl/Cmd+K`), yeni kayıt (`Ctrl/Cmd+Shift+N`),
- **Kart banka markası.** Visa, Mastercard, Amex, Troy, UnionPay, JCB, Diners,
- **Kartlarda tarih.** Son kullanma (`AA/YYYY`) ve son değiştirilme
- **Modal klavye erişimi.** Tüm modallarda odak döngüsü (focus trap) ve açılışta
- **Kayıt eki (attachment).** Kayda 2 MB'a kadar tek dosya eklenebiliyor. Ek
- **Kart ağı işaretleri.** Visa, Mastercard, Amex ve diğer ağlar için logo
- **Düşük güç modunda opak yedek.** Tasarruf moduna girince panellerin buğusu

### Değiştirildi

- Electron 44.5.1 → 44.7.0 (Chromium sürümü değişmedi; yalnızca Node/V8
- Modallarda klavye ile gezinme ve odak sırası standartlaştırıldı.

### Düzeltildi

- **`.json` ve `.txt` içe aktarımı hata veriyordu.** Kayıtlar eklendikten ve
- **Normal arka plan modlarında cam yarı saydam görünüyordu.** Perde katmanı
- **Tasarruf (düşük güç) modu camın arka planını siliyordu.** 45 saniye hareketsizlik
- **Giriş ekranı da tasarruf moduna giriyordu.** `login.html` ana iskeleti
- **Kart bankası listesi yanlış markaları listeliyordu.** Liste web sitesi
- **Toplu etiket ekleme, eklediği etiketi aynı adımda siliyordu.**
- **Türkçe büyük/küçük harf katlaması.** `İş` ile `iş` farklı etiket olarak
- **Kartlar hiç renderlanmıyordu.** Etiket filtresi eklendiğinden beri
- **Arama ve sıralama seçicileri çubuktan modal'a taşındı.** 1200×800'de iki
- **Görünüm seçenekleri düğmesinde cam efekti yoktu.** Yanındaki yüzeyler
- **Modal içindeki açılır menüler çok küçük açılıyordu.** Menüyü kırpma

### Güvenlik

- Etiketler ve özel alan değerleri **şifreli** saklanıyor; ayrı bir tablo
- Kart banka markası beyaz listeden geçiyor; ham kullanıcı girdisi hiçbir
- Toplu düzenleme parolayı, kayıt türünü ve şifreli özel alanları
- Pano otomatik temizleme ayarı yalnız yerel oturumdan değiştirilebiliyor ve
- Tüm bulunan güvenlik açıkları kapatıldı. (semgrep kullanıldı)
- 15 adet yüksek, 8 adet orta, 7 adet düşük seviyeli güvenlik açığı kapatıldı, toplam: 30~ (Bu güvenlik açıklarının çoğu "kullanıcı güvenliği" değil, sessiz veri kaybıydı)
- 1 Sertleştirme yapıldı
- 4 Test hatası düzeltildi
- 4 Yanlış dokümantasyon hükmü düzeltildi
- 1 Ölü özellik canlandırıldı (ekran yakalama)
- 1 Build kırılması düzeltildi
- LAN moduna olan güvenlik büyük ölçüde arttırıldı, yetki seviyesi düşürüldü.
- Yayın notlarına doğrulanabilir bütünlük bilgisi(hash) ekle: kullanılan algoritmayı ve ilgili dosya/kurulum paketi hash değerlerini açıkça belirt. - Yapılacak
- Etiketler ve özel alan değerleri **şifreli** saklanıyor; ayrı bir tablo
- Kart banka markası beyaz listeden geçiyor; ham kullanıcı girdisi hiçbir
- Toplu düzenleme parolayı, kayıt türünü ve şifreli özel alanları
- Pano otomatik temizleme ayarı yalnız yerel oturumdan değiştirilebiliyor ve
- Tüm bulunan güvenlik açıkları kapatıldı. (semgrep kullanıldı)
- 15 adet yüksek, 8 adet orta, 7 adet düşük seviyeli güvenlik açığı kapatıldı, toplam: 30~ (Bu güvenlik açıklarının çoğu "kullanıcı güvenliği" değil, sessiz veri kaybıydı)
- 1 Sertleştirme yapıldı
- 4 Test hatası düzeltildi
- 4 Yanlış dokümantasyon hükmü düzeltildi
- 1 Ölü özellik canlandırıldı (ekran yakalama)
- 1 Build kırılması düzeltildi
- LAN moduna olan güvenlik büyük ölçüde arttırıldı, yetki seviyesi düşürüldü.
- Yayın notlarına doğrulanabilir bütünlük bilgisi(hash) ekle: kullanılan algoritmayı ve ilgili dosya/kurulum paketi hash değerlerini açıkça belirt. - Yapılacak

### Performans ve depolama

- Minification kararını ölçüme dayalı ver: işlevselliği değiştirmeden paket boyutunu ve yükleme süresini azalt. Kaynak kodun okunabilirliğini korumak için minify edilmiş çıktıyı yalnızca dağıtım paketinde kullan ve source map gereksinimini değerlendir. - Yapılacak

### Görsel

- Glass efekti kapalıyken "bazı elemenlerin" bozuk ve saydam olması düzeltildi.

### Parola üretici

- Oluşturulan şifrenin Frontende gösterilmemesi bugu çözüldü

### Giriş ve yükleme ekranı

- Yeni tasarım

### Ayarlar

- Bazı ayar komboları diğer ayarları devre dışı bırakabiliyor, bunlara ek bilgilendirme eklendi ve görsel olarak revize edildi

### Dokümantasyon

- README dosyasını güncelle; yeni ekran görüntüleri ve yeni özellikler tanıtılsın; 2.7.0 sürümünden sonra yalnızca hata düzeltmeleri ve küçük bakım güncellemelerinin geleceği vurgulansın. - Yapılacak
- Üçüncü parti dosyasını güncelle; gerekli lisans/attribution bilgilerini eksiksiz ve güncel tut. - Yapılacak

### Geliştirici araçları

- glass-preview.html dosyası çalışır hale getirildi, yeni özellikler eklendi (Not: Bu sadece glass efektlerini test etmek içindir, bugları olabilir)

### Genel

- Genel kod temizliği yapıldı. --- Hata düzeltmeleri, ölü kod temizliği, DRY + Performans.
- Kurulum akışındaki bilgilendirme geliştirildi.
- Kurulum sırasında ortaya çıkabilecek "edge-case" korumaları eklendi.
- Electron versiyonu 44.5.1'e yükseltildi
- Forge 8.0.1'e yükseltildi
- @electron/fuses 2.1.3'e yükseltildi

---

## [2.7.0-beta.3] - 2026-09-13

### Eklendi

- Her sayfadan erişilebilen yuvarlatılmış (pill) navigasyon çubuğu ve bildirim menüsü.
- Gizlilik politikası: **Ayarlar > Veri ve Yedekleme**.
- Varsayılan olarak kapalı deneysel buz (BUZ) efekti.
- Beta aşamasında internet erişimi kill switch'i ve veritabanı kontrolü ayarları.
- Şifre sağlığı araçları: kayıtları birleştirme, zayıf parolaları listeleme, yedek alma, `.txt` raporu oluşturma, satır arama ve filtreleme.
- Sızdırılmış parola veritabanlarına dayalı canlı parola taraması.
- Daha güvenli `.kasaenc` dışa aktarma biçimi. Dosya, dışa aktarma sırasında belirlenen parola ile açılabilir; eski `.kasa` içe/dışa aktarma uzantısı kaldırıldı.
- Otomatik parola yedekleme ve yedekleme aralığı ayarı.
- `src/main/startup-timing.js`: `SIFREKASAM_BENCH=1` veya `--bench` ile başlangıç ölçümü. Sonuç `%APPDATA%\ŞifreKasam\startup-bench.json` dosyasına yazılır; normal çalışmada ek yük oluşturmaz.
- `src/main/cache-hygiene.js`: 8 MB eşiğini aşan GPUCache, DawnGraphiteCache, DawnWebGPUCache, GrShaderCache ve Code Cache dizinlerini başlangıçtan 8 saniye sonra temizleme. Service Worker CacheStorage temizlenmez.
- Backend bütünlük manifesti ve imza üretimi: `build-backend.js`, derleme sonrasında tüm dosyaların SHA-256 listesini içeren `backend_integrity.json` dosyasını ve özel Ed25519 anahtarıyla imzalanan `backend_integrity.sig.json` dosyasını üretir. Anahtar `SIFREKASAM_SIGN_KEY_PATH` veya repo dışındaki `~/.sifrekasam/sign_key.pem` konumundan alınır.

### Değiştirildi

- Ana sayfa ve kasa kartları, ayarlar, kayıt ekleme/düzenleme, şifre oluşturucu, şifre sağlığı, modallar ve bildirim panellerinin tasarım ve animasyonları yenilendi; cam efektleri güncellendi.
- Uygulamanın bölümleri daha kolay yönetilmesi için küçük modüllere ayrıldı.
- Özel arka plan sayfa değişimlerinde yeniden yüklenmiyor; ayarlardaki özel arka plan seçeneği farklı bir bölüme taşındı.
- İlk kurulumda dil, tema ve renk seçenekleri yapılandırılabiliyor.
- LAN modu tasarım ve güvenlik iyileştirmeleri aldı.
- Flask backend pencere oluşturulmasıyla paralel başlatılıyor.
- `forge.config.js` paketleme hariç tutma listesi genişletildi. Dokümantasyon amaçlı altı PNG `assets/` yerine `docs/screenshots/` dizinine taşındı; README bağlantıları güncellendi. Pakette yalnızca çalışma zamanı varlıkları (`tray-icon.png`, `installer-loading.gif`) tutuluyor.
- `electron-squirrel-startup` kaldırıldı; ASAR'da yalnızca çalışma zamanı bağımlılığı olan `tree-kill` kaldı. `THIRD_PARTY_NOTICES` güncellendi.
- Kullanılmayan `numpy` (19.5 MB OpenBLAS) ve `PIL._avif` (7.5 MB) `app.spec` paketlemesinden çıkarıldı.
- `forge.config.js` içindeki `postPackage` kancası 55 Chromium locale `.pak` dosyasını yalnızca `en-US`, `en-GB` ve `tr` kalacak şekilde buduyor (46.5 MB azalma). Eksik locale için Electron `en-US` diline döner.
- Chromium HTTP önbelleği `--disk-cache-size=32MB` ile sınırlandı; ayarın paketli uygulamada etkin olduğu doğrulandı.
- Bağımlılıklar güncellendi:
	- Cryptography: `49.0.0` → `50.0.1`
	- PyInstaller: `6.21.0` → `6.22.2`
	- Electron: `43.2.0` → `44.3.0` → `44.4.5` (Chromium: `150.0.7871.129` → `152.0.7977.78` → `152.0.7977.130`; Node.js: `24.17.0` → `24.20.0`; 32 bit desteği kaldırıldı)
	- `@electron-forge/cli`, `maker-squirrel` ve `maker-zip`: `7.4.0` → `7.11.2`
	- `@reforged/maker-appimage`: `5.2.0` → `5.3.1`

### Düzeltildi

- Önceki sürümlerden kalan ve beta.3 geliştirilirken ortaya çıkan çok sayıda hata giderildi.
- Kayıt ekleme ve düzenleme akışındaki hatalar düzeltildi; kullanılabilirlik iyileştirmeleri yapıldı.
- Kaydedilmemiş değişiklik göstergesi ve ilgili buton animasyonu eklendi.
- LAN moduna özgü tasarım ve işleyiş hataları giderildi.

### Performans ve depolama

- Yükleme süreleri düşürüldü. Ölçümler (150 kayıtlı kasa, gerçek HTTPS, sıcak önbellek): **GET /** 1009 → 61 ms, **/ekle** 124 → 17 ms, **/saglik** 248 → 34 ms. Giriş doğrulaması yaklaşık 350 ms sürer (PBKDF2 600k + scrypt; güvenlik nedeniyle korunmuştur).
- Paketli uygulamada pencerenin görünme süresi **2568 → ~985 ms**, ilk ekranın (giriş) açılma süresi **3387 → ~3066 ms**; sıcak önbellekte ilk ekran yaklaşık **2081 ms** (`SIFREKASAM_BENCH`).
- Paket boyutları: uygulama klasörü ~413 → **366.2 MB**, ZIP 242.45 → **161.7 MB**, kurulum dosyası 236.07 → **157.6 MB**, NUPKG **156.8 MB**. Temiz kurulum toplamı ~620 → **~560 MB**; `app.asar` 140 MB → **393 KB**.
- Önbellek temizleme testi: 12 MB'lık GPU önbelleği silindi, eşik altındaki dizinler korundu.

### Güvenlik

- `src/main/integrity.js` imza ve hash doğrulaması yapar. Manifest varsa imza zorunludur. Kritik backend dosyaları (EXE, `python312.dll`, `_ssl`, `libssl`/`libcrypto`, `_rust.pyd`) başlatma öncesinde eşzamanlı doğrulanır; tam dosya ağacı arka planda denetlenir. Uyumsuzlukta süreç durdurulur ve kullanıcı uyarılır. Manifestin bulunmaması geliştirme paketlerinde kabul edilir.
- Uçtan uca testte, paketli uygulamadaki `_ssl.pyd` dosyası değiştirildiğinde backend'in başlatılmadığı doğrulandı.
## Doğrulama — SHA-256

Paketler **`SHA-256`** ile doğrulanır. Komut satırında:

```bash
sha256sum -c SHA256SUMS.txt
```

PowerShell:

```powershell
Get-FileHash <dosya> -Algorithm SHA256
```

| Dosya | Boyut | SHA-256 |
|---|---|---|
| `SifreKasam-2.7.0-beta.4-Setup.exe` | 158.9 MB | `d7c8136a830f5dd8e6c9f3f7aeaa295a…` |
| `SifreKasam-2.7.0-beta.4-portable.zip` | 163.1 MB | `3370ee8c9549d91724940ef00144e7a4…` |
| `SifreKasam-2.7.0-beta.4-full.nupkg` | 158.2 MB | `db759779d957e6cd6435e54f1eb2a4eb…` |

Tam değerler:

`d7c8136a830f5dd8e6c9f3f7aeaa295ad5afb354259e4f38ff37cf3c2a09f4db`

`3370ee8c9549d91724940ef00144e7a40ce3f35c5ade130aa42defdabea84dcf`

`db759779d957e6cd6435e54f1eb2a4eb53df0499374e902dbfa58d7ae5788154`

`SHA256SUMS.txt` bu release'a eklendi; indirdiğiniz dosyaları onunla
karşılaştırabilirsiniz.

### Ek bütünlük

`backend/` içindeki Python çalışma zamanı ayrıca imzalanır: derleme sonrası
tüm dosyaların SHA-256 listesi `backend_integrity.json` içine, bu liste
özel bir Ed25519 anahtarıyla `backend_integrity.sig.json` içine yazılır. Uygulama
başlarken imzayı doğrular — manifest yoksa geliştirme paketleri kabul edilir,
paketli sürümlerde imza zorunludur.
