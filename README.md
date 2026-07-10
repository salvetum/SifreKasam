<div align="center">

<img src="favicon.ico" width="128" height="128" alt="ŞifreKasam Logo">

# ŞifreKasam

**Yerel, açık kaynaklı masaüstü şifre yöneticisi**

Verilerinizi cihazınızda tutun ve ana şifrenizle şifreleyin.

<br>

[![Türkçe](https://img.shields.io/badge/README-Türkçe-1f6feb?style=for-the-badge)](README.md)
[![English](https://img.shields.io/badge/README-English-1f6feb?style=for-the-badge)](README_EN.md)

<br>

[![Son Sürüm](https://img.shields.io/github/v/release/salvetum/SifreKasam?style=flat-square&label=Son%20Sürüm)](https://github.com/salvetum/SifreKasam/releases/latest)
[![İndirme](https://img.shields.io/github/downloads/salvetum/SifreKasam/total?style=flat-square&label=İndirme)](https://github.com/salvetum/SifreKasam/releases)
[![Lisans](https://img.shields.io/github/license/salvetum/SifreKasam?style=flat-square&label=Lisans)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D4?style=flat-square)](https://github.com/salvetum/SifreKasam/releases/latest)

<br>

[⬇️ Son Sürümü İndir](https://github.com/salvetum/SifreKasam/releases/latest)
&nbsp;•&nbsp;
[🐛 Hata Bildir](https://github.com/salvetum/SifreKasam/issues)

</div>

---

## ŞifreKasam Nedir?

**ŞifreKasam**, yerel çalışan bir masaüstü şifre yöneticisidir. Veriler cihazda tutulur, ana şifreyle şifrelenir ve uygulama Electron ile Flask tabanlı bir masaüstü paket olarak çalışır.

> Bu proje, yapay zekâ destekli geliştirme ve *vibe coding* sürecini deneyimlemek amacıyla başlatılmıştır.

## İndirme Kaynağı ve Güvenlik Uyarısı

Bu yazılımın resmî ve güvenilir dağıtımları yalnızca aşağıdaki bağlantı üzerinden yayımlanmaktadır:

**https://github.com/salvetum/SifreKasam**

Bu bağlantı dışında bulunan üçüncü taraf sitelerden, dosya paylaşım platformlarından, yeniden yüklenmiş paketlerden veya değiştirilmiş sürümlerden indirilen dosyaların güvenliği, bütünlüğü ve güncelliği garanti edilmez.

Resmî kaynak dışında indirilen sürümlerde oluşabilecek veri kaybı, zararlı yazılım, hesap güvenliği sorunları, sistem arızaları veya diğer zararlardan proje geliştiricisi sorumlu değildir.

İndirme yapmadan önce bağlantının resmî kaynağa ait olduğunu kontrol etmeniz önerilir.


## Özellikler

- Yerel veritabanı ve ana şifre ile şifreleme
- Kayıt ekleme, düzenleme, silme ve favorileme
- Şifre oluşturucu ve şifre sağlığı ekranı
- Türkçe / İngilizce dil desteği
- Koyu ve açık tema, glass efektleri, vurgu rengi ve arkaplan ayarları
- İçe/dışa aktarma, trayde çalışmaya devam etme ve otomatik kilitleme seçenekleri
- Github üzerinden versiyon kontrolü

## Güvenlik Notları

- Bu proje kişisel kullanım için geliştirilmiştir; ticari veya yüksek riskli kullanım için bağımsız güvenlik denetiminden geçmemiştir.
- Ana şifrenizi unutursanız kayıtları kurtarmak mümkün olmayabilir.
- LAN erişimi geliştirme/kolay bağlantı amaçlıdır ve güvenlik riski taşır. Güvenmediğiniz ağlarda kapalı tutun.
- Repo’ya gerçek veritabanı, yedek, sertifika, anahtar veya kişisel kayıt dosyası yüklemeyin.

## Geliştirme

Gereksinimler:

- Node.js / npm
- Python
- PyInstaller

Kurulum:

```bash
npm install
```

Geliştirme sırasında Electron uygulamasını başlatmak için:

```bash
npm start
```

Windows paket çıktısı almak için:

```bash
npm run package
```

Flask backend tek başına paketlenecekse `flask_app` klasöründe:

```bash
pyinstaller app.spec --clean -y
```

## Repo’ya Dahil Edilmeyenler

Aşağıdaki dosyalar bilinçli olarak Git dışında tutulur:

- `node_modules/`
- `backend/`
- `out/`
- `flask_app/build/`
- `flask_app/dist/`
- `flask_app/*.db`
- sertifika, anahtar, yedek ve geçici dosyalar

## Lisans

MIT lisansı ile yayınlanır. Detaylar için `LICENSE` dosyasına bakın.
