import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const targetPath = join(__dirname, 'src/copy-trading/modules/CopyMetricsRecorder.ts');

const content = `/**
 * CopyMetricsRecorder - Task 19.1
 * Req: 8.1, 8.2
 */
import { createLogger } from '../../logger.js';
import { pgPool } from '../../trading-validation/postgres.js';
import type { CopyPosition, CopySignal, EnrichedSignal, WalletTier, IExitManager } from '../interfaces/types.js';

const log = createLogger('copy-metrics-recorder');

export interface CopySignalRecord {
  id: string; source_wallet: string; wallet_tier: string; token_address: string;
  pool_address: string; action: 'BUY' | 'SELL'; trade_amount_usdc: number;
  entry_price: string; block_number: number; tx_hash: string; detected_at: number;
  detection_latency_ms: number; enrichment_result: string | null;
  enrichment_reject_reason: string | null; baiting_result: string | null;
  baiting_reject_reason: string | null; execution_result: string | null;
  execution_reject_reason: string | null; position_id: string | null; created_at: Date;
}

export interface CopyPositionRecord {
  id: string; signal_id: string; source_wallet: string; token_address: string;
  pool_address: string; entry_price: string; position_size_usdc: number;
  token_amount: string; status: string; opened_at: number; closed_at: number | null;
  exit_price: string | null; pnl_usdc: number | null; exit_reason: string | null;
}

export interface SignalValidationResult {
  enrichmentResult?: 'APPROVED' | 'REJECTED'; enrichmentRejectReason?: string;
  baitingResult?: 'APPROVED' | 'REJECTED'; baitingRejectReason?: string;
  executionResult?: 'EXECUTED' | 'REJECTED'; executionRejectReason?: string;
  positionId?: string;
}

export interface DailyReport {
  date: Date; totalPnlUsdc: number; tradesCount: number; winsCount: number;
  winRate: number; avgPnlPerTrade: number;
  topWallets: Array<{ address: string; tier: WalletTier; pnl: number; trades: number }>;
  worstWallets: Array<{ address: string; tier: WalletTier; pnl: number; trades: number }>;
  pnlByTier: Record<WalletTier, { pnl: number; trades: number; winRate: number }>;
  exitReasonBreakdown: Record<string, { count: number; pnl: number }>;
}
`;

writeFileSync(targetPath, content, 'utf8');
console.log('Part 1 written to:', targetPath);
