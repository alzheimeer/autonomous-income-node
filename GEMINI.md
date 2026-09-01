# Autonomous Income Node — Context for AI Coding Assistants
> Para contexto técnico completo ver CLAUDE.md. Este archivo es el resumen ejecutivo.

---

## ¿Qué es?

**Agente de IA autónomo** que genera ingresos en USDC en Base blockchain, sin intervención manual.
Corre 24/7 en Docker (3 containers) + Cloudflare Tunnel. **CON FONDOS REALES — NO detener sin razón.**

**Propietario:** Mauricio Quintero (niklaussmauricio@gmail.com, Colombia)
**Estado:** PRODUCCIÓN ACTIVA — Shadow Trading + Auto-Implementación Autónoma ✅

---

## Stack

- Node.js 24 + TypeScript strict ESM + pnpm workspaces
- PostgreSQL + TimescaleDB + Redis + SQLite | Fastify 4 | ethers v6 | Base L2
- **LLM: DeepSeek API** — V4 Flash (triage/análisis) + V4 Pro (generación de código)
- **Sin Ollama en el agente** — Ollama (qwen3.5:9b) solo para uso personal en editor
- Trading: Uniswap v3 + 1inch + Paraswap + indicadores técnicos (Binance)
- Docker Compose: `ain-agent` (:3000/:3001), `ain-research` (:3002), `ain-redis`
- Cloudflare Tunnel: `niklauss.uk` (api/health/research subdominios)
- Testing: 61+ tests hybrid-sniper (properties + unit + integration + fastify)

---

## Estado Actual (19 Agosto 2026)

- **Balance:** $99.64 USDC en wallet, $0 en Aave (PERMANENTEMENTE DESACTIVADO)
- **Tier:** 3 — todas las capacidades activas
- **Wallet:** `0xae36889c670CaA446bE18ECdC96f7c882e601D81`
- **TradingOrchestrator:** Shadow mode — MACRO TREND FILTER activo, sin trades reales
- **CopyTrading Smart Money:** ACTIVO (flag `COPY_TRADING_ENABLED=true`) — sistema completo de 6 módulos corriendo en producción vía AgentCore Paso 5.6
- **HybridSniper (Phase 0):** SHADOW ONLY — resultados negativos, solo recolecta datos
- **RugAlertService:** Integrado tanto en CopyTrading como en HybridSniper — protección proactiva multi-señal de rug pulls
- **AdaptiveEvolver:** ACTIVO modo live — 1 implementación exitosa ✅
- **DailyReport:** 3 informes/día: 11am, 6pm, 4am Colombia (`[16, 23, 9]` UTC)
- **LLM Engine:** DeepSeek API con sanitización de `<think>` CoT, restricción de 30 palabras en reasoning, maxTokens: 2048 y JSON repair fallback.
- **AutoLender:** PERMANENTEMENTE DESACTIVADO (`AAVE_PERMANENTLY_DISABLED=true`)

---

## Reglas para el AI (IMPORTANTE)

1. **NO detener** el agente sin autorización — fondos reales en producción
2. **NO usar** `docker compose build --no-cache` ni `--force-recreate` — mata la WiFi
3. **SOLO usar** `docker compose up -d --build agent` para rebuilds
4. **bigint** para balances USDC (6 decimales: 1 USDC = 1_000_000n)
5. **TypeScript strict ESM** — sin CommonJS ni `require()`
6. **Hablar en español** en respuestas al usuario
7. Horas del DailyReport son **UTC** — Colombia es UTC-5

---

## Módulos Principales

### ACTIVOS

| Módulo | Función |
|--------|---------|
| **CopyTrading Smart Money** | Sistema completo integrado en AgentCore (Paso 5.6). WalletWatcher detecta swaps de wallets curadas → SignalEnricher valida → AntiBaiting filtra → CopyExecutor abre posición → ExitManager gestiona salidas → **RugAlertService** protege en tiempo real |
| **RugAlertService** | Protege posiciones de AMBOS sistemas (CopyTrading + HybridSniper). LiquidityMonitor (15s/5s), LpRemovalDetector (Transfer events), LargeHolderSellDetector (deployer+whales). Cierra automáticamente en HIGH/CRITICAL. **35 tests ✅** |
| **AdaptiveEvolver** | Auto-implementa código con **DeepSeek V4 Pro**: queue → LLM → sandbox → apply |
| **HybridSniper (Phase 0)** | SHADOW ONLY — 0% win rate real, recolecta datos. 4 fuentes ingesta. 61 tests |
| **TradingOrchestrator** | Pipeline spot trading WETH/USDC (shadow mode) |
| **ResearchAgent** | 5 scanners, descubre oportunidades, escribe JSON en ./investigacion/ |
| **FeatureEngine** | Indicadores técnicos multi-pair (ETH/BTC/SOL, Binance) |
| **ModelRouter** | DeepSeek V4 Flash triage → ahorra ~70% en LLM |
| **DailyReport** | Telegram 3x/día con secciones: balance, pipeline, sniper, auto-implementación |
| **Evolution Lab** | Iteración autónoma de estrategias (15 módulos) |
| **Backtester** | Replay histórico offline, `pnpm backtest --days 30` |
| **Pipeline Metrics** | Observer pasivo del pipeline → `data/metrics.db` |
| **Servicios x402** | APIs pagas: text-gen $0.50, code-gen $1.00, summarize $0.30, scraping $0.20 |
| **Research Agent** | 5 scanners, descubre oportunidades, escribe JSON en ./investigacion/. **FIX Ago 2026:** dedup mejorada (fingerprint URL+título), scanner health tracking, revenue lifecycle (code_generated → implementada solo con revenue confirmado) |
| **FeatureEngine** | Indicadores técnicos multi-pair (ETH/BTC/SOL, Binance) |
| **ModelRouter** | Haiku triage → ahorra ~70% en LLM |
| **DailyReport** | Telegram 3x/día con secciones: balance, pipeline, sniper, auto-implementación |
| **Evolution Lab** | Iteración autónoma de estrategias (15 módulos) |
| **Backtester** | Replay histórico offline, `pnpm backtest --days 30` |
| **Pipeline Metrics** | Observer pasivo del pipeline → `data/metrics.db` |
| **Servicios x402** | APIs pagas: text-gen $0.50, code-gen $1.00, summarize $0.30, scraping $0.20 |

### DESACTIVADOS

| Módulo | Razón |
|--------|-------|
| AutoLender | PERMANENTEMENTE — re-depositaba sin permiso |
| Hyperliquid | Durante trading validation |
| SocialModule | Reducción de ruido durante testing |

---

## Auto-Implementación Autónoma (AdaptiveEvolver) — NUEVO ✅

El sistema más avanzado: el agente escribe, testea y aplica su propio código.

```
ain-research → JSON en ./investigacion/
  → AgentCore watcher (30s) → queueResearchProposal()
    → rate limit check primero
    → LLM genera TypeScript para src/strategies/auto-generated/xxx.ts
      → BackupManager (maneja ENOENT para archivos nuevos)
      → SandboxRunner: pnpm test --run src/strategies/auto-generated/
        → SOLO esta carpeta (evita falsos negativos de tests de integración)
      → CodePatcher: mkdir + writeFile + audit log
      → DailyReport: sección 🧠 Auto-Implementación
```

**Variables de entorno:**
```env
ADAPTIVE_EVOLVER_DRY_RUN=false
ADAPTIVE_EVOLVER_INTERVAL_MS=3600000
ADAPTIVE_EVOLVER_MAX_PER_CYCLE=1
ADAPTIVE_EVOLVER_MIN_SCORE=70
```

---

## Trading Validation — COMPLETA ✅ (54/54 tareas)

**Ubicación:** `src/trading-validation/` — 20+ módulos

**Modo dual:**
- **Shadow** (actual): paper trading con executable quotes reales
- **Micro** (tras Shadow Pass): trades reales $5-$10 on-chain

**Parámetros de riesgo (TUNED Julio 2026):**

| Parámetro | Valor | Nota |
|-----------|-------|------|
| Max trade | $15 | Aumentado de $10 |
| Max pérdida/día | $5 | Aumentado de $3 |
| Stop loss ATR | 2.2 | Aumentado de 1.8 |
| **MIN Stop loss %** | **1.5%** | **Floor absoluto (era 1.0%)** |
| **MIN Take profit %** | **2.0%** | **Floor absoluto (era 1.2%)** |
| Cooldown | 30 min | Aumentado de 20 min |
| Volume Z threshold | 0.5 | Aumentado de 0.3 |

**MACRO TREND FILTER (NUEVO):**
- Bloquea LONGs cuando EMA20 < EMA50 Y precio < EMA200
- En TRENDING_DOWN, solo permite si RSI < 25 Y precio > EMA200
- Sistema correctamente pausado durante mercado bajista

**Criterios de avance:**
- Shadow Pass: ≥10 trades, net PnL ≥ 0, confirmación operador
- Micro Pass: 20+ trades, profit factor > 1.2, drawdown < $10

---

## Hybrid Sniper (Phase 0) — COMPLETO ✅ (ACTUALIZADO 13 Agosto 2026)

**Ubicación:** `src/hybrid-sniper/` (8 archivos) | **DB:** PostgreSQL + TimescaleDB
**Tests:** `tests/hybrid-sniper/` — **61/61 tests pasando** ✅

### 🔄 Flujo End-to-End

```
INGEST → VALIDATE → EXECUTE → MONITOR → CLOSE
  │         │          │         │        │
  ▼         ▼          ▼         ▼        ▼
4 fuentes  5 checks   3 vars   10s loop  TP/SL/Time
DexScreen  Honeypot   $25/$15  Quote     + PnL calc
GeckoTerm  Tax<5%     /$10     prices    + Metrics
Bitquery   Liquidity  shadow   check     + RiskBucket
Webhook    Blacklist  position exits
           LP Lock
```

### 4 fuentes de señales

| Fuente | Intervalo | Filtros Pre-Validación |
|--------|-----------|------------------------|
| **DexScreener** | 30s | `volume.h1 > $10k` + `liquidity >= $5k` ← **NUEVO filtro** |
| **GeckoTerminal** | 25s | `reserve >= $10k` + vol o buys recientes |
| **Bitquery** | 30s | Tokens nuevos (5 min), requiere API key |
| **Webhook** | On-demand | POST /webhook/alpha |

### 5 validaciones secuenciales (ContractValidator)

1. **Pool Detection** → detecta UniV3 vs Aerodrome
2. **Honeypot Test** → simula buy $5 + sell 50% + sell 50%
3. **Tax Scanner** → rechaza si sell tax > 5%
4. **Liquidity Check** → requiere $1k USDC o 0.4 ETH
5. **Flag Scanner** → verifica isBlacklisted(agentAddress)
5.5. **LP Lock/Burn** → verifica si LP está quemado o bloqueado

### 3 variantes activas (Multi-Variant Executor)

| Variante | TP | SL | TimeStop | Trade Size | Win Rate |
|----------|----|----|----------|------------|----------|
| **balanced-large** | 40% | 15% | 2h | $25 | **0%** (corregido) |
| **conservative-1h** | 25% | 8% | 1h | $15 | **0%** (corregido) |
| **scalp-medium-1h** | 20% | 10% | 1h | $10 | **0%** (corregido) |

### Optimizaciones 13 Agosto 2026

| Mejora | Impacto |
|--------|---------|
| Pre-filtro liquidez $5k en DexScreener | -80% señales basura |
| Cache de pool tokens (TTL 1h) | -40% llamadas RPC |
| TIME_STOP 2h → 4h para micro-caps | Más tiempo para pump |
| Retry logic + backoff en DexQuoter | Menos QUOTE_ERROR |
| Fallback: UniV3 → Aerodrome → Direct | Más cobertura pools |

### DexQuoter — Cadena de Fallback

```
UniswapV3 (fee tiers: 10000→3000→500→100)
    ↓ (si falla)
Aerodrome (getAmountOut)
    ↓ (si falla)
Direct Pool (lee reserves + formula constant product)
```

### Manejo de Errores

| Error | Handling |
|-------|----------|
| Rate limit 429 | Pausa automática 60-120s |
| Timeout/502/503 | Retry 3x con backoff exponencial |
| Quote revert | Skip position (no cuenta como loss) |
| Auth 401/402 | Desactiva fuente para sesión |

### Métricas Actuales (13 Agosto 2026)

| Métrica | Valor | Objetivo |
|---------|-------|----------|
| Pass Rate DexScreener | 9.55% | ≥5% ✅ |
| QUOTE_ERROR rate | 99.4% | <30% ❌ |
| Micro-cap trades | 5,196 | ≥50 ✅ |
| Win Rate micro-cap | **0%** (corregido) | ≥40% ❌ |

**Problema principal:** RPC rate limits (Alchemy agotado, Base público limitado)

**~~Ganancias~~ PÉRDIDAS por trade (CORREGIDO):**
- balanced-large $25: ~-$100/trade (PÉRDIDA)
- conservative-1h $15: ~-$30/trade (PÉRDIDA)
- scalp-medium-1h $10: ~-$10/trade (PÉRDIDA)

**Endpoints:** `GET /sniper/status` | `POST /webhook/alpha` | `GET /sniper/rug-alerts` (nuevo)

---

## Copy-Trading Smart Money (19 Agosto 2026) — ACTIVO ✅

Sistema completo que copia trades de wallets "smart money" curadas. Integrado en AgentCore como **Paso 5.6** (non-fatal, mismo patrón que HybridSniper).

### Pipeline de señales

```
WalletWatcher (WebSocket + polling 2s)
  → detecta swap de wallet monitoreada
    → SignalEnricher (honeypot, tax<5%, liquidez≥$10k, LP lock, slippage)
      → AntiBaitingModule (round-trip, volume footprint, deployer tokens)
        → CopyExecutor (sizing: min(insider×10%, $100, capital×5%))
          → ExitManager (follow insider, trailing stop, TP+50%/SL-20%/48h)
            → RugAlertService (protección proactiva contra rug pulls)
```

### Módulos

| Módulo | Archivo |
|--------|---------|
| SmartMoneyCurator | `modules/SmartMoneyCurator.ts` — 10-50 wallets, WinRate≥70%, tiers S/A/B, re-eval 24h |
| WalletWatcher | `modules/WalletWatcher.ts` — WebSocket + polling híbrido, decode UniV3/Aerodrome/1inch |
| SignalEnricher | `modules/SignalEnricher.ts` — 7 validaciones, timeout 2s, EnrichedSignal |
| AntiBaitingModule | `modules/AntiBaitingModule.ts` — bait flags, round-trips, delay 5-30s |
| CopyExecutor | `modules/CopyExecutor.ts` — sizing dinámico, splits órdenes >$50, slippage dinámico |
| ExitManager | `modules/ExitManager.ts` — 3 estrategias salida, trailing stop state machine, rug detect |
| CopyTradingRiskManager | `modules/CopyTradingRiskManager.ts` — 3 pos max, 20% capital/día, CB 24h |
| CopyMetricsRecorder | `modules/CopyMetricsRecorder.ts` — persistencia PostgreSQL, restore on restart |

### Integración AgentCore

```typescript
// src/agent/index.ts — Paso 5.6
if (process.env['COPY_TRADING_ENABLED'] === 'true') {
  const { buildCopyTradingForAgent } = await import('../copy-trading/agent-integration.js');
  this.copyTrading = await buildCopyTradingForAgent(process.env);
  await this.copyTrading.start();  // Arranca WalletWatcher + ExitManager + RugAlertService
}
```

### Variables de entorno

```env
COPY_TRADING_ENABLED=true
COPY_SEED_WALLETS=0xWallet1,0xWallet2   # Wallets smart money a copiar
COPY_WS_RPC_URL=wss://...               # WebSocket RPC Base (QuickNode/Alchemy)
COPY_INITIAL_CAPITAL_USDC=500           # Capital inicial
COPY_MAX_POSITION_USDC=100              # Posición máxima por trade
COPY_TP_PCT=50                          # Take profit %
COPY_SL_PCT=20                          # Stop loss %
```

### Relación con RugAlertService

El `RugAlertService` protege **ambos** sistemas:
- CopyTrading: `rugAlertService.trackPosition()` en `processSignal()` tras abrir posición
- HybridSniper: monkey-patch en `openPosition()` de ShadowExecutor

Cuando detecta rug → `untrackPosition()` al cerrar vía ExitManager.

---

## 🐛 FIX CRÍTICO #2: Lógica de Precios INVERTIDA (15 Ago 2026)

**El BUG REAL:** Una auditoría externa reveló que el simulador estaba operando completamente al revés. Las PÉRDIDAS se registraban como GANANCIAS.

**Causa:** `quote(USDC → TOKEN)` retorna "tokens por USDC". Cuando token SUBE → recibes MENOS tokens. Todas las comparaciones y cálculos estaban invertidos.

| Bug | Fix |
|-----|-----|
| `TP: tokens * 1.40` (más tokens) | `TP: tokens * 0.85` (menos = subió) |
| `SL: tokens * 0.95` (menos tokens) | `SL: tokens * 1.05` (más = bajó) |
| `PnL: (exit - entry) / entry` | `PnL: (entry - exit) / entry` |

**Ejemplo:** Token crash 50% → antes registraba +100% ganancia, ahora registra -50% pérdida.

**⚠️ DATOS HISTÓRICOS INVÁLIDOS:** Todas las métricas anteriores al fix están invertidas.

**⚠️ DATOS HISTÓRICOS CORREGIDOS:** Script `sql/fix-inverted-pnl.sql` ejecutado.

| Métrica | Antes (Bug) | Después (Correcto) |
|---------|-------------|-------------------|
| Win Rate | 99.9% | **0%** |
| PnL Total | +$1.25M | **-$1.25M** |
| TP_HITs | 30,060 | **0** |
| SL_HITs | 0 | **30,060** |

**Realidad:** Todos los trades fueron pérdidas. Sistema necesita revisión completa.

---

## 🐛 FIX CRÍTICO #1: Detección de Rug Pulls (15 Ago 2026)

**Problema:** Win Rate del 99.5% era falso. Cuando `quote()` fallaba (rug pull), el código hacía `continue;` y nunca registraba la pérdida.

**Solución implementada:**

| Cambio | Archivo | Efecto |
|--------|---------|--------|
| `MAX_QUOTE_FAILURES = 3` | `shadow-executor.ts` | Tras 3 fallos de quote consecutivos, asume rug pull |
| `quoteFailCount` tracking | `shadow-executor.ts` | Contador por posición, reset a 0 en quote exitoso |
| `_closePositionAsRugPull()` | `shadow-executor.ts` | Cierra con status `RUG_PULL`, exitPrice=0, pnlUsdc=-100% |
| `restoreOpenPositions()` fix | `shadow-executor.ts` | Intenta precio real antes de asumir $0 PnL |
| `RUG_PULL` en RiskBucket | `risk-bucket.ts` | Cuenta como loss para Circuit Breaker |

**Resultado esperado:**
- Win Rate ahora será **REAL** (40-60% típico para micro-caps)
- Rug pulls contabilizados como pérdidas del 100%
- Circuit Breaker se activa correctamente tras rug pulls consecutivos

**Documentación completa:** `docs/FIXES-15-AGO-2026.md`

---

## Strategy Evolution Lab — ACTIVO ✅

**Ubicación:** `src/evolution/` (15 módulos) | **DB:** `data/evolution.db`

```bash
npx tsx src/evolution/cli.ts run-cycle    # ciclo completo
npx tsx src/evolution/cli.ts status       # estado estrategias
npx tsx src/evolution/cli.ts funding-arb  # backtest funding rate
```

**Scheduler Windows Task Scheduler:**
- Daily: 6am Colombia — diagnóstico + variantes
- Weekly: Domingo 3am — backtest batch + funding-arb
- Monthly: Día 1, 4am — dormancy revival

---

## DailyReport — Telegram

**Horas UTC:** `[16, 23, 9]` = **11am, 6pm, 4am Colombia**

4 secciones:
1. Balance, yield, trades, costos LLM
2. Pipeline metrics (señales, rechazos, near-misses)
3. HybridSniper (señales procesadas, latencia, razón rechazo)
4. AdaptiveEvolver (implementaciones: ✅ aplicadas, ❌ fallidas, ⏭ omitidas)

---

## Endpoints

```bash
# Públicos
https://health.niklauss.uk/health       # health check
https://health.niklauss.uk/report       # último informe diario
https://health.niklauss.uk/chart        # dashboard velas live
https://health.niklauss.uk/sniper/status # estado sniper
https://api.niklauss.uk/services        # servicios x402

# Internos (requieren auth)
http://localhost:3000/trading/status
http://localhost:3000/trading/bankroll
http://localhost:3000/trading/experiment
http://localhost:3000/evolution/status
http://localhost:3000/sniper/status
```

---

## Comandos

```bash
pnpm build                              # compilar
pnpm test                               # 750+ tests
pnpm backtest --days 30                 # backtester offline

# Deploy (SOLO este comando)
docker compose up -d --build agent

# Monitoreo
curl http://localhost:3000/health
curl http://localhost:3000/sniper/status
curl http://localhost:3000/evolution/status

# Evolution Lab
npx tsx src/evolution/cli.ts run-cycle
npx tsx src/evolution/cli.ts funding-arb
```

---

## Historial

1. **Etapa 1 (May-Jun 2026):** Fundación — ReAct Loop, wallet, tiers
2. **Etapa 2 (Jun 2026):** Servicios x402, Social, Conway (caído)
3. **Etapa 3 (Jun-Jul 2026):** Arbitraje — imposible con $5 capital
4. **Etapa 4 (Jul 2026):** Spot Trading — 54 tareas, 750+ tests, shadow mode
5. **Etapa 5 (Jul 2026):** DeepSeek API reemplaza Anthropic (21x más barato). HybridSniper auditado (5 bugs, GeckoTerminal 4ª fuente, 61 tests). ModelRouter: Flash para triage/análisis, Pro para código. Ollama local solo para editor personal.
6. **Etapa 6 (Jul 2026):** Optimización Trading:
   - Aave PERMANENTEMENTE desactivado (flag en código)
   - MACRO TREND FILTER: bloquea LONGs en downtrends claros
   - Stops ampliados: min 1.5% SL / 2.0% TP (antes 1.0% / 1.2%)
   - Stop loss ATR: 2.2 (antes 1.8), Cooldown: 30 min (antes 20 min)
   - AdaptiveEvolver transpiler corregido (catch clauses, return types)
   - Primera implementación autónoma exitosa ✅
   - Shadow Trader nonce fix
7. **Etapa 7 (Ago 2026) ← ACTUAL:** Hybrid Sniper Optimización:
   - Multi-Variant Executor con 3 variantes probadas rentables
   - Pre-filtro liquidez $5k en DexScreener (-80% señales basura)
   - Cache de pool tokens con TTL 1h (-40% llamadas RPC)
   - TIME_STOP 2h → 4h para micro-caps
   - Retry logic con backoff exponencial en DexQuoter
   - Fallback cascada: UniV3 → Aerodrome → Direct Pool
   - Restauración de posiciones al reiniciar container
   - Separación de métricas por signal_type
   - **FIX CRÍTICO #1 (15 Ago 2026): Detección de Rug Pulls** — Nuevo status `RUG_PULL`, cierre automático tras 3 fallos de quote
   - **FIX CRÍTICO #2 (15 Ago 2026): Lógica de Precios INVERTIDA** — Todas las comparaciones TP/SL y cálculos de PnL estaban al revés. El simulador registraba PÉRDIDAS como GANANCIAS. Fix corrige TP/SL thresholds, comparaciones en monitorPositions(), y fórmula de PnL en _closePosition()
8. **Etapa 8 (19 Ago 2026) ← ACTUAL:** Rug Alert Service + Copy-Trading integrado:
   - **RugAlertService** (`src/rug-alert/`) — 10 archivos, 35 tests, 0 errores TypeScript
   - LiquidityMonitor: polling dual 15s/5s, timeout 5s por llamada
   - LpRemovalDetector: Transfer events LP token (burn + removal)
   - LargeHolderSellDetector: deployer sells + whale-to-DEX sells
   - AlertDispatcher: pipeline 500ms deadline closePosition + DB + Telegram
   - Integrado en `initHybridSniper()` + `wireSniper()` + `CopyTradingOrchestrator`
   - **CopyTrading integrado en AgentCore** (Paso 5.6) — `agent-integration.ts`
   - `CopyTradingOrchestrator` recibe `rugAlertService` — trackPosition/untrackPosition en cada apertura/cierre
   - Tabla `alert_events` en PostgreSQL (migración automática)
   - `GET /sniper/rug-alerts` + `rugAlerts` en `/sniper/status`
   - Variables: `COPY_TRADING_ENABLED=true`, `COPY_SEED_WALLETS=0x...`

**Funciona:** FeatureEngine, ModelRouter (70% ahorro), Research Agent, Trading Validation, HybridSniper, AdaptiveEvolver, MultiVariantExecutor
**No funcionó:** Conway Cloud, x402 (sin clientes), arbitraje, Twitter ($100/mes)

---

## Trading Stats Actuales

| Métrica | Valor |
|---------|-------|
| Total trades | 20 |
| Win Rate | 10% |
| PnL Total | -$2.19 |
| Mejor estrategia | trend_pullback (33.3%) |
| Régimen actual | TRENDING_DOWN |
| RSI | 34.1 (oversold) |

**Sistema correctamente NO operando** debido a MACRO TREND FILTER en mercado bajista.

---

## Research Agent Fixes (Agosto 2026)

3 correcciones críticas al módulo de investigación:

### Fix 1: Deduplicación mejorada
- **Antes:** Comparaba títulos exactos (case-insensitive). El mismo artículo de Medium aparecía 8+ veces.
- **Ahora:** Usa `dedup_key` = URL + primeros 50 chars normalizados (sin especiales, whitespace colapsado).
- **Adicional:** Cooldown de 24h por `source_url` para fuentes `content-platform`. Max 1 deep-dive por categoría/ciclo.

### Fix 2: Scanner health tracking
- Tabla `scanner_health` en `research.db` registra ok/failed por scanner por ciclo.
- Si un scanner falla 3+ ciclos consecutivos → alerta Telegram.
- Endpoint nuevo: `GET /scanner-health`

### Fix 3: Revenue lifecycle
- **Antes:** ACK `implemented` → marcaba como `implementada` inmediatamente (sin verificar ingresos).
- **Ahora:** ACK → `code_generated` → (24h) → `revenue_tracking` → (7 días) → `implementada` (si `actual_revenue` confirmado) o `failed_no_revenue`.
- Revenue checker automático cada 6 horas.
- Legacy "implementadas" sin revenue se migran a `code_generated` automáticamente.
- Endpoint nuevo: `GET /revenue-status`
- Migración: `002_scanner_health_and_revenue.sql`

### Fix 4: Scoring discriminador (ROI-based)
- Se agregó una quinta dimensión: `expectedRoi` (peso 25%). Las demás se rebalancearon.
- El LLM ahora penaliza fuertemente las oportunidades que requieren capital $0 pero que solo generarían ~$0.50-$5 al mes (ej. artículos genéricos de Medium).

### Fix 5 y 8: Caché de Deep Dives (Ahorro LLM)
- Se agregó una caché en memoria para los deep dives (`ScoringEngine.deepDiveCache`).
- Si una oportunidad sobre el mismo tema ya fue analizada en las últimas 48h, se reutiliza la conclusión en lugar de gastar tokens LLM repitiendo que "es viable pero de bajo ROI".

### Fix 6 y 7: Scanners resilientes (Anti-bot y selectores)
- **YouTube:** Reemplazado scraping de `/feed/trending` (bloqueado por anti-bot/JS) por Google News RSS para temas de IA.
- **TikTok:** Reemplazado scraping de Creative Center HTML por Google Trends RSS (búsquedas diarias sobre IA).
- **Medium:** Ahora usa RSS feed como fuente primaria, y tiene un HTML scraper de respaldo con 7 selectores CSS en cascada para evitar romperse con cambios de layout.

### Fix (10 Agosto 2026): ain-agent (Sniper) - Auto-Recuperación de JsonRpcProvider
- **Problema:** Al perder conexión brevemente, la librería ethers.js (JsonRpcProvider) entraba en un "bucle ciego" (getaddrinfo ENOTFOUND) y no lograba recuperar la sincronización con la blockchain al volver el internet.
- **Solución:** Se implementó un "RPC Watchdog" en AgentCore.start() que monitorea la conexión del nodo mediante peticiones HTTP directas. Si el ping falla por 3 minutos consecutivos, el agente aborta intencionalmente con process.exit(1), lo que obliga al gestor de contenedores (Docker) a revivirlo instantáneamente con una conexión limpia a la red, solucionando el bloqueo permanente.

---

## 📊 ANÁLISIS CRÍTICO SNIPER — 11 Agosto 2026

> **Ver documento completo:** `docs/SNIPER-ANALISIS-11-AGO-2026.md`

### Estado: ⏳ NO LISTO para "Mes 2 (Micro-Live)"

**Problema identificado:** El 100% de trades cerrados eran de pares establecidos (WETH/DAI), no micro-caps reales. Las métricas mostraban 100% win rate y +$133k PnL, pero esto es un artefacto de simulación — los pares establecidos tienen spread ~0.

**Correcciones implementadas:**

1. **Separación de métricas** por `signal_type` (micro-cap vs established)
2. **Reducción de liquidez mínima:** $3,000 → $1,000 USDC o 0.4 ETH
3. **Script de análisis actualizado** con checklist de criterios

**Verificación:**
```bash
node analyze-sniper-metrics.mjs
```

### Fix (12 Agosto 2026): Restauración de Posiciones al Reiniciar

- **Problema:** 27 posiciones micro-cap quedaron OPEN en DB pero nunca cerraban tras reiniciar container.
- **Causa:** ShadowExecutor solo mantenía posiciones en memoria (Map), no restauraba de DB.
- **Solución:** 
  - Nuevo método `restoreOpenPositions()` en `shadow-executor.ts`
  - Nuevo método `getOpenPositions()` en `metrics-recorder.ts`
  - Se llama automáticamente en `start()` antes del monitoring loop

### Fix (12 Agosto 2026): Separación de Tablas Shadow

- **Problema:** Error `column "token_address" of relation "shadow_positions" does not exist`
- **Causa:** El `ShadowTrader` del trading-validation usaba la tabla `shadow_positions` del hybrid-sniper con esquema incompatible
- **Solución:** 
  - Creada nueva tabla `trading_shadow_positions` para el trading-validation
  - Archivo: `src/trading-validation/shadow-trader.ts` corregido
  - Migración: `sql/003_trading_shadow_positions.sql`

**Tablas de shadow trading:**
| Tabla | Módulo | Uso |
|-------|--------|-----|
| `shadow_positions` | hybrid-sniper | Posiciones micro-cap sniping |
| `trading_shadow_positions` | trading-validation | Posiciones WETH/USDC shadow trading |

**Estado actualizado (12 Agosto 2026):**

| Tipo | Status | Count | PnL |
|------|--------|-------|-----|
| established | TP_HIT | 4,149 | +$134,470 |
| micro-cap | TIME_STOP | 27 | $0 |
| unknown | TP_HIT | 18 | +$567 |

**Mejoras observadas:**
- Pass rate: 0% → 1.13%
- INSUFFICIENT_LIQUIDITY: 46% → 28%
- Threshold de WETH funcionando (logs muestran `liquiditySource: "WETH"`)
- Error `token_address` eliminado ✅

---

*Documento generado para Gemini, Kiro, Claude, Cursor*
*Última actualización: 2026-08-19 — CopyTrading integrado en AgentCore + RugAlertService en ambos sistemas*
