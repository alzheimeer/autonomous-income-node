@echo off
:: ============================================================
:: ain-startup.bat — Auto-arranque de contenedores AIN
:: Se ejecuta al iniciar sesion via HKCU\Run
:: Espera 60s para que Docker Desktop termine de iniciar
:: ============================================================
timeout /t 60 /nobreak >nul 2>&1

:: Verificar que Docker este disponible
docker info >nul 2>&1
if %errorlevel% neq 0 (
    :: Docker no esta listo, esperar 30s mas
    timeout /t 30 /nobreak >nul 2>&1
    docker info >nul 2>&1
    if %errorlevel% neq 0 (
        :: Ultimo intento
        timeout /t 30 /nobreak >nul 2>&1
    )
)

:: Arrancar todos los contenedores AIN
cd /d "C:\Users\fogni\OneDrive\Escritorio\proyecto1a\autonomous-income-node"
docker compose up -d >nul 2>&1

exit /b 0
