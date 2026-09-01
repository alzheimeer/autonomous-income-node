@echo off
REM ============================================================
REM Script para exponer el puerto 3001 (servicios x402) a internet
REM usando ngrok (gratuito, sin cuenta requerida para prueba básica)
REM ============================================================

echo [Tunnel] Verificando ngrok...

where ngrok >nul 2>&1
if %errorlevel% neq 0 (
    echo [Tunnel] ngrok no encontrado. Descargando...
    echo.
    echo Por favor descarga ngrok manualmente:
    echo 1. Ve a https://ngrok.com/download
    echo 2. Descarga la version Windows
    echo 3. Extrae ngrok.exe a C:\Users\fogni\
    echo 4. Ejecuta este script de nuevo
    echo.
    echo Alternativa: usa Cloudflare Tunnel
    echo   1. Descarga cloudflared de https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
    echo   2. Ejecuta: cloudflared tunnel --url http://localhost:3001
    pause
    exit /b 1
)

echo [Tunnel] Iniciando tunnel en puerto 3001...
echo [Tunnel] El agente recibira pagos x402 desde internet
echo [Tunnel] Copia la URL publica que aparece abajo y guardala en .env como TUNNEL_URL
echo.

ngrok http 3001 --log=stdout
