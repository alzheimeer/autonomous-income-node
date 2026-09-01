/**
 * Unit tests for DailyMetricsManager, AI budget tracking, alerts, and secret redaction.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DailyMetricsManager,
  redactSecrets,
  selectLlmModel,
  type IDailyMetricsDb,
  type ISafeModeForMetrics,
  type IAlertSender,
  type IBackupTrigger,
  type AiCostCategory,
  type AlertSeverity,
  type LlmModelTier,
} from './daily-metrics.js';
import type { AiBudgetConfig, AlertsConfig } from './config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

function createMockDb(): IDailyMetricsDb {
  const store: Record<string, Record<string, unknown>> = {};
  const eventLog: Array<Record<string, unknown>> = [];

  return {
    prepare(sql: string) {
      return {
        run(...params: unknown[]) {
          if (sql.includes('INSERT OR IGNORE INTO daily_metrics')) {
            const day = params[0] as string;
            if (!store[day]) {
              store[day] = {
                day_utc: day,
                trades_count: 0,
                failed_tx_count: 0,
                evaluations_count: 0,
                signals_generated: 0,
                trades_rejected: 0,
                total_gas_usd: '0',
                total_pnl: '0',
                ai_cost_trading: '0',
                ai_cost_services: '0',
                ai_cost_diagnostics: '0',
                safe_mode_events: 0,
                alerts_sent: 0,
              };
            }
          } else if (sql.includes('UPDATE daily_metrics SET trades_count')) {
            const day = params[0] as string;
            if (store[day]) (store[day].trades_count as number)++;
          } else if (sql.includes('UPDATE daily_metrics SET failed_tx_count')) {
            const day = params[0] as string;
            if (store[day]) (store[day].failed_tx_count as number)++;
          } else if (sql.includes('UPDATE daily_metrics SET evaluations_count')) {
            const day = params[0] as string;
            if (store[day]) (store[day].evaluations_count as number)++;
          } else if (sql.includes('UPDATE daily_metrics SET signals_generated')) {
            const day = params[0] as string;
            if (store[day]) (store[day].signals_generated as number)++;
          } else if (sql.includes('UPDATE daily_metrics SET trades_rejected')) {
            const day = params[0] as string;
            if (store[day]) (store[day].trades_rejected as number)++;
          } else if (sql.includes('UPDATE daily_metrics SET total_gas_usd')) {
            const day = params[1] as string;
            if (store[day]) {
              const current = parseFloat(store[day].total_gas_usd as string) || 0;
              store[day].total_gas_usd = String(current + (params[0] as number));
            }
          } else if (sql.includes('UPDATE daily_metrics SET total_pnl')) {
            const day = params[1] as string;
            if (store[day]) {
              const current = parseFloat(store[day].total_pnl as string) || 0;
              store[day].total_pnl = String(current + (params[0] as number));
            }
          } else if (sql.includes('UPDATE daily_metrics SET safe_mode_events')) {
            const day = params[0] as string;
            if (store[day]) (store[day].safe_mode_events as number)++;
          } else if (sql.includes('UPDATE daily_metrics SET alerts_sent')) {
            const day = params[0] as string;
            if (store[day]) (store[day].alerts_sent as number)++;
          } else if (sql.includes('UPDATE daily_metrics SET ai_cost_trading')) {
            const day = params[1] as string;
            if (store[day]) {
              const current = parseFloat(store[day].ai_cost_trading as string) || 0;
              store[day].ai_cost_trading = String(current + (params[0] as number));
            }
          } else if (sql.includes('UPDATE daily_metrics SET ai_cost_services')) {
            const day = params[1] as string;
            if (store[day]) {
              const current = parseFloat(store[day].ai_cost_services as string) || 0;
              store[day].ai_cost_services = String(current + (params[0] as number));
            }
          } else if (sql.includes('UPDATE daily_metrics SET ai_cost_diagnostics')) {
            const day = params[1] as string;
            if (store[day]) {
              const current = parseFloat(store[day].ai_cost_diagnostics as string) || 0;
              store[day].ai_cost_diagnostics = String(current + (params[0] as number));
            }
          } else if (sql.includes('INSERT INTO event_log')) {
            eventLog.push({ event_type: params[0], details: params[1], timestamp: params[2] });
          }
          return {};
        },
        get(...params: unknown[]) {
          if (sql.includes('FROM daily_metrics')) {
            const day = params[0] as string;
            return store[day] ?? undefined;
          }
          return undefined;
        },
        all() {
          return Object.values(store);
        },
      };
    },
  };
}

function createDefaultAiBudgetConfig(): AiBudgetConfig {
  return {
    globalHardCapDay: 0.20,
    tradingBudgetDay: 0.10,
    servicesBudgetDay: 0.05,
    researchBudgetDay: 0.00,
    diagnosticsBudgetDay: 0.02,
    sonnetMinProfit: 150000n, // $0.15
  };
}

function createDefaultAlertsConfig(): AlertsConfig {
  return {
    telegramChatId: '12345',
    nonCriticalMaxPerHour: 10,
    deviationThresholdPct: 0.50,
    deviationThresholdUsdc: 30000n,
    consecutiveDeviationsForSafe: 3,
  };
}

function createMockSafeModeController(): ISafeModeForMetrics {
  let state = 'normal';
  return {
    enterLowCostMode() { state = 'low_cost_mode'; },
    exitLowCostMode() { state = 'normal'; },
    getState() { return { state }; },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Secret Redaction Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('redactSecrets', () => {
  it('redacts private keys (0x + 64 hex chars)', () => {
    const input = 'Key: 0x' + 'a'.repeat(64);
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('a'.repeat(64));
  });

  it('redacts API key patterns', () => {
    const input = 'api_key=dummy_key_abc123456789012345678901';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED]');
  });

  it('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED]');
  });

  it('redacts Telegram bot tokens', () => {
    const input = 'Token: 1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED]');
  });

  it('redacts env var patterns with sensitive names', () => {
    const input = 'PRIVATE_KEY=0xdeadbeef1234';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED]');
  });

  it('does not redact normal text', () => {
    const input = 'Trade executed at price 2500.50 USDC';
    const result = redactSecrets(input);
    expect(result).toBe(input);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LLM Model Selection Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('selectLlmModel', () => {
  it('returns "none" for exits regardless of profit', () => {
    expect(selectLlmModel(500000n, true, false)).toBe('none');
    expect(selectLlmModel(200000n, true, false)).toBe('none');
  });

  it('returns "none" when budget is exceeded', () => {
    expect(selectLlmModel(500000n, false, true)).toBe('none');
  });

  it('returns "sonnet" when profit > $0.15', () => {
    // $0.16 = 160000 (6 decimals)
    expect(selectLlmModel(160000n, false, false)).toBe('sonnet');
    expect(selectLlmModel(200000n, false, false)).toBe('sonnet');
  });

  it('returns "haiku" for profit $0.08-$0.15', () => {
    expect(selectLlmModel(80000n, false, false)).toBe('haiku');
    expect(selectLlmModel(100000n, false, false)).toBe('haiku');
    expect(selectLlmModel(150000n, false, false)).toBe('haiku');
  });

  it('returns "none" for profit < $0.08', () => {
    expect(selectLlmModel(70000n, false, false)).toBe('none');
    expect(selectLlmModel(0n, false, false)).toBe('none');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DailyMetricsManager Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('DailyMetricsManager', () => {
  let manager: DailyMetricsManager;
  let db: IDailyMetricsDb;
  let safeModeController: ISafeModeForMetrics;
  let alertSender: IAlertSender;

  beforeEach(() => {
    db = createMockDb();
    safeModeController = createMockSafeModeController();
    alertSender = {
      sendTelegramAlert: vi.fn().mockResolvedValue(undefined),
    };

    manager = new DailyMetricsManager({
      db,
      aiBudgetConfig: createDefaultAiBudgetConfig(),
      alertsConfig: createDefaultAlertsConfig(),
      safeModeController,
      alertSender,
    });
  });

  describe('metric recording', () => {
    it('records trades count', () => {
      manager.recordTrade();
      manager.recordTrade();
      expect(manager.getTradesCountToday()).toBe(2);
    });

    it('records failed transactions', () => {
      manager.recordFailedTx();
      expect(manager.getFailedTxCountToday()).toBe(1);
    });

    it('records evaluations', () => {
      manager.recordEvaluation();
      const metrics = manager.getMetrics();
      expect(metrics.evaluationsCount).toBe(1);
    });

    it('records gas expenditure', () => {
      manager.recordGas(0.03);
      manager.recordGas(0.02);
      const metrics = manager.getMetrics();
      expect(metrics.totalGasUsd).toBeCloseTo(0.05);
    });

    it('records P&L (positive and negative)', () => {
      manager.recordPnl(0.15);
      manager.recordPnl(-0.05);
      const metrics = manager.getMetrics();
      expect(metrics.totalPnl).toBeCloseTo(0.10);
    });
  });

  describe('AI budget enforcement', () => {
    it('allows calls within budget', () => {
      expect(manager.canMakeAiCall('trading', 0.05)).toBe(true);
      expect(manager.canMakeAiCall('services', 0.03)).toBe(true);
      expect(manager.canMakeAiCall('diagnostics', 0.01)).toBe(true);
    });

    it('blocks research calls (budget=$0.00)', () => {
      expect(manager.canMakeAiCall('research', 0.001)).toBe(false);
    });

    it('triggers LowCostMode when trading budget exceeded', () => {
      manager.recordAiCost({
        timestamp: Date.now(),
        category: 'trading',
        model: 'haiku',
        cost: 0.11,
        purpose: 'test',
        decisionImpact: 'test',
      });

      expect(safeModeController.getState().state).toBe('low_cost_mode');
    });

    it('blocks calls when global cap exceeded', () => {
      // Spend up to global cap
      manager.recordAiCost({
        timestamp: Date.now(),
        category: 'trading',
        model: 'haiku',
        cost: 0.10,
        purpose: 'test',
        decisionImpact: 'test',
      });
      manager.recordAiCost({
        timestamp: Date.now(),
        category: 'services',
        model: 'haiku',
        cost: 0.05,
        purpose: 'test',
        decisionImpact: 'test',
      });
      manager.recordAiCost({
        timestamp: Date.now(),
        category: 'diagnostics',
        model: 'haiku',
        cost: 0.05,
        purpose: 'test',
        decisionImpact: 'test',
      });

      // Now at $0.20 — global cap
      expect(manager.canMakeAiCall('trading', 0.01)).toBe(false);
      expect(manager.canMakeAiCall('services', 0.01)).toBe(false);
      expect(manager.canMakeAiCall('diagnostics', 0.01)).toBe(false);
    });

    it('provides accurate budget status', () => {
      manager.recordAiCost({
        timestamp: Date.now(),
        category: 'trading',
        model: 'haiku',
        cost: 0.06,
        purpose: 'test',
        decisionImpact: 'test',
      });

      const status = manager.getAiBudgetStatus();
      expect(status.tradingSpent).toBeCloseTo(0.06);
      expect(status.tradingRemaining).toBeCloseTo(0.04);
      expect(status.tradingExceeded).toBe(false);
      expect(status.globalSpent).toBeCloseTo(0.06);
    });
  });

  describe('alert rate limiting', () => {
    it('sends critical alerts without limit', () => {
      for (let i = 0; i < 20; i++) {
        manager.sendAlert(`Critical alert ${i}`, 'critical');
      }
      // All 20 should have been sent
      expect(alertSender.sendTelegramAlert).toHaveBeenCalledTimes(20);
    });

    it('rate limits non-critical alerts to 10/hour', () => {
      for (let i = 0; i < 15; i++) {
        manager.sendAlert(`Non-critical ${i}`, 'non_critical');
      }
      // Only 10 should have been sent
      expect(alertSender.sendTelegramAlert).toHaveBeenCalledTimes(10);
    });

    it('redacts secrets in alert messages', () => {
      const secretMsg = 'Error with key 0x' + 'f'.repeat(64);
      manager.sendAlert(secretMsg, 'critical');

      expect(alertSender.sendTelegramAlert).toHaveBeenCalledWith(
        expect.stringContaining('[REDACTED]'),
        'critical',
      );
      expect(alertSender.sendTelegramAlert).not.toHaveBeenCalledWith(
        expect.stringContaining('f'.repeat(64)),
        expect.anything(),
      );
    });
  });

  describe('daily backup trigger', () => {
    it('triggers backup callback when provided', () => {
      const backupTrigger: IBackupTrigger = {
        triggerDailyBackup: vi.fn().mockResolvedValue(undefined),
      };

      const managerWithBackup = new DailyMetricsManager({
        db,
        aiBudgetConfig: createDefaultAiBudgetConfig(),
        alertsConfig: createDefaultAlertsConfig(),
        safeModeController,
        backupTrigger,
      });

      managerWithBackup.triggerBackupManual();
      expect(backupTrigger.triggerDailyBackup).toHaveBeenCalled();
    });
  });

  describe('getMetrics snapshot', () => {
    it('returns complete metrics snapshot', () => {
      manager.recordTrade();
      manager.recordFailedTx();
      manager.recordEvaluation();
      manager.recordSignal();
      manager.recordTradeRejected();
      manager.recordGas(0.04);
      manager.recordPnl(0.12);
      manager.recordSafeModeEvent();

      const metrics = manager.getMetrics();
      expect(metrics.tradesCount).toBe(1);
      expect(metrics.failedTxCount).toBe(1);
      expect(metrics.evaluationsCount).toBe(1);
      expect(metrics.signalsGenerated).toBe(1);
      expect(metrics.tradesRejected).toBe(1);
      expect(metrics.totalGasUsd).toBeCloseTo(0.04);
      expect(metrics.totalPnl).toBeCloseTo(0.12);
      expect(metrics.safeModeEvents).toBe(1);
    });
  });
});
