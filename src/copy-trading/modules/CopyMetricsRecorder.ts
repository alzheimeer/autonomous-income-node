/**
 * CopyMetricsRecorder Module - Tasks 19.1-19.7
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.9, 8.10, 8.11
 */
import { createLogger } from '../../logger.js';
import { pgPool } from '../../trading-validation/postgres.js';
import type { CopyPosition, CopySignal, EnrichedSignal, WalletTier, IExitManager } from '../interfaces/types.js';

const log = createLogger('copy-metrics-recorder');
const RISK_FREE_RATE = 0; // 0% risk-free rate for Sharpe ratio

export interface CopySignalRecord {
  id: string;
  source_wallet: string;
  wallet_tier: string;
  token_address: string;
  pool_address: string;
  action: 'BUY' | 'SELL';
  trade_amount_usdc: number;
  entry_price: string;
  block_number: number;
  tx_hash: string;
  detected_at: number;
  detection_latency_ms: number;
  enrichment_result: string | null;
  enrichment_reject_reason: string | null;
  baiting_result: string | null;
  baiting_reject_reason: string | null;
  execution_result: string | null;
  execution_reject_reason: string | null;
  position_id?: string | null;
  created_at: Date;
}

export interface CopyPositionRecord {
  id: string;
  signal_id: string;
  source_wallet: string;
  token_address: string;
  pool_address: string;
  entry_price: string;
  position_size_usdc: number;
  token_amount: string;
  status: string;
  opened_at: number;
  closed_at: number | null;
  exit_price: string | null;
  pnl_usdc: number | null;
  exit_reason: string | null;
}

export interface SignalValidationResult {
  enrichmentResult?: 'APPROVED' | 'REJECTED';
  enrichmentRejectReason?: string;
  baitingResult?: 'APPROVED' | 'REJECTED';
  baitingRejectReason?: string;
  executionResult?: 'EXECUTED' | 'REJECTED';
  executionRejectReason?: string;
  positionId?: string;
}

export interface PositionRestorationResult {
  totalLoaded: number;
  restored: number;
  expiredTimeStop: number;
  errors: number;
}

/** Req 8.3: Wallet metrics interface */
export interface WalletMetrics {
  walletAddress: string;
  tradesCount: number;
  winsCount: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  sharpeRatio: number | null;
}

/** Req 8.4: Tier metrics interface */
export interface TierMetrics {
  tier: WalletTier;
  tradesCount: number;
  winsCount: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  sharpeRatio: number | null;
}

/** Req 8.5: Period type for aggregations */
export type PeriodType = 'DAILY' | 'WEEKLY' | 'MONTHLY';

/** Req 8.5: Aggregate metrics interface */
export interface AggregateMetrics {
  date: Date;
  walletAddress: string | null;
  tier: WalletTier | null;
  periodType: PeriodType;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnlUsdc: number;
  avgPnlUsdc: number;
  sharpeRatio: number | null;
}

export interface DailyReport {
  date: Date;
  totalPnlUsdc: number;
  tradesCount: number;
  winsCount: number;
  winRate: number;
  avgPnlPerTrade: number;
  topWallets: Array<{ address: string; tier: WalletTier; pnl: number; trades: number }>;
  worstWallets: Array<{ address: string; tier: WalletTier; pnl: number; trades: number }>;
  pnlByTier: Record<WalletTier, { pnl: number; trades: number; winRate: number }>;
  exitReasonBreakdown: Record<string, { count: number; pnl: number }>;
}

export interface ICopyMetricsRecorder {
  recordSignal(signal: CopySignal | EnrichedSignal, v?: SignalValidationResult): Promise<void>;
  recordSignalBatch(batch: Array<{ signal: CopySignal | EnrichedSignal; validation?: SignalValidationResult }>): Promise<void>;
  getSignalById(signalId: string): Promise<CopySignalRecord | null>;
  getSignalsByWallet(walletAddress: string, limit?: number): Promise<CopySignalRecord[]>;
  getRecentSignals(l: number): Promise<CopySignalRecord[]>;
  recordPosition(p: CopyPosition): Promise<void>;
  recordPositionOpen(p: CopyPosition): Promise<void>;
  recordPositionClose(p: CopyPosition): Promise<void>;
  updatePosition(p: CopyPosition): Promise<void>;
  getOpenPositions(): Promise<CopyPosition[]>;
  getClosedPositions(s?: Date, e?: Date, l?: number): Promise<CopyPosition[]>;
  getPositionById(positionId: string): Promise<CopyPosition | null>;
  getPositionsByWallet(walletAddress: string, limit?: number): Promise<CopyPosition[]>;
  bufferSignal(signal: CopySignal | EnrichedSignal, validation?: SignalValidationResult): void;
  flushSignalBatch(): Promise<void>;
  loadOpenPositions(): Promise<CopyPosition[]>;
  restorePositions(exitManager: IExitManager): Promise<PositionRestorationResult>;
  restoreOpenPositions(exitManager?: IExitManager): Promise<CopyPosition[]>;
  getRestoredPositionCount(): number;
  calculateWalletMetrics(walletAddress: string, startDate?: Date, endDate?: Date): Promise<WalletMetrics | null>;
  calculateTierMetrics(tier: WalletTier, startDate?: Date, endDate?: Date): Promise<TierMetrics | null>;
  calculateDailyMetrics(date: Date): Promise<AggregateMetrics | null>;
  getAggregatedMetrics(period: PeriodType, startDate: Date, endDate: Date): Promise<AggregateMetrics[]>;
  generateDailyReport(d?: Date): Promise<DailyReport>;
  formatReportForLog(r: DailyReport): string;
  scheduleDailyReport(h: number): void;
  close(): Promise<void>;
}

export class CopyMetricsRecorder implements ICopyMetricsRecorder {
  private dailyReportTimer: NodeJS.Timeout | null = null;
  private restoredPositionCount = 0;
  private signalBuffer: Array<{ signal: CopySignal | EnrichedSignal; validation?: SignalValidationResult }> = [];
  private readonly maxRetries = 3;
  private readonly retryDelayMs = 1000;

  constructor() { log.info('CopyMetricsRecorder initialized'); }

  async recordSignal(signal: CopySignal | EnrichedSignal, vr?: SignalValidationResult): Promise<void> {
    try {
      let er = vr?.enrichmentResult ?? null;
      let err = vr?.enrichmentRejectReason ?? null;
      if ('approved' in signal) { const e = signal as EnrichedSignal; er = e.approved ? 'APPROVED' : 'REJECTED'; err = e.rejectReason ?? null; }
      const q = `INSERT INTO copy_signals (id,source_wallet,wallet_tier,token_address,pool_address,action,trade_amount_usdc,entry_price,block_number,tx_hash,detected_at,detection_latency_ms,enrichment_result,enrichment_reject_reason,baiting_result,baiting_reject_reason,execution_result,execution_reject_reason,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW()) ON CONFLICT (id) DO UPDATE SET enrichment_result=COALESCE(EXCLUDED.enrichment_result,copy_signals.enrichment_result)`;
      await pgPool.query(q, [signal.id, signal.sourceWallet, signal.walletTier, signal.tokenAddress, signal.poolAddress, signal.action, signal.tradeAmountUsdc, signal.entryPrice.toString(), signal.blockNumber, signal.txHash, signal.detectedAt, signal.detectionLatencyMs, er, err, vr?.baitingResult ?? null, vr?.baitingRejectReason ?? null, vr?.executionResult ?? null, vr?.executionRejectReason ?? null]);
      log.debug('Signal recorded', { signalId: signal.id });
    } catch (e) { log.error('Failed to record signal', { signalId: signal.id, error: String(e) }); throw e; }
  }

  async recordSignalBatch(batch: Array<{ signal: CopySignal | EnrichedSignal; validation?: SignalValidationResult }>): Promise<void> {
    if (batch.length === 0) return;
    for (const item of batch) await this.recordSignal(item.signal, item.validation);
    log.info('Signal batch recorded', { count: batch.length });
  }

  async getSignalById(signalId: string): Promise<CopySignalRecord | null> {
    try { const r = await pgPool.query(`SELECT * FROM copy_signals WHERE id = $1`, [signalId]); return r.rows.length > 0 ? r.rows[0] as CopySignalRecord : null; }
    catch (e) { log.error('Failed get signal by id', { signalId, error: String(e) }); return null; }
  }

  async getSignalsByWallet(walletAddress: string, limit = 100): Promise<CopySignalRecord[]> {
    try { const r = await pgPool.query(`SELECT * FROM copy_signals WHERE source_wallet = $1 ORDER BY detected_at DESC LIMIT $2`, [walletAddress, limit]); return r.rows as CopySignalRecord[]; }
    catch (e) { log.error('Failed get signals by wallet', { walletAddress, error: String(e) }); return []; }
  }

  async getRecentSignals(limit = 100): Promise<CopySignalRecord[]> {
    try { const r = await pgPool.query(`SELECT * FROM copy_signals ORDER BY detected_at DESC LIMIT $1`, [limit]); return r.rows as CopySignalRecord[]; }
    catch (e) { log.error('Failed get signals', { error: String(e) }); return []; }
  }

  bufferSignal(signal: CopySignal | EnrichedSignal, validation?: SignalValidationResult): void { this.signalBuffer.push({ signal, validation }); }

  async flushSignalBatch(): Promise<void> {
    if (this.signalBuffer.length === 0) return;
    const batch = this.signalBuffer.splice(0, this.signalBuffer.length);
    await this.recordSignalBatch(batch);
  }

  async recordPosition(p: CopyPosition): Promise<void> {
    try {
      const q = `INSERT INTO copy_positions (id,signal_id,source_wallet,token_address,pool_address,entry_price,position_size_usdc,token_amount,take_profit,stop_loss,trailing_stop_trigger,trailing_stop_level,time_stop,status,opened_at,closed_at,exit_price,pnl_usdc,exit_reason,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW()) ON CONFLICT(id) DO NOTHING`;
      await pgPool.query(q, [p.id, p.signalId, p.sourceWallet, p.tokenAddress, p.poolAddress, p.entryPrice.toString(), p.positionSizeUsdc, p.tokenAmount.toString(), p.takeProfit.toString(), p.stopLoss.toString(), p.trailingStopTrigger.toString(), p.trailingStopLevel?.toString() ?? null, p.timeStop, p.status, p.openedAt, p.closedAt, p.exitPrice?.toString() ?? null, p.pnlUsdc, p.exitReason]);
      log.info('Position recorded', { positionId: p.id });
    } catch (e) { log.error('Failed to record position', { positionId: p.id, error: String(e) }); throw e; }
  }

  /** Alias for recordPosition for test compatibility */
  async recordPositionOpen(p: CopyPosition): Promise<void> { return this.recordPosition(p); }

  /** Update position when closed */
  async recordPositionClose(p: CopyPosition): Promise<void> {
    try {
      const q = `UPDATE copy_positions SET status=$2,closed_at=$3,exit_price=$4,pnl_usdc=$5,exit_reason=$6,trailing_stop_level=$7 WHERE id=$1`;
      const result = await pgPool.query(q, [p.id, p.status, p.closedAt, p.exitPrice?.toString() ?? null, p.pnlUsdc, p.exitReason, p.trailingStopLevel?.toString() ?? null]);
      if (result.rowCount === 0) log.warn('Position not found for close', { positionId: p.id });
      else log.info('Position closed', { positionId: p.id, status: p.status, pnlUsdc: p.pnlUsdc });
    } catch (e) { log.error('Failed to close position', { positionId: p.id, error: String(e) }); throw e; }
  }

  async updatePosition(p: CopyPosition): Promise<void> {
    try {
      const q = `UPDATE copy_positions SET status=$2,closed_at=$3,exit_price=$4,pnl_usdc=$5,exit_reason=$6,trailing_stop_level=$7 WHERE id=$1`;
      await pgPool.query(q, [p.id, p.status, p.closedAt, p.exitPrice?.toString() ?? null, p.pnlUsdc, p.exitReason, p.trailingStopLevel?.toString() ?? null]);
      log.info('Position updated', { positionId: p.id, status: p.status });
    } catch (e) { log.error('Failed to update position', { positionId: p.id, error: String(e) }); throw e; }
  }

  async getOpenPositions(): Promise<CopyPosition[]> {
    try { const r = await pgPool.query(`SELECT * FROM copy_positions WHERE status='OPEN' ORDER BY opened_at ASC`); return r.rows.map((row: Record<string, unknown>) => this._toPosition(row)); }
    catch (e) { log.error('Failed get open positions', { error: String(e) }); return []; }
  }

  async getClosedPositions(startDate?: Date, endDate?: Date, limit = 100): Promise<CopyPosition[]> {
    try {
      let q = `SELECT * FROM copy_positions WHERE status!='OPEN'`; const v: (number | string)[] = []; let i = 1;
      if (startDate) { q += ` AND closed_at>=$${i++}`; v.push(startDate.getTime()); }
      if (endDate) { q += ` AND closed_at<=$${i++}`; v.push(endDate.getTime()); }
      q += ` ORDER BY closed_at DESC LIMIT $${i}`; v.push(limit);
      const r = await pgPool.query(q, v); return r.rows.map((row: Record<string, unknown>) => this._toPosition(row));
    } catch (e) { log.error('Failed get closed positions', { error: String(e) }); return []; }
  }

  async getPositionById(positionId: string): Promise<CopyPosition | null> {
    try {
      const r = await pgPool.query(`SELECT * FROM copy_positions WHERE id = $1`, [positionId]);
      return r.rows.length > 0 ? this._toPosition(r.rows[0]) : null;
    } catch (e) { log.error('Failed get position by id', { positionId, error: String(e) }); return null; }
  }

  async getPositionsByWallet(walletAddress: string, limit = 100): Promise<CopyPosition[]> {
    try {
      const r = await pgPool.query(`SELECT * FROM copy_positions WHERE source_wallet = $1 ORDER BY opened_at DESC LIMIT $2`, [walletAddress, limit]);
      return r.rows.map((row: Record<string, unknown>) => this._toPosition(row));
    } catch (e) { log.error('Failed get positions by wallet', { walletAddress, error: String(e) }); return []; }
  }

  async loadOpenPositions(): Promise<CopyPosition[]> {
    try {
      const result = await pgPool.query(`SELECT * FROM copy_positions WHERE status = 'OPEN'`);
      const positions = result.rows.map((row: Record<string, unknown>) => this._toPosition(row));
      log.info('Loaded open positions from database', { count: positions.length });
      return positions;
    } catch (error) { log.error('Failed to load open positions', { error: error instanceof Error ? error.message : String(error) }); throw error; }
  }

  async restorePositions(exitManager: IExitManager): Promise<PositionRestorationResult> {
    const result: PositionRestorationResult = { totalLoaded: 0, restored: 0, expiredTimeStop: 0, errors: 0 };
    let positions: CopyPosition[] = []; let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try { positions = await this.loadOpenPositions(); lastError = null; break; }
      catch (error) { lastError = error instanceof Error ? error : new Error(String(error)); log.warn('Failed to load positions, retrying...', { attempt, maxRetries: this.maxRetries, error: lastError.message }); if (attempt < this.maxRetries) await this._sleep(this.retryDelayMs * attempt); }
    }
    if (lastError) { log.error('Failed to load positions after all retries', { error: lastError.message }); throw lastError; }
    result.totalLoaded = positions.length; const now = Date.now();
    for (const position of positions) {
      try {
        if (position.timeStop <= now) {
          position.status = 'TIME_STOP'; position.closedAt = now; position.exitReason = 'TIME_STOP';
          await this.updatePosition(position); result.expiredTimeStop++;
          log.info('Position expired during downtime', { positionId: position.id, timeStop: position.timeStop, expiredBy: now - position.timeStop });
        } else {
          exitManager.registerPosition(position); result.restored++;
          log.info('Position restored and registered', { positionId: position.id, tokenAddress: position.tokenAddress.slice(0, 10), timeStopRemaining: position.timeStop - now });
        }
      } catch (error) { result.errors++; log.error('Failed to restore position', { positionId: position.id, error: error instanceof Error ? error.message : String(error) }); }
    }
    this.restoredPositionCount = result.restored;
    log.info('Position restoration complete', { totalLoaded: result.totalLoaded, restored: result.restored, expiredTimeStop: result.expiredTimeStop, errors: result.errors });
    return result;
  }

  async restoreOpenPositions(exitManager?: IExitManager): Promise<CopyPosition[]> {
    const positions = await this.loadOpenPositions();
    if (exitManager) { for (const p of positions) exitManager.registerPosition(p); log.info('Restored and registered positions', { count: positions.length }); }
    return positions;
  }

  getRestoredPositionCount(): number { return this.restoredPositionCount; }

  /** Req 8.3: Calculate wallet metrics - win rate, PnL, Sharpe ratio per wallet */
  async calculateWalletMetrics(walletAddress: string, startDate?: Date, endDate?: Date): Promise<WalletMetrics | null> {
    try {
      let query = `SELECT COUNT(*) as total_trades, SUM(CASE WHEN pnl_usdc > 0 THEN 1 ELSE 0 END) as wins_count, SUM(pnl_usdc) as total_pnl, AVG(pnl_usdc) as avg_pnl, STDDEV(pnl_usdc) as stddev_pnl FROM copy_positions WHERE source_wallet = $1 AND status != 'OPEN'`;
      const values: (string | number)[] = [walletAddress]; let paramIndex = 2;
      if (startDate) { query += ` AND closed_at >= $${paramIndex}`; values.push(startDate.getTime()); paramIndex++; }
      if (endDate) { query += ` AND closed_at <= $${paramIndex}`; values.push(endDate.getTime()); }
      const result = await pgPool.query(query, values);
      const row = result.rows[0]; const tradesCount = parseInt(row.total_trades || '0', 10);
      if (tradesCount === 0) return null;
      const winsCount = parseInt(row.wins_count || '0', 10);
      const totalPnl = parseFloat(row.total_pnl || '0');
      const avgPnl = parseFloat(row.avg_pnl || '0');
      const stddevPnl = parseFloat(row.stddev_pnl || '0');
      const sharpeRatio = stddevPnl > 0 ? (avgPnl - RISK_FREE_RATE) / stddevPnl : null;
      return { walletAddress, tradesCount, winsCount, winRate: (winsCount / tradesCount) * 100, totalPnl, avgPnl, sharpeRatio };
    } catch (err) { log.error('Failed to calculate wallet metrics', { walletAddress, error: String(err) }); return null; }
  }

  /** Req 8.4: Calculate tier metrics - metrics grouped by wallet tier (S, A, B) */
  async calculateTierMetrics(tier: WalletTier, startDate?: Date, endDate?: Date): Promise<TierMetrics | null> {
    try {
      let query = `SELECT COUNT(cp.id) as total_trades, SUM(CASE WHEN cp.pnl_usdc > 0 THEN 1 ELSE 0 END) as wins_count, SUM(cp.pnl_usdc) as total_pnl, AVG(cp.pnl_usdc) as avg_pnl, STDDEV(cp.pnl_usdc) as stddev_pnl FROM copy_positions cp INNER JOIN copy_signals cs ON cp.signal_id = cs.id WHERE cs.wallet_tier = $1 AND cp.status != 'OPEN'`;
      const values: (string | number)[] = [tier]; let paramIndex = 2;
      if (startDate) { query += ` AND cp.closed_at >= $${paramIndex}`; values.push(startDate.getTime()); paramIndex++; }
      if (endDate) { query += ` AND cp.closed_at <= $${paramIndex}`; values.push(endDate.getTime()); }
      const result = await pgPool.query(query, values);
      const row = result.rows[0]; const tradesCount = parseInt(row.total_trades || '0', 10);
      if (tradesCount === 0) return null;
      const winsCount = parseInt(row.wins_count || '0', 10);
      const totalPnl = parseFloat(row.total_pnl || '0');
      const avgPnl = parseFloat(row.avg_pnl || '0');
      const stddevPnl = parseFloat(row.stddev_pnl || '0');
      const sharpeRatio = stddevPnl > 0 ? (avgPnl - RISK_FREE_RATE) / stddevPnl : null;
      return { tier, tradesCount, winsCount, winRate: (winsCount / tradesCount) * 100, totalPnl, avgPnl, sharpeRatio };
    } catch (err) { log.error('Failed to calculate tier metrics', { tier, error: String(err) }); return null; }
  }

  /** Req 8.5: Calculate daily metrics - daily aggregation for all wallets */
  async calculateDailyMetrics(date: Date): Promise<AggregateMetrics | null> {
    try {
      const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const endOfDay = new Date(startOfDay.getTime() + 86400000);
      const query = `SELECT COUNT(*) as total_trades, SUM(CASE WHEN pnl_usdc > 0 THEN 1 ELSE 0 END) as winning_trades, SUM(CASE WHEN pnl_usdc <= 0 THEN 1 ELSE 0 END) as losing_trades, SUM(pnl_usdc) as total_pnl, AVG(pnl_usdc) as avg_pnl, STDDEV(pnl_usdc) as stddev_pnl FROM copy_positions WHERE status != 'OPEN' AND closed_at >= $1 AND closed_at < $2`;
      const result = await pgPool.query(query, [startOfDay.getTime(), endOfDay.getTime()]);
      const row = result.rows[0]; const totalTrades = parseInt(row.total_trades || '0', 10);
      if (totalTrades === 0) return null;
      const winningTrades = parseInt(row.winning_trades || '0', 10);
      const avgPnl = parseFloat(row.avg_pnl || '0');
      const stddevPnl = parseFloat(row.stddev_pnl || '0');
      return {
        date: startOfDay, walletAddress: null, tier: null, periodType: 'DAILY', totalTrades, winningTrades,
        losingTrades: parseInt(row.losing_trades || '0', 10), winRate: (winningTrades / totalTrades) * 100,
        totalPnlUsdc: parseFloat(row.total_pnl || '0'), avgPnlUsdc: avgPnl,
        sharpeRatio: stddevPnl > 0 ? (avgPnl - RISK_FREE_RATE) / stddevPnl : null
      };
    } catch (err) { log.error('Failed to calculate daily metrics', { date, error: String(err) }); return null; }
  }

  /** Req 8.5: Get aggregated metrics for period (daily, weekly, monthly) */
  async getAggregatedMetrics(period: PeriodType, startDate: Date, endDate: Date): Promise<AggregateMetrics[]> {
    const results: AggregateMetrics[] = [];
    try {
      const currentDate = new Date(startDate);
      while (currentDate <= endDate) {
        const { periodStart, periodEnd, nextDate } = this._getPeriodBounds(currentDate, period);
        if (periodStart > endDate) break;
        const query = `SELECT COUNT(*) as total_trades, SUM(CASE WHEN pnl_usdc > 0 THEN 1 ELSE 0 END) as winning_trades, SUM(CASE WHEN pnl_usdc <= 0 THEN 1 ELSE 0 END) as losing_trades, SUM(pnl_usdc) as total_pnl, AVG(pnl_usdc) as avg_pnl, STDDEV(pnl_usdc) as stddev_pnl FROM copy_positions WHERE status != 'OPEN' AND closed_at >= $1 AND closed_at < $2`;
        const actualEnd = Math.min(periodEnd.getTime(), endDate.getTime() + 86400000);
        const result = await pgPool.query(query, [periodStart.getTime(), actualEnd]);
        const row = result.rows[0]; const totalTrades = parseInt(row.total_trades || '0', 10);
        if (totalTrades > 0) {
          const winningTrades = parseInt(row.winning_trades || '0', 10);
          const avgPnl = parseFloat(row.avg_pnl || '0');
          const stddevPnl = parseFloat(row.stddev_pnl || '0');
          results.push({
            date: periodStart, walletAddress: null, tier: null, periodType: period, totalTrades, winningTrades,
            losingTrades: parseInt(row.losing_trades || '0', 10), winRate: (winningTrades / totalTrades) * 100,
            totalPnlUsdc: parseFloat(row.total_pnl || '0'), avgPnlUsdc: avgPnl,
            sharpeRatio: stddevPnl > 0 ? (avgPnl - RISK_FREE_RATE) / stddevPnl : null
          });
        }
        currentDate.setTime(nextDate.getTime());
      }
      log.debug('Aggregated metrics retrieved', { period, count: results.length });
      return results;
    } catch (err) { log.error('Failed to get aggregated metrics', { period, error: String(err) }); return results; }
  }

  private _getPeriodBounds(date: Date, period: PeriodType): { periodStart: Date; periodEnd: Date; nextDate: Date } {
    let periodStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    let periodEnd: Date; let nextDate: Date;
    switch (period) {
      case 'DAILY':
        periodEnd = new Date(periodStart.getTime() + 86400000); nextDate = periodEnd; break;
      case 'WEEKLY':
        const dayOfWeek = periodStart.getDay();
        const monday = new Date(periodStart);
        monday.setDate(periodStart.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
        periodStart = monday;
        periodEnd = new Date(periodStart.getTime() + 7 * 86400000); nextDate = periodEnd; break;
      case 'MONTHLY':
        periodStart = new Date(periodStart.getFullYear(), periodStart.getMonth(), 1);
        periodEnd = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, 1);
        nextDate = periodEnd; break;
    }
    return { periodStart, periodEnd, nextDate };
  }

  /** Persist daily metrics to copy_daily_metrics table */
  async persistDailyMetrics(date: Date): Promise<void> {
    try {
      const metrics = await this.calculateDailyMetrics(date);
      if (!metrics) { log.debug('No metrics to persist', { date: date.toISOString().split('T')[0] }); return; }
      const dateStr = date.toISOString().split('T')[0];
      const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const endOfDay = new Date(startOfDay.getTime() + 86400000);
      const walletsResult = await pgPool.query(`SELECT source_wallet, SUM(pnl_usdc) as total_pnl FROM copy_positions WHERE status != 'OPEN' AND closed_at >= $1 AND closed_at < $2 GROUP BY source_wallet ORDER BY total_pnl DESC`, [startOfDay.getTime(), endOfDay.getTime()]);
      const bestWallet = walletsResult.rows[0]?.source_wallet || null;
      const worstWallet = walletsResult.rows[walletsResult.rows.length - 1]?.source_wallet || null;
      const signalsResult = await pgPool.query(`SELECT COUNT(*) as total_signals, SUM(CASE WHEN enrichment_result = 'APPROVED' THEN 1 ELSE 0 END) as approved_signals FROM copy_signals WHERE detected_at >= $1 AND detected_at < $2`, [startOfDay.getTime(), endOfDay.getTime()]);
      const sRow = signalsResult.rows[0];
      const query = `INSERT INTO copy_daily_metrics (date, total_signals, approved_signals, executed_trades, total_pnl_usdc, win_count, loss_count, avg_holding_time_ms, best_wallet, worst_wallet) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (date) DO UPDATE SET total_signals = EXCLUDED.total_signals, approved_signals = EXCLUDED.approved_signals, executed_trades = EXCLUDED.executed_trades, total_pnl_usdc = EXCLUDED.total_pnl_usdc, win_count = EXCLUDED.win_count, loss_count = EXCLUDED.loss_count, best_wallet = EXCLUDED.best_wallet, worst_wallet = EXCLUDED.worst_wallet`;
      await pgPool.query(query, [dateStr, parseInt(sRow.total_signals || '0', 10), parseInt(sRow.approved_signals || '0', 10), metrics.totalTrades, metrics.totalPnlUsdc, metrics.winningTrades, metrics.losingTrades, null, bestWallet, worstWallet]);
      log.info('Daily metrics persisted', { date: dateStr, totalTrades: metrics.totalTrades, totalPnl: metrics.totalPnlUsdc });
    } catch (err) { log.error('Failed to persist daily metrics', { date, error: String(err) }); throw err; }
  }

  async generateDailyReport(date: Date = new Date()): Promise<DailyReport> {
    const startOfDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
    const endOfDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
    const startTs = startOfDay.getTime(); const endTs = endOfDay.getTime();
    log.info('Generating daily report', { date: startOfDay.toISOString().split('T')[0] });
    try {
      const mRes = await pgPool.query(`SELECT COUNT(*) as total,SUM(CASE WHEN pnl_usdc>0 THEN 1 ELSE 0 END) as wins,SUM(pnl_usdc) as pnl,AVG(pnl_usdc) as avg_pnl FROM copy_positions WHERE status!='OPEN' AND closed_at>=$1 AND closed_at<=$2`, [startTs, endTs]);
      const m = mRes.rows[0]; const tradesCount = parseInt(m.total || '0', 10); const winsCount = parseInt(m.wins || '0', 10);
      const totalPnlUsdc = parseFloat(m.pnl || '0'); const avgPnlPerTrade = parseFloat(m.avg_pnl || '0');
      const winRate = tradesCount > 0 ? (winsCount / tradesCount) * 100 : 0;
      const topRes = await pgPool.query(`SELECT source_wallet,SUM(pnl_usdc) as pnl,COUNT(*) as trades FROM copy_positions WHERE status!='OPEN' AND closed_at>=$1 AND closed_at<=$2 GROUP BY source_wallet ORDER BY pnl DESC LIMIT 5`, [startTs, endTs]);
      const topWallets = topRes.rows.map(r => ({ address: r.source_wallet, tier: 'B_TIER' as WalletTier, pnl: parseFloat(r.pnl || '0'), trades: parseInt(r.trades || '0', 10) }));
      const worstRes = await pgPool.query(`SELECT source_wallet,SUM(pnl_usdc) as pnl,COUNT(*) as trades FROM copy_positions WHERE status!='OPEN' AND closed_at>=$1 AND closed_at<=$2 GROUP BY source_wallet ORDER BY pnl ASC LIMIT 5`, [startTs, endTs]);
      const worstWallets = worstRes.rows.map(r => ({ address: r.source_wallet, tier: 'B_TIER' as WalletTier, pnl: parseFloat(r.pnl || '0'), trades: parseInt(r.trades || '0', 10) }));
      const pnlByTier: Record<WalletTier, { pnl: number; trades: number; winRate: number }> = { S_TIER: { pnl: 0, trades: 0, winRate: 0 }, A_TIER: { pnl: 0, trades: 0, winRate: 0 }, B_TIER: { pnl: totalPnlUsdc, trades: tradesCount, winRate } };
      const exitRes = await pgPool.query(`SELECT exit_reason,COUNT(*) as cnt,SUM(pnl_usdc) as pnl FROM copy_positions WHERE status!='OPEN' AND closed_at>=$1 AND closed_at<=$2 AND exit_reason IS NOT NULL GROUP BY exit_reason`, [startTs, endTs]);
      const exitReasonBreakdown: Record<string, { count: number; pnl: number }> = {};
      for (const r of exitRes.rows) exitReasonBreakdown[r.exit_reason] = { count: parseInt(r.cnt || '0', 10), pnl: parseFloat(r.pnl || '0') };
      log.info('Daily report generated', { date: startOfDay.toISOString().split('T')[0], totalPnlUsdc, tradesCount, winRate: winRate.toFixed(1) + '%' });
      return { date: startOfDay, totalPnlUsdc, tradesCount, winsCount, winRate, avgPnlPerTrade, topWallets, worstWallets, pnlByTier, exitReasonBreakdown };
    } catch (e) {
      log.error('Failed generate report', { error: String(e) });
      return { date: startOfDay, totalPnlUsdc: 0, tradesCount: 0, winsCount: 0, winRate: 0, avgPnlPerTrade: 0, topWallets: [], worstWallets: [], pnlByTier: { S_TIER: { pnl: 0, trades: 0, winRate: 0 }, A_TIER: { pnl: 0, trades: 0, winRate: 0 }, B_TIER: { pnl: 0, trades: 0, winRate: 0 } }, exitReasonBreakdown: {} };
    }
  }

  formatReportForLog(report: DailyReport): string {
    const dateStr = report.date.toISOString().split('T')[0]; const pnlSign = report.totalPnlUsdc >= 0 ? '+' : '';
    return `\n=== DAILY REPORT ${dateStr} ===\nTotal PnL: ${pnlSign}$${report.totalPnlUsdc.toFixed(2)} | Trades: ${report.tradesCount} | Win Rate: ${report.winRate.toFixed(1)}%\n`;
  }

  scheduleDailyReport(hour: number): void {
    if (this.dailyReportTimer) clearInterval(this.dailyReportTimer);
    const scheduleNext = () => {
      const now = new Date(); const next = new Date(now);
      next.setUTCHours(hour, 0, 0, 0); if (next <= now) next.setDate(next.getDate() + 1);
      const delay = next.getTime() - now.getTime();
      setTimeout(async () => {
        try { const report = await this.generateDailyReport(new Date(Date.now() - 86400000)); log.info(this.formatReportForLog(report)); }
        catch (e) { log.error('Scheduled report failed', { error: String(e) }); }
        scheduleNext();
      }, delay);
    };
    scheduleNext(); log.info('Daily report scheduled', { hour });
  }

  async close(): Promise<void> { if (this.dailyReportTimer) { clearInterval(this.dailyReportTimer); this.dailyReportTimer = null; } log.info('CopyMetricsRecorder closed'); }

  private _toPosition(row: Record<string, unknown>): CopyPosition {
    return {
      id: String(row.id), signalId: String(row.signal_id), sourceWallet: String(row.source_wallet),
      tokenAddress: String(row.token_address), poolAddress: String(row.pool_address),
      entryPrice: BigInt(String(row.entry_price || '0')), positionSizeUsdc: Number(row.position_size_usdc),
      tokenAmount: BigInt(String(row.token_amount || '0')), takeProfit: BigInt(String(row.take_profit || '0')),
      stopLoss: BigInt(String(row.stop_loss || '0')), trailingStopTrigger: BigInt(String(row.trailing_stop_trigger || '0')),
      trailingStopLevel: row.trailing_stop_level ? BigInt(String(row.trailing_stop_level)) : null,
      timeStop: Number(row.time_stop), status: row.status as CopyPosition['status'], openedAt: Number(row.opened_at),
      closedAt: row.closed_at ? Number(row.closed_at) : null, exitPrice: row.exit_price ? BigInt(String(row.exit_price)) : null,
      pnlUsdc: row.pnl_usdc ? Number(row.pnl_usdc) : null, exitReason: row.exit_reason as string | null,
    };
  }

  private _sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
}

export function createCopyMetricsRecorder(): CopyMetricsRecorder { return new CopyMetricsRecorder(); }
