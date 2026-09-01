#!/usr/bin/env node
/**
 * @ain/cli — CLI for the Autonomous Income Node
 *
 * Commands:
 *   status   → GET /status  — show wallet, tier, balance, uptime, modules
 *   logs     → GET /logs    — stream recent log lines (last 50)
 *   fund     → POST /fund   — send USDC top-up request to the agent
 *
 * Uses the agent REST API exposed by HeartbeatModule on API_PORT (default: 3000).
 *
 * Requirements: 15.7
 */

import axios, { type AxiosError } from 'axios';
import { config as loadDotenv } from 'dotenv';

// Load .env from the monorepo root (two levels up from packages/cli)
loadDotenv({ path: new URL('../../../.env', import.meta.url).pathname });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_PORT = process.env['API_PORT'] ?? '3000';
const BASE_URL = `http://127.0.0.1:${API_PORT}`;
const TIMEOUT_MS = 8_000;

const client = axios.create({
  baseURL: BASE_URL,
  timeout: TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json' },
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ModuleHealth {
  status: string;
  consecutiveFailures?: number;
  lastCheck?: number;
}

interface StatusResponse {
  health: {
    overall: string;
    tier: number;
    balanceUsdc: string;
    llmAvailable: boolean;
    modules: Record<string, ModuleHealth>;
    timestamp: number;
  };
  metrics: {
    uptimeMs: number;
    cycleCount: number;
    totalIncomeUsdc: string;
    totalErrors: number;
  };
  children?: Array<{
    id: string;
    walletAddress: string;
    status: string;
    spawnedAt: number;
  }>;
}

interface LogsResponse {
  lines: string[];
  total: number;
}

interface FundResponse {
  ok: boolean;
  txHash?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const TIER_LABELS: Record<number, string> = {
  0: 'EMERGENCY (< $0)',
  1: 'TIER_1    (< $10)',
  2: 'TIER_2    ($10 – $99)',
  3: 'TIER_3    ($100 – $999)',
  4: 'TIER_4    (> $1,000)',
};

function formatUsdc(raw: string): string {
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
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function statusIcon(s: string): string {
  if (s === 'healthy') return '✓';
  if (s === 'unhealthy') return '✗';
  return '~';
}

// ---------------------------------------------------------------------------
// Command: status
// ---------------------------------------------------------------------------

async function cmdStatus(): Promise<void> {
  let data: StatusResponse;
  try {
    const res = await client.get<StatusResponse>('/status');
    data = res.data;
  } catch (err) {
    handleNetworkError(err);
    return;
  }

  const { health, metrics, children } = data;
  const tier = TIER_LABELS[health.tier] ?? `TIER_${health.tier}`;

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  Autonomous Income Node — CLI Status             ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Health:  ${health.overall.toUpperCase().padEnd(40)}║`);
  console.log(`║  Tier:    ${tier.padEnd(40)}║`);
  console.log(`║  Balance: ${formatUsdc(health.balanceUsdc).padEnd(40)}║`);
  console.log(`║  Uptime:  ${formatUptime(metrics.uptimeMs).padEnd(40)}║`);
  console.log(`║  Cycles:  ${String(metrics.cycleCount).padEnd(40)}║`);
  console.log(`║  Income:  ${formatUsdc(metrics.totalIncomeUsdc).padEnd(40)}║`);
  console.log(`║  Errors:  ${String(metrics.totalErrors).padEnd(40)}║`);
  console.log(`║  LLM:     ${(health.llmAvailable ? 'available' : 'unavailable').padEnd(40)}║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Modules:                                        ║');

  for (const [name, mod] of Object.entries(health.modules)) {
    const icon = statusIcon(mod.status);
    const line = `  [${icon}] ${name.padEnd(18)} ${mod.status}`;
    console.log(`║${line.padEnd(50)}║`);
  }

  if (children && children.length > 0) {
    console.log('╠══════════════════════════════════════════════════╣');
    console.log('║  Child Agents:                                   ║');
    for (const c of children) {
      const line = `  ${c.walletAddress.slice(0, 14)}…  [${c.status}]`;
      console.log(`║${line.padEnd(50)}║`);
    }
  }

  console.log('╚══════════════════════════════════════════════════╝\n');
}

// ---------------------------------------------------------------------------
// Command: logs
// ---------------------------------------------------------------------------

async function cmdLogs(): Promise<void> {
  try {
    const res = await client.get<LogsResponse>('/logs');
    const { lines } = res.data;

    if (!lines || lines.length === 0) {
      console.log('\n[AIN CLI] No log lines available.\n');
      return;
    }

    console.log(`\n[AIN CLI] Last ${lines.length} log lines:\n`);
    for (const line of lines) {
      console.log(line);
    }
    console.log('');
  } catch (err) {
    const axErr = err as AxiosError;
    if (axErr.response?.status === 404) {
      console.warn('[AIN CLI] /logs endpoint not yet available on this agent version.');
    } else {
      handleNetworkError(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Command: fund
// ---------------------------------------------------------------------------

async function cmdFund(): Promise<void> {
  const amountArg = process.argv[3];
  const addressArg = process.argv[4];

  if (!amountArg || !addressArg) {
    console.error('\n[AIN CLI] Usage: ain fund <amount_usdc> <from_address>');
    console.error('  Example: ain fund 50 0xYourAddress\n');
    process.exit(1);
  }

  const amountUsdc = parseFloat(amountArg);
  if (isNaN(amountUsdc) || amountUsdc <= 0) {
    console.error('[AIN CLI] Invalid amount. Must be a positive number (e.g. 50).');
    process.exit(1);
  }

  console.log(`\n[AIN CLI] Requesting funding: ${amountUsdc} USDC from ${addressArg}...`);

  try {
    const res = await client.post<FundResponse>('/fund', {
      amountUsdc: amountUsdc.toString(),
      fromAddress: addressArg,
    });

    const data = res.data;
    if (data.ok) {
      console.log(`[AIN CLI] Fund request submitted.${data.txHash ? ` TxHash: ${data.txHash}` : ''}\n`);
    } else {
      console.error(`[AIN CLI] Fund request rejected: ${data.error ?? 'unknown error'}\n`);
      process.exit(1);
    }
  } catch (err) {
    const axErr = err as AxiosError;
    if (axErr.response?.status === 404) {
      console.warn('[AIN CLI] /fund endpoint not yet available on this agent version.');
    } else {
      handleNetworkError(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

function handleNetworkError(err: unknown): void {
  const axErr = err as AxiosError;
  if (axErr.code === 'ECONNREFUSED' || axErr.code === 'ENOTFOUND') {
    console.error(`\n[AIN CLI] Cannot connect to agent at ${BASE_URL}`);
    console.error('           Is the agent running? Check API_PORT in .env\n');
  } else if (axErr.code === 'ECONNABORTED') {
    console.error(`\n[AIN CLI] Request timed out (${TIMEOUT_MS}ms). Agent may be busy.\n`);
  } else {
    console.error('\n[AIN CLI] Request failed:', (err as Error).message, '\n');
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const COMMANDS: Record<string, () => Promise<void>> = {
  status: cmdStatus,
  logs: cmdLogs,
  fund: cmdFund,
};

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'status';

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`\n[AIN CLI] Unknown command: "${command}"`);
    console.error(`  Available commands: ${Object.keys(COMMANDS).join(', ')}\n`);
    process.exit(1);
  }

  await handler();
}

main().catch((err) => {
  console.error('[AIN CLI] Fatal error:', err);
  process.exit(1);
});
