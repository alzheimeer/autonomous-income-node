# Autonomous Income Node — Project Context for AI Assistants
> Leído automáticamente por Claude, Cursor, Kiro, Windsurf y similares.
> Contexto completo del proyecto para cualquier AI que contribuya sin conocimiento previo.

---

## ¿Qué es este proyecto?

**Agente de IA autónomo** que corre localmente (Docker en Windows) y genera ingresos en USDC en la blockchain Base, sin intervención manual. Piensa, actúa y observa en ciclo continuo.

**Propietario:** Mauricio Quintero (niklaussmauricio@gmail.com, +57 3187244914 Colombia)

**Estado actual:** PRODUCCIÓN ACTIVA — Copy-Trading Smart Money + Shadow Trading + Auto-Implementación Autónoma ✅
- Wallet: `0xae36889c670CaA446bE18ECdC96f7c882e601D81` (Base mainnet)
- Balance: $99.64 USDC en wallet, $0 en Aave — **Tier 3**
- Docker Compose en Windows PC
- **TradingOrchestrator:** Shadow mode con Stop Loss a **1.8 ATR** y **Trailing Stop Dinámico** (+0.5% PnL activation)
- **CopyTrading:** ACTIVO (flag `COPY_TRADING_ENABLED=true`) — WalletWatcher + SmartMoneyCurator + SignalEnricher + AntiBaitingModule + CopyExecutor + ExitManager + **RugAlertService** integrado
- **AdaptiveEvolver:** ACTIVO en modo live — genera código con **DeepSeek V4 Pro** — 1 implementación exitosa ✅
- **DailyReport:** 3 reportes/día: 11am, 6pm, 4am Colombia (16, 23, 9 UTC)
- **HybridSniper:** SHADOW ONLY (resultados negativos). Sub-second WebSocket ingestion + pre-quote cache TTL 30s + **RugAlertService integrado**
- **RugAlertService:** Protege posiciones de CopyTrading Y HybridSniper — LiquidityMonitor (15s/5s), LpRemovalDetector, LargeHolderSellDetector, AlertDispatcher, DeduplicationMap, TelegramNotifier
- **LLM Engine:** DeepSeek V4 Flash / Pro con sanitización de `<think>` CoT, restricción de 30 palabras en reasoning, maxTokens: 2048 y JSON repair fallback.
- **Aave Lending:** PERMANENTEMENTE DESACTIVADO (flag `AAVE_PERMANENTLY_DISABLED=true`)

---

## REGLAS CRÍTICAS para el AI

1. **NUNCA detener el agente** sin autorización explícita — está en producción con fondos reales
2. **NUNCA usar** `docker compose build --no-cache` ni `--force-recreate` — mata la WiFi del PC
3. **SOLO usar** `docker compose up -d --build agent` para rebuilds
4. **NUNCA commitear** `keys/`, `data/`, `.env`
5. **bigint** para todos los balances USDC (6 decimales: 1 USDC = 1_000_000n)
6. **TypeScript strict ESM NodeNext** — sin CommonJS, sin `require()`
7. **Bases de Datos Híbrida**: PostgreSQL + TimescaleDB (para Series de Tiempo de Trading/Métricas) + Redis (Cache de Ticks) + SQLite via `node:sqlite` (solo configuraciones menores).
8. **Hablar solo en español** en las respuestas al usuario
9. Las **horas del DailyReport son UTC** — Colombia es UTC-5, usar `[16, 23, 9]` para 11am/6pm/4am Colombia

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 24, TypeScript strict ESM NodeNext |
| Package manager | pnpm workspaces |
| Database | PostgreSQL + TimescaleDB (`ain_trading`) & SQLite (`./data/agent.db`) |
| Cache | Redis 7 (Docker) |
| HTTP | Fastify 4 — puerto 3000 |
| Blockchain | ethers v6, Base L2 (chainId 8453) |
| LLM | **DeepSeek API** — V4 Flash (triage + análisis, $0.14/1M) / V4 Pro (código, $0.435/1M) |
| Trading | Uniswap v3 SDK + 1inch API + Paraswap |
| Containers | Docker Compose (3 servicios) |
| Testing | Vitest + fast-check (750+ tests: 576 unit + 63 property + 12 integration) |
| Protocol | MCP (Model Context Protocol) para herramientas externas |

---

## Estructura del Proyecto

```
autonomous-income-node/
├── src/
│   ├── agent/                  # ReAct Loop, AgentCore, ModelRouter, CostOptimizer, DailyReport
│   ├── heartbeat/              # Health monitoring, HTTP endpoints (port 3000)
│   ├── identity/               # Wallet BIP-39/AES-256, ERC-8004
│   ├── survival/               # 5-tier balance manager, CapabilityGates
│   ├── intelligence/           # StrategyTracker, OpportunityDiscovery, KnowledgeAcquirer
│   │   └── adaptive-evolver.ts # Auto-implementación: queue proposals → LLM → sandbox → apply
│   ├── trading-validation/     # Sistema completo spot trading (20+ módulos)
│   ├── pipeline-metrics/       # Observer pasivo → data/metrics.db
│   ├── hybrid-sniper/          # Phase 0 micro-cap sniping satellite → data/sniper-metrics.db
│   ├── rug-alert/              # Rug Alert Service (19 Ago 2026) — detección proactiva multi-señal
│   │   ├── types.ts            # AlertEvent, AlertSeverity, AlertReason, IRugAlertService
│   │   ├── abis.ts             # RESERVES_ABI, ERC20_TRANSFER_ABI, ERC20_SUPPLY_ABI
│   │   ├── deduplication-map.ts# TTL configurable, case-insensitive, lazy expiry
│   │   ├── telegram-notifier.ts# Rate limit 10/5min, cola supresión max 50
│   │   ├── liquidity-monitor.ts# Polling 15s/5s, timeout 5s, RESERVE_POLL_FAILURE
│   │   ├── lp-removal-detector.ts # Transfer events en LP token, burn + removal
│   │   ├── large-holder-sell-detector.ts # Deployer + whale sells a DEX
│   │   ├── alert-dispatcher.ts # Pipeline: dedup → closePosition → RiskBucket → DB → TG
│   │   ├── rug-alert-service.ts# Orquestador principal, modo DEGRADED
│   │   └── index.ts            # API pública del módulo
│   ├── copy-trading/           # Copy-Trading Smart Money (COMPLETO — integrado en AgentCore)
│   │   ├── CopyTradingOrchestrator.ts  # Orquestador principal + RugAlertService integrado
│   │   ├── agent-integration.ts        # Adaptador para AgentCore (sin HTTP API, sin migraciones)
│   │   ├── bootstrap.ts                # Entrypoint standalone (con HTTP API + migraciones)
│   │   ├── config/CopyTradingConfig.ts # 13 vars de entorno COPY_*
│   │   ├── interfaces/types.ts         # CopySignal, CopyPosition, EnrichedSignal, etc.
│   │   ├── migrations/                 # SQL: copy_wallets, copy_signals, copy_positions, etc.
│   │   ├── modules/
│   │   │   ├── SmartMoneyCurator.ts    # 10-50 wallets, scoring, tiers S/A/B, re-eval 24h
│   │   │   ├── WalletWatcher.ts        # WebSocket + polling híbrido, decode calldata
│   │   │   ├── SignalEnricher.ts       # Liquidity, honeypot, tax, slippage, LP lock
│   │   │   ├── AntiBaitingModule.ts    # Detecta manipulación, bait flags, round-trips
│   │   │   ├── CopyExecutor.ts         # Position sizing dinámico, splits, delays anti-detect
│   │   │   ├── ExitManager.ts          # Follow insider, trailing stop, TP/SL/time, rug detect
│   │   │   ├── CopyTradingRiskManager.ts # Circuit breaker, 3 pos max, 20% capital/día
│   │   │   └── CopyMetricsRecorder.ts  # Persistencia señales+posiciones, restore on restart
│   │   ├── routes/copy.ts              # HTTP API: /copy/status, /copy/wallets, /copy/positions
│   │   └── tests/                      # 400+ tests unit + property-based (fast-check)
│   │   ├── rug-alert-service.ts# Orquestador principal, modo DEGRADED
│   │   └── index.ts            # API pública del módulo
│   ├── backtester/             # Replay histórico Binance candles → data/backtest-results/
│   ├── evolution/              # Strategy Evolution Lab (15 módulos) → data/evolution.db
│   │   └── funding-arb/       # Funding-arb simulator → data/funding.db
│   ├── strategies/
│   │   ├── trading/            # RiskManager, MultiSourceScanner, FeatureEngine, KillSwitch
│   │   ├── lending/            # AaveLendingModule (AutoLender DISABLED)
│   │   ├── services/           # x402 API services
│   │   ├── marketplace/        # MarketplaceIntegrator
│   │   ├── auto-generated/     # Código generado autónomamente por AdaptiveEvolver + tests
│   │   └── content/            # ContentGenerator
│   ├── self-mod/               # BackupManager, SandboxRunner, CodePatcher, AuditLogger
│   ├── research/               # Research Agent (segundo container)
│   ├── social/                 # TelegramClient, DiscordClient
│   ├── mcp/                    # 5 MCP servers + client + schemas
│   ├── payments/               # x402 protocol
│   └── config/                 # EnvValidator (Zod), Logger
├── investigacion/              # Inter-agent comms: proposals JSON + ACKs
├── data/                       # Configs SQLite locales
├── sql/                        # Esquemas Postgres/TimescaleDB
├── keys/                       # Wallet keystore cifrado (NO commitear)
├── .env                        # Secretos producción (NO commitear)
└── docker-compose.yml          # 3 services: agent(:3000/:3001), research(:3002), redis
```

---

## Auto-Implementación Autónoma — MÓDULO MÁS IMPORTANTE

El sistema que permite al agente escribir, testear y aplicar su propio código nuevo.

### Flujo end-to-end

```
ain-research escanea internet (cada 1-2h)
  → score ≥ 70 → escribe JSON en ./investigacion/{timestamp}_strategy_proposal_{uuid}.json
    → AgentCore.startResearchWatcher() detecta cada 30s (polling)
      → llama this.adaptiveEvolver.queueResearchProposal({
          opportunityId, title, source, estimatedRevenue, priority: 'P1'|'P2'|'P3'
        })
        → AdaptiveEvolver verifica rate limit PRIMERO (máx 3 / 24h)
        → drena queue → construye KnowledgeEntry (score P1=80, P2=70, P3=60)
        → llama LLM: genera TypeScript completo para src/strategies/auto-generated/xxx.ts
          → SelfModModule.proposeModification({ filePath: absolutePath, ... })
            → BackupManager.createBackup(filePath) — crea backup vacío si archivo no existe
            → SandboxRunner.runInSandbox():
                mkdir(dirname), writeFile(proposed)
                pnpm test --run src/strategies/auto-generated/  ← SOLO esta carpeta
                if originalContent === '' → unlink (era nuevo), else → restore
            → Si tests pasan → CodePatcher:
                mkdir(dirname) ← CRÍTICO para archivos nuevos
                writeFile(proposed) → audit log (status='applied')
            → Si tests fallan → rechaza, backup intacto
      → ACK escrito en ./investigacion/{file}_ack.json
      → DailyReport incluye sección 🧠 Auto-Implementación

AdaptiveEvolver timer (cada 1h) también evalúa KnowledgeAcquirer entries.
```

### Protecciones críticas implementadas

| Protección | Dónde | Qué hace |
|-----------|-------|---------|
| Rate limit primero | `adaptive-evolver.ts` | Verifica límite ANTES de drener queue — no pierde propuestas |
| Guard concurrencia | `evaluationInProgress` flag | Nunca dos evaluaciones en paralelo |
| Path absoluto | `adaptive-evolver.ts` | `resolve(process.cwd(), plan.targetFile)` antes de proposeModification |
| mkdir defensivo | `code-patcher.ts` + `sandbox-runner.ts` | Crea directorio padre antes de escribir |
| Backup de archivo nuevo | `backup-manager.ts` | Si ENOENT → crea backup vacío (no falla) |
| Sandbox aislado | `sandbox-runner.ts` | Solo `auto-generated/` — evita falsos negativos por tests de integración |
| Cleanup sandbox | `sandbox-runner.ts` | Si originalContent === '' → unlink (no deja archivos huérfanos) |
| Debounce queue | `debounceTimer` | Un solo setTimeout, se cancela en cada nueva propuesta |
| ACK correcto | `agent/index.ts` | Default `failed`, solo `implemented` si queueResearchProposal() OK |
| Memory cap | `processedFiles` Set | Max 1000 entradas (evita memory leak en larga duración) |

### Variables de entorno

```env
ADAPTIVE_EVOLVER_DRY_RUN=false        # false = aplica cambios reales (PRODUCCIÓN)
ADAPTIVE_EVOLVER_INTERVAL_MS=3600000  # evaluación timer (ms)
ADAPTIVE_EVOLVER_MAX_PER_CYCLE=1      # máx implementaciones por ciclo
ADAPTIVE_EVOLVER_MIN_SCORE=70         # score mínimo para intentar
```

### Test suite de auto-generated

`src/strategies/auto-generated/auto-generated.test.ts`:
- Detecta automáticamente todos los `.ts` del directorio (sin registro manual)
- Verifica que exportan una clase con `execute(): Promise<{success: boolean}>`
- Si no hay módulos → pasa trivialmente (no bloquea sandbox)

### AutonomousValidator Transpiler (CORREGIDO - Julio 2026)

**Ubicación:** `src/self-mod/autonomous-validator.ts`

El transpiler convierte TypeScript a JavaScript para validación en sandbox. Bugs corregidos:

| Bug | Pattern | Fix |
|-----|---------|-----|
| catch type annotation | `catch (error: any)` | `catch (error)` |
| class property declarations | `private provider: ethers.Provider;` | Línea eliminada |
| complex return types | `): Promise<{ success: boolean }>` | `) {` |
| temp directory | `/tmp/auto-validator` | `/app/data/temp-validator` (acceso a node_modules) |

**Directorio temporal:** Cambiado a `/app/data/temp-validator` porque `/tmp` no tiene acceso a `node_modules` dentro del container.

---

## ReAct Loop (ciclo cada 5 min)

```
PRE-CYCLE HOOKS:
  1. MultiSourceScanner → arbitraje entre 1inch/Paraswap/Uniswap
  2. FeatureEngine      → indicadores técnicos (Binance API)

TRIAGE (ModelRouter — DeepSeek V4 Flash):
  → "signal / wait / uncertain?"
  → wait → skip análisis completo (~$0.002 ahorrado)
  → signal → DeepSeek V4 Flash con contexto completo
  → signal → LLM completo

THINK (Claude Sonnet):
  → balance, tier, indicadores técnicos, oportunidades, rankings estrategias
  → retorna ActionPlan JSON

ACT (ActionDispatcher, max 10 concurrent):
  → trading, lending, services, social, marketplace, self-mod, heartbeat

OBSERVE → persiste en PostgreSQL/TimescaleDB

RESEARCH WATCHER (cada 30s, independiente del loop):
  → lee ./investigacion/*.json
  → llama adaptiveEvolver.queueResearchProposal()
  → escribe _ack.json

ADAPTIVE EVOLVER (timer 1h + immediate tras queue):
  → evalúa oportunidades
  → genera código → sandbox → aplica
```

---

## Trading Validation System

**Ubicación:** `src/trading-validation/` | 20+ módulos | Dual mode Shadow/Micro

### Módulos principales

| Módulo | Propósito |
|--------|---------|
| BankrollManager | $25 activo / $74.63 reserva, misma wallet |
| StrategyEngine | Trend Pullback + Mean Reversion, regime-aware |
| CostAwareTradeGate | 8+ criterios de rechazo |
| PositionSizer | Fórmula: risk_budget/stop_distance, $5-$10 |
| PreTradeSimulator | eth_call simulation antes de broadcast |
| TransactionManager | Mutex, persistent nonce, idempotent intents |
| ReconciliationEngine | 3 mismatches → KillSwitch |
| ExitManager | SL (1.5 ATR), TP (2.0 ATR), time-stop (8h), regime-exit |
| ShadowTrader | Paper trading con executable quotes |
| ExperimentTracker | Criterios Shadow Pass / Micro Pass |
| SafeModeController | Normal → SafeMode → KillSwitch |
| MarketDataManager | WebSocket + REST fallback, Binance |
| TradingOrchestrator | Pipeline event-driven completo |

### Módulos DESACTIVADOS durante trading validation

```typescript
export const DISABLED_MODULES = ['AdaptiveEvolver', 'SelfMod', 'Hyperliquid']
```
**NOTA:** `DISABLED_MODULES` es solo documentación — NO bloquea nada activamente.
AdaptiveEvolver corre independiente en AgentCore. Solo indica que no se debe
modificar código de trading-validation mientras hay experimento activo.

### Aave Lending — PERMANENTEMENTE DESACTIVADO

**Flag:** `AAVE_PERMANENTLY_DISABLED = true` en `src/agent/index.ts`

Cuando está activo:
- `aaveLending = null`
- `autoLender = null`
- `smartAutoLender = null`
- Log: `[AgentCore] ⛔ Aave lending PERMANENTLY DISABLED`

**Motivo:** El AutoLender re-depositaba fondos automáticamente sin permiso, lo cual interfería con el trading que necesita liquidez inmediata en wallet.

### Parámetros de riesgo (TUNED Julio 2026)

| Parámetro | Valor | Nota |
|-----------|-------|------|
| Max trade | $15 | Aumentado de $10 |
| Min trade | $5 | |
| Max pérdida/día | $5 | Aumentado de $3 |
| Max trades/día | 5 | |
| Max failed tx/día | 3 | |
| AI budget/día | $0.20 global | |
| Stop loss ATR | 2.2 × ATR | Aumentado de 1.8 |
| Take profit ATR | 2.5 × ATR | |
| **MIN Stop loss %** | **1.5%** | **NUEVO - Floor absoluto (era 1.0%)** |
| **MIN Take profit %** | **2.0%** | **NUEVO - Floor absoluto (era 1.2%)** |
| Max holding | 8 horas | |
| Cooldown entre trades | 30 min | Aumentado de 20 min |
| Volume Z threshold | 0.5 | Aumentado de 0.3 |

### Estrategias de Trading

| Estrategia | Régimen Óptimo | Win Rate (actual) | Notas |
|------------|----------------|-------------------|-------|
| trend_pullback | TRENDING_UP | 33.3% ⭐ | Mejor rendimiento |
| mean_reversion | RANGING | 0% | Solo en RANGING estricto |
| dip_buying | Cualquiera con soporte | 0% | Requiere EMA200 support |
| momentum_breakout | TRENDING_UP/VOLATILE | N/A | Requiere volumen > 0.8 Z |

### MACRO TREND FILTER (NUEVO - Julio 2026)

El sistema ahora incluye un filtro de tendencia macro que:
1. **Bloquea LONGs en downtrends claros** cuando EMA20 < EMA50 Y precio < EMA200
2. **En TRENDING_DOWN**, solo permite trades si RSI < 25 Y precio arriba de EMA200
3. **Reduce actividad** cuando tendencia es débil (EMA20 < precio)
4. **Requiere estructura alcista en 1h** para la mayoría de estrategias

---

## Hybrid Sniper (Phase 0) — SISTEMA COMPLETO ✅ (ACTUALIZADO 13 Agosto 2026)

**Ubicación:** `src/hybrid-sniper/` (8 archivos) | **DB:** PostgreSQL + TimescaleDB
**Tests:** `tests/hybrid-sniper/` (5 archivos, 61 tests — 61/61 pasando) ✅
**Auditoría completa:** `docs/SNIPER-ANALISIS-12-AGO-2026.md`

Satélite non-fatal activado en Step 5.5b del AgentCore.

---

### 🔄 FLUJO END-TO-END DEL SNIPER

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         HYBRID SNIPER PIPELINE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐  │
│  │   INGEST     │──▶│   VALIDATE   │──▶│   EXECUTE    │──▶│   MONITOR    │  │
│  │   SIGNAL     │   │   CONTRACT   │   │   VARIANTS   │   │   POSITIONS  │  │
│  └──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘  │
│        │                  │                   │                   │         │
│        ▼                  ▼                   ▼                   ▼         │
│  - DexScreener      - Pool Detection    - 3 Variantes       - Quote cada   │
│  - GeckoTerminal    - Honeypot Test     - Shadow Position     10 segundos  │
│  - Bitquery         - Tax Scanner       - Entry Price       - TP/SL/Time   │
│  - Webhook          - Liquidity Check   - TP/SL/TimeStop    - Close + PnL  │
│  - Dedup 60s        - Flag Scanner      - Record in DB      - Risk Bucket  │
│                     - LP Lock/Burn                          - Metrics DB   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### PASO 1: Signal Ingestor (`signal-ingestor.ts`)

**Objetivo:** Descubrir tokens nuevos en Base lo más rápido posible desde múltiples fuentes.

**4 Fuentes de Señales:**

| Fuente | Intervalo | Filtros Pre-Validación | Notas |
|--------|-----------|------------------------|-------|
| DexScreener | 30s | `volume.h1 > $10k` + `liquidity.usd >= $5k` | Token-boosts → token-profiles → search fallback |
| GeckoTerminal | 25s | `reserve_in_usd >= $10k` + `volume.h1 >= $500` | Free, no API key |
| Bitquery | 30s | Tokens nuevos (últimos 5 min) | Requiere API key pagada |
| Webhook | On-demand | Ninguno | POST /webhook/alpha |

**Optimizaciones Implementadas:**

1. **Pre-filtro de liquidez en DexScreener** ✅
   - Filtra `(p.liquidity?.usd ?? 0) >= 5_000` ANTES de enviar a validación
   - Reduce señales basura ~80% → menos llamadas RPC

2. **Dedup Window de 60 segundos**
   - Map<contractAddress, lastSeenMs> con purge automático
   - Evita procesar el mismo token múltiples veces

3. **Rate-limit handling graceful**
   - 429 de DexScreener → pausa 60s automática
   - 429 de GeckoTerminal → pausa 120s automática
   - 401/402/403 de Bitquery → desactiva para sesión

4. **Fallback cascada en DexScreener**
   ```
   token-boosts/latest/v1 → token-profiles/latest/v1 → search/?q=WETH+base
   ```

#### PASO 2: Contract Validator (`contract-validator.ts`)

**Objetivo:** Filtrar honeypots, scams, y tokens sin liquidez usando staticCall (0 gas).

**5 Validaciones Secuenciales:**

```typescript
// Orden de validación (falla rápido)
1. Pool Detection      → POOL_DETECTION_FAILED
2. Honeypot Test       → HONEYPOT_SELL1_ZERO / HONEYPOT_SELL2_ZERO
3. Tax Scanner         → SELL_TAX_EXCEEDED (>5%)
4. Liquidity Check     → INSUFFICIENT_LIQUIDITY (<$1k USDC OR <0.4 ETH)
5. Flag Scanner        → BLACKLISTED (isBlacklisted(agentAddress))
5.5. LP Lock/Burn      → UNVERIFIED_OR_UNLOCKED_LP (soft warning)
```

**Optimizaciones Implementadas:**

1. **Cache de Pool Tokens** ✅ (NUEVO 13 Agosto)
   - `poolTokenCache` con TTL de 1 hora
   - Reduce llamadas RPC de 5→3 por validación (~40% ahorro)
   - Pool tokens (token0/token1) nunca cambian

2. **Dual Quote Currency**
   - Detecta automáticamente si usar USDC o WETH
   - Muchos micro-caps solo tienen pool token/WETH

3. **Parallel Balance Checks**
   ```typescript
   const [poolUsdcBalance, poolWethBalance] = await Promise.all([
     usdcContract['balanceOf'].staticCall(poolAddress),
     wethContract['balanceOf'].staticCall(poolAddress),
   ]);
   ```

4. **Honeypot Test Completo**
   - Simula: Buy $5 → Sell 50% → Sell 50%
   - Detecta tokens que bloquean ventas o cobran impuestos ocultos

#### PASO 3: Multi-Variant Executor (`multi-variant-executor.ts`)

**Objetivo:** Explorar múltiples configuraciones de TP/SL/TimeStop en paralelo para encontrar parámetros óptimos.

**3 Variantes Activas (Probadas rentables):**

| Variante | TP | SL | TimeStop | Trade Size | Win Rate |
|----------|----|----|----------|------------|----------|
| balanced-large | 40% | 15% | 2h | $25 | **0%** (corregido) |
| conservative-1h | 25% | 8% | 1h | $15 | **0%** (corregido) |
| scalp-medium-1h | 20% | 10% | 1h | $10 | **0%** (corregido) |

**Variantes REMOVIDAS (0-31% WR):**
- Moon Bag 8h/24h (siempre hit SL)
- Balanced Micro $2 (muy pequeño)
- Swing variants (time stops inefectivos)

**Flujo de Apertura:**
```typescript
async openMultiVariantPositions(signal: SniperSignal): Promise<VariantPosition[]>
  1. Check maxTotalPositions (50 max)
  2. Get entryPrice ONCE (shared para fair comparison)
  3. Loop cada variante:
     - Check maxPositionsPerVariant (5 max)
     - Create position con TP/SL/TimeStop específicos
     - Record en PostgreSQL
     - Update metrics por variante
```

#### PASO 4: Shadow Executor (`shadow-executor.ts`)

**Objetivo:** Monitorear posiciones y cerrar en TP_HIT, SL_HIT, o TIME_STOP.

**Ciclo de Monitoreo (cada 10s):**
```typescript
async monitorPositions():
  for (const position of openPositions):
    currentPrice = await dexQuoter.quote(...)
    
    if (currentPrice > takeProfit)     → TP_HIT
    else if (currentPrice < stopLoss)  → SL_HIT
    else if (now > timeStop)           → TIME_STOP
    
    if (exitReason):
      closePosition(position, exitReason, currentPrice)
```

**Optimización TIME_STOP:** ✅ (NUEVO 13 Agosto)
- Aumentado de 2h a 4h para micro-caps
- Datos mostraban 27 posiciones con TIME_STOP a 2h sin mover precio
- 4h da más tiempo para que el pump ocurra

**Restauración de Posiciones:**
```typescript
async restoreOpenPositions(): // Llamado en start()
  - Lee posiciones OPEN de PostgreSQL
  - Cierra las que expiraron mientras container estaba down
  - Restaura las activas a memoria
```

#### PASO 5: DexQuoter (`dex-quoter.ts`)

**Objetivo:** Obtener precios de tokens via staticCall sin gastar gas.

**Cadena de Fallback:**
```
UniswapV3 (4 fee tiers) → Aerodrome (getAmountOut) → Direct Pool (reserves)
```

**Optimizaciones Implementadas:**

1. **Retry Logic con Backoff Exponencial**
   - MAX_RETRIES = 3
   - RETRY_DELAY_MS = 500ms × attempt
   - Solo retry en errores transient (timeout, 502, 503)

2. **Fee Tier Auto-Discovery**
   ```typescript
   const feeTiersToTry = [fee, 10_000, 3_000, 500, 100]; // Deduplicated
   ```

3. **Direct Pool Quote (Last Resort)**
   - Lee reserves + token0/token1
   - Calcula constant product con 0.3% fee

4. **Pool Type Cache**
   - Evita re-probing de pools ya detectados

---

### 📊 MÓDULOS Y SUS FUNCIONES

| Módulo | Archivo | Función Principal | Dependencias |
|--------|---------|-------------------|--------------|
| **SignalIngestor** | `signal-ingestor.ts` | Descubrir tokens nuevos | ContractValidator, MetricsRecorder |
| **ContractValidator** | `contract-validator.ts` | Filtrar honeypots/scams | DexQuoter, Provider |
| **MultiVariantExecutor** | `multi-variant-executor.ts` | Explorar parámetros | DexQuoter, RiskBucket, MetricsRecorder |
| **ShadowExecutor** | `shadow-executor.ts` | Monitorear posiciones | DexQuoter, RiskBucket, MetricsRecorder |
| **DexQuoter** | `dex-quoter.ts` | Obtener precios on-chain | Provider (ethers) |
| **RiskBucket** | `risk-bucket.ts` | Circuit breaker + budget | Ninguna (pure) |
| **MetricsRecorder** | `metrics-recorder.ts` | Persistir a PostgreSQL | pgPool |
| **ExplorationConfig** | `exploration-config.ts` | Definir variantes | Ninguna (config) |

---

### 🛡️ SISTEMA DE PREVENCIÓN Y MANEJO DE ERRORES

#### Prevención de Pérdidas

| Mecanismo | Ubicación | Protección |
|-----------|-----------|------------|
| Pre-filtro liquidez $5k | `signal-ingestor.ts` | Evita tokens sin liquidez |
| Honeypot test (buy+sell+sell) | `contract-validator.ts` | Detecta tokens que bloquean venta |
| Tax scanner (<5%) | `contract-validator.ts` | Rechaza high-tax tokens |
| LP Lock/Burn check | `contract-validator.ts` | Detecta posibles rugs |
| Circuit Breaker | `risk-bucket.ts` | Para tras 5 SL_HITs consecutivos |
| Max positions (50) | `multi-variant-executor.ts` | Limita exposición total |

#### Manejo de Errores RPC

| Error | Handling | Ubicación |
|-------|----------|-----------|
| Rate limit (429) | Pausa automática 60-120s | `signal-ingestor.ts` |
| Timeout | Retry 3x con backoff | `dex-quoter.ts` |
| Quote revert | Skip position (no loss) | `shadow-executor.ts` |
| Pool detection fail | POOL_DETECTION_FAILED | `contract-validator.ts` |
| Auth error (401/402) | Disable source for session | `signal-ingestor.ts` |

#### Fallbacks y Redundancia

| Sistema | Fallback |
|---------|----------|
| DexScreener | → token-profiles → search |
| UniswapV3 | → Aerodrome → Direct Pool |
| USDC liquidity | → WETH liquidity |
| Bitquery | → GeckoTerminal (free) |
| Position restore | → PostgreSQL on restart |

---

### 📈 MÉTRICAS Y OBJETIVOS ACTUALES

#### Estado del Sistema (13 Agosto 2026)

| Métrica | Valor Actual | Objetivo Mes 2 |
|---------|--------------|----------------|
| Pass Rate DexScreener | 9.55% | ≥5% ✅ |
| Trades micro-cap cerrados | 5,196 | ≥50 ✅ |
| Win Rate micro-cap | **0%** (corregido) | ≥40% ❌ |
| Días de data | 5 | ≥14 ⏳ |
| QUOTE_ERROR rate | 99.4% | <30% ❌ |

#### ~~Ganancias por Variante (simuladas)~~ CORREGIDO

**NOTA:** Los win rates del 100% eran FALSOS debido al bug de lógica invertida. Todos los trades fueron SL_HIT (pérdidas).

| Variante | PnL por Trade (CORREGIDO) | Win Rate |
|----------|---------------------------|----------|
| balanced-large $25 | ~-$100 (pérdida) | **0%** |
| conservative-1h $15 | ~-$30 (pérdida) | **0%** |
| scalp-medium-1h $10 | ~-$10 (pérdida) | **0%** |

#### Problema Principal: RPC Rate Limits

El cuello de botella actual es el rate limit de RPCs gratuitos:
- Alchemy: agotado
- Base público: 100 req/min limit
- Solución: rotar cuentas + cache de pools

---

### Variables de Entorno (ACTUALIZADAS 13 Agosto)

```env
# Sniper Core
SNIPER_ENABLED=true
SNIPER_RISK_BUDGET_USDC=15
SNIPER_TRADE_SIZE_USDC=5
SNIPER_MAX_LOSS_STREAK=5
SNIPER_TP_PCT=40
SNIPER_SL_PCT=15
SNIPER_POLL_INTERVAL_MS=30000
WALLET_ADDRESS=0xae36889c670CaA446bE18ECdC96f7c882e601D81

# API Keys
BITQUERY_API_KEY=                 # API v2 (streaming.bitquery.io)
RPC_PROVIDER_URL=                 # Base mainnet (Alchemy/Ankr)

# Thresholds (internos, no env vars)
# MIN_LIQUIDITY_USDC = $1,000
# MIN_LIQUIDITY_WETH = 0.4 ETH
# TIME_STOP = 4 horas (micro-caps)
# POOL_CACHE_TTL = 1 hora
```

---

### Próximos Pasos de Optimización

1. **Resolver RPC Rate Limits** (URGENTE)
   - Crear segunda cuenta Alchemy
   - Implementar rotación de RPCs

2. **Reducir QUOTE_ERROR Rate**
   - Actualmente 99.4% → objetivo <30%
   - Cache de pools ayudará significativamente

3. **Más Data para Evaluación**
   - Necesitamos 14+ días de trades
   - Actualmente 5 días

4. **Decisión Micro-Live**
   - Revisión: 22 Agosto 2026
   - Criterio: ≥40% WR en 50+ trades

---

## DailyReport (Telegram)

**Horas:** `[16, 23, 9]` UTC = **11am, 6pm, 4am Colombia** (UTC-5)

El reporte incluye 4 secciones:
1. Balance + yield + trades + costos LLM
2. `getPipelineSection()` — métricas del pipeline de trading
3. `getSniperSection()` — señales del HybridSniper
4. `getEvolverSection()` — implementaciones autónomas ✅ (nuevo)

Para conectar el AdaptiveEvolver al reporte:
```typescript
this.dailyReport.setAdaptiveEvolver(this.adaptiveEvolver);
```

El método `getRecentResults(10)` del evolver devuelve los últimos resultados con título, status, targetFile y error.

---

## Bases de Datos

| DB | Módulo | Notas |
|----|--------|-------|
| `data/agent.db` | AgentCore | Principal — wallet, observaciones, estrategias |
| `data/metrics.db` | PipelineMetrics | Observer del pipeline de trading |
| `data/sniper-metrics.db` | HybridSniper | Señales + latencia del sniper |
| `data/evolution.db` | EvolutionLab | Estrategias, variantes, backtests |
| `data/funding.db` | FundingArb | Simulaciones funding rate arb |
| `data/research.db` | ResearchAgent | Oportunidades descubiertas |

---

## External Services & API Keys

| Service | Purpose | Key location |
|---------|---------|-------------|
| **DeepSeek API** | Triage (V4 Flash) + Análisis (V4 Flash) + Código (V4 Pro) | `.env: OPENAI_API_KEY` (la key de DeepSeek va aquí) |
| Alchemy (Base) | RPC mainnet | `.env: RPC_PROVIDER_URL` |
| Alchemy (ETH) | ETH mainnet RPC | `.env: RPC_PROVIDER_URL_ETHEREUM` |
| Telegram Bot | @AINAgentBot — canal principal | `.env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID` |
| 1inch API | Cotizaciones DEX Base | `.env: ONEINCH_API_KEY` |
| Cloudflare Tunnel | URL permanente `niklauss.uk` | `.env: CLOUDFLARE_TUNNEL_TOKEN` |
| Bitquery | Tokens nuevos Base (plan free, 402 → desactiva silenciosamente) | `.env: BITQUERY_API_KEY` |
| OKX Dev Portal | SDK x402 pagos (Agent #6932) | `.env: OKX_DEV_API_KEY/SECRET/PASSPHRASE` |

---

## Comandos Docker (IMPORTANTE)

```bash
# ✅ CORRECTO — rebuild solo agent sin matar WiFi
docker compose up -d --build agent

# ❌ NUNCA usar — mata la red WiFi
docker compose build --no-cache
docker compose up --force-recreate

# Logs
docker logs ain-agent --tail 50
docker logs ain-research --tail 20

# Health check
curl http://localhost:3000/health
curl http://localhost:3000/sniper/status
curl http://localhost:3000/evolution/status
```

---

## Optimization Stack (3 capas LLM)

| Capa | Mecanismo | Ahorro |
|------|-----------|--------|
| CostOptimizer | LRU cache por hash de contexto (`getMetrics().hits`) | ~30% |
| ModelRouter | Triage DeepSeek V4 Flash → skip análisis si "wait" | ~60% |
| Adaptive interval | 5min idle / 1min cuando hay oportunidades | ~20% |
| **Combinado** | | **~70% reducción** |

---

## collectDailyMetrics() — Estado actual

```typescript
// Ya conectados:
cacheHits: this.costOptimizer?.getMetrics().hits ?? 0,  // ✅
tradesExecuted: bootstrap.experimentTracker.getReport().totalTrades,  // ✅

// Pendientes (sin fuente de datos disponible):
aaveYieldToday: 0n,       // requiere delta de posición Aave
signalsRejected: 0,       // requiere contador en RiskManager
```

---

## Flujo de comunicación entre containers

```
ain-research → escribe ./investigacion/{ts}_strategy_proposal_{uuid}.json
                    campo implementation: "// TODO: Implement strategy...\n// Source: X\n// Revenue: Y"

ain-agent watcher → lee cada 30s → extrae source y revenue con regex
                  → llama adaptiveEvolver.queueResearchProposal()
                  → escribe ./investigacion/{ts}_strategy_proposal_{uuid}_ack.json
                    { type: 'ack', originalId: uuid, status: 'implemented'|'failed', error }

ain-research CommsReader → lee los _ack.json → actualiza DB de research
```

---

---

## Copy-Trading Smart Money (19 Agosto 2026) — ACTIVO ✅

**Ubicación:** `src/copy-trading/` (13 archivos principales + tests)
**Tests:** 400+ tests (unit + property-based con fast-check) | **TypeScript:** 0 errores
**Integración:** AgentCore Paso 5.6 via `agent-integration.ts`

### Secuencia de arranque (AgentCore Paso 5.6)

```typescript
// src/agent/index.ts
if (process.env['COPY_TRADING_ENABLED'] === 'true') {
  const { buildCopyTradingForAgent } = await import('../copy-trading/agent-integration.js');
  this.copyTrading = await buildCopyTradingForAgent(process.env);
  await this.copyTrading.start();
}
// Shutdown en stop():
await this.copyTrading.gracefulShutdown();
```

### Flujo completo de una señal

```
WalletWatcher detecta swap (WebSocket/polling 2s, latencia <5s)
  → CopySignal { sourceWallet, tokenAddress, action, tradeAmountUsdc, entryPrice, txHash }
    → SignalEnricher.enrich() [timeout 2s]
       checks: liquidez≥$10k, honeypot, tax<5%, slippage<5%, LP lock≥50%
      → AntiBaitingModule.check()
         checks: deployer tokens, holder concentration, round-trips, volume footprint
        → delay 5-30s (anti-detección)
          → CopyExecutor.execute()
             positionSize = min(insider×10%, $100, capital×5%) × tierMultiplier
             splits si >$50, slippage dinámico 1%+0.5%/10K missing
            → ExitManager.registerPosition(pos)
               monitorea cada 5s: follow-insider, trailing-stop, TP+50%/SL-20%/48h
              → RugAlertService.trackPosition(pos, poolAddress, poolAddress)
                 detecta rug proactivamente en paralelo
```

### Modules

| Módulo | Responsabilidad |
|--------|----------------|
| `SmartMoneyCurator` | 10-50 wallets curadas. Criterios: WinRate≥70%, PnL≥$50k, Trades≥100. Tiers S/A/B. Re-eval 24h |
| `WalletWatcher` | WebSocket + polling híbrido. Decode calldata UniV3/Aerodrome/1inch. CopySignal emission |
| `SignalEnricher` | 7 validaciones. Primera falla = reject. Timeout 2s total |
| `AntiBaitingModule` | Blacklist deployers, bait flags (3 en 7 días → remove), volume footprint 5% max |
| `CopyExecutor` | Sizing con caps, splits, delays, staticCall pre-validación |
| `ExitManager` | FOLLOW_INSIDER (24h) → TRAILING_STOP (10% activation, 10% trailing). TP/SL/Time/RUG_PULL |
| `CopyTradingRiskManager` | Max 3 posiciones, 20% capital/día, CB 24h tras 3 losses o -15% PnL/día, 20% reserva |
| `CopyMetricsRecorder` | INSERT copy_signals + copy_positions. Restore on restart. Métricas por wallet/tier |

### Relación con RugAlertService

```
CopyTradingOrchestrator.processSignal()
  └── tras abrir posición:
      rugAlertService.trackPosition(shadowLike, pos.poolAddress, pos.poolAddress)

CopyTradingOrchestrator.handlePositionExit()
  └── antes de recordPositionClose:
      rugAlertService.untrackPosition(evt.positionId)

CopyTradingOrchestrator.gracefulShutdown()
  └── await rugAlertService.stop()
```

El objeto `shadowLike` mapea `CopyPosition → ShadowPosition`:
- `id → id`
- `tokenAddress → contractAddress`
- `entryPrice → entryPrice`
- `positionSizeUsdc × 1_000_000n → tradeSize`

### Variables de entorno clave

```env
COPY_TRADING_ENABLED=true               # Flag de activación en AgentCore
COPY_SEED_WALLETS=0xWallet1,0xWallet2  # Wallets smart money (CSV)
COPY_WS_RPC_URL=wss://...              # WebSocket RPC Base
COPY_HTTP_RPC_URL=https://...          # Fallback HTTP RPC
COPY_INITIAL_CAPITAL_USDC=500          # Capital inicial simulado
COPY_MAX_POSITION_USDC=100             # Cap por posición
COPY_RATIO=0.10                        # 10% del trade del insider
COPY_TP_PCT=50                         # Take profit %
COPY_SL_PCT=20                         # Stop loss %
COPY_MAX_CONCURRENT_POSITIONS=3        # Máximo posiciones abiertas
```

---

## Rug Alert Service (19 Agosto 2026) — NUEVO ✅

**Ubicación:** `src/rug-alert/` (10 archivos) | **DB:** tabla `alert_events` en PostgreSQL
**Tests:** 35 tests pasando (unit + property-based con fast-check) | **TypeScript:** 0 errores

Satélite non-fatal que protege **AMBOS sistemas**: HybridSniper (Paso 8.5 en `initHybridSniper()`) y CopyTrading (`CopyTradingOrchestrator` via `trackPosition/untrackPosition`). Si falla al iniciar, entra en modo DEGRADED (solo queda activo el heurístico `MAX_QUOTE_FAILURES`).

### Canales de detección

```
LiquidityMonitor    → polling cada 15s de reservas pool (5s si CRITICAL)
                       ≥50% y <80% drop → HIGH
                       ≥80% drop        → CRITICAL
                       3 fallos consec. → RESERVE_POLL_FAILURE (CRITICAL)

LpRemovalDetector   → suscripción Transfer events en LP token
                       ≥20% y <60% supply → HIGH
                       ≥60% supply       → CRITICAL

LargeHolderSellDet  → suscripción Transfer events en token
                       Deployer ≥10% y <30% supply → HIGH
                       Deployer ≥30% supply         → CRITICAL
                       Whale to DEX ≥20%            → WARNING
```

### Pipeline AlertDispatcher

```
Alert emitted
  → DeduplicationMap.isDuplicate()  → si duplicado → suppressedAlerts++, return
  → DeduplicationMap.register()
  → stats.counters++
  → WARNING? → solo log, return
  → position.status !== 'OPEN'? → log warning, return
  → DexQuoter.quote() con timeout 2s → exitPrice (0n si falla)
  → pnlUsdc = (entryPrice - exitPrice) / entryPrice * tradeSize
  → executor.closePosition() con timeout 500ms
  → riskBucket.onPositionClosed('RUG_PULL')
  → metricsRecorder.recordAlertEvent() (no bloquea si falla)
  → telegramNotifier.send()
  → positionsClosedByAlert++
```

### Endpoints

| Endpoint | Descripción |
|----------|-------------|
| `GET /sniper/rug-alerts` | `monitoredPositions`, `alertsEmitted` {WARNING/HIGH/CRITICAL}, `positionsClosedByAlert`, `lastAlertAt`, `degradedMode` |
| `GET /sniper/status` | Campo `rugAlerts` añadido al response existente |

### Variables de entorno

```env
RUG_ALERT_DEDUP_TTL_MS=120000    # TTL deduplication (default: 120s)
USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  # Base USDC
DEX_POOL_ADDRESSES=0x4752...,0x8909...  # Lista de DEX router/pool addresses
```

### Tabla alert_events (PostgreSQL)

```sql
CREATE TABLE IF NOT EXISTS alert_events (
  id               TEXT  NOT NULL PRIMARY KEY,
  contract_address TEXT  NOT NULL,
  severity         TEXT  NOT NULL,  -- 'WARNING' | 'HIGH' | 'CRITICAL'
  reason           TEXT  NOT NULL,
  detected_at      BIGINT NOT NULL,
  position_id      TEXT  NOT NULL,
  pnl_usdc         DOUBLE PRECISION,
  transaction_hash TEXT,
  created_at       BIGINT NOT NULL
);
```

---

## Historial de desarrollo

1. **Etapa 1 — Fundación (Mayo-Jun 2026):** ReAct Loop, Identity, SurvivalModule
2. **Etapa 2 — Revenue Attempts (Jun 2026):** x402, Social, Conway Cloud (caído)
3. **Etapa 3 — Arbitraje (Jun-Jul 2026):** MultiSourceScanner, fix bug decimales
4. **Etapa 4 — Spot Trading (Jul 2026):** Trading Validation (54 tareas, 750+ tests)
5. **Etapa 5 — Auto-Implementación (Jul 2026):** AdaptiveEvolver conectado, sandbox aislado, DailyReport integrado, 8 bugs corregidos en auditoría
6. **Etapa 6 — Optimización Trading (Jul 2026):**
   - Aave PERMANENTEMENTE desactivado (flag `AAVE_PERMANENTLY_DISABLED`)
   - MACRO TREND FILTER implementado (bloquea LONGs en downtrends)
   - Stops más amplios: min 1.5% SL, min 2.0% TP (antes 1.0%/1.2%)
   - Stop loss ATR: 2.2 (antes 1.8)
   - Cooldown: 30 min (antes 20 min)
   - Volume threshold: 0.5 (antes 0.3)
   - Transpiler de AdaptiveEvolver corregido (catch clauses, return types, class properties)
   - Primera implementación autónoma exitosa: "Integrate with: View AgentKey" ✅
   - Shadow Trader nonce fix (inicializa desde DB para evitar UNIQUE constraint)
7. **Etapa 7 — Hybrid Sniper Optimización (Ago 2026) ← ACTUAL:**
   - Multi-Variant Executor con 3 variantes probadas rentables
   - Pre-filtro liquidez $5k en DexScreener (-80% señales basura)
   - Cache de pool tokens con TTL 1h (-40% llamadas RPC)
   - TIME_STOP aumentado de 2h a 4h para micro-caps
   - Separación de métricas por signal_type (micro-cap vs established)
   - Restauración de posiciones al reiniciar container
   - Retry logic con backoff exponencial en DexQuoter
   - Fallback cascada: UniV3 → Aerodrome → Direct Pool
   - Documentación completa del flujo end-to-end
   - **FIX CRÍTICO (15 Ago 2026): Detección de Rug Pulls**
     - Corregido Win Rate falso del 99.5%
     - Nuevo status `RUG_PULL` con tracking de `quoteFailCount`
     - 3 fallos consecutivos de quote → cierra con -100% pérdida
     - RiskBucket ahora cuenta rug pulls como losses para Circuit Breaker
     - `restoreOpenPositions()` intenta precio real antes de asumir $0 PnL

**No funcionó:** Conway Cloud, x402 (sin clientes), arbitraje, Twitter ($100/mes), better-sqlite3 Node24
**Funciona:** FeatureEngine, ModelRouter (70% ahorro), Research Agent, Trading Validation, HybridSniper, AdaptiveEvolver, MultiVariantExecutor

---

## Trading Stats Actuales (Shadow Mode)

| Métrica | Valor | Notas |
|---------|-------|-------|
| Total trades | 20 | |
| Wins | 2 | |
| Losses | 18 | |
| Win Rate | 10% | Afectado por crash de mercado (-2.57% en 24h) |
| PnL Total | -$2.19 | |
| Mejor estrategia | trend_pullback (33.3%) | |
| Régimen actual | TRENDING_DOWN | Sistema correctamente NO operando |
| RSI actual | 34.1 | Zona oversold |

**Nota:** El bajo win rate se debe a:
1. Crash de mercado: ETH cayó ~$70 en 24h
2. Stops anteriores muy ajustados (1.0%)
3. Mean reversion en downtrend (estrategia incorrecta)

Las mejoras implementadas (macro filter + stops amplios) aún no tienen trades suficientes para evaluar.

---

## Research Agent — Fixes Agosto 2026

3 correcciones críticas al módulo de investigación (`src/research/`):

### Fix 1: Deduplicación mejorada
- Dedup anterior: título exacto (case-insensitive) → mismo artículo Medium aparecía 8+ veces
- Dedup nueva: `dedup_key` = `source_url::normalized_title_50chars` (sin caracteres especiales, whitespace colapsado)
- Cooldown de 24h por `source_url` para fuentes `content-platform`
- Max 1 deep-dive por categoría por ciclo (ahorro de tokens LLM)
- Archivos: `engine.ts` (métodos `computeDedupeKey()`, `deduplicate()`)

### Fix 2: Scanner health tracking
- Tabla nueva `scanner_health` en `research.db` (migración `002_scanner_health_and_revenue.sql`)
- Registra ok/failed por scanner por ciclo con error message y cycle_id
- Alerta Telegram si scanner falla 3+ ciclos consecutivos (`sendScannerFailureAlert()` en `alerts.ts`)
- Endpoint nuevo: `GET :3002/scanner-health`

### Fix 3: Revenue lifecycle
- Status anterior: ACK `implemented` → `implementada` inmediatamente (sin verificar ingresos reales)
- Status nuevo: ACK → `code_generated` → (24h) → `revenue_tracking` → (7 días) → `implementada` (con `actual_revenue` confirmado) o `failed_no_revenue`
- `RevenueChecker` automático cada 6 horas (en `engine.ts`)
- Las 18 "implementadas" legacy se migran automáticamente a `code_generated` al reiniciar
- Nuevos estados en `protocol.ts`: `code_generated`, `revenue_tracking`, `failed_no_revenue`
- Nuevas columnas en `opportunities`: `dedup_key`, `code_generated_at`, `revenue_check_at`, `actual_revenue`
- Endpoint nuevo: `GET :3002/revenue-status`

### Fix 4: Scoring discriminador (ROI-based)
- Nueva dimensión: `expectedRoi` (peso 25%) con rebalanceo (viability 25%, risk 20%, capital 15%, automation 15%).
- Filtra oportunidades de capital $0 que dejan pocos ingresos (<$5/mes).

### Fix 5 y 8: Caché de Deep Dives (Ahorro LLM)
- Caché en memoria con ventana de 48h en `ScoringEngine` para saltarse llamados al LLM sobre el mismo tema/noticia.

### Fix 6 y 7: Scanners resilientes
- **YouTube:** Reemplazado scraper bloqueado por Google News RSS de inteligencia artificial.
- **TikTok:** Reemplazado scraper (bloqueado por JS) por Google Trends RSS.
- **Medium:** RSS feed primario con HTML scraper en cascada de 7 selectores en caso de fallback.


---

## Child Projects (Proyectos Hijo Implementados)

Proyectos generados automáticamente por el módulo de oportunidades del agente.

### OmniAI-Engine

**Ubicación:** `../OmniAI-Engine/`  
**Puerto:** 3003  
**Estado:** ✅ Activo y publicando  
**Origen:** Oportunidades de contenido AI (score 79-92)  
**Canal YouTube:** NeuroSync AI  

Motor de contenido totalmente autónomo especializado en **Autismo e Inteligencia Artificial**.

**Arquitectura:**
```
OmniAI-Engine/
├── src/
│   ├── agents/           # SEOAgent (con deduplicación), AnalyticsEngine
│   ├── generators/       # ScriptGenerator, AudioGenerator, VideoRenderer, BlogGenerator, ThumbnailGenerator, AutonomousOrchestrator
│   ├── publishers/       # YouTubePublisher, BlogDispatcher
│   ├── auth/             # GoogleAuth (OAuth2 con refresh automático)
│   ├── reporters/        # TelegramReporter
│   ├── db/               # Database (SQLite con deduplicación de temas)
│   └── utils/            # Logger
├── content/              # Videos, audios, artículos generados, database.sqlite
├── oauth2.tokens.json    # Tokens YouTube (montado como volumen Docker)
└── docker-compose.yml
```

**Schedule (Cron - horario local):**
| Evento | Horario | Descripción |
|--------|---------|-------------|
| Blog diario | 6:00 AM | Artículo multi-plataforma (Hashnode, Medium, Dev.to) |
| Shorts Lun/Mié/Vie | 10am, 2pm, 6pm | YouTube Shorts trilingües (ES/EN/PT) |
| Documentales Mar/Jue/Sáb | 3:00 PM | Videos largos 8-10min (ES/EN/PT) |
| Reporte nocturno | 8:00 PM | Analytics + limpieza de archivos antiguos |

**OAuth2 YouTube - Refresh Automático:**
- `GoogleAuth.ts` verifica expiración al inicializar
- Si `access_token` expirado + `refresh_token` presente → refresh automático
- Tokens guardados en `oauth2.tokens.json` (persiste entre reinicios)
- Listener `on('tokens')` guarda nuevos tokens automáticamente

**Módulos clave:**
- `SEOAgent`: Genera títulos virales + 20 keywords con DeepSeek, retroalimentado por analytics, **con deduplicación de temas**
- `ScriptGenerator`: Guiones de 60s (shorts) y 8-10min (documentales) con hooks de 3 segundos y chapters
- `AudioGenerator`: Google Cloud TTS (voces Journey ES/EN/PT)
- `VideoRenderer`: Pexels API → FFmpeg → video final 1080p
- `ThumbnailGenerator`: Genera thumbnails personalizados con Puppeteer + Pexels
- `YouTubePublisher`: Upload con OAuth2, thumbnail automático, #Shorts tag, categoryId=27 (Education)
- `BlogDispatcher`: Publicación simultánea a 3 plataformas
- `Database`: SQLite con sistema de deduplicación de temas (topicHash)

**Optimizaciones SEO (Agosto 2026):**
- ✅ Thumbnails personalizados (Pexels + Puppeteer, texto Montserrat 900, keywords en cyan)
- ✅ Hook de 3 segundos en todos los scripts para retención
- ✅ Videos largos 8-10 min (antes 3-5 min) para mid-roll ads
- ✅ Timestamps/chapters automáticos en descripción
- ✅ #Shorts tag automático para clasificación correcta
- ✅ Títulos validados < 60 caracteres
- ✅ Videos públicos por default (antes private)
- ✅ **NUEVO: Deduplicación de temas** - Evita repetir contenido

**Sistema de Deduplicación de Temas (NUEVO):**
- BD extendida con columnas: `rawTopic`, `topicHash`, `keywords`, `videoType`
- SEOAgent carga últimos 50 temas antes de generar nuevo contenido
- Hash MD5 normalizado para detectar temas similares ("IA y autismo" == "autismo e IA")
- Reintenta hasta 3 veces si detecta duplicado
- Escala a cientos de videos sin repetir temas

**Ejecutar:**
```bash
cd ../OmniAI-Engine
docker-compose up -d --build
```

**Monitoreo:**
- Dashboard: http://localhost:3003/logs
- Errores: http://localhost:3003/logs/errors
- Telegram: Comparte bot con ain-agent

**Test de autenticación:**
```bash
cd ../OmniAI-Engine
node test-youtube-auth.mjs
```

**Verificar temas guardados:**
```bash
docker exec omniai-engine sqlite3 /usr/src/app/content/database.sqlite \
  "SELECT title, topicHash FROM published_videos ORDER BY publishedAt DESC LIMIT 10"
```

**Oportunidades implementadas:** 17 (IDs en `docs/CHILD_PROJECTS.md`)

**Stats actuales (4 agosto 2026):**
- Videos publicados: 2
- Artículos publicados: 10+
- Suscriptores: 0 (canal nuevo)
- OAuth: ✅ Funcionando con refresh automático
- SEO: ✅ Auditoría completa implementada
- Deduplicación: ✅ Sistema activo para evitar temas repetidos

**Documentación:**
- Auditoría SEO: `../OmniAI-Engine/docs/AUDITORIA-SEO-YOUTUBE.md`
- Expectativas: `./docs/EXPECTATIVAS-MODULOS-2026.md`

---

*Documento generado para Kiro, Claude, Cursor, Windsurf y similares*
*Última actualización: 2026-08-13 — Documentación completa Hybrid Sniper + Optimizaciones*

### Fix (10 Agosto 2026): ain-agent (Sniper) - Auto-Recuperación de JsonRpcProvider
- **Problema:** Al perder conexión brevemente, la librería ethers.js (JsonRpcProvider) entraba en un "bucle ciego" (getaddrinfo ENOTFOUND) y no lograba recuperar la sincronización con la blockchain al volver el internet.
- **Solución:** Se implementó un "RPC Watchdog" en AgentCore.start() que monitorea la conexión del nodo mediante peticiones HTTP directas. Si el ping falla por 3 minutos consecutivos, el agente aborta intencionalmente con process.exit(1), lo que obliga al gestor de contenedores (Docker) a revivirlo instantáneamente con una conexión limpia a la red, solucionando el bloqueo permanente.

---

## 📊 ANÁLISIS CRÍTICO SNIPER — 11 Agosto 2026

> **Ver documento completo:** `docs/SNIPER-ANALISIS-11-AGO-2026.md`

### Estado: ⏳ NO LISTO para "Mes 2 (Micro-Live)"

**Problema identificado:** 100% de trades cerrados eran de pares establecidos (WETH/DAI), NO micro-caps reales.

| Tipo | Trades | Win Rate | PnL | Relevancia |
|------|--------|----------|-----|------------|
| established | 4,134 | 100% | +$133,955 | ❌ NO ÚTIL |
| micro-cap | 27 OPEN | N/A | N/A | ✅ RELEVANTE |

**Correcciones implementadas (11 Agosto 2026):**

1. **Separación de métricas por `signal_type`:**
   - Nueva columna en `shadow_positions`
   - Auto-detección: WETH/DAI/USDC → established, resto → micro-cap
   - Script `analyze-sniper-metrics.mjs` actualizado

2. **Reducción de threshold de liquidez:**
   - `MIN_LIQUIDITY_USDC`: $3,000 → $1,000
   - **NUEVO:** `MIN_LIQUIDITY_WETH`: 0.4 ETH (~$1,500)
   - Acepta pools con liquidez en WETH (no solo USDC)

**Criterios para Mes 2:**
| Criterio | Requerido | Actual | Estado |
|----------|-----------|--------|--------|
| Trades micro-cap cerrados | ≥50 | 0 | ❌ |
| Win Rate micro-cap | ≥40% | N/A | ⏳ |
| Días de datos | ≥14 | 5 | ❌ |

**Verificación rápida:**
```bash
node analyze-sniper-metrics.mjs
# Buscar sección "MÉTRICAS POR TIPO DE TOKEN"
```

### Fix (12 Agosto 2026): Restauración de Posiciones al Reiniciar

- **Problema:** 27 posiciones micro-cap quedaron OPEN en DB pero nunca cerraban tras reiniciar container
- **Causa:** ShadowExecutor solo mantenía posiciones en memoria (Map), no restauraba de DB
- **Solución:** 
  - Nuevo método `restoreOpenPositions()` en ShadowExecutor
  - Se llama automáticamente en `start()` antes del monitoring loop  
  - Posiciones expiradas se cierran con TIME_STOP al restaurar
  - Nuevo método `getOpenPositions()` en MetricsRecorder

### Fix (12 Agosto 2026): Separación de Tablas Shadow

- **Problema:** Error `column "token_address" of relation "shadow_positions" does not exist`
- **Causa:** El `ShadowTrader` del trading-validation usaba la tabla `shadow_positions` del hybrid-sniper con esquema incompatible
- **Solución:** 
  - Creada nueva tabla `trading_shadow_positions` para el trading-validation
  - Archivo: `src/trading-validation/shadow-trader.ts` corregido para usar la nueva tabla
  - Migración: `sql/003_trading_shadow_positions.sql`

**Tablas de shadow trading (IMPORTANTE):**
| Tabla | Módulo | Esquema clave |
|-------|--------|---------------|
| `shadow_positions` | hybrid-sniper | contract_address, signal_type, entry_price, pnl_usdc |
| `trading_shadow_positions` | trading-validation | token_address, direction, close_price, pnl_usd |

**Verificación post-restart:**
```bash
docker logs ain-agent --tail 50 | findstr "restoreOpenPositions"
# Debe mostrar: "restoreOpenPositions: completed"

# Verificar que no hay errores de columna:
docker logs ain-agent --tail 100 | findstr "token_address column"
# No debe mostrar nada
```

### Estado Actualizado (12 Agosto 2026)

Las 27 posiciones micro-cap fueron cerradas manualmente con TIME_STOP (pnl=0).

| Tipo | Status | Count | PnL |
|------|--------|-------|-----|
| established | TP_HIT | 4,134 | +$133,955 |
| micro-cap | TIME_STOP | 27 | $0 |
| unknown | TP_HIT | 12 | +$379 |

**Nota:** El TIME_STOP con pnl=0 indica que no se obtuvo precio de salida real porque las posiciones expiraron mientras el container estaba reiniciado. A partir de ahora, con el fix de restauración, las posiciones se cerrarán correctamente.

---

## 🚀 OPTIMIZACIONES IMPLEMENTADAS — 13 Agosto 2026

### Resumen de Mejoras Prioritarias

| # | Mejora | Archivo | Impacto |
|---|--------|---------|---------|
| 1 | Pre-filtro liquidez $5k en DexScreener | `signal-ingestor.ts` | -80% señales basura |
| 2 | Cache de pools con TTL 1h | `contract-validator.ts` | -40% llamadas RPC |
| 3 | TIME_STOP 2h → 4h para micro-caps | `shadow-executor.ts` | Más tiempo para pump |

### Detalle de Implementaciones

#### 1. Pre-filtro de Liquidez en DexScreener

**Ubicación:** `src/hybrid-sniper/signal-ingestor.ts`

**Cambio:**
```typescript
// ANTES: Solo filtraba por chain y volumen
const basePairs = pairs.filter((p) => p.chainId === 'base' && p.volume?.h1 > 10_000);

// DESPUÉS: También filtra por liquidez mínima
const basePairs = pairs.filter((p) => 
  p.chainId === 'base' && 
  p.volume?.h1 > 10_000 &&
  (p.liquidity?.usd ?? 0) >= 5_000  // Pre-filter: min $5k liquidity
);
```

**Beneficio:** Reduce ~80% de señales que terminaban en INSUFFICIENT_LIQUIDITY o QUOTE_ERROR, ahorrando llamadas RPC costosas.

#### 2. Cache de Pool Tokens

**Ubicación:** `src/hybrid-sniper/contract-validator.ts`

**Cambio:**
```typescript
// NUEVO: Cache global de tokens de pool
interface PoolTokenCache {
  token0: string;
  token1: string;
  lastChecked: number;
}
const POOL_CACHE_TTL_MS = 3_600_000; // 1 hora
const poolTokenCache = new Map<string, PoolTokenCache>();

// En _detectQuoteCurrency():
const cached = poolTokenCache.get(poolKey);
if (cached && (now - cached.lastChecked) < POOL_CACHE_TTL_MS) {
  // Cache hit — skip RPC calls
  token0 = cached.token0;
  token1 = cached.token1;
} else {
  // Cache miss — make RPC calls + store in cache
  [token0, token1] = await Promise.all([pool['token0'](), pool['token1']()]);
  poolTokenCache.set(poolKey, { token0, token1, lastChecked: now });
}
```

**Beneficio:** Los tokens de un pool nunca cambian. Cachear por 1h reduce llamadas RPC de 5→3 por validación (~40% ahorro).

#### 3. TIME_STOP Extendido para Micro-Caps

**Ubicación:** `src/hybrid-sniper/shadow-executor.ts`

**Cambio:**
```typescript
// ANTES: 2 horas (7_200_000 ms)
const timeStop = signal.ingestionTime + 7_200_000;

// DESPUÉS: 4 horas (14_400_000 ms)
const timeStop = signal.ingestionTime + 14_400_000;
```

**Beneficio:** Los datos del 12 de agosto mostraron 27 posiciones cerrando con TIME_STOP a las 2h con $0 PnL — el precio no se había movido suficiente. Con 4h, hay más tiempo para que ocurra el pump típico de micro-caps.

### Verificación de Mejoras

```bash
# Ver logs del Sniper con las optimizaciones
docker logs ain-agent --tail 100 | findstr "sniper\|cache\|liquidity"

# Verificar métricas actuales
node analyze-sniper-metrics.mjs
```

### Resultados Observados (Post-Mejoras)

- TP_HITs constantes en variantes activas
- Ganancias por ciclo (~30s):
  - Balanced Large $25: ~$99.71 - $100.01
  - Conservative 1h $15: ~$29.95 - $30.00
  - Scalp Medium 1h $10: ~$9.99 - $10.00
- Latencia RPC: 600-900ms (aceptable)
- Container `ain-agent`: Running, healthy

---

## 🐛 FIX CRÍTICO #2: LÓGICA DE PRECIOS INVERTIDA — 15 Agosto 2026

### ⚠️ EL BUG REAL: El Simulador Operaba Completamente al Revés

Una **auditoría externa** reveló que el FIX #1 (detección de rug pulls) era correcto pero **NO ERA LA CAUSA PRINCIPAL** del 99.5% de win rate falso. El simulador estaba registrando PÉRDIDAS como GANANCIAS.

### La Causa Raíz REAL

El sistema usa `quote(USDC → TOKEN)` que retorna "cuántos TOKENS recibes por X USDC":
- Token **SUBE** de valor → recibes **MENOS** tokens por la misma USDC
- Token **BAJA** de valor → recibes **MÁS** tokens por la misma USDC

**EL BUG:** Todas las comparaciones y cálculos estaban **INVERTIDOS**:

| Componente | Bug | Fix |
|------------|-----|-----|
| TP calculation | `tokens * 1.40` (más tokens) | `tokens * 0.85` (menos tokens) |
| SL calculation | `tokens * 0.95` (menos tokens) | `tokens * 1.05` (más tokens) |
| TP comparison | `current > takeProfit` | `current < takeProfit` |
| SL comparison | `current < stopLoss` | `current > stopLoss` |
| PnL formula | `(exit - entry) / entry` | `(entry - exit) / entry` |

### Ejemplo del Bug

```
Token CRASH 50% (pierde la mitad de su valor):
  - $5 USDC compraba 1000 tokens
  - Ahora $5 USDC compra 2000 tokens (más tokens = token vale menos)
  
BUG ANTERIOR:
  - TP: 1000 * 1.40 = 1400 → 2000 > 1400 → TP_HIT! ← INCORRECTO
  - PnL: (2000-1000)/1000 = +100% ← Registró GANANCIA cuando perdió 50%

FIX APLICADO:
  - SL: 1000 * 1.05 = 1050 → 2000 > 1050 → SL_HIT! ← CORRECTO
  - PnL: (1000-2000)/1000 = -50% ← PÉRDIDA correcta
```

### Cambios Aplicados

1. **openPosition()** - TP/SL invertidos
2. **monitorPositions()** - Comparaciones invertidas
3. **_closePosition()** - PnL invertido: `(entryPrice - exitPrice) / entryPrice`
4. **restoreOpenPositions()** - Mismo fix de PnL

**Documentación completa:** `docs/FIXES-15-AGO-2026.md`

**⚠️ DATOS HISTÓRICOS CORREGIDOS:** Script `sql/fix-inverted-pnl.sql` ejecutado - todos los PnL invertidos y status recalculados. Backup en `shadow_positions_backup_20260815`.

**Resultados de la corrección:**
- Win Rate REAL: **0%** (no 99.9%)
- PnL Total: **-$1.25M** (no +$1.25M)
- Todos los trades fueron pérdidas - el sistema necesita revisión completa

---

## 🐛 FIX CRÍTICO #1: DETECCIÓN DE RUG PULLS — 15 Agosto 2026

### El Problema: Win Rate Falso del 99.5%

Se detectó que el **Win Rate de 99.5%** y **Profit Factor infinito** (0 Stop Losses) era **matemáticamente irreal** para micro-caps. Análisis del código reveló 3 bugs críticos que ocultaban pérdidas masivas.

### Los 3 Bugs Identificados

| Bug | Ubicación | Problema | Consecuencia |
|-----|-----------|----------|--------------|
| **#1** | `monitorPositions()` | Cuando `quote()` falla, código hace `continue;` | Posición queda OPEN hasta TIME_STOP, SL NUNCA se dispara |
| **#2** | `monitorPositions()` | Sin tracking de fallos consecutivos de quote | Rug pulls no detectados, posiciones "zombies" |
| **#3** | `restoreOpenPositions()` | Asigna `exitPrice = entryPrice` y `pnlUsdc = 0` | Oculta pérdidas masivas de posiciones expiradas |

### La Solución Implementada

- **MAX_QUOTE_FAILURES = 3** - Cierra como RUG_PULL tras 3 fallos consecutivos
- **_closePositionAsRugPull()** - Nuevo método, 100% pérdida
- **RiskBucket** maneja `'RUG_PULL'` como pérdida para Circuit Breaker

### Archivos Modificados (Ambos Fixes)

| Archivo | Cambios |
|---------|---------|
| `shadow-executor.ts` | FIX #1: quoteFailCount, RUG_PULL detection. FIX #2: TP/SL/PnL invertido |
| `risk-bucket.ts` | onPositionClosed() acepta 'RUG_PULL' |
| `metrics-recorder.ts` | ShadowPosition.status incluye 'RUG_PULL', quoteFailCount |

### ⚠️ IMPORTANTE: Datos Históricos Inválidos

**TODOS los datos de posiciones anteriores a este fix están INVERTIDOS** - las "ganancias" eran pérdidas y viceversa.

### Verificación

```bash
docker logs ain-agent --tail 200 | findstr "RUG_PULL"
docker logs ain-agent --tail 200 | findstr "TP_HIT\|SL_HIT"
```
