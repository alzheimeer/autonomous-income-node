/**
 * Strategy Evolution Lab — Evolution Report
 *
 * Generates structured cycle reports in both Markdown and JSON formats.
 * Saves reports to `reports/evolution/` with timestamp-based filenames.
 *
 * Includes:
 *   - Strategy landscape (count per status)
 *   - Top performers (by score)
 *   - Diagnoses found during the cycle
 *   - Next recommended actions
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvolutionDatabase } from './evolution-database.js';
import type { ExperimentMetrics } from './types.js';
import { VALID_STATUSES } from './types.js';
import type { DiagnosisResult } from './diagnosis-engine.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface CycleReport {
  timestamp: string;
  strategies_evaluated: number;
  diagnoses_found: DiagnosisResult[];
  variants_generated: number;
  backtest_results: { passed: number; failed: number };
  promotions: string[];
  demotions: string[];
  strategy_landscape: Record<string, number>;
  top_performers: { strategy_id: string; score: number; metrics: ExperimentMetrics }[];
  next_actions: string[];
}

// ─── Report Generator ───────────────────────────────────────────────────────

export class EvolutionReport {
  constructor(private db: EvolutionDatabase) {}

  /**
   * Generate formatted report output from a CycleReport data object.
   * Returns both Markdown and JSON string representations.
   */
  generateCycleReport(cycleData: CycleReport): { markdown: string; json: string } {
    const markdown = this.formatMarkdown(cycleData);
    const json = JSON.stringify(cycleData, null, 2);
    return { markdown, json };
  }

  /**
   * Save a formatted report to disk under `outputDir` with timestamp-based filenames.
   * Creates the output directory if it does not exist.
   * Returns the base path (without extension) of the saved files.
   */
  saveReport(
    report: { markdown: string; json: string },
    outputDir: string = 'reports/evolution',
  ): string {
    mkdirSync(outputDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = `cycle_${ts}`;
    writeFileSync(join(outputDir, `${baseName}.md`), report.markdown, 'utf-8');
    writeFileSync(join(outputDir, `${baseName}.json`), report.json, 'utf-8');
    return join(outputDir, baseName);
  }

  /**
   * Get strategy landscape (count per status) from the database.
   */
  getStrategyLandscape(): Record<string, number> {
    const all = this.db.getAllStrategies();
    const landscape: Record<string, number> = {};
    for (const status of VALID_STATUSES) {
      landscape[status] = 0;
    }
    for (const s of all) {
      landscape[s.status] = (landscape[s.status] || 0) + 1;
    }
    return landscape;
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private formatMarkdown(data: CycleReport): string {
    const lines: string[] = [
      `# Evolution Cycle Report`,
      ``,
      `**Timestamp:** ${data.timestamp}`,
      ``,
      `## Summary`,
      `- Strategies evaluated: ${data.strategies_evaluated}`,
      `- Diagnoses found: ${data.diagnoses_found.length}`,
      `- Variants generated: ${data.variants_generated}`,
      `- Backtest results: ${data.backtest_results.passed} passed, ${data.backtest_results.failed} failed`,
      `- Promotions: ${data.promotions.length}`,
      `- Demotions: ${data.demotions.length}`,
      ``,
      `## Strategy Landscape`,
    ];

    for (const [status, count] of Object.entries(data.strategy_landscape)) {
      if (count > 0) {
        lines.push(`- ${status}: ${count}`);
      }
    }

    lines.push('', '## Top Performers');
    for (const p of data.top_performers.slice(0, 5)) {
      lines.push(
        `- ${p.strategy_id} (score: ${p.score.toFixed(2)}, PF: ${p.metrics.profit_factor.toFixed(2)})`,
      );
    }

    lines.push('', '## Diagnoses');
    for (const d of data.diagnoses_found) {
      lines.push(`- **${d.code}** (confidence: ${d.confidence.toFixed(2)}): ${d.description}`);
    }

    lines.push('', '## Next Actions');
    for (const a of data.next_actions) {
      lines.push(`- ${a}`);
    }

    lines.push('');
    return lines.join('\n');
  }
}
