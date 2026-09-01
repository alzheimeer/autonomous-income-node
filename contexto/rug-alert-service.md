# Rug Alert Service — Contexto técnico completo
> Módulo implementado el 19 de Agosto de 2026
> Para contexto general del proyecto ver CLAUDE.md o GEMINI.md

---

## ¿Qué hace?

Detecta señales de rug pull en posiciones OPEN del Hybrid Sniper de forma proactiva (no reactiva). Cuando detecta una señal HIGH o CRITICAL, cierra la posición automáticamente, notifica por Telegram y persiste el evento en PostgreSQL.

Opera como satélite **non-fatal**: si falla al iniciar entra en modo DEGRADED (solo queda el heurístico `MAX_QUOTE_FAILURES` preexistente).

---

## Estructura de archivos

```
src/rug-alert/
├── index.ts                  # API pública: RugAlertService + tipos
├── types.ts                  # AlertEvent, AlertSeverity, AlertReason, IRugAlertService, AlertStats
├── abis.ts                   # RESERVES_ABI, ERC20_TRANSFER_ABI, ERC20_SUPPLY_ABI
├── deduplication-map.ts      # Map<contractAddress:reason, expiry>. TTL env RUG_ALERT_DEDUP_TTL_MS
├── telegram-notifier.ts      # Rate limit 10 msg/5min, cola supresión max 50 entradas
├── liquidity-monitor.ts      # computeDropPct(), classifyLiquidityDrop(), LiquidityMonitor
├── lp-removal-detector.ts    # computeLpRemovedPct(), classifyLpRemoval(), LpRemovalDetector
├── large-holder-sell-detector.ts  # computeTransferPct(), classifyDeployerSell(), LargeHolderSellDetector
├── alert-dispatcher.ts       # AlertDispatcher — pipeline completo post-alerta
└── rug-alert-service.ts      # RugAlertService — orquestador principal
```

---

## Flujo completo

```
openPosition() (ShadowExecutor o MultiVariantExecutor)
    │ (monkey-patched en initHybridSniper)
    ▼
RugAlertService.trackPosition(position, poolAddress, lpTokenAddress)
    ├── liquidityMonitor.addPool()       → polling 15s (5s si CRITICAL)
    ├── lpRemovalDetector.addPool()      → suscripción Transfer events LP token
    └── largeHolderSellDetector.addToken() → suscripción Transfer events + resolución deployer

Detector detecta señal
    ▼
onAlert(AlertEvent) → AlertDispatcher.dispatch(event, position)
    1. deduplicationMap.isDuplicate() → si true, suppressedAlerts++, return
    2. deduplicationMap.register()
    3. stats.counters++, stats.lastAlertAt = now
    4. WARNING? → log only, return
    5. position.status !== 'OPEN'? → log warn, return
    6. dexQuoter.quote() [timeout 2s] → exitPrice (0n si falla)
    7. pnlUsdc = (entryPrice - exitPrice) / entryPrice * (tradeSize / 1_000_000)
    8. event.pnlUsdc = pnlUsdc
    9. executor.closePosition() [timeout 500ms]
   10. riskBucket.onPositionClosed('RUG_PULL')
   11. metricsRecorder.recordAlertEvent(event) [no bloquea si falla]
   12. telegramNotifier.send(event)
   13. positionsClosedByAlert++
```

---

## Severidades y umbrales

### LiquidityMonitor (polling)

| Condición | Severidad | Razón |
|-----------|-----------|-------|
| Reserva cae ≥50% y <80% vs baseline | HIGH | `LIQUIDITY_DROP_HIGH` |
| Reserva cae ≥80% vs baseline | CRITICAL | `LIQUIDITY_DROP_CRITICAL` |
| 3 fallos consecutivos de poll (5s timeout) | CRITICAL | `RESERVE_POLL_FAILURE` |
| Pool CRITICAL → polling escala de 15s a 5s | — | elevación automática |

### LpRemovalDetector (eventos)

| Condición | Severidad | Razón |
|-----------|-----------|-------|
| LP Transfer a ZeroAddress o desde pool address, ≥20% y <60% supply | HIGH | `LP_REMOVAL_HIGH` |
| Misma condición, ≥60% supply | CRITICAL | `LP_REMOVAL_CRITICAL` |
| totalSupply() revierte o retorna 0n | — | skip (no false positive) |

### LargeHolderSellDetector (eventos)

| Condición | Severidad | Razón |
|-----------|-----------|-------|
| Deployer vende ≥10% y <30% supply | HIGH | `DEPLOYER_SELL_HIGH` |
| Deployer vende ≥30% supply | CRITICAL | `DEPLOYER_SELL_CRITICAL` |
| Cualquier wallet vende ≥20% supply a DEX | WARNING | `WHALE_SELL_TO_DEX` |
| totalSupply refresh falla | — | suprime alertas % hasta próximo refresh exitoso |

---

## Modo DEGRADED

Se activa si `RugAlertService.start()` lanza excepción (ej: provider no conecta).

- `degradedMode = true`
- `trackPosition()` es no-op silencioso
- `GET /sniper/rug-alerts` responde con `degradedMode: true`
- Solo queda activo el heurístico `MAX_QUOTE_FAILURES` en ShadowExecutor

---

## Integración con initHybridSniper

```typescript
// Paso 8.5 — después de crear ShadowExecutor y MultiVariantExecutor
let rugAlertService: RugAlertService | null = null;
try {
  const { TelegramClient } = await import('../social/telegram-client.js');
  rugAlertService = new RugAlertService(provider, dexQuoter, shadowExecutor,
    multiVariantExecutor, metricsRecorder, riskBucket, new TelegramClient(), env);
  await rugAlertService.start();
} catch (err) {
  // DEGRADED mode — log warn, rugAlertService = null
}

// Monkey-patch openPosition para registrar cada posición nueva
shadowExecutor.openPosition = async (signal) => {
  const position = await _orig(signal);
  if (position && rugAlertService) {
    rugAlertService.trackPosition(position, signal.poolAddress ?? position.contractAddress, position.contractAddress);
  }
  return position;
};
```

---

## Endpoints HTTP

### GET /sniper/rug-alerts

```json
{
  "monitoredPositions": 3,
  "alertsEmitted": { "WARNING": 1, "HIGH": 0, "CRITICAL": 2 },
  "positionsClosedByAlert": 2,
  "suppressedAlerts": 5,
  "lastAlertAt": "2026-08-19T14:32:00.000Z",
  "degradedMode": false
}
```

### GET /sniper/status — campo rugAlerts añadido

```json
{
  "signals": [...],
  "avgLatencyMs": 245,
  "circuitBreaker": {...},
  "exploration": {...},
  "rugAlerts": { ... }  // null si rugAlertService no disponible
}
```

---

## Base de datos

```sql
-- Tabla alert_events (PostgreSQL, migración automática en initPostgresSchema)
CREATE TABLE IF NOT EXISTS alert_events (
  id                TEXT             NOT NULL PRIMARY KEY,
  contract_address  TEXT             NOT NULL,
  severity          TEXT             NOT NULL,  -- WARNING | HIGH | CRITICAL
  reason            TEXT             NOT NULL,
  detected_at       BIGINT           NOT NULL,  -- Unix ms
  position_id       TEXT             NOT NULL,
  pnl_usdc          DOUBLE PRECISION,           -- null si no resoluble
  transaction_hash  TEXT,                       -- null para alertas por polling
  created_at        BIGINT           NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alert_events_contract ON alert_events (contract_address, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_events_position ON alert_events (position_id);
```

---

## Variables de entorno

```env
RUG_ALERT_DEDUP_TTL_MS=120000          # TTL deduplication en ms (default: 120s)
USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  # Base USDC
DEX_POOL_ADDRESSES=0x4752...,0x8909... # DEX addresses para detección whale-to-DEX
```

---

## Integración con CopyTrading

El `RugAlertService` está integrado en **ambos** sistemas:

### En HybridSniper (`src/hybrid-sniper/index.ts`)
- Paso 8.5 en `initHybridSniper()`
- Monkey-patch `shadowExecutor.openPosition()` → `rugAlertService.trackPosition()`
- Monkey-patch `multiVariantExecutor.openMultiVariantPositions()` → idem

### En CopyTrading (`src/copy-trading/CopyTradingOrchestrator.ts`)
- `processSignal()`: tras `executor.execute()` exitoso → `trackPosition(shadowLike, poolAddress, poolAddress)`
- `handlePositionExit()`: → `untrackPosition(positionId)` 
- `gracefulShutdown()`: → `await rugAlertService.stop()`

**Objeto shadowLike** (mapeo CopyPosition → ShadowPosition):
```typescript
{
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
}
```

- **35 tests pasando** (unit + property-based con fast-check)
- **0 errores TypeScript**

Archivos de test:
- `src/rug-alert/deduplication-map.test.ts` — 17 unit tests
- `src/rug-alert/__tests__/deduplication-map.property.test.ts` — 5 tests de propiedad (100 iteraciones cada uno)
- `src/rug-alert/liquidity-monitor.test.ts` — 13 unit tests

---

## Propiedades de corrección verificadas

| Propiedad | Descripción | Requisitos |
|-----------|-------------|------------|
| P1 | Severidad de caída de reservas es monótona y exclusiva | Req 1.3, 1.4, 1.7 |
| P2 | RESERVE_POLL_FAILURE se emite exactamente 1 vez por run | Req 1.5 |
| P3 | Severidad LP removal es monótona y exclusiva | Req 2.2, 2.3 |
| P4 | Severidad deployer sell es monótona y exclusiva | Req 3.3, 3.4 |
| P5 | Deduplication es TTL-bounded y case-insensitive | Req 8.1, 8.2, 8.5 |
| P6 | Mensaje Telegram contiene todos los campos requeridos | Req 5.2 |
| P7 | PnL de pérdida 100% es correcto para cualquier trade size | Req 4.4, 4.6 |
| P8 | Rate limit impone cap 10/5min, cola nunca excede 50 | Req 5.4, 5.5 |
| P9 | TTL inválido siempre usa default 120 000 ms | Req 8.4 |
