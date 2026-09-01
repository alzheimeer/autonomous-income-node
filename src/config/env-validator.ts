/**
 * Environment variable validator for Autonomous Income Node.
 *
 * Loads .env via dotenv, then validates all required/optional variables
 * using Zod. Halts with a descriptive error and process.exit(1) if any
 * required variable is missing or malformed.
 *
 * Usage:
 *   import { validateEnv } from '@config/env-validator.js';
 *   const config = validateEnv(); // throws + exits on failure
 *
 * Requirements: 1.5, 14.4
 */

import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';
import type { EnvConfig } from './types.js';

// ---------------------------------------------------------------------------
// Load .env (silently ignored if the file doesn't exist — e.g. in Docker
// where vars are injected directly into the environment)
// ---------------------------------------------------------------------------

loadDotenv();

// ---------------------------------------------------------------------------
// Zod schema — maps process.env strings → EnvConfig
// ---------------------------------------------------------------------------

/**
 * All env var values arrive as strings from process.env; Zod coerces numeric
 * fields with .transform(Number) so the returned EnvConfig has the correct
 * TypeScript types.
 */
const EnvSchema = z
  .object({
    // ── Security / Wallet ─────────────────────────────────────────────────
    WALLET_PASSWORD: z.string().min(1, 'WALLET_PASSWORD must not be empty'),

    // ── LLM providers (at least one required — validated in superRefine) ──
    // Empty strings from .env are treated as absent (same as undefined)
    ANTHROPIC_API_KEY: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
    OPENAI_API_KEY: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),

    // ── Blockchain RPC ────────────────────────────────────────────────────
    RPC_PROVIDER_URL: z
      .string()
      .url('RPC_PROVIDER_URL must be a valid URL')
      .min(1, 'RPC_PROVIDER_URL must not be empty'),
    RPC_PROVIDER_URL_FALLBACK: z.string().url().optional(),
    RPC_PROVIDER_URL_TESTNET: z.string().url().optional(),

    // ── LLM configuration ─────────────────────────────────────────────────
    LLM_MODEL: z
      .string()
      .min(1, 'LLM_MODEL must not be empty')
      .default('deepseek-v4-flash'),
    LLM_PROVIDER: z
      .enum(['anthropic', 'openai', 'deepseek', 'qwen', 'ollama'])
      .default('openai'),

    // ── Blockchain identity ───────────────────────────────────────────────
    CHAIN_ID: z
      .string()
      .min(1, 'CHAIN_ID must not be empty')
      .default('8453'),
    CHAIN_NAME: z
      .string()
      .min(1, 'CHAIN_NAME must not be empty')
      .default('base'),

    // ── Server ports ──────────────────────────────────────────────────────
    API_PORT: z
      .string()
      .regex(/^\d+$/, 'API_PORT must be a positive integer')
      .default('3000')
      .transform(Number),
    METRICS_PORT: z
      .string()
      .regex(/^\d+$/, 'METRICS_PORT must be a positive integer')
      .default('9090')
      .transform(Number),

    // ── ReAct loop ────────────────────────────────────────────────────────
    REACT_LOOP_INTERVAL_MS: z
      .string()
      .regex(/^\d+$/, 'REACT_LOOP_INTERVAL_MS must be a positive integer')
      .default('10000')
      .transform(Number),

    REACT_LOOP_MAX_ACTIONS: z
      .string()
      .regex(/^\d+$/, 'REACT_LOOP_MAX_ACTIONS must be a positive integer')
      .default('10')
      .transform(Number),
    LLM_TIMEOUT_MS: z
      .string()
      .regex(/^\d+$/, 'LLM_TIMEOUT_MS must be a positive integer')
      .default('30000')
      .transform(Number),

    // ── Runtime ───────────────────────────────────────────────────────────
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),

    // ── Storage paths ─────────────────────────────────────────────────────
    DB_PATH: z.string().default('./data/agent.db'),
    KEYS_PATH: z.string().default('./keys'),
    BACKUP_DIR: z.string().default('./data/backups'),

    // ── Logging ───────────────────────────────────────────────────────────
    LOG_LEVEL: z
      .enum(['error', 'warn', 'info', 'debug', 'verbose'])
      .default('info'),

    // ── Optional integrations ─────────────────────────────────────────────
    REDIS_URL: z.string().optional(),

    // ── Social ────────────────────────────────────────────────────────────
    TWITTER_API_KEY: z.string().optional(),
    TWITTER_API_SECRET: z.string().optional(),
    TWITTER_BEARER_TOKEN: z.string().optional(),
    TWITTER_ACCESS_TOKEN: z.string().optional(),
    TWITTER_ACCESS_SECRET: z.string().optional(),

    // ── Docker / Replication ──────────────────────────────────────────────
    DOCKER_SOCKET_PATH: z.string().optional(),
    MAX_CHILD_AGENTS: z
      .string()
      .regex(/^\d+$/, 'MAX_CHILD_AGENTS must be a positive integer')
      .default('5')
      .transform(Number),
  })
  .superRefine((data, ctx) => {
    // Ollama y DeepSeek no requieren ANTHROPIC_API_KEY ni OPENAI_API_KEY
    const isLocal = data.LLM_PROVIDER === 'ollama';
    const isDeepSeekOrQwen = data.LLM_PROVIDER === 'deepseek' || data.LLM_PROVIDER === 'qwen';

    // At least one LLM provider key must be set (excepto ollama que es local)
    if (!isLocal && !isDeepSeekOrQwen && !data.ANTHROPIC_API_KEY && !data.OPENAI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'At least one LLM provider key is required: set ANTHROPIC_API_KEY or OPENAI_API_KEY (or use LLM_PROVIDER=ollama/deepseek).',
        path: ['ANTHROPIC_API_KEY'],
      });
    }

    // LLM_PROVIDER=anthropic requiere ANTHROPIC_API_KEY
    if (data.LLM_PROVIDER === 'anthropic' && !data.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'LLM_PROVIDER=anthropic requiere ANTHROPIC_API_KEY.',
        path: ['ANTHROPIC_API_KEY'],
      });
    }

    // LLM_PROVIDER=openai requiere OPENAI_API_KEY (DeepSeek/Qwen usan OPENAI_API_KEY también)
    if ((data.LLM_PROVIDER === 'openai' || isDeepSeekOrQwen) && !data.OPENAI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `LLM_PROVIDER=${data.LLM_PROVIDER} requiere OPENAI_API_KEY (la API key de DeepSeek/Qwen va en OPENAI_API_KEY).`,
        path: ['OPENAI_API_KEY'],
      });
    }

    // REACT_LOOP_INTERVAL_MS must be >= 1000 per Requirement 2.1
    const interval =
      typeof data.REACT_LOOP_INTERVAL_MS === 'string'
        ? Number(data.REACT_LOOP_INTERVAL_MS)
        : (data.REACT_LOOP_INTERVAL_MS as unknown as number);
    if (!isNaN(interval) && interval < 1000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'REACT_LOOP_INTERVAL_MS must be at least 1000 ms (Requirement 2.1).',
        path: ['REACT_LOOP_INTERVAL_MS'],
      });
    }
  });

// ---------------------------------------------------------------------------
// Exported function
// ---------------------------------------------------------------------------

/**
 * Validates `process.env` against the full EnvConfig schema.
 *
 * - Loads .env via dotenv before validation.
 * - Returns the fully typed and coerced {@link EnvConfig} on success.
 * - Throws an {@link Error} with a descriptive bullet-list of issues on failure.
 *   Callers in production entry points should catch this and call
 *   `process.exit(1)` (or let the top-level handler do it).
 *
 * @throws {Error} Descriptive validation error listing every missing /
 *   invalid variable.
 * @returns Validated, typed {@link EnvConfig} object.
 */
export function validateEnv(): EnvConfig {
  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const field = issue.path.join('.') || 'unknown';
        return `  • ${field}: ${issue.message}`;
      })
      .join('\n');

    throw new Error(
      `[Config] Environment validation failed. The following variables are missing or invalid:\n${issues}\n\n` +
        `Please check your .env file or environment configuration.\n` +
        `See .env.example for reference.`,
    );
  }

  // Cast via unknown: Zod infers numeric transforms but our EnvConfig uses
  // number types directly; the shapes are structurally identical.
  return result.data as unknown as EnvConfig;
}
