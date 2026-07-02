# ŞifreKasam

ŞifreKasam, yerel çalışan masaüstü şifre yöneticisidir. Veriler cihazda tutulur, ana şifreyle şifrelenir ve uygulama Electron + Flask tabanlı bir masaüstü paket olarak çalışır.
vibecoding ile yapılmıştır.

## Özellikler

- Yerel veritabanı ve ana şifre ile şifreleme
- Kayıt ekleme, düzenleme, silme ve favorileme
- Şifre oluşturucu ve şifre sağlığı ekranı
- Türkçe/İngilizce dil desteği
- Koyu/açık tema, glass efektleri, vurgu rengi ve arkaplan ayarları
- İçe/dışa aktarma ve otomatik kilitleme seçenekleri

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
