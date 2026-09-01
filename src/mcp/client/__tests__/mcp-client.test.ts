/**
 * Unit tests for McpClient and validateSchema.
 *
 * These tests cover Property 16: MCP Client Contracts
 *   - Input that fails JSON Schema validation → Result { ok: false, MCP_VALIDATION_ERROR }
 *   - Tool is never invoked when schema validation fails
 *   - Tool errors are returned as structured Result, never thrown
 *   - McpClientRegistry registers / retrieves clients
 *
 * Property-based coverage is in mcp-client.property.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateSchema,
  McpClient,
  McpClientRegistry,
  ErrorCode,
} from '../mcp-client.js';
import type { JSONSchemaObject, McpServerConfig } from '../mcp-client.js';
import { TERMINAL_SCHEMAS } from '../../schemas/terminal.schema.js';
import { TRADING_SCHEMAS } from '../../schemas/trading.schema.js';
import { WEB_SCHEMAS } from '../../schemas/web.schema.js';
import { LLM_SCHEMAS } from '../../schemas/llm.schema.js';
import { DOCKER_SCHEMAS } from '../../schemas/docker.schema.js';

// ---------------------------------------------------------------------------
// validateSchema – unit tests
// ---------------------------------------------------------------------------

describe('validateSchema', () => {
  const simpleSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      age: { type: 'number', minimum: 0 },
    },
    required: ['name'],
    additionalProperties: false,
  };

  it('passes for a valid object', () => {
    const result = validateSchema({ name: 'Alice', age: 30 }, simpleSchema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when a required field is missing', () => {
    const result = validateSchema({ age: 30 }, simpleSchema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('fails when a field has the wrong type', () => {
    const result = validateSchema({ name: 42 }, simpleSchema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('string'))).toBe(true);
  });

  it('fails for additional properties when not allowed', () => {
    const result = validateSchema({ name: 'Bob', extra: true }, simpleSchema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('extra'))).toBe(true);
  });

  it('fails for strings shorter than minLength', () => {
    const result = validateSchema({ name: '' }, simpleSchema);
    expect(result.valid).toBe(false);
  });

  it('fails for numbers below minimum', () => {
    const result = validateSchema({ name: 'X', age: -1 }, simpleSchema);
    expect(result.valid).toBe(false);
  });

  it('passes for optional fields when absent', () => {
    const result = validateSchema({ name: 'Bob' }, simpleSchema);
    expect(result.valid).toBe(true);
  });

  it('validates enum values', () => {
    const schema: JSONSchemaObject = { type: 'string', enum: ['a', 'b', 'c'] };
    expect(validateSchema('a', schema).valid).toBe(true);
    expect(validateSchema('d', schema).valid).toBe(false);
  });

  it('validates nested objects recursively', () => {
    const schema: JSONSchemaObject = {
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: { street: { type: 'string', minLength: 1 } },
          required: ['street'],
        },
      },
      required: ['address'],
    };
    expect(validateSchema({ address: { street: 'Main St' } }, schema).valid).toBe(true);
    expect(validateSchema({ address: { street: '' } }, schema).valid).toBe(false);
    expect(validateSchema({ address: {} }, schema).valid).toBe(false);
  });

  it('validates array items', () => {
    const schema: JSONSchemaObject = {
      type: 'array',
      items: { type: 'string' },
    };
    expect(validateSchema(['a', 'b'], schema).valid).toBe(true);
    expect(validateSchema(['a', 123], schema).valid).toBe(false);
  });

  it('validates pattern constraint', () => {
    const schema: JSONSchemaObject = {
      type: 'string',
      pattern: '^0x[0-9a-fA-F]{40}$',
    };
    expect(validateSchema('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', schema).valid).toBe(true);
    expect(validateSchema('not-an-address', schema).valid).toBe(false);
  });

  it('validates additionalProperties as schema object', () => {
    const schema: JSONSchemaObject = {
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: { type: 'number' },
    };
    expect(validateSchema({ name: 'x', score: 10 }, schema).valid).toBe(true);
    expect(validateSchema({ name: 'x', score: 'bad' }, schema).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Terminal schemas
// ---------------------------------------------------------------------------

describe('TERMINAL_SCHEMAS', () => {
  describe('execute_command', () => {
    it('passes with only required field', () => {
      expect(validateSchema({ command: 'ls' }, TERMINAL_SCHEMAS.execute_command).valid).toBe(true);
    });

    it('passes with all fields', () => {
      expect(
        validateSchema(
          { command: 'echo', cwd: '/tmp', timeoutMs: 5000, env: { FOO: 'bar' } },
          TERMINAL_SCHEMAS.execute_command
        ).valid
      ).toBe(true);
    });

    it('fails when command is missing', () => {
      expect(validateSchema({}, TERMINAL_SCHEMAS.execute_command).valid).toBe(false);
    });

    it('fails when command is empty string', () => {
      expect(validateSchema({ command: '' }, TERMINAL_SCHEMAS.execute_command).valid).toBe(false);
    });

    it('fails for additional properties', () => {
      expect(
        validateSchema({ command: 'ls', unknown: true }, TERMINAL_SCHEMAS.execute_command).valid
      ).toBe(false);
    });
  });

  describe('run_tests', () => {
    it('passes with required modulePath', () => {
      expect(
        validateSchema({ modulePath: './src/agent' }, TERMINAL_SCHEMAS.run_tests).valid
      ).toBe(true);
    });

    it('fails when modulePath is missing', () => {
      expect(validateSchema({}, TERMINAL_SCHEMAS.run_tests).valid).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Trading schemas
// ---------------------------------------------------------------------------

describe('TRADING_SCHEMAS', () => {
  const validAddress = '0xAbCdEf0123456789012345678901234567890123';

  describe('get_quote', () => {
    it('passes with required fields', () => {
      expect(
        validateSchema(
          {
            tokenIn: validAddress,
            tokenOut: validAddress,
            amountIn: '1000000',
            network: 'base',
          },
          TRADING_SCHEMAS.get_quote
        ).valid
      ).toBe(true);
    });

    it('fails for invalid network', () => {
      expect(
        validateSchema(
          { tokenIn: validAddress, tokenOut: validAddress, amountIn: '100', network: 'solana' },
          TRADING_SCHEMAS.get_quote
        ).valid
      ).toBe(false);
    });

    it('fails for non-numeric amountIn', () => {
      expect(
        validateSchema(
          { tokenIn: validAddress, tokenOut: validAddress, amountIn: 'abc', network: 'ethereum' },
          TRADING_SCHEMAS.get_quote
        ).valid
      ).toBe(false);
    });
  });

  describe('execute_swap', () => {
    it('passes with required fields', () => {
      expect(
        validateSchema(
          { quoteId: 'q-123', walletAddress: validAddress },
          TRADING_SCHEMAS.execute_swap
        ).valid
      ).toBe(true);
    });

    it('fails when quoteId is missing', () => {
      expect(
        validateSchema({ walletAddress: validAddress }, TRADING_SCHEMAS.execute_swap).valid
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Web schemas
// ---------------------------------------------------------------------------

describe('WEB_SCHEMAS', () => {
  describe('extract_data', () => {
    it('passes with url and selectors', () => {
      expect(
        validateSchema(
          { url: 'https://example.com', selectors: { title: 'h1', price: '.price' } },
          WEB_SCHEMAS.extract_data
        ).valid
      ).toBe(true);
    });

    it('fails when selectors is missing', () => {
      expect(
        validateSchema({ url: 'https://example.com' }, WEB_SCHEMAS.extract_data).valid
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// LLM schemas
// ---------------------------------------------------------------------------

describe('LLM_SCHEMAS', () => {
  describe('infer', () => {
    it('passes with required fields', () => {
      expect(
        validateSchema(
          { systemPrompt: 'You are an agent.', userMessage: 'Hello' },
          LLM_SCHEMAS.infer
        ).valid
      ).toBe(true);
    });

    it('fails when systemPrompt is empty', () => {
      expect(
        validateSchema({ systemPrompt: '', userMessage: 'Hello' }, LLM_SCHEMAS.infer).valid
      ).toBe(false);
    });

    it('fails when userMessage is missing', () => {
      expect(
        validateSchema({ systemPrompt: 'You are an agent.' }, LLM_SCHEMAS.infer).valid
      ).toBe(false);
    });

    it('fails for temperature out of range', () => {
      expect(
        validateSchema(
          { systemPrompt: 'S', userMessage: 'U', temperature: 3 },
          LLM_SCHEMAS.infer
        ).valid
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Docker schemas
// ---------------------------------------------------------------------------

describe('DOCKER_SCHEMAS', () => {
  describe('provision_container', () => {
    it('passes with required fields', () => {
      expect(
        validateSchema(
          { image: 'autonomous-income-node:latest', name: 'ain-child-1', env: {} },
          DOCKER_SCHEMAS.provision_container
        ).valid
      ).toBe(true);
    });

    it('fails when image is missing', () => {
      expect(
        validateSchema({ name: 'child', env: {} }, DOCKER_SCHEMAS.provision_container).valid
      ).toBe(false);
    });

    it('fails for invalid container name', () => {
      expect(
        validateSchema(
          { image: 'img', name: 'a', env: {} },
          DOCKER_SCHEMAS.provision_container
        ).valid
      ).toBe(false);
    });
  });

  describe('stop_container', () => {
    it('passes with containerId', () => {
      expect(
        validateSchema({ containerId: 'abc123' }, DOCKER_SCHEMAS.stop_container).valid
      ).toBe(true);
    });

    it('fails when containerId is missing', () => {
      expect(validateSchema({}, DOCKER_SCHEMAS.stop_container).valid).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// McpClient — schema validation gate (no real server needed)
// ---------------------------------------------------------------------------

describe('McpClient schema validation gate', () => {
  function makeClient(
    serverName: string,
    schemas: Record<string, JSONSchemaObject>
  ): McpClient {
    const config: McpServerConfig = {
      serverName,
      command: 'node', // irrelevant — we won't connect
      schemas,
    };
    return new McpClient(config, null);
  }

  it('returns MCP_VALIDATION_ERROR when required field is missing — does NOT connect', async () => {
    const client = makeClient('terminal', TERMINAL_SCHEMAS);
    // No connect() call — ensures validation runs before any connection attempt
    const result = await client.callTool('execute_command', { cwd: '/tmp' }); // missing 'command'
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.MCP_VALIDATION_ERROR);
      expect(result.error.retryable).toBe(false);
    }
  });

  it('returns MCP_VALIDATION_ERROR for unknown tool', async () => {
    const client = makeClient('terminal', TERMINAL_SCHEMAS);
    const result = await client.callTool('nonexistent_tool', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.MCP_VALIDATION_ERROR);
    }
  });

  it('returns MCP_CONNECTION_ERROR when not connected but input is valid', async () => {
    const client = makeClient('terminal', TERMINAL_SCHEMAS);
    const result = await client.callTool('execute_command', { command: 'ls' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.MCP_CONNECTION_ERROR);
      expect(result.error.retryable).toBe(true);
    }
  });

  it('isConnected starts as false', () => {
    const client = makeClient('terminal', TERMINAL_SCHEMAS);
    expect(client.isConnected).toBe(false);
  });

  it('exposes the server name', () => {
    const client = makeClient('terminal', TERMINAL_SCHEMAS);
    expect(client.name).toBe('terminal');
  });
});

// ---------------------------------------------------------------------------
// McpClient — logging (mocked repo)
// ---------------------------------------------------------------------------

describe('McpClient logging', () => {
  it('calls repo.insert on validation failure', async () => {
    const mockRepo = { insert: vi.fn() } as never;
    const config: McpServerConfig = {
      serverName: 'terminal',
      command: 'node',
      schemas: TERMINAL_SCHEMAS,
    };
    const client = new McpClient(config, mockRepo);

    await client.callTool('execute_command', {}); // missing command → validation error
    expect(mockRepo.insert).toHaveBeenCalledOnce();
    const call = mockRepo.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(call.success).toBe(false);
    expect(call.server).toBe('terminal');
    expect(call.tool).toBe('execute_command');
  });

  it('does not throw when repo.insert throws', async () => {
    const mockRepo = {
      insert: vi.fn().mockImplementation(() => {
        throw new Error('DB down');
      }),
    } as never;
    const config: McpServerConfig = {
      serverName: 'terminal',
      command: 'node',
      schemas: TERMINAL_SCHEMAS,
    };
    const client = new McpClient(config, mockRepo);
    // Should not throw — logging failure is swallowed
    await expect(client.callTool('execute_command', {})).resolves.toBeDefined();
  });

  it('redacts known secret keys in input summary', async () => {
    const mockRepo = { insert: vi.fn() } as never;
    const config: McpServerConfig = {
      serverName: 'llm',
      command: 'node',
      schemas: LLM_SCHEMAS,
    };
    const client = new McpClient(config, mockRepo);
    await client.callTool('infer', {
      systemPrompt: 'You are an agent.',
      userMessage: 'Hello',
      apiKey: 'sk-super-secret-key',
    } as Record<string, unknown>);
    // The infer schema has additionalProperties:false, so it fails validation
    // but the logged inputSummary should still redact the apiKey
    const call = mockRepo.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(String(call.inputSummary)).not.toContain('sk-super-secret-key');
    expect(String(call.inputSummary)).toContain('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// McpClientRegistry
// ---------------------------------------------------------------------------

describe('McpClientRegistry', () => {
  it('registers and retrieves clients by server name', () => {
    const registry = new McpClientRegistry();
    const config: McpServerConfig = {
      serverName: 'terminal',
      command: 'node',
      schemas: TERMINAL_SCHEMAS,
    };
    const client = new McpClient(config, null);
    registry.register(client);
    expect(registry.get('terminal')).toBe(client);
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('size reflects registered clients', () => {
    const registry = new McpClientRegistry();
    expect(registry.size).toBe(0);
    const c1 = new McpClient({ serverName: 'a', command: 'node', schemas: {} }, null);
    const c2 = new McpClient({ serverName: 'b', command: 'node', schemas: {} }, null);
    registry.register(c1);
    registry.register(c2);
    expect(registry.size).toBe(2);
  });

  it('connectAll returns results for all registered clients', async () => {
    const registry = new McpClientRegistry();
    // Use a command that will fail quickly — that's expected
    const c = new McpClient(
      { serverName: 'terminal', command: 'no-such-binary-xyz', schemas: TERMINAL_SCHEMAS },
      null
    );
    registry.register(c);
    const results = await registry.connectAll();
    // Connection will fail (no real binary), but we get a Result back, not an exception
    expect('terminal' in results).toBe(true);
    expect(results['terminal']!.ok).toBe(false);
  });

  it('disconnectAll does not throw even when not connected', async () => {
    const registry = new McpClientRegistry();
    const c = new McpClient(
      { serverName: 'terminal', command: 'node', schemas: TERMINAL_SCHEMAS },
      null
    );
    registry.register(c);
    await expect(registry.disconnectAll()).resolves.toBeUndefined();
  });
});
