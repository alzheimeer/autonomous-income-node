/**
 * Categorizer — Priority assignment (P1-P4), status transitions, and master_log.md management.
 *
 * Status flow:
 * new → activa → profundización → pendiente_aprobacion → aprobada → implementada
 *                                                      → descartada (razón)
 *     → descartada (score < 50)
 *
 * Priority Assignment Rules:
 * - Contains "agent", "A2A", "marketplace", "service" → P1
 * - Contains "browser", "automation", "RPA", "bot" → P2
 * - Contains "youtube", "tiktok", "content", "video" → P3
 * - Contains "trading", "yield", "arb", "DeFi", "perps" → P4
 * - Other → classify via LLM (fallback to category-based assignment)
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  RawOpportunity,
  ScoredOpportunity,
  Priority,
  OpportunityStatus,
} from './comms/protocol.js';
import type { ResearchDatabase } from './state/database.js';

// ── Priority keywords for rule-based assignment ────────────────────────────

const PRIORITY_KEYWORDS: Record<Priority, string[]> = {
  P1: ['agent', 'a2a', 'marketplace', 'service', 'swarms', 'horizen', 'near ai', 'okx ai'],
  P2: ['browser', 'automation', 'rpa', 'bot', 'puppeteer', 'playwright', 'selenium', 'scraper'],
  P3: ['youtube', 'tiktok', 'content', 'video', 'faceless', 'shorts', 'reels', 'creator'],
  P4: ['trading', 'yield', 'arb', 'defi', 'perps', 'perpetual', 'dex', 'amm', 'lending', 'aave', 'uniswap'],
};

// ── Valid status transitions ───────────────────────────────────────────────

const VALID_TRANSITIONS: Record<OpportunityStatus, OpportunityStatus[]> = {
  new: ['activa', 'descartada'],
  activa: ['profundización', 'pendiente_aprobacion', 'descartada', 'code_generated'],
  profundización: ['activa', 'pendiente_aprobacion', 'descartada'],
  pendiente_aprobacion: ['aprobada', 'descartada'],
  aprobada: ['code_generated', 'implementada', 'descartada'],
  code_generated: ['revenue_tracking', 'failed_no_revenue', 'descartada'],
  revenue_tracking: ['implementada', 'failed_no_revenue'],
  implementada: ['descartada'], // Can be discarded if no longer viable
  failed_no_revenue: ['descartada'],
  descartada: [], // Terminal state
};

// ── DB row type ────────────────────────────────────────────────────────────

interface OpportunityRow {
  id: string;
  title: string;
  source: string;
  category: string;
  priority: string;
  score: number;
  score_viability: number;
  score_risk: number;
  score_capital: number;
  score_automation: number;
  status: string;
  description: string;
  estimated_revenue: string;
  capital_required: string;
  risk_level: string;
  automation_level: string;
  source_url: string | null;
  metadata: string | null;
  reasoning: string | null;
  discovered_at: number;
  last_evaluated_at: number | null;
  status_changed_at: number | null;
  discard_reason: string | null;
}

// ── Categorizer class ──────────────────────────────────────────────────────

export class Categorizer {
  private readonly db: ResearchDatabase;
  private readonly minScoreForAction: number;
  private readonly masterLogPath: string;

  constructor(db: ResearchDatabase, minScoreForAction: number = 70, investigacionDir: string = './investigacion') {
    this.db = db;
    this.minScoreForAction = minScoreForAction;
    this.masterLogPath = join(investigacionDir, 'master_log.md');
  }

  /**
   * Assign priority (P1-P4) based on category, title, and description.
   * Uses rule-based keyword matching first, falls back to category-based assignment.
   */
  assignPriority(category: string, title: string, description: string): Priority {
    const searchText = [category, title, description].join(' ').toLowerCase();

    // Check each priority level in order (P1 is highest priority)
    for (const priority of ['P1', 'P2', 'P3', 'P4'] as Priority[]) {
      const keywords = PRIORITY_KEYWORDS[priority];
      if (keywords.some((kw) => searchText.includes(kw.toLowerCase()))) {
        return priority;
      }
    }

    // Fallback: assign based on category
    switch (category) {
      case 'a2a':
        return 'P1';
      case 'rpa':
        return 'P2';
      case 'content':
        return 'P3';
      case 'trading':
        return 'P4';
      default:
        // Default to P3 (content) for unknown categories
        return 'P3';
    }
  }

  /**
   * Determine status based on score, risk, capital, and priority.
   *
   * Decision logic:
   * - score < 50 → 'descartada'
   * - score >= minScoreForAction AND needs approval → 'pendiente_aprobacion'
   * - score >= minScoreForAction → 'activa'
   * - score >= 50 but < minScoreForAction → 'profundización'
   */
  determineStatus(
    score: number,
    riskScore: number,
    capitalRequired: string,
    priority: Priority,
  ): OpportunityStatus {
    // Low score → discard immediately
    if (score < 50) {
      return 'descartada';
    }

    // Below action threshold → needs more investigation
    if (score < this.minScoreForAction) {
      return 'profundización';
    }

    // High enough score → check if approval needed
    const needsApproval = this.requiresApproval(priority, riskScore, capitalRequired);
    
    if (needsApproval) {
      return 'pendiente_aprobacion';
    }

    return 'activa';
  }

  /**
   * Check if a status transition is valid.
   */
  isValidTransition(currentStatus: OpportunityStatus, newStatus: OpportunityStatus): boolean {
    const allowed = VALID_TRANSITIONS[currentStatus];
    return allowed?.includes(newStatus) ?? false;
  }

  /**
   * Transition the status of an opportunity.
   * Validates the transition and updates the database.
   */
  transitionStatus(opportunityId: string, newStatus: OpportunityStatus, reason?: string): void {
    // Get current status
    const row = this.db.get<{ status: string }>(
      'SELECT status FROM opportunities WHERE id = ?',
      opportunityId,
    );

    if (!row) {
      console.warn(`[Categorizer] Opportunity not found: ${opportunityId}`);
      return;
    }

    const currentStatus = row.status as OpportunityStatus;

    // Validate transition
    if (!this.isValidTransition(currentStatus, newStatus)) {
      console.warn(
        `[Categorizer] Invalid status transition: ${currentStatus} → ${newStatus} (allowed: ${VALID_TRANSITIONS[currentStatus]?.join(', ') || 'none'})`,
      );
      return;
    }

    const now = Date.now();

    // Update the opportunity
    if (newStatus === 'descartada' && reason) {
      this.db.run(
        `UPDATE opportunities 
         SET status = ?, status_changed_at = ?, discard_reason = ?
         WHERE id = ?`,
        newStatus,
        now,
        reason,
        opportunityId,
      );
    } else {
      this.db.run(
        `UPDATE opportunities 
         SET status = ?, status_changed_at = ?
         WHERE id = ?`,
        newStatus,
        now,
        opportunityId,
      );
    }

    console.log(
      `[Categorizer] Status updated: ${opportunityId.slice(0, 8)}... ${currentStatus} → ${newStatus}${reason ? ` (${reason})` : ''}`,
    );
  }

  /**
   * Alias for transitionStatus for backwards compatibility.
   */
  async updateStatus(
    opportunityId: string,
    newStatus: OpportunityStatus,
    reason?: string,
  ): Promise<void> {
    this.transitionStatus(opportunityId, newStatus, reason);
  }

  /**
   * Generate and write the master_log.md file from the database.
   * This is regenerated each cycle for consistency.
   *
   * Format includes:
   * - Opportunity ID, title, source
   * - Priority_Category, Viability_Score
   * - Status, discovery timestamp, last-updated timestamp
   * - Discard reason (if applicable)
   */
  generateMasterLog(): void {
    // Fetch all opportunities ordered by score descending, then by discovered_at
    const rows = this.db.all<OpportunityRow>(
      `SELECT * FROM opportunities 
       ORDER BY score DESC, discovered_at DESC`,
    );

    // Group by status for better organization
    const byStatus = this.groupByStatus(rows);

    // Build markdown content
    const content = this.buildMasterLogContent(byStatus);

    // Ensure directory exists
    try {
      mkdirSync(dirname(this.masterLogPath), { recursive: true });
    } catch {
      // Directory may already exist
    }

    // Write the file synchronously
    writeFileSync(this.masterLogPath, content, 'utf-8');

    console.log(`[Categorizer] Master log updated: ${rows.length} opportunities`);
  }

  /**
   * Alias for generateMasterLog for async compatibility.
   */
  async updateMasterLog(): Promise<void> {
    this.generateMasterLog();
  }

  /**
   * Check if an opportunity requires human approval.
   * Conditions:
   * - Any P4 (trading) strategy
   * - Any opportunity with risk dimension < 40 (high risk, since 100 = safe)
   * - Capital required > $20 USDC
   */
  requiresApproval(priority: Priority, riskScore: number, capitalRequired: string): boolean {
    // P4 (trading) always requires approval
    if (priority === 'P4') {
      return true;
    }

    // High risk (risk score < 40 means risky since 100 = safe)
    if (riskScore < 40) {
      return true;
    }

    // High capital requirement
    const capitalMatch = capitalRequired.match(/\$?([\d.]+)/);
    if (capitalMatch) {
      const capital = parseFloat(capitalMatch[1]);
      if (capital > 20) {
        return true;
      }
    }

    return false;
  }

  /**
   * Group opportunities by status for organized display.
   */
  private groupByStatus(rows: OpportunityRow[]): Map<string, OpportunityRow[]> {
    const grouped = new Map<string, OpportunityRow[]>();

    // Define display order for statuses
    const statusOrder: OpportunityStatus[] = [
      'implementada',
      'revenue_tracking',
      'code_generated',
      'aprobada',
      'pendiente_aprobacion',
      'activa',
      'profundización',
      'failed_no_revenue',
      'descartada',
      'new',
    ];

    // Initialize empty arrays for each status
    for (const status of statusOrder) {
      grouped.set(status, []);
    }

    // Group rows
    for (const row of rows) {
      const list = grouped.get(row.status) ?? [];
      list.push(row);
      grouped.set(row.status, list);
    }

    return grouped;
  }

  /**
   * Build the markdown content for master_log.md.
   */
  private buildMasterLogContent(byStatus: Map<string, OpportunityRow[]>): string {
    const lines: string[] = [];

    // Header
    lines.push('# 📊 Research Master Log');
    lines.push('');
    lines.push(`*Última actualización: ${new Date().toISOString()}*`);
    lines.push('');

    // Summary stats
    const total = Array.from(byStatus.values()).reduce((sum, arr) => sum + arr.length, 0);
    const activeCount = (byStatus.get('activa')?.length ?? 0) +
      (byStatus.get('aprobada')?.length ?? 0) +
      (byStatus.get('pendiente_aprobacion')?.length ?? 0);
    const implementedCount = byStatus.get('implementada')?.length ?? 0;
    const discardedCount = byStatus.get('descartada')?.length ?? 0;

    lines.push('## 📈 Resumen');
    lines.push('');
    lines.push(`| Métrica | Valor |`);
    lines.push(`|---------|-------|`);
    lines.push(`| Total oportunidades | ${total} |`);
    lines.push(`| Activas/En progreso | ${activeCount} |`);
    lines.push(`| Implementadas | ${implementedCount} |`);
    lines.push(`| Descartadas | ${discardedCount} |`);
    lines.push('');

    // Status emoji mapping
    const statusEmoji: Record<string, string> = {
      implementada: '✅',
      revenue_tracking: '📈',
      code_generated: '🔧',
      aprobada: '👍',
      pendiente_aprobacion: '⏳',
      activa: '🔍',
      profundización: '🔬',
      failed_no_revenue: '📉',
      descartada: '❌',
      new: '🆕',
    };

    const statusNames: Record<string, string> = {
      implementada: 'Implementadas',
      revenue_tracking: 'Monitoreando Revenue',
      code_generated: 'Código Generado',
      aprobada: 'Aprobadas',
      pendiente_aprobacion: 'Pendientes de Aprobación',
      activa: 'Activas',
      profundización: 'En Profundización',
      failed_no_revenue: 'Sin Revenue (Fallidas)',
      descartada: 'Descartadas',
      new: 'Nuevas',
    };

    // Add sections for each status that has entries
    for (const [status, rows] of byStatus) {
      if (rows.length === 0) continue;

      const emoji = statusEmoji[status] ?? '📋';
      const name = statusNames[status] ?? status;

      lines.push(`## ${emoji} ${name} (${rows.length})`);
      lines.push('');

      // Table header
      lines.push('| ID | Título | Fuente | Prioridad | Score | Descubierto | Actualizado | Razón |');
      lines.push('|----|--------|--------|-----------|-------|-------------|-------------|-------|');

      // Table rows
      for (const row of rows) {
        const id = row.id.slice(0, 8);
        const title = this.truncate(row.title, 40);
        const source = row.source;
        const priority = row.priority;
        const score = row.score;
        const discovered = this.formatDate(row.discovered_at);
        const updated = row.status_changed_at ? this.formatDate(row.status_changed_at) : '-';
        const reason = row.discard_reason ? this.truncate(row.discard_reason, 30) : '-';

        lines.push(`| ${id} | ${title} | ${source} | ${priority} | ${score} | ${discovered} | ${updated} | ${reason} |`);
      }

      lines.push('');
    }

    // Footer with legend
    lines.push('---');
    lines.push('');
    lines.push('### Leyenda de Prioridades');
    lines.push('');
    lines.push('- **P1**: A2A agent marketplaces (máxima prioridad)');
    lines.push('- **P2**: RPA/Browser automation');
    lines.push('- **P3**: Content generation (YouTube/TikTok)');
    lines.push('- **P4**: Trading/DeFi (requiere aprobación)');
    lines.push('');
    lines.push('### Estados');
    lines.push('');
    lines.push('- ✅ **Implementada**: Generando revenue');
    lines.push('- 📈 **Revenue Tracking**: Monitoreando por 7 días');
    lines.push('- 🔧 **Code Generated**: Código aceptado, sin revenue aún');
    lines.push('- 👍 **Aprobada**: Lista para implementar');
    lines.push('- ⏳ **Pendiente Aprobación**: Esperando confirmación humana');
    lines.push('- 🔍 **Activa**: En investigación activa');
    lines.push('- 🔬 **Profundización**: Requiere más análisis');
    lines.push('- 📉 **Sin Revenue**: No generó revenue tras 7 días');
    lines.push('- ❌ **Descartada**: No viable');

    return lines.join('\n');
  }

  /**
   * Truncate a string to max length with ellipsis.
   */
  private truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength - 3) + '...';
  }

  /**
   * Format a Unix timestamp as YYYY-MM-DD.
   */
  private formatDate(timestamp: number): string {
    return new Date(timestamp).toISOString().split('T')[0];
  }

  /**
   * Get all opportunities with a specific status.
   */
  getByStatus(status: OpportunityStatus): ScoredOpportunity[] {
    const rows = this.db.all<OpportunityRow>(
      'SELECT * FROM opportunities WHERE status = ? ORDER BY score DESC',
      status,
    );
    return rows.map((row) => this.rowToScoredOpportunity(row));
  }

  /**
   * Get opportunities pending approval (P4 or high-risk).
   */
  getPendingApproval(): ScoredOpportunity[] {
    return this.getByStatus('pendiente_aprobacion');
  }

  /**
   * Get active opportunities ready for implementation.
   */
  getActiveOpportunities(): ScoredOpportunity[] {
    const rows = this.db.all<OpportunityRow>(
      `SELECT * FROM opportunities 
       WHERE status IN ('activa', 'aprobada') 
       ORDER BY 
         CASE priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
         score DESC`,
    );
    return rows.map((row) => this.rowToScoredOpportunity(row));
  }

  /**
   * Convert a database row to a ScoredOpportunity.
   */
  private rowToScoredOpportunity(row: OpportunityRow): ScoredOpportunity {
    let metadata: Record<string, unknown> = {};
    try {
      if (row.metadata) {
        metadata = JSON.parse(row.metadata);
      }
    } catch {
      // Ignore JSON parse errors
    }

    return {
      id: row.id,
      title: row.title,
      source: row.source,
      category: row.category as RawOpportunity['category'],
      priority: row.priority as Priority,
      score: row.score,
      dimensions: {
        viability: row.score_viability,
        risk: row.score_risk,
        capital: row.score_capital,
        automation: row.score_automation,
      },
      status: row.status as OpportunityStatus,
      description: row.description,
      estimatedRevenue: row.estimated_revenue,
      capitalRequired: row.capital_required,
      riskLevel: row.risk_level as RawOpportunity['riskLevel'],
      automationLevel: row.automation_level as RawOpportunity['automationLevel'],
      sourceUrl: row.source_url ?? undefined,
      metadata,
      reasoning: row.reasoning ?? '',
      discoveredAt: row.discovered_at,
      lastEvaluatedAt: row.last_evaluated_at ?? row.discovered_at,
      statusChangedAt: row.status_changed_at ?? undefined,
    };
  }

  /**
   * Bulk update: Set status to 'descartada' for opportunities with score below threshold.
   * Useful for cleanup after re-scoring.
   */
  discardLowScoreOpportunities(threshold: number = 50): number {
    const now = Date.now();

    const result = this.db.run(
      `UPDATE opportunities 
       SET status = 'descartada', status_changed_at = ?, discard_reason = ?
       WHERE score < ? AND status NOT IN ('descartada', 'implementada')`,
      now,
      `score below ${threshold}`,
      threshold,
    );

    if (result.changes > 0) {
      console.log(`[Categorizer] Discarded ${result.changes} opportunities with score < ${threshold}`);
    }

    return result.changes;
  }

  /**
   * Get statistics about opportunities by status and priority.
   */
  getStats(): {
    byStatus: Record<string, number>;
    byPriority: Record<string, number>;
    total: number;
    avgScore: number;
  } {
    const byStatus: Record<string, number> = {};
    const statusRows = this.db.all<{ status: string; count: number }>(
      'SELECT status, COUNT(*) as count FROM opportunities GROUP BY status',
    );
    for (const row of statusRows) {
      byStatus[row.status] = row.count;
    }

    const byPriority: Record<string, number> = {};
    const priorityRows = this.db.all<{ priority: string; count: number }>(
      'SELECT priority, COUNT(*) as count FROM opportunities GROUP BY priority',
    );
    for (const row of priorityRows) {
      byPriority[row.priority] = row.count;
    }

    const statsRow = this.db.get<{ total: number; avg_score: number }>(
      'SELECT COUNT(*) as total, AVG(score) as avg_score FROM opportunities',
    );

    return {
      byStatus,
      byPriority,
      total: statsRow?.total ?? 0,
      avgScore: Math.round(statsRow?.avg_score ?? 0),
    };
  }
}
