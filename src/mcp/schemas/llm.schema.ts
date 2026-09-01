/**
 * JSON Schema definitions for the MCP LLM Inference server tools.
 * Supports Anthropic Claude and OpenAI GPT.
 * Requirements: 13.4, 13.8
 */

import type { JSONSchemaObject } from '../client/mcp-client.js';

// ---------------------------------------------------------------------------
// infer
// ---------------------------------------------------------------------------

export const inferSchema: JSONSchemaObject = {
  type: 'object',
  properties: {
    model: {
      type: 'string',
      description:
        'Model identifier, e.g. "claude-3-5-sonnet-20241022" or "gpt-4o". ' +
        'Defaults to the model configured via ANTHROPIC_MODEL or OPENAI_MODEL env var.',
    },
    systemPrompt: {
      type: 'string',
      minLength: 1,
      description: 'System-level instructions for the LLM',
    },
    userMessage: {
      type: 'string',
      minLength: 1,
      description: 'User turn message / prompt',
    },
    maxTokens: {
      type: 'number',
      minimum: 1,
      maximum: 128_000,
      default: 4096,
      description: 'Maximum tokens in the completion',
    },
    temperature: {
      type: 'number',
      minimum: 0,
      maximum: 2,
      default: 0.7,
      description: 'Sampling temperature (0 = deterministic, 2 = highly random)',
    },
  },
  required: ['systemPrompt', 'userMessage'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const LLM_SCHEMAS = {
  infer: inferSchema,
} as const satisfies Record<string, JSONSchemaObject>;
