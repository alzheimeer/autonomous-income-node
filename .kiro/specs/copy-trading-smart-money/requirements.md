# Requirements Document

## Introduction

Este documento define los requisitos formales para el **Copy-Trading Smart Money Module**, un sistema que monitorea wallets "smart money" curadas en tiempo real y replica automáticamente sus trades de manera proporcional. El sistema pivota desde el enfoque anterior de micro-cap sniping (que tuvo 0% win rate en 5,169+ trades) hacia una estrategia de seguimiento de traders exitosos con un edge demostrado.

### Objetivos Principales
- Monitorear 10-50 wallets smart money curadas en tiempo real
- Detectar compras/ventas de tokens por wallets objetivo
- Validar tokens antes de copiar (liquidez, honeypot, tax)
- Ejecutar copias proporcionales con sizing dinámico
- Gestionar salidas (seguir al insider, trailing stop, TP/SL)
- Proteger contra baiting y manipulación

### Restricciones de Usuario
- Capital limitado: $500-$2,000 USD
- Win rate objetivo: >50%
- Máximo drawdown tolerable: 25%
- Infraestructura: Local o AWS básico ($50-100/mes)
- Chains objetivo: Base L2 (principal), Ethereum L1 (secundario)

### Módulos Existentes a Reutilizar
- `DexQuoter`: Cotizaciones DEX via staticCall
- `RiskBucket`: Gestión de riesgo y circuit breaker
- `MetricsRecorder`: Persistencia de métricas en PostgreSQL
- `ContractValidator`: Validación de honeypots y liquidez

## Glossary

- **Copy_Trading_System**: Sistema completo que monitorea wallets smart money y replica sus trades automáticamente
- **Smart_Money_Curator**: Módulo responsable de seleccionar, calificar y mantener la lista de wallets a seguir
- **Wallet_Watcher**: Módulo que monitorea eventos on-chain de las wallets curadas en tiempo real
- **Signal_Enricher**: Módulo que valida y enriquece señales de trading antes de ejecución
- **Copy_Executor**: Módulo que ejecuta trades de copia con sizing dinámico
- **Exit_Manager**: Módulo que gestiona las estrategias de salida de posiciones
- **Anti_Baiting_Module**: Módulo que detecta y mitiga intentos de manipulación
- **Copy_Signal**: Señal generada cuando una wallet smart money ejecuta un trade
- **Insider_Trade**: Trade original ejecutado por una wallet smart money monitoreada
- **Position_Size**: Monto en USDC/WETH de una posición de copia
- **Trailing_Stop**: Stop loss que se ajusta automáticamente siguiendo el precio
- **Baiting**: Manipulación donde una wallet crea trampas sabiendo que está siendo copiada
- **LP_Lock**: Bloqueo de tokens de liquidez para prevenir rug pulls
- **Transfer_Tax**: Impuesto aplicado en transferencias de ciertos tokens
- **Win_Rate**: Porcentaje de trades que resultan en ganancia
- **PnL**: Profit and Loss (Ganancia y Pérdida) en USDC
- **Slippage**: Diferencia entre precio esperado y precio de ejecución
- **Circuit_Breaker**: Mecanismo que detiene operaciones tras pérdidas consecutivas

## Requirements

### Requirement 1: Curaduría de Wallets Smart Money

**User Story:** As a trader, I want the system to automatically select and maintain a curated list of high-performing wallets, so that I can copy trades from consistently profitable traders.

#### Acceptance Criteria

1. THE Smart_Money_Curator SHALL maintain a list of 10-50 monitored wallets at any time
2. WHEN evaluating a wallet for inclusion, THE Smart_Money_Curator SHALL require a minimum win rate of 70% over the last 90 days
3. WHEN evaluating a wallet for inclusion, THE Smart_Money_Curator SHALL require a minimum historical PnL of $50,000 USDC
4. WHEN evaluating a wallet for inclusion, THE Smart_Money_Curator SHALL require at least 100 historical trades for statistical significance
5. WHEN evaluating a wallet for inclusion, THE Smart_Money_Curator SHALL require an average holding time between 15 minutes and 7 days
6. WHEN evaluating a wallet for inclusion, THE Smart_Money_Curator SHALL require a minimum historical volume of $500,000 USDC
7. THE Smart_Money_Curator SHALL exclude wallets with more than 50% of trades in the same block as another trade (MEV bot indicator)
8. THE Smart_Money_Curator SHALL exclude wallets that have deployed tokens in the last 180 days
9. THE Smart_Money_Curator SHALL exclude wallets where more than 20% of purchased tokens were honeypots or rugs
10. THE Smart_Money_Curator SHALL exclude wallets that received tokens directly from token deployers (insider airdrop indicator)
11. THE Smart_Money_Curator SHALL exclude wallets with more than 30% of trades with the same counterparty (wash trading indicator)
12. THE Smart_Money_Curator SHALL assign a tier (S_TIER, A_TIER, B_TIER) to each wallet based on performance metrics
13. THE Smart_Money_Curator SHALL re-evaluate wallet metrics every 24 hours
14. WHEN a wallet's win rate drops below 60%, THE Smart_Money_Curator SHALL remove it from the monitored list

### Requirement 2: Monitoreo de Wallets en Tiempo Real

**User Story:** As a trader, I want the system to detect trades from monitored wallets in real-time, so that I can copy them with minimal delay.

#### Acceptance Criteria

1. THE Wallet_Watcher SHALL detect swap transactions from monitored wallets within 5 seconds of block confirmation
2. THE Wallet_Watcher SHALL support both WebSocket and polling ingestion methods
3. WHEN using polling mode, THE Wallet_Watcher SHALL poll for new transactions every 2 seconds
4. WHEN a swap is detected, THE Wallet_Watcher SHALL decode the calldata to extract token address, amount, and direction
5. THE Wallet_Watcher SHALL support decoding swaps from Uniswap V3, Aerodrome, and 1inch router contracts
6. THE Wallet_Watcher SHALL ignore dust transfers with value less than $100 USDC
7. THE Wallet_Watcher SHALL ignore internal wallet transfers (non-swap transfers)
8. WHEN a valid swap is detected, THE Wallet_Watcher SHALL emit a Copy_Signal with source wallet, token address, action type, trade amount, entry price, block number, and transaction hash
9. THE Wallet_Watcher SHALL maintain a heartbeat every 30 seconds to verify connection health
10. IF the WebSocket connection is lost, THEN THE Wallet_Watcher SHALL automatically reconnect within 10 seconds
11. THE Wallet_Watcher SHALL log all detected swaps with timestamp and latency metrics

### Requirement 3: Enriquecimiento y Validación de Señales

**User Story:** As a trader, I want each trade signal to be validated before execution, so that I avoid honeypots, high-tax tokens, and low-liquidity pools.

#### Acceptance Criteria

1. WHEN a Copy_Signal is received, THE Signal_Enricher SHALL validate the token within 2 seconds
2. THE Signal_Enricher SHALL verify pool liquidity is at least $10,000 USDC or 2.0 WETH
3. THE Signal_Enricher SHALL simulate a sell transaction before allowing a buy (honeypot detection)
4. IF the simulated sell returns zero tokens, THEN THE Signal_Enricher SHALL reject the signal as HONEYPOT_DETECTED
5. THE Signal_Enricher SHALL calculate the effective transfer tax by comparing buy input to sell output
6. IF the transfer tax exceeds 5%, THEN THE Signal_Enricher SHALL reject the signal as TRANSFER_TAX_EXCEEDED
7. THE Signal_Enricher SHALL estimate slippage for the planned position size
8. IF estimated slippage exceeds 5%, THEN THE Signal_Enricher SHALL reject the signal as HIGH_SLIPPAGE
9. THE Signal_Enricher SHALL check if the token deployer has previous rug history
10. IF the token deployer is flagged as a known scammer, THEN THE Signal_Enricher SHALL reject the signal as DEPLOYER_FLAGGED
11. THE Signal_Enricher SHALL verify that LP tokens are burned or locked (at least 50% of total supply)
12. IF LP is not locked or burned, THEN THE Signal_Enricher SHALL reject the signal as UNVERIFIED_LP
13. THE Signal_Enricher SHALL check if the source wallet recently round-tripped the same token within 1 hour
14. IF a recent round-trip is detected, THEN THE Signal_Enricher SHALL reject the signal as BAITING_DETECTED
15. WHEN validation passes, THE Signal_Enricher SHALL emit an enriched signal with liquidity amount, slippage estimate, tax percentage, and deployer status

### Requirement 4: Ejecución de Trades de Copia

**User Story:** As a trader, I want the system to execute copy trades with appropriate sizing relative to my capital, so that I maintain proper risk management.

#### Acceptance Criteria

1. WHEN an enriched signal is received, THE Copy_Executor SHALL calculate position size as minimum of: (insider trade × 10%), $100 USDC, or (available capital × 5%)
2. THE Copy_Executor SHALL apply a wallet tier multiplier to position size: S_TIER=1.5x, A_TIER=1.0x, B_TIER=0.5x
3. THE Copy_Executor SHALL reject trades with calculated position size below $10 USDC
4. THE Copy_Executor SHALL add a random delay between 5 and 30 seconds before executing (anti-detection)
5. WHEN position size exceeds $50 USDC, THE Copy_Executor SHALL split the order into 3 smaller orders with 10 second delays
6. THE Copy_Executor SHALL use dynamic slippage tolerance: 1% base plus 0.5% per $10K missing liquidity, capped at 5%
7. THE Copy_Executor SHALL abort execution if gas price exceeds 50 gwei on Base L2
8. THE Copy_Executor SHALL abort execution if gas estimate exceeds 2x the expected amount (honeypot indicator)
9. THE Copy_Executor SHALL simulate the transaction before broadcasting using staticCall
10. IF simulation shows loss exceeding 10%, THEN THE Copy_Executor SHALL abort the trade
11. WHEN a trade is executed, THE Copy_Executor SHALL record the position with entry price, take profit, stop loss, and time stop values
12. THE Copy_Executor SHALL reject trades if our buy would exceed 5% of the token's daily volume

### Requirement 5: Gestión de Riesgo y Circuit Breaker

**User Story:** As a trader, I want the system to automatically limit losses through circuit breakers and position limits, so that I protect my capital during adverse conditions.

#### Acceptance Criteria

1. THE Risk_Bucket SHALL limit maximum concurrent open positions to 3
2. THE Risk_Bucket SHALL limit maximum daily capital deployment to 20% of total capital
3. WHEN 3 consecutive positions close at stop loss, THE Risk_Bucket SHALL activate the circuit breaker for 24 hours
4. WHILE the circuit breaker is active, THE Copy_Trading_System SHALL reject all new trade signals
5. THE Risk_Bucket SHALL track cumulative daily PnL
6. IF daily PnL reaches -15% of total capital, THEN THE Risk_Bucket SHALL activate the circuit breaker for 24 hours
7. THE Risk_Bucket SHALL reset daily limits at 00:00 UTC each day
8. WHEN a position's drawdown exceeds 25%, THE Risk_Bucket SHALL force close the position at market price
9. THE Risk_Bucket SHALL maintain a minimum reserve of 20% of capital (never deploy more than 80%)
10. THE Risk_Bucket SHALL log all circuit breaker activations with reason and timestamp

### Requirement 6: Estrategias de Salida

**User Story:** As a trader, I want the system to manage position exits through multiple strategies, so that I can capture profits and limit losses effectively.

#### Acceptance Criteria

1. THE Exit_Manager SHALL support three exit strategies: follow insider, trailing stop, and fixed TP/SL
2. WHEN the source wallet sells at least 50% of their position, THE Exit_Manager SHALL close our position within 30 seconds (follow insider mode)
3. IF the source wallet does not sell within 24 hours, THEN THE Exit_Manager SHALL switch to trailing stop mode
4. THE Exit_Manager SHALL initialize trailing stop at 15% below entry price
5. WHEN position price rises 10% above entry, THE Exit_Manager SHALL activate trailing stop following
6. WHILE trailing stop is active, THE Exit_Manager SHALL maintain stop at 10% below the highest price reached
7. THE Exit_Manager SHALL close position when price hits the trailing stop level
8. THE Exit_Manager SHALL close position when price reaches +50% (fixed take profit)
9. THE Exit_Manager SHALL close position when price reaches -20% (fixed stop loss)
10. THE Exit_Manager SHALL close position after 48 hours if no other exit is triggered (time stop)
11. THE Exit_Manager SHALL record exit reason, exit price, and final PnL for each closed position
12. IF three consecutive quote attempts fail for a position, THEN THE Exit_Manager SHALL assume rug pull and record 100% loss

### Requirement 7: Protección Anti-Baiting

**User Story:** As a trader, I want the system to detect and avoid bait trades from wallets that know they are being copied, so that I don't fall into manipulation traps.

#### Acceptance Criteria

1. THE Anti_Baiting_Module SHALL reject signals for tokens deployed by the source wallet in the last 30 days
2. THE Anti_Baiting_Module SHALL maintain a blacklist of known scammer deployer addresses
3. THE Anti_Baiting_Module SHALL reject signals where more than 30% of token holders are wallets we are monitoring
4. THE Anti_Baiting_Module SHALL track source wallet behavior patterns for suspicious activity
5. WHEN a source wallet buys and sells the same token within 1 hour, THE Anti_Baiting_Module SHALL flag the wallet for review
6. IF a wallet accumulates 3 or more bait flags within 7 days, THEN THE Anti_Baiting_Module SHALL remove the wallet from the monitored list
7. THE Anti_Baiting_Module SHALL reject signals where our buy would exceed 5% of the token's daily volume (footprint too large)
8. THE Anti_Baiting_Module SHALL apply random execution delays between 5 and 30 seconds to obscure copy patterns
9. WHEN enabled, THE Anti_Baiting_Module SHALL rotate between multiple execution wallets to reduce detectability
10. THE Anti_Baiting_Module SHALL log all detected bait patterns with signal details and detection reason

### Requirement 8: Persistencia de Métricas y Reporting

**User Story:** As a trader, I want the system to record all trades and metrics in a database, so that I can analyze performance and optimize parameters.

#### Acceptance Criteria

1. THE Metrics_Recorder SHALL persist all Copy_Signals to PostgreSQL with timestamp, source wallet, token, and validation result
2. THE Metrics_Recorder SHALL persist all positions with entry price, exit price, PnL, duration, and exit reason
3. THE Metrics_Recorder SHALL calculate and store daily, weekly, and monthly aggregate metrics
4. THE Metrics_Recorder SHALL track win rate, average PnL, and Sharpe ratio per monitored wallet
5. THE Metrics_Recorder SHALL track win rate and PnL by wallet tier (S_TIER, A_TIER, B_TIER)
6. THE Metrics_Recorder SHALL provide an API endpoint to retrieve recent signals with configurable limit
7. THE Metrics_Recorder SHALL provide an API endpoint to retrieve open positions
8. THE Metrics_Recorder SHALL provide an API endpoint to retrieve closed positions with filtering by date range
9. THE Metrics_Recorder SHALL restore open positions from database on system restart
10. WHEN a position is restored from database, THE Exit_Manager SHALL resume monitoring with original parameters
11. THE Metrics_Recorder SHALL generate a daily performance report with total PnL, win rate, and top performing wallets

### Requirement 9: API HTTP y Endpoints de Control

**User Story:** As a trader, I want HTTP endpoints to monitor and control the copy trading system, so that I can manage operations remotely.

#### Acceptance Criteria

1. THE Copy_Trading_System SHALL expose a GET /copy/status endpoint returning system health, open positions count, and circuit breaker state
2. THE Copy_Trading_System SHALL expose a GET /copy/wallets endpoint returning the list of monitored wallets with their tiers and metrics
3. THE Copy_Trading_System SHALL expose a POST /copy/wallets endpoint to add a new wallet to the monitored list
4. THE Copy_Trading_System SHALL expose a DELETE /copy/wallets/:address endpoint to remove a wallet from the monitored list
5. THE Copy_Trading_System SHALL expose a GET /copy/positions endpoint returning all open positions with current prices and unrealized PnL
6. THE Copy_Trading_System SHALL expose a POST /copy/positions/:id/close endpoint to manually close a specific position
7. THE Copy_Trading_System SHALL expose a POST /copy/circuit-breaker/reset endpoint to manually reset the circuit breaker
8. THE Copy_Trading_System SHALL expose a GET /copy/metrics endpoint returning aggregate performance metrics
9. IF an invalid wallet address is provided to POST /copy/wallets, THEN THE Copy_Trading_System SHALL return HTTP 400 with error description
10. THE Copy_Trading_System SHALL require API key authentication for all mutating endpoints (POST, DELETE)

### Requirement 10: Configuración y Parámetros

**User Story:** As a trader, I want to configure system parameters through environment variables, so that I can adjust behavior without code changes.

#### Acceptance Criteria

1. THE Copy_Trading_System SHALL read initial capital from COPY_INITIAL_CAPITAL_USDC environment variable with default of 500
2. THE Copy_Trading_System SHALL read maximum position size from COPY_MAX_POSITION_USDC environment variable with default of 100
3. THE Copy_Trading_System SHALL read copy ratio from COPY_RATIO environment variable with default of 0.10
4. THE Copy_Trading_System SHALL read take profit percentage from COPY_TP_PCT environment variable with default of 50
5. THE Copy_Trading_System SHALL read stop loss percentage from COPY_SL_PCT environment variable with default of 20
6. THE Copy_Trading_System SHALL read trailing stop activation from COPY_TRAIL_ACTIVATION_PCT environment variable with default of 10
7. THE Copy_Trading_System SHALL read trailing stop distance from COPY_TRAIL_DISTANCE_PCT environment variable with default of 10
8. THE Copy_Trading_System SHALL read time stop hours from COPY_TIME_STOP_HOURS environment variable with default of 48
9. THE Copy_Trading_System SHALL read maximum gas price from COPY_MAX_GAS_GWEI environment variable with default of 50
10. THE Copy_Trading_System SHALL read RPC WebSocket URL from COPY_WS_RPC_URL environment variable
11. THE Copy_Trading_System SHALL read circuit breaker loss streak from COPY_MAX_LOSS_STREAK environment variable with default of 3
12. THE Copy_Trading_System SHALL validate all numeric environment variables and use defaults for invalid values
13. THE Copy_Trading_System SHALL log all loaded configuration parameters on startup
