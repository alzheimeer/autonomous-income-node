# Design Document — Hybrid Sniper

## Overview

El módulo **Hybrid Sniper** es un satélite autónomo de alto riesgo dentro del agente AIN.
Opera exclusivamente en **Phase 0 Shadow Testing**: ingiere señales de tokens de micro-cap
en Base blockchain, valida matemáticamente los contratos (anti-honeypot, tax scanner,
liquidez, flags), abre posiciones simuladas con precios reales (QuoterV2 / Aerodrome vía
`staticCall`), y registra los resultados en una SQLite independiente.

**Filosofía de diseño:**
- Non-fatal: cualquier fallo de inicialización se captura con `try/catch` y no propaga.
- Aislado: base de datos propia (`data/sniper-metrics.db`), nunca toca `agent.db`.
- DEX-agnostic: soporte transparente para Uniswap V3 y Aerodrome (fork Solidly).
- Sin claves privadas: todas las cotizaciones usan `eth_call` (`staticCall`), cero gas real.
- Configurable: todos los parámetros de riesgo son variables de entorno con defaults sensatos.


## Architecture

### Diagrama de Componentes

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  AgentCore (src/agent/index.ts)                                              │
│                                                                               │
│  Step 5.5 — HybridSniper bootstrap (try/catch, non-fatal)                    │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │  initHybridSniper(env)  ──►  HybridSniperModule                       │   │
│  │  wireSniper(fastify, module)  ──►  Fastify routes                     │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  src/hybrid-sniper/                                                          │
│                                                                               │
│  ┌──────────────────┐   signal    ┌──────────────────┐                       │
│  │  SignalIngestor   │ ──────────► │ ContractValidator│                       │
│  │                  │             │                  │                       │
│  │  · DexScreener   │             │  · HoneypotTest  │                       │
│  │    polling 30s   │             │  · SellTax calc  │                       │
│  │  · Bitquery GQL  │             │  · Liquidity chk │                       │
│  │  · Webhook POST  │             │  · FlagScanner   │                       │
│  │  · Dedup 60s     │             │  · DEX detection │                       │
│  └──────────────────┘             └────────┬─────────┘                       │
│                                            │ ValidationResult                │
│                                            ▼                                 │
│                                   ┌──────────────────┐                       │
│                                   │  ShadowExecutor  │◄── RiskBucket         │
│                                   │                  │    · budget mgmt      │
│                                   │  · Open position │    · consecutiveLoss  │
│                                   │  · Price polling │    · CircuitBreaker   │
│                                   │  · TP/SL/TimeStop│    · env vars         │
│                                   └────────┬─────────┘                       │
│                                            │ position events                 │
│                                            ▼                                 │
│                                   ┌──────────────────┐                       │
│                                   │ MetricsRecorder  │                       │
│                                   │                  │                       │
│                                   │  sniper-metrics  │                       │
│                                   │  .db (SQLite WAL)│                       │
│                                   └──────────────────┘                       │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │  DexQuoter (DEX-agnostic)                                            │     │
│  │  · detectPoolType(address) → 'uniswap_v3' | 'aerodrome'            │     │
│  │  · quoteV3(params) via QuoterV2.quoteExactInputSingle (staticCall) │     │
│  │  · quoteAerodrome(params) via pool.getAmountOut (staticCall)        │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  Fastify HTTP (src/heartbeat/index.ts)                                       │
│                                                                               │
│  POST  /webhook/alpha     ← señales externas                                 │
│  GET   /sniper/status     ← últimas 10, latencia avg, estado CB              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Flujo de Datos End-to-End

```
1. SEÑAL ENTRA
   DexScreener poll / Bitquery GQL / POST /webhook/alpha
        │
        ▼
2. NORMALIZACIÓN (SignalIngestor)
   SniperSignal { id, ticker, contractAddress, source, ingestionTime }
   ↳ dedup check: mismo contractAddress en últimos 60s → DISCARD
        │
        ▼
3. VALIDACIÓN (ContractValidator)
   a) detectar tipo pool (UniswapV3 vs Aerodrome)
   b) HoneypotTest: staticCall buy(100%) → sell(50%) → sell(50%)
      ↳ sell1Out = 0 → HONEYPOT_SELL1_ZERO
      ↳ sell2Out = 0 → HONEYPOT_SELL2_ZERO
   c) sellTax = (expectedOut - actualOut) / expectedOut * 100
      ↳ sellTax > 5% → SELL_TAX_EXCEEDED
   d) liquidez USDC del pool < $10,000 → INSUFFICIENT_LIQUIDITY
   e) FlagScanner: isBlacklisted, maxTxAmount, maxWalletAmount, tradingActive
      ↳ isBlacklisted(agentAddress) = true → BLACKLISTED
   → ValidationResult { passed, rejectReason, validatedAt, latencyMs }
        │
        ▼ (si passed = true)
4. RISK CHECK (RiskBucket)
   ↳ CircuitBreaker activo (now < blockedUntil) → REJECT
   ↳ availableTrades = 0 → REJECT
        │
        ▼
5. SHADOW EXECUTION (ShadowExecutor)
   entryPrice = DexQuoter.quote(tradeSize)  ← staticCall, sin gas
   ShadowPosition {
     takeProfit = entryPrice * 1.15
     stopLoss   = entryPrice * 0.95
     timeStop   = ingestionTime + 7_200_000
   }
        │
        ▼
6. PRICE MONITORING (ShadowExecutor — polling loop)
   currentPrice = DexQuoter.quote(position) [cada 10s]
   ↳ currentPrice > takeProfit  → TP_HIT   → notify RiskBucket → reset consecutiveLosses
   ↳ currentPrice < stopLoss    → SL_HIT   → notify RiskBucket → consecutiveLosses++
   ↳ now > timeStop             → TIME_STOP → notify RiskBucket → reset consecutiveLosses
        │
        ▼
7. PERSISTENCIA (MetricsRecorder)
   sniper_signals: señal + resultado de validación + latencia
   shadow_positions: posición completa con PnL en USDC
```


## Components and Interfaces

### `HybridSniperModule` (index.ts)

Punto de entrada del módulo. Orquesta todos los componentes internos y expone
`initHybridSniper` / `wireSniper` al agente principal.

```typescript
// src/hybrid-sniper/index.ts

export interface HybridSniperConfig {
  enabled: boolean;
  rpcUrl: string;
  riskBudgetUsdc: number;         // default: 15
  tradeSizeUsdc: number;           // default: 5
  maxLossStreak: number;           // default: 2
  tpPct: number;                   // default: 15
  slPct: number;                   // default: 5
  dexscreenerPollIntervalMs: number; // default: 30_000
  bitqueryApiKey: string | null;
  dbPath: string;                  // default: 'data/sniper-metrics.db'
}

export interface HybridSniperModule {
  signalIngestor: SignalIngestor;
  contractValidator: ContractValidator;
  shadowExecutor: ShadowExecutor;
  riskBucket: RiskBucket;
  metricsRecorder: MetricsRecorder;
  config: HybridSniperConfig;
  isEnabled: boolean;
  stop(): void;
}

export async function initHybridSniper(
  env: Record<string, string | undefined>
): Promise<HybridSniperModule>;

export function wireSniper(
  fastify: FastifyInstance,
  module: HybridSniperModule
): void;
```


### `SignalIngestor` (signal-ingestor.ts)

```typescript
// src/hybrid-sniper/signal-ingestor.ts

export interface SniperSignal {
  id: string;                  // uuid v4
  ticker: string;
  contractAddress: string;     // checksum address
  source: 'dexscreener' | 'bitquery' | 'webhook';
  ingestionTime: number;       // Date.now() en ms, antes de cualquier validación
}

export interface DexScreenerPair {
  chainId: string;
  baseToken: { address: string; symbol: string };
  volume: { h1: number };
  liquidity: { usd: number };
}

export interface BitqueryToken {
  address: string;
  symbol: string;
  createdAt: string;
}

export interface WebhookBody {
  ticker: string;
  contractAddress: string;
  source: string;
}

export interface ISignalIngestor {
  /** Arranca el polling de DexScreener y Bitquery */
  start(): void;
  /** Para todos los loops de polling */
  stop(): void;
  /** Normaliza y despacha una señal al pipeline */
  ingestWebhook(body: WebhookBody): Promise<SniperSignal>;
  /** Expone el último estado para el endpoint de status */
  getStats(): { totalReceived: number; totalDeduped: number };
}
```

**Dedup:** Un `Map<string, number>` (contractAddress → lastSeenMs) actúa como ventana
deslizante de 60 segundos. Antes de cada procesamiento se purgan las entradas expiradas.

**DexScreener polling:**
- Endpoint: `GET https://api.dexscreener.com/token-boosts/latest/v1`
- Filtro: `chainId === 'base'` y `volume.h1 > 10_000`
- Máx. 20 pares por ciclo para no saturar el validator

**Bitquery GraphQL:**
- Endpoint: `https://streaming.bitquery.io/graphql`
- Header: `Authorization: Bearer {BITQUERY_API_KEY}`
- Query ejemplo:
```graphql
{
  EVM(network: base) {
    TokenSmartContract(
      where: { Block: { Time: { after: "{{5min_ago}}" } } }
      limit: { count: 10 }
    ) {
      SmartContract { Address }
      Currency { Symbol }
    }
  }
}
```


### `ContractValidator` (contract-validator.ts)

```typescript
// src/hybrid-sniper/contract-validator.ts

export interface ValidationResult {
  passed: boolean;
  rejectReason: string | null;   // null si passed = true
  validatedAt: number;           // Date.now() al finalizar todas las checks
  latencyMs: number;             // validatedAt - signal.ingestionTime
}

export type RejectReason =
  | 'HONEYPOT_SELL1_ZERO'
  | 'HONEYPOT_SELL2_ZERO'
  | 'SELL_TAX_EXCEEDED'
  | 'INSUFFICIENT_LIQUIDITY'
  | 'BLACKLISTED'
  | 'POOL_DETECTION_FAILED'
  | 'QUOTE_ERROR';

export type PoolType = 'uniswap_v3' | 'aerodrome';

export interface IContractValidator {
  validate(signal: SniperSignal): Promise<ValidationResult>;
}
```

**Detección de tipo de pool (DEX-agnostic):**

Para determinar si un pool es UniswapV3 o Aerodrome se intenta llamar a funciones
características de cada interfaz:

```
INTENTA: pool.fee()           → si OK: UniswapV3
INTENTA: pool.factory()       → si factory === AERODROME_FACTORY: Aerodrome
INTENTA: pool.getAmountOut(1, tokenIn)  → si OK: Aerodrome (Solidly interface)
FALLBACK: asumir UniswapV3
```

Constantes relevantes:
- `QUOTER_V2_ADDRESS = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a'` (ya en el proyecto)
- `AERODROME_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da'`


### `ShadowExecutor` (shadow-executor.ts)

```typescript
// src/hybrid-sniper/shadow-executor.ts

export interface ShadowPosition {
  id: string;                  // uuid v4
  signalId: string;
  contractAddress: string;
  entryPrice: bigint;          // precio en USDC 6-decimales (cotización real)
  takeProfit: bigint;          // entryPrice * (100 + tpPct) / 100
  stopLoss: bigint;            // entryPrice * (100 - slPct) / 100
  timeStop: number;            // ingestionTime + 7_200_000 ms
  tradeSize: bigint;           // SNIPER_TRADE_SIZE_USDC * 1_000_000n
  status: 'OPEN' | 'TP_HIT' | 'SL_HIT' | 'TIME_STOP';
  openedAt: number;
  closedAt: number | null;
  exitPrice: bigint | null;
  pnlUsdc: number | null;      // (exitPrice - entryPrice) / 1_000_000 en USDC float
}

export interface IShadowExecutor {
  openPosition(signal: SniperSignal): Promise<ShadowPosition | null>;
  /** Polling loop, llamado internamente cada 10 segundos */
  monitorPositions(): Promise<void>;
  getOpenPositions(): ShadowPosition[];
}
```

### `RiskBucket` (risk-bucket.ts)

```typescript
// src/hybrid-sniper/risk-bucket.ts

export interface CircuitBreakerState {
  active: boolean;
  blockedUntil: number | null;  // timestamp ms
  consecutiveLosses: number;
}

export interface IRiskBucket {
  /** Trades disponibles. 0 si CB activo o presupuesto agotado. */
  availableTrades(): number;
  /** Llamado por ShadowExecutor al cerrar una posición */
  onPositionClosed(result: 'TP_HIT' | 'SL_HIT' | 'TIME_STOP'): void;
  getState(): CircuitBreakerState;
  /** Reinicia el conteo de pérdidas (para testing / reset manual) */
  reset(): void;
}
```

### `MetricsRecorder` (metrics-recorder.ts)

```typescript
// src/hybrid-sniper/metrics-recorder.ts

export interface IMetricsRecorder {
  recordSignal(signal: SniperSignal, result: ValidationResult): void;
  recordPosition(position: ShadowPosition): void;
  getRecentSignals(limit: number): SignalRecord[];
  getAverageLatency(limit: number): number;
  close(): void;
}
```

### `DexQuoter` (dex-quoter.ts)

```typescript
// src/hybrid-sniper/dex-quoter.ts

export interface QuoteParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  poolAddress: string;
  fee?: number;   // solo para UniswapV3
}

export interface IDexQuoter {
  detectPoolType(poolAddress: string): Promise<PoolType>;
  quote(params: QuoteParams): Promise<bigint>;  // amountOut
}
```


## Data Models

### Schema SQLite — `data/sniper-metrics.db`

```sql
-- Tabla 1: Señales procesadas (validadas o rechazadas)
CREATE TABLE IF NOT EXISTS sniper_signals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id         TEXT NOT NULL,            -- uuid de la señal original
  contract_address  TEXT NOT NULL,
  ticker            TEXT NOT NULL,
  source            TEXT NOT NULL,            -- 'dexscreener' | 'bitquery' | 'webhook'
  ingestion_time    INTEGER NOT NULL,         -- ms UNIX
  validated_at      INTEGER NOT NULL,         -- ms UNIX
  total_latency_ms  INTEGER NOT NULL,         -- validated_at - ingestion_time
  passed            INTEGER NOT NULL,         -- 0 | 1 (SQLite boolean)
  reject_reason     TEXT,                     -- NULL si passed = 1
  result            TEXT,                     -- 'PASS' | 'FAIL'
  created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

-- Índices para consultas frecuentes
CREATE INDEX IF NOT EXISTS idx_signals_contract
  ON sniper_signals(contract_address, ingestion_time DESC);
CREATE INDEX IF NOT EXISTS idx_signals_created
  ON sniper_signals(created_at DESC);

-- Tabla 2: Posiciones shadow
CREATE TABLE IF NOT EXISTS shadow_positions (
  id                TEXT PRIMARY KEY,         -- uuid
  signal_id         TEXT NOT NULL,
  contract_address  TEXT NOT NULL,
  entry_price       TEXT NOT NULL,            -- bigint como string (6-decimal USDC)
  take_profit       TEXT NOT NULL,            -- bigint como string
  stop_loss         TEXT NOT NULL,            -- bigint como string
  time_stop         INTEGER NOT NULL,         -- ms UNIX
  trade_size        TEXT NOT NULL,            -- bigint como string
  status            TEXT NOT NULL DEFAULT 'OPEN',  -- 'OPEN'|'TP_HIT'|'SL_HIT'|'TIME_STOP'
  opened_at         INTEGER NOT NULL,         -- ms UNIX
  closed_at         INTEGER,                  -- NULL si OPEN
  exit_price        TEXT,                     -- bigint como string, NULL si OPEN
  pnl_usdc          REAL,                     -- float en USDC, NULL si OPEN
  created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_positions_status
  ON shadow_positions(status, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_positions_contract
  ON shadow_positions(contract_address);
```

**PRAGMAs aplicados al abrir:**
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
```

**Nota sobre bigint:** Los campos `entry_price`, `take_profit`, `stop_loss`, `trade_size`,
`exit_price` se almacenan como TEXT (string de bigint) para preservar precisión completa
en 256-bit integers. La conversión `BigInt(row.entry_price)` se aplica al leer.


## Lógica Detallada de Componentes Clave

### HoneypotTest — Pseudocódigo

El HoneypotTest simula una secuencia de compra + doble venta vía `staticCall` para
detectar contratos que bloquean ventas parciales o totales.

```
function honeypotTest(contractAddress, tradeSize, poolType, rpcProvider):
  
  STEP 1: Simular compra (USDC → TOKEN)
  ─────────────────────────────────────
  buyAmountOut = quote(
    tokenIn  = USDC_ADDRESS,
    tokenOut = contractAddress,
    amountIn = tradeSize,          // ej: 5_000_000 (5 USDC)
    poolType = poolType
  )  // via staticCall → no gas

  if buyAmountOut == 0:
    return ValidationResult { passed: false, rejectReason: "QUOTE_ERROR" }

  STEP 2: Primera venta (50% del buyAmountOut → USDC)
  ───────────────────────────────────────────────────
  sell1Amount = buyAmountOut / 2n

  sell1Out = quote(
    tokenIn  = contractAddress,
    tokenOut = USDC_ADDRESS,
    amountIn = sell1Amount,
    poolType = poolType
  )  // via staticCall

  if sell1Out == 0:
    return ValidationResult { passed: false, rejectReason: "HONEYPOT_SELL1_ZERO" }

  STEP 3: Segunda venta (50% restante → USDC)
  ────────────────────────────────────────────
  sell2Amount = buyAmountOut - sell1Amount   // maneja buyAmountOut impar

  sell2Out = quote(
    tokenIn  = contractAddress,
    tokenOut = USDC_ADDRESS,
    amountIn = sell2Amount,
    poolType = poolType
  )  // via staticCall

  if sell2Out == 0:
    return ValidationResult { passed: false, rejectReason: "HONEYPOT_SELL2_ZERO" }

  STEP 4: Calcular sellTax
  ────────────────────────
  totalOut = sell1Out + sell2Out
  // "expectedOut" = lo que deberíamos obtener sin impuesto
  // Aproximación: comprar buyAmountOut tokens y venderlos todos debería dar tradeSize
  expectedOut = tradeSize  // precio teórico de round-trip sin fees

  sellTax = (expectedOut - totalOut) * 100n / expectedOut   // en %
  // Nota: esto incluye el pool fee normal (~0.3%), el umbral de rechazo es 5%

  if sellTax > 5:
    return ValidationResult { passed: false, rejectReason: "SELL_TAX_EXCEEDED" }

  return { taxPct: sellTax, honeypotPassed: true }
```

**Nota sobre la implementación de `quote` por tipo de pool:**

```typescript
// UniswapV3: usa QuoterV2.quoteExactInputSingle
const params = {
  tokenIn, tokenOut, amountIn,
  fee: detectFee(poolAddress),   // 100 | 500 | 3000 | 10000
  sqrtPriceLimitX96: 0n
};
const [amountOut] = await quoterV2.quoteExactInputSingle.staticCall(params);

// Aerodrome (Solidly fork): usa pool.getAmountOut directamente
const amountOut = await aerodromePool.getAmountOut.staticCall(amountIn, tokenIn);
```

### Circuit Breaker — Pseudocódigo

```
state = {
  consecutiveLosses: 0,
  blockedUntil: null   // timestamp ms | null
}

function availableTrades(config):
  if state.blockedUntil !== null AND now() < state.blockedUntil:
    return 0   // CB activo

  if state.blockedUntil !== null AND now() >= state.blockedUntil:
    // Auto-reset al expirar
    state.blockedUntil = null
    state.consecutiveLosses = 0

  return floor(config.riskBudgetUsdc / config.tradeSizeUsdc)

function onPositionClosed(result):
  if result === 'SL_HIT':
    state.consecutiveLosses += 1
    if state.consecutiveLosses >= config.maxLossStreak:
      state.blockedUntil = now() + 86_400_000   // 24 horas
      logger.warn('[RiskBucket] CircuitBreaker ACTIVATED for 24h')
  else:  // TP_HIT | TIME_STOP
    state.consecutiveLosses = 0
```


## Variables de Entorno

| Variable                   | Default | Descripción                                           |
|----------------------------|---------|-------------------------------------------------------|
| `SNIPER_ENABLED`           | `false` | Activa el módulo. Debe ser exactamente `'true'`.      |
| `SNIPER_RISK_BUDGET_USDC`  | `15`    | Presupuesto lógico total en USDC.                     |
| `SNIPER_TRADE_SIZE_USDC`   | `5`     | Tamaño por trade en USDC.                             |
| `SNIPER_MAX_LOSS_STREAK`   | `2`     | Pérdidas consecutivas antes de activar CB.            |
| `SNIPER_TP_PCT`            | `15`    | Take Profit: porcentaje sobre precio de entrada.      |
| `SNIPER_SL_PCT`            | `5`     | Stop Loss: porcentaje bajo precio de entrada.         |
| `SNIPER_POLL_INTERVAL_MS`  | `30000` | Intervalo de polling DexScreener en ms.               |
| `BITQUERY_API_KEY`         | `""`    | API key de Bitquery. Vacío → Bitquery deshabilitado.  |

**Extracto para `.env.example`:**
```bash
# ─── Hybrid Sniper (satélite de micro-cap, Phase 0 Shadow Testing) ────────────
SNIPER_ENABLED=false
SNIPER_RISK_BUDGET_USDC=15      # Presupuesto lógico total en USDC
SNIPER_TRADE_SIZE_USDC=5        # Tamaño por trade en USDC
SNIPER_MAX_LOSS_STREAK=2        # Pérdidas consecutivas antes del Circuit Breaker
SNIPER_TP_PCT=15                # Take Profit %
SNIPER_SL_PCT=5                 # Stop Loss %
SNIPER_POLL_INTERVAL_MS=30000   # Intervalo de polling DexScreener (ms)
BITQUERY_API_KEY=               # API Key de Bitquery (dejar vacío para desactivar)
```


## Correctness Properties

*Una propiedad es una característica o comportamiento que debe cumplirse en todas las
ejecuciones válidas del sistema — una declaración formal sobre qué debe hacer el software.
Las propiedades sirven de puente entre especificaciones legibles por humanos y garantías
de corrección verificables automáticamente.*

### Property 1: Phase 0 invariant — sin transacciones reales

*Para cualquier* `SniperSignal` válida procesada por el pipeline completo (ingestión →
validación → shadow execution), el resultado nunca debe contener un hash de transacción
real (`txHash`) ni evidencia de que se haya emitido una llamada `eth_sendRawTransaction`
al RPC. Todas las cotizaciones se obtienen exclusivamente via `eth_call`.

**Validates: Requirements 1.5, 5.6**

---

### Property 2: Ordering invariant — ingestionTime siempre precede a validatedAt

*Para cualquier* señal procesada hasta su finalización, `signal.ingestionTime` debe ser
estrictamente menor o igual a `result.validatedAt`. El timestamp de ingestión se asigna
antes de cualquier llamada asíncrona al RPC.

**Validates: Requirements 2.6, 3.10, 4.1**

---

### Property 3: Latency calculation correctness

*Para cualquier* par `(ingestionTime, validatedAt)` donde `validatedAt >= ingestionTime`,
el campo `totalLatencyMs` almacenado en la base de datos debe ser exactamente igual a
`validatedAt - ingestionTime`. No se permite redondeo ni estimación.

**Validates: Requirements 4.1, 4.2**

---

### Property 4: Honeypot detection completeness

*Para cualquier* contrato token donde la simulación de la primera venta (`sell1Out`)
retorna `0n` via `staticCall`, el `ValidationResult` debe tener `passed = false` y
`rejectReason = 'HONEYPOT_SELL1_ZERO'`. Análogamente, si `sell2Out = 0n`, la razón debe
ser `'HONEYPOT_SELL2_ZERO'`. Si ambas son `0n`, prima la primera detección.

**Validates: Requirements 3.1, 3.2, 3.3**

---

### Property 5: Threshold consistency — sellTax y liquidez

*Para cualquier* par `(expectedOut, actualOut)` con `actualOut <= expectedOut` y
`expectedOut > 0n`, el `sellTax` calculado debe ser `(expectedOut - actualOut) * 100n / expectedOut`
como número entero de porcentaje. Si `sellTax > 5`, el resultado es `passed = false` con
`rejectReason = 'SELL_TAX_EXCEEDED'`. Si `sellTax <= 5`, no aplica este rechazo.

De forma análoga, *para cualquier* valor de liquidez `L` medido en USDC: si `L < 10_000`,
el resultado es `passed = false` con `rejectReason = 'INSUFFICIENT_LIQUIDITY'`.

**Validates: Requirements 3.4, 3.5, 3.6**

---

### Property 6: ShadowPosition TP/SL/TimeStop invariants

*Para cualquier* `entryPrice: bigint` con `tpPct` y `slPct` enteros positivos, la
`ShadowPosition` creada por el `ShadowExecutor` debe satisfacer:
- `takeProfit === entryPrice * BigInt(100 + tpPct) / 100n`
- `stopLoss === entryPrice * BigInt(100 - slPct) / 100n`
- `timeStop === signal.ingestionTime + 7_200_000`

Además, *para cualquier* posición abierta y precio de mercado `currentPrice`:
- Si `currentPrice > takeProfit` → cierre con `status = 'TP_HIT'`
- Si `currentPrice < stopLoss` → cierre con `status = 'SL_HIT'`
- Si `now > timeStop` → cierre con `status = 'TIME_STOP'`

**Validates: Requirements 5.1, 5.2, 5.3, 5.4**

---

### Property 7: Deduplicación idempotente

*Para cualquier* `contractAddress`, enviar la misma señal `N` veces dentro de una ventana
de 60 segundos debe producir exactamente `1` señal procesada en el pipeline de validación.
Las `N-1` señales restantes son descartadas silenciosamente.

**Validates: Requirement 2.5**

---

### Property 8: RiskBucket — cálculo de trades disponibles

*Para cualquier* par `(riskBudgetUsdc: number, tradeSizeUsdc: number)` con
`tradeSizeUsdc > 0`, el número de trades disponibles cuando el CircuitBreaker está
inactivo debe ser exactamente `Math.floor(riskBudgetUsdc / tradeSizeUsdc)`.

**Validates: Requirement 6.1**

---

### Property 9: CircuitBreaker — activación y bloqueo

*Para cualquier* secuencia de eventos de cierre de posición, si los últimos `N` cierres
consecutivos son todos `SL_HIT` y `N >= maxLossStreak`, entonces:
- `riskBucket.availableTrades() === 0`
- `circuitBreakerState.active === true`
- `circuitBreakerState.blockedUntil >= Date.now() + 86_400_000 - epsilon`

Cualquier cierre `TP_HIT` o `TIME_STOP` dentro de la secuencia resetea el contador a 0.

**Validates: Requirements 6.2, 6.3, 6.4, 6.5**

---

### Property 10: CircuitBreaker — auto-reset por tiempo

*Para cualquier* `RiskBucket` con CircuitBreaker activo (`blockedUntil = T`), cuando
se consulta `availableTrades()` con `now >= T`, el resultado debe ser mayor que 0 y el
estado del CB debe ser `active = false`, `consecutiveLosses = 0`.

**Validates: Requirement 6.6**

---

### Property 11: Persistencia de señales — round trip

*Para cualquier* `(SniperSignal, ValidationResult)` persitida por `MetricsRecorder`,
leer el registro con el mismo `signal_id` de `sniper_signals` debe retornar todos los
campos originales sin pérdida: `contract_address`, `source`, `ingestion_time`,
`validated_at`, `total_latency_ms`, `passed`, `reject_reason`, `result`.

**Validates: Requirements 4.2, 8.2, 8.4**


## Error Handling

### Degraded Mode — inicialización de SniperDB

Si `DatabaseSync` lanza al abrir `data/sniper-metrics.db`:

```typescript
try {
  this.db = new SniperDatabase('data/sniper-metrics.db');
} catch (err) {
  logger.error('[HybridSniper] SniperDB failed to open (degraded mode):', err);
  this.degraded = true;
  // El módulo continúa sin persistencia — las señales se procesan en memoria
  // pero no se registran. El endpoint /sniper/status retorna una lista vacía.
}
```

### Errores de red en SignalIngestor

- **DexScreener timeout/5xx**: El error se logea a nivel `warn`, el ciclo de polling
  continúa en el siguiente intervalo. No se propaga.
- **Bitquery error de autenticación (401)**: Se logea `warn` y se deshabilita el polling
  de Bitquery para la sesión actual. DexScreener y webhook continúan.
- **Webhook body inválido**: Responde HTTP 400 con `{ error: "contractAddress required" }`.
  No afecta al polling.

### Errores de RPC en ContractValidator

Si `staticCall` falla (nodo RPC no disponible, contrato sin código, revert):
- Se captura la excepción.
- Se retorna `ValidationResult { passed: false, rejectReason: 'QUOTE_ERROR' }`.
- Se logea a nivel `warn` con la dirección del contrato y el mensaje de error.
- El pipeline continúa con la siguiente señal.

### Errores en ShadowExecutor

Si la cotización del `entryPrice` falla al abrir una posición:
- La posición no se abre.
- Se logea `warn`.
- Se notifica al `RiskBucket` que la apertura fue omitida (no cuenta como pérdida).

### Errores de escritura en SniperDB

Las escrituras usan `try/catch` individuales. Un fallo de escritura solo se logea a
nivel `error`; nunca interrumpe el flujo de validación o shadow execution.

### Non-fatal en AgentCore

```typescript
// src/agent/index.ts — Step 5.5
try {
  if (this.env.SNIPER_ENABLED === 'true') {
    const { initHybridSniper, wireSniper } = await import('../hybrid-sniper/index.js');
    this.hybridSniper = await initHybridSniper(this.env);
    wireSniper(this.heartbeatModule!.fastify, this.hybridSniper);
    this.setModuleStatus('hybrid-sniper', 'healthy');
  }
} catch (err) {
  logger.error('[AgentCore] HybridSniper failed to start (non-fatal):', err);
  this.setModuleStatus('hybrid-sniper', 'unhealthy');
  // El agente principal continúa con normalidad
}
```


## Testing Strategy

### Evaluación de PBT para esta feature

El módulo HybridSniper contiene lógica de transformación pura con un espacio de inputs
grande (señales con múltiples campos, valores bigint, secuencias de eventos de posición),
lo que hace que PBT sea apropiado para las properties 1–11 identificadas arriba.

Las partes de integración (DexScreener polling, Bitquery GQL, RPC calls) se manejan con
tests de integración de 1-3 ejemplos con mocks.

### Librería de Property-Based Testing

**[fast-check](https://fast-check.dev/)** — TypeScript nativo, amplio soporte de
arbitrarios, mínimo 100 iteraciones por propiedad.

```bash
npm install --save-dev fast-check
```

### Tests de Propiedad (fast-check, mínimo 100 iteraciones)

Cada propiedad referencia su número de property del design con el tag:
`Feature: hybrid-sniper, Property N: <texto>`

```typescript
// tests/hybrid-sniper/properties.test.ts

import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

describe('hybrid-sniper — Correctness Properties', () => {

  // Property 2 & 3: Ordering invariant + Latency
  it('Property 2 & 3: ingestionTime <= validatedAt, latencyMs correcto', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1_000_000, max: Date.now() }),
      fc.nat({ max: 5000 }),  // ms de latencia
      (ingestionTime, delta) => {
        const validatedAt = ingestionTime + delta;
        const latencyMs = validatedAt - ingestionTime;
        expect(ingestionTime).toBeLessThanOrEqual(validatedAt);
        expect(latencyMs).toBe(delta);
      }
    ), { numRuns: 200 });
  });

  // Property 4: Honeypot detection
  it('Property 4: sell1Out=0 → HONEYPOT_SELL1_ZERO', () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 1n, max: 1_000_000_000n }),  // buyAmountOut
      (buyAmountOut) => {
        const result = evaluateHoneypotResult({
          sell1Out: 0n, sell2Out: 100n, buyAmountOut
        });
        expect(result.passed).toBe(false);
        expect(result.rejectReason).toBe('HONEYPOT_SELL1_ZERO');
      }
    ), { numRuns: 100 });
  });

  // Property 5: sellTax threshold
  it('Property 5: sellTax > 5 → SELL_TAX_EXCEEDED', () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 1000n, max: 1_000_000_000n }),  // expectedOut
      fc.float({ min: 0.051, max: 0.99 }),              // factor de pérdida
      (expectedOut, lossFactor) => {
        const actualOut = BigInt(Math.floor(Number(expectedOut) * (1 - lossFactor)));
        const tax = Number((expectedOut - actualOut) * 100n / expectedOut);
        const result = evaluateTaxResult(expectedOut, actualOut);
        if (tax > 5) {
          expect(result.passed).toBe(false);
          expect(result.rejectReason).toBe('SELL_TAX_EXCEEDED');
        }
      }
    ), { numRuns: 200 });
  });

  // Property 6: TP/SL/TimeStop calculations
  it('Property 6: ShadowPosition TP/SL/TimeStop son correctos', () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 1_000_000n, max: 100_000_000n }),  // entryPrice (6 dec USDC)
      fc.integer({ min: 1, max: 50 }),  // tpPct
      fc.integer({ min: 1, max: 49 }),  // slPct
      fc.integer({ min: 1_700_000_000_000, max: Date.now() }),  // ingestionTime
      (entryPrice, tpPct, slPct, ingestionTime) => {
        const pos = computePositionParams(entryPrice, tpPct, slPct, ingestionTime);
        expect(pos.takeProfit).toBe(entryPrice * BigInt(100 + tpPct) / 100n);
        expect(pos.stopLoss).toBe(entryPrice * BigInt(100 - slPct) / 100n);
        expect(pos.timeStop).toBe(ingestionTime + 7_200_000);
      }
    ), { numRuns: 200 });
  });

  // Property 7: Deduplicación
  it('Property 7: N señales idénticas en <60s → exactamente 1 procesada', () => {
    fc.assert(fc.property(
      fc.hexaString({ minLength: 40, maxLength: 40 }),  // contractAddress
      fc.integer({ min: 2, max: 10 }),                   // N duplicados
      (contractAddress, n) => {
        const dedup = new DedupWindow(60_000);
        let processed = 0;
        const baseTime = Date.now();
        for (let i = 0; i < n; i++) {
          if (dedup.shouldProcess(contractAddress, baseTime + i * 100)) {
            processed++;
          }
        }
        expect(processed).toBe(1);
      }
    ), { numRuns: 200 });
  });

  // Property 8: RiskBucket availableTrades
  it('Property 8: availableTrades = floor(budget / tradeSize)', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 1000 }),  // budget USDC
      fc.integer({ min: 1, max: 100 }),   // tradeSize USDC
      (budget, tradeSize) => {
        const bucket = new RiskBucket({ riskBudgetUsdc: budget, tradeSizeUsdc: tradeSize, maxLossStreak: 2 });
        expect(bucket.availableTrades()).toBe(Math.floor(budget / tradeSize));
      }
    ), { numRuns: 200 });
  });

  // Property 9: CircuitBreaker activation
  it('Property 9: N SL_HITs consecutivos activan CB cuando N >= maxLossStreak', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 5 }),  // maxLossStreak
      fc.integer({ min: 0, max: 5 }),  // N SL_HITs
      (maxLossStreak, slCount) => {
        const bucket = new RiskBucket({ riskBudgetUsdc: 15, tradeSizeUsdc: 5, maxLossStreak });
        for (let i = 0; i < slCount; i++) {
          bucket.onPositionClosed('SL_HIT');
        }
        if (slCount >= maxLossStreak) {
          expect(bucket.availableTrades()).toBe(0);
          expect(bucket.getState().active).toBe(true);
        } else {
          expect(bucket.getState().active).toBe(false);
        }
      }
    ), { numRuns: 300 });
  });

  // Property 10: CB auto-reset
  it('Property 10: CB se desactiva automáticamente cuando now >= blockedUntil', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 5 }),  // maxLossStreak
      (maxLossStreak) => {
        const bucket = new RiskBucket({ riskBudgetUsdc: 15, tradeSizeUsdc: 5, maxLossStreak });
        for (let i = 0; i < maxLossStreak; i++) bucket.onPositionClosed('SL_HIT');
        expect(bucket.getState().active).toBe(true);
        // Avanzar reloj mock más allá de blockedUntil
        bucket._overrideNow(bucket.getState().blockedUntil! + 1);
        expect(bucket.availableTrades()).toBeGreaterThan(0);
        expect(bucket.getState().active).toBe(false);
      }
    ), { numRuns: 100 });
  });

  // Property 11: DB round trip
  it('Property 11: señal persistida y leída es idéntica al original', () => {
    fc.assert(fc.property(
      fc.record({
        contractAddress: fc.hexaString({ minLength: 40, maxLength: 40 }),
        source: fc.constantFrom('dexscreener', 'bitquery', 'webhook'),
        ingestionTime: fc.integer({ min: 1_700_000_000_000, max: Date.now() }),
        passed: fc.boolean(),
        rejectReason: fc.option(fc.constantFrom('HONEYPOT_SELL1_ZERO', 'SELL_TAX_EXCEEDED', 'INSUFFICIENT_LIQUIDITY')),
        totalLatencyMs: fc.nat({ max: 5000 }),
      }),
      (data) => {
        const db = new SniperDatabase(':memory:');
        const recorder = new MetricsRecorder(db);
        recorder.recordSignal(buildSignal(data), buildResult(data));
        const rows = recorder.getRecentSignals(1);
        expect(rows[0].contract_address).toBe(data.contractAddress.toLowerCase());
        expect(rows[0].passed).toBe(data.passed ? 1 : 0);
        expect(rows[0].total_latency_ms).toBe(data.totalLatencyMs);
      }
    ), { numRuns: 150 });
  });
});
```

### Tests de Ejemplo (Vitest)

Tests para comportamientos de casos específicos y rutas HTTP:

- `initHybridSniper` con `SNIPER_ENABLED=false` → módulo inactivo, sin DB
- `initHybridSniper` con DB path inválido → degraded mode, no lanza
- `POST /webhook/alpha` sin `contractAddress` → HTTP 400
- `POST /webhook/alpha` con body válido → HTTP 200 + señal creada
- `GET /sniper/status` → retorna estructura `{ signals, avgLatencyMs, circuitBreaker }`
- `GET /sniper/status` con `SNIPER_ENABLED=false` → HTTP 503
- Pool Uniswap V3 mock → `detectPoolType` retorna `'uniswap_v3'`
- Pool Aerodrome mock → `detectPoolType` retorna `'aerodrome'`
- `isBlacklisted = true` → ValidationResult `passed = false, rejectReason = 'BLACKLISTED'`

### Tests de Integración (1-3 ejemplos, mocks de RPC)

- DexScreener polling: mock HTTP, verificar endpoint correcto y filtro `chainId = 'base'`
- Bitquery polling: mock GraphQL, verificar auth header y query correcta
- QuoterV2 `staticCall`: mock ethers provider, verificar que se emite `eth_call` (no `eth_sendRawTransaction`)
- Aerodrome `staticCall`: mock del pool Solidly, verificar que usa `getAmountOut`

