/**
 * ContentGenerator
 *
 * Calls the MCP LLM Server to generate platform-appropriate content,
 * then validates it through PlatformPoster before returning.
 *
 * Requirements: 8.6, 8.7
 */

import type { McpClient } from '../../mcp/client/mcp-client.js';
import type { SocialPostsRepository } from '../../state/repositories/social-posts.repo.js';
import { PlatformPoster } from './platform-poster.js';
import type { InferResult } from '../../mcp/servers/llm-server.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max content length per platform */
const PLATFORM_MAX_CHARS: Record<string, number> = {
  twitter: 280,
  webhook: 2_000,
};

/** System prompt template for content generation */
const SYSTEM_PROMPT = `You are a professional social media content creator for an autonomous AI agent.
Generate concise, engaging, factual content about AI, technology, automation, and DeFi.
Never include harmful, misleading, or offensive content. Be transparent that you are an AI.
Keep responses ONLY with the content itself — no preamble, no explanation.`;

// ---------------------------------------------------------------------------
// ContentGenerator
// ---------------------------------------------------------------------------

export class ContentGenerator {
  private readonly poster: PlatformPoster;

  constructor(
    private readonly llmClient: McpClient | null,
    socialPostsRepo: SocialPostsRepository,
    rateLimitPerDay?: number
  ) {
    // Leer MAX_POSTS_PER_DAY del .env si no se pasa explícitamente
    const envLimit = process.env['MAX_POSTS_PER_DAY']
      ? parseInt(process.env['MAX_POSTS_PER_DAY'], 10)
      : undefined;
    this.poster = new PlatformPoster(socialPostsRepo, rateLimitPerDay ?? envLimit ?? 10);
  }

  /**
   * Generate content for a specific topic and platform.
   * Uses LLM via MCP if available; falls back to deterministic template.
   * Returns validated content (guaranteed to fit platform character limit).
   * Requirement: 8.6
   */
  async generateContent(topic: string, platform: string): Promise<string> {
    const maxChars = PLATFORM_MAX_CHARS[platform] ?? 280;

    // Attempt LLM generation
    if (this.llmClient !== null && this.llmClient.isConnected) {
      try {
        const result = await this.llmClient.callTool<InferResult>('infer', {
          systemPrompt: SYSTEM_PROMPT,
          userMessage: `Generate a ${platform === 'webhook' ? 'Discord' : platform} post about: ${topic}. Maximum ${maxChars} characters. ${platform === 'webhook' ? 'You can use Discord markdown: **bold**, *italic*, bullet points with -.' : ''}`,
          maxTokens: 256,
          temperature: 0.8,
        });

        if (result.ok) {
          const content =
            typeof result.value === 'string'
              ? result.value
              : result.value?.content ?? '';

          const trimmed = content.trim();

          // Validate with PlatformPoster
          const validation = this.poster.validateContent(trimmed, platform);
          if (validation.valid) {
            return trimmed;
          }

          // If LLM output is too long, truncate intelligently
          return this.truncate(trimmed, maxChars);
        }
      } catch (err) {
        console.warn('[ContentGenerator] LLM generation failed, using fallback:', err);
      }
    }

    // Fallback: template-based generation
    return this.generateFallback(topic, platform, maxChars);
  }

  /**
   * Generate content and immediately post it.
   * Returns the PostResult from PlatformPoster.
   * Requirement: 8.6, 8.7
   */
  async generateAndPost(
    topic: string,
    platform: string
  ): Promise<{ postId: string; url: string; content: string }> {
    const content = await this.generateContent(topic, platform);
    const postResult = await this.poster.post(content, platform);
    return { postId: postResult.postId, url: postResult.url, content };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private generateFallback(topic: string, platform: string, maxChars: number): string {
    const templates = [
      `Exploring ${topic} as an autonomous AI agent. The future of automated intelligence is unfolding now. #AI #Automation`,
      `New insights on ${topic}: autonomous systems are learning to optimize and adapt continuously. #DeFi #AI`,
      `${topic} — one more step toward fully autonomous income generation. #Web3 #AI`,
    ];

    const base = templates[Math.floor(Math.random() * templates.length)] ?? templates[0]!;
    return this.truncate(base, maxChars);
  }

  private truncate(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    // Truncate at word boundary
    const truncated = content.substring(0, maxChars - 3);
    const lastSpace = truncated.lastIndexOf(' ');
    return (lastSpace > maxChars * 0.5 ? truncated.substring(0, lastSpace) : truncated) + '...';
  }
}
