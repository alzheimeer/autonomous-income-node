/**
 * EngagementMonitor
 *
 * Monitors social media engagement metrics for published posts.
 * - Uses MCP Web Scraping when available; falls back to mock data in development.
 * - Enforces a minimum 4-hour interval between checks per post (Requirement 8.6).
 *
 * Requirements: 8.6
 */

import type { McpClient } from '../mcp/client/mcp-client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum interval between engagement checks per post */
const MIN_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EngagementMetrics {
  postId: string;
  platform: string;
  likes: number;
  replies: number;
  reach: number;
  checkedAt: number;
  mockMode: boolean;
}

// ---------------------------------------------------------------------------
// EngagementMonitor
// ---------------------------------------------------------------------------

export class EngagementMonitor {
  /** Track last check time per post to enforce 4-hour minimum interval */
  private readonly lastChecked = new Map<string, number>();

  constructor(
    /** Optional MCP Web Scraping client; when null, runs in mock mode */
    private readonly webScrapingClient: McpClient | null = null
  ) {}

  /**
   * Monitor engagement metrics for a post.
   * Returns cached/mock data if the post was checked within the last 4 hours.
   * Requirement: 8.6
   */
  async monitorEngagement(
    postId: string,
    platform: string
  ): Promise<EngagementMetrics> {
    const now = Date.now();
    const lastCheck = this.lastChecked.get(postId);

    // Enforce minimum check interval (Requirement 8.6)
    if (lastCheck !== undefined && now - lastCheck < MIN_CHECK_INTERVAL_MS) {
      const waitMs = MIN_CHECK_INTERVAL_MS - (now - lastCheck);
      const waitMins = Math.ceil(waitMs / 60_000);
      console.log(
        `[EngagementMonitor] Skipping check for ${postId} — next check in ${waitMins} min`
      );
      return this.mockMetrics(postId, platform, now);
    }

    let metrics: EngagementMetrics;

    if (this.webScrapingClient !== null && this.webScrapingClient.isConnected) {
      metrics = await this.fetchViaWebScraping(postId, platform, now);
    } else {
      metrics = this.mockMetrics(postId, platform, now);
    }

    // Record last check time
    this.lastChecked.set(postId, now);

    return metrics;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async fetchViaWebScraping(
    postId: string,
    platform: string,
    now: number
  ): Promise<EngagementMetrics> {
    try {
      const url = this.buildEngagementUrl(postId, platform);

      const result = await this.webScrapingClient!.callTool<{
        likes?: number;
        replies?: number;
        views?: number;
      }>('fetch_structured', {
        url,
        selector: '[data-testid="like"], [data-testid="reply"], [data-testid="views"]',
        format: 'json',
      });

      if (result.ok && result.value) {
        return {
          postId,
          platform,
          likes: result.value.likes ?? 0,
          replies: result.value.replies ?? 0,
          reach: result.value.views ?? 0,
          checkedAt: now,
          mockMode: false,
        };
      }
    } catch (err) {
      console.warn('[EngagementMonitor] Web scraping failed, using mock data:', err);
    }

    return this.mockMetrics(postId, platform, now);
  }

  private mockMetrics(
    postId: string,
    platform: string,
    now: number
  ): EngagementMetrics {
    // Generate stable mock data based on postId hash
    const seed = postId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return {
      postId,
      platform,
      likes: (seed % 50) + 1,
      replies: (seed % 10),
      reach: (seed % 500) + 100,
      checkedAt: now,
      mockMode: true,
    };
  }

  private buildEngagementUrl(postId: string, platform: string): string {
    if (platform === 'twitter') {
      return `https://twitter.com/i/web/status/${postId}`;
    }
    return `https://${platform}.com/posts/${postId}`;
  }

  /** Reset the check timer for a post (useful for tests). */
  resetCheckTimer(postId: string): void {
    this.lastChecked.delete(postId);
  }
}
