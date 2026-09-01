# Implementation Plan: Copy-Trading Smart Money

## Overview

Este plan implementa el módulo Copy-Trading Smart Money en TypeScript, siguiendo la arquitectura de 6 componentes principales: SmartMoneyCurator, WalletWatcher, SignalEnricher, CopyExecutor, ExitManager, y AntiBaitingModule.

### Estructura de Carpetas

```
src/
├── shared/                      # NUEVO - Módulos compartidos (refactorizados de hybrid-sniper)
│   ├── index.ts
│   ├── dex-quoter.ts           # Cotizaciones DEX via staticCall
│   ├── risk-bucket.ts          # Gestión de riesgo y circuit breaker
│   ├── metrics-recorder.ts     # Persistencia de métricas en PostgreSQL
│   └── contract-validator.ts   # Validación de honeypots y liquidez
│
├── copy-trading/               # NUEVO - Copy Trading Smart Money
│   ├── index.ts
│   ├── config/
│   │   └── CopyTradingConfig.ts
│   ├── interfaces/
│   │   └── types.ts
│   ├── modules/
│   │   ├── SmartMoneyCurator.ts
│   │   ├── WalletWatcher.ts
│   │   ├── SignalEnricher.ts
│   │   ├── CopyExecutor.ts
│   │   ├── ExitManager.ts
│   │   ├── AntiBaitingModule.ts
│   │   └── CopyMetricsRecorder.ts
│   ├── routes/
│   │   └── copy.ts
│   └── tests/
│
└── hybrid-sniper/              # LEGACY - Micro-cap sniping (CANCELADO)
    └── (mantener como referencia histórica, SNIPER_ENABLED=false)
```

## Tasks

- [x] 1. Refactoring: Crear carpeta shared y mover módulos reutilizables
  - [x] 1.1 Crear estructura de carpeta shared
    - Crear `src/shared/` con archivo de barril `index.ts`
    - _Prerequisites: none_

  - [x] 1.2 Mover DexQuoter a shared
    - Copiar `src/hybrid-sniper/dex-quoter.ts` a `src/shared/dex-quoter.ts`
    - Actualizar imports internos
    - Exportar desde `src/shared/index.ts`
    - _Prerequisites: 1.1_

  - [x] 1.3 Mover RiskBucket a shared
    - Copiar `src/hybrid-sniper/risk-bucket.ts` a `src/shared/risk-bucket.ts`
    - Actualizar imports internos
    - Exportar desde `src/shared/index.ts`
    - _Prerequisites: 1.1_


  - [x] 1.4 Mover MetricsRecorder a shared
    - Copiar `src/hybrid-sniper/metrics-recorder.ts` a `src/shared/metrics-recorder.ts`
    - Actualizar imports internos
    - Exportar desde `src/shared/index.ts`
    - _Prerequisites: 1.1_

  - [x] 1.5 Mover ContractValidator a shared
    - Copiar `src/hybrid-sniper/contract-validator.ts` a `src/shared/contract-validator.ts`
    - Actualizar imports internos
    - Exportar desde `src/shared/index.ts`
    - _Prerequisites: 1.1_

  - [x] 1.6 Actualizar imports en hybrid-sniper para usar shared
    - Modificar `src/hybrid-sniper/index.ts` para importar desde `../shared/`
    - Modificar `src/hybrid-sniper/shadow-executor.ts`
    - Modificar `src/hybrid-sniper/multi-variant-executor.ts`
    - Modificar `src/hybrid-sniper/signal-ingestor.ts`
    - Verificar que hybrid-sniper sigue compilando
    - _Prerequisites: 1.2, 1.3, 1.4, 1.5_

- [x] 2. Checkpoint - Verificar refactoring de shared
  - Ensure all tests pass, hybrid-sniper compila correctamente
  - Verificar que `src/shared/index.ts` exporta los 4 módulos

- [x] 3. Setup inicial del módulo copy-trading
  - [x] 3.1 Crear estructura de directorios del módulo copy-trading
    - Crear `src/copy-trading/` con subdirectorios: `interfaces/`, `modules/`, `config/`, `routes/`, `tests/`
    - Crear archivo de barril `src/copy-trading/index.ts`
    - _Requirements: 10.1-10.13_
    - _Prerequisites: 2_

  - [x] 3.2 Implementar carga de configuración desde environment variables
    - Crear `src/copy-trading/config/CopyTradingConfig.ts`
    - Implementar validación y defaults según Requirements 10.x
    - Logging de configuración cargada al inicio
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11, 10.12, 10.13_


  - [x]* 3.3 Write property test for configuration defaults
    - **Property 33: Configuration Default Values**
    - **Validates: Requirements 10.1-10.12**

  - [x] 3.4 Crear interfaces TypeScript base
    - Crear `src/copy-trading/interfaces/types.ts` con WalletTier, SwapAction, CopySignal
    - Crear interfaces para todos los módulos según design.md
    - _Requirements: 1.12, 2.8_

  - [x] 3.5 Crear migraciones de base de datos PostgreSQL
    - Crear migración para tabla `copy_wallets`
    - Crear migración para tabla `copy_signals`
    - Crear migración para tabla `copy_positions`
    - Crear migración para tablas `bait_flags` y `blacklisted_deployers`
    - Crear migración para tabla `copy_daily_metrics`
    - _Requirements: 8.1, 8.2, 8.3_

- [x] 4. Checkpoint - Verificar estructura base copy-trading
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implementar SmartMoneyCurator
  - [x] 5.1 Implementar evaluación de criterios de inclusión
    - Crear `src/copy-trading/modules/SmartMoneyCurator.ts`
    - Implementar validación: win_rate ≥70%, pnl ≥$50K, trades ≥100
    - Implementar validación de holding time (15min-7days) y volume ≥$500K
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x]* 5.2 Write property test for wallet inclusion criteria
    - **Property 1: Wallet Inclusion Criteria Enforcement**
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6**

  - [x] 5.3 Implementar filtros de exclusión de wallets
    - Detectar MEV bots (>50% trades en mismo bloque)
    - Excluir deployers de tokens (últimos 180 días)
    - Excluir wallets con >20% honeypot exposure
    - Excluir receptores de airdrops de deployers
    - Excluir wash traders (>30% mismo counterparty)
    - _Requirements: 1.7, 1.8, 1.9, 1.10, 1.11_


  - [x]* 5.4 Write property test for wallet exclusion filters
    - **Property 2: Wallet Exclusion Filters Enforcement**
    - **Validates: Requirements 1.7, 1.8, 1.9, 1.10, 1.11**

  - [x] 5.5 Implementar sistema de tiers y scoring
    - Calcular score combinado (win_rate × profit_factor × sharpe_ratio)
    - Asignar S_TIER (top 5), A_TIER (6-15), B_TIER (16-50)
    - Garantizar idempotencia de asignación
    - _Requirements: 1.12_

  - [x]* 5.6 Write property test for tier assignment
    - **Property 4: Tier Assignment Determinism**
    - **Validates: Requirements 1.12**

  - [x] 5.7 Implementar gestión de lista de wallets
    - Mantener límite de 10-50 wallets monitoreadas
    - Implementar addWallet, removeWallet, getWallets
    - Implementar isMonitored lookup
    - _Requirements: 1.1_

  - [x]* 5.8 Write property test for wallet count bounds
    - **Property 3: Wallet Count Bounds Invariant**
    - **Validates: Requirements 1.1**

  - [x] 5.9 Implementar re-evaluación periódica de wallets
    - Ejecutar re-evaluación cada 24 horas
    - Remover wallets con win_rate <60%
    - Actualizar métricas y tiers
    - _Requirements: 1.13, 1.14_

  - [x]* 5.10 Write property test for degraded wallet removal
    - **Property 5: Degraded Wallet Removal**
    - **Validates: Requirements 1.14**

- [x] 6. Checkpoint - SmartMoneyCurator completo
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implementar WalletWatcher
  - [x] 7.1 Implementar conexión WebSocket a RPC
    - Crear `src/copy-trading/modules/WalletWatcher.ts`
    - Implementar conexión WebSocket con auto-reconnect (10s)
    - Implementar heartbeat cada 30 segundos
    - _Requirements: 2.2, 2.9, 2.10_


  - [x] 7.2 Implementar modo polling como fallback
    - Polling HTTP cada 2 segundos
    - Modo híbrido (WebSocket + polling)
    - _Requirements: 2.2, 2.3_

  - [x] 7.3 Implementar decodificación de swap calldata
    - Decodificar swaps de Uniswap V3, Aerodrome, 1inch
    - Extraer token address, amount, direction
    - _Requirements: 2.4, 2.5_

  - [x]* 7.4 Write property test for swap calldata decoding
    - **Property 6: Swap Calldata Decode Round-Trip**
    - **Validates: Requirements 2.4, 2.5**

  - [x] 7.5 Implementar filtrado de dust transfers
    - Ignorar transferencias <$100 USDC
    - Ignorar transferencias internas (no-swap)
    - _Requirements: 2.6, 2.7_

  - [x]* 7.6 Write property test for dust filtering
    - **Property 7: Dust Transfer Filtering**
    - **Validates: Requirements 2.6**

  - [x] 7.7 Implementar emisión de CopySignal
    - Construir señal completa con todos los campos requeridos
    - Calcular latencia de detección
    - Logging con timestamp y métricas
    - _Requirements: 2.1, 2.8, 2.11_

  - [x]* 7.8 Write property test for signal completeness
    - **Property 8: CopySignal Field Completeness**
    - **Validates: Requirements 2.8**

- [x] 8. Checkpoint - WalletWatcher completo
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Implementar SignalEnricher
  - [x] 9.1 Implementar validación de liquidez
    - Crear `src/copy-trading/modules/SignalEnricher.ts`
    - Verificar pool liquidity ≥$10K USDC o ≥2.0 WETH
    - Rechazar con LOW_LIQUIDITY si no cumple
    - Usar `DexQuoter` de `src/shared/` para cotizaciones
    - _Requirements: 3.1, 3.2_


  - [x] 9.2 Implementar detección de honeypot
    - Simular transacción de venta via staticCall
    - Rechazar con HONEYPOT_DETECTED si sell retorna 0
    - Usar `ContractValidator` de `src/shared/`
    - _Requirements: 3.3, 3.4_

  - [x] 9.3 Implementar cálculo de transfer tax
    - Comparar buy input vs sell output
    - Calcular tax_pct = (X - Y) / X × 100
    - Rechazar con TRANSFER_TAX_EXCEEDED si >5%
    - _Requirements: 3.5, 3.6_

  - [x]* 9.4 Write property test for tax calculation
    - **Property 10: Transfer Tax Calculation Accuracy**
    - **Validates: Requirements 3.5**

  - [x] 9.5 Implementar estimación de slippage
    - Estimar slippage para position size planeado
    - Rechazar con HIGH_SLIPPAGE si >5%
    - _Requirements: 3.7, 3.8_

  - [x] 9.6 Implementar verificación de deployer y LP lock
    - Verificar historial de rug del deployer
    - Rechazar con DEPLOYER_FLAGGED si deployer conocido como scammer
    - Verificar LP burned/locked ≥50%
    - Rechazar con UNVERIFIED_LP si no cumple
    - _Requirements: 3.9, 3.10, 3.11, 3.12_

  - [x] 9.7 Implementar detección de round-trip baiting
    - Detectar buy+sell del mismo token en <1 hora
    - Rechazar con BAITING_DETECTED si detectado
    - _Requirements: 3.13, 3.14_

  - [x]* 9.8 Write property test for round-trip baiting
    - **Property 11: Round-Trip Baiting Detection**
    - **Validates: Requirements 3.13, 3.14**

  - [x] 9.9 Implementar cascade de validación completa
    - Ejecutar todas las validaciones en orden
    - Primera condición que falla determina reject reason
    - Emitir EnrichedSignal con datos de enrichment
    - Timeout de validación: 2 segundos máximo
    - _Requirements: 3.1, 3.15_

  - [x]* 9.10 Write property test for validation cascade
    - **Property 9: Signal Validation Rejection Cascade**
    - **Validates: Requirements 3.2, 3.4, 3.6, 3.8, 3.10, 3.12**


- [x] 10. Checkpoint - SignalEnricher completo
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Implementar AntiBaitingModule
  - [x] 11.1 Implementar detección de tokens del deployer
    - Crear `src/copy-trading/modules/AntiBaitingModule.ts`
    - Rechazar tokens deployeados por source wallet en últimos 30 días
    - Mantener blacklist de deployers conocidos
    - _Requirements: 7.1, 7.2_

  - [x]* 11.2 Write property test for deployer token rejection
    - **Property 27: Deployer Token Rejection**
    - **Validates: Requirements 7.1**

  - [x] 11.3 Implementar detección de concentración de holders
    - Rechazar si >30% de holders son wallets monitoreadas
    - _Requirements: 7.3_

  - [x]* 11.4 Write property test for holder concentration
    - **Property 28: Monitored Holder Concentration**
    - **Validates: Requirements 7.3**

  - [x] 11.5 Implementar tracking de bait flags
    - Registrar flags cuando wallet hace buy+sell en <1 hora
    - Remover wallet tras 3+ flags en 7 días
    - _Requirements: 7.4, 7.5, 7.6_

  - [x]* 11.6 Write property test for bait flag accumulation
    - **Property 29: Bait Flag Accumulation**
    - **Validates: Requirements 7.5, 7.6**

  - [x] 11.7 Implementar límite de volume footprint
    - Rechazar si nuestra posición excedería 5% del volumen diario
    - _Requirements: 7.7_

  - [x]* 11.8 Write property test for volume footprint
    - **Property 30: Volume Footprint Limit**
    - **Validates: Requirements 7.7, 4.12**

  - [x] 11.9 Implementar delays aleatorios de ejecución
    - Generar delay uniforme entre 5-30 segundos
    - Rotación de wallets de ejecución (cuando habilitado)
    - Logging de patrones detectados
    - _Requirements: 7.8, 7.9, 7.10_

- [x] 12. Checkpoint - AntiBaitingModule completo
  - Ensure all tests pass, ask the user if questions arise.


- [x] 13. Implementar CopyExecutor
  - [x] 13.1 Implementar cálculo de position sizing
    - Crear `src/copy-trading/modules/CopyExecutor.ts`
    - Calcular: min(insider × 10%, $100, capital × 5%)
    - Aplicar multiplicador de tier: S=1.5x, A=1.0x, B=0.5x
    - Rechazar posiciones <$10 USDC
    - Usar `DexQuoter` de `src/shared/` para ejecución
    - _Requirements: 4.1, 4.2, 4.3_

  - [x]* 13.2 Write property test for position sizing
    - **Property 12: Position Sizing Formula Correctness**
    - **Validates: Requirements 4.1, 4.2, 4.3**

  - [x] 13.3 Implementar delay aleatorio pre-ejecución
    - Delay uniforme entre 5-30 segundos
    - _Requirements: 4.4_

  - [x]* 13.4 Write property test for execution delay bounds
    - **Property 13: Execution Delay Bounds**
    - **Validates: Requirements 4.4**

  - [x] 13.5 Implementar splitting de órdenes grandes
    - Dividir en 3 órdenes si position >$50 USDC
    - Delay de 10 segundos entre órdenes
    - _Requirements: 4.5_

  - [x]* 13.6 Write property test for order splitting
    - **Property 14: Large Order Splitting**
    - **Validates: Requirements 4.5**

  - [x] 13.7 Implementar slippage dinámico
    - Base 1% + 0.5% por cada $10K faltante de liquidez
    - Cap máximo de 5%
    - _Requirements: 4.6_

  - [x]* 13.8 Write property test for dynamic slippage
    - **Property 15: Dynamic Slippage Calculation**
    - **Validates: Requirements 4.6**

  - [x] 13.9 Implementar validaciones pre-ejecución
    - Abortar si gas >50 gwei
    - Abortar si gas estimate >2x esperado
    - Simular tx con staticCall antes de broadcast
    - Abortar si simulación muestra pérdida >10%
    - Abortar si excede 5% del volumen diario del token
    - _Requirements: 4.7, 4.8, 4.9, 4.10, 4.12_

  - [x] 13.10 Implementar registro de posiciones
    - Crear CopyPosition con entry_price, TP, SL, time_stop
    - Integrar con DexQuoter para ejecución
    - Persistir posición en base de datos
    - _Requirements: 4.11_


- [x] 14. Checkpoint - CopyExecutor completo
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Implementar RiskBucket integration (usando src/shared/)
  - [x] 15.1 Implementar límite de posiciones concurrentes
    - Usar `RiskBucket` de `src/shared/`
    - Máximo 3 posiciones abiertas simultáneas
    - Rechazar nuevos trades con MAX_POSITIONS_REACHED
    - _Requirements: 5.1_

  - [x]* 15.2 Write property test for position limit
    - **Property 16: Concurrent Position Limit**
    - **Validates: Requirements 5.1**

  - [x] 15.3 Implementar límite de capital diario
    - Máximo 20% del capital total por día
    - Reset a 00:00 UTC
    - _Requirements: 5.2, 5.7_

  - [x]* 15.4 Write property test for daily capital limit
    - **Property 17: Daily Capital Deployment Limit**
    - **Validates: Requirements 5.2**

  - [x] 15.5 Implementar circuit breaker por loss streak
    - Activar tras 3 pérdidas consecutivas (SL o RUG)
    - Duración: 24 horas
    - Logging de activaciones
    - _Requirements: 5.3, 5.10_

  - [x]* 15.6 Write property test for loss streak circuit breaker
    - **Property 18: Circuit Breaker Activation on Loss Streak**
    - **Validates: Requirements 5.3**

  - [x] 15.7 Implementar bloqueo de trades durante circuit breaker
    - Rechazar todas las señales mientras CB activo
    - _Requirements: 5.4_

  - [x]* 15.8 Write property test for circuit breaker blocking
    - **Property 19: Circuit Breaker Trade Blocking**
    - **Validates: Requirements 5.4**

  - [x] 15.9 Implementar circuit breaker por PnL diario
    - Activar si PnL diario alcanza -15% del capital
    - Duración: 24 horas
    - _Requirements: 5.5, 5.6_

  - [x]* 15.10 Write property test for daily PnL circuit breaker
    - **Property 20: Daily PnL Circuit Breaker**
    - **Validates: Requirements 5.6**

  - [x] 15.11 Implementar force close por drawdown excesivo
    - Cerrar posición a market si drawdown >25%
    - _Requirements: 5.8_


  - [x]* 15.12 Write property test for forced close on drawdown
    - **Property 21: Forced Position Close on Drawdown**
    - **Validates: Requirements 5.8**

  - [x] 15.13 Implementar reserva de capital mínima
    - Mantener siempre 20% en reserva
    - Nunca desplegar más del 80%
    - _Requirements: 5.9_

  - [x]* 15.14 Write property test for capital reserve
    - **Property 22: Capital Reserve Invariant**
    - **Validates: Requirements 5.9**

- [x] 16. Checkpoint - RiskBucket integration completa
  - ✓ Tests CopyTradingRiskManager: 155/155 pasaron
  - ✓ TypeScript compila sin errores
  - ✓ CopyTradingRiskManager exportado desde módulo index
  - Requisitos verificados:
    - 5.1: Límite de 3 posiciones concurrentes ✓
    - 5.2: Límite diario de capital 20% ✓
    - 5.3: Circuit breaker tras 3 pérdidas consecutivas ✓
    - 5.4: Bloqueo de trades durante circuit breaker ✓
    - 5.5-5.6: Circuit breaker en -15% PnL diario ✓
    - 5.7: Reset de límites diarios a 00:00 UTC ✓
    - 5.8: Force close en drawdown >25% ✓
    - 5.9: Reserva de capital mínima 20% ✓
    - 5.10: Logging de activaciones de circuit breaker ✓

- [x] 17. Implementar ExitManager
  - [x] 17.1 Crear estructura base de ExitManager
    - Crear `src/copy-trading/modules/ExitManager.ts`
    - Implementar start/stop para monitoreo
    - Implementar registerPosition para nuevas posiciones
    - Usar `DexQuoter` de `src/shared/` para cotizaciones de salida
    - _Requirements: 6.1_

  - [x] 17.2 Implementar estrategia follow insider
    - Detectar cuando source wallet vende ≥50%
    - Cerrar posición dentro de 30 segundos
    - _Requirements: 6.2_

  - [x]* 17.3 Write property test for follow insider exit
    - **Property 23: Follow Insider Exit**
    - **Validates: Requirements 6.2**

  - [x] 17.4 Implementar trailing stop state machine
    - Inicializar a -15% bajo entry
    - Activar cuando precio sube 10%
    - Seguir a 10% bajo highest price
    - Cerrar cuando precio toca trailing stop
    - _Requirements: 6.4, 6.5, 6.6, 6.7_

  - [x]* 17.5 Write property test for trailing stop
    - **Property 24: Trailing Stop State Machine**
    - **Validates: Requirements 6.4, 6.5, 6.6, 6.7**

  - [x] 17.6 Implementar exits fijos (TP/SL/Time)
    - Take profit a +50%
    - Stop loss a -20%
    - Time stop a 48 horas
    - _Requirements: 6.8, 6.9, 6.10_

  - [x]* 17.7 Write property test for fixed exits
    - **Property 25: Fixed Exit Triggers**
    - **Validates: Requirements 6.8, 6.9, 6.10**


  - [x] 17.8 Implementar detección de rug pull
    - Marcar como RUG_PULL tras 3 quote failures
    - Registrar 100% loss
    - _Requirements: 6.12_

  - [x]* 17.9 Write property test for rug pull detection
    - **Property 26: Rug Pull Detection**
    - **Validates: Requirements 6.12**

  - [x] 17.10 Implementar switch automático a trailing stop
    - Si insider no vende en 24h, cambiar a modo trailing
    - _Requirements: 6.3_

  - [x] 17.11 Implementar registro de exits
    - Registrar exit_reason, exit_price, final_pnl
    - Persistir en base de datos
    - _Requirements: 6.11_

- [x] 18. Checkpoint - ExitManager completo
  - ✓ 96 tests ExitManager pasaron
  - ✓ ExitRecord type y métodos implementados
  - ✓ recordExit, getExitHistory, getExitsByReason funcionando
  - ✓ Integración automática con closePosition
  - Ensure all tests pass, ask the user if questions arise.

- [x] 19. Implementar CopyMetricsRecorder (extendiendo src/shared/)
  - [x] 19.1 Implementar persistencia de CopySignals
    - Crear `src/copy-trading/modules/CopyMetricsRecorder.ts`
    - Extender `MetricsRecorder` de `src/shared/`
    - Persistir todas las señales con resultado de validación
    - _Requirements: 8.1_

  - [x]* 19.2 Write property test for metrics persistence
    - **Property 31: Metrics Persistence Round-Trip**
    - **Validates: Requirements 8.1**

  - [x] 19.3 Implementar persistencia de posiciones
    - Guardar entry, exit, PnL, duration, exit_reason
    - _Requirements: 8.2_

  - [x] 19.4 Implementar cálculo de métricas agregadas
    - Win rate, PnL promedio, Sharpe ratio por wallet
    - Métricas por tier (S, A, B)
    - Agregaciones diarias, semanales, mensuales
    - _Requirements: 8.3, 8.4, 8.5_

  - [x] 19.5 Implementar restauración de posiciones al restart
    - Cargar posiciones con status='OPEN' desde DB
    - Restaurar parámetros originales
    - Registrar en ExitManager para continuar monitoreo
    - _Requirements: 8.9, 8.10_

  - [x]* 19.6 Write property test for position restoration
    - **Property 32: Position Restoration on Restart**
    - **Validates: Requirements 8.9, 8.10**

  - [x] 19.7 Implementar generación de reporte diario
    - Total PnL, win rate, top wallets
    - _Requirements: 8.11_


- [x] 20. Checkpoint - CopyMetricsRecorder completa
  - ✓ 29+ tests CopyMetricsRecorder pasaron
  - ✓ Persistencia de signals y positions funcional
  - ✓ Métricas agregadas implementadas (wallet, tier, daily/weekly/monthly)
  - ✓ Restauración de posiciones al restart con manejo de time_stop expirados
  - ✓ Reporte diario con top/worst wallets y exit breakdown

- [x] 21. Implementar HTTP API endpoints
  - [x] 21.1 Implementar endpoint GET /copy/status
    - Crear `src/copy-trading/routes/copy.ts`
    - Retornar health, open positions count, circuit breaker state
    - _Requirements: 9.1_

  - [x] 21.2 Implementar endpoints de gestión de wallets
    - GET /copy/wallets - lista con tiers y métricas
    - POST /copy/wallets - añadir nueva wallet (validación)
    - DELETE /copy/wallets/:address - remover wallet
    - Validación de address (HTTP 400 si inválido)
    - _Requirements: 9.2, 9.3, 9.4, 9.9_

  - [x] 21.3 Implementar endpoints de posiciones
    - GET /copy/positions - posiciones abiertas con unrealized PnL
    - POST /copy/positions/:id/close - cerrar posición manualmente
    - _Requirements: 9.5, 9.6_

  - [x] 21.4 Implementar endpoints de control
    - POST /copy/circuit-breaker/reset - reset manual del CB
    - GET /copy/metrics - métricas agregadas
    - _Requirements: 9.7, 9.8_

  - [x] 21.5 Implementar autenticación API key
    - Requerir API key para endpoints POST/DELETE
    - _Requirements: 9.10_

- [x] 22. Checkpoint - HTTP API completa
  - Ensure all tests pass, ask the user if questions arise.

- [x] 23. Integración y wiring de componentes
  - [x] 23.1 Crear CopyTradingOrchestrator
    - Crear `src/copy-trading/CopyTradingOrchestrator.ts`
    - Instanciar y conectar todos los módulos
    - Usar módulos compartidos de `src/shared/`
    - Implementar start/stop lifecycle
    - _Requirements: All_

  - [x] 23.2 Conectar flujo de señales completo
    - WalletWatcher → SignalEnricher → AntiBaitingModule → CopyExecutor
    - CopyExecutor → ExitManager (registro de posiciones)
    - ExitManager → CopyMetricsRecorder (registro de exits)
    - _Requirements: All signal flow requirements_


  - [x] 23.3 Integrar con módulos shared
    - Conectar `DexQuoter` de `src/shared/` para cotizaciones
    - Conectar `RiskBucket` de `src/shared/` para gestión de riesgo
    - Conectar `ContractValidator` de `src/shared/` para validación de honeypots
    - Conectar `MetricsRecorder` de `src/shared/` como base
    - _Requirements: Integration with shared modules_

  - [x] 23.4 Implementar graceful shutdown
    - Cerrar conexiones WebSocket
    - Persistir estado de posiciones
    - Flush de métricas pendientes
    - _Requirements: System reliability_

  - [x]* 23.5 Write integration tests for signal flow
    - Test end-to-end: signal detection → validation → execution → exit
    - Test circuit breaker integration
    - Test position restoration after restart
    - _Requirements: All_

- [x] 24. Final checkpoint - Sistema completo
  - Ensure all tests pass, ask the user if questions arise.
  - Verificar cobertura de tests ≥80%
  - Verificar todas las 33 property tests pasan
  - Verificar integración con módulos shared


## Notes

- **Tarea 1 (Refactoring)** es CRÍTICA y debe completarse primero para establecer la estructura de carpetas
- Tasks marked with `*` are optional property-based tests that can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation after each major module
- Property tests validate universal correctness properties from design.md (33 total)
- The system imports shared modules from `src/shared/`: DexQuoter, RiskBucket, MetricsRecorder, ContractValidator
- `hybrid-sniper` se mantiene como referencia histórica pero está DESHABILITADO (SNIPER_ENABLED=false)
- All delays (5-30s) are intentional for anti-detection, TypeScript performance is adequate
- WebSocket + Polling hybrid provides redundancy for <5s detection latency


## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"], "description": "Crear carpeta shared" },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5"], "description": "Mover módulos a shared" },
    { "id": 2, "tasks": ["1.6"], "description": "Actualizar imports en hybrid-sniper" },
    { "id": 3, "tasks": ["3.1", "3.2"], "description": "Setup copy-trading" },
    { "id": 4, "tasks": ["3.3", "3.4", "3.5"], "description": "Interfaces y DB" },
    { "id": 5, "tasks": ["5.1", "7.1"], "description": "SmartMoneyCurator y WalletWatcher base" },
    { "id": 6, "tasks": ["5.2", "5.3", "7.2"], "description": "Inclusión y polling" },
    { "id": 7, "tasks": ["5.4", "5.5", "7.3"], "description": "Exclusión y calldata" },
    { "id": 8, "tasks": ["5.6", "5.7", "7.4", "7.5"], "description": "Tiers y dust filter" },
    { "id": 9, "tasks": ["5.8", "5.9", "7.6", "7.7"], "description": "Wallet limits y signals" },
    { "id": 10, "tasks": ["5.10", "7.8", "9.1"], "description": "Re-eval y SignalEnricher" },
    { "id": 11, "tasks": ["9.2", "9.3", "11.1"], "description": "Honeypot y AntiBaiting" },
    { "id": 12, "tasks": ["9.4", "9.5", "9.6", "11.2"], "description": "Tax y deployer checks" },
    { "id": 13, "tasks": ["9.7", "9.8", "11.3", "11.4"], "description": "Round-trip y concentration" },
    { "id": 14, "tasks": ["9.9", "9.10", "11.5", "11.6"], "description": "Cascade y flags" },
    { "id": 15, "tasks": ["11.7", "11.8", "11.9", "13.1"], "description": "Volume y CopyExecutor" },
    { "id": 16, "tasks": ["13.2", "13.3", "13.4"], "description": "Sizing y delays" },
    { "id": 17, "tasks": ["13.5", "13.6", "13.7", "13.8"], "description": "Splitting y slippage" },
    { "id": 18, "tasks": ["13.9", "13.10", "15.1"], "description": "Pre-exec y RiskBucket" },
    { "id": 19, "tasks": ["15.2", "15.3", "15.4", "15.5"], "description": "Position limits" },
    { "id": 20, "tasks": ["15.6", "15.7", "15.8", "15.9"], "description": "Circuit breakers" },
    { "id": 21, "tasks": ["15.10", "15.11", "15.12", "15.13", "15.14"], "description": "Drawdown y reserve" },
    { "id": 22, "tasks": ["17.1", "17.2"], "description": "ExitManager base" },
    { "id": 23, "tasks": ["17.3", "17.4", "17.5"], "description": "Follow insider y trailing" },
    { "id": 24, "tasks": ["17.6", "17.7", "17.8"], "description": "Fixed exits y rug" },
    { "id": 25, "tasks": ["17.9", "17.10", "17.11"], "description": "Exit recording" },
    { "id": 26, "tasks": ["19.1", "19.2", "19.3"], "description": "CopyMetricsRecorder" },
    { "id": 27, "tasks": ["19.4", "19.5", "19.6", "19.7"], "description": "Aggregates y restore" },
    { "id": 28, "tasks": ["21.1", "21.2"], "description": "HTTP endpoints base" },
    { "id": 29, "tasks": ["21.3", "21.4", "21.5"], "description": "HTTP positions y auth" },
    { "id": 30, "tasks": ["23.1", "23.2"], "description": "Orchestrator" },
    { "id": 31, "tasks": ["23.3", "23.4", "23.5"], "description": "Integration" }
  ]
}
```
