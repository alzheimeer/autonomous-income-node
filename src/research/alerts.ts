/**
 * AlertSystem — Sends Telegram alerts after scan cycles.
 *
 * Rules:
 * - 3+ opportunities with score ≥ 70 in same cycle → batch alert
 * - 1 opportunity with score ≥ 90 → immediate individual alert
 * - Max 1 batch alert per cycle
 */

import axios from 'axios';

export interface AlertOpportunity {
  title: string;
  score: number;
  priority: string;
}

export class AlertSystem {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly isMock: boolean;
  private batchSentThisCycle = false;

  constructor() {
    this.botToken = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
    this.chatId = process.env['TELEGRAM_CHAT_ID'] ?? '';
    this.isMock = !this.botToken || !this.chatId;
  }

  /**
   * Reset cycle state — call at start of each scan cycle.
   */
  resetCycle(): void {
    this.batchSentThisCycle = false;
  }

  /**
   * Check opportunities and send alerts if criteria met.
   */
  async checkAndAlert(opportunities: AlertOpportunity[]): Promise<void> {
    // Individual alerts for score ≥ 90
    const exceptional = opportunities.filter((o) => o.score >= 90);
    for (const opp of exceptional) {
      await this.sendIndividualAlert(opp);
    }

    // Batch alert for 3+ score ≥ 70
    const viable = opportunities.filter((o) => o.score >= 70);
    if (viable.length >= 3 && !this.batchSentThisCycle) {
      await this.sendBatchAlert(viable);
      this.batchSentThisCycle = true;
    }
  }

  private async sendIndividualAlert(opp: AlertOpportunity): Promise<void> {
    const message = [
      `🚨 OPORTUNIDAD EXCEPCIONAL 🚨`,
      ``,
      `🏆 ${opp.title}`,
      `📊 Score: ${opp.score}/100`,
      `🏷️ Prioridad: ${opp.priority}`,
      ``,
      `Revisa el dashboard: http://localhost:3002/opportunities`,
    ].join('\n');

    await this.sendTelegram(message);
  }

  private async sendBatchAlert(opportunities: AlertOpportunity[]): Promise<void> {
    const lines = opportunities.slice(0, 5).map(
      (o, i) => `${i + 1}. ${o.title} (Score: ${o.score}, ${o.priority})`,
    );

    const message = [
      `🚨 ALERTA: VÍAS PROMETEDORAS 🚨`,
      ``,
      `Se encontraron ${opportunities.length} oportunidades viables:`,
      ``,
      ...lines,
      ``,
      `Revisa el dashboard: http://localhost:3002/opportunities`,
    ].join('\n');

    await this.sendTelegram(message);
  }

  private async sendTelegram(text: string): Promise<void> {
    if (this.isMock) {
      console.log(`[AlertSystem] MOCK alert:\n${text.slice(0, 200)}`);
      return;
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      await axios.post(url, {
        chat_id: this.chatId,
        text,
        disable_web_page_preview: true,
      }, { timeout: 15_000 });
    } catch (err) {
      console.warn('[AlertSystem] Failed to send alert:', (err as Error).message);
    }
  }

  /**
   * FIX 2: Alert when a scanner has failed multiple consecutive cycles.
   */
  async sendScannerFailureAlert(scannerName: string, consecutiveFailures: number): Promise<void> {
    const message = [
      `⚠️ SCANNER OFFLINE ⚠️`,
      ``,
      `El scanner "${scannerName}" ha fallado ${consecutiveFailures} ciclos consecutivos.`,
      `Esto significa que NO se están descubriendo oportunidades de esta fuente.`,
      ``,
      `Revisa los logs: docker logs ain-research --tail 50`,
      `Dashboard: http://localhost:3002/scanner-health`,
    ].join('\n');

    await this.sendTelegram(message);
  }
}
