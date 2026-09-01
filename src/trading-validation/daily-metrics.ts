/**
 * Trading Validation Phase - Daily Metrics, AI Budget Tracking, and Alerts
 *
 * Tracks: trades/day, failed tx/day, evaluations, gas, P&L, AI costs by category.
 * AI budget enforcement: global $0.20/day, trading $0.10, services $0.05, research $0.00, diagnostics $0.02.
 * LLM model selection: Sonnet only if profit > $0.15, Haiku for $0.08-$0.15, no LLM for exits.
 * LowCostMode on trading budget exceeded.
 * Telegram alerts: rate limited (10 non-critical/hour, unlimited critical).
 * Secret redaction in all log/alert output.
 * Daily backup trigger.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.5, 27.1, 27.2, 27.3, 27.4, 27.5, 27.6, E14, 34.2, 35.2, 35.3, 35.5
 */

import type { UsdcAmount } from './types.js';
import type { AiBudgetConfig, AlertsConfig } from './config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Types and Interfaces
// ═══════════════════════════════════════════════════════════════════════════

/** AI cost category for sub-budget enforcement */
export type AiCostCategory = 'trading' | 'services' | 'research' | 'diagnostics';

/** LLM model tier selection */
export type LlmModelTier = 'sonnet' | 'haiku' | 'none';

/** Alert severity level */
export type AlertSeverity = 'critical' | 'non_critical';

/** Snapshot of daily metrics */
export interface DailyMetricsSnapshot {
  dayUtc: string;                    // 'YYYY-MM-DD'
  tradesCount: number;
  failedTxCount: number;
  evaluationsCount: number;
  signalsGenerated: number;
  tradesRejected: number;
  totalGasUsd: number;
  totalPnl: number;
  aiCostTrading: number;
  aiCostServices: number;
  aiCostDiagnostics: number;
  aiCostResearch: number;
  safeModeEvents: number;
  alertsSent: number;
}

/** AI budget status */
export interface AiBudgetStatus {
  globalSpent: number;
  globalRemaining: number;
  globalExceeded: boolean;
  tradingSpent: number;
  tradingRemaining: number;
  tradingExceeded: boolean;
  servicesSpent: number;
  servicesRemaining: number;
  servicesExceeded: boolean;
  researchSpent: number;
  diagnosticsSpent: number;
  diagnosticsRemaining: number;
  diagnosticsExceeded: boolean;
  lowCostModeActive: boolean;
}

/** Record of an LLM call for cost tracking */
export interface LlmCallRecord {
  timestamp: number;
  category: AiCostCategory;
  model: LlmModelTier;
  cost: number;
  purpose: string;
  decisionImpact: string;
}

/** Alert callback interface */
export interface IAlertSender {
  sendTelegramAlert(message: string, severity: AlertSeverity): Promise<void>;
}

/** Backup trigger callback */
export interface IBackupTrigger {
  triggerDailyBackup(): Promise<void>;
}

/** SafeMode controller interface (subset needed here) */
export interface ISafeModeForMetrics {
  enterLowCostMode(): void;
  exitLowCostMode(): void;
  getState(): { state: string };
}

/** Database interface (subset for daily-metrics) */
export interface IDailyMetricsDb {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Secret Redaction
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Patterns that indicate secrets which must be redacted from logs and alerts.
 * Requirements: 35.2, 35.3, 35.5
 */
const SECRET_PATTERNS: RegExp[] = [
  // Private keys (hex, 64 chars)
  /0x[0-9a-fA-F]{64}/g,
  // Seed phrases (12 or 24 words separated by spaces)
  /\b(?:[a-z]+\s){11}[a-z]+\b/gi,
  /\b(?:[a-z]+\s){23}[a-z]+\b/gi,
  // API keys (various formats)
  /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token)[=:]\s*["']?[A-Za-z0-9\-_.]{20,}["']?/gi,
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9\-_.~+/]{20,}/gi,
  // RPC URLs with embedded keys
  /https?:\/\/[^/]*[A-Za-z0-9]{32,}[^/\s]*/g,
  // Telegram bot tokens
  /\d{8,10}:[A-Za-z0-9_-]{35}/g,
  // Generic long hex strings that look like keys (32+ bytes)
  /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40,}(?![0-9a-fA-F])/g,
  // Env var patterns with sensitive names
  /(?:PRIVATE_KEY|MNEMONIC|SECRET|PASSWORD|TOKEN|TELEGRAM_BOT_TOKEN)[=:]\s*\S+/gi,
];

/**
 * Redacts secrets from a string, replacing them with [REDACTED].
 * Used for all log output and alert messages.
 *
 * Requirements: 35.2, 35.3, 35.5
 */
export function redactSecrets(input: string): string {
  let result = input;
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// LLM Model Selection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Determines which LLM model tier to use based on expected profit.
 *
 * - Sonnet: only if expected profit > $0.15
 * - Haiku: for profit $0.08-$0.15
 * - None: for exits (no LLM), or when budget exceeded
 *
 * Requirements: 9.2
 */
export function selectLlmModel(
  expectedProfitUsdc: UsdcAmount,
  isExit: boolean,
  budgetExceeded: boolean,
): LlmModelTier {
  // No LLM for exits (Requirement 9.2)
  if (isExit) {
    return 'none';
  }

  // No LLM if budget exceeded (LowCostMode)
  if (budgetExceeded) {
    return 'none';
  }

  // Convert to USD (6 decimals)
  const profitUsd = Number(expectedProfitUsdc) / 1_000_000;

  if (profitUsd > 0.15) {
    return 'sonnet';
  }
  if (profitUsd >= 0.08) {
    return 'haiku';
  }

  return 'none';
}

// ═══════════════════════════════════════════════════════════════════════════
// Daily Metrics Manager
// ═══════════════════════════════════════════════════════════════════════════

export class DailyMetricsManager {
  private readonly db: IDailyMetricsDb;
  private readonly aiBudgetConfig: AiBudgetConfig;
  private readonly alertsConfig: AlertsConfig;
  private readonly safeModeController: ISafeModeForMetrics;
  private readonly alertSender?: IAlertSender;
  private readonly backupTrigger?: IBackupTrigger;

  // In-memory rate limiting for alerts (E14)
  private nonCriticalAlertTimestamps: number[] = [];

  // In-memory AI cost tracking for current day
  private currentDayUtc: string;
  private aiCosts: Record<AiCostCategory, number> = {
    trading: 0,
    services: 0,
    research: 0,
    diagnostics: 0,
  };

  // Track whether LowCostMode was already triggered today
  private lowCostModeTriggeredToday = false;

  // Track last backup date
  private lastBackupDay: string | null = null;

  constructor(params: {
    db: IDailyMetricsDb;
    aiBudgetConfig: AiBudgetConfig;
    alertsConfig: AlertsConfig;
    safeModeController: ISafeModeForMetrics;
    alertSender?: IAlertSender;
    backupTrigger?: IBackupTrigger;
  }) {
    this.db = params.db;
    this.aiBudgetConfig = params.aiBudgetConfig;
    this.alertsConfig = params.alertsConfig;
    this.safeModeController = params.safeModeController;
    this.alertSender = params.alertSender;
    this.backupTrigger = params.backupTrigger;
    this.currentDayUtc = this.getTodayUtc();

    // Load existing AI costs for today from DB
    this.loadAiCostsFromDb();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Day Management
  // ─────────────────────────────────────────────────────────────────────────

  /** Get current UTC date string */
  private getTodayUtc(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Ensures metrics row exists for current day.
   * Resets in-memory state on day change.
   */
  private ensureCurrentDay(): void {
    const today = this.getTodayUtc();

    if (today !== this.currentDayUtc) {
      // Day changed — reset in-memory state
      this.currentDayUtc = today;
      this.aiCosts = { trading: 0, services: 0, research: 0, diagnostics: 0 };
      this.nonCriticalAlertTimestamps = [];
      this.lowCostModeTriggeredToday = false;

      // Exit LowCostMode on new day (E7: reset at UTC midnight)
      const state = this.safeModeController.getState();
      if (state.state === 'low_cost_mode') {
        this.safeModeController.exitLowCostMode();
      }

      // Trigger daily backup (Requirement 34.2)
      this.triggerBackup();
    }

    // Upsert daily_metrics row
    this.db.prepare(`
      INSERT OR IGNORE INTO daily_metrics (day_utc)
      VALUES (?)
    `).run(today);
  }

  /**
   * Load AI costs from DB for current day.
   */
  private loadAiCostsFromDb(): void {
    const row = this.db.prepare(
      'SELECT ai_cost_trading, ai_cost_services, ai_cost_diagnostics FROM daily_metrics WHERE day_utc = ?'
    ).get(this.currentDayUtc) as {
      ai_cost_trading: string;
      ai_cost_services: string;
      ai_cost_diagnostics: string;
    } | undefined;

    if (row) {
      this.aiCosts.trading = parseFloat(row.ai_cost_trading) || 0;
      this.aiCosts.services = parseFloat(row.ai_cost_services) || 0;
      this.aiCosts.diagnostics = parseFloat(row.ai_cost_diagnostics) || 0;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Metric Recording
  // ─────────────────────────────────────────────────────────────────────────

  /** Record a completed trade */
  recordTrade(): void {
    this.ensureCurrentDay();
    this.db.prepare(
      'UPDATE daily_metrics SET trades_count = trades_count + 1 WHERE day_utc = ?'
    ).run(this.currentDayUtc);
  }

  /** Record a failed transaction (broadcasted, reverted/dropped) */
  recordFailedTx(): void {
    this.ensureCurrentDay();
    this.db.prepare(
      'UPDATE daily_metrics SET failed_tx_count = failed_tx_count + 1 WHERE day_utc = ?'
    ).run(this.currentDayUtc);
  }

  /** Record a strategy evaluation */
  recordEvaluation(): void {
    this.ensureCurrentDay();
    this.db.prepare(
      'UPDATE daily_metrics SET evaluations_count = evaluations_count + 1 WHERE day_utc = ?'
    ).run(this.currentDayUtc);
  }

  /** Record a signal generated by StrategyEngine */
  recordSignal(): void {
    this.ensureCurrentDay();
    this.db.prepare(
      'UPDATE daily_metrics SET signals_generated = signals_generated + 1 WHERE day_utc = ?'
    ).run(this.currentDayUtc);
  }

  /** Record a trade rejected by CostAwareTradeGate */
  recordTradeRejected(): void {
    this.ensureCurrentDay();
    this.db.prepare(
      'UPDATE daily_metrics SET trades_rejected = trades_rejected + 1 WHERE day_utc = ?'
    ).run(this.currentDayUtc);
  }

  /** Record gas expenditure (in USD) */
  recordGas(gasUsd: number): void {
    this.ensureCurrentDay();
    this.db.prepare(
      'UPDATE daily_metrics SET total_gas_usd = CAST(CAST(total_gas_usd AS REAL) + ? AS TEXT) WHERE day_utc = ?'
    ).run(gasUsd, this.currentDayUtc);
  }

  /** Record realized P&L (in USD, can be negative) */
  recordPnl(pnlUsd: number): void {
    this.ensureCurrentDay();
    this.db.prepare(
      'UPDATE daily_metrics SET total_pnl = CAST(CAST(total_pnl AS REAL) + ? AS TEXT) WHERE day_utc = ?'
    ).run(pnlUsd, this.currentDayUtc);
  }

  /** Record a Safe_Mode event */
  recordSafeModeEvent(): void {
    this.ensureCurrentDay();
    this.db.prepare(
      'UPDATE daily_metrics SET safe_mode_events = safe_mode_events + 1 WHERE day_utc = ?'
    ).run(this.currentDayUtc);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // AI Cost Tracking (Requirements 9.1, 9.5, 27.1-27.6)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Record an AI/LLM cost. Enforces budget limits and triggers LowCostMode
   * when trading budget is exceeded.
   *
   * Requirements: 9.1, 9.3, 9.5, 27.1, 27.2, 27.5, 27.6
   */
  recordAiCost(record: LlmCallRecord): void {
    this.ensureCurrentDay();

    const { category, cost, model, purpose, decisionImpact } = record;

    // Accumulate cost in memory
    this.aiCosts[category] += cost;

    // Persist to DB
    const columnMap: Record<AiCostCategory, string> = {
      trading: 'ai_cost_trading',
      services: 'ai_cost_services',
      diagnostics: 'ai_cost_diagnostics',
      research: 'ai_cost_trading', // research mapped to trading column (budget is $0.00)
    };

    const column = columnMap[category];
    this.db.prepare(
      `UPDATE daily_metrics SET ${column} = CAST(CAST(${column} AS REAL) + ? AS TEXT) WHERE day_utc = ?`
    ).run(cost, this.currentDayUtc);

    // Log the LLM call to event_log (Requirement 9.5)
    this.db.prepare(
      'INSERT INTO event_log (event_type, details, timestamp) VALUES (?, ?, ?)'
    ).run(
      'llm_call',
      JSON.stringify({
        category,
        model,
        cost,
        purpose: redactSecrets(purpose),
        decisionImpact: redactSecrets(decisionImpact),
        dayTotal: this.getGlobalAiSpent(),
      }),
      Date.now(),
    );

    // Check budget enforcement
    this.enforceBudgetLimits();
  }

  /**
   * Get total AI spend across all categories for current day.
   */
  private getGlobalAiSpent(): number {
    return this.aiCosts.trading + this.aiCosts.services + this.aiCosts.research + this.aiCosts.diagnostics;
  }

  /**
   * Enforce AI budget limits.
   * - Global cap exceeded → disable ALL discretionary LLM (Requirement 27.5)
   * - Trading budget exceeded → LowCostMode (Requirement 9.3)
   *
   * Requirements: 9.3, 27.1, 27.2, 27.5
   */
  private enforceBudgetLimits(): void {
    const globalSpent = this.getGlobalAiSpent();
    const tradingSpent = this.aiCosts.trading;

    // Check trading budget ($0.10/day)
    if (tradingSpent >= this.aiBudgetConfig.tradingBudgetDay && !this.lowCostModeTriggeredToday) {
      this.lowCostModeTriggeredToday = true;
      this.safeModeController.enterLowCostMode();

      this.sendAlert(
        `⚠️ Trading AI budget exceeded ($${tradingSpent.toFixed(4)}/$${this.aiBudgetConfig.tradingBudgetDay.toFixed(2)}). LowCostMode activated. Local trading/exits continue.`,
        'non_critical',
      );
    }

    // Check global cap ($0.20/day) — disable ALL discretionary LLM
    if (globalSpent >= this.aiBudgetConfig.globalHardCapDay && !this.lowCostModeTriggeredToday) {
      this.lowCostModeTriggeredToday = true;
      this.safeModeController.enterLowCostMode();

      this.sendAlert(
        `🚫 Global AI budget cap exceeded ($${globalSpent.toFixed(4)}/$${this.aiBudgetConfig.globalHardCapDay.toFixed(2)}). ALL discretionary LLM disabled until next UTC day.`,
        'non_critical',
      );
    }
  }

  /**
   * Check if a specific AI cost category budget allows a call.
   * Returns true if the call is allowed within budget.
   *
   * Requirements: 27.2, 27.3, 27.4
   */
  canMakeAiCall(category: AiCostCategory, estimatedCost: number): boolean {
    this.ensureCurrentDay();

    const globalSpent = this.getGlobalAiSpent();

    // Global cap exceeded → block all
    if (globalSpent >= this.aiBudgetConfig.globalHardCapDay) {
      return false;
    }

    // Category-specific checks
    switch (category) {
      case 'trading':
        return this.aiCosts.trading + estimatedCost <= this.aiBudgetConfig.tradingBudgetDay;
      case 'services':
        return this.aiCosts.services + estimatedCost <= this.aiBudgetConfig.servicesBudgetDay;
      case 'research':
        // Research budget is $0.00 during validation (Requirement 27.4)
        return this.aiBudgetConfig.researchBudgetDay > 0 &&
          this.aiCosts.research + estimatedCost <= this.aiBudgetConfig.researchBudgetDay;
      case 'diagnostics':
        return this.aiCosts.diagnostics + estimatedCost <= this.aiBudgetConfig.diagnosticsBudgetDay;
      default:
        return false;
    }
  }

  /**
   * Get current AI budget status.
   */
  getAiBudgetStatus(): AiBudgetStatus {
    this.ensureCurrentDay();

    const globalSpent = this.getGlobalAiSpent();
    const state = this.safeModeController.getState();

    return {
      globalSpent,
      globalRemaining: Math.max(0, this.aiBudgetConfig.globalHardCapDay - globalSpent),
      globalExceeded: globalSpent >= this.aiBudgetConfig.globalHardCapDay,
      tradingSpent: this.aiCosts.trading,
      tradingRemaining: Math.max(0, this.aiBudgetConfig.tradingBudgetDay - this.aiCosts.trading),
      tradingExceeded: this.aiCosts.trading >= this.aiBudgetConfig.tradingBudgetDay,
      servicesSpent: this.aiCosts.services,
      servicesRemaining: Math.max(0, this.aiBudgetConfig.servicesBudgetDay - this.aiCosts.services),
      servicesExceeded: this.aiCosts.services >= this.aiBudgetConfig.servicesBudgetDay,
      researchSpent: this.aiCosts.research,
      diagnosticsSpent: this.aiCosts.diagnostics,
      diagnosticsRemaining: Math.max(0, this.aiBudgetConfig.diagnosticsBudgetDay - this.aiCosts.diagnostics),
      diagnosticsExceeded: this.aiCosts.diagnostics >= this.aiBudgetConfig.diagnosticsBudgetDay,
      lowCostModeActive: state.state === 'low_cost_mode',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Telegram Alerts with Rate Limiting (E14)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send an alert with rate limiting.
   * - Critical alerts: unlimited (Safe_Mode, KillSwitch, security)
   * - Non-critical alerts: max 10/hour
   *
   * All output is secret-redacted (Requirement 35.2, 35.3, 35.5).
   *
   * Requirements: E14, 35.2, 35.3, 35.5
   */
  sendAlert(message: string, severity: AlertSeverity): void {
    // Redact secrets from the message
    const safeMessage = redactSecrets(message);

    // Rate limiting for non-critical alerts
    if (severity === 'non_critical') {
      const now = Date.now();
      const oneHourAgo = now - 3_600_000;

      // Remove timestamps older than 1 hour
      this.nonCriticalAlertTimestamps = this.nonCriticalAlertTimestamps.filter(
        (ts) => ts > oneHourAgo
      );

      // Check rate limit
      if (this.nonCriticalAlertTimestamps.length >= this.alertsConfig.nonCriticalMaxPerHour) {
        // Rate limited — log but don't send
        this.db.prepare(
          'INSERT INTO event_log (event_type, details, timestamp) VALUES (?, ?, ?)'
        ).run(
          'alert_rate_limited',
          JSON.stringify({ message: safeMessage, severity }),
          now,
        );
        return;
      }

      this.nonCriticalAlertTimestamps.push(now);
    }

    // Critical alerts are unlimited — always send

    // Record alert sent
    this.ensureCurrentDay();
    this.db.prepare(
      'UPDATE daily_metrics SET alerts_sent = alerts_sent + 1 WHERE day_utc = ?'
    ).run(this.currentDayUtc);

    // Send via Telegram if sender is configured
    if (this.alertSender) {
      // Fire and forget — alert delivery failure is non-critical
      this.alertSender.sendTelegramAlert(safeMessage, severity).catch(() => {
        // Delivery failure logged but not escalated
      });
    }

    // Log alert to event_log
    this.db.prepare(
      'INSERT INTO event_log (event_type, details, timestamp) VALUES (?, ?, ?)'
    ).run(
      'alert_sent',
      JSON.stringify({ message: safeMessage, severity }),
      Date.now(),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Daily Backup Trigger (Requirement 34.2)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Triggers daily backup. Called on day change.
   * Logs backup timestamp.
   *
   * Requirements: 34.2
   */
  private triggerBackup(): void {
    const today = this.getTodayUtc();

    if (this.lastBackupDay === today) {
      return; // Already backed up today
    }

    this.lastBackupDay = today;

    // Log backup attempt
    this.db.prepare(
      'INSERT INTO event_log (event_type, details, timestamp) VALUES (?, ?, ?)'
    ).run(
      'daily_backup_triggered',
      JSON.stringify({ day: today }),
      Date.now(),
    );

    // Trigger actual backup if callback is provided
    if (this.backupTrigger) {
      this.backupTrigger.triggerDailyBackup().catch(() => {
        // Backup failure logged separately
        this.db.prepare(
          'INSERT INTO event_log (event_type, details, timestamp) VALUES (?, ?, ?)'
        ).run(
          'daily_backup_failed',
          JSON.stringify({ day: today }),
          Date.now(),
        );
      });
    }
  }

  /**
   * Manual backup trigger (can be called by operator or on startup).
   */
  triggerBackupManual(): void {
    this.triggerBackup();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Metrics Retrieval
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get daily metrics snapshot for current day.
   */
  getMetrics(): DailyMetricsSnapshot {
    this.ensureCurrentDay();

    const row = this.db.prepare(
      'SELECT * FROM daily_metrics WHERE day_utc = ?'
    ).get(this.currentDayUtc) as {
      day_utc: string;
      trades_count: number;
      failed_tx_count: number;
      evaluations_count: number;
      signals_generated: number;
      trades_rejected: number;
      total_gas_usd: string;
      total_pnl: string;
      ai_cost_trading: string;
      ai_cost_services: string;
      ai_cost_diagnostics: string;
      safe_mode_events: number;
      alerts_sent: number;
    } | undefined;

    if (!row) {
      return {
        dayUtc: this.currentDayUtc,
        tradesCount: 0,
        failedTxCount: 0,
        evaluationsCount: 0,
        signalsGenerated: 0,
        tradesRejected: 0,
        totalGasUsd: 0,
        totalPnl: 0,
        aiCostTrading: 0,
        aiCostServices: 0,
        aiCostDiagnostics: 0,
        aiCostResearch: 0,
        safeModeEvents: 0,
        alertsSent: 0,
      };
    }

    return {
      dayUtc: row.day_utc,
      tradesCount: row.trades_count,
      failedTxCount: row.failed_tx_count,
      evaluationsCount: row.evaluations_count,
      signalsGenerated: row.signals_generated,
      tradesRejected: row.trades_rejected,
      totalGasUsd: parseFloat(row.total_gas_usd) || 0,
      totalPnl: parseFloat(row.total_pnl) || 0,
      aiCostTrading: parseFloat(row.ai_cost_trading) || 0,
      aiCostServices: parseFloat(row.ai_cost_services) || 0,
      aiCostDiagnostics: parseFloat(row.ai_cost_diagnostics) || 0,
      aiCostResearch: this.aiCosts.research,
      safeModeEvents: row.safe_mode_events,
      alertsSent: row.alerts_sent,
    };
  }

  /**
   * Get metrics for a specific day (historical).
   */
  getMetricsForDay(dayUtc: string): DailyMetricsSnapshot | null {
    const row = this.db.prepare(
      'SELECT * FROM daily_metrics WHERE day_utc = ?'
    ).get(dayUtc) as {
      day_utc: string;
      trades_count: number;
      failed_tx_count: number;
      evaluations_count: number;
      signals_generated: number;
      trades_rejected: number;
      total_gas_usd: string;
      total_pnl: string;
      ai_cost_trading: string;
      ai_cost_services: string;
      ai_cost_diagnostics: string;
      safe_mode_events: number;
      alerts_sent: number;
    } | undefined;

    if (!row) {
      return null;
    }

    return {
      dayUtc: row.day_utc,
      tradesCount: row.trades_count,
      failedTxCount: row.failed_tx_count,
      evaluationsCount: row.evaluations_count,
      signalsGenerated: row.signals_generated,
      tradesRejected: row.trades_rejected,
      totalGasUsd: parseFloat(row.total_gas_usd) || 0,
      totalPnl: parseFloat(row.total_pnl) || 0,
      aiCostTrading: parseFloat(row.ai_cost_trading) || 0,
      aiCostServices: parseFloat(row.ai_cost_services) || 0,
      aiCostDiagnostics: parseFloat(row.ai_cost_diagnostics) || 0,
      aiCostResearch: 0, // Historical research not tracked separately in DB
      safeModeEvents: row.safe_mode_events,
      alertsSent: row.alerts_sent,
    };
  }

  /**
   * Get trades count for current day (used by risk limits).
   */
  getTradesCountToday(): number {
    this.ensureCurrentDay();
    const row = this.db.prepare(
      'SELECT trades_count FROM daily_metrics WHERE day_utc = ?'
    ).get(this.currentDayUtc) as { trades_count: number } | undefined;
    return row?.trades_count ?? 0;
  }

  /**
   * Get failed tx count for current day (used by risk limits).
   */
  getFailedTxCountToday(): number {
    this.ensureCurrentDay();
    const row = this.db.prepare(
      'SELECT failed_tx_count FROM daily_metrics WHERE day_utc = ?'
    ).get(this.currentDayUtc) as { failed_tx_count: number } | undefined;
    return row?.failed_tx_count ?? 0;
  }
}
