/**
 * DailyReport — Sends a daily summary via Telegram at configurable hour.
 *
 * Collects metrics from all subsystems and formats a comprehensive
 * report including balance, yield, trades, LLM costs, and health status.
 *
 * Uses existing TelegramClient pattern. Triggered by setInterval
 * checking if it's the report hour (default: 23:00).
 */

import { TelegramClient } from '../social/telegram-client.js';
import { getPipelineTelegramSummary } from '../pipeline-metrics/index.js';
import type { MetricsDatabase } from '../pipeline-metrics/index.js';
import type { MetricsRecorder } from '../shared/index.js';
import type { AdaptiveEvolver } from '../intelligence/adaptive-evolver.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

export interface DailyReportConfig {
  /** Hours to send the report (0-23). Default: [23] (11pm local) */
  reportHours: number[];
  /** Check interval in ms. Default: 60_000 (1 minute) */
  checkIntervalMs: number;
  /** Whether daily reports are enabled. Default: true */
  enabled: boolean;
}

export const DEFAULT_DAILY_REPORT_CONFIG: DailyReportConfig = {
  reportHours: [6, 13, 23], // 6am, 1pm, 11pm Colombia
  checkIntervalMs: 60_000,
  enabled: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Metrics interface — populated by AgentCore
// ═══════════════════════════════════════════════════════════════════════════════

export interface DailyMetrics {
  /** Total USDC balance (wallet + protocols) in 6-decimal bigint */
  totalBalanceUsdc: bigint;
  /** Wallet USDC balance */
  walletBalanceUsdc: bigint;
  /** Aave deposited amount */
  aaveBalanceUsdc: bigint;
  /** Aave yield earned today */
  aaveYieldToday: bigint;
  /** Number of trades executed today */
  tradesExecuted: number;
  /** Number of signals rejected (by risk manager, kill-switch, etc.) */
  signalsRejected: number;
  /** Total LLM cycles today */
  llmCycles: number;
  /** LLM cache hits today */
  cacheHits: number;
  /** ModelRouter triage skips (Haiku said 'wait') */
  triageSkips: number;
  /** Estimated API cost in cents */
  estimatedCostCents: number;
  /** Research opportunities found */
  opportunitiesFound: number;
  /** Actionable opportunities (passed all filters) */
  actionableOpportunities: number;
  /** System health status */
  healthStatus: 'healthy' | 'degraded' | 'critical';
  /** Optional degradation reason */
  degradationReason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DailyReport service
// ═══════════════════════════════════════════════════════════════════════════════

export class DailyReport {
  private readonly config: DailyReportConfig;
  private readonly telegramClient: TelegramClient;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sentReports: Set<string> = new Set(); // tracks "YYYY-MM-DD-HH" to avoid duplicates
  private metricsProvider: (() => DailyMetrics) | null = null;
  private metricsDb: MetricsDatabase | null = null;
  private currentRegime: string = 'UNKNOWN';
  private sniperRecorder: MetricsRecorder | null = null;
  private adaptiveEvolver: AdaptiveEvolver | null = null;

  constructor(config: Partial<DailyReportConfig> & { reportHour?: number } = {}) {
    // Support legacy single-hour config
    const reportHours = config.reportHours ?? (config.reportHour != null ? [config.reportHour] : undefined);
    this.config = { ...DEFAULT_DAILY_REPORT_CONFIG, ...config, ...(reportHours ? { reportHours } : {}) };
    this.telegramClient = new TelegramClient();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Register a function that provides the current daily metrics.
   * This is called when it's time to generate the report.
   */
  setMetricsProvider(provider: () => DailyMetrics): void {
    this.metricsProvider = provider;
  }

  /**
   * Register the pipeline metrics database for inclusion in the daily report.
   * Best-effort: if metricsDb is null or unavailable, the pipeline section is skipped.
   */
  setPipelineMetricsDb(db: MetricsDatabase | null, regime?: string): void {
    this.metricsDb = db;
    if (regime) this.currentRegime = regime;
  }

  /**
   * Register the Hybrid Sniper MetricsRecorder for inclusion in the daily report.
   * Best-effort: if null or unavailable, the sniper section is silently skipped.
   */
  setSniperRecorder(recorder: MetricsRecorder | null): void {
    this.sniperRecorder = recorder;
  }

  /**
   * Register the AdaptiveEvolver for inclusion in the daily report.
   * Best-effort: if null, the evolver section is silently skipped.
   */
  setAdaptiveEvolver(evolver: AdaptiveEvolver | null): void {
    this.adaptiveEvolver = evolver;
  }

  /**
   * Start the timer that checks if it's time to send the daily report.
   */
  start(): void {
    if (!this.config.enabled) {
      console.log('[DailyReport] Disabled — not starting timer');
      return;
    }

    if (this.timer) {
      console.warn('[DailyReport] Already running');
      return;
    }

    this.timer = setInterval(() => {
      void this.checkAndSend();
    }, this.config.checkIntervalMs);

    console.log(`[DailyReport] Started — will send at ${this.config.reportHours.map(h => `${h}:00`).join(', ')} daily`);
  }

  /**
   * Stop the timer.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Force-send a report now (for testing or manual trigger).
   */
  async sendNow(): Promise<void> {
    await this.sendReport();
  }

  /**
   * Whether the service is running.
   */
  isRunning(): boolean {
    return this.timer !== null;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async checkAndSend(): Promise<void> {
    const now = new Date();
    const currentHour = now.getHours();
    const key = `${now.toISOString().slice(0, 10)}-${currentHour}`;

    // Send if current hour is in reportHours and we haven't sent for this hour+day
    if (this.config.reportHours.includes(currentHour) && !this.sentReports.has(key)) {
      this.sentReports.add(key);

      // Clean old entries (keep only last 24 entries)
      if (this.sentReports.size > 24) {
        const entries = [...this.sentReports];
        this.sentReports = new Set(entries.slice(-12));
      }

      await this.sendReport();
    }
  }

  private async sendReport(): Promise<void> {
    try {
      const metrics = this.metricsProvider?.() ?? this.getDefaultMetrics();
      const message = await this.formatReport(metrics);

      const result = await this.telegramClient.sendMessage(message);
      if (result.mockMode) {
        console.log('[DailyReport] Sent (mock mode)');
      } else {
        console.log(`[DailyReport] Sent — message ID: ${result.messageId}`);
      }
    } catch (err) {
      // Never throw — log and continue
      console.error('[DailyReport] Failed to send report:', err);
    }
  }

  private async formatReport(m: DailyMetrics): Promise<string> {
    const fecha = new Date().toISOString().slice(0, 10);
    const total = (Number(m.totalBalanceUsdc) / 1_000_000).toFixed(2);
    const wallet = (Number(m.walletBalanceUsdc) / 1_000_000).toFixed(2);
    const aave = (Number(m.aaveBalanceUsdc) / 1_000_000).toFixed(2);
    const yieldToday = (Number(m.aaveYieldToday) / 1_000_000).toFixed(4);
    const cost = (m.estimatedCostCents / 100).toFixed(3);

    const statusEmoji = m.healthStatus === 'healthy' ? '✅' :
      m.healthStatus === 'degraded' ? '⚠️' : '🚨';

    const statusLine = m.degradationReason
      ? `${statusEmoji} Estado: ${m.healthStatus} — ${m.degradationReason}`
      : `${statusEmoji} Estado: ${m.healthStatus}`;

    const sniperSection = await this.getSniperSection();

    return [
      `📊 <b>INFORME DIARIO</b> — ${fecha}`,
      '',
      `💰 Balance: <b>$${total}</b> USDC`,
      `   Wallet: $${wallet} | Aave: $${aave}`,
      `📈 Yield Aave hoy: +$${yieldToday}`,
      `🔄 Trades ejecutados: ${m.tradesExecuted}`,
      `❌ Señales rechazadas: ${m.signalsRejected}`,
      `🤖 Ciclos LLM: ${m.llmCycles} | Cache hits: ${m.cacheHits} | Triage skips: ${m.triageSkips}`,
      `💸 Costo API estimado: ~$${cost}`,
      `🔬 Research: ${m.opportunitiesFound} oportunidades, ${m.actionableOpportunities} viables`,
      '',
      statusLine,
      this.getPipelineSection(),
      sniperSection,
      this.getEvolverSection(),
    ].join('\n');
  }

  /**
   * Best-effort pipeline metrics section for the daily report.
   * Returns empty string if metricsDb is unavailable or if any error occurs.
   */
  private getPipelineSection(): string {
    if (!this.metricsDb) return '';
    try {
      const summary = getPipelineTelegramSummary(this.metricsDb, this.currentRegime);
      if (!summary || summary.includes('unavailable')) return '';
      return '\n' + summary;
    } catch {
      return '';
    }
  }

  /**
   * Best-effort Hybrid Sniper section for the daily report.
   * Returns empty string if sniperRecorder is unavailable.
   */
  private async getSniperSection(): Promise<string> {
    if (!this.sniperRecorder) return '';
    try {
      const signals = await this.sniperRecorder.getRecentSignals(50);
      const avgLatency = await this.sniperRecorder.getAverageLatency(50);

      // We still parse signals sync since we just got the array
      if (signals.length === 0) {
        return '\n🎯 <b>Hybrid Sniper</b> — 0 señales procesadas hoy';
      }

      const passed = signals.filter(s => s.passed === 1).length;
      const rejected = signals.length - passed;

      // Count rejection reasons
      const reasons: Record<string, number> = {};
      for (const s of signals) {
        if (s.reject_reason) {
          reasons[s.reject_reason] = (reasons[s.reject_reason] ?? 0) + 1;
        }
      }

      const topReason = Object.entries(reasons)
        .sort((a, b) => b[1] - a[1])[0];

      const latencyStr = avgLatency > 0
        ? `${Math.round(avgLatency)}ms`
        : 'N/A';

      const lines = [
        '\n🎯 <b>Hybrid Sniper (Phase 0)</b>',
        `   Señales: ${signals.length} | ✅ Válidas: ${passed} | ❌ Rechazadas: ${rejected}`,
        `   Latencia promedio: ${latencyStr}`,
      ];

      if (topReason) {
        const label: Record<string, string> = {
          HONEYPOT_SELL1_ZERO: 'honeypot (venta 1)',
          HONEYPOT_SELL2_ZERO: 'honeypot (venta 2)',
          SELL_TAX_EXCEEDED: 'impuesto >5%',
          INSUFFICIENT_LIQUIDITY: 'liquidez insuficiente',
          BLACKLISTED: 'blacklist',
          QUOTE_ERROR: 'error de cotización',
          POOL_DETECTION_FAILED: 'pool no detectado',
        };
        lines.push(`   Rechazo más común: ${label[topReason[0]] ?? topReason[0]} (${topReason[1]})`);
      }

      return lines.join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Best-effort AdaptiveEvolver section for the daily report.
   * Shows what the agent auto-implemented or attempted in the last 24h.
   */
  private getEvolverSection(): string {
    if (!this.adaptiveEvolver) return '';
    try {
      const results = this.adaptiveEvolver.getRecentResults(10);
      if (results.length === 0) return '';

      const implemented = results.filter(r => r.status === 'implemented');
      const failed = results.filter(r => r.status === 'failed' || r.status === 'error');
      const rejected = results.filter(r => r.status === 'skipped');

      const lines = ['\n🧠 <b>Auto-Implementación (AdaptiveEvolver)</b>'];

      if (implemented.length > 0) {
        lines.push(`   ✅ Implementados: ${implemented.length}`);
        for (const r of implemented.slice(0, 3)) {
          const file = r.targetFile?.split('/').pop() ?? '';
          lines.push(`      · ${r.title}${file ? ` → ${file}` : ''}`);
        }
      }

      if (failed.length > 0) {
        lines.push(`   ❌ Fallidos: ${failed.length}`);
        for (const r of failed.slice(0, 2)) {
          const reason = r.error?.slice(0, 60) ?? 'sandbox error';
          lines.push(`      · ${r.title}: ${reason}`);
        }
      }

      if (rejected.length > 0) {
        lines.push(`   ⏭ Omitidos (LLM no generó plan): ${rejected.length}`);
      }

      return lines.join('\n');
    } catch {
      return '';
    }
  }

  private getDefaultMetrics(): DailyMetrics {
    return {
      totalBalanceUsdc: 0n,
      walletBalanceUsdc: 0n,
      aaveBalanceUsdc: 0n,
      aaveYieldToday: 0n,
      tradesExecuted: 0,
      signalsRejected: 0,
      llmCycles: 0,
      cacheHits: 0,
      triageSkips: 0,
      estimatedCostCents: 0,
      opportunitiesFound: 0,
      actionableOpportunities: 0,
      healthStatus: 'healthy',
    };
  }
}
