/**
 * Property 11 — PlatformPoster: character limit always detected
 *
 * Validates: Requirements 8.1, 8.2
 *
 * Properties verified:
 *  P11-a: Content exceeding the Twitter 280-char limit always fails validateContent.
 *  P11-b: Content within the Twitter 280-char limit always passes validateContent.
 *  P11-c: Empty content always fails validation for any platform.
 *  P11-d: Whitespace-only content always fails validation.
 *  P11-e: Unknown platform always fails validation.
 */

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { PlatformPoster } from '../platform-poster.js';

// ---------------------------------------------------------------------------
// Minimal in-memory SocialPostsRepository stub
// ---------------------------------------------------------------------------

function createStubRepo() {
  const posts: Array<{ id: string; status: string; publishedAt: number | null; platform: string }> = [];
  return {
    insert: (input: { id: string; platform: string; contentHash: string; status?: string }) => {
      posts.push({ id: input.id, platform: input.platform, status: input.status ?? 'pending', publishedAt: null });
    },
    findById: (id: string) => posts.find((p) => p.id === id) ?? null,
    findByPlatform: (platform: string, limit: number) =>
      posts.filter((p) => p.platform === platform).slice(0, limit),
    findByStatus: (status: string, limit: number) =>
      posts.filter((p) => p.status === status).slice(0, limit),
    updatePublished: (id: string, postId: string, url: string, publishedAt: number) => {
      const p = posts.find((p) => p.id === id);
      if (p) { p.status = 'published'; p.publishedAt = publishedAt; }
    },
    updateFailed: (id: string) => {
      const p = posts.find((p) => p.id === id);
      if (p) p.status = 'failed';
    },
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TWITTER_LIMIT = 280;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Property 11 — PlatformPoster: character limit invariants', () => {
  const poster = new PlatformPoster(createStubRepo() as never);

  /**
   * P11-a: Any content > 280 chars for Twitter always fails validation.
   * Validates: Requirement 8.2
   */
  it('P11-a: content exceeding Twitter 280-char limit always fails validation', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: TWITTER_LIMIT + 1, maxLength: 5000 }),
        (content) => {
          const result = poster.validateContent(content, 'twitter');
          return result.valid === false && typeof result.reason === 'string';
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * P11-b: Non-empty content within 280 chars always passes Twitter validation.
   * Validates: Requirement 8.2
   */
  it('P11-b: content within Twitter 280-char limit always passes validation', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: TWITTER_LIMIT })
          .filter((s) => s.trim().length > 0),
        (content) => {
          const result = poster.validateContent(content, 'twitter');
          return result.valid === true;
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * P11-c: Empty string always fails for any platform.
   * Validates: Requirement 8.2
   */
  it('P11-c: empty content always fails for any known platform', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('twitter', 'webhook'),
        (platform) => {
          const result = poster.validateContent('', platform);
          return result.valid === false;
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * P11-d: Whitespace-only content always fails validation.
   * Validates: Requirement 8.2
   */
  it('P11-d: whitespace-only content always fails validation', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 })
          .map((s) => s.replace(/[^ \t\n\r]/g, ' '))
          .filter((s) => s.trim().length === 0 && s.length > 0),
        (whitespace) => {
          const result = poster.validateContent(whitespace, 'twitter');
          return result.valid === false;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * P11-e: Unknown platform always fails validation with a reason.
   * Validates: Requirement 8.2
   */
  it('P11-e: unknown platform always fails validation', () => {
    // Only use truly unknown platforms — exclude 'twitter', 'webhook',
    // and any names that could be JavaScript reserved property names
    // that might accidentally appear on PLATFORM_CHAR_LIMITS via prototype.
    const KNOWN_PLATFORMS = new Set(['twitter', 'webhook']);
    // Use alphanumeric-only names to avoid prototype pollution via special chars
    const arbUnknownPlatform = fc
      .stringMatching(/^[a-z][a-z0-9]{0,19}$/)
      .filter((s) => !KNOWN_PLATFORMS.has(s));

    fc.assert(
      fc.property(
        arbUnknownPlatform,
        fc.string({ minLength: 1, maxLength: 280 }),
        (platform, content) => {
          const result = poster.validateContent(content, platform);
          return result.valid === false && typeof result.reason === 'string';
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * P11-f: Content length boundary — exactly 280 chars is valid for Twitter.
   * Validates: Requirement 8.2 (boundary condition)
   */
  it('P11-f: content of exactly 280 characters passes Twitter validation', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: TWITTER_LIMIT, maxLength: TWITTER_LIMIT })
          .filter((s) => s.trim().length > 0),
        (content) => {
          const result = poster.validateContent(content, 'twitter');
          // If content is exactly 280 chars and non-empty, it should pass
          return content.length === TWITTER_LIMIT
            ? result.valid === true
            : result.valid === false;
        }
      ),
      { numRuns: 100 }
    );
  });
});
