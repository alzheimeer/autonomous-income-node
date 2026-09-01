/**
 * Code Generation Service Handler
 *
 * Service ID : code-generation
 * Price      : $1.00 USDC (1_000_000n in 6-decimal units)
 * Timeout    : 60 seconds (code generation needs more time)
 *
 * Generates code via an LLM given a natural-language prompt, target language,
 * and optional context. Returns generated code and a brief explanation.
 * Falls back to a stub in dev / test mode.
 *
 * Requirement: 7.3
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ServiceResult } from '../service-registry.js';

// ---------------------------------------------------------------------------
// Handler input schema
// ---------------------------------------------------------------------------

export interface CodeGenParams {
  prompt: string;
  /** Target programming language (e.g. "TypeScript", "Python", "Rust"). */
  language?: string;
  /** Optional existing code snippet for context / continuation. */
  context?: string;
  /** Optional instructions for code style, libraries, constraints. */
  instructions?: string;
  /** Whether to include explanatory comments in the generated code. */
  includeComments?: boolean;
  /** Maximum number of tokens to generate (default: 2048, max: 4096). */
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// JSON Schema exported for ServiceDescriptor
// ---------------------------------------------------------------------------

export const CODE_GEN_SCHEMA = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: 'Natural-language description of the code to generate.',
      minLength: 10,
    },
    language: {
      type: 'string',
      description: 'Target programming language (e.g. "TypeScript", "Python", "Rust"). Defaults to TypeScript.',
    },
    context: {
      type: 'string',
      description: 'Optional existing code snippet that the generation should build upon or integrate with.',
    },
    instructions: {
      type: 'string',
      description: 'Additional style, library, or constraint instructions for the generated code.',
    },
    includeComments: {
      type: 'boolean',
      description: 'If true, include JSDoc/docstring comments in the generated code. Default: true.',
    },
    maxTokens: {
      type: 'number',
      minimum: 256,
      maximum: 4096,
      description: 'Maximum number of tokens to generate (default: 2048).',
    },
  },
  required: ['prompt'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildCodeGenSystemPrompt(
  language: string,
  instructions?: string,
  includeComments?: boolean,
): string {
  const commentInstruction =
    includeComments !== false
      ? 'Include clear JSDoc/docstring comments for all public functions, classes, and modules.'
      : 'Omit comments to keep the code concise.';

  const styleInstruction = instructions
    ? `\n\nAdditional requirements: ${instructions}`
    : '';

  return (
    `You are an expert ${language} software engineer. ` +
    `Generate clean, idiomatic, production-quality ${language} code. ` +
    `${commentInstruction} ` +
    `Output ONLY the code block — no markdown fences, no preamble, no explanation. ` +
    `If a brief explanation would help the user, add it as a trailing comment block starting with "// ---".` +
    styleInstruction
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Code generation handler.
 * Uses the Anthropic/OpenAI API to generate code from a natural-language prompt.
 */
export async function codeGenHandler(params: unknown): Promise<ServiceResult> {
  const startMs = Date.now();

  const p = params as CodeGenParams;
  const prompt = typeof p?.prompt === 'string' ? p.prompt.trim() : '';

  if (prompt.length < 10) {
    return {
      success: false,
      error: 'Parameter "prompt" must be at least 10 characters long.',
      latencyMs: Date.now() - startMs,
    };
  }

  const language = p.language ?? 'TypeScript';
  const maxTokens = Math.min(p.maxTokens ?? 2048, 4096);

  // Build the user message
  const contextPart = p.context
    ? `\n\nExisting code context:\n\`\`\`${language.toLowerCase()}\n${p.context}\n\`\`\``
    : '';
  const userMessage = `${prompt}${contextPart}`;

  const apiKey = process.env['ANTHROPIC_API_KEY'] ?? process.env['OPENAI_API_KEY'];
  const mockMode =
    process.env['MOCK_LLM'] === 'true' ||
    process.env['NODE_ENV'] === 'test' ||
    !apiKey;

  if (mockMode) {
    return {
      success: true,
      data: {
        code: `// [STUB] Generated ${language} code for: "${prompt.slice(0, 60)}..."\n// TODO: implement\nfunction stub(): void {}\n`,
        language,
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
    const systemPrompt = buildCodeGenSystemPrompt(language, p.instructions, p.includeComments);
    let code: string;
    let model: string;
    let provider_used: string;

    if (provider === 'openai') {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] });

      const resp = await client.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: maxTokens,
        temperature: 0.2, // Low temperature for code = more deterministic
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      });
      code = resp.choices[0]?.message?.content?.trim() ?? '';
      model = resp.model;
      provider_used = 'openai';
    } else {
      // Anthropic (default)
      const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });

      const resp = await client.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: maxTokens,
        temperature: 0.2,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });
      const textBlock = resp.content.find((b) => b.type === 'text');
      code = textBlock && textBlock.type === 'text' ? textBlock.text.trim() : '';
      model = resp.model;
      provider_used = 'anthropic';
    }

    return {
      success: true,
      data: {
        code,
        language,
        model,
        provider: provider_used,
        lineCount: code.split('\n').length,
      },
      latencyMs: Date.now() - startMs,
    };
  } catch (err) {
    return {
      success: false,
      error: `Code generation LLM call failed: ${(err as Error).message}`,
      latencyMs: Date.now() - startMs,
    };
  }
}
