# Análisis Quant Trading Architect Senior
## Pivote Estratégico y Especificación Técnica de Implementación
**Fecha:** 16 Agosto 2026  
**Autor:** Kiro (Quant Trading Architect Senior & DeFi Infrastructure Specialist)

---

# RESUMEN EJECUTIVO

Tras auditar 30,285 trades con **0.25% win rate** y **-$1.25M PnL**, el sistema actual de micro-cap sniping es **inviable sin infraestructura de $50-200K/año**. Este documento presenta:

1. **Reevaluación del Stack Tecnológico** (TypeScript vs Go/Rust)
2. **Análisis AWS vs Bare Metal vs Local** para copy-trading y arbitraje
3. **Proyección Cuantitativa** de Grid Trading con $500-$2,000 USD
4. **Especificación Técnica Completa** para Copy-Trading de Smart Money

---

# 1. REEVALUACIÓN DEL STACK TECNOLÓGICO

## 1.1 Stack Actual
```
Runtime:       Node.js 20+ (TypeScript)
Packages:      ethers.js v6, axios, fastify, pg, ioredis, zod
DB:            PostgreSQL + SQLite (degraded mode)
Quotes:        staticCall via JSON-RPC (Uniswap V3 QuoterV2 + Aerodrome)
Latencia:      ~50-200ms end-to-end (polling + quote + log)
```

## 1.2 Análisis Comparativo: TypeScript vs Go vs Rust


| Componente | TypeScript | Go | Rust | **VEREDICTO** |
|------------|------------|-----|------|---------------|
| **SignalIngestor** (HTTP polling) | ✅ Adecuado | ✅ Marginal mejora | ⚠️ Overkill | **TypeScript** - I/O bound, no CPU bound |
| **WebSocket Listener** (mempool) | ⚠️ ws lib async | ✅ goroutines | ✅ tokio | **Go** si se escala a >100 wallets |
| **Calldata Decoder** (swap decode) | ⚠️ ethers.js lento | ✅ go-ethereum | ✅ alloy-rs | **Rust** si <5ms importa |
| **Execution Engine** (bundle/sign) | ✅ ethers.js | ✅ go-ethereum | ✅ ethers-rs | **TypeScript** - no es cuello de botella |
| **Risk Engine** (TP/SL/sizing) | ✅ Perfecto | ✅ | ✅ | **TypeScript** - lógica pura, cero latencia crítica |
| **DB Layer** (pg/metrics) | ✅ pg driver | ✅ | ✅ | **TypeScript** - I/O bound |

### 1.2.1 Recomendación de Migración Selectiva

```
┌─────────────────────────────────────────────────────────────────┐
│ MANTENER EN TYPESCRIPT (90% del código)                        │
├─────────────────────────────────────────────────────────────────┤
│ • RiskBucket, MetricsRecorder, MultiVariantExecutor            │
│ • SignalIngestor (polling HTTP - no hay ganancia en Go/Rust)   │
│ • Fastify API routes                                           │
│ • PostgreSQL persistence layer                                 │
│ • Toda la lógica de negocio                                    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ CONSIDERAR MICROSERVICIO EN GO (solo si se escala)             │
├─────────────────────────────────────────────────────────────────┤
│ • WebSocket mempool streamer (100+ wallets simultáneas)        │
│ • gRPC server para recibir eventos de Yellowstone              │
│ • Ventaja: goroutines manejan miles de conexiones concurrentes │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ RUST: INNECESARIO PARA ESTE CASO DE USO                        │
├─────────────────────────────────────────────────────────────────┤
│ • Copy-trading NO requiere latencia <1ms                       │
│ • Los 5-15 segundos de delay en copy son inherentes al mempool │
│ • Compilación compleja, desarrollo 3x más lento               │
│ • ROI negativo salvo que compitamos en MEV puro                │
└─────────────────────────────────────────────────────────────────┘
```

**VEREDICTO STACK:** Mantener TypeScript. Optimizar con worker threads para parsing paralelo si es necesario. No hay ROI en reescribir.


---

# 2. INFRAESTRUCTURA: LOCAL vs AWS vs BARE METAL

## 2.1 Análisis de Latencia por Deployment

| Deployment | Latencia RPC | Costo Mensual | Ventaja |
|------------|--------------|---------------|---------|
| **Local (actual)** | 50-100ms | $0 + electricidad | Cero costo fijo |
| **AWS c6in.large** (us-east-1) | 15-30ms | ~$120/mes | Menor latencia a nodos US |
| **AWS c7g.medium** (eu-west-1) | 20-40ms | ~$80/mes | Cerca de validadores EU |
| **Bare Metal** (Hetzner AX42) | 10-20ms | ~$50/mes | Mejor precio/rendimiento |
| **Colocated** (en DC de validador) | 1-5ms | $500-2000/mes | Solo para MEV competitivo |

## 2.2 RPCs: Gestionados vs Nodos Propios

```
┌──────────────────────────────────────────────────────────────────────────┐
│ RPCs GESTIONADOS (Recomendado para Copy-Trading)                         │
├──────────────────────────────────────────────────────────────────────────┤
│ • Alchemy Growth: $49/mes, 300M CUs, <50ms latencia, archival           │
│ • QuickNode Pro: $99/mes, dedicado, websockets ilimitados               │
│ • Helius (Solana): $49/mes si pivoteamos a SOL                          │
│ • dRPC/Infura: Alternativas como fallback                               │
│                                                                          │
│ VENTAJA: Cero mantenimiento, alta disponibilidad, soporte empresarial   │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│ NODOS PROPIOS (Solo si necesitamos mempool privado)                      │
├──────────────────────────────────────────────────────────────────────────┤
│ • Reth (Rust): 2TB SSD, 32GB RAM, ~$150/mes en Hetzner                  │
│ • Erigon: Similar specs, mejor para archival                            │
│ • Yellowstone gRPC (Solana): Streaming de eventos en tiempo real        │
│                                                                          │
│ VENTAJA: Mempool privado, sin rate limits, latencia mínima             │
│ DESVENTAJA: Mantenimiento 24/7, sincronización, updates de cliente      │
└──────────────────────────────────────────────────────────────────────────┘
```

## 2.3 ¿Es Viable Competir en AWS para Arbitraje Cross-DEX y Sniping?

### 2.3.1 Realidad del Mempool Público vs Builders Privados


```
┌─────────────────────────────────────────────────────────────────────────────┐
│ LA CRUDA REALIDAD DEL MEMPOOL EN 2026                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ETHEREUM / BASE:                                                           │
│  ├── 90%+ del flujo de órdenes va por Flashbots Protect/MEV Blocker        │
│  ├── Builders privados (Flashbots, BloXroute, Titan) tienen acceso         │
│  │   exclusivo al mempool 50-200ms ANTES que el público                    │
│  ├── Searchers profesionales pagan $50-500K/año por colocación física      │
│  └── Sin private mempool access = ver transacciones ya mineadas            │
│                                                                             │
│  SOLANA:                                                                    │
│  ├── Jito domina el 80%+ del flujo MEV                                     │
│  ├── Bundles privados = necesitas relación con Jito                        │
│  └── Latencia del RPC público: 200-400ms (inaceptable para sniping)        │
│                                                                             │
│  CONCLUSIÓN: Sin $100K+/año en infraestructura, PERDEMOS SIEMPRE           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.3.2 Veredicto Técnico: Arbitraje Cross-DEX en AWS

| Estrategia | ¿Viable en AWS? | Por qué |
|------------|-----------------|---------|
| **Sniping micro-caps** | ❌ NO | 5-11s delay = compramos el dump |
| **Arbitraje atómico** | ❌ NO | Searchers en DC de validadores ganan 100% |
| **Liquidaciones** | ❌ NO | Misma razón que arbitraje |
| **Copy-trading** | ✅ SÍ | No competimos contra MEV, copiamos después |
| **Grid Trading** | ✅ SÍ | Posiciones largas, latencia irrelevante |

**VEREDICTO INFRA:** 
- **Copy-Trading/Grid:** Local o AWS básico (~$50-100/mes) es SUFICIENTE
- **Arbitraje/Sniping:** Batalla perdida sin colocación física y mempool privado

---

# 3. PROYECCIÓN CUANTITATIVA: GRID TRADING EN ETH/USDC

## 3.1 Modelo de Grid Trading en Uniswap V3 / Concentrated Liquidity

### Parámetros del Modelo
```
Capital Inicial:     $500 USD (conservador) / $2,000 USD (extrapolación)
Par:                 ETH/USDC en Base L2
Rango de Grid:       ±5% del precio actual (concentrado)
Número de Grids:     10 niveles
Fee Tier:            0.05% (5 bps) - más competitivo en L2
Gas por rebalanceo:  ~$0.01-0.05 en Base (vs $5-20 en L1)
Volatilidad media:   2-4% diario en ETH
```


### 3.2 Proyección de Retornos

| Escenario | Volatilidad | Trades/Día | Fee Income | Gas Cost | Net Daily | APR | APY |
|-----------|-------------|------------|------------|----------|-----------|-----|-----|
| **Bajo** | 1% | 2-3 | $0.15-0.25 | $0.02 | **$0.13-0.23** | ~10% | ~10.5% |
| **Medio** | 2-3% | 5-8 | $0.35-0.60 | $0.05 | **$0.30-0.55** | ~22-40% | ~25-50% |
| **Alto** | 4-5% | 10-15 | $0.70-1.10 | $0.10 | **$0.60-1.00** | ~44-73% | ~55-100% |

### 3.3 Proyección por Capital

| Capital | Escenario Medio | Retorno Mensual | Retorno Anual |
|---------|-----------------|-----------------|---------------|
| **$500** | $0.40/día avg | **$12/mes** | **$146/año** (29% APR) |
| **$2,000** | $1.60/día avg | **$48/mes** | **$584/año** (29% APR) |
| **$10,000** | $8.00/día avg | **$240/mes** | **$2,920/año** (29% APR) |

### 3.4 Riesgos Críticos

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ IMPERMANENT LOSS (IL) - EL RIESGO PRINCIPAL                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Si ETH se mueve ±10% fuera del rango:                                      │
│  • Posición concentrada = 100% en un solo activo                           │
│  • IL puede superar TODAS las fees acumuladas                              │
│  • ETH cae 20%: IL de ~4% sobre el capital                                 │
│  • ETH sube 20%: IL de ~4% (pierdes upside de ETH)                         │
│                                                                             │
│  MITIGACIÓN:                                                                │
│  • Rebalancear cuando precio escapa del rango                              │
│  • Usar rangos más amplios (±10-15%) = menos fees pero menos IL            │
│  • Aceptar IL como costo de hacer negocio                                  │
│                                                                             │
│  ESCENARIO REALISTA CON IL:                                                 │
│  • APR bruto: 29%                                                           │
│  • IL promedio anual en mercado lateral: -5% a -10%                        │
│  • APR NETO ESPERADO: 15-25%                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.5 Comparativa L1 vs L2

| Métrica | Ethereum L1 | Base L2 | Arbitrum L2 |
|---------|-------------|---------|-------------|
| Gas por swap | $5-20 | $0.01-0.05 | $0.05-0.20 |
| Rentabilidad mínima viable | $10K+ capital | **$500 viable** | $1K viable |
| Liquidez | Máxima | Creciente | Alta |
| Riesgo bridge | N/A | Bajo (Coinbase) | Bajo |

**VEREDICTO GRID TRADING:**
- Con **$500 en Base L2**, esperamos **$10-15/mes neto** (20-35% APR después de IL)
- Con **$2,000**, esperamos **$40-60/mes neto**
- **ES VIABLE** como estrategia conservadora, pero no genera income significativo con capital bajo

---


# 4. BACKLOG Y CAMBIO DE ESTADO

## 4.1 Ideas Aprobadas para Documentación Formal

| Idea | Prioridad | Estado | Archivo Destino |
|------|-----------|--------|-----------------|
| **Rug Alert Service** (Servicio de Datos) | 🟢 ALTA | Pendiente spec | `ideasaprobadas.md` |
| Copy-Trading Smart Money | 🟢 ALTA | Este documento | N/A |
| Grid Trading ETH/USDC | 🟡 MEDIA | Evaluado arriba | `ideasaprobadas.md` |
| Cross-DEX Arbitraje | 🔴 BAJA | Inviable sin infra | Descartado |

## 4.2 Cese Inmediato de Compras Automáticas de Micro-Caps

```typescript
// CAMBIO REQUERIDO EN .env
SNIPER_ENABLED=false           // ← DESACTIVAR COMPRAS REALES
SNIPER_EXPLORATION_MODE=true   // ← Solo shadow mode (ingesta + log)

// Estado actual del sistema:
// ✅ SignalIngestor: Sigue ingiriendo señales para análisis
// ✅ ContractValidator: Sigue validando para detectar rugs
// ✅ MetricsRecorder: Sigue registrando estadísticas
// ❌ MultiVariantExecutor: NO abre posiciones reales
// ❌ ShadowExecutor: Solo simula, nunca ejecuta
```

## 4.3 Transición a Shadow Mode Puro

El sistema YA está en shadow mode, pero confirmo los cambios necesarios:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SHADOW MODE CONFIRMADO                                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ Estado actual verificado en código:                                         │
│                                                                             │
│ 1. DexQuoter: ✅ Solo usa staticCall (nunca eth_sendRawTransaction)        │
│ 2. ShadowExecutor: ✅ Simula trades sin firmar transacciones               │
│ 3. RiskBucket: ✅ Gestiona presupuesto virtual ($15 USDC simulados)        │
│ 4. Ningún módulo tiene privateKey cargado para firmar                      │
│                                                                             │
│ ACCIÓN: El sistema puede seguir corriendo para recolectar datos            │
│ de validación de contratos (útil para Rug Alert Service futuro)            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

# 5. ESPECIFICACIÓN TÉCNICA: COPY-TRADING DE SMART MONEY

## 5.1 Visión General de la Arquitectura

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     COPY-TRADING SYSTEM ARCHITECTURE                          │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────────┐    ┌──────────────────┐    ┌────────────────────┐     │
│   │  SmartMoney     │───▶│  WalletWatcher   │───▶│  SignalIngestor    │     │
│   │  CuratorModule  │    │  (WebSocket/     │    │  (Refactored)      │     │
│   │                 │    │   Polling)       │    │                    │     │
│   └─────────────────┘    └──────────────────┘    └─────────┬──────────┘     │
│          │                                                  │                │
│          ▼                                                  ▼                │
│   ┌─────────────────┐                           ┌────────────────────┐      │
│   │  WalletMetrics  │                           │  SignalEnricher    │      │
│   │  PostgreSQL     │                           │  (Liquidity/Tax/   │      │
│   │  (Historical)   │                           │   Slippage Check)  │      │
│   └─────────────────┘                           └─────────┬──────────┘      │
│                                                            │                 │
│                                                            ▼                 │
│   ┌──────────────────────────────────────────────────────────────────┐      │
│   │                     EXISTING MODULES (REUSED)                     │      │
│   ├──────────────────────────────────────────────────────────────────┤      │
│   │  ContractValidator │ RiskBucket │ DexQuoter │ ExecutionEngine    │      │
│   └──────────────────────────────────────────────────────────────────┘      │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```


## 5.2 MÓDULO A: Smart Money Finder & Curator

### 5.2.1 Métricas On-Chain Obligatorias para Filtrar Wallets

```typescript
interface SmartMoneyWalletCriteria {
  // ═══════════════════════════════════════════════════════════════════════
  // FILTROS OBLIGATORIOS (Hard Requirements)
  // ═══════════════════════════════════════════════════════════════════════
  
  /** Win rate mínimo en últimos 90 días */
  minWinRate: 0.70;  // 70% - riguroso
  
  /** PnL total histórico mínimo (en USDC) */
  minHistoricalPnlUsdc: 50_000;  // $50K+ demuestra consistencia
  
  /** Número mínimo de trades para significancia estadística */
  minTradeCount: 100;  // <100 trades = muestra insuficiente
  
  /** Holding time MÍNIMO promedio (segundos) */
  minAvgHoldingTimeSec: 900;  // 15 min mínimo - filtra toxic flow
  
  /** Holding time MÁXIMO promedio (evitar HODLers puros) */
  maxAvgHoldingTimeSec: 604_800;  // 7 días máximo
  
  /** Volumen histórico mínimo (demuestra capital real) */
  minHistoricalVolumeUsdc: 500_000;  // $500K+ en volumen total
  
  // ═══════════════════════════════════════════════════════════════════════
  // MÉTRICAS AVANZADAS (Scoring)
  // ═══════════════════════════════════════════════════════════════════════
  
  /** Sharpe ratio mínimo (retorno ajustado por riesgo) */
  minSharpeRatio: 1.5;  // >1.5 = performance superior
  
  /** Max drawdown tolerable */
  maxDrawdownPct: 30;  // No más de 30% pérdida pico-valle
  
  /** Profit factor mínimo (gross profit / gross loss) */
  minProfitFactor: 2.0;  // Gana $2 por cada $1 que pierde
  
  /** Consistencia: % de semanas rentables */
  minProfitableWeeksPct: 60;  // 60%+ semanas en verde
}
```

### 5.2.2 Filtros de Exclusión (Blacklist Automática)

```typescript
interface WalletExclusionFilters {
  // ═══════════════════════════════════════════════════════════════════════
  // BOTS MEV (Frontrunners/Backrunners/Sandwich)
  // ═══════════════════════════════════════════════════════════════════════
  
  /** Excluir si >50% de trades son en el mismo bloque que otro trade */
  maxSameBlockTradePct: 0.50;
  
  /** Excluir si holding time promedio <60 segundos (bot de arb) */
  minHoldingTimeForHuman: 60;
  
  /** Excluir si interactúa con Flashbots/MEV Relay contracts */
  blacklistMevContracts: [
    '0xC0...FlashbotsRelay',
    '0x...BloXrouteRelay',
  ];
  
  // ═══════════════════════════════════════════════════════════════════════
  // DEPLOYERS / INSIDERS / HONEYPOT CREATORS
  // ═══════════════════════════════════════════════════════════════════════
  
  /** Excluir si wallet ha deployado tokens en los últimos 180 días */
  excludeTokenDeployers: true;
  
  /** Excluir si >20% de tokens comprados fueron honeypots/rugs */
  maxHoneypotExposurePct: 0.20;
  
  /** Excluir si recibió tokens directamente del deployer (airdrop insider) */
  excludeDeployerRecipients: true;
  
  // ═══════════════════════════════════════════════════════════════════════
  // WASH TRADING / MANIPULACIÓN
  // ═══════════════════════════════════════════════════════════════════════
  
  /** Excluir si >30% de trades son con la misma contraparte */
  maxSameCounterpartyPct: 0.30;
  
  /** Excluir si opera tokens con <$5K de liquidez consistentemente */
  excludeLowLiquidityTraders: true;
  
  /** Excluir si patrón de "pump and dump" detectado (>5 instancias) */
  maxPumpDumpPatterns: 5;
}
```


### 5.2.3 Fuentes de Datos para Curaduría de Wallets

| Fuente | Datos Disponibles | Costo | Latencia |
|--------|-------------------|-------|----------|
| **Nansen** | Labels, smart money tags, profit leaderboards | $150-500/mes | Minutos |
| **Arkham** | Entity labels, flow analysis | $0-300/mes | Minutos |
| **Dune Analytics** | Custom queries, historical data | $0-400/mes | Minutos |
| **DeBank API** | Portfolio, PnL, transaction history | $0 (rate limited) | Segundos |
| **Etherscan/Basescan** | Raw transactions, token transfers | $0-200/mes | Segundos |
| **On-chain directo** | Eventos Transfer/Swap vía RPC | $50-100/mes RPC | Milisegundos |

**RECOMENDACIÓN:** Combinar Dune Analytics (gratis tier) + DeBank API + On-chain directo para MVP.

---

## 5.3 MÓDULO B: Wallet Watcher (Nuevo SignalIngestor)

### 5.3.1 Arquitectura de Ingesta de Eventos On-Chain

```typescript
/**
 * WalletWatcher - Nuevo módulo que reemplaza la lógica de polling de SignalIngestor
 * 
 * Responsabilidades:
 *   1. Suscribirse a eventos Transfer/Swap de wallets curadas
 *   2. Decodificar calldata para extraer token, amount, dirección
 *   3. Emitir CopySignal cuando una wallet compra/vende
 *   4. Filtrar ruido (transfers internos, dust, etc.)
 */

interface WalletWatcherConfig {
  /** Lista de wallets a monitorear (max 50 para performance) */
  watchedWallets: string[];
  
  /** Método de ingesta */
  ingestMethod: 'websocket' | 'polling' | 'hybrid';
  
  /** RPC WebSocket URL (para método websocket) */
  wsRpcUrl: string;
  
  /** Polling interval en ms (para método polling) */
  pollingIntervalMs: 2000;  // 2s para baja latencia
  
  /** Filtros de token */
  tokenFilters: {
    /** Ignorar tokens con liquidez < $X */
    minLiquidityUsdc: 10_000;
    /** Ignorar dust transfers < $X */
    minTransferValueUsdc: 100;
    /** Lista negra de tokens conocidos como scam */
    tokenBlacklist: string[];
  };
}

interface CopySignal {
  /** UUID único del signal */
  id: string;
  
  /** Wallet que originó el trade */
  sourceWallet: string;
  
  /** Tipo de operación */
  action: 'BUY' | 'SELL';
  
  /** Token address */
  tokenAddress: string;
  
  /** Pool/pair address donde se ejecutó */
  poolAddress: string;
  
  /** Monto en USDC del trade original */
  tradeAmountUsdc: number;
  
  /** Precio de entrada del insider */
  entryPrice: bigint;
  
  /** Block number donde se detectó */
  blockNumber: number;
  
  /** Timestamp de detección (ms) */
  detectedAt: number;
  
  /** Hash de la transacción original */
  txHash: string;
  
  /** Métricas de la wallet al momento del trade */
  walletMetrics: {
    winRate: number;
    recentPnl7d: number;
    avgHoldingTime: number;
  };
}
```


### 5.3.2 Pipeline de Detección de Swaps

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    SWAP DETECTION PIPELINE                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. INGESTA (WebSocket / Polling)                                           │
│     │                                                                       │
│     ├── eth_subscribe("logs", {topics: [Transfer, Swap], address: pools})  │
│     ├── Cada 2s: eth_getLogs(fromBlock: latest-1, toBlock: latest)         │
│     │                                                                       │
│  2. FILTRADO INICIAL                                                        │
│     │                                                                       │
│     ├── ¿El `from` o `to` está en watchedWallets? → Continuar              │
│     ├── ¿Es Transfer de WETH/USDC (no token específico)? → Ignorar         │
│     ├── ¿Monto < $100 USD? → Ignorar (dust)                                │
│     │                                                                       │
│  3. DECODIFICACIÓN DE CALLDATA                                              │
│     │                                                                       │
│     ├── Obtener tx completa: eth_getTransactionByHash                       │
│     ├── Decodificar input data:                                            │
│     │   ├── Uniswap V3: exactInputSingle, exactInput, multicall            │
│     │   ├── Aerodrome: swapExactTokensForTokens, swapExactETHForTokens     │
│     │   ├── 1inch: swap, unoswap, uniswapV3Swap                            │
│     │                                                                       │
│  4. ENRIQUECIMIENTO                                                         │
│     │                                                                       │
│     ├── Obtener precio actual del token (DexQuoter.quote)                  │
│     ├── Verificar liquidez del pool (≥$10K)                                │
│     ├── Calcular slippage esperado para nuestro trade size                 │
│     ├── Check transfer tax del token                                        │
│     │                                                                       │
│  5. EMISIÓN DE CopySignal                                                   │
│     │                                                                       │
│     └── Pasar a ExecutionEngine si pasa todos los checks                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.3.3 Proveedores de WebSocket/Streaming Recomendados

| Proveedor | Tipo | Latencia | Costo | Características |
|-----------|------|----------|-------|-----------------|
| **QuickNode Streams** | WebSocket | <100ms | $99+/mes | Filtros custom, auto-reconnect |
| **Alchemy Webhooks** | Push | <200ms | $49+/mes | Managed, no mantener conexión |
| **Infura WebSocket** | WebSocket | <150ms | $50+/mes | Estable, bien documentado |
| **Helius (Solana)** | gRPC | <50ms | $49+/mes | Solo para Solana |
| **Self-hosted Reth** | WebSocket | <20ms | $150/mes | Máximo control, mantenimiento |

**RECOMENDACIÓN MVP:** QuickNode Streams ($99/mes) - balance costo/latencia/facilidad.

---

## 5.4 MÓDULO C: Signal Enricher (Pre-Execution Validation)

### 5.4.1 Checks de Enriquecimiento Antes de Ejecutar

```typescript
interface SignalEnrichmentResult {
  /** Signal original */
  signal: CopySignal;
  
  /** ¿Pasó todos los checks? */
  approved: boolean;
  
  /** Razón de rechazo si no aprobó */
  rejectReason?: 
    | 'LOW_LIQUIDITY'      // Pool <$10K
    | 'HIGH_SLIPPAGE'      // Slippage >5%
    | 'TRANSFER_TAX'       // Token tiene tax >5%
    | 'HONEYPOT_DETECTED'  // Simulación de venta falló
    | 'WALLET_DEGRADED'    // Win rate de wallet cayó <60%
    | 'RECENT_RUG'         // Token del mismo deployer ruggeó antes
    | 'BAITING_DETECTED';  // Patrón de bait detectado
  
  /** Métricas de enriquecimiento */
  enrichment: {
    currentLiquidityUsdc: number;
    estimatedSlippagePct: number;
    transferTaxPct: number;
    simulatedSellSuccess: boolean;
    tokenAgeHours: number;
    deployerHistory: 'clean' | 'suspicious' | 'known_scammer';
  };
}
```


### 5.4.2 Simulación Anti-Honeypot

```typescript
/**
 * Simula una venta del token ANTES de comprar.
 * 
 * Proceso:
 *   1. staticCall: approve(router, maxUint256)
 *   2. staticCall: swap(token → USDC, amountIn, minOut=0)
 *   3. Si la simulación revierte → HONEYPOT
 *   4. Si amountOut < 90% del esperado → TRANSFER_TAX alto
 * 
 * CRÍTICO: Usar Tenderly/Alchemy Simulate para estado forkeado
 */
async function simulateSellBeforeBuy(
  tokenAddress: string,
  poolAddress: string,
  testAmountUsdc: bigint,
): Promise<{ canSell: boolean; effectiveTaxPct: number }> {
  // ... implementación
}
```

---

## 5.5 MÓDULO D: Execution Engine (Reutilización + Sizing Dinámico)

### 5.5.1 Position Sizing Relativo al Trade del Insider

```typescript
interface CopyPositionSizing {
  /**
   * REGLA DE SIZING:
   * 
   * El tamaño de nuestra posición es PROPORCIONAL al trade del insider,
   * pero capeado por nuestro capital disponible y reglas de riesgo.
   * 
   * Fórmula:
   *   positionSize = min(
   *     insiderTradeUsdc * copyRatio,
   *     maxPositionUsdc,
   *     availableCapital * maxCapitalPct
   *   )
   */
  
  /** Ratio de copia: qué % del trade del insider copiamos */
  copyRatio: 0.10;  // 10% del tamaño del insider
  
  /** Posición máxima absoluta en USDC */
  maxPositionUsdc: 100;  // Nunca más de $100 por trade
  
  /** % máximo del capital disponible por trade */
  maxCapitalPct: 0.05;  // Nunca más del 5% del capital total
  
  /** Posición mínima (no vale la pena si es muy pequeña) */
  minPositionUsdc: 10;  // Al menos $10 para cubrir gas
  
  /** Ajuste por confianza en la wallet */
  walletTierMultipliers: {
    'S_TIER': 1.5,   // Top 5 wallets: +50% tamaño
    'A_TIER': 1.0,   // Wallets 6-15: tamaño normal
    'B_TIER': 0.5,   // Wallets 16-50: -50% tamaño
  };
}

// Ejemplo de cálculo:
// insiderTradeUsdc = $5,000
// copyRatio = 0.10 → $500 objetivo
// maxPositionUsdc = $100 → capeado a $100
// availableCapital = $1,000, maxCapitalPct = 5% → $50 máximo
// RESULTADO: positionSize = $50 (el menor de todos los caps)
```

### 5.5.2 Estrategia de Salida

```typescript
interface CopyExitStrategy {
  /**
   * TRES MODOS DE SALIDA (configurables por wallet tier):
   */
  
  /** MODO 1: Seguir al insider */
  followInsiderSell: {
    enabled: true;
    /** Timeout: si insider no vende en X horas, aplicar fallback */
    maxWaitHours: 24;
    /** Vender cuando insider vende ≥50% de su posición */
    sellThresholdPct: 0.50;
  };
  
  /** MODO 2: Trailing Stop dinámico */
  trailingStop: {
    enabled: true;
    /** Stop inicial: -15% desde entry */
    initialStopPct: 15;
    /** Trail: mover stop cuando precio sube +10% */
    trailActivationPct: 10;
    /** Trail distance: stop siempre 10% debajo del máximo */
    trailDistancePct: 10;
  };
  
  /** MODO 3: TP/SL fijo (fallback) */
  fixedTpSl: {
    enabled: true;
    takeProfitPct: 50;   // +50% = vender todo
    stopLossPct: 20;     // -20% = vender todo
    timeStopHours: 48;   // Máximo 48h holding
  };
  
  /**
   * PRIORIDAD DE SALIDA:
   * 1. Si insider vende → seguir (si followInsiderSell.enabled)
   * 2. Si trailing stop triggered → salir
   * 3. Si TP/SL fijo triggered → salir
   * 4. Si timeStop alcanzado → salir a mercado
   */
}
```


---

## 5.6 MÓDULO E: Medidas Anti-Explotación

### 5.6.1 Protección Contra Baiting

```typescript
/**
 * BAITING: Wallets que SABEN que están siendo copiadas y crean trampas.
 * 
 * Patrón típico:
 *   1. Insider compra token X (su propia creación o de cómplice)
 *   2. Copy-bots detectan y compran
 *   3. Insider vende inmediatamente, causando dump
 *   4. Copy-bots quedan atrapados con tokens sin valor
 * 
 * DETECCIÓN Y MITIGACIÓN:
 */

interface AntiBaitingProtection {
  // ═══════════════════════════════════════════════════════════════════════
  // DETECCIÓN DE PATRONES SOSPECHOSOS
  // ═══════════════════════════════════════════════════════════════════════
  
  /** Rechazar si token fue deployado por la misma wallet en últimos 30 días */
  rejectSelfDeployedTokens: true;
  
  /** Rechazar si deployer del token es conocido por rugs anteriores */
  checkDeployerHistory: true;
  
  /** Rechazar si >30% de holders son wallets en nuestra lista de copiados */
  maxCopyBotHoldersPct: 0.30;
  
  /** Rechazar si wallet compró y vendió el mismo token en <1 hora antes */
  rejectRecentRoundTrip: true;
  
  // ═══════════════════════════════════════════════════════════════════════
  // MITIGACIÓN ACTIVA
  // ═══════════════════════════════════════════════════════════════════════
  
  /** Delay aleatorio antes de ejecutar (evita detección de patrón) */
  randomDelayMs: { min: 5_000, max: 30_000 };  // 5-30 segundos
  
  /** Dividir orden grande en múltiples pequeñas (reduce footprint) */
  splitLargeOrders: {
    enabled: true;
    /** Umbral para dividir */
    thresholdUsdc: 50;
    /** Número de splits */
    splitCount: 3;
    /** Delay entre splits */
    splitDelayMs: 10_000;
  };
  
  /** Rotar entre múltiples wallets de ejecución */
  walletRotation: {
    enabled: true;
    /** Número de wallets a rotar */
    walletPoolSize: 5;
  };
  
  /** Rechazar tokens donde nuestra compra sería >5% del volumen diario */
  maxVolumeImpactPct: 0.05;
}
```

### 5.6.2 Gas Limit Caps y Protección de Slippage

```typescript
interface ExecutionSafetyLimits {
  // ═══════════════════════════════════════════════════════════════════════
  // GAS LIMITS
  // ═══════════════════════════════════════════════════════════════════════
  
  /** Gas price máximo (en gwei) - evita ejecución en gas spikes */
  maxGasPriceGwei: 50;  // En Base L2, rara vez >1 gwei
  
  /** Gas limit máximo por transacción */
  maxGasLimit: 500_000;  // Swap típico: 150-250K
  
  /** Abortar si estimación de gas > 2x del esperado (posible honeypot) */
  gasEstimateMultiplierLimit: 2.0;
  
  // ═══════════════════════════════════════════════════════════════════════
  // SLIPPAGE PROTECTION
  // ═══════════════════════════════════════════════════════════════════════
  
  /** Slippage máximo tolerable */
  maxSlippagePct: 5.0;  // 5% máximo
  
  /** Calcular slippage dinámicamente basado en liquidez */
  dynamicSlippage: {
    enabled: true;
    /** Base slippage para pools >$100K liquidez */
    basePct: 1.0;
    /** Extra slippage por cada $10K menos de liquidez */
    extraPerMissingLiquidityPct: 0.5;
    /** Cap máximo incluso con cálculo dinámico */
    capPct: 5.0;
  };
  
  /** Usar precio de referencia de oracle si disponible */
  useOraclePrice: true;
  
  /** Rechazar si precio on-chain difiere >3% del oracle */
  maxOracleDeviationPct: 3.0;
  
  // ═══════════════════════════════════════════════════════════════════════
  // TRANSACTION SIMULATION
  // ═══════════════════════════════════════════════════════════════════════
  
  /** Simular transacción antes de enviar (Tenderly/Alchemy) */
  simulateBeforeExecute: true;
  
  /** Timeout para simulación (ms) */
  simulationTimeoutMs: 5_000;
  
  /** Rechazar si simulación muestra pérdida >10% */
  maxSimulatedLossPct: 10;
}
```


---

## 5.7 ESTRUCTURA DE ARCHIVOS PROPUESTA

```
src/
├── copy-trading/
│   ├── index.ts                    # Entry point, wires all modules
│   ├── smart-money-curator.ts      # Wallet selection & metrics
│   ├── wallet-watcher.ts           # WebSocket/polling listener
│   ├── signal-enricher.ts          # Pre-execution validation
│   ├── copy-executor.ts            # Execution engine (reuses DexQuoter)
│   ├── exit-manager.ts             # TP/SL, trailing stop, follow insider
│   ├── anti-baiting.ts             # Bait detection & mitigation
│   └── types.ts                    # Shared interfaces
│
├── hybrid-sniper/                  # EXISTING - reutilizado
│   ├── dex-quoter.ts              # ✅ Reutilizar tal cual
│   ├── risk-bucket.ts             # ✅ Reutilizar con ajustes
│   ├── metrics-recorder.ts        # ✅ Reutilizar, extender schema
│   ├── contract-validator.ts      # ✅ Reutilizar honeypot checks
│   └── ...
│
├── shared/
│   ├── simulation.ts              # Tenderly/Alchemy simulation wrapper
│   ├── gas-oracle.ts              # Gas price monitoring
│   └── wallet-manager.ts          # Multi-wallet rotation
```

---

## 5.8 ROADMAP DE IMPLEMENTACIÓN

| Fase | Duración | Entregables | Dependencias |
|------|----------|-------------|--------------|
| **0. Shadow Mode Cleanup** | 1 día | Confirmar sistema en shadow, limpiar logs | - |
| **1. Smart Money Curator MVP** | 3-5 días | Scraper de Dune/DeBank, DB de wallets | Dune API key |
| **2. Wallet Watcher** | 5-7 días | WebSocket listener, swap decoder | QuickNode Streams |
| **3. Signal Enricher** | 3-4 días | Liquidity/slippage/honeypot checks | Reutiliza DexQuoter |
| **4. Copy Executor** | 4-5 días | Position sizing, tx building | Wallet con fondos |
| **5. Exit Manager** | 3-4 días | TP/SL, trailing, follow insider | Wallet Watcher |
| **6. Anti-Baiting** | 2-3 días | Bait detection, delay, rotation | Multi-wallet setup |
| **7. Integration & Testing** | 5-7 días | E2E tests, shadow validation | Todas las fases |
| **8. Live MVP** | Ongoing | Deploy con $100-500 capital | Fases 1-7 |

**TIEMPO TOTAL ESTIMADO:** 4-6 semanas para MVP funcional

---

# 6. CONCLUSIONES Y PRÓXIMOS PASOS

## 6.1 Resumen de Decisiones

| Decisión | Veredicto | Justificación |
|----------|-----------|---------------|
| **Stack** | ✅ Mantener TypeScript | No hay ROI en reescribir, I/O bound |
| **Infra** | ✅ Local o AWS básico | Copy-trading no requiere latencia <100ms |
| **Micro-cap sniping** | ❌ CANCELADO | 0% win rate, inviable sin $100K+/año infra |
| **Grid Trading** | ✅ VIABLE (bajo capital) | 15-25% APR neto, pero retornos absolutos bajos |
| **Copy-Trading** | ✅ PIVOTE PRINCIPAL | Mayor edge con menor infra |

## 6.2 Acciones Inmediatas

1. **HOY:** Documentar "Rug Alert Service" en `ideasaprobadas.md`
2. **ESTA SEMANA:** Crear spec formal para Copy-Trading Module
3. **PRÓXIMA SEMANA:** Implementar Smart Money Curator MVP
4. **MES 1:** Copy-Trading en shadow mode con wallets curadas
5. **MES 2:** Live con $100-500 capital de prueba

---

**Documento preparado por Kiro — Quant Trading Architect Senior**  
**Fecha:** 16 Agosto 2026  
**Versión:** 1.0
