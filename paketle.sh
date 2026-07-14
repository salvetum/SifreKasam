#!/bin/bash
set -e

echo "==================================================="
echo "  KASA - Linux Paketleme ve Başlatma Aracı"
echo "==================================================="
echo ""

# 1. Sanal Ortam Kontrolü
if [ -d "venv" ]; then
    echo "[*] Sanal ortam bulundu, aktif ediliyor..."
    source venv/bin/activate
else
    echo "[!] Sanal ortam (venv) bulunamadı. Global paketler kullanılacak."
fi

# 2. Python Bağımlılıkları
echo "[*] Python bağımlılıkları kontrol ediliyor..."
pip install -r flask_app/requirements.txt -q 2>/dev/null || {
    echo "[HATA] pip install başarısız!"
    exit 1
}

# 3. Node Modules Kontrolü
if [ ! -d "node_modules" ]; then
    echo "[!] node_modules bulunamadı! npm install çalıştırılıyor..."
    npm install || {
        echo "[HATA] npm install başarısız oldu."
        exit 1
    }
fi

# 4. Python Backend Derlemesi
echo ""
echo "[1/3] Python arka planı (Flask) derleniyor..."
cd flask_app

pyinstaller app.spec --clean -y 2>&1 || {
    echo "[UYARI] Derleme başarısız, yeniden deneniyor..."
    pip install -r requirements.txt -q
    pyinstaller app.spec --clean -y 2>&1 || {
        echo "[HATA] Derleme başarısız oldu!"
        exit 1
    }
}

echo "[OK] Backend başarıyla derlendi."
cd ..

# 5. Backend Taşınması
echo ""
echo "[2/3] Derlenen dosyalar ana dizine taşınıyor..."
rm -rf backend
mv flask_app/dist/SifreKasam backend
echo "[OK] Dosyalar taşındı."

# 6. AppImage Paketleme
echo ""
echo "[3/3] AppImage paketi oluşturuluyor..."
echo "---------------------------------------------------"
npm run make

echo ""
echo "==================================================="
echo "[OK] AppImage başarıyla oluşturuldu!"
echo "Dosyalar: out/make/ içinde"
echo "==================================================="
