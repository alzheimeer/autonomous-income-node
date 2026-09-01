#!/usr/bin/env node
/**
 * Dashboard CLI — standalone script to inspect the running agent.
 *
 * Usage:
 *   node dist/dashboard/index.js status   → show wallet, tier, balance, uptime, modules
 *   node dist/dashboard/index.js backup   → trigger AgentDatabase.backup() via REST
 *
 * Calls GET /status or POST /backup on the HeartbeatModule HTTP server.
 *
 * Requirements: 15.7
 */

import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Types (mirrors what /status endpoint returns)
// ---------------------------------------------------------------------------

interface ModuleEntry {
  status: string;
  consecutiveFailures?: number;
}

interface StatusResponse {
  health: {
    overall: string;
    tier: number;
    balanceUsdc: string;
    llmAvailable: boolean;
    modules: Record<string, ModuleEntry>;
    timestamp: number;
  };
  metrics: {
    uptimeMs: number;
    cycleCount: number;
    totalIncomeUsdc: string;
    totalErrors: number;
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_PORT = process.env['API_PORT'] ?? '3000';
const BASE_URL = `http://127.0.0.1:${API_PORT}`;
const TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// HTTP helpers — use built-in fetch (Node 20+) or fallback to http module
// ---------------------------------------------------------------------------

async function httpGet(path: string): Promise<unknown> {
  const url = `${BASE_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function httpPost(path: string, body?: unknown): Promise<unknown> {
  const url = `${BASE_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const TIER_LABELS: Record<number, string> = {
  0: 'EMERGENCY',
  1: 'TIER_1  (<$10)',
  2: 'TIER_2  ($10-$99)',
  3: 'TIER_3  ($100-$999)',
  4: 'TIER_4  (>$1000)',
};

function formatUsdcBalance(raw: string): string {
  try {
    const n = BigInt(raw);
    const whole = n / 1_000000n;
    const frac = (n % 1_000000n).toString().padStart(6, '0');
    return `$${whole}.${frac} USDC`;
  } catch {
    return `${raw} (raw)`;
  }
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function statusIcon(status: string): string {
  switch (status) {
    case 'healthy': return '✓';
    case 'unhealthy': return '✗';
    case 'starting': return '⟳';
    default: return '?';
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdStatus(): Promise<void> {
  let data: StatusResponse;

  try {
    data = (await httpGet('/status')) as StatusResponse;
  } catch (err) {
    console.error(`\n[Dashboard] Cannot reach agent at ${BASE_URL}`);
    console.error(`           Is the agent running? (${(err as Error).message})\n`);
    process.exit(1);
  }

  const { health, metrics } = data;
  const tierLabel = TIER_LABELS[health.tier] ?? `TIER_${health.tier}`;
  const balanceFormatted = formatUsdcBalance(health.balanceUsdc);
  const uptimeFormatted = formatUptime(metrics.uptimeMs);
  const incomeFormatted = formatUsdcBalance(metrics.totalIncomeUsdc);

  console.log('\n══════════════════════════════════════════════');
  console.log('  Autonomous Income Node — Agent Status');
  console.log('══════════════════════════════════════════════');
  console.log(`  Overall:   ${health.overall.toUpperCase()}`);
  console.log(`  Wallet:    (use /identity endpoint)`);
  console.log(`  Tier:      ${tierLabel}`);
  console.log(`  Balance:   ${balanceFormatted}`);
  console.log(`  Uptime:    ${uptimeFormatted}`);
  console.log(`  Cycles:    ${metrics.cycleCount}`);
  console.log(`  Income:    ${incomeFormatted}`);
  console.log(`  Errors:    ${metrics.totalErrors}`);
  console.log(`  LLM:       ${health.llmAvailable ? 'available' : 'unavailable'}`);
  console.log('──────────────────────────────────────────────');
  console.log('  Modules:');

  const moduleEntries = Object.entries(health.modules);
  if (moduleEntries.length === 0) {
    console.log('    (none reported)');
  } else {
    for (const [name, entry] of moduleEntries) {
      const icon = statusIcon(entry.status);
      const fails =
        entry.consecutiveFailures && entry.consecutiveFailures > 0
          ? ` (${entry.consecutiveFailures} consecutive failures)`
          : '';
      console.log(`    [${icon}] ${name.padEnd(20)} ${entry.status}${fails}`);
    }
  }

  console.log('══════════════════════════════════════════════\n');
}

async function cmdBackup(): Promise<void> {
  console.log('\n[Dashboard] Requesting database backup...');

  try {
    const result = await httpPost('/backup');
    console.log('[Dashboard] Backup completed:', result);
  } catch (err) {
    console.error(`[Dashboard] Backup failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'status';

  switch (command) {
    case 'status':
      await cmdStatus();
      break;
    case 'backup':
      await cmdBackup();
      break;
    default:
      console.error(`\n[Dashboard] Unknown command: ${command}`);
      console.error('  Usage: node dist/dashboard/index.js <status|backup>\n');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('[Dashboard] Fatal error:', err);
  process.exit(1);
});
