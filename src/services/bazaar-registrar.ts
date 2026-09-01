/**
 * x402 Bazaar Service Registration Module
 *
 * Registers, updates, and deregisters the agent's x402 services on the
 * x402 Bazaar discovery layer so other agents and clients can find them.
 *
 * - HTTP client: native fetch (Node 20+)
 * - Retry: exponential backoff (1s, 2s, 4s) up to config.retryAttempts
 * - Persistence: BazaarListingsRepository (SQLite)
 * - Graceful skip if apiUrl is not configured
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';
import type { BazaarConfig } from '../config/income-sustainability.config.js';
import type { BazaarListingsRepository } from '../state/repositories/bazaar-listings.repo.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Interfaces
// ═══════════════════════════════════════════════════════════════════════════════

export interface BazaarServiceListing {
  serviceId: string;
  name: string;
  description: string;
  priceUsdc: bigint;
  endpointUrl: string;
  inputSchema: Record<string, unknown>;
}

export interface BazaarRegistrationResult {
  listingId: string;
  registeredAt: number;
  expiresAt: number;
}

export interface IBazaarRegistrar {
  register(service: BazaarServiceListing): Promise<BazaarRegistrationResult>;
  update(listingId: string, updates: Partial<BazaarServiceListing>): Promise<void>;
  deregister(listingId: string): Promise<void>;
  getActiveListings(): BazaarRegistrationResult[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

const log = createLogger('bazaar-registrar');

/**
 * Delay utility for exponential backoff.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * BazaarRegistrar — manages service listings on the x402 Bazaar.
 */
export class BazaarRegistrar implements IBazaarRegistrar {
  private readonly config: BazaarConfig;
  private readonly repo: BazaarListingsRepository;

  constructor(config: BazaarConfig, repo: BazaarListingsRepository) {
    this.config = config;
    this.repo = repo;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Public API
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Register a service on the x402 Bazaar. Req 2.1, 2.2
   */
  async register(service: BazaarServiceListing): Promise<BazaarRegistrationResult> {
    if (!this.isConfigured()) {
      log.warn('Bazaar API URL not configured — skipping registration', {
        serviceId: service.serviceId,
      });
      // Return a local-only result so the caller can continue gracefully
      const now = Date.now();
      return { listingId: `local-${randomUUID()}`, registeredAt: now, expiresAt: 0 };
    }

    const url = `${this.config.apiUrl}/v1/services`;
    const body = {
      serviceId: service.serviceId,
      name: service.name,
      description: service.description,
      priceUsdc: service.priceUsdc.toString(),
      endpointUrl: service.endpointUrl,
      inputSchema: service.inputSchema,
    };

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as {
      listingId: string;
      registeredAt: number;
      expiresAt: number;
    };

    const result: BazaarRegistrationResult = {
      listingId: data.listingId,
      registeredAt: data.registeredAt,
      expiresAt: data.expiresAt,
    };

    // Persist to DB (Req 2.3)
    this.repo.insert({
      id: randomUUID(),
      service_id: service.serviceId,
      listing_id: result.listingId,
      endpoint_url: service.endpointUrl,
      registered_at: result.registeredAt,
      expires_at: result.expiresAt || null,
      status: 'active',
    });

    log.info('Service registered on Bazaar', {
      serviceId: service.serviceId,
      listingId: result.listingId,
    });

    return result;
  }

  /**
   * Update an existing listing (e.g. when endpoint URL changes). Req 2.4
   * Should be triggered within 60s of an endpoint change.
   */
  async update(listingId: string, updates: Partial<BazaarServiceListing>): Promise<void> {
    if (!this.isConfigured()) {
      log.warn('Bazaar API URL not configured — skipping update', { listingId });
      return;
    }

    const url = `${this.config.apiUrl}/v1/services/${listingId}`;
    const body: Record<string, unknown> = {};

    if (updates.name !== undefined) body['name'] = updates.name;
    if (updates.description !== undefined) body['description'] = updates.description;
    if (updates.priceUsdc !== undefined) body['priceUsdc'] = updates.priceUsdc.toString();
    if (updates.endpointUrl !== undefined) body['endpointUrl'] = updates.endpointUrl;
    if (updates.inputSchema !== undefined) body['inputSchema'] = updates.inputSchema;

    await this.fetchWithRetry(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    // Update local DB if endpoint changed
    if (updates.endpointUrl) {
      const listing = this.findListingByListingId(listingId);
      if (listing) {
        this.repo.updateEndpointUrl(listing.id, updates.endpointUrl);
      }
    }

    log.info('Bazaar listing updated', { listingId, updates: Object.keys(body) });
  }

  /**
   * Remove a listing from the Bazaar.
   */
  async deregister(listingId: string): Promise<void> {
    if (!this.isConfigured()) {
      log.warn('Bazaar API URL not configured — skipping deregistration', { listingId });
      return;
    }

    const url = `${this.config.apiUrl}/v1/services/${listingId}`;

    await this.fetchWithRetry(url, { method: 'DELETE' });

    // Update DB status
    const listing = this.findListingByListingId(listingId);
    if (listing) {
      this.repo.updateStatus(listing.id, 'deregistered');
    }

    log.info('Service deregistered from Bazaar', { listingId });
  }

  /**
   * Get all current agent listings from DB cache.
   */
  getActiveListings(): BazaarRegistrationResult[] {
    const rows = this.repo.getActive();
    return rows.map((row) => ({
      listingId: row.listing_id,
      registeredAt: row.registered_at,
      expiresAt: row.expires_at ?? 0,
    }));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Check whether the Bazaar API URL is configured.
   */
  private isConfigured(): boolean {
    return this.config.apiUrl.trim().length > 0;
  }

  /**
   * Find a listing row in the DB by its Bazaar listing ID.
   */
  private findListingByListingId(listingId: string) {
    const activeRows = this.repo.getActive();
    return activeRows.find((r) => r.listing_id === listingId) ?? null;
  }

  /**
   * Perform an HTTP fetch with exponential backoff retry logic. Req 2.5
   * Delay: 1000ms * 2^attempt (1s, 2s, 4s, ...)
   */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    const maxAttempts = this.config.retryAttempts || 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(url, init);

        if (response.ok) {
          return response;
        }

        // Non-retryable client errors (4xx except 429)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          const errorBody = await response.text().catch(() => 'unknown');
          const error = new Error(
            `Bazaar API error ${response.status}: ${errorBody}`,
          );
          log.error('Bazaar API client error (not retrying)', {
            url,
            status: response.status,
            attempt: attempt + 1,
            body: errorBody,
          });
          throw error;
        }

        // Server error or rate limit — retry
        log.warn('Bazaar API error, will retry', {
          url,
          status: response.status,
          attempt: attempt + 1,
          maxAttempts,
        });
      } catch (err: unknown) {
        // Network or parse errors
        if (attempt === maxAttempts - 1) {
          log.error('Bazaar API request failed after all retries', {
            url,
            attempt: attempt + 1,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }

        log.warn('Bazaar API network error, will retry', {
          url,
          attempt: attempt + 1,
          maxAttempts,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Exponential backoff: 1000ms * 2^attempt
      const backoffMs = 1000 * Math.pow(2, attempt);
      await delay(backoffMs);
    }

    // Should not reach here, but TypeScript requires a return
    throw new Error(`Bazaar API request failed after ${maxAttempts} attempts`);
  }
}
