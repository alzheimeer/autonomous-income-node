/**
 * Text Generation Service Handler
 *
 * Service ID : text-generation
 * Price      : $0.50 USDC (500_000n in 6-decimal units)
 * Timeout    : 30 seconds
 *
 * Calls the MCP LLM Inference server with the supplied prompt and returns
 * the generated text. When the MCP client is not available (e.g. in
 * development / unit tests), falls back to a stub response.
 *
 * Requirement: 7.3
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ServiceResult } from '../service-registry.js';

// ---------------------------------------------------------------------------
// Handler input schema
// ---------------------------------------------------------------------------

export interface TextGenParams {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

// ---------------------------------------------------------------------------
// JSON Schema exported for ServiceDescriptor
// ---------------------------------------------------------------------------

export const TEXT_GEN_SCHEMA = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: 'The user prompt to send to the LLM for text generation.',
      minLength: 1,
    },
    systemPrompt: {
      type: 'string',
      description: 'Optional system-level instruction that frames the LLM context.',
    },
    maxTokens: {
      type: 'number',
      minimum: 1,
      maximum: 4096,
      description: 'Maximum number of tokens to generate (default: 1024).',
    },
    temperature: {
      type: 'number',
      minimum: 0,
      maximum: 2,
      description: 'Sampling temperature (default: 0.7).',
    },
  },
  required: ['prompt'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Text generation handler.
 *
 * Uses the Anthropic SDK directly (same approach as the MCP LLM server)
 * to avoid subprocess round-trip latency inside a service call.
 * Falls back to a stub when the API key is absent (dev / test mode).
 */
export async function textGenHandler(params: unknown): Promise<ServiceResult> {
  const startMs = Date.now();

  const p = params as TextGenParams;
  const prompt = typeof p?.prompt === 'string' ? p.prompt : '';
  if (!prompt) {
    return {
      success: false,
      error: 'Missing required parameter: prompt',
      latencyMs: Date.now() - startMs,
    };
  }

  const apiKey = process.env['ANTHROPIC_API_KEY'] ?? process.env['OPENAI_API_KEY'];
  const mockMode =
    process.env['MOCK_LLM'] === 'true' ||
    process.env['NODE_ENV'] === 'test' ||
    !apiKey;

  if (mockMode) {
    // Stub response for development / testing
    return {
      success: true,
      data: {
        text: `[STUB] Generated text for prompt: "${prompt.slice(0, 80)}..."`,
        model: 'stub',
        provider: 'mock',
        promptTokens: 0,
        completionTokens: 0,
      },
      latencyMs: Date.now() - startMs,
    };
  }

  try {
    const provider = (process.env['LLM_PROVIDER'] ?? 'anthropic').toLowerCase();
    let content: string;
    let model: string;
    let provider_used: string;

    if (provider === 'openai') {
      // Dynamic import to keep OpenAI optional at runtime
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] });
      const maxTokens = Math.min(p.maxTokens ?? 1024, 4096);
      const temperature = p.temperature ?? 0.7;

      const resp = await client.chat.completions.create({
        model: p.systemPrompt ? 'gpt-4o' : 'gpt-4o-mini',
        max_tokens: maxTokens,
        temperature,
        messages: [
          ...(p.systemPrompt ? [{ role: 'system' as const, content: p.systemPrompt }] : []),
          { role: 'user' as const, content: prompt },
        ],
      });
      content = resp.choices[0]?.message?.content ?? '';
      model = resp.model;
      provider_used = 'openai';
    } else {
      // Anthropic (default)
      const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });
      const maxTokens = Math.min(p.maxTokens ?? 1024, 4096);
      const temperature = p.temperature ?? 0.7;

      const resp = await client.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: maxTokens,
        temperature,
        ...(p.systemPrompt ? { system: p.systemPrompt } : {}),
        messages: [{ role: 'user', content: prompt }],
      });
      const textBlock = resp.content.find((b) => b.type === 'text');
      content = textBlock && textBlock.type === 'text' ? textBlock.text : '';
      model = resp.model;
      provider_used = 'anthropic';
    }

    return {
      success: true,
      data: { text: content, model, provider: provider_used },
      latencyMs: Date.now() - startMs,
    };
  } catch (err) {
    return {
      success: false,
      error: `LLM call failed: ${(err as Error).message}`,
      latencyMs: Date.now() - startMs,
    };
  }
}
