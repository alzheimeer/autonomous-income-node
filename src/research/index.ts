/**
 * Research Agent — Entry point.
 *
 * Bootstrap:
 * 1. Load .env (dotenv)
 * 2. Initialize ResearchDatabase
 * 3. Initialize PriceFeedService
 * 4. Initialize ApprovalGate
 * 5. Initialize Dashboard
 * 6. Initialize ResearchEngine
 * 7. Start all services
 * 8. Handle SIGTERM/SIGINT for graceful shutdown
 */

import { config } from 'dotenv';
config();

import { ResearchDatabase } from './state/database.js';
import { PriceFeedService } from './price-feed.js';
import { ApprovalGate } from './approval-gate.js';
import { ResearchDashboard } from './dashboard.js';
import { ResearchEngine } from './engine.js';
import axios from 'axios';

/** Send startup notification via Telegram */
async function notifyStartup(): Promise<void> {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  const chatId = process.env['TELEGRAM_CHAT_ID'];
  if (!token || !chatId) return;

  const message = `🔬 <b>Research Agent ONLINE</b>\n\n` +
    `El agente investigador ha iniciado.\n` +
    `• Escaneando: marketplaces, RPA, contenido, trading\n` +
    `• Ciclo: cada 4-6 horas\n` +
    `• Dashboard: http://localhost:3002\n\n` +
    `Primer ciclo de investigación iniciando en 5 segundos...`;

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
    }, { timeout: 10_000 });
    console.log('[Research] Telegram startup notification sent.');
  } catch (err) {
    console.warn('[Research] Telegram notification failed:', (err as Error).message);
  }
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('  RESEARCH AGENT — Autonomous Income Node');
  console.log('  Starting up...');
  console.log('='.repeat(60));

  // ── Step 1: Database ─────────────────────────────────────────────────────
  console.log('[Research] Initializing database...');
  const db = new ResearchDatabase();
  db.initialize();

  // ── Step 2: Price Feed ───────────────────────────────────────────────────
  console.log('[Research] Starting price feed...');
  const priceFeed = new PriceFeedService();
  priceFeed.start();

  // ── Step 3: Approval Gate ────────────────────────────────────────────────
  console.log('[Research] Initializing approval gate...');
  const approvalGate = new ApprovalGate(db);
  approvalGate.start();

  // ── Step 4: Research Engine ──────────────────────────────────────────────
  console.log('[Research] Initializing research engine...');
  const engine = new ResearchEngine(db, approvalGate);

  // ── Step 5: Dashboard ────────────────────────────────────────────────────
  console.log('[Research] Starting dashboard...');
  const dashboard = new ResearchDashboard({
    db,
    priceFeed,
    getState: () => engine.getState(),
  });
  await dashboard.start();

  // ── Step 6: Start Engine ─────────────────────────────────────────────────
  console.log('[Research] Starting research engine loop...');
  engine.start();

  // ── Step 7: Notify via Telegram ──────────────────────────────────────────
  await notifyStartup();

  // Run first cycle immediately (after a short delay for services to stabilize)
  setTimeout(async () => {
    console.log('[Research] Running initial research cycle...');
    await engine.runCycle();
  }, 5_000);

  console.log('='.repeat(60));
  console.log('  RESEARCH AGENT READY');
  console.log(`  Dashboard: http://localhost:${process.env['RESEARCH_DASHBOARD_PORT'] ?? '3002'}`);
  console.log('='.repeat(60));

  // ── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`\n[Research] ${signal} received — shutting down gracefully...`);
    engine.stop();
    approvalGate.stop();
    priceFeed.stop();
    await dashboard.stop();
    db.close();
    console.log('[Research] Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[Research] Fatal error:', err);
  process.exit(1);
});
