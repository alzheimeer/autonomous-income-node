/**
 * Repository for the `social_posts` table.
 * Tracks content published to social platforms.
 */

import type { Database } from '../database.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type SocialPostStatus = 'pending' | 'published' | 'failed';

export interface SocialPostRecord {
  id: string;
  platform: string;
  postId: string | null;
  contentHash: string;
  status: SocialPostStatus;
  engagementUrl: string | null;
  publishedAt: number | null;
  createdAt: number;
}

export interface CreateSocialPostInput {
  id: string;
  platform: string;
  contentHash: string;
  status?: SocialPostStatus;
  postId?: string;
  engagementUrl?: string;
  publishedAt?: number;
  createdAt?: number;
}

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

interface SocialPostRow {
  id: string;
  platform: string;
  post_id: string | null;
  content_hash: string;
  status: string;
  engagement_url: string | null;
  published_at: number | null;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class SocialPostsRepository {
  constructor(private readonly db: Database) {}

  insert(input: CreateSocialPostInput): void {
    this.db
      .prepare<
        [
          string,
          string,
          string | null,
          string,
          string,
          string | null,
          number | null,
          number,
        ]
      >(`
        INSERT INTO social_posts
          (id, platform, post_id, content_hash, status, engagement_url,
           published_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.platform,
        input.postId ?? null,
        input.contentHash,
        input.status ?? 'pending',
        input.engagementUrl ?? null,
        input.publishedAt ?? null,
        input.createdAt ?? Date.now()
      );
  }

  findById(id: string): SocialPostRecord | null {
    const row = this.db
      .prepare<[string], SocialPostRow>('SELECT * FROM social_posts WHERE id = ?')
      .get(id) as SocialPostRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  findByPlatform(platform: string, limit = 50): SocialPostRecord[] {
    return (
      this.db
        .prepare<[string, number], SocialPostRow>(
          'SELECT * FROM social_posts WHERE platform = ? ORDER BY created_at DESC LIMIT ?'
        )
        .all(platform, limit) as SocialPostRow[]
    ).map((r) => this.toRecord(r));
  }

  findByStatus(status: SocialPostStatus, limit = 50): SocialPostRecord[] {
    return (
      this.db
        .prepare<[string, number], SocialPostRow>(
          'SELECT * FROM social_posts WHERE status = ? ORDER BY created_at DESC LIMIT ?'
        )
        .all(status, limit) as SocialPostRow[]
    ).map((r) => this.toRecord(r));
  }

  updatePublished(
    id: string,
    postId: string,
    engagementUrl: string,
    publishedAt?: number
  ): void {
    this.db
      .prepare<[string, string, number, string]>(`
        UPDATE social_posts
        SET status         = 'published',
            post_id        = ?,
            engagement_url = ?,
            published_at   = ?
        WHERE id = ?
      `)
      .run(postId, engagementUrl, publishedAt ?? Date.now(), id);
  }

  updateFailed(id: string): void {
    this.db
      .prepare<[string]>("UPDATE social_posts SET status = 'failed' WHERE id = ?")
      .run(id);
  }

  // ---------------------------------------------------------------------------
  // Mapping helpers
  // ---------------------------------------------------------------------------

  private toRecord(row: SocialPostRow): SocialPostRecord {
    return {
      id: row.id,
      platform: row.platform,
      postId: row.post_id,
      contentHash: row.content_hash,
      status: row.status as SocialPostStatus,
      engagementUrl: row.engagement_url,
      publishedAt: row.published_at,
      createdAt: row.created_at,
    };
  }
}
