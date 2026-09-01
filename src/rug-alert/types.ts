/**
 * Rug Alert Service — Shared Types and Interfaces
 *
 * Defines all public-facing types, interfaces, and type aliases used across
 * the rug-alert-service module and its integration points.
 *
 * Requirements: 1.1, 1.2, 2.1, 3.1, 4.1, 4.6, 6.1, 6.6
 */

import type { ShadowPosition } from '../shared/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// Alert classification types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Classification of rug pull risk severity.
 * - WARNING: Suspicious activity detected; position is monitored but not closed.
 * - HIGH: Significant signal detected; position is closed immediately.
 * - CRITICAL: Severe rug pull signal; position is closed immediately.
 */
export type AlertSeverity = 'WARNING' | 'HIGH' | 'CRITICAL';

/**
 * The specific on-chain signal that triggered an alert.
 */
export type AlertReason =
  | 'LIQUIDITY_DROP_HIGH'
  | 'LIQUIDITY_DROP_CRITICAL'
  | 'RESERVE_POLL_FAILURE'
  | 'LP_REMOVAL_HIGH'
  | 'LP_REMOVAL_CRITICAL'
  | 'DEPLOYER_SELL_HIGH'
  | 'DEPLOYER_SELL_CRITICAL'
  | 'WHALE_SELL_TO_DEX';

// ═══════════════════════════════════════════════════════════════════════════
// Core event model
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Structured record describing a detected rug pull signal.
 * Persisted to the `alert_events` table via MetricsRecorder.
 */
export interface AlertEvent {
  /** UUID — unique identifier for this alert event */
  id: string;
  /** Token contract address (checksummed) */
  contractAddress: string;
  severity: AlertSeverity;
  reason: AlertReason;
  /** Unix ms timestamp of when the signal was first detected */
  detectedAt: number;
  /** ID of the ShadowPosition this alert relates to */
  positionId: string;
  /** Realised P&L in USDC; null until closePosition resolves */
  pnlUsdc: number | null;
  /** Set by on-chain event detectors (LP removal, transfer events); absent for poll-based alerts */
  transactionHash?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Stats models
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Public-facing alert statistics returned by IRugAlertService.getAlertStats().
 * lastAlertAt is formatted as ISO 8601 string for API consumers.
 */
export interface AlertStats {
  alertsEmitted: {
    WARNING: number;
    HIGH: number;
    CRITICAL: number;
  };
  positionsClosedByAlert: number;
  suppressedAlerts: number;
  /** ISO 8601 string, or null if no alerts have been emitted this session */
  lastAlertAt: string | null;
  degradedMode: boolean;
}

/**
 * Internal mutable stats object maintained by RugAlertService.
 * lastAlertAt is stored as Unix ms for easy comparison; projected to ISO 8601 on getAlertStats().
 */
export interface MutableAlertStats {
  WARNING: number;
  HIGH: number;
  CRITICAL: number;
  positionsClosedByAlert: number;
  suppressedAlerts: number;
  /** Unix ms timestamp, or null if no alerts have been emitted */
  lastAlertAt: number | null;
  degradedMode: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Position registry
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Entry in the RugAlertService's in-memory position registry.
 * Keyed by positionId inside a Map<string, MonitoredPosition>.
 */
export interface MonitoredPosition {
  position: ShadowPosition;
  poolAddress: string;
  lpTokenAddress: string;
  /** Which executor owns this position — determines which closePosition() to call */
  ownerExecutor: 'shadow' | 'multiVariant';
}

// ═══════════════════════════════════════════════════════════════════════════
// Service interface
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Public interface for the RugAlertService.
 * Exposed to initHybridSniper and wireSniper.
 *
 * Requirements: 6.1, 6.6
 */
export interface IRugAlertService {
  /** Start polling and event listeners. Throws on connectivity failure (sets DEGRADED mode). */
  start(): Promise<void>;
  /** Stop all polling intervals, remove all event listeners, flush queued Telegram notifications. */
  stop(): Promise<void>;
  /**
   * Register an open position for rug pull monitoring.
   * No-op if the service is in DEGRADED mode.
   */
  trackPosition(
    position: ShadowPosition,
    poolAddress: string,
    lpTokenAddress: string,
  ): void;
  /** Unregister a position (called after closePosition resolves). */
  untrackPosition(positionId: string): void;
  /** Returns aggregated alert statistics for the current session. */
  getAlertStats(): AlertStats;
  /** Returns the number of positions currently being monitored. */
  getMonitoredCount(): number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Emitter callback type
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Callback signature used by the three detector components to surface alerts
 * to the AlertDispatcher. All async operations inside handlers must be
 * wrapped in try/catch to prevent unhandled promise rejections.
 */
export type AlertEmitter = (event: AlertEvent) => Promise<void>;
