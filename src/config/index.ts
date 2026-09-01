/**
 * Config module barrel export.
 *
 * Re-exports:
 *  - EnvConfig                    → typed interface for all env variables
 *  - validateEnv                  → Zod-based env var validation with dotenv loading
 *  - ConfigStore                  → AES-256-GCM keystore encryption + file watcher
 *  - maskSecrets / safeStringify  → log filter to prevent secret leakage
 *  - createLogger / logger        → Winston JSON logger with secret masking (Task 18.1)
 *
 * Usage:
 *   import { validateEnv, ConfigStore, maskSecrets, createLogger } from '@config/index.js'
 */

export type { EnvConfig } from './types.js';
export * from './env-validator.js';
export * from './config-store.js';
export * from './log-filter.js';
export { createLogger, logger } from './logger.js';
