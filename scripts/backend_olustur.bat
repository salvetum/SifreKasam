@echo off
setlocal
chcp 65001 >nul

title SifreKasam - Backend Olusturma
color 0B

pushd "%~dp0" >nul 2>&1
if errorlevel 1 (
    color 0C
    echo [HATA] Proje klasorune gecilemedi.
    pause
    exit /b 1
)

echo ======================================================
echo          SIFREKASAM - BACKEND OLUSTURMA
echo ======================================================
echo.

if exist "venv\Scripts\activate.bat" (
    echo [1/3] Sanal ortam etkinlestiriliyor...
    call "venv\Scripts\activate.bat"
) else (
    echo [1/3] Sanal ortam bulunamadi; sistem Python'u kullanilacak.
)

where python >nul 2>&1
if errorlevel 1 (
    color 0C
    echo [HATA] Python bulunamadi.
    goto :fail
)

where node >nul 2>&1
if errorlevel 1 (
    color 0C
    echo [HATA] Node.js bulunamadi.
    goto :fail
)

echo [2/3] Python derleme bagimliliklari kontrol ediliyor...
python -c "import PyInstaller" >nul 2>&1
if errorlevel 1 (
    echo PyInstaller bulunamadi; Python bagimliliklari kuruluyor...
    python -m pip install -r "flask_app\requirements.txt"
    if errorlevel 1 (
        color 0C
        echo [HATA] Python bagimliliklari kurulamadi.
        goto :fail
    )
)

echo [3/3] Flask backend derleniyor...
node "scripts\build-backend.js"
if errorlevel 1 (
    color 0C
    echo [HATA] Backend derlemesi basarisiz oldu.
    goto :fail
)

if not exist "backend\SifreKasam.exe" (
    color 0C
    echo [HATA] Derleme tamamlandi ancak backend\SifreKasam.exe bulunamadi.
    goto :fail
)

color 0A
echo.
echo ======================================================
echo [OK] Backend basariyla olusturuldu.
echo %CD%\backend\SifreKasam.exe
echo ======================================================
popd
pause
exit /b 0

:fail
popd
pause
exit /b 1
