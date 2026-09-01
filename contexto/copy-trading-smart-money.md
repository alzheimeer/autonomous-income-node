# Copy-Trading Smart Money — Contexto técnico completo
> Módulo implementado y completado. Integrado en AgentCore el 19 de Agosto de 2026.
> Para contexto general del proyecto ver CLAUDE.md o GEMINI.md

---

## ¿Qué hace?

Copia automáticamente los trades de wallets "smart money" curadas en tiempo real. Es el **módulo principal de generación de ingresos** del agente, reemplazando el micro-cap sniping que tuvo 0% win rate.

Opera como satélite **non-fatal** en el AgentCore (Paso 5.6): si falla al iniciar no afecta al agente principal.

---

## Estructura de archivos

```
src/copy-trading/
├── index.ts                          # API pública del módulo
├── CopyTradingOrchestrator.ts        # Orquestador principal + RugAlertService
├── agent-integration.ts              # Adaptador para AgentCore (sin HTTP, sin migraciones)
├── bootstrap.ts                      # Entrypoint standalone (con HTTP + migraciones)
├── config/
│   └── CopyTradingConfig.ts          # 13 vars COPY_* con validación y defaults
├── interfaces/
│   └── types.ts                      # CopySignal, CopyPosition, EnrichedSignal, WalletTier...
├── migrations/
│   ├── 001_copy_trading_schema.sql   # copy_wallets, copy_signals, copy_positions, bait_flags
│   └── 002_extend_daily_metrics.sql  # copy_daily_metrics extendida
├── modules/
│   ├── SmartMoneyCurator.ts          # Curaduría de wallets, tiers S/A/B, re-evaluación 24h
│   ├── WalletWatcher.ts              # WebSocket + polling híbrido, decode calldata
│   ├── SignalEnricher.ts             # 7 validaciones pre-copia
│   ├── AntiBaitingModule.ts          # Detección de manipulación y trampas
│   ├── CopyExecutor.ts               # Ejecución proporcional con sizing dinámico
│   ├── ExitManager.ts                # 3 estrategias de salida + state machine
│   ├── CopyTradingRiskManager.ts     # Circuit breaker, límites diarios, reserva capital
│   ├── CopyMetricsRecorder.ts        # Persistencia PostgreSQL + restore on restart
│   └── SwapDecoder.ts                # Decodifica calldata UniV3/Aerodrome/1inch
├── routes/
│   └── copy.ts                       # HTTP API: /copy/status, wallets, positions, metrics
└── tests/                            # 400+ tests: unit + property-based (fast-check)
    ├── SmartMoneyCurator.test.ts
    ├── SmartMoneyCurator.*.property.test.ts (5 archivos PBT)
    ├── WalletWatcher.test.ts
    ├── SignalEnricher.test.ts
    ├── AntiBaitingModule.test.ts
    ├── CopyExecutor.test.ts
    ├── ExitManager.test.ts
    ├── ExitManager.rugpull.test.ts
    ├── CopyTradingRiskManager.test.ts  (155 tests)
    ├── CopyMetricsRecorder.test.ts
    ├── CopyTradingOrchestrator.test.ts
    └── api-*.test.ts (3 archivos)
```

---

## Pipeline completo de una señal

```
1. WalletWatcher detecta swap (WebSocket o polling 2s)
   → CopySignal { id, sourceWallet, tokenAddress, action, tradeAmountUsdc, entryPrice, blockNumber, txHash }

2. SignalEnricher.enrich() [timeout 2s]
   → check liquidez pool ≥ $10K USDC o 2.0 WETH
   → simulación sell (honeypot detection via staticCall)
   → tax = (buy_input - sell_output) / buy_input × 100 < 5%
   → slippage estimado < 5%
   → deployer con historial de rugs → reject DEPLOYER_FLAGGED
   → LP burned/locked ≥ 50%
   → round-trip en < 1h → reject BAITING_DETECTED
   → EnrichedSignal { ...signal, approved, rejectReason, enrichment }

3. AntiBaitingModule.check()
   → token deployado por sourceWallet en últimos 30 días → reject
   → >30% de holders son wallets monitoreadas → reject
   → bait flags: 3+ en 7 días → remove wallet
   → nuestra posición excede 5% del volumen diario → reject
   → delay 5-30s (anti-detección uniforme)

4. CopyExecutor.execute()
   → positionSize = min(tradeAmountUsdc × copyRatio, maxPositionUsdc, capital × 5%)
   → × tierMultiplier: S_TIER=1.5, A_TIER=1.0, B_TIER=0.5
   → if positionSize < $10 → reject
   → if positionSize > $50 → split en 3 órdenes con 10s entre ellas
   → slippage = 1% + 0.5% por cada $10K faltante de liquidez (cap 5%)
   → abort si gas > 50 gwei o gas estimate > 2x esperado
   → staticCall simulación → abort si pérdida > 10%
   → abre CopyPosition { id, tokenAddress, poolAddress, sourceWallet, entryPrice, positionSizeUsdc, takeProfit, stopLoss, timeStop }

5. ExitManager.registerPosition(pos) — monitoreo cada 5s
   → FOLLOW_INSIDER mode: cierra si insider vende ≥50% en 30s
   → Si insider no vende en 24h → switch a TRAILING_STOP mode
   → TRAILING_STOP: activa al +10%, trailing 10% bajo máximo
   → TP fijo: +50% | SL fijo: -20% | TimeStop: 48h
   → RUG_PULL: 3 quote failures consecutivos → 100% loss

6. RugAlertService.trackPosition(shadowLike, poolAddress, poolAddress)
   → protección proactiva en paralelo (ver rug-alert-service.md)
```

---

## SmartMoneyCurator — Criterios de inclusión/exclusión

### Inclusión (todos obligatorios)
| Criterio | Valor mínimo |
|----------|-------------|
| Win rate | ≥ 70% (últimos 90 días) |
| PnL histórico | ≥ $50,000 USDC |
| Trades | ≥ 100 |
| Holding time promedio | 15 min – 7 días |
| Volumen histórico | ≥ $500,000 USDC |

### Exclusión automática
- > 50% trades en el mismo bloque (MEV bot)
- Ha deployado tokens en últimos 180 días
- > 20% de tokens comprados fueron honeypots/rugs
- Recibió tokens directamente de deployers (insider airdrop)
- > 30% trades con el mismo counterparty (wash trading)
- Win rate cae a < 60% → removida de la lista

### Tiers
| Tier | Posiciones | Multiplier |
|------|-----------|-----------|
| S_TIER | Top 5 por score | 1.5x |
| A_TIER | Posiciones 6-15 | 1.0x |
| B_TIER | Posiciones 16-50 | 0.5x |

Score = `winRate × profitFactor × sharpeRatio`

---

## CopyTradingRiskManager — Límites

| Parámetro | Valor |
|-----------|-------|
| Max posiciones concurrentes | 3 |
| Max capital diario | 20% del capital total |
| Circuit breaker (streak) | 3 SL/RUG consecutivos → 24h bloqueado |
| Circuit breaker (PnL) | -15% PnL diario → 24h bloqueado |
| Drawdown por posición | > 25% → force close |
| Reserva mínima | 20% del capital siempre en reserva |

---

## Integración con AgentCore

### Archivo: `agent-integration.ts`

Función `buildCopyTradingForAgent(env)` — construye el orquestador sin:
- Servidor HTTP independiente (el AgentCore usa su propio Fastify)
- Migraciones de DB (las gestiona `initPostgresSchema` del sistema principal)

```typescript
// Paso 5.6 en src/agent/index.ts
if (process.env['COPY_TRADING_ENABLED'] === 'true') {
  const { buildCopyTradingForAgent } = await import('../copy-trading/agent-integration.js');
  this.copyTrading = await buildCopyTradingForAgent(process.env);
  await this.copyTrading.start();
}
```

### Shutdown en AgentCore

```typescript
// En stop() del AgentCore
if (this.copyTrading) {
  await this.copyTrading.gracefulShutdown();
}
```

---

## Integración con RugAlertService

```typescript
// En processSignal() — tras abrir posición exitosamente
if (this.rugAlertService) {
  const shadowLike: ShadowPosition = {
    id: pos.id,
    contractAddress: pos.tokenAddress,
    status: 'OPEN',
    entryPrice: pos.entryPrice,
    tradeSize: BigInt(Math.round(pos.positionSizeUsdc * 1_000_000)),
    signalId: pos.signalId ?? '',
    takeProfit: pos.takeProfit,
    stopLoss: pos.stopLoss,
    timeStop: pos.timeStop,
    openedAt: pos.openedAt,
    closedAt: null, exitPrice: null, pnlUsdc: null,
  };
  this.rugAlertService.trackPosition(shadowLike, pos.poolAddress, pos.poolAddress);
}

// En handlePositionExit()
this.rugAlertService?.untrackPosition(evt.positionId);

// En gracefulShutdown()
if (this.rugAlertService) await this.rugAlertService.stop();
```

---

## HTTP API (bootstrap standalone — puerto 3004)

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/copy/status` | GET | Health, open positions count, circuit breaker |
| `/copy/wallets` | GET | Lista de wallets curadas con tier y métricas |
| `/copy/wallets` | POST | Añadir nueva wallet (requiere API key) |
| `/copy/wallets/:address` | DELETE | Remover wallet (requiere API key) |
| `/copy/positions` | GET | Posiciones abiertas con PnL no realizado |
| `/copy/positions/:id/close` | POST | Cierre manual de posición |
| `/copy/circuit-breaker/reset` | POST | Reset manual del circuit breaker |
| `/copy/metrics` | GET | Métricas agregadas de rendimiento |

---

## Variables de entorno

```env
# Activación
COPY_TRADING_ENABLED=true               # Flag en AgentCore (Paso 5.6)

# Capital y sizing
COPY_INITIAL_CAPITAL_USDC=500           # Capital inicial
COPY_MAX_POSITION_USDC=100              # Cap máximo por posición
COPY_RATIO=0.10                         # % del trade del insider a copiar
COPY_MAX_CONCURRENT_POSITIONS=3        # Posiciones máximas abiertas

# Salidas
COPY_TP_PCT=50                          # Take profit %
COPY_SL_PCT=20                          # Stop loss %
COPY_TRAIL_ACTIVATION_PCT=10           # % profit para activar trailing stop
COPY_TRAIL_DISTANCE_PCT=10             # Distancia del trailing stop
COPY_TIME_STOP_HOURS=48                # Time stop en horas

# RPC y conexión
COPY_WS_RPC_URL=wss://...              # WebSocket RPC Base
COPY_HTTP_RPC_URL=https://...          # Fallback HTTP RPC (opcional)
COPY_POLLING_INTERVAL_MS=2000          # Intervalo polling en ms

# Wallets
COPY_SEED_WALLETS=0xAddr1,0xAddr2     # Wallets smart money iniciales (CSV)

# Seguridad
COPY_API_KEY=...                       # API key para endpoints mutantes
COPY_MAX_GAS_GWEI=50                  # Máximo gas price en gwei
COPY_MAX_SLIPPAGE_PCT=5               # Slippage máximo tolerable
COPY_MAX_LOSS_STREAK=3               # Pérdidas consecutivas antes de CB
```

---

## Base de datos (PostgreSQL)

Tablas creadas por las migraciones:

| Tabla | Contenido |
|-------|-----------|
| `copy_wallets` | Wallets curadas con tier, métricas, estado |
| `copy_signals` | Señales detectadas con resultado de validación |
| `copy_positions` | Posiciones abiertas y cerradas con PnL |
| `bait_flags` | Flags de baiting por wallet |
| `blacklisted_deployers` | Deployers conocidos como scammers |
| `copy_daily_metrics` | Agregados diarios por wallet y tier |

---

## Estado de tests

- **SmartMoneyCurator:** unit + 5 archivos property-based (fast-check)
- **CopyTradingRiskManager:** 155 tests
- **ExitManager:** 96 tests + tests específicos de rug pull
- **CopyMetricsRecorder:** 29+ tests
- **Total:** 400+ tests pasando

---

## Diferencia bootstrap.ts vs agent-integration.ts

| Aspecto | bootstrap.ts | agent-integration.ts |
|---------|-------------|---------------------|
| HTTP API | ✅ Puerto 3004 | ❌ No (usa Fastify del AgentCore) |
| Migraciones DB | ✅ Corre en startup | ❌ No (gestiona initPostgresSchema) |
| PostgreSQL propio | ✅ Conecta su propio pool | ❌ No (usa pgPool compartido) |
| Uso | Standalone / desarrollo | Producción integrado en AgentCore |
