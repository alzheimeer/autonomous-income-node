/**
 * PlatformPoster
 *
 * Validates content character limits, enforces per-platform rate limits,
 * posts via the appropriate client, and records every post in social_posts.
 *
 * Rate limit: max 10 posts per platform per 24-hour window stored in SQLite.
 * Retry policy: on platform error, wait 30 s and retry once (Req 8.5).
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
 */

import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type { SocialPostsRepository } from '../../state/repositories/social-posts.repo.js';
import { TwitterClient } from '../../social/twitter-client.js';
import { TelegramClient } from '../../social/telegram-client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Character limits per platform */
const PLATFORM_CHAR_LIMITS: Record<string, number> = {
  twitter: 280,
  telegram: 4_096, // Telegram soporta hasta 4096 chars con parse_mode HTML
  webhook: 2_000,  // Discord embed description limit
};

/** Default max posts per platform per 24-hour window (Requirement 8.3) */
const DEFAULT_RATE_LIMIT = 10;

/** Retry delay in ms (Requirement 8.5) */
const RETRY_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export interface PostResult {
  postId: string;
  url: string;
  platform: string;
  mockMode?: boolean;
}

// ---------------------------------------------------------------------------
// PlatformPoster
// ---------------------------------------------------------------------------

export class PlatformPoster {
  private readonly twitterClient: TwitterClient;
  private readonly telegramClient: TelegramClient;
  private readonly webhookUrl: string | null;

  constructor(
    private readonly repo: SocialPostsRepository,
    private readonly rateLimitPerDay: number = DEFAULT_RATE_LIMIT
  ) {
    this.twitterClient = new TwitterClient();
    this.telegramClient = new TelegramClient();
    this.webhookUrl = process.env['WEBHOOK_URL'] ?? null;
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  /**
   * Validate content for a specific platform.
   * Currently enforces character limit only; returns {valid: false} with reason
   * when the content exceeds the platform's limit.
   * Requirement: 8.2
   */
  validateContent(
    content: string,
    platform: 'twitter' | string
  ): ValidationResult {
    const limit = PLATFORM_CHAR_LIMITS[platform];
    if (limit === undefined) {
      return { valid: false, reason: `Unknown platform: ${platform}` };
    }

    if (content.length > limit) {
      return {
        valid: false,
        reason: `Content length ${content.length} exceeds ${platform} limit of ${limit} characters`,
      };
    }

    if (content.trim().length === 0) {
      return { valid: false, reason: 'Content must not be empty' };
    }

    return { valid: true };
  }

  // ---------------------------------------------------------------------------
  // Rate limiting (SQLite-backed, 24h window)
  // ---------------------------------------------------------------------------

  /**
   * Count posts published to a platform in the last 24 hours.
   * Requirement: 8.3
   */
  private countRecentPosts(platform: string): number {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const posts = this.repo.findByPlatform(platform, 200);
    return posts.filter(
      (p) =>
        p.status === 'published' &&
        p.publishedAt !== null &&
        p.publishedAt >= since
    ).length;
  }

  private isRateLimited(platform: string): boolean {
    return this.countRecentPosts(platform) >= this.rateLimitPerDay;
  }

  // ---------------------------------------------------------------------------
  // Post
  // ---------------------------------------------------------------------------

  /**
   * Validate, rate-check, post, and record a social post.
   * On failure: retries once after RETRY_DELAY_MS, then records as 'failed'.
   * Requirement: 8.1, 8.4, 8.5
   */
  async post(content: string, platform: string): Promise<PostResult> {
    // Validation
    const validation = this.validateContent(content, platform);
    if (!validation.valid) {
      throw new Error(`Content validation failed: ${validation.reason}`);
    }

    // Rate limit check (Requirement 8.3)
    if (this.isRateLimited(platform)) {
      throw new Error(
        `Rate limit reached for platform "${platform}" (max ${this.rateLimitPerDay} posts/24h)`
      );
    }

    const contentHash = createHash('sha256').update(content).digest('hex');
    const recordId = uuidv4();

    // Pre-insert as pending
    this.repo.insert({
      id: recordId,
      platform,
      contentHash,
      status: 'pending',
    });

    // Attempt to post (with one retry on failure)
    let result: { postId: string; url: string; mockMode?: boolean };

    try {
      result = await this.publishToPlatform(content, platform);
    } catch (firstErr) {
      console.warn(`[PlatformPoster] First attempt failed for ${platform}:`, firstErr);
      // Retry once after 30 seconds (Requirement 8.5)
      await sleep(RETRY_DELAY_MS);
      try {
        result = await this.publishToPlatform(content, platform);
      } catch (retryErr) {
        // Final failure — mark as failed and re-throw
        this.repo.updateFailed(recordId);
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        throw new Error(`Failed to post to ${platform} after retry: ${msg}`);
      }
    }

    // Record success (Requirement 8.4)
    const publishedAt = Date.now();
    this.repo.updatePublished(recordId, result.postId, result.url, publishedAt);

    return {
      postId: result.postId,
      url: result.url,
      platform,
      mockMode: result.mockMode,
    };
  }

  // ---------------------------------------------------------------------------
  // Platform-specific publishing
  // ---------------------------------------------------------------------------

  private async publishToPlatform(
    content: string,
    platform: string
  ): Promise<{ postId: string; url: string; mockMode?: boolean }> {
    if (platform === 'twitter') {
      const tweetResult = await this.twitterClient.postTweet(content);
      const url = tweetResult.mockMode
        ? `https://twitter.com/mock/status/${tweetResult.tweetId}`
        : `https://twitter.com/i/web/status/${tweetResult.tweetId}`;
      return { postId: tweetResult.tweetId, url, mockMode: tweetResult.mockMode };
    }

    if (platform === 'telegram') {
      const tgResult = await this.telegramClient.sendMessage(content);
      const url = `https://t.me/ain_niklaussq/${tgResult.messageId}`;
      return { postId: String(tgResult.messageId), url, mockMode: tgResult.mockMode };
    }

    if (platform === 'webhook') {
      return this.postToWebhook(content);
    }

    throw new Error(`Unsupported platform: ${platform}`);
  }

  private async postToWebhook(
    content: string
  ): Promise<{ postId: string; url: string }> {
    if (!this.webhookUrl) {
      const mockId = `webhook_mock_${Date.now()}`;
      console.log(`[PlatformPoster] MOCK webhook — no WEBHOOK_URL configured: "${content}"`);
      return { postId: mockId, url: mockId };
    }

    const { default: axios } = await import('axios');

    // Detectar si es un webhook de Discord para usar formato rico
    const isDiscord = this.webhookUrl.includes('discord.com/api/webhooks');

    if (isDiscord) {
      // Discord webhook format con embed
      const payload = {
        username: 'Autonomous Income Node',
        avatar_url: 'https://cryptologos.cc/logos/usd-coin-usdc-logo.png',
        embeds: [
          {
            description: content,
            color: 0x5865F2, // Discord blurple
            footer: {
              text: `AIN Agent • ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`,
            },
          },
        ],
      };
      await axios.post(this.webhookUrl, payload, { timeout: 10_000 });
    } else {
      // Webhook genérico — JSON plano
      await axios.post(
        this.webhookUrl,
        { content, timestamp: Date.now() },
        { timeout: 10_000 }
      );
    }

    const webhookId = `webhook_${Date.now()}`;
    return { postId: webhookId, url: this.webhookUrl };
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
