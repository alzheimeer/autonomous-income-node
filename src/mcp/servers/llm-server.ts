/**
 * MCP LLM Inference Server
 *
 * Implements the MCP protocol via stdio, exposing one tool:
 *   - infer: run inference via Anthropic Claude, OpenAI-compatible APIs, or Ollama local
 *
 * Provider is selected via LLM_PROVIDER env var:
 *   'anthropic'  → Anthropic API (claude-*)
 *   'openai'     → OpenAI-compatible API (GPT, DeepSeek, Qwen, etc.)
 *                  Set OPENAI_API_KEY + OPENAI_BASE_URL for DeepSeek/Qwen
 *   'ollama'     → Local Ollama server (free, no API key, runs on GPU)
 *                  Set OLLAMA_BASE_URL (default: http://localhost:11434)
 *                  Set OLLAMA_MODEL (default: qwen3:8b)
 *
 * The llmBudgetMultiplier from the SurvivalModule is honoured by scaling
 * maxTokens down proportionally (read from LLM_BUDGET_MULTIPLIER env var,
 * range 0.0–1.0, default 1.0).
 *
 * Requirements: 13.4, 2.2, 5.3, 5.4, 5.5, 5.6
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// ---------------------------------------------------------------------------
// Constants & defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.7;
const HARD_MAX_TOKENS = 8192;

// LLM budget multiplier from SurvivalModule (0.0 – 1.0)
function getBudgetMultiplier(): number {
  const raw = process.env['LLM_BUDGET_MULTIPLIER'];
  if (!raw) return 1.0;
  const n = parseFloat(raw);
  if (!isFinite(n) || n < 0) return 0.0;
  if (n > 1) return 1.0;
  return n;
}

function applyBudget(requestedMaxTokens: number): number {
  const multiplier = getBudgetMultiplier();
  const scaled = Math.floor(requestedMaxTokens * multiplier);
  // Minimum 64 tokens to avoid API errors; max hard cap
  return Math.max(64, Math.min(scaled, HARD_MAX_TOKENS));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InferInput {
  model?: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  temperature?: number;
}

export interface InferResult {
  content: string;
  model: string;
  provider: string;
  promptTokens?: number;
  completionTokens?: number;
  budgetMultiplier: number;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'infer',
    description: 'Run LLM inference with Anthropic Claude or OpenAI GPT, selected via LLM_PROVIDER env var',
    inputSchema: {
      type: 'object' as const,
      properties: {
        model: {
          type: 'string',
          description: 'Model identifier, e.g. "claude-3-5-sonnet-20241022" or "gpt-4o". Defaults to provider default.',
        },
        systemPrompt: {
          type: 'string',
          description: 'System prompt (instructions / persona)',
        },
        userMessage: {
          type: 'string',
          description: 'User message to send to the model',
        },
        maxTokens: {
          type: 'number',
          minimum: 1,
          maximum: HARD_MAX_TOKENS,
          default: DEFAULT_MAX_TOKENS,
          description: 'Maximum tokens to generate. Scaled by llmBudgetMultiplier.',
        },
        temperature: {
          type: 'number',
          minimum: 0,
          maximum: 2,
          default: DEFAULT_TEMPERATURE,
          description: 'Sampling temperature (0 = deterministic, 2 = very creative)',
        },
      },
      required: ['systemPrompt', 'userMessage'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

async function inferWithAnthropic(input: InferInput): Promise<InferResult> {
  const client = new Anthropic({
    apiKey: process.env['ANTHROPIC_API_KEY'],
  });

  const model = input.model ?? process.env['LLM_MODEL'] ?? 'claude-sonnet-4-5';
  const maxTokens = applyBudget(input.maxTokens ?? DEFAULT_MAX_TOKENS);
  const temperature = input.temperature ?? DEFAULT_TEMPERATURE;

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    temperature,
    system: input.systemPrompt,
    messages: [{ role: 'user', content: input.userMessage }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const content = textBlock && textBlock.type === 'text' ? textBlock.text : '';

  return {
    content,
    model: response.model,
    provider: 'anthropic',
    promptTokens: response.usage?.input_tokens,
    completionTokens: response.usage?.output_tokens,
    budgetMultiplier: getBudgetMultiplier(),
  };
}

async function inferWithOpenAI(input: InferInput): Promise<InferResult> {
  // Supports any OpenAI-compatible API: OpenAI, DeepSeek, Qwen, etc.
  // Set OPENAI_BASE_URL to override (e.g. https://api.deepseek.com for DeepSeek)
  const baseURL = process.env['OPENAI_BASE_URL'] || undefined;

  const client = new OpenAI({
    apiKey: process.env['OPENAI_API_KEY'] ?? 'no-key',
    ...(baseURL ? { baseURL } : {}),
  });

  // Default model depends on provider: DeepSeek uses deepseek-chat, OpenAI uses gpt-4o
  const defaultModel = baseURL?.includes('deepseek') ? 'deepseek-v4-flash'
    : baseURL?.includes('dashscope') || baseURL?.includes('qwen') ? 'qwen-plus'
    : 'gpt-4o';

  const model = input.model ?? process.env['LLM_MODEL'] ?? defaultModel;
  const maxTokens = applyBudget(input.maxTokens ?? DEFAULT_MAX_TOKENS);
  const temperature = input.temperature ?? DEFAULT_TEMPERATURE;

  const response = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    temperature,
    messages: [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.userMessage },
    ],
  });

  const content = response.choices[0]?.message?.content ?? '';

  return {
    content,
    model: response.model,
    provider: 'openai',
    promptTokens: response.usage?.prompt_tokens,
    completionTokens: response.usage?.completion_tokens,
    budgetMultiplier: getBudgetMultiplier(),
  };
}

/**
 * Ollama local inference — OpenAI-compatible API at localhost:11434
 * Free, runs entirely on local GPU. No API key required.
 * Install: https://ollama.com → then: ollama pull qwen3:8b
 */
async function inferWithOllama(input: InferInput): Promise<InferResult> {
  const baseURL = process.env['OLLAMA_BASE_URL'] ?? 'http://host.docker.internal:11434';

  const client = new OpenAI({
    apiKey: 'ollama', // Ollama accepts any non-empty string
    baseURL: `${baseURL}/v1`,
  });

  const model = input.model ?? process.env['OLLAMA_MODEL'] ?? 'qwen3.5:9b';
  const maxTokens = applyBudget(input.maxTokens ?? DEFAULT_MAX_TOKENS);
  const temperature = input.temperature ?? DEFAULT_TEMPERATURE;

  // Qwen3/Qwen3.5 thinking mode: use think=false parameter via Ollama API
  // For triage we need fast single-word responses, not extended reasoning chains.
  // The /no_think prefix works in some interfaces; the API parameter is more reliable.
  const systemPrompt = input.systemPrompt;

  try {
    const response = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature,
      // @ts-expect-error — Ollama-specific extension to disable chain-of-thought thinking
      think: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: input.userMessage },
      ],
    });

    // Strip any residual <think>...</think> blocks from output (safety net)
    let content = response.choices[0]?.message?.content ?? '';
    content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    return {
      content,
      model: response.model ?? model,
      provider: 'ollama',
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
      budgetMultiplier: getBudgetMultiplier(),
    };
  } catch (err) {
    // Ollama not available — fallback to OpenAI/DeepSeek if configured
    const fallbackKey = process.env['OPENAI_API_KEY'];
    if (fallbackKey && fallbackKey !== 'no-key') {
      process.stderr.write(`[llm-server] Ollama unavailable (${(err as Error).message}), falling back to OpenAI provider\n`);
      return inferWithOpenAI({ ...input, model: undefined }); // use OpenAI default model
    }
    throw err; // no fallback available
  }
}

async function runInfer(input: InferInput): Promise<InferResult> {
  const provider = (process.env['LLM_PROVIDER'] ?? 'anthropic').toLowerCase();

  // If a specific model is requested that is an Ollama local model, route to Ollama
  // regardless of the configured LLM_PROVIDER. This allows DeepSeek for analysis
  // and qwen2.5-coder:7b for code generation without changing the global provider.
  const ollamaModels = (process.env['OLLAMA_LOCAL_MODELS'] ?? 'qwen3.5:9b,qwen2.5-coder:7b,qwen3:8b')
    .split(',').map(m => m.trim());

  if (input.model && ollamaModels.includes(input.model)) {
    return inferWithOllama(input);
  }

  if (provider === 'openai' || provider === 'deepseek' || provider === 'qwen') {
    return inferWithOpenAI(input);
  }

  if (provider === 'ollama') {
    return inferWithOllama(input);
  }

  // Default: anthropic
  return inferWithAnthropic(input);
}

// ---------------------------------------------------------------------------
// MCP Server bootstrap
// ---------------------------------------------------------------------------

function createLlmServer(): Server {
  const server = new Server(
    { name: 'llm-server', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      if (name !== 'infer') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
          isError: true,
        };
      }

      const input = args as unknown as InferInput;

      if (!input.systemPrompt || typeof input.systemPrompt !== 'string') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Missing required field: systemPrompt' }) }],
          isError: true,
        };
      }
      if (!input.userMessage || typeof input.userMessage !== 'string') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Missing required field: userMessage' }) }],
          isError: true,
        };
      }

      const result = await runInfer(input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      // Requirement 13.6 — structured error, no unhandled exceptions
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  return server;
}

export async function startLlmServer(): Promise<void> {
  const server = createLlmServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('llm-server.ts') ||
    process.argv[1].endsWith('llm-server.js'));

if (isMain) {
  startLlmServer().catch((err) => {
    process.stderr.write(`LLM server fatal error: ${String(err)}\n`);
    process.exit(1);
  });
}
