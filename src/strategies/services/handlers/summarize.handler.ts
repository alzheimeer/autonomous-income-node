/**
 * Data Summarization Service Handler
 *
 * Service ID : data-summarization
 * Price      : $0.30 USDC (300_000n in 6-decimal units)
 * Timeout    : 30 seconds
 *
 * Takes a block of text and returns a concise LLM-generated summary.
 * Falls back to a stub when no LLM API key is available (dev / test mode).
 *
 * Requirement: 7.3
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ServiceResult } from '../service-registry.js';

// ---------------------------------------------------------------------------
// Handler input schema
// ---------------------------------------------------------------------------

export interface SummarizeParams {
  text: string;
  /** Optional hint for the desired summary length: 'short' | 'medium' | 'detailed'. */
  length?: 'short' | 'medium' | 'detailed';
  /** Optional language for the output summary (defaults to language of input text). */
  language?: string;
}

// ---------------------------------------------------------------------------
// JSON Schema exported for ServiceDescriptor
// ---------------------------------------------------------------------------

export const SUMMARIZE_SCHEMA = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'The text content to summarize.',
      minLength: 10,
    },
    length: {
      type: 'string',
      enum: ['short', 'medium', 'detailed'],
      description: 'Desired summary length: short (~1 sentence), medium (~3 sentences), detailed (~5 sentences). Defaults to medium.',
    },
    language: {
      type: 'string',
      description: 'Language for the output summary (e.g. "English", "Spanish"). Defaults to the input language.',
    },
  },
  required: ['text'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Build the system prompt for the summarization task. */
function buildSummarizeSystemPrompt(length: string, language?: string): string {
  const lengthInstructions: Record<string, string> = {
    short:    'Provide a single-sentence summary (max 30 words).',
    medium:   'Provide a 2–3 sentence summary capturing the key points.',
    detailed: 'Provide a 4–6 sentence summary covering all main ideas and important details.',
  };

  const instruction = lengthInstructions[length] ?? lengthInstructions['medium']!;
  const langInstruction = language ? ` Respond in ${language}.` : '';

  return (
    `You are a professional text summarization assistant. ` +
    `${instruction}${langInstruction} ` +
    `Respond with only the summary text, no preamble or commentary.`
  );
}

/**
 * Data summarization handler.
 *
 * Calls the Anthropic/OpenAI API directly to summarize the provided text.
 */
export async function summarizeHandler(params: unknown): Promise<ServiceResult> {
  const startMs = Date.now();

  const p = params as SummarizeParams;
  const text = typeof p?.text === 'string' ? p.text : '';
  if (text.length < 10) {
    return {
      success: false,
      error: 'Parameter "text" must be at least 10 characters long.',
      latencyMs: Date.now() - startMs,
    };
  }

  const length = p.length ?? 'medium';
  const validLengths = ['short', 'medium', 'detailed'];
  if (!validLengths.includes(length)) {
    return {
      success: false,
      error: `Invalid "length" value "${length}". Must be one of: ${validLengths.join(', ')}.`,
      latencyMs: Date.now() - startMs,
    };
  }

  const apiKey = process.env['ANTHROPIC_API_KEY'] ?? process.env['OPENAI_API_KEY'];
  const mockMode =
    process.env['MOCK_LLM'] === 'true' ||
    process.env['NODE_ENV'] === 'test' ||
    !apiKey;

  if (mockMode) {
    const preview = text.slice(0, 120).replace(/\s+/g, ' ').trim();
    return {
      success: true,
      data: {
        summary: `[STUB] Summary of: "${preview}${text.length > 120 ? '...' : ''}"`,
        length,
        wordCount: preview.split(' ').length,
      },
      latencyMs: Date.now() - startMs,
    };
  }

  try {
    const provider = (process.env['LLM_PROVIDER'] ?? 'anthropic').toLowerCase();
    const systemPrompt = buildSummarizeSystemPrompt(length, p.language);
    let summary: string;
    let model: string;

    if (provider === 'openai') {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] });

      const resp = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 512,
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
      });
      summary = resp.choices[0]?.message?.content?.trim() ?? '';
      model = resp.model;
    } else {
      const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });

      const resp = await client.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 512,
        temperature: 0.3,
        system: systemPrompt,
        messages: [{ role: 'user', content: text }],
      });
      const textBlock = resp.content.find((b) => b.type === 'text');
      summary = textBlock && textBlock.type === 'text' ? textBlock.text.trim() : '';
      model = resp.model;
    }

    return {
      success: true,
      data: {
        summary,
        length,
        wordCount: summary.split(/\s+/).filter(Boolean).length,
        model,
      },
      latencyMs: Date.now() - startMs,
    };
  } catch (err) {
    return {
      success: false,
      error: `LLM summarization failed: ${(err as Error).message}`,
      latencyMs: Date.now() - startMs,
    };
  }
}
