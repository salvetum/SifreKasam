# Değişiklik Günlüğü

## 2.6.0

### Güvenlik
- Content-Security-Policy'den `unsafe-inline` kaldırıldı, script ve style için per-request nonce sistemine geçildi
- Tüm inline `style=""` kullanımları CSS class'larına veya güvenli nonce'lu runtime style injection'a taşındı
- `app.py` modüler hale getirildi (`kasa_core/` paketi), kod tabanı daha okunabilir ve test edilebilir hale geldi
- Veri dizini izinleri ve CSP regresyonlarını yakalayan yeni otomatik testler eklendi

### Linux Desteği (YENİ)
- Uygulama artık Linux'ta (Ubuntu/WSL dahil) çalışıyor — önceki sürümlerde birkaç platforma özgü sorun nedeniyle hiç açılmıyordu
- Sistem tepsisi ikonu artık Linux'ta doğru yükleniyor (Windows'a özgü .ico formatı yerine PNG kullanılıyor)
- Geliştirme modunda (`npm start`) Python komutu artık platforma göre doğru seçiliyor (`python3` / `python`)
- Backend derleme script'i artık Linux/macOS'ta doğru çalıştırılabilir dosya adını arıyor
- AppImage ve zip formatında Linux build'i eklendi

### Arayuz
- Acik (light) temada giris ekraninin sol ust kosumesindeki metinler (guvenlik rozeti, dil secici) artik okunabilir — onceki surumde neredeyse gorunmez beyaz ustune beyaz render oluyordu
- Filtreleme butonlarindaki ikonlar artik sistem emoji fontuna bagimli degil, projeye gomulu Font Awesome ikonlarina gecirildi (bazi Linux kurulumlarinda emoji fontu eksik oldugu icin ikonlar gorunmuyordu)
- "Toplu Sec" butonu artik filtre ve secim kontrolleriyle ayni satirda, daha tutarli bir yerlesimde
- 3 ayri CSS framework'u (Bootstrap, Tailwind subset, custom design sistemi) 2'ye indirildi, Bootstrap'in kullanilmayan ~228KB'lik yuku kaldirildi

### Kararlilik
- Sistemde kayitli bir varsayilan tarayici olmadiginda (veya harici link acma basarisiz oldugunda) uygulamanin artik cokmemesi saglandi
- Uygulama baslangicindaki gri ekran flashi giderildi (pencere artik icerik boyanana kadar gosterilmiyor)
- Backend baslatma zamani asimi artirildi, yavas makinalarda/antivirus taramasinda erken "baslatilamadi" hatasi verilmesi engellendi

## 2.5.11

- Dil düzeltmesi

## 2.5.10

- Bootstrap bağımlılığı kaldırıldı

## 2.5.9

- Güvenlik ve UI iyileştirmeleri

## 2.5.8

- İlk kararlı sürümlerden biri
