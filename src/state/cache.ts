/**
 * Optional Redis cache wrapper (ioredis) with silent fallback.
 * If REDIS_URL is not set, all methods are no-ops and the caller
 * falls through to SQLite without any error.
 * Requirement: 12.4
 */

import type { Redis as RedisClient } from 'ioredis';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheConfig {
  /** Redis connection URL. Defaults to REDIS_URL env var. */
  url?: string;
  /** Key prefix for all cache entries. Default: 'ain:' */
  keyPrefix?: string;
  /** Default TTL in seconds for set operations. Default: 60 */
  defaultTtl?: number;
}

// ---------------------------------------------------------------------------
// AgentCache
// ---------------------------------------------------------------------------

export class AgentCache {
  private client: RedisClient | null = null;
  private readonly keyPrefix: string;
  private readonly defaultTtl: number;
  private connected = false;

  constructor(config: CacheConfig = {}) {
    this.keyPrefix = config.keyPrefix ?? 'ain:';
    this.defaultTtl = config.defaultTtl ?? 60;

    const url = config.url ?? process.env['REDIS_URL'];
    if (url) {
      this.connect(url);
    }
    // No URL → stay disconnected silently (Redis is optional)
  }

  /** Whether the cache backend is available. */
  get isAvailable(): boolean {
    return this.connected && this.client !== null;
  }

  // ---------------------------------------------------------------------------
  // Cache operations (all silent no-ops when Redis is not configured)
  // ---------------------------------------------------------------------------

  /** Set a value with optional TTL in seconds. */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.client) return;
    try {
      const ttl = ttlSeconds ?? this.defaultTtl;
      await this.client.set(this.prefixed(key), value, 'EX', ttl);
    } catch {
      // Silent fallback — don't crash the agent over cache failures
    }
  }

  /** Get a value. Returns null on cache miss or if Redis is unavailable. */
  async get(key: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      return await this.client.get(this.prefixed(key));
    } catch {
      return null;
    }
  }

  /** Delete a key. */
  async del(key: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.del(this.prefixed(key));
    } catch {
      // Silent
    }
  }

  /** Increment a counter atomically. Returns the new value or null if unavailable. */
  async incr(key: string): Promise<number | null> {
    if (!this.client) return null;
    try {
      return await this.client.incr(this.prefixed(key));
    } catch {
      return null;
    }
  }

  /** Set a counter value with TTL (used for rate limit windows). */
  async setCounter(key: string, value: number, ttlSeconds: number): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.set(this.prefixed(key), String(value), 'EX', ttlSeconds);
    } catch {
      // Silent
    }
  }

  /** Get a counter value. Returns null on miss or unavailability. */
  async getCounter(key: string): Promise<number | null> {
    if (!this.client) return null;
    try {
      const val = await this.client.get(this.prefixed(key));
      return val !== null ? parseInt(val, 10) : null;
    } catch {
      return null;
    }
  }

  /** Cache a JSON-serialisable object. */
  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  /** Retrieve and parse a JSON-cached object. Returns null on miss. */
  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** Gracefully disconnect. */
  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        // Ignore errors on shutdown
      }
      this.client = null;
      this.connected = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private prefixed(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /** Connect to Redis. Failures are silently swallowed. */
  private connect(url: string): void {
    // Dynamic import so that the module loads even if ioredis is not installed
    import('ioredis')
      .then(({ Redis }) => {
        const client = new Redis(url, {
          // Don't retry forever — if Redis isn't there, skip it
          maxRetriesPerRequest: 1,
          retryStrategy: (times: number) => (times > 2 ? null : 100),
          lazyConnect: true,
          enableOfflineQueue: false,
        });

        client.on('connect', () => {
          this.connected = true;
        });

        client.on('close', () => {
          this.connected = false;
        });

        client.on('error', () => {
          // Silently absorb — Redis errors must never crash the agent
          this.connected = false;
        });

        // Initiate the connection; failures are handled by the error listener
        void client.connect().catch(() => {
          // Silent
        });

        this.client = client;
      })
      .catch(() => {
        // ioredis not installed or not importable — silently skip
      });
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _cacheInstance: AgentCache | null = null;

export function getCache(config?: CacheConfig): AgentCache {
  if (!_cacheInstance) {
    _cacheInstance = new AgentCache(config);
  }
  return _cacheInstance;
}

export function resetCacheInstance(): void {
  if (_cacheInstance) {
    void _cacheInstance.close();
    _cacheInstance = null;
  }
}
