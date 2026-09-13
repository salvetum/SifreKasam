# Gizlilik Politikası

**ŞifreKasam** — By Salvetum
Son güncelleme: 2 Eylül 2026

Bu politika, ŞifreKasam uygulamasının (bundan sonra "uygulama") hangi verileri
nasıl işlediğini, nelerin cihazınızdan asla çıkmadığını ve hangi durumlarda
dış servislere minimum düzeyde veri aktarıldığını açıklar.

## 1. Genel bakış

Uygulama **çevrimdışı öncelikli** bir şifre yöneticisidir. Asıl amacı, kasa
verilerinizin (parolalar, kullanıcı adları, notlar ve diğer kayıtlar) büyük
çoğunluğunun **cihazınızda, şifreli ve yerel** kalmasıdır.

- Varsayılan olarak hiçbir otomatik ağ isteği yapılmaz.
- Hiçbir telemetri, analiz, izleme veya reklam bileşeni yoktur.
- Kasa verileriniz üçüncü taraflarla **asla paylaşılmaz ve satılmaz**.

## 2. Yerel saklama ve şifreleme

- Tüm kasa kayıtlarınız uygulamanın veri klasöründe tutulur ve
  cihazda şifreli saklanır (Fernet simetrik şifreleme).
- Kasa şifreleme anahtarı, sizden **asla** çıkmaz; ana şifrenizden
  PBKDF2 ile türetilir ve yalnızca oturum süresince bellekte tutulur.
- Ana şifreniz doğrudan saklanmaz; yalnızca doğrulama amaçlı güvenli
  türevleri kullanılır.
- Uygulama kullanıcı verisi toplamaz; verileriniz cihazınızdadır.

## 3. Otomatik kilitleme ve oturum

- İsteğe bağlı otomatik kilitleme ve ekran süresi boyunca kasa şifreleme
  anahtarı yalnızca oturum içinde tutulur; kilitlenen kasaya yeniden
  ana şifre olmadan erişilmez.

## 4. Canlı sızıntı taraması (HaveIBeenPwned)

Bu özellik **varsayılan olarak kapalıdır** ve Ayarlar'dan açılır. Açıldığında:

- Şifrelerinizin HaveIBeenPwned (HIBP) veritabanında bilinen bir sızıntıda
  görünüp görünmediği kontrol edilir.
- Güvenlik için **şifrenizin tamamı asla gönderilmez**. Yalnızca şifrenizin
  SHA-1 parmak izinin ilk **5 karakteri** (k-anonimlik) HIBP sunucusuna
  gönderilir. Eşleşen son ekler sunucudan döner ve tam eşleşme karşılaştırması
  **tamamen cihazınızda** yapılır.
- Başlık, kullanıcı adı, e-posta veya şifre bu süreçte ağa gönderilmez.
- HIBP'dan alınan önek–sonek eşleşmeleri yerel önbellekte geçici olarak
  tutulur; bu önbellek düz şifre içermez.
- İnternet Kill-Switch açıkken bu özellik hiçbir istek göndermez.

## 5. Güncelleme kontrolü

- Uygulama, yeni sürümleri denetlemek için **GitHub Releases** uç noktasına
  bağlanabilir. Bu istek sırasında IP adresiniz ve istek meta verileriniz,
  GitHub tarafından standart erişim günlüklerinde işlenebilir; herhangi bir
  kasa verisi bu istekle gönderilmez.
- Bu kontrol devre dışı bırakılmak istenirse İnternet Kill-Switch ayarı
  kullanılabilir.

## 6. LAN erişimi (isteğe bağlı)

- LAN modu açıkken uygulama yerel ağınızda şifreli bir giriş ekranı sunar.
  Veriler üzerinde değil, yalnızca kimlik doğrulama üzerinde etkilidir;
  kasa verileri yine cihazda şifreli kalır.

## 7. Yedekleme ve dışa aktarma

- Dışa aktardığınız veya yedeklediğiniz dosyalar **şifresiz (düz metin)
  içerebilir**. Bu dosyaların güvenli saklanması sizin sorumluluğunuzdadır.
- Uygulamayı kaldırdığınızda veya veri klasörünü sildiğinizde kasa verileriniz
  kalıcı olarak silinir; uygulama kasa verilerinizi başka bir sunucuda
  tutmaz.

## 8. Çerezler ve yerel tercihler

- Web arayüzü, oturum yönetimi ve güvenlik için çerez ve yerel depolama
  kullanabilir. Arayüz tercihleri (tema, dil, düzen) cihazınızda saklanır.

## 9. Veri sahipliği ve haklarınız

- Verilerinizin sahibi sizsiniz. Tüm verilerinizi **İçe/Dışa Aktar**
  özellikleriyle cihazınızdan dışa alabilir ve üçüncü taraflarla paylaşmadan
  kendi kontrolünüzde tutabilirsiniz.
- Dışa aktarma veya geri alma işlemleri Ayarlar → Veri ve Yedekleme
  bölümünde bulunur.

## 10. İletişim

Sorular ve talepler için projenin GitHub sayfasındaki hata/özellik takip
sistemini kullanabilirsiniz. ŞifreKasam, "By Salvetum" tarafından yayınlanır
ve GitHub Releases üzerinden dağıtılır.

## 11. Politika değişiklikleri

Bu politika, uygulamanın yetenekleri değiştikçe güncellenebilir; geçerlilik
tarihi bu belgenin başında yer alır.