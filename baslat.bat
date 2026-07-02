@echo off
setlocal enabledelayedexpansion

title SifreKasam v2.2 - Gelistirme Ortami
color 0B

echo ===================================================
echo   SIFREKASAM V2.2 - Baslatma ve Derleme Araci
echo ===================================================
echo.

:: 1. Sanal Ortam Kontrolu
if exist venv\Scripts\activate.bat (
    echo [*] Sanal ortam bulundu, aktif ediliyor...
    call venv\Scripts\activate.bat
) else (
    echo [!] Sanal ortam venv bulunamadi. Sadece global paketler kullanilacak.
)

:: 2. Node Modules Kontrolu
if not exist "node_modules" (
    echo [!] node_modules klasoru bulunamadi! 'npm install' calistiriliyor...
    call npm install
    if !errorlevel! neq 0 (
        color 0C
        echo [HATA] npm install basarisiz oldu. Node.js yuklu mu?
        pause
        exit /b 1
    )
    echo [OK] Bagimliliklar kuruldu.
)

:: 3. Python Backend Derlemesi
echo.
echo [1/3] Python arka plani (Flask) derleniyor...
cd flask_app

:: PyInstaller ile derle
call pyinstaller app.spec --clean -y >nul 2>&1

if !errorlevel! neq 0 (
    echo [UYARI] Python derlemesi basarisiz oldu. "pyinstaller" eksik olabilir.
    echo [*] Eksik paketler otomatik olarak kuruluyor, lutfen bekleyin...
    call pip install pyinstaller flask cryptography Flask-SQLAlchemy Flask-Login >nul 2>&1
    
    echo [*] Tekrar derleniyor...
    call pyinstaller app.spec --clean -y >nul 2>&1
    
    if !errorlevel! neq 0 (
        color 0C
        echo [HATA] Kurulum sonrasi derleme de basarisiz oldu!
        echo Lutfen internet baglantinizi ve Python yolunuzu kontrol edin.
        pause
        exit /b 1
    )
)

echo [OK] Backend basariyla derlendi.
cd ..

:: 4. Backend Tasinmasi
echo.
echo [2/3] Derlenen dosyalar ana dizine tasiniyor...
if exist backend (
    rmdir /s /q backend
)
move flask_app\dist\SifreKasam backend >nul
echo [OK] Dosyalar tasindi.

:: 5. Electron Baslatilmasi
echo.
echo [3/3] Electron uygulamasi baslatiliyor...
echo ---------------------------------------------------
call npm start

echo.
echo ===================================================
echo [*] Uygulama kapatildi. Iyi gunler!
echo ===================================================
echo [*] 5 saniye sonra otomatik kapanacaktir...
timeout /t 5 /nobreak
