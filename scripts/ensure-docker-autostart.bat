@echo off
:: ============================================================
:: ensure-docker-autostart.bat
:: 
:: Configura Docker Desktop + contenedores AIN para auto-arranque
:: Ejecutar UNA VEZ como Administrador
:: ============================================================

echo [AIN] Configurando auto-arranque de Docker y contenedores...

:: 1. Configurar Docker Desktop Service para arrancar automaticamente
sc config "com.docker.service" start= auto
if %errorlevel% == 0 (
    echo [OK] Docker Desktop Service configurado como auto-arranque
) else (
    echo [WARN] No se pudo configurar el servicio ^(puede requerir admin^)
)

:: 2. Verificar que Docker Desktop esta en el registro de arranque del usuario
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "Docker Desktop" >nul 2>&1
if %errorlevel% neq 0 (
    reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "Docker Desktop" /t REG_SZ /d "\"C:\Program Files\Docker\Docker\Docker Desktop.exe\"" /f
    echo [OK] Docker Desktop agregado al arranque de usuario
) else (
    echo [OK] Docker Desktop ya esta en arranque de usuario
)

:: 3. Crear tarea programada para arrancar contenedores AIN tras iniciar sesion
:: Esta tarea espera que Docker Engine este listo antes de iniciar contenedores
schtasks /Query /TN "AIN-Docker-Autostart" >nul 2>&1
if %errorlevel% neq 0 (
    schtasks /Create /TN "AIN-Docker-Autostart" ^
        /TR "cmd /c timeout /t 30 /nobreak && cd /d \"C:\Users\fogni\OneDrive\Escritorio\proyecto1a\autonomous-income-node\" && docker compose up -d" ^
        /SC ONLOGON ^
        /DELAY 0000:30 ^
        /RL HIGHEST ^
        /F
    echo [OK] Tarea programada AIN-Docker-Autostart creada
) else (
    echo [OK] Tarea programada AIN-Docker-Autostart ya existe
)

echo.
echo [AIN] Configuracion completada.
echo       Los contenedores arrancaran automaticamente al iniciar sesion.
echo       Politica restart 'unless-stopped' garantiza re-arranque tras crashes.
echo.
pause
