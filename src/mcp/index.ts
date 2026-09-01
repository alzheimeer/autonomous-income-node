/**
 * MCP layer barrel export.
 * Re-exports the generic client, error types, and all server schemas.
 */

// Client
export {
  McpClient,
  McpClientRegistry,
  validateSchema,
  ErrorCode,
} from './client/mcp-client.js';
export type {
  Result,
  AgentError,
  McpServerConfig,
  JSONSchemaObject,
} from './client/mcp-client.js';

// Schemas
export {
  MCP_SCHEMAS,
  TERMINAL_SCHEMAS,
  TRADING_SCHEMAS,
  WEB_SCHEMAS,
  LLM_SCHEMAS,
  DOCKER_SCHEMAS,
} from './schemas/index.js';
export type { McpServerName } from './schemas/index.js';
