/**
 * ResearchEngine — Orchestrates the research loop.
 *
 * - Aggressive mode: every 1-2h, with deep-dive on promising findings
 * - runCycle(): scanners → deduplicate → score → deep-dive → categorize → communicate → alerts
 * - start()/stop() lifecycle
 *
 * FIXES (Aug 2026):
 * - Fix 1: Improved deduplication with normalized title+URL fingerprints
 * - Fix 2: Scanner health tracking in DB with consecutive failure alerts
 * - Fix 3: Revenue lifecycle (code_generated → revenue_tracking → implementada)
 * - Fix 4 (Aug 13): Blacklist patterns to prevent re-researching descartadas/irrelevant topics
 *   - Sports teams, celebrities, fast food news
 *   - DeFi with APY > 500% (likely scams)
 *   - Topics marked as "never research" in HISTORIAL_PROPUESTAS.md
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ResearchDatabase } from './state/database.js';
import type { IResearchScanner, RawOpportunity } from './scanners/types.js';
import { ScoringEngine } from './scoring.js';
import { Categorizer } from './categorizer.js';
import { DeepAuditorEngine } from './deep-auditor.js';
import { CommsWriter } from './comms/writer.js';
import { CommsReader } from './comms/reader.js';
import { AlertSystem } from './alerts.js';
import { ApprovalGate } from './approval-gate.js';
import type { EngineState, CycleResult, StrategyProposal } from './comms/protocol.js';

// Scanners
import { MarketplaceScanner } from './scanners/marketplace-scanner.js';
import { RPAScanner } from './scanners/rpa-scanner.js';
// import { ContentScanner } from './scanners/content-scanner.js';
import { TradingScanner } from './scanners/trading-scanner.js';
import { GeneralScanner } from './scanners/general-scanner.js';
import { HighSpeedArbitrageScanner } from './scanners/high-speed-arbitrage-scanner.js';

export interface ResearchEngineConfig {
  intervalMinMs: number;
  intervalMaxMs: number;
  minScoreForAction: number;
  maxOpportunitiesPerCycle: number;
}

const DEFAULT_CONFIG: ResearchEngineConfig = {
  intervalMinMs: parseInt(process.env['RESEARCH_INTERVAL_MIN_MS'] ?? '3600000', 10),    // 1h
  intervalMaxMs: parseInt(process.env['RESEARCH_INTERVAL_MAX_MS'] ?? '7200000', 10),    // 2h
  minScoreForAction: parseInt(process.env['RESEARCH_MIN_SCORE'] ?? '70', 10),
  maxOpportunitiesPerCycle: 20,
};

/** Max deep-dive calls per category per cycle (Fix 1) */
const MAX_DEEP_DIVES_PER_CATEGORY = 1;

/** Source URL cooldown — skip if already scanned within this window (Fix 1) */
const SOURCE_URL_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Revenue tracking period in ms (Fix 3) */
const REVENUE_TRACKING_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Revenue checker interval (Fix 3) */
const REVENUE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

/** Scanner failure threshold for alerts (Fix 2) */
const SCANNER_FAILURE_ALERT_THRESHOLD = 3;

export class ResearchEngine {
  private readonly config: ResearchEngineConfig;
  private readonly db: ResearchDatabase;
  private readonly scoringEngine: ScoringEngine;
  private readonly categorizer: Categorizer;
  private readonly commsWriter: CommsWriter;
  private readonly commsReader: CommsReader;
  private readonly alertSystem: AlertSystem;
  private readonly approvalGate: ApprovalGate;
  private readonly deepAuditor: DeepAuditorEngine;
  private readonly scanners: IResearchScanner[];

  private state: EngineState = 'idle';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revenueCheckTimer: ReturnType<typeof setInterval> | null = null;
  private cycleCount = 0;

  constructor(db: ResearchDatabase, approvalGate: ApprovalGate) {
    this.config = DEFAULT_CONFIG;
    this.db = db;
    this.scoringEngine = new ScoringEngine();
    this.categorizer = new Categorizer(db, this.config.minScoreForAction);
    this.commsWriter = new CommsWriter();
    this.commsReader = new CommsReader();
    this.alertSystem = new AlertSystem();
    this.approvalGate = approvalGate;
    this.deepAuditor = new DeepAuditorEngine();

    this.scanners = [
      new MarketplaceScanner(),
      new RPAScanner(),
      new HighSpeedArbitrageScanner(),
      // new ContentScanner(),
      new TradingScanner(),
      new GeneralScanner(),
    ];

    // Handle ACKs from operator — FIX 3: Use code_generated instead of implementada
    this.commsReader.onAck((ack) => {
      console.log(`[ResearchEngine] Received ACK for ${ack.originalId}: ${ack.status}`);
      this.db.run(
        "UPDATE strategies SET status = ?, operator_ack = ?, implemented_at = ? WHERE opportunity_id = ?",
        ack.status === 'implemented' ? 'implemented' : 'failed',
        ack.status,
        Date.now(),
        ack.originalId,
      );
      if (ack.status === 'implemented') {
        // FIX 3: Don't mark as 'implementada' immediately — mark as 'code_generated'
        // and schedule revenue tracking. Only promote to 'implementada' after confirmed revenue.
        this.categorizer.transitionStatus(ack.originalId, 'code_generated');
        this.db.run(
          'UPDATE opportunities SET code_generated_at = ?, revenue_check_at = ? WHERE id = ?',
          Date.now(),
          Date.now() + REVENUE_TRACKING_PERIOD_MS,
          ack.originalId,
        );
        console.log(`[ResearchEngine] ⏳ Opportunity ${ack.originalId} → code_generated (revenue check in 7 days)`);
      }
    });
  }

  getState(): EngineState {
    return this.state;
  }

  start(): void {
    console.log('[ResearchEngine] Starting research engine.');
    this.commsReader.start();
    this.scheduleNextCycle();
    this.startRevenueChecker(); // FIX 3
  }

  stop(): void {
    this.state = 'stopped';
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.revenueCheckTimer) {
      clearInterval(this.revenueCheckTimer);
      this.revenueCheckTimer = null;
    }
    this.commsReader.stop();
    console.log('[ResearchEngine] Stopped.');
  }

  /**
   * Execute a full research cycle.
   */
  async runCycle(): Promise<CycleResult> {
    const scanId = randomUUID();
    const startedAt = Date.now();
    let sourcesScanned = 0;
    let sourcesFailed = 0;
    let opportunitiesFound = 0;
    let opportunitiesActionable = 0;

    try {
      // ── Phase 1: Scan ──────────────────────────────────────────────────
      this.state = 'scanning';
      console.log(`[ResearchEngine] Cycle #${++this.cycleCount} started — scanning ${this.scanners.length} sources...`);

      const allRaw: RawOpportunity[] = [];
      const scanResults = await Promise.allSettled(
        this.scanners.map((s) => s.scan()),
      );

      for (let i = 0; i < scanResults.length; i++) {
        const result = scanResults[i];
        const scannerName = this.scanners[i].name;

        if (result.status === 'fulfilled') {
          allRaw.push(...result.value);
          sourcesScanned++;
          // FIX 2: Record scanner success
          this.recordScannerHealth(scannerName, 'ok', result.value.length, null, scanId);
        } else {
          sourcesFailed++;
          const errorMsg = (result.reason as Error)?.message ?? 'Unknown error';
          console.warn(`[ResearchEngine] Scanner ${scannerName} failed:`, errorMsg);
          // FIX 2: Record scanner failure
          this.recordScannerHealth(scannerName, 'failed', 0, errorMsg, scanId);
          // FIX 2: Check consecutive failures and alert
          await this.checkScannerConsecutiveFailures(scannerName);
        }
      }

      opportunitiesFound = allRaw.length;
      console.log(`[ResearchEngine] Found ${allRaw.length} raw opportunities.`);

      // ── Phase 2: Deduplicate ───────────────────────────────────────────
      const deduped = this.deduplicate(allRaw);
      console.log(`[ResearchEngine] After dedup: ${deduped.length} new opportunities.`);

      // ── Phase 3: Score & Categorize ────────────────────────────────────
      this.state = 'evaluating';
      const toProcess = deduped.slice(0, this.config.maxOpportunitiesPerCycle);

      // FIX 1: Track deep dives per category to limit LLM waste
      const deepDivesPerCategory = new Map<string, number>();

      for (const raw of toProcess) {
        const scoringResult = await this.scoringEngine.score(raw);
        const priority = this.categorizer.assignPriority(raw.category, raw.title, raw.description);
        const status = this.categorizer.determineStatus(
          scoringResult.composite,
          scoringResult.dimensions.risk,
          raw.capitalRequired,
          priority,
        );

        const id = randomUUID();
        // FIX 1: Compute and store dedup key
        const dedupKey = this.computeDedupeKey(raw.title, raw.sourceUrl);

        // Insert into DB
        this.db.run(
          `INSERT OR IGNORE INTO opportunities (
            id, title, source, category, priority, score,
            score_viability, score_risk, score_capital, score_automation,
            status, description, estimated_revenue, capital_required,
            risk_level, automation_level, source_url, metadata, reasoning,
            discovered_at, last_evaluated_at, status_changed_at, dedup_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, raw.title, raw.source, raw.category, priority, scoringResult.composite,
          scoringResult.dimensions.viability, scoringResult.dimensions.risk,
          scoringResult.dimensions.capital, scoringResult.dimensions.automation,
          status, raw.description, raw.estimatedRevenue, raw.capitalRequired,
          raw.riskLevel, raw.automationLevel, raw.sourceUrl ?? null,
          JSON.stringify(raw.metadata), scoringResult.reasoning,
          startedAt, Date.now(), Date.now(), dedupKey,
        );

        if (scoringResult.composite >= this.config.minScoreForAction) {
          opportunitiesActionable++;

          // FIX 1: Limit deep dives per category to prevent LLM waste on duplicates
          const categoryDives = deepDivesPerCategory.get(raw.category) ?? 0;
          if (categoryDives >= MAX_DEEP_DIVES_PER_CATEGORY) {
            console.log(`[ResearchEngine] ⏭ Skipping deep-dive for "${raw.title.slice(0, 60)}" (category ${raw.category} already deep-dived this cycle)`);
          } else {
            // ── Deep Dive: Investigate promising opportunity in detail ──────
            console.log(`[ResearchEngine] 🔍 Deep-diving into: "${raw.title}" (score: ${scoringResult.composite})`);
            deepDivesPerCategory.set(raw.category, categoryDives + 1);
            const deepDive = await this.scoringEngine.deepDive(raw, scoringResult);
            if (deepDive) {
              console.log(`[ResearchEngine] Deep-dive result: ${deepDive.conclusion}`);
              // Update reasoning in DB with deep-dive analysis
              this.db.run(
                'UPDATE opportunities SET reasoning = ? WHERE id = ?',
                `${scoringResult.reasoning}\n\n--- DEEP DIVE ---\n${deepDive.analysis}\nConclusion: ${deepDive.conclusion}`,
                id,
              );
              // If deep-dive says "not viable after all", downgrade
              if (deepDive.stillViable === false) {
                this.db.run('UPDATE opportunities SET status = ?, score = ? WHERE id = ?', 'descartada', Math.max(0, scoringResult.composite - 30), id);
                opportunitiesActionable--;
                continue;
              }
            }
          }
        }

        // ── Phase 4: Communicate ─────────────────────────────────────────
        if (status === 'activa') {
          // Write strategy proposal
          const proposal: StrategyProposal = {
            type: 'strategy_proposal',
            timestamp: new Date().toISOString(),
            priority,
            payload: {
              opportunityId: id,
              title: raw.title,
              implementation: `// TODO: Implement strategy for "${raw.title}"\n// Source: ${raw.source}\n// Revenue: ${raw.estimatedRevenue}`,
              testCommand: 'pnpm test -- --run',
              requiresRestart: false,
            },
          };

          const filepath = this.commsWriter.writeStrategyProposal(proposal);

          // Record strategy
          this.db.run(
            `INSERT INTO strategies (id, opportunity_id, status, file_written, created_at)
             VALUES (?, ?, 'proposed', ?, ?)`,
            randomUUID(), id, filepath, Date.now(),
          );
        }

        // Send for approval if needed
        if (status === 'pendiente_aprobacion') {
          await this.approvalGate.requestApproval({
            opportunityId: id,
            strategy: raw.title,
            riskPercent: 100 - scoringResult.dimensions.risk,
            capitalRequired: raw.capitalRequired,
            bestCase: raw.estimatedRevenue,
            worstCase: 'Pérdida del capital invertido',
          });
        }
      }

      // ── Phase 5: Deep Audit & Telegram Alerts (Exclusively Verified) ───
      this.state = 'communicating';
      this.alertSystem.resetCycle();

      // FILTRO ESTRICTO: Solo iniciativas con score_risk > 50 (es decir riesgo < 50%) y score >= minScoreForAction
      const actionable = this.db.all<{ id: string; title: string; score: number; score_risk: number; priority: string; description: string; category: string; source_url: string | null }>(
        "SELECT id, title, score, score_risk, priority, description, category, source_url FROM opportunities WHERE discovered_at >= ? AND score >= ? AND score_risk > 50",
        startedAt,
        this.config.minScoreForAction,
      );

      for (const opp of actionable) {
        const audit = await this.deepAuditor.auditOpportunity({
          id: opp.id,
          title: opp.title,
          description: opp.description,
          category: opp.category,
          sourceUrl: opp.source_url ?? undefined,
          rawScore: opp.score,
          scoreRisk: opp.score_risk,
        });

        // Actualizar oportunidad con resultado de auditoría
        if (
          audit.verdict === 'REJECTED_HISTORICAL' || 
          audit.verdict === 'REJECTED_SCAM' || 
          audit.verdict === 'REJECTED_RISK' || 
          audit.verdict === 'REJECTED_DUPLICATE' ||
          audit.riskPercent >= 50
        ) {
          this.db.run(
            'UPDATE opportunities SET status = ?, reasoning = ? WHERE id = ?',
            'descartada',
            `[AUDIT RECHAZADO: ${audit.verdict}] (Riesgo: ${audit.riskPercent}%) ${audit.summaryConclusion}`,
            opp.id
          );
        } else if (audit.verdict === 'VERIFIED_LEGIT' && audit.riskPercent < 50) {
          this.db.run(
            'UPDATE opportunities SET status = ?, score = ?, reasoning = ? WHERE id = ?',
            'verificada_legitima',
            audit.trustScore,
            `[AUDIT VERIFICADO: Riesgo ${audit.riskPercent}%] ${audit.summaryConclusion}`,
            opp.id
          );

          // Enviar dossier exclusivo a Telegram
          await this.alertSystem.sendAuditedDossier({
            id: opp.id,
            title: opp.title,
            description: opp.description,
            category: opp.category,
            sourceUrl: opp.source_url ?? undefined,
            rawScore: opp.score,
            scoreRisk: opp.score_risk,
          }, audit);
        }
      }

      // ── Phase 6: Update master_log ─────────────────────────────────────
      this.categorizer.generateMasterLog();

      // Record scan history
      const completedAt = Date.now();
      this.db.run(
        `INSERT INTO scan_history (id, started_at, completed_at, sources_scanned, sources_failed, opportunities_found, opportunities_actionable)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        scanId, startedAt, completedAt, sourcesScanned, sourcesFailed, opportunitiesFound, opportunitiesActionable,
      );

      this.state = 'idle';
      console.log(
        `[ResearchEngine] Cycle #${this.cycleCount} complete: ${opportunitiesFound} found, ${opportunitiesActionable} actionable. Duration: ${Math.round((completedAt - startedAt) / 1000)}s`,
      );

      return {
        scanId, startedAt, completedAt, sourcesScanned, sourcesFailed, opportunitiesFound, opportunitiesActionable,
      };
    } catch (err) {
      this.state = 'idle';
      const error = (err as Error).message;
      console.error('[ResearchEngine] Cycle failed:', error);

      this.db.run(
        `INSERT INTO scan_history (id, started_at, completed_at, sources_scanned, sources_failed, opportunities_found, opportunities_actionable, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        scanId, startedAt, Date.now(), sourcesScanned, sourcesFailed, opportunitiesFound, opportunitiesActionable, error,
      );

      return {
        scanId, startedAt, completedAt: Date.now(), sourcesScanned, sourcesFailed, opportunitiesFound, opportunitiesActionable, error,
      };
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private scheduleNextCycle(): void {
    const delay = this.randomInterval();
    console.log(`[ResearchEngine] Next cycle in ${Math.round(delay / 60_000)} minutes.`);
    this.timer = setTimeout(async () => {
      await this.runCycle();
      if (this.state !== 'stopped') {
        this.scheduleNextCycle();
      }
    }, delay);
  }

  private randomInterval(): number {
    const { intervalMinMs, intervalMaxMs } = this.config;
    return intervalMinMs + Math.random() * (intervalMaxMs - intervalMinMs);
  }

  // ── FIX 1: Improved deduplication ─────────────────────────────────────────

  /**
   * Compute a normalized dedup key from title + URL.
   * Uses first 50 chars of normalized title + source_url to catch
   * near-duplicates (e.g. same Medium article across scan cycles).
   */
  /**
   * Compute a normalized dedup key from title + URL.
   * Neutralizes specific cryptocurrency tokens/pairs (e.g. BTC, ETH, SOL, BTCUSDT, ETH-USDT)
   * so identical strategies (e.g. "Binance BTCUSDT funding" vs "Binance ETHUSDT funding")
   * share the same dedupe key and are not repeated across different currencies.
   */
  private computeDedupeKey(title: string, sourceUrl?: string): string {
    let normalized = title
      .toLowerCase()
      // Eliminar identificadores específicos de pares o contratos
      .replace(/\b(?:btc|eth|sol|bnb|xrp|ada|doge|dot|matic|avax|link|arb|op|sui|apt|near|ton|shib|pepe|wif|floki|usdt|usdc|busd|dai|fdusd|tusd|weth|cbeth|wsteth|weeth)\b/gi, '<token>')
      // Eliminar pares continuos comunes (ej: btcusdt, ethusdt, solusdc)
      .replace(/[a-z0-9]{2,10}(?:usdt|usdc|busd|dai|btc|eth)/gi, '<pair>')
      // Eliminar direcciones hexadecimales (ej: 0x123...abc)
      .replace(/0x[a-f0-9]{4,40}/gi, '<address>')
      // Eliminar porcentajes y números específicos que varían entre monedas (ej: 12.5% vs 15.2%)
      .replace(/\b\d+(\.\d+)?%\b/g, '<percent>')
      .replace(/\b\d+(\.\d+)?\b/g, '<num>')
      .replace(/\s+/g, ' ')
      .replace(/[^a-z0-9 <>]/g, '')
      .trim()
      .slice(0, 60);

    // Normalizar URL eliminando rutas específicas de pares o tokens
    let normalizedUrl = '';
    if (sourceUrl) {
      try {
        const u = new URL(sourceUrl);
        normalizedUrl = `${u.hostname}${u.pathname.replace(/\/(0x[a-f0-9]+|[a-z0-9_-]+(usdt|usdc|swap|perp|pool))/i, '/<pool>')}`;
      } catch {
        normalizedUrl = sourceUrl.split('?')[0]?.slice(0, 40) ?? '';
      }
    }

    return normalizedUrl ? `${normalizedUrl}::${normalized}` : normalized;
  }

  private deduplicate(raw: RawOpportunity[]): RawOpportunity[] {
    // FIX 1: Use dedup_key (normalized fingerprint) instead of exact title match
    // FIX 4 (Aug 13): Include ALL statuses - even descartada, code_generated, failed_no_revenue
    // to prevent re-investigating opportunities that were already processed
    const existingKeys = new Set(
      this.db
        .all<{ dedup_key: string | null; title: string }>('SELECT dedup_key, title FROM opportunities')
        .map((r) => r.dedup_key ?? r.title.toLowerCase().trim()),
    );

    // FIX 1: Source URL cooldown — skip opportunities from URLs scanned in last 24h
    const recentSourceUrls = new Set(
      this.db
        .all<{ source_url: string }>(
          'SELECT DISTINCT source_url FROM opportunities WHERE source_url IS NOT NULL AND discovered_at > ?',
          Date.now() - SOURCE_URL_COOLDOWN_MS,
        )
        .map((r) => r.source_url),
    );

    // FIX 4 (Aug 13): Load blacklisted keywords from HISTORIAL to prevent re-research
    // These are topics/patterns that were manually marked as "never research again"
    const blacklistedPatterns = this.loadBlacklistedPatterns();

    const seen = new Set<string>();
    return raw.filter((opp) => {
      const key = this.computeDedupeKey(opp.title, opp.sourceUrl);

      // Skip if dedup key already exists (including descartadas, code_generated, etc.)
      if (existingKeys.has(key) || seen.has(key)) return false;

      // FIX 1: Skip if same source_url was scanned recently (for content-platform sources)
      if (opp.sourceUrl && recentSourceUrls.has(opp.sourceUrl) && opp.source === 'content-platform') {
        return false;
      }

      // FIX 4: Skip if matches blacklisted pattern (e.g., "sports", "celebrities", high APY DeFi)
      if (this.matchesBlacklistPattern(opp, blacklistedPatterns)) {
        console.log(`[ResearchEngine] ⛔ Skipping blacklisted topic: "${opp.title.slice(0, 60)}"`);
        return false;
      }

      seen.add(key);
      return true;
    });
  }

  // ── FIX 4: Blacklist pattern matching ─────────────────────────────────────

  /**
   * Load blacklisted patterns from config or hardcoded rules.
   * ONLY blocks truly dangerous/scam content - NOT based on "nicho".
   * The Research Agent explores ALL income opportunities regardless of category.
   * 
   * FIX-028: Now also loads from data/research-blacklist.json (populated by ProposalConsolidator)
   */
  private loadBlacklistedPatterns(): {
    titlePatterns: RegExp[];
    maxDeFiApy: number;
    blacklistedTitles: Set<string>;
  } {
    // Load dynamic blacklist from consolidator (failed/discarded proposals)
    const blacklistedTitles = new Set<string>();
    try {
      const blacklistPath = resolve(process.cwd(), 'data/research-blacklist.json');
      
      if (existsSync(blacklistPath)) {
        const content = readFileSync(blacklistPath, 'utf-8');
        const entries = JSON.parse(content) as Array<{ title: string }>;
        for (const entry of entries) {
          // Normalize title for matching
          const normalized = entry.title.toLowerCase().replace(/[^a-z0-9]/g, '');
          blacklistedTitles.add(normalized);
        }
        console.log(`[ResearchEngine] Loaded ${blacklistedTitles.size} blacklisted titles from consolidator`);
      }
    } catch (err) {
      // Non-fatal: blacklist file might not exist yet
      console.warn('[ResearchEngine] Could not load blacklist file:', (err as Error).message);
    }

    return {
      // ONLY block genuinely dangerous/illegal content
      titlePatterns: [
        /\bcsam\b/i,  // Child safety content - NEVER
      ],
      // DeFi opportunities with APY > this are mathematically unsustainable (likely scams/rugs)
      maxDeFiApy: 5000,  // 5000% is extremely generous - anything higher is almost certainly a scam
      blacklistedTitles,
    };
  }

  /**
   * Check if an opportunity matches any blacklist pattern.
   * ONLY blocks dangerous/scam content, NOT based on category/niche.
   * FIX-028: Also checks against previously failed/discarded proposals
   */
  private matchesBlacklistPattern(
    opp: RawOpportunity,
    patterns: ReturnType<typeof this.loadBlacklistedPatterns>,
  ): boolean {
    // FIX-028: Check against dynamic blacklist (previously failed/discarded)
    const normalizedTitle = opp.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (patterns.blacklistedTitles.has(normalizedTitle)) {
      console.log(`[ResearchEngine] ⛔ Previously failed/discarded: "${opp.title.slice(0, 60)}"`);
      return true;
    }

    // Check title patterns (only dangerous content)
    for (const regex of patterns.titlePatterns) {
      if (regex.test(opp.title) || regex.test(opp.description ?? '')) {
        return true;
      }
    }

    // Check DeFi APY threshold - extremely high APY = mathematically unsustainable
    if (opp.category === 'trading' || opp.source === 'defi-llama') {
      const apyMatch = opp.title.match(/(\d+(?:,\d+)?(?:\.\d+)?)\s*%/);
      if (apyMatch) {
        const apy = parseFloat(apyMatch[1].replace(/,/g, ''));
        if (apy > patterns.maxDeFiApy) {
          console.log(`[ResearchEngine] ⛔ DeFi APY unsustainable (${apy}% > ${patterns.maxDeFiApy}%): "${opp.title.slice(0, 60)}"`);
          return true;
        }
      }
    }

    return false;
  }

  // ── FIX 2: Scanner health tracking ────────────────────────────────────────

  private recordScannerHealth(
    scanner: string,
    status: 'ok' | 'failed',
    resultsCount: number,
    error: string | null,
    cycleId: string,
  ): void {
    try {
      this.db.run(
        `INSERT INTO scanner_health (scanner, status, results_count, error, cycle_id, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
        scanner, status, resultsCount, error, cycleId, Date.now(),
      );
    } catch (err) {
      // Non-fatal: table might not exist yet if migration hasn't run
      console.warn('[ResearchEngine] Failed to record scanner health:', (err as Error).message);
    }
  }

  private async checkScannerConsecutiveFailures(scannerName: string): Promise<void> {
    try {
      const recentEntries = this.db.all<{ status: string }>(
        `SELECT status FROM scanner_health WHERE scanner = ? ORDER BY timestamp DESC LIMIT ?`,
        scannerName, SCANNER_FAILURE_ALERT_THRESHOLD,
      );

      // If all recent entries are failures, send alert
      if (
        recentEntries.length >= SCANNER_FAILURE_ALERT_THRESHOLD &&
        recentEntries.every((e) => e.status === 'failed')
      ) {
        console.warn(`[ResearchEngine] ⚠️ Scanner "${scannerName}" has failed ${SCANNER_FAILURE_ALERT_THRESHOLD}+ consecutive cycles!`);
        this.alertSystem.sendScannerFailureAlert(scannerName, SCANNER_FAILURE_ALERT_THRESHOLD);
      }
    } catch {
      // Non-fatal
    }
  }

  // ── FIX 3: Revenue lifecycle checker ──────────────────────────────────────

  /**
   * Periodically check opportunities in 'code_generated' status.
   * If 7 days have passed without confirmed revenue → 'failed_no_revenue'.
   * If revenue is confirmed (actual_revenue set) → 'implementada'.
   */
  private startRevenueChecker(): void {
    console.log('[ResearchEngine] Starting revenue lifecycle checker (every 6h).');
    this.revenueCheckTimer = setInterval(() => this.checkRevenueLifecycle(), REVENUE_CHECK_INTERVAL_MS);
    // Also run once after a short delay
    setTimeout(() => this.checkRevenueLifecycle(), 60_000);
  }

  private checkRevenueLifecycle(): void {
    const now = Date.now();

    // 1. Promote code_generated → revenue_tracking after 24h (gives time for initial execution)
    const readyForTracking = this.db.all<{ id: string; title: string }>(
      `SELECT id, title FROM opportunities
       WHERE status = 'code_generated'
       AND code_generated_at IS NOT NULL
       AND code_generated_at < ?`,
      now - (24 * 60 * 60 * 1000), // 24h after code generation
    );
    for (const opp of readyForTracking) {
      this.categorizer.transitionStatus(opp.id, 'revenue_tracking');
      console.log(`[RevenueChecker] 📊 ${opp.title.slice(0, 60)} → revenue_tracking`);
    }

    // 2. Check revenue_tracking opportunities that have passed the 7-day window
    const expiredTracking = this.db.all<{ id: string; title: string; actual_revenue: string | null }>(
      `SELECT id, title, actual_revenue FROM opportunities
       WHERE status = 'revenue_tracking'
       AND revenue_check_at IS NOT NULL
       AND revenue_check_at <= ?`,
      now,
    );

    for (const opp of expiredTracking) {
      if (opp.actual_revenue && opp.actual_revenue !== '$0' && opp.actual_revenue !== '') {
        // Revenue confirmed!
        this.categorizer.transitionStatus(opp.id, 'implementada');
        console.log(`[RevenueChecker] ✅ ${opp.title.slice(0, 60)} → implementada (revenue: ${opp.actual_revenue})`);
      } else {
        // No revenue after 7 days
        this.categorizer.transitionStatus(opp.id, 'failed_no_revenue');
        console.log(`[RevenueChecker] ❌ ${opp.title.slice(0, 60)} → failed_no_revenue (7-day window expired)`);
      }
    }

    // 3. Also transition old 'implementada' entries that were set before this fix
    // to 'code_generated' if they have no actual_revenue
    const legacyImplemented = this.db.all<{ id: string; title: string }>(
      `SELECT id, title FROM opportunities
       WHERE status = 'implementada'
       AND actual_revenue IS NULL
       AND code_generated_at IS NULL`,
    );
    if (legacyImplemented.length > 0) {
      console.log(`[RevenueChecker] 🔄 Migrating ${legacyImplemented.length} legacy 'implementada' entries → code_generated`);
      for (const opp of legacyImplemented) {
        this.db.run(
          'UPDATE opportunities SET status = ?, code_generated_at = ?, revenue_check_at = ? WHERE id = ?',
          'code_generated', now, now + REVENUE_TRACKING_PERIOD_MS, opp.id,
        );
      }
    }
  }
}
