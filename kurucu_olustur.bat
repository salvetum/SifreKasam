@echo off
setlocal
chcp 65001 >nul

title SifreKasam - Kurucu Olusturma
color 0B

pushd "%~dp0" >nul 2>&1
if errorlevel 1 (
    color 0C
    echo [HATA] Proje klasorune gecilemedi.
    pause
    exit /b 1
)

echo ======================================================
echo          SIFREKASAM - KURUCU OLUSTURMA
echo ======================================================
echo.

if exist "venv\Scripts\activate.bat" (
    echo [1/4] Sanal ortam etkinlestiriliyor...
    call "venv\Scripts\activate.bat"
) else (
    echo [1/4] Sanal ortam bulunamadi; sistem Python'u kullanilacak.
)

where python >nul 2>&1
if errorlevel 1 (
    color 0C
    echo [HATA] Python bulunamadi. Backend derlenemez.
    goto :fail
)

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

where node >nul 2>&1
if errorlevel 1 (
    color 0C
    echo [HATA] Node.js bulunamadi. Once Node.js kurun.
    goto :fail
)

where npm >nul 2>&1
if errorlevel 1 (
    color 0C
    echo [HATA] npm bulunamadi. Node.js kurulumunu kontrol edin.
    goto :fail
)

if not exist "node_modules\" (
    echo [2/4] Node bagimliliklari kuruluyor...
    call npm ci
    if errorlevel 1 (
        color 0C
        echo [HATA] npm ci islemi basarisiz oldu.
        goto :fail
    )
) else (
    echo [2/4] Node bagimliliklari hazir.
)

echo [3/4] Eski Electron ciktilari temizleniyor...
set "KASA_PROJECT_ROOT=%CD%"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$root = [IO.Path]::GetFullPath($env:KASA_PROJECT_ROOT);" ^
    "$target = [IO.Path]::GetFullPath((Join-Path $root 'out'));" ^
    "if (-not $target.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Guvenli olmayan temizleme hedefi.' };" ^
    "if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }"
if errorlevel 1 (
    color 0C
    echo [HATA] Eski ciktilar guvenli sekilde temizlenemedi.
    goto :fail
)

echo [4/4] Backend ve Electron kurucusu olusturuluyor...
echo Bu islem birkac dakika surebilir.
echo ------------------------------------------------------
call npm run make
if errorlevel 1 (
    color 0C
    echo.
    echo [HATA] Kurucu olusturulamadi. Yukaridaki hata mesajini kontrol edin.
    goto :fail
)

set "SETUP_PATH=%CD%\out\make\squirrel.windows\x64\SifreKasamSetup.exe"
if not exist "%SETUP_PATH%" (
    color 0C
    echo [HATA] Derleme tamamlandi ancak SifreKasamSetup.exe bulunamadi.
    goto :fail
)

color 0A
echo.
echo ======================================================
echo [OK] Kurucu basariyla olusturuldu.
echo %SETUP_PATH%
echo ======================================================
start "" explorer "%CD%\out\make\squirrel.windows\x64"
popd
pause
exit /b 0

:fail
popd
pause
exit /b 1
