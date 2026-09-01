/**
 * Generic MCP client wrapper.
 *
 * Responsibilities (Requirements 13.6, 13.7, 13.8):
 *  1. Validate tool input against the tool's registered JSON Schema before
 *     invoking the MCP server. Returns Result<never, AgentError> with code
 *     MCP_VALIDATION_ERROR when validation fails — the server is NOT called.
 *  2. Invoke the tool via the @modelcontextprotocol/sdk Client over stdio.
 *  3. Return structured Result<T, AgentError> — no unhandled exceptions
 *     ever propagate to the ReAct loop.
 *  4. Log every invocation (input summary, output summary, latency, success)
 *     to the `mcp_invocations` SQLite table via McpInvocationsRepository.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { v4 as uuidv4 } from 'uuid';

import type { McpInvocationsRepository } from '../../state/repositories/mcp-invocations.repo.js';

// ---------------------------------------------------------------------------
// Re-exported base types (used by schema files)
// ---------------------------------------------------------------------------

/** Minimal JSON Schema object type used for tool input schemas. */
export interface JSONSchemaObject {
  type?: string | string[];
  properties?: Record<string, JSONSchemaObject>;
  required?: string[];
  additionalProperties?: boolean | JSONSchemaObject;
  items?: JSONSchemaObject;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minProperties?: number;
  maxProperties?: number;
  pattern?: string;
  format?: string;
  default?: unknown;
  description?: string;
  $ref?: string;
  allOf?: JSONSchemaObject[];
  anyOf?: JSONSchemaObject[];
  oneOf?: JSONSchemaObject[];
  not?: JSONSchemaObject;
}

// ---------------------------------------------------------------------------
// Result<T, E> pattern
// ---------------------------------------------------------------------------

export type Result<T, E = AgentError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export enum ErrorCode {
  MCP_VALIDATION_ERROR = 'MCP_VALIDATION_ERROR',
  MCP_TOOL_ERROR = 'MCP_TOOL_ERROR',
  MCP_CONNECTION_ERROR = 'MCP_CONNECTION_ERROR',
  MCP_TIMEOUT_ERROR = 'MCP_TIMEOUT_ERROR',
  LLM_TIMEOUT = 'LLM_TIMEOUT',
  LLM_RATE_LIMIT = 'LLM_RATE_LIMIT',
  TX_REVERT = 'TX_REVERT',
  INSUFFICIENT_GAS = 'INSUFFICIENT_GAS',
  PAYMENT_INVALID = 'PAYMENT_INVALID',
  DB_UNAVAILABLE = 'DB_UNAVAILABLE',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  TIER_GATE_DENIED = 'TIER_GATE_DENIED',
  SANDBOX_TEST_FAILURE = 'SANDBOX_TEST_FAILURE',
}

export interface AgentError {
  code: ErrorCode;
  message: string;
  module: string;
  retryable: boolean;
  context?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Lightweight JSON Schema validator.
 *
 * Covers the subset used by our MCP tool schemas:
 *  type, required, additionalProperties, properties (recursive),
 *  minimum/maximum, minLength/maxLength, minProperties, enum, pattern.
 *
 * For production, this could be replaced with ajv; we use a dependency-free
 * implementation to keep the MCP layer self-contained.
 */
export function validateSchema(
  value: unknown,
  schema: JSONSchemaObject,
  path = 'input'
): ValidationResult {
  const errors: string[] = [];

  // --- type check ---
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    // Derive the JSON Schema type name of the actual value
    const getJsonType = (v: unknown): string => {
      if (v === null) return 'null';
      if (Array.isArray(v)) return 'array';
      return typeof v;
    };
    const actual = getJsonType(value);
    // JSON Schema "integer" maps to typeof === 'number' with integer constraint
    const typeMatch = types.some((t) =>
      t === 'integer' ? Number.isInteger(value) : t === actual
    );
    if (!typeMatch) {
      errors.push(`${path}: expected type ${types.join('|')}, got ${actual}`);
      // Can't validate further if the type is wrong
      return { valid: false, errors };
    }
  }

  // --- enum check ---
  if (schema.enum !== undefined) {
    if (!schema.enum.includes(value)) {
      errors.push(
        `${path}: value must be one of [${schema.enum.map((e) => JSON.stringify(e)).join(', ')}]`
      );
    }
  }

  // --- string constraints ---
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: string length ${value.length} < minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: string length ${value.length} > maxLength ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined) {
      const re = new RegExp(schema.pattern);
      if (!re.test(value)) {
        errors.push(`${path}: string does not match pattern ${schema.pattern}`);
      }
    }
  }

  // --- number constraints ---
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: value ${value} < minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: value ${value} > maximum ${schema.maximum}`);
    }
  }

  // --- object constraints ---
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const objKeys = Object.keys(obj);

    // minProperties
    if (schema.minProperties !== undefined && objKeys.length < schema.minProperties) {
      errors.push(
        `${path}: object has ${objKeys.length} properties, minimum is ${schema.minProperties}`
      );
    }

    // required fields
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          errors.push(`${path}: missing required field "${key}"`);
        }
      }
    }

    // additionalProperties = false
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of objKeys) {
        if (!allowed.has(key)) {
          errors.push(`${path}: additional property "${key}" is not allowed`);
        }
      }
    }

    // recursive property validation
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          const nested = validateSchema(obj[key], propSchema, `${path}.${key}`);
          errors.push(...nested.errors);
        }
      }
    }

    // additionalProperties as schema (e.g. { type: 'string' })
    if (
      schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties === 'object' &&
      schema.additionalProperties !== null
    ) {
      const allowedKeys = new Set(Object.keys(schema.properties ?? {}));
      for (const key of objKeys) {
        if (!allowedKeys.has(key)) {
          const nested = validateSchema(
            obj[key],
            schema.additionalProperties as JSONSchemaObject,
            `${path}.${key}`
          );
          errors.push(...nested.errors);
        }
      }
    }
  }

  // --- array constraints ---
  if (Array.isArray(value)) {
    if (schema.items) {
      value.forEach((item, i) => {
        const nested = validateSchema(item, schema.items!, `${path}[${i}]`);
        errors.push(...nested.errors);
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// McpServerConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for a single MCP server process (stdio transport).
 */
export interface McpServerConfig {
  /** Display name for logging, e.g. "terminal" */
  serverName: string;
  /** Path to the server executable / script */
  command: string;
  /** CLI arguments for the server process */
  args?: string[];
  /** Extra environment variables for the server process */
  env?: Record<string, string>;
  /** Tool input schemas indexed by tool name */
  schemas: Record<string, JSONSchemaObject>;
}

// ---------------------------------------------------------------------------
// McpClient
// ---------------------------------------------------------------------------

/**
 * Generic MCP client for a single server process.
 *
 * Usage:
 *   const client = new McpClient(config, mcpInvocationsRepo);
 *   await client.connect();
 *   const result = await client.callTool('execute_command', { command: 'ls' });
 *   await client.disconnect();
 */
export class McpClient {
  private readonly serverName: string;
  private readonly schemas: Record<string, JSONSchemaObject>;
  private readonly repo: McpInvocationsRepository | null;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connected = false;

  private readonly command: string;
  private readonly args: string[];
  private readonly env: Record<string, string>;

  constructor(
    config: McpServerConfig,
    /** Pass a McpInvocationsRepository to enable SQLite logging. Pass null to disable (e.g. in tests). */
    invocationsRepo: McpInvocationsRepository | null = null
  ) {
    this.serverName = config.serverName;
    this.schemas = config.schemas;
    this.repo = invocationsRepo;
    this.command = config.command;
    this.args = config.args ?? [];
    this.env = config.env ?? {};
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  /** Connect to the MCP server process via stdio. */
  async connect(): Promise<Result<void>> {
    if (this.connected) {
      return { ok: true, value: undefined };
    }

    try {
      this.transport = new StdioClientTransport({
        command: this.command,
        args: this.args,
        env: { ...process.env, ...this.env } as Record<string, string>,
      });

      this.client = new Client(
        { name: 'autonomous-income-node', version: '0.1.0' },
        { capabilities: {} }
      );

      await this.client.connect(this.transport);
      this.connected = true;
      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: ErrorCode.MCP_CONNECTION_ERROR,
          message: `Failed to connect to MCP server "${this.serverName}": ${String(err)}`,
          module: 'mcp',
          retryable: true,
          context: { serverName: this.serverName, command: this.command },
        },
      };
    }
  }

  /** Disconnect from the MCP server process and clean up. */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      try {
        await this.client.close();
      } catch {
        // Ignore errors during disconnect
      }
    }
    this.connected = false;
    this.client = null;
    this.transport = null;
  }

  // ---------------------------------------------------------------------------
  // Tool invocation
  // ---------------------------------------------------------------------------

  /**
   * Validate input against the registered JSON Schema, then call the MCP tool.
   *
   * Returns:
   *   - `{ ok: true, value: T }` on success
   *   - `{ ok: false, error: { code: MCP_VALIDATION_ERROR } }` if input fails schema
   *   - `{ ok: false, error: { code: MCP_TOOL_ERROR } }` if the tool itself fails
   *   - `{ ok: false, error: { code: MCP_CONNECTION_ERROR } }` if not connected
   *
   * Never throws — all exceptions are caught and returned as `{ ok: false }`.
   * Requirement: 13.6, 13.7, 13.8
   */
  async callTool<T = unknown>(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<Result<T>> {
    const startMs = Date.now();
    let success = false;
    let outputSummary: string | undefined;
    let errorMsg: string | undefined;

    // --- Schema validation (Requirement 13.8) ---
    const schema = this.schemas[toolName];
    if (!schema) {
      const error: AgentError = {
        code: ErrorCode.MCP_VALIDATION_ERROR,
        message: `No schema registered for tool "${toolName}" on server "${this.serverName}"`,
        module: 'mcp',
        retryable: false,
        context: { serverName: this.serverName, toolName },
      };
      await this.logInvocation(toolName, input, startMs, false, undefined, error.message);
      return { ok: false, error };
    }

    const validation = validateSchema(input, schema);
    if (!validation.valid) {
      const error: AgentError = {
        code: ErrorCode.MCP_VALIDATION_ERROR,
        message: `Input validation failed for tool "${toolName}": ${validation.errors.join('; ')}`,
        module: 'mcp',
        retryable: false,
        context: {
          serverName: this.serverName,
          toolName,
          validationErrors: validation.errors,
        },
      };
      await this.logInvocation(toolName, input, startMs, false, undefined, error.message);
      return { ok: false, error };
    }

    // --- Connection check ---
    if (!this.connected || !this.client) {
      const error: AgentError = {
        code: ErrorCode.MCP_CONNECTION_ERROR,
        message: `McpClient for server "${this.serverName}" is not connected. Call connect() first.`,
        module: 'mcp',
        retryable: true,
        context: { serverName: this.serverName, toolName },
      };
      await this.logInvocation(toolName, input, startMs, false, undefined, error.message);
      return { ok: false, error };
    }

    // --- Tool invocation (Requirement 13.6) ---
    try {
      // LLM inference tools (e.g. 'infer') can take 60–120s for code generation.
      // Pass a 120s timeout so the MCP SDK doesn't fire -32001 prematurely.
      const isLlmTool = toolName === 'infer';
      const sdkResult = await this.client.callTool(
        { name: toolName, arguments: input },
        undefined,
        isLlmTool ? { timeout: 120_000 } : undefined,
      );

      // The MCP SDK returns { content: Array<{type, text|data|...}> }
      // We unwrap the first text content item as the typed value, or return
      // the whole content array if it can't be reduced to a single value.
      let value: unknown;

      if (
        sdkResult.content &&
        Array.isArray(sdkResult.content) &&
        sdkResult.content.length > 0
      ) {
        const firstContent = sdkResult.content[0] as { type: string; text?: string };
        if (firstContent.type === 'text' && typeof firstContent.text === 'string') {
          try {
            value = JSON.parse(firstContent.text);
          } catch {
            value = firstContent.text;
          }
        } else {
          value = sdkResult.content;
        }
      } else {
        value = sdkResult.content ?? null;
      }

      success = true;
      outputSummary = truncate(JSON.stringify(value), 500);
      await this.logInvocation(toolName, input, startMs, true, outputSummary, undefined);
      return { ok: true, value: value as T };
    } catch (err) {
      errorMsg = String(err);
      const error: AgentError = {
        code: ErrorCode.MCP_TOOL_ERROR,
        message: `MCP tool "${toolName}" on server "${this.serverName}" failed: ${errorMsg}`,
        module: 'mcp',
        retryable: isRetryableError(err),
        context: { serverName: this.serverName, toolName },
      };
      await this.logInvocation(toolName, input, startMs, false, undefined, errorMsg);
      return { ok: false, error };
    }

    void success; // referenced in logInvocation
    void outputSummary;
    void errorMsg;
  }

  // ---------------------------------------------------------------------------
  // Logging
  // ---------------------------------------------------------------------------

  /**
   * Persist an invocation record to `mcp_invocations` via the repository.
   * Silently swallows logging errors — a log failure must never crash the agent.
   * Requirement: 13.7
   */
  private async logInvocation(
    toolName: string,
    input: Record<string, unknown>,
    startMs: number,
    success: boolean,
    outputSummary: string | undefined,
    errorMsg: string | undefined
  ): Promise<void> {
    if (!this.repo) return;

    try {
      const latencyMs = Date.now() - startMs;
      const inputSummary = truncate(JSON.stringify(sanitizeInput(input)), 500);

      this.repo.insert({
        id: uuidv4(),
        server: this.serverName,
        tool: toolName,
        inputSummary,
        outputSummary,
        success,
        latencyMs,
        error: errorMsg,
        invokedAt: startMs,
      });
    } catch {
      // Logging is best-effort — never propagate
    }
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  get isConnected(): boolean {
    return this.connected;
  }

  get name(): string {
    return this.serverName;
  }
}

// ---------------------------------------------------------------------------
// McpClientRegistry
// ---------------------------------------------------------------------------

/**
 * Registry that holds one McpClient per server name.
 * Modules retrieve clients by server name instead of managing their own connections.
 */
export class McpClientRegistry {
  private readonly clients = new Map<string, McpClient>();

  register(client: McpClient): void {
    this.clients.set(client.name, client);
  }

  get(serverName: string): McpClient | undefined {
    return this.clients.get(serverName);
  }

  /** Connect all registered clients. Returns a map of serverName → Result. */
  async connectAll(): Promise<Record<string, Result<void>>> {
    const results: Record<string, Result<void>> = {};
    await Promise.all(
      [...this.clients.entries()].map(async ([name, client]) => {
        results[name] = await client.connect();
      })
    );
    return results;
  }

  /** Disconnect all registered clients gracefully. */
  async disconnectAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.disconnect()));
  }

  get size(): number {
    return this.clients.size;
  }

  getAll(): ReadonlyMap<string, McpClient> {
    return this.clients;
  }
}

// ---------------------------------------------------------------------------
// Private utility helpers
// ---------------------------------------------------------------------------

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
}

/**
 * Remove known secret-like keys from an input object before logging.
 * This prevents accidental persistence of API keys, private keys, etc.
 * Requirement: 14.1
 */
function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const SECRET_KEYS = new Set([
    'apiKey', 'api_key', 'privateKey', 'private_key',
    'password', 'secret', 'token', 'mnemonic', 'walletPassword',
    'wallet_password', 'encryptedKey', 'encrypted_key',
  ]);

  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    sanitized[k] = SECRET_KEYS.has(k) ? '[REDACTED]' : v;
  }
  return sanitized;
}

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('epipe') ||
    msg.includes('network')
  );
}
