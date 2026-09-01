# Implementation Plan: Hybrid Sniper

## Overview

Implementación del módulo satélite `src/hybrid-sniper/` en TypeScript, siguiendo el
orden **foundation-up**: base de datos y métricas → riesgo → cotizaciones DEX →
validación → ingestión → ejecución shadow → integración HTTP → integración AgentCore →
tests de propiedad (fast-check) → tests de integración. El módulo opera en Phase 0
(shadow-only, sin gas real) y es non-fatal respecto al agente principal.

---

## Tasks

- [x] 1. SniperDatabase y MetricsRecorder (SQLite, CRUD, degraded mode)
  - [x] 1.1 Crear `src/hybrid-sniper/metrics-recorder.ts` con `SniperDatabase` y `MetricsRecorder`
    - Abrir `data/sniper-metrics.db` con `node:sqlite` DatabaseSync
    - Aplicar `PRAGMA journal_mode = WAL` y `PRAGMA synchronous = NORMAL`
    - Crear tablas `sniper_signals` y `shadow_positions` con todos los campos del schema del diseño
    - Crear índices `idx_signals_contract`, `idx_signals_created`, `idx_positions_status`, `idx_positions_contract`
    - Implementar `recordSignal(signal, result): void`, `recordPosition(position): void`
    - Implementar `getRecentSignals(limit): SignalRecord[]`, `getAverageLatency(limit): number`, `close(): void`
    - Implementar degraded mode: si `DatabaseSync` lanza, asignar `this.degraded = true` y continuar en memoria
    - Exportar interfaz `IMetricsRecorder` y clase `MetricsRecorder`
    - _Requirements: 4.2, 4.4, 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ]* 1.2 Escribir property test Property 11: round-trip de señal persistida
    - Usar `fc.record` con `contractAddress`, `source`, `ingestionTime`, `passed`, `rejectReason`, `totalLatencyMs`
    - Abrir SniperDatabase en `:memory:`, persistir con `recordSignal`, leer con `getRecentSignals(1)` y comparar todos los campos
    - Mínimo 150 iteraciones con fast-check
    - **Property 11: Persistencia de señales — round trip**
    - **Validates: Requirements 4.2, 8.2, 8.4**

- [x] 2. RiskBucket (pura, sin dependencias externas, Circuit Breaker)
  - [x] 2.1 Crear `src/hybrid-sniper/risk-bucket.ts` con `RiskBucket`
    - Leer `SNIPER_RISK_BUDGET_USDC` (default 15), `SNIPER_TRADE_SIZE_USDC` (default 5), `SNIPER_MAX_LOSS_STREAK` (default 2) desde env
    - Implementar `availableTrades(): number` → `Math.floor(budget / tradeSize)` cuando CB inactivo
    - Implementar `onPositionClosed(result: 'TP_HIT' | 'SL_HIT' | 'TIME_STOP'): void`
      - `SL_HIT` → incrementar `consecutiveLosses`, activar CB con `blockedUntil = now + 86_400_000` si `>= maxLossStreak`
      - `TP_HIT` | `TIME_STOP` → resetear `consecutiveLosses = 0`
    - Implementar auto-reset en `availableTrades()`: si `now >= blockedUntil`, desactivar CB y resetear contador
    - Implementar `getState(): CircuitBreakerState`, `reset(): void`
    - Exponer `_overrideNow(ts: number)` solo para tests (sin uso en producción)
    - Exportar interfaz `IRiskBucket` y clase `RiskBucket`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_
  - [ ]* 2.2 Escribir property tests Property 8, 9, 10 para RiskBucket
    - **Property 8:** `fc.integer` budget y tradeSize → `availableTrades() === Math.floor(budget / tradeSize)` cuando CB inactivo. 200 iteraciones.
    - **Property 9:** Secuencia de `N` `SL_HIT` + eventos mixtos → CB activo iff `consecutiveLosses >= maxLossStreak`. 300 iteraciones.
    - **Property 10:** Con CB activo, avanzar mock clock más allá de `blockedUntil` → `availableTrades() > 0`, `active = false`. 100 iteraciones.
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6**

- [x] 3. Checkpoint 1 — Base matemática lista
  - Ejecutar `npx vitest --run tests/hybrid-sniper/` y verificar que todos los tests de MetricsRecorder y RiskBucket pasan.
  - Confirmar que `data/sniper-metrics.db` se crea correctamente con el schema esperado.
  - Preguntar al usuario si hay ajustes antes de continuar con los componentes de cotización.

- [x] 4. DexQuoter (abstracción DEX-agnostic, mock-friendly)
  - [x] 4.1 Crear `src/hybrid-sniper/dex-quoter.ts` con `DexQuoter`
    - Definir interfaces `QuoteParams`, `IDexQuoter` y tipo `PoolType = 'uniswap_v3' | 'aerodrome'`
    - Definir **inline** al inicio del archivo el ABI mínimo de Aerodrome (no usar fetch dinámico de ABI para evitar fallos de red en la inicialización):
      ```ts
      const AERODROME_POOL_ABI = [
        {
          name: 'getAmountOut',
          type: 'function',
          inputs: [
            { name: 'amountIn', type: 'uint256' },
            { name: 'tokenIn',  type: 'address' },
          ],
          outputs: [{ name: 'amountOut', type: 'uint256' }],
        },
      ] as const;
      ```
    - Implementar `detectPoolType(poolAddress: string): Promise<PoolType>`
      - Intentar `pool.fee()` → si OK: `'uniswap_v3'`
      - Intentar `pool.factory()` → si factory === `AERODROME_FACTORY` (`0x420DD381b31aEf6683db6B902084cB0FFECe40Da`): `'aerodrome'`
      - Intentar `pool.getAmountOut(1n, tokenIn)` usando `AERODROME_POOL_ABI` → si OK: `'aerodrome'`
      - Fallback: `'uniswap_v3'`
    - Implementar `quote(params: QuoteParams): Promise<bigint>`
      - UniswapV3: `QuoterV2.quoteExactInputSingle.staticCall(params)` usando address `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`
      - Aerodrome: instanciar el pool con `AERODROME_POOL_ABI` y llamar `pool.getAmountOut.staticCall(amountIn, tokenIn)`
    - Aceptar un `provider` inyectable en el constructor (mock-friendly)
    - Exportar interfaz `IDexQuoter` y clase `DexQuoter`
    - _Requirements: 3.9, 5.6_
  - [ ]* 4.2 Escribir unit tests de ejemplo para DexQuoter con mock de provider
    - Mock de pool UniswapV3 → `detectPoolType` retorna `'uniswap_v3'`
    - Mock de pool Aerodrome → `detectPoolType` retorna `'aerodrome'`
    - Mock de `QuoterV2.staticCall` → `quote` retorna `amountOut` esperado
    - Verificar que solo se emiten `eth_call` (no `eth_sendRawTransaction`)
    - _Requirements: 3.9, 5.6_

- [x] 5. ContractValidator (honeypot multi-sell, tax, liquidez, flags)
  - [x] 5.1 Crear `src/hybrid-sniper/contract-validator.ts` con `ContractValidator`
    - Definir interfaces `ValidationResult`, `IContractValidator` y tipo `RejectReason`
    - Implementar `validate(signal: SniperSignal): Promise<ValidationResult>` con el flujo completo:
      - Llamar `dexQuoter.detectPoolType(poolAddress)` para obtener el tipo de pool
      - **HoneypotTest** (Steps 1-4 del pseudocódigo del diseño):
        - `buyAmountOut` = `quote(USDC → token, tradeSize)`; si 0 → `QUOTE_ERROR`
        - `sell1Out` = `quote(token → USDC, buyAmountOut / 2n)`; si 0 → `HONEYPOT_SELL1_ZERO`
        - `sell2Out` = `quote(token → USDC, buyAmountOut - buyAmountOut / 2n)`; si 0 → `HONEYPOT_SELL2_ZERO`
        - `sellTax = (tradeSize - sell1Out - sell2Out) * 100n / tradeSize`; si > 5 → `SELL_TAX_EXCEEDED`
      - **Liquidez**: obtener reserve en USDC del pool; si < 10_000 → `INSUFFICIENT_LIQUIDITY`
      - **FlagScanner**: verificar `isBlacklisted(agentAddress)`, `maxTxAmount`, `maxWalletAmount`, `tradingActive`; si blacklisted → `BLACKLISTED`
      - Asignar `validatedAt = Date.now()` al finalizar todas las checks
      - Calcular `latencyMs = validatedAt - signal.ingestionTime`
    - Capturar cualquier error de RPC → retornar `{ passed: false, rejectReason: 'QUOTE_ERROR' }` y loguear `warn`
    - Exportar interfaz `IContractValidator` y clase `ContractValidator`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10_
  - [ ]* 5.2 Escribir property tests Property 4 y 5 para ContractValidator
    - **Property 4:** `fc.bigInt` para `buyAmountOut`; con `sell1Out = 0n` → resultado `HONEYPOT_SELL1_ZERO`; con `sell2Out = 0n` → `HONEYPOT_SELL2_ZERO`. 100 iteraciones.
    - **Property 5:** `fc.bigInt` expectedOut + `fc.float` lossFactor → si tax > 5 → `SELL_TAX_EXCEEDED`; para liquidez `L < 10_000` → `INSUFFICIENT_LIQUIDITY`. 200 iteraciones.
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**
  - [ ]* 5.3 Escribir unit tests de ejemplo para ContractValidator
    - Mock de `isBlacklisted = true` → `passed = false, rejectReason = 'BLACKLISTED'`
    - Mock de pool detectado como Aerodrome → validación completa sin errores
    - Mock de RPC que lanza → retorna `QUOTE_ERROR` sin propagar excepción
    - _Requirements: 3.7, 3.8, 3.9_

- [x] 6. Checkpoint 2 — Validator completo
  - Ejecutar `npx vitest --run tests/hybrid-sniper/` y verificar que todos los tests de ContractValidator y DexQuoter pasan.
  - Verificar que la honeypot logic rechaza correctamente contratos con `sell1Out = 0n` y `sell2Out = 0n`.
  - Preguntar al usuario si hay ajustes en la lógica de validación antes de continuar.

- [x] 7. SignalIngestor (DexScreener polling, Bitquery GQL, normalización, dedup)
  - [x] 7.1 Crear `src/hybrid-sniper/signal-ingestor.ts` con `SignalIngestor`
    - Definir interfaces `SniperSignal`, `DexScreenerPair`, `BitqueryToken`, `WebhookBody`, `ISignalIngestor`
    - Implementar dedup con `Map<string, number>` (contractAddress → lastSeenMs), ventana de 60 segundos
      - El método `shouldProcess(contractAddress, now)` debe iterar el Map y eliminar todas las entradas cuya marca de tiempo sea `> 60_000 ms` respecto al `now` actual antes de comprobar el duplicado — esto mantiene la memoria acotada y evita fugas con el tiempo
    - Implementar **DexScreener polling**:
      - `GET https://api.dexscreener.com/token-boosts/latest/v1`
      - Filtrar `chainId === 'base'` y `volume.h1 > 10_000`, máx. 20 pares por ciclo
      - Intervalo configurable con `SNIPER_POLL_INTERVAL_MS` (default 30_000 ms)
      - Errores 5xx / timeout: loguear `warn` y continuar en el próximo ciclo
      - **HTTP 429 (rate-limit)**: pausar el polling de DexScreener por 60 segundos (`dexscreenerPausedUntil = Date.now() + 60_000`) y loguear `warn` — nunca reintentar inmediatamente para evitar empeorar el bloqueo; si `Date.now() < dexscreenerPausedUntil` al inicio del ciclo, saltar el poll sin loguear
    - Implementar **Bitquery GraphQL polling**:
      - Endpoint `https://streaming.bitquery.io/graphql`, header `Authorization: Bearer {BITQUERY_API_KEY}`
      - Si `BITQUERY_API_KEY` está vacía: loguear `warn` y omitir el polling (no fallar)
      - Error 401: loguear `warn` y deshabilitar Bitquery para la sesión
    - Implementar `ingestWebhook(body: WebhookBody): Promise<SniperSignal>`
      - Validar que `contractAddress` no esté vacío; si falta, lanzar error con código HTTP 400
      - Asignar `ingestionTime = Date.now()` antes de cualquier llamada asíncrona
    - Implementar `start(): void`, `stop(): void`, `getStats(): { totalReceived, totalDeduped }`
    - El pipeline de procesamiento llama a `ContractValidator.validate` tras normalizar la señal
    - Exportar interfaz `ISignalIngestor` y clase `SignalIngestor`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 9.4_
  - [ ]* 7.2 Escribir property test Property 7 para deduplicación
    - `fc.hexaString` (contractAddress) + `fc.integer` N duplicados (2–10) → exactamente 1 señal procesada en ventana de 60s
    - Usar clase `DedupWindow` extraída de `SignalIngestor` para testar aisladamente
    - Mínimo 200 iteraciones
    - **Property 7: Deduplicación idempotente**
    - **Validates: Requirement 2.5**

- [x] 8. ShadowExecutor (posiciones paper con precios reales, TP/SL/TimeStop)
  - [x] 8.1 Crear `src/hybrid-sniper/shadow-executor.ts` con `ShadowExecutor`
    - Definir interfaces `ShadowPosition` e `IShadowExecutor` con los campos del diseño
    - Implementar `openPosition(signal: SniperSignal): Promise<ShadowPosition | null>`
      - Verificar `riskBucket.availableTrades() > 0`; si 0 → retornar `null` sin lanzar
      - Obtener `entryPrice = dexQuoter.quote({ tokenIn: USDC, amountIn: tradeSize, ... })` via `staticCall`
      - Calcular `takeProfit = entryPrice * BigInt(100 + tpPct) / 100n`
      - Calcular `stopLoss = entryPrice * BigInt(100 - slPct) / 100n`
      - Calcular `timeStop = signal.ingestionTime + 7_200_000`
      - Si cotización falla: loguear `warn`, no abrir posición, no contar como pérdida
    - Implementar `monitorPositions(): Promise<void>` (polling loop interno cada 10s)
      - Para cada posición `OPEN`: obtener `currentPrice = dexQuoter.quote(...)`
      - `currentPrice > takeProfit` → cerrar `TP_HIT`, notificar `riskBucket.onPositionClosed('TP_HIT')`
      - `currentPrice < stopLoss` → cerrar `SL_HIT`, notificar `riskBucket.onPositionClosed('SL_HIT')`
      - `now > timeStop` → cerrar `TIME_STOP`, notificar `riskBucket.onPositionClosed('TIME_STOP')`
      - Calcular `pnlUsdc = Number(exitPrice - entryPrice) / 1_000_000`
      - Llamar `metricsRecorder.recordPosition(position)` al cerrar
    - Implementar `getOpenPositions(): ShadowPosition[]`
    - Exportar interfaz `IShadowExecutor` y clase `ShadowExecutor`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_
  - [ ]* 8.2 Escribir property tests Property 2, 3 y 6 para ShadowExecutor
    - **Property 2 & 3:** `fc.integer` ingestionTime + `fc.nat` delta → `ingestionTime <= validatedAt` y `latencyMs === delta`. 200 iteraciones.
    - **Property 6:** `fc.bigInt` entryPrice + `fc.integer` tpPct + `fc.integer` slPct + `fc.integer` ingestionTime → verificar los 3 invariants de TP/SL/TimeStop. 200 iteraciones.
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 2.6, 3.10, 4.1**

- [x] 9. Checkpoint 3 — Pipeline end-to-end en shadow
  - Ejecutar `npx vitest --run tests/hybrid-sniper/` y verificar que todos los tests de ShadowExecutor pasan.
  - Verificar manualmente (con mocks) que el flujo señal → validación → apertura de posición → persistencia en DB funciona sin errores.
  - Preguntar al usuario si hay ajustes antes de continuar con la integración HTTP.

- [x] 10. Integración index.ts (HybridSniperModule, wireSniper, rutas Fastify)
  - [x] 10.1 Crear `src/hybrid-sniper/index.ts` con `initHybridSniper` y `wireSniper`
    - Definir interfaces `HybridSniperConfig` y `HybridSniperModule` con todos los campos del diseño
    - Implementar `initHybridSniper(env): Promise<HybridSniperModule>`:
      - Parsear todas las variables de entorno con defaults (`SNIPER_RISK_BUDGET_USDC=15`, `SNIPER_TRADE_SIZE_USDC=5`, `SNIPER_MAX_LOSS_STREAK=2`, `SNIPER_TP_PCT=15`, `SNIPER_SL_PCT=5`, `SNIPER_POLL_INTERVAL_MS=30000`)
      - Instanciar `MetricsRecorder` (con degraded mode si DB falla)
      - Instanciar `RiskBucket`, `DexQuoter`, `ContractValidator`, `ShadowExecutor`, `SignalIngestor`
      - Llamar `signalIngestor.start()`
      - Emitir log `info` confirmando arranque en Phase 0 Shadow Mode
      - Retornar el módulo completo con `isEnabled: true`
    - Implementar `wireSniper(fastify, module): void`:
      - Registrar `POST /webhook/alpha`: llamar `signalIngestor.ingestWebhook(body)`, devolver 400 si `contractAddress` faltante
      - Registrar `GET /sniper/status`: retornar `{ signals: getRecentSignals(10), avgLatencyMs: getAverageLatency(10), circuitBreaker: riskBucket.getState() }`
      - Si `SNIPER_ENABLED !== 'true'`: ambas rutas responden HTTP 503 con `"Hybrid Sniper is disabled"`
    - Implementar `module.stop(): void` → llamar `signalIngestor.stop()` y `metricsRecorder.close()`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 4.3, 7.1, 7.2, 7.3, 7.4, 7.5, 9.1, 9.2, 9.3_
  - [ ]* 10.2 Escribir unit tests de ejemplo para initHybridSniper y rutas Fastify
    - `SNIPER_ENABLED=false` → `initHybridSniper` retorna módulo con `isEnabled: false`, sin abrir DB
    - `SNIPER_ENABLED=true` con DB path inválido → degraded mode, no lanza excepción
    - `POST /webhook/alpha` sin `contractAddress` → HTTP 400
    - `POST /webhook/alpha` con body válido → HTTP 200 y señal creada
    - `GET /sniper/status` → estructura `{ signals, avgLatencyMs, circuitBreaker }`
    - `GET /sniper/status` con `SNIPER_ENABLED=false` → HTTP 503
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.3, 2.4, 4.3, 7.4_

- [x] 11. Integración AgentCore (Step 5.5 non-fatal, .env.example)
  - [x] 11.1 Modificar `src/heartbeat/index.ts` para llamar `wireSniper`
    - Agregar solo 2 líneas: importar `wireSniper` y llamar `wireSniper(fastify, hybridSniperModule)` junto a `wireEvolution`
    - NO modificar ninguna otra lógica de `buildFastifyServer` ni del `TradingOrchestrator`
    - _Requirements: 7.5_
  - [x] 11.2 Modificar `src/agent/index.ts` para agregar Step 5.5 non-fatal
    - Agregar bloque `try/catch` (~10 líneas) para inicializar `HybridSniper` como Step 5.5:
      ```typescript
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
      }
      ```
    - NO modificar ningún otro Step ni la lógica de módulos existentes
    - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - [x] 11.3 Agregar 8 variables en `.env.example`
    - Agregar sección comentada en español al final del archivo:
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
    - _Requirements: 9.3_

- [x] 12. Checkpoint 4 — Integración completa
  - Ejecutar `npx tsc --noEmit` para verificar que no hay errores de tipos en los archivos nuevos ni modificados.
  - Ejecutar `npx vitest --run tests/hybrid-sniper/` y verificar que todos los tests pasan.
  - Verificar que el agente arranca con `SNIPER_ENABLED=true` (sin gas real) y el log muestra "Phase 0 Shadow Mode".
  - Verificar que `SNIPER_ENABLED=false` no produce ningún log ni error de inicialización.
  - Preguntar al usuario si hay ajustes antes de continuar con los tests de propiedad y de integración.

- [x] 13. Property tests con fast-check (11 properties)
  - [x] 13.1 Instalar `fast-check` como devDependency
    - Ejecutar `npm install --save-dev fast-check` (pinned a la versión actual estable)
    - Verificar que la instalación no introduce conflictos con Vitest
    - _Requirements: — (prerequisito técnico)_
  - [ ]* 13.2 Crear `tests/hybrid-sniper/properties.test.ts` con Property 1 (Phase 0 invariant)
    - Verificar para cualquier señal procesada que el resultado no contiene `txHash` y que ninguna llamada RPC usa `eth_sendRawTransaction`
    - Mock del provider para interceptar llamadas RPC y verificar solo `eth_call`
    - Mínimo 100 iteraciones
    - **Property 1: Phase 0 invariant — sin transacciones reales**
    - **Validates: Requirements 1.5, 5.6**
  - [ ]* 13.3 Consolidar Properties 2 y 3 en `tests/hybrid-sniper/properties.test.ts`
    - `fc.integer` ingestionTime + `fc.nat` delta → `ingestionTime <= validatedAt` y `totalLatencyMs === delta`. 200 iteraciones.
    - **Property 2 & 3: Ordering invariant + Latency calculation correctness**
    - **Validates: Requirements 2.6, 3.10, 4.1**
  - [ ]* 13.4 Consolidar Properties 4, 5, 7, 8, 9, 10, 11 en `tests/hybrid-sniper/properties.test.ts`
    - Mover / consolidar los tests ya escritos en tareas 1.2, 2.2, 5.2, 7.2 a este archivo unificado
    - Verificar que cada property tiene su tag `Feature: hybrid-sniper, Property N: <texto>`
    - Ejecutar con `numRuns` especificados en el diseño para cada property
    - **Validates: Requirements 2.5, 3.1–3.6, 4.1–4.2, 6.1–6.6, 8.2, 8.4**

- [ ] 14. Tests de integración (mocks de RPC y HTTP endpoints)
  - [ ]* 14.1 Crear `tests/hybrid-sniper/integration.test.ts` — tests de integración de red
    - **DexScreener polling**: mock HTTP con `msw` o `nock`, verificar endpoint correcto y filtro `chainId = 'base'`
    - **Bitquery polling**: mock GraphQL, verificar header `Authorization: Bearer {KEY}` y estructura de query
    - **QuoterV2 `staticCall`**: mock ethers provider, verificar que se emite `eth_call` (no `eth_sendRawTransaction`)
    - **Aerodrome `staticCall`**: mock del pool Solidly, verificar que usa `getAmountOut`
    - _Requirements: 2.1, 2.2, 3.9, 5.6_
  - [ ]* 14.2 Crear `tests/hybrid-sniper/fastify.test.ts` — tests de integración Fastify completos
    - Levantar instancia Fastify en test con mocks de todos los componentes internos
    - `POST /webhook/alpha` flujo completo: señal → validación mock → posición shadow creada → respuesta HTTP 200
    - `GET /sniper/status` con datos reales de MetricsRecorder en memoria → verificar estructura completa
    - Doble `POST /webhook/alpha` con mismo `contractAddress` en < 60s → segunda petición descartada, solo 1 señal procesada
    - _Requirements: 2.3, 2.4, 2.5, 4.3, 7.2, 7.3_

---

## Notes

- Las tareas marcadas con `*` son opcionales y pueden omitirse para un MVP funcional más rápido.
- La instalación de `fast-check` (tarea 13.1) es prerequisito para todas las sub-tareas de property tests; si se saltan los tests opcionales, no es necesaria.
- Archivos **nuevos** creados por este plan: `src/hybrid-sniper/metrics-recorder.ts`, `src/hybrid-sniper/risk-bucket.ts`, `src/hybrid-sniper/dex-quoter.ts`, `src/hybrid-sniper/contract-validator.ts`, `src/hybrid-sniper/signal-ingestor.ts`, `src/hybrid-sniper/shadow-executor.ts`, `src/hybrid-sniper/index.ts`, `tests/hybrid-sniper/properties.test.ts`, `tests/hybrid-sniper/integration.test.ts`, `tests/hybrid-sniper/fastify.test.ts`.
- Archivos **modificados** (mínimamente): `src/heartbeat/index.ts` (+2 líneas), `src/agent/index.ts` (+~10 líneas Step 5.5), `.env.example` (+sección sniper).
- Archivos **explícitamente NO modificados**: `trading-validation/`, `evolution/`, `data/agent.db`.
- Todos los precios se obtienen via `staticCall` (`eth_call`). Nunca se emite `eth_sendRawTransaction`.
- Los bigints de precio se almacenan como TEXT en SQLite para preservar precisión de 256 bits.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["2.2", "4.1"] },
    { "id": 3, "tasks": ["4.2", "5.1"] },
    { "id": 4, "tasks": ["5.2", "5.3", "7.1"] },
    { "id": 5, "tasks": ["7.2", "8.1"] },
    { "id": 6, "tasks": ["8.2", "10.1"] },
    { "id": 7, "tasks": ["10.2", "11.1", "11.2", "11.3"] },
    { "id": 8, "tasks": ["13.1"] },
    { "id": 9, "tasks": ["13.2", "13.3", "13.4"] },
    { "id": 10, "tasks": ["14.1", "14.2"] }
  ]
}
```
