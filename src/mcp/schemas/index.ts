/**
 * Barrel export for all MCP tool JSON Schemas.
 * Maps each server name and tool name to its JSONSchema definition.
 * Requirements: 13.8
 */

export { TERMINAL_SCHEMAS, executeCommandSchema, runTestsSchema } from './terminal.schema.js';
export { TRADING_SCHEMAS, getQuoteSchema, executeSwapSchema } from './trading.schema.js';
export { WEB_SCHEMAS, fetchPageSchema, extractDataSchema, getJsonSchema } from './web.schema.js';
export { LLM_SCHEMAS, inferSchema } from './llm.schema.js';
export { DOCKER_SCHEMAS, provisionContainerSchema, inspectContainerSchema, stopContainerSchema } from './docker.schema.js';

import type { JSONSchemaObject } from '../client/mcp-client.js';
import { TERMINAL_SCHEMAS } from './terminal.schema.js';
import { TRADING_SCHEMAS } from './trading.schema.js';
import { WEB_SCHEMAS } from './web.schema.js';
import { LLM_SCHEMAS } from './llm.schema.js';
import { DOCKER_SCHEMAS } from './docker.schema.js';

/** Server name literal type, matching the 5 MCP servers in the design. */
export type McpServerName = 'terminal' | 'trading' | 'web' | 'llm' | 'docker';

/**
 * Complete registry: serverName → toolName → JSONSchema.
 * Used by McpClient to validate inputs before invoking any tool.
 */
export const MCP_SCHEMAS: Record<McpServerName, Record<string, JSONSchemaObject>> = {
  terminal: TERMINAL_SCHEMAS,
  trading: TRADING_SCHEMAS,
  web: WEB_SCHEMAS,
  llm: LLM_SCHEMAS,
  docker: DOCKER_SCHEMAS,
};
