/**
 * ApprovalGate — Sends Telegram messages for risky strategy approval.
 *
 * Uses Telegram Bot API directly (axios):
 * - sendMessage: POST https://api.telegram.org/bot{token}/sendMessage
 * - getUpdates: GET https://api.telegram.org/bot{token}/getUpdates?offset={last+1}
 *
 * Timeout: 24h. Polls every 30s.
 */

import axios from 'axios';
import { randomUUID } from 'node:crypto';
import type { ResearchDatabase } from './state/database.js';
import type { ApprovalRequest, ApprovalResponse } from './comms/protocol.js';

const POLL_INTERVAL_MS = 30_000;
const TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h

export class ApprovalGate {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly isMock: boolean;
  private readonly db: ResearchDatabase;
  private lastUpdateId = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(db: ResearchDatabase) {
    this.botToken = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
    this.chatId = process.env['TELEGRAM_CHAT_ID'] ?? '';
    this.isMock = !this.botToken || !this.chatId;
    this.db = db;
  }

  /**
   * Start polling for approval responses.
   */
  start(): void {
    if (this.isMock) {
      console.log('[ApprovalGate] MOCK MODE — no Telegram token configured.');
      return;
    }
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.pollUpdates(), POLL_INTERVAL_MS);
    console.log('[ApprovalGate] Started polling for approval responses.');
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Request human approval for a risky strategy via Telegram.
   */
  async requestApproval(req: ApprovalRequest): Promise<string> {
    const id = randomUUID();

    // Store in DB
    this.db.run(
      `INSERT INTO approvals (id, opportunity_id, strategy, risk_percent, capital_required, best_case, worst_case, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id,
      req.opportunityId,
      req.strategy,
      req.riskPercent,
      req.capitalRequired,
      req.bestCase,
      req.worstCase,
      Date.now(),
    );

    // Send Telegram message
    const message = this.formatApprovalMessage(req, id);
    const messageId = await this.sendTelegram(message);

    // Store telegram message ID for correlation
    if (messageId) {
      this.db.run(
        'UPDATE approvals SET telegram_message_id = ? WHERE id = ?',
        messageId,
        id,
      );
    }

    return id;
  }

  /**
   * Check for expired approvals and auto-reject.
   */
  checkTimeouts(): void {
    const cutoff = Date.now() - TIMEOUT_MS;
    const expired = this.db.all<{ id: string; opportunity_id: string }>(
      "SELECT id, opportunity_id FROM approvals WHERE status = 'pending' AND created_at < ?",
      cutoff,
    );

    for (const approval of expired) {
      this.db.run(
        "UPDATE approvals SET status = 'expired', responded_at = ? WHERE id = ?",
        Date.now(),
        approval.id,
      );
      console.log(`[ApprovalGate] Approval ${approval.id} expired (24h timeout).`);
    }
  }

  /**
   * Get all pending approvals.
   */
  getPending(): Array<{ id: string; opportunityId: string; strategy: string }> {
    return this.db.all(
      "SELECT id, opportunity_id as opportunityId, strategy FROM approvals WHERE status = 'pending'",
    );
  }

  /**
   * Get recently responded approvals.
   */
  getResponded(): ApprovalResponse[] {
    const rows = this.db.all<{
      id: string;
      opportunity_id: string;
      status: string;
      responded_at: number;
    }>(
      "SELECT id, opportunity_id, status, responded_at FROM approvals WHERE status IN ('approved', 'rejected') AND responded_at > ?",
      Date.now() - 60_000, // last minute
    );

    return rows.map((r) => ({
      id: r.id,
      opportunityId: r.opportunity_id,
      approved: r.status === 'approved',
      respondedAt: r.responded_at,
    }));
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private formatApprovalMessage(req: ApprovalRequest, id: string): string {
    return [
      `🔔 ESTRATEGIA PROPUESTA`,
      ``,
      `📋 ${req.strategy}`,
      `⚠️ Riesgo: ${req.riskPercent}%`,
      `💰 Capital: $${req.capitalRequired}`,
      `📈 Mejor caso: ${req.bestCase}`,
      `📉 Peor caso: ${req.worstCase}`,
      ``,
      `ID: ${id.slice(0, 8)}`,
      `Responde: ✅ SI o ❌ NO`,
    ].join('\n');
  }

  private async sendTelegram(text: string): Promise<number | null> {
    if (this.isMock) {
      console.log(`[ApprovalGate] MOCK — would send:\n${text.slice(0, 200)}`);
      return Date.now();
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const response = await axios.post(url, {
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
      }, { timeout: 15_000 });

      return response.data?.result?.message_id ?? null;
    } catch (err) {
      console.warn('[ApprovalGate] Telegram send failed:', (err as Error).message);
      return null;
    }
  }

  private async pollUpdates(): Promise<void> {
    if (this.isMock) return;

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=5`;
      const response = await axios.get(url, { timeout: 15_000 });

      const updates = response.data?.result ?? [];
      for (const update of updates) {
        this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);

        const text = update.message?.text?.trim().toUpperCase() ?? '';
        const chatId = String(update.message?.chat?.id ?? '');

        // Only process messages from our chat
        if (chatId !== this.chatId) continue;

        if (text === 'SI' || text === 'SÍ' || text === 'YES' || text === '✅') {
          await this.processResponse(true);
        } else if (text === 'NO' || text === '❌') {
          await this.processResponse(false);
        }
      }

      // Also check timeouts
      this.checkTimeouts();
    } catch (err) {
      console.warn('[ApprovalGate] Poll error:', (err as Error).message);
    }
  }

  private async processResponse(approved: boolean): Promise<void> {
    // Get oldest pending approval
    const pending = this.db.get<{ id: string; opportunity_id: string }>(
      "SELECT id, opportunity_id FROM approvals WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1",
    );

    if (!pending) return;

    const newStatus = approved ? 'approved' : 'rejected';
    this.db.run(
      'UPDATE approvals SET status = ?, responded_at = ? WHERE id = ?',
      newStatus,
      Date.now(),
      pending.id,
    );

    const emoji = approved ? '✅' : '❌';
    await this.sendTelegram(`${emoji} Aprobación ${newStatus}: ${pending.id.slice(0, 8)}`);
    console.log(`[ApprovalGate] Approval ${pending.id} → ${newStatus}`);
  }
}
