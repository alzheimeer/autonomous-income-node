---
trigger: always_on
description: Contexto y reglas del proyecto Autonomous Income Node para Antigravity/Gemini
---

# Autonomous Income Node — Reglas del Agente

## Contexto del Proyecto

**Agente de IA autónomo** corriendo en producción con fondos reales en Base mainnet.
Propietario: Mauricio Quintero | niklaussmauricio@gmail.com | Colombia

**Wallet:** `0xae36889c670CaA446bE18ECdC96f7c882e601D81` (Base mainnet)
**Balance:** ~$99.63 USDC ($15 wallet + $84.63 Aave V3) + 0.013 ETH gas
**Tier:** 3 (todas las capacidades activas)
**Estado:** PRODUCCIÓN 24/7

**Dominio:** `niklauss.uk` (Cloudflare Tunnel permanente)
- `https://api.niklauss.uk` — servicios x402
- `https://health.niklauss.uk` — health + report
- `https://research.niklauss.uk` — research agent

---

## Reglas de Seguridad (OBLIGATORIAS)

1. **NUNCA ejecutar** `docker compose down` sin permiso explícito
2. **NUNCA commitear** archivos: `.env`, `keys/keystore.json`, `data/*.db`
3. **NUNCA modificar** `constitution.md` — leyes inmutables del agente
4. **SIEMPRE mostrar** cambios propuestos a `.env` antes de aplicarlos
5. **NUNCA exponer** valores de `WALLET_PASSWORD`, `ANTHROPIC_API_KEY`, `CLOUDFLARE_TUNNEL_TOKEN`

---

## Reglas de Código

- TypeScript strict ESM con NodeNext module resolution
- Balances USDC como `bigint` (6 decimales) — NO convertir a `number`
- No usar `process.exit()` en tests — usar stubs en memoria
- Secrets enmascarados con `maskSecrets()` en `src/config/log-filter.ts`
- APIs externas via MCP servers en `src/mcp/servers/`
- Módulos nunca lanzan excepciones en producción — retornan null o Result pattern

---

## Stack y Herramientas

- **Node.js 20** + **pnpm** workspaces
- **Vitest** + **fast-check** para tests (410+ tests, 24 para FeatureEngine)
- **Docker Compose** — 3 contenedores: `ain-agent`, `ain-research`, `ain-redis`
- **ethers v6** para blockchain (Base mainnet)
- **Fastify 4** para HTTP
- **better-sqlite3** para SQLite síncrono
- **Cloudflare Tunnel** para URLs permanentes (niklauss.uk)
- **Binance API** para candles/indicadores técnicos

---

## Archivos de Contexto (leer en orden)

1. `CLAUDE.md` — contexto técnico completo
2. `.kiro/steering/project-context.md` — estado actual del proyecto
3. `.kiro/steering/trading-strategy.md` — estrategia de trading e indicadores
4. `constitution.md` — leyes inmutables del agente

## Módulos Principales

- `src/agent/` — ReAct Loop, AgentCore, EventBus, ModelRouter
- `src/trading-validation/` — Sistema completo de spot trading (20+ módulos)
- `src/pipeline-metrics/` — Observador pasivo de señales → data/metrics.db
- `src/backtester/` — Replay offline con candles Binance
- `src/evolution/` — Strategy Evolution Lab (15 módulos) → data/evolution.db
- `src/evolution/funding-arb/` — Funding-arb backtest (Hyperliquid funding rate arb) → data/funding.db
- `src/strategies/` — Trading, lending, services, perps, LP, content
- `src/research/` — Research Agent (segundo contenedor)
