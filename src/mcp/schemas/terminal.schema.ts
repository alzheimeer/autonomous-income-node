/**
 * JSON Schema definitions for the MCP Terminal / Sandbox server tools.
 * Requirements: 13.1, 13.8
 */

import type { JSONSchemaObject } from '../client/mcp-client.js';

// ---------------------------------------------------------------------------
// execute_command
// ---------------------------------------------------------------------------

export const executeCommandSchema: JSONSchemaObject = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      minLength: 1,
      description: 'Shell command to execute inside the sandbox',
    },
    cwd: {
      type: 'string',
      description: 'Working directory for the command (absolute or relative path)',
    },
    timeoutMs: {
      type: 'number',
      minimum: 100,
      maximum: 300_000,
      default: 30_000,
      description: 'Maximum execution time in milliseconds',
    },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Additional environment variables to inject',
    },
  },
  required: ['command'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// run_tests
// ---------------------------------------------------------------------------

export const runTestsSchema: JSONSchemaObject = {
  type: 'object',
  properties: {
    modulePath: {
      type: 'string',
      minLength: 1,
      description: 'Absolute or relative path to the module whose tests should run',
    },
    testPattern: {
      type: 'string',
      default: '**/*.test.ts',
      description: 'Glob pattern to match test files',
    },
  },
  required: ['modulePath'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const TERMINAL_SCHEMAS = {
  execute_command: executeCommandSchema,
  run_tests: runTestsSchema,
} as const satisfies Record<string, JSONSchemaObject>;
