/**
 * AlertSystem — Envío exclusivo de Dossiers Auditados y Verificados a Telegram.
 * 
 * Regla Estricta:
 * Ya NO se envían alertas de oportunidades crudas.
 * Únicamente se notifica cuando una oportunidad pasa la Fase 2 (DeepAuditorEngine)
 * con veredicto 'VERIFIED_LEGIT' y un Trust Score superior a 85.
 */

import axios from 'axios';
import type { AuditResult, AuditInput } from './deep-auditor.js';

export class AlertSystem {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly isMock: boolean;

  constructor() {
    this.botToken = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
    this.chatId = process.env['TELEGRAM_CHAT_ID'] ?? '';
    this.isMock = !this.botToken || !this.chatId;
  }

  public resetCycle(): void {
    // No-op en nueva arquitectura
  }

  /**
   * Notifica a Telegram ÚNICAMENTE un dossier de oportunidad completamente auditada y legítima
   */
  public async sendAuditedDossier(opp: AuditInput, audit: AuditResult): Promise<void> {
    if (audit.verdict !== 'VERIFIED_LEGIT' || audit.trustScore < 85 || audit.riskPercent >= 50) {
      console.log(`[AlertSystem] 🔕 Oportunidad "${opp.title}" descartada para Telegram (Veredicto: ${audit.verdict}, Score: ${audit.trustScore}, Riesgo: ${audit.riskPercent}%)`);
      return;
    }

    const steps = audit.actionableSteps?.map((s, i) => `${i + 1}. ${s}`).join('\n') || 'N/A';
    const evidenceList = audit.evidenceCollected.map(e => `• [${e.sourceType.toUpperCase()}] ${e.description}`).join('\n');

    const message = [
      `🛡️ *DOSSIER DE INVESTIGACIÓN AUDITADO Y VERIFICADO* 🛡️`,
      ``,
      `🎯 *Oportunidad:* ${opp.title}`,
      `📂 *Categoría:* ${opp.category}`,
      `⭐ *Puntaje de Confianza:* ${audit.trustScore}/100`,
      `🛡️ *Riesgo Estimado:* ${audit.riskPercent}% *(Aprobado: < 50%)*`,
      `🔍 *Factibilidad Técnica:* ${audit.technicalFeasibility}`,
      `💰 *Demanda Económica:* ${audit.economicModelViability}`,
      ``,
      `📋 *Conclusión de la Auditoría:*`,
      `${audit.summaryConclusion}`,
      ``,
      audit.deepseekAnalysis ? `🧠 *Evaluación DeepSeek:*\n${audit.deepseekAnalysis}\n` : '',
      `📊 *Evidencia & Verificación:*`,
      evidenceList,
      ``,
      `🚀 *Siguientes Pasos Recomendados:*`,
      steps,
      ``,
      opp.sourceUrl ? `🔗 *Fuente Verificada:* ${opp.sourceUrl}` : '',
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `_Filtro Anti-Estafas, Memoria Histórica y Riesgo Cuantitativo (<50%) Aprobados_`
    ].filter(Boolean).join('\n');

    await this.sendTelegram(message);
  }

  public async sendScannerFailureAlert(scannerName: string, failures: number): Promise<void> {
    const text = `⚠️ *ALERTA DE SCANNER*: El scanner \`${scannerName}\` ha fallado ${failures} ciclos consecutivos.`;
    await this.sendTelegram(text);
  }

  private async sendTelegram(text: string): Promise<void> {
    if (this.isMock) {
      console.log(`[AlertSystem] MOCK Telegram Audit Notification:\n${text}`);
      return;
    }

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    try {
      await axios.post(url, {
        chat_id: this.chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }, { timeout: 15_000 });
      console.log('[AlertSystem] ✅ Dossier auditado enviado exitosamente a Telegram.');
    } catch {
      // Fallback sin Markdown si hay caracteres no escapados como guiones bajos en URLs de GitHub
      try {
        await axios.post(url, {
          chat_id: this.chatId,
          text: text.replace(/[*_`]/g, ''),
          disable_web_page_preview: true,
        }, { timeout: 15_000 });
        console.log('[AlertSystem] ✅ Dossier auditado enviado a Telegram (modo fallback texto plano).');
      } catch (err2) {
        console.error('[AlertSystem] ❌ Fallo al enviar mensaje a Telegram:', (err2 as Error).message);
      }
    }
  }
}
