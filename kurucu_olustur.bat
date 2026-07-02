@echo off
setlocal enabledelayedexpansion

title SifreKasam - Kurucu Derleme Araci
color 0A

echo ======================================================
echo          KASA - KURUCU OLUSTURMA ARACI
echo ======================================================
echo.

:: 1. Backend kontrolu
if not exist "backend\SifreKasam.exe" (
    color 0C
    echo [!] HATA: backend\SifreKasam.exe bulunamadi.
    echo Lutfen once 'baslat.bat' calistirarak backend uygulamasini derleyin.
    echo Veya 'baslat.bat' icinde hata alip almadiginizi kontrol edin.
    pause
    exit /b 1
)

:: 2. Eski Build Temizligi (Daha temiz bir derleme icin)
echo [*] Eski derleme artikalari temizleniyor...
if exist "out" (
    rmdir /s /q "out"
)

:: 3. Electron Forge Islemi
echo [*] Electron Forge 'make' islemi baslatiliyor...
echo [!] Lutfen bekleyin, bu islem bilgisayar hizina bagli olarak birkac dakika surebilir.
echo ------------------------------------------------------
echo.

call npm run make

:: 4. Sonuc Kontrolu
if !errorlevel! neq 0 (
    color 0C
    echo.
    echo ======================================================
    echo [!] HATA: Kurucu olusturulurken bir sorun olustu.
    echo Electron Forge kisminda bir bagimlilik hatasi olabilir.
    echo ======================================================
    pause
    exit /b 1
)

color 0A
echo.
echo ======================================================
echo [OK] KURUCU BASARIYLA OLUSTURULDU!
echo.
echo Kurucu dosyanizi (Setup.exe) su klasorde bulabilirsiniz:
echo %cd%\out\make\squirrel.windows\x64\
echo.
echo Klasor aciliyor...
explorer "%cd%\out\make\squirrel.windows\x64"
echo ======================================================
echo.
pause
