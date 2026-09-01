/**
 * Shared TypeScript interfaces for the Config module.
 *
 * EnvConfig is the canonical typed representation of the validated environment
 * returned by validateEnv(). All other modules should import this type instead
 * of accessing process.env directly.
 *
 * Requirements: 1.5, 14.1, 14.4
 */

// ---------------------------------------------------------------------------
// EnvConfig — full typed, validated environment
// ---------------------------------------------------------------------------

/**
 * Typed representation of all environment variables used by the node.
 * All required fields are guaranteed to be non-empty strings / numbers after
 * validation; optional fields may be undefined.
 */
export interface EnvConfig {
  // ── Security / Wallet ────────────────────────────────────────────────────
  /** Password used to encrypt/decrypt the Ethereum keystore (AES-256). */
  WALLET_PASSWORD: string;

  // ── LLM Providers (at least one required) ───────────────────────────────
  /** Anthropic API key (sk-ant-...). Required if LLM_PROVIDER=anthropic. */
  ANTHROPIC_API_KEY?: string;
  /** OpenAI API key (sk-...). Required if LLM_PROVIDER=openai. */
  OPENAI_API_KEY?: string;

  // ── Blockchain RPC ───────────────────────────────────────────────────────
  /** Base/Ethereum mainnet RPC provider URL (Alchemy, Infura, etc.). */
  RPC_PROVIDER_URL: string;
  /** Optional testnet RPC URL (e.g. Base Sepolia). */
  RPC_PROVIDER_URL_TESTNET?: string;

  // ── LLM Configuration ────────────────────────────────────────────────────
  /** Model identifier, e.g. "claude-3-5-sonnet-20241022" or "gpt-4o". */
  LLM_MODEL: string;
  /** Which LLM provider to use. Determines which API key is required. */
  LLM_PROVIDER: 'anthropic' | 'openai';

  // ── Blockchain Identity ───────────────────────────────────────────────────
  /** EVM chain ID as string, e.g. "8453" for Base mainnet. */
  CHAIN_ID: string;
  /** Human-readable chain name, e.g. "base". */
  CHAIN_NAME: string;

  // ── Server Ports ─────────────────────────────────────────────────────────
  /** Port for the main HTTP API server (x402 + services). Default: 3000. */
  API_PORT: number;
  /** Port for the Prometheus-compatible metrics endpoint. Default: 9090. */
  METRICS_PORT: number;

  // ── ReAct Loop ────────────────────────────────────────────────────────────
  /** Milliseconds between ReAct loop cycles. Minimum: 1000. Default: 10000. */
  REACT_LOOP_INTERVAL_MS: number;
  /** Maximum number of concurrent actions per cycle. Default: 10. */
  REACT_LOOP_MAX_ACTIONS: number;
  /** LLM inference timeout in milliseconds. Default: 30000. */
  LLM_TIMEOUT_MS: number;

  // ── Runtime ───────────────────────────────────────────────────────────────
  /** Node.js environment mode. */
  NODE_ENV: 'development' | 'production' | 'test';

  // ── Storage Paths ─────────────────────────────────────────────────────────
  /** Path to the SQLite database file. Default: "./data/agent.db". */
  DB_PATH: string;
  /** Directory where encrypted keystore files are stored. Default: "./keys". */
  KEYS_PATH: string;
  /** Directory for SQLite database backups. Default: "./data/backups". */
  BACKUP_DIR: string;

  // ── Logging ───────────────────────────────────────────────────────────────
  /** Winston log level. Default: "info". */
  LOG_LEVEL: string;

  // ── Optional Integrations ─────────────────────────────────────────────────
  /** Redis connection URL. If omitted, the agent uses SQLite-only mode. */
  REDIS_URL?: string;

  // ── Social (Twitter/X) ────────────────────────────────────────────────────
  /** Twitter API key (OAuth 1.0a). */
  TWITTER_API_KEY?: string;
  /** Twitter API secret (OAuth 1.0a). */
  TWITTER_API_SECRET?: string;
  /** Twitter bearer token (OAuth 2.0 app-only). */
  TWITTER_BEARER_TOKEN?: string;
  /** Twitter access token (OAuth 1.0a user context). */
  TWITTER_ACCESS_TOKEN?: string;
  /** Twitter access secret (OAuth 1.0a user context). */
  TWITTER_ACCESS_SECRET?: string;

  // ── Docker / Replication ──────────────────────────────────────────────────
  /** Path to the Docker daemon socket. Default: "/var/run/docker.sock". */
  DOCKER_SOCKET_PATH?: string;
  /** Maximum number of active child agents. Default: 5. */
  MAX_CHILD_AGENTS: number;
}
