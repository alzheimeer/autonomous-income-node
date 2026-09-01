/**
 * Shared — MetricsRecorder (PostgreSQL + TimescaleDB)
 *
 * Persists trading signals and shadow positions directly to PostgreSQL
 * to avoid SQLite concurrency / corruption issues.
 *
 * Originally developed for hybrid-sniper, now shared across all trading systems.
 *
 * Requirements: 4.1, 4.2, 8.1, 8.2, 8.3, 8.4, 8.5
 */

import { createLogger } from '../logger.js';
import { pgPool } from '../trading-validation/postgres.js';

const log = createLogger('metrics-recorder');

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface SniperSignal {
  id: string;
  ticker: string;
  contractAddress: string;
  source: 'dexscreener' | 'geckoterminal' | 'bitquery' | 'webhook';
  ingestionTime: number;
  poolAddress?: string;
}

export interface ValidationResult {
  passed: boolean;
  rejectReason: string | null;
  validatedAt: number;
  latencyMs: number;
}

export interface ShadowPosition {
  id: string;
  signalId: string;
  contractAddress: string;
  entryPrice: bigint;
  takeProfit: bigint;
  stopLoss: bigint;
  timeStop: number;
  tradeSize: bigint;
  status: 'OPEN' | 'TP_HIT' | 'SL_HIT' | 'TIME_STOP' | 'RUG_PULL';
  openedAt: number;
  closedAt: number | null;
  exitPrice: bigint | null;
  pnlUsdc: number | null;
  variantId?: string;
  variantName?: string;
  signalSource?: 'micro-cap' | 'established';
  pairId?: string;
  /** Token type classification for separate metrics tracking */
  signalType?: 'micro-cap' | 'established' | 'unknown';
  /** 
   * FIX: Counter for consecutive quote failures during monitoring.
   * If this reaches MAX_QUOTE_FAILURES (3), we assume rug pull and close with 100% loss.
   * This prevents the bug where rug pulls are never detected because quote() fails silently.
   */
  quoteFailCount?: number;
}

export interface SignalRecord {
  signal_id: string;
  contract_address: string;
  ticker: string;
  source: string;
  ingestion_time: number;
  validated_at: number;
  total_latency_ms: number;
  passed: number; // 0 | 1
  reject_reason: string | null;
  result: string | null;
  created_at: number;
}

export interface IMetricsRecorder {
  recordSignal(signal: SniperSignal, result: ValidationResult): Promise<void> | void;
  recordPosition(position: ShadowPosition): Promise<void> | void;
  getRecentSignals(limit: number): Promise<SignalRecord[]>;
  getAverageLatency(limit: number): Promise<number>;
  getVariantMetrics(): Promise<{ variantId: string; variantName: string; trades: number; wins: number; losses: number; timeStops: number; pnl: number }[]>;
  getVariantPositions(variantId: string, limit?: number): Promise<ShadowPosition[]>;
  /** Get all OPEN positions from DB for restoration after restart */
  getOpenPositions?(): Promise<ShadowPosition[]>;
  /**
   * Persist an AlertEvent to the `alert_events` table.
   * Optional — implementations that don't support alert persistence (e.g. mocks,
   * early-iteration versions) may omit this method for backward compatibility.
   *
   * Implementation must use `ON CONFLICT (id) DO NOTHING` to be idempotent.
   *
   * Requirement: 4.6
   */
  recordAlertEvent?(event: import('../rug-alert/types.js').AlertEvent): Promise<void>;
  close(): Promise<void> | void;
}

// ═══════════════════════════════════════════════════════════════════════════
// MetricsRecorder
// ═══════════════════════════════════════════════════════════════════════════

export class MetricsRecorder implements IMetricsRecorder {
  constructor(dbPath?: string) {
    // dbPath is ignored, we use pgPool
    log.info('MetricsRecorder (PostgreSQL) initialized');
  }

  get isDegraded(): boolean {
    return false; // With pgPool, we assume it handles reconnections
  }

  async recordSignal(signal: SniperSignal, result: ValidationResult): Promise<void> {
    try {
      await pgPool.query(`
        INSERT INTO sniper_signals (
          signal_id, contract_address, ticker, source,
          ingestion_time, validated_at, total_latency_ms,
          passed, reject_reason, result, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [
        signal.id,
        signal.contractAddress,
        signal.ticker,
        signal.source,
        signal.ingestionTime,
        result.validatedAt,
        result.validatedAt - signal.ingestionTime,
        result.passed ? 1 : 0,
        result.rejectReason,
        result.passed ? 'PASS' : 'FAIL',
        Date.now()
      ]);
    } catch (err) {
      log.error('recordSignal failed', {
        signal_id: signal.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async recordPosition(position: ShadowPosition): Promise<void> {
    try {
      // Auto-detect signal_type based on contract address if not provided
      const signalType = position.signalType ?? this._detectSignalType(position.contractAddress);
      
      await pgPool.query(`
        INSERT INTO shadow_positions (
          id, signal_id, contract_address,
          entry_price, take_profit, stop_loss,
          time_stop, trade_size, status,
          opened_at, closed_at, exit_price, pnl_usdc,
          created_at, signal_type,
          variant_id, variant_name, signal_source
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          closed_at = EXCLUDED.closed_at,
          exit_price = EXCLUDED.exit_price,
          pnl_usdc = EXCLUDED.pnl_usdc,
          signal_type = EXCLUDED.signal_type,
          variant_id = EXCLUDED.variant_id,
          variant_name = EXCLUDED.variant_name,
          signal_source = EXCLUDED.signal_source
      `, [
        position.id,
        position.signalId,
        position.contractAddress,
        position.entryPrice.toString(),
        position.takeProfit.toString(),
        position.stopLoss.toString(),
        position.timeStop,
        position.tradeSize.toString(),
        position.status,
        position.openedAt,
        position.closedAt ?? null,
        position.exitPrice !== null ? position.exitPrice.toString() : null,
        position.pnlUsdc ?? null,
        Date.now(),
        signalType,
        position.variantId ?? null,
        position.variantName ?? null,
        position.signalSource ?? null,
      ]);
    } catch (err) {
      log.error('recordPosition failed', {
        position_id: position.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Detect if a position is from an established pair or a micro-cap based on contract address.
   * This is critical for separating metrics correctly.
   */
  private _detectSignalType(contractAddress: string): 'micro-cap' | 'established' {
    const ESTABLISHED_TOKENS = [
      '0x4200000000000000000000000000000000000006', // WETH
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
      '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI
      '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', // cbETH
      '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC
    ];
    
    const normalizedAddress = contractAddress.toLowerCase();
    const isEstablished = ESTABLISHED_TOKENS.some(t => t.toLowerCase() === normalizedAddress);
    
    return isEstablished ? 'established' : 'micro-cap';
  }

  async getRecentSignals(limit: number): Promise<SignalRecord[]> {
    try {
      const res = await pgPool.query(`
        SELECT signal_id, contract_address, ticker, source,
               ingestion_time, validated_at, total_latency_ms,
               passed, reject_reason, result, created_at
        FROM sniper_signals
        ORDER BY created_at DESC
        LIMIT $1
      `, [limit]);
      
      return res.rows.map(r => ({
        signal_id: r.signal_id,
        contract_address: r.contract_address,
        ticker: r.ticker,
        source: r.source,
        ingestion_time: parseInt(r.ingestion_time, 10),
        validated_at: parseInt(r.validated_at, 10),
        total_latency_ms: parseInt(r.total_latency_ms, 10),
        passed: parseInt(r.passed, 10),
        reject_reason: r.reject_reason,
        result: r.result,
        created_at: parseInt(r.created_at, 10),
      }));
    } catch (err) {
      log.error('getRecentSignals failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async getAverageLatency(limit: number): Promise<number> {
    try {
      const res = await pgPool.query(`
        SELECT AVG(total_latency_ms) as avg_latency
        FROM (
          SELECT total_latency_ms
          FROM sniper_signals
          ORDER BY created_at DESC
          LIMIT $1
        ) sub
      `, [limit]);
      return parseFloat(res.rows[0]?.avg_latency || '0');
    } catch (err) {
      log.error('getAverageLatency failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  async getVariantMetrics(): Promise<{ variantId: string; variantName: string; trades: number; wins: number; losses: number; timeStops: number; pnl: number }[]> {
    return []; // Optional for now, unless used
  }

  async getVariantPositions(variantId: string, limit: number = 100): Promise<ShadowPosition[]> {
    return [];
  }

  /**
   * Get all OPEN positions from DB for restoration after container restart.
   * Returns positions with status='OPEN' to be restored to memory.
   */
  async getOpenPositions(): Promise<ShadowPosition[]> {
    try {
      const res = await pgPool.query(`
        SELECT id, signal_id, contract_address,
               entry_price, take_profit, stop_loss,
               time_stop, trade_size, status,
               opened_at, closed_at, exit_price, pnl_usdc,
               signal_type, variant_id, variant_name, signal_source
        FROM shadow_positions
        WHERE status = 'OPEN'
        ORDER BY opened_at ASC
      `);
      
      return res.rows.map(r => ({
        id: r.id,
        signalId: r.signal_id,
        contractAddress: r.contract_address,
        entryPrice: BigInt(r.entry_price || '0'),
        takeProfit: BigInt(r.take_profit || '0'),
        stopLoss: BigInt(r.stop_loss || '0'),
        timeStop: parseInt(r.time_stop, 10),
        tradeSize: BigInt(r.trade_size || '0'),
        status: r.status as 'OPEN',
        openedAt: parseInt(r.opened_at, 10),
        closedAt: r.closed_at ? parseInt(r.closed_at, 10) : null,
        exitPrice: r.exit_price ? BigInt(r.exit_price) : null,
        pnlUsdc: r.pnl_usdc ? parseFloat(r.pnl_usdc) : null,
        signalType: r.signal_type || 'unknown',
        variantId: r.variant_id || undefined,
        variantName: r.variant_name || undefined,
        signalSource: r.signal_source || undefined,
      }));
    } catch (err) {
      log.error('getOpenPositions failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async recordAlertEvent(event: import('../rug-alert/types.js').AlertEvent): Promise<void> {
    try {
      await pgPool.query(`
        INSERT INTO alert_events (
          id, contract_address, severity, reason,
          detected_at, position_id, pnl_usdc, transaction_hash, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO NOTHING
      `, [
        event.id,
        event.contractAddress,
        event.severity,
        event.reason,
        event.detectedAt,
        event.positionId,
        event.pnlUsdc ?? null,
        event.transactionHash ?? null,
        Date.now(),
      ]);
    } catch (err) {
      log.warn('recordAlertEvent failed', {
        id: event.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async close(): Promise<void> {
    // pgPool is shared, we don't close it here
    log.info('MetricsRecorder closed (noop for pgPool)');
  }
}
