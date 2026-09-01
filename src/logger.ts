/**
 * Structured JSON logger for Autonomous Income Node.
 *
 * - Winston output: JSON to stdout only (no file transports — Docker-friendly).
 * - Integrates maskSecrets from src/config/log-filter.ts as a Winston transform.
 * - Format: { "level": "info", "message": "...", "timestamp": "ISO", "module": "...", ...data }
 * - Levels: error, warn, info, debug
 * - Export: createLogger(module: string) → winston.Logger
 *
 * Requirements: 14.1, 15.5
 */

import winston from 'winston';
import { maskSecrets } from './config/log-filter.js';

// ---------------------------------------------------------------------------
// Secret-masking Winston transform
// ---------------------------------------------------------------------------

/**
 * Winston Transform that passes every log info object through maskSecrets.
 *
 * Applied to both the `message` field and any string-valued extra metadata
 * fields so that secrets embedded in arbitrary places are caught.
 */
const secretMaskTransform = winston.format((info) => {
  // Mask the message
  if (typeof info['message'] === 'string') {
    info['message'] = maskSecrets(info['message'] as string);
  }

  // Mask any extra string-valued metadata fields
  for (const key of Object.keys(info)) {
    if (key === 'message' || key === 'level' || key === 'timestamp') continue;
    const val = (info as Record<string, unknown>)[key];
    if (typeof val === 'string') {
      (info as Record<string, unknown>)[key] = maskSecrets(val);
    } else if (typeof val === 'object' && val !== null) {
      // Stringify nested objects for masking, then re-parse
      try {
        const masked = maskSecrets(JSON.stringify(val));
        (info as Record<string, unknown>)[key] = JSON.parse(masked) as unknown;
      } catch {
        // If JSON round-trip fails, leave the value as-is
      }
    }
  }

  return info;
})();

// ---------------------------------------------------------------------------
// JSON format for stdout
// ---------------------------------------------------------------------------

const jsonFormat = winston.format.combine(
  winston.format.timestamp({ format: () => new Date().toISOString() }),
  secretMaskTransform,
  winston.format.json(),
);

// ---------------------------------------------------------------------------
// Log level from environment
// ---------------------------------------------------------------------------

function resolveLogLevel(): string {
  const envLevel = process.env['LOG_LEVEL'];
  const validLevels = ['error', 'warn', 'info', 'debug', 'verbose'];
  if (envLevel && validLevels.includes(envLevel)) return envLevel;
  return process.env['NODE_ENV'] === 'production' ? 'info' : 'debug';
}

// ---------------------------------------------------------------------------
// createLogger
// ---------------------------------------------------------------------------

/**
 * Create a Winston logger scoped to a named module.
 *
 * Every log line includes a `module` field so entries can be filtered by
 * source in log aggregators (e.g. Docker / Datadog).
 *
 * @param module - Human-readable module name (e.g. `'identity'`, `'trading'`).
 * @returns A configured Winston Logger instance.
 *
 * @example
 * ```ts
 * import { createLogger } from '../logger.js';
 * const log = createLogger('identity');
 * log.info('Wallet loaded', { address: '0x…' });
 * // stdout: {"level":"info","message":"Wallet loaded","module":"identity","address":"0x…","timestamp":"…"}
 * ```
 */
export function createLogger(module: string): winston.Logger {
  return winston.createLogger({
    level: resolveLogLevel(),
    defaultMeta: { module },
    format: jsonFormat,
    transports: [
      new winston.transports.Console({
        // Ensure stdout (not stderr) — important for Docker log drivers
        stderrLevels: [],
      }),
    ],
    // Do not exit on uncaught exceptions automatically
    exitOnError: false,
  });
}

// ---------------------------------------------------------------------------
// Root / default logger
// ---------------------------------------------------------------------------

/**
 * Root logger for code that doesn't have a specific module context.
 * Prefer `createLogger('myModule')` in production code.
 */
export const logger = createLogger('root');

// ---------------------------------------------------------------------------
// Re-export maskSecrets for convenience
// ---------------------------------------------------------------------------

export { maskSecrets } from './config/log-filter.js';
