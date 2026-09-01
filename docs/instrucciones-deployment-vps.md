# Instrucciones de Deployment — Autonomous Income Node

> Última actualización: 13 de Agosto 2026
> Setup actual: Docker Compose en PC Windows + Cloudflare Tunnel + PostgreSQL

---

## Resumen

El agente corre en Docker Compose en la PC de Mauricio (Windows 11). Se expone a internet via Cloudflare Tunnel con dominio propio `niklauss.uk`. No hay VPS externo.

**Requisitos mínimos:**
- Windows 10/11 con Docker Desktop instalado
- Node.js 24+ (para onchainos CLI y herramientas OKX)
- pnpm instalado globalmente
- Conexión a internet estable (24/7 para mantener el tunnel activo)
- Cuenta Cloudflare con dominio configurado

---

## PARTE 1: Clonar y Configurar

### 1.1 Clonar el repositorio

```bash
git clone <repo-url> autonomous-income-node
cd autonomous-income-node
pnpm install
```

### 1.2 Configurar .env

```bash
copy .env.example .env
```

Variables críticas a configurar:

```env
# Seguridad
WALLET_PASSWORD=<password-del-keystore-AES256>

# LLM
ANTHROPIC_API_KEY=sk-ant-...
LLM_MODEL=claude-sonnet-4-5
LLM_PROVIDER=anthropic

# Blockchain
RPC_PROVIDER_URL=https://base-mainnet.g.alchemy.com/v2/<tu-alchemy-key>
CHAIN_ID=8453
MOCK_ONCHAIN_IDENTITY=false
MOCK_PAYMENTS=false

# Producción
NODE_ENV=production
REACT_LOOP_INTERVAL_MS=30000

# Trading
ONEINCH_API_KEY=<tu-1inch-api-key>
MIN_PROFIT_THRESHOLD_USDC=500000

# Social
TELEGRAM_BOT_TOKEN=<tu-bot-token>
TELEGRAM_CHAT_ID=<tu-chat-id>
DISCORD_WEBHOOK_URL=<tu-webhook-url>

# OKX AI Marketplace
OKX_HEARTBEAT_ENABLED=false
OKX_AGENT_ID=6932
OKX_X402_ENABLED=true
OKX_PAY_TO_ADDRESS=0x687dd10e8240908069ee760b7a41ac2c451f6031

# Cloudflare Tunnel
CLOUDFLARE_TUNNEL_TOKEN=<tu-tunnel-token>
CF_TUNNEL_SUBDOMAIN=api.niklauss.uk
CF_TUNNEL_LOCAL_PORT=3001
```

### 1.3 Copiar el keystore

El archivo `keys/keystore.json` contiene la wallet cifrada. Nunca se sube a git.

```bash
mkdir keys
# Copiar keystore.json a la carpeta keys/
```

---

## PARTE 2: Docker Compose

### 2.1 Construir y levantar

```bash
docker compose up -d --build
```

### 2.2 Verificar que todo corre

```bash
docker compose ps
# Esperado: ain-agent (healthy), ain-postgres (healthy), ain-redis (healthy), ain-research (healthy)

curl http://localhost:3000/health
# Esperado: {"status":"healthy",...}

curl http://localhost:3001/services
# Esperado: JSON con 4 servicios

# Verificar PostgreSQL
docker exec -it ain-postgres psql -U ain -d ain_shadow -c "SELECT COUNT(*) FROM shadow_positions"
```

### 2.3 Contenedores

| Container | Puertos | Función |
|-----------|---------|---------|
| `ain-agent` | :3000, :3001, :9090 | Agente principal (ReAct loop, Hybrid Sniper, servicios x402) |
| `ain-postgres` | :5433 (externo) → 5432 | PostgreSQL para shadow positions |
| `ain-research` | :3002 | Agente de investigación (scanners, scoring) |
| `ain-redis` | 6379 (interno) | Cache compartida |
| `omniai-engine` | — | OmniAI integration |

### 2.4 Logs

```bash
docker compose logs -f ain-agent     # logs del agente principal
docker compose logs -f ain-research  # logs del research
docker compose logs --tail 50        # últimas 50 líneas de todos
```

### 2.5 Reiniciar después de cambios en .env

```bash
docker compose down
docker compose up -d --build
```

---

## PARTE 3: Cloudflare Tunnel

### 3.1 Crear el tunnel (una sola vez)

1. Ir a https://one.dash.cloudflare.com → Zero Trust → Networks → Tunnels
2. Crear nuevo tunnel con nombre `ain-agent`
3. Copiar el token del tunnel
4. Configurar Public Hostnames:

| Subdomain | Domain | Service |
|-----------|--------|---------|
| api | niklauss.uk | http://localhost:3001 |
| health | niklauss.uk | http://localhost:3000 |
| research | niklauss.uk | http://localhost:3002 |

### 3.2 Instalar cloudflared como servicio Windows

```powershell
# Descargar cloudflared para Windows:
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# Instalar como servicio (arranca automáticamente con Windows):
cloudflared service install <TUNNEL_TOKEN>
```

El tunnel arranca solo al prender la PC. No necesita intervención manual.

### 3.3 Verificar acceso público

```bash
curl https://api.niklauss.uk/services
# Esperado: JSON con 4 servicios

curl -X POST https://api.niklauss.uk/service/text-generation
# Esperado: HTTP 402 con challenge x402
```

### 3.4 URLs públicas

| URL | Propósito |
|-----|-----------|
| `https://api.niklauss.uk/services` | Lista de servicios pagos |
| `https://api.niklauss.uk/service/<id>` | Endpoint de servicio (402 sin pago) |
| `https://health.niklauss.uk/health` | Health check JSON |
| `https://health.niklauss.uk/report` | Informe completo |
| `https://health.niklauss.uk/chart` | Dashboard de trading (velas + indicadores) |
| `https://health.niklauss.uk/chart/data` | API JSON: velas, EMA, RSI, MACD, régimen |
| `https://research.niklauss.uk/health` | Estado del research agent |

---

## PARTE 4: OKX AI Marketplace (onchainos CLI)

### 4.1 Instalar herramientas OKX

```bash
# onchainos CLI
curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh
# En Windows: descargar el instalador de https://web3.okx.com/onchainos

# A2A Node (daemon)
npm i -g @okxweb3/a2a-node@latest

# OpenClaw (runtime AI para A2A)
# Seguir instrucciones en: https://openclaw.ai
```

### 4.2 Login en Agentic Wallet

```bash
onchainos wallet login niklaussmauricio@gmail.com
# Verificar OTP del email:
onchainos wallet verify <CODIGO>
# Ver wallets:
onchainos wallet addresses
```

Wallets:
- **EVM (X Layer):** `0x687dd10e8240908069ee760b7a41ac2c451f6031`
- **Solana:** `5NHM7HfcGqN6t9ZKMg5Ak4sioYAC9cxpnvTfLuQxHREe`

### 4.3 Configurar A2A Daemon

```bash
# Vincular OpenClaw como AI provider:
okx-a2a ai-provider set --provider openclaw

# Verificar salud:
okx-a2a doctor --fix

# Instalar autostart (Windows):
okx-a2a daemon autostart install

# O iniciar manualmente:
okx-a2a daemon start
```

### 4.4 Gestión del agente

```bash
# Ver mis agentes:
onchainos agent get-my-agents

# Ver servicios del agente:
onchainos agent service-list --agent-id 6932

# Subir avatar (max 1MB):
onchainos agent upload --file assets/avatar-small.png

# Actualizar avatar:
onchainos agent update --agent-id 6932 --picture "https://static.okx.com/cdn/..."

# Agregar servicio:
onchainos agent update --agent-id 6932 --service '[{"operation":"create","serviceName":"Nombre","serviceDescription":"Desc","serviceType":"A2MCP","fee":"0.50","endpoint":"https://api.niklauss.uk/service/id"}]'

# Eliminar servicio (necesita ID del service-list):
onchainos agent update --agent-id 6932 --service '[{"operation":"delete","id":"35902","serviceName":"x","serviceDescription":"x","serviceType":"A2MCP","fee":"0.01","endpoint":"https://x.com"}]'

# Solicitar review:
onchainos agent activate --agent-id 6932 --preferred-language en-US

# Heartbeat manual:
onchainos agent heartbeat --chain-index 196
```

### 4.5 Notas importantes sobre onchainos

- Los comandos que modifican el agente (`update`, `activate`) tardan ~2 minutos porque hacen A2A doctor check primero
- El formato `--service` requiere TODOS los campos: `operation`, `serviceName`, `serviceDescription`, `serviceType`, `fee`, `endpoint`
- Para `delete` necesitas el `id` numérico (obtener de `service-list`)
- El daemon A2A mantiene el heartbeat automáticamente — no necesitas `OKX_HEARTBEAT_ENABLED=true` en Docker

---

## PARTE 5: Verificación Final (Checklist)

```bash
# 1. Docker corriendo:
docker compose ps | findstr "healthy"

# 2. Health check local:
curl http://localhost:3000/health

# 3. Servicios locales:
curl http://localhost:3001/services

# 4. Acceso público via Cloudflare:
curl https://api.niklauss.uk/services

# 5. Challenge x402 (debe dar 402):
curl -s -o NUL -w "%{http_code}" -X POST https://api.niklauss.uk/service/text-generation
# Esperado: 402

# 6. A2A daemon:
okx-a2a doctor

# 7. Estado del agente en OKX:
onchainos agent get-agents --agent-ids 6932
# Verificar: onlineStatus=1, approvalStatus
```

---

## PARTE 6: Troubleshooting

### El agente no arranca

```bash
docker compose logs ain-agent --tail 100
# Buscar errores de: keystore, .env, migraciones SQL, API keys
```

### PostgreSQL no conecta

```bash
# Verificar que el container está corriendo
docker ps | findstr postgres

# Probar conexión manual
docker exec -it ain-postgres psql -U ain -d ain_shadow -c "SELECT 1"

# Ver logs
docker logs ain-postgres --tail 50
```

### Cloudflare Tunnel no conecta

```bash
# Verificar que el servicio está corriendo:
sc query cloudflared
# Si no está: cloudflared service install <TOKEN>
# Reiniciar: sc stop cloudflared & sc start cloudflared
```

### OKX rechaza la review

1. Verificar que Docker + Cloudflare Tunnel estén corriendo
2. Verificar que `curl -X POST https://api.niklauss.uk/service/text-generation` retorne HTTP 402
3. Verificar que `okx-a2a doctor` no tenga fails
4. Verificar que `onchainos agent get-agents --agent-ids 6932` muestre `onlineStatus: 1`
5. Re-submit: `onchainos agent activate --agent-id 6932 --preferred-language en-US`

### La PC se reinició

- Docker Desktop arranca automáticamente (si está configurado)
- Cloudflare Tunnel arranca como servicio Windows automáticamente
- A2A Daemon arranca como tarea programada Windows automáticamente
- **Verificar:** `docker compose ps` + `curl https://api.niklauss.uk/services`

---

## PARTE 7: Hybrid Sniper (Shadow Trading)

### 7.1 Verificar métricas del Sniper

```bash
# Script de estadísticas rápidas
node scripts/quick-stats.mjs

# Query directo a PostgreSQL
docker exec -it ain-postgres psql -U ain -d ain_shadow -c "
SELECT 
  variant_name,
  COUNT(*) as trades,
  SUM(CASE WHEN exit_reason='TP_HIT' THEN 1 ELSE 0 END) as wins,
  ROUND(100.0 * SUM(CASE WHEN exit_reason='TP_HIT' THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate,
  ROUND(SUM(realized_pnl)::numeric, 2) as total_pnl
FROM shadow_positions 
WHERE closed_at IS NOT NULL
GROUP BY variant_name
ORDER BY total_pnl DESC
"
```

### 7.2 Variantes activas

| Variante | TP% | SL% | Time Stop | Size |
|----------|-----|-----|-----------|------|
| **Balanced Large $25** | 40% | 15% | 2h | $25 |
| **Conservative 1h** | 25% | 8% | 1h | $15 |
| **Scalp Medium 1h** | 20% | 10% | 1h | $10 |

### 7.3 Fases del Shadow Trading

- **Fase 1 (8-22 Ago):** Recolección de datos — EN PROGRESO
- **Fase 2 (22-24 Ago):** Análisis y selección de variante ganadora
- **Fase 3 (24-31 Ago):** Paper trading con costos reales
- **Fase 4 (1 Sep):** Trading real con micro-capital ($20-50)

Ver detalles en `docs/fases.md`

---

## IDs y Referencias

| Item | Valor |
|------|-------|
| Agent OKX activo | #6932 |
| Agents desactivados | #6740, #6741, #6742 |
| Wallet agente (Base) | `0xae36889c670CaA446bE18ECdC96f7c882e601D81` |
| Balance actual | ~$99.80 USDC |
| Agentic Wallet (X Layer) | `0x687dd10e8240908069ee760b7a41ac2c451f6031` |
| Email OKX | niklaussmauricio@gmail.com |
| Dominio | niklauss.uk |
| Tunnel ID | 753eb114-81fc-4da2-a4e2-0a7fed56e8ed |
| onchainos | v4.2.6 |
| @okxweb3/a2a-node | v0.1.10 |
| PostgreSQL port | 5433 (externo) → 5432 (interno) |
| Shadow DB | ain_shadow |

---

## Archivos Sensibles (NUNCA subir a git)

- `keys/keystore.json` — wallet cifrada AES-256
- `.env` — API keys, passwords, tokens
- `data/agent.db` — base de datos SQLite del agente
- PostgreSQL data — volumen Docker con shadow positions

---

## Bases de Datos

| Database | Tipo | Ubicación | Contenido |
|----------|------|-----------|-----------|
| `agent.db` | SQLite | `data/agent.db` | Estado del agente, historial |
| `ain_shadow` | PostgreSQL | Container `ain-postgres` | Shadow positions, métricas Sniper |
| `metrics.db` | SQLite | `data/metrics.db` | Pipeline metrics |
| `evolution.db` | SQLite | `data/evolution.db` | Strategy evolution lab |

---

## Costos de Operación

| Item | Costo |
|------|-------|
| Dominio niklauss.uk | ~$10/año |
| Cloudflare Tunnel | Gratis (Zero Trust free tier) |
| Docker (local) | Gratis (usa tu PC) |
| Anthropic API | ~$0.23/día con optimización |
| Gas ETH (Base) | ~$0.01/tx |
| Total mensual estimado | ~$7-10 (casi todo es LLM) |
