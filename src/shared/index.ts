/**
 * Shared Modules - Barrel File
 *
 * This module exports reusable components that are shared across different
 * trading systems in the autonomous-income-node project.
 *
 * These modules were originally developed for hybrid-sniper and have been
 * refactored to be reusable by the copy-trading system and future modules.
 *
 * Exported modules:
 *   - DexQuoter:         DEX price quotes via staticCall simulation
 *   - RiskBucket:        Risk management and circuit breaker logic
 *   - MetricsRecorder:   Persistence of trading metrics to PostgreSQL
 *   - ContractValidator: Honeypot detection and liquidity validation
 *
 * Usage:
 *   import { DexQuoter, RiskBucket, MetricsRecorder, ContractValidator } from '../shared/index.js';
 *
 * @module shared
 */

// ═══════════════════════════════════════════════════════════════════════════
// Module Exports
// ═══════════════════════════════════════════════════════════════════════════

// Task 1.2 - DexQuoter: DEX price quotes via staticCall simulation
export { DexQuoter, type IDexQuoter, type PoolType, type QuoteParams } from './dex-quoter.js';

// Task 1.3 - Export RiskBucket (completed)
export { RiskBucket, type IRiskBucket, type CircuitBreakerState } from './risk-bucket.js';

// MetricsRecorder - PostgreSQL metrics persistence (Task 1.4 ✓)
export { MetricsRecorder } from './metrics-recorder.js';
export type { SniperSignal, ValidationResult, ShadowPosition, SignalRecord, IMetricsRecorder } from './metrics-recorder.js';

// Task 1.5 - Export ContractValidator from ./contract-validator.js
export { ContractValidator, type IContractValidator, type RejectReason } from './contract-validator.js';
