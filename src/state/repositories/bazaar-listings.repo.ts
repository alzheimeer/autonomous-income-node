/**
 * Repository for the `bazaar_listings` table.
 * Tracks x402 Bazaar service registrations.
 */

import type { Database } from '../database.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface BazaarListingRow {
  id: string;
  service_id: string;
  listing_id: string;
  endpoint_url: string;
  registered_at: number;
  expires_at: number | null;
  last_updated_at: number | null;
  status: string;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface InsertBazaarListingInput {
  id: string;
  service_id: string;
  listing_id: string;
  endpoint_url: string;
  registered_at?: number;
  expires_at?: number | null;
  status?: string;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class BazaarListingsRepository {
  constructor(private readonly db: Database) {}

  insert(listing: InsertBazaarListingInput): void {
    this.db
      .prepare<
        [string, string, string, string, number, number | null, string]
      >(`
        INSERT INTO bazaar_listings
          (id, service_id, listing_id, endpoint_url, registered_at, expires_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        listing.id,
        listing.service_id,
        listing.listing_id,
        listing.endpoint_url,
        listing.registered_at ?? Date.now(),
        listing.expires_at ?? null,
        listing.status ?? 'active',
      );
  }

  getActive(): BazaarListingRow[] {
    return this.db
      .prepare<[], BazaarListingRow>(
        "SELECT * FROM bazaar_listings WHERE status = 'active' ORDER BY registered_at DESC"
      )
      .all() as BazaarListingRow[];
  }

  getByServiceId(serviceId: string): BazaarListingRow | null {
    const row = this.db
      .prepare<[string], BazaarListingRow>(
        'SELECT * FROM bazaar_listings WHERE service_id = ? LIMIT 1'
      )
      .get(serviceId) as BazaarListingRow | undefined;
    return row ?? null;
  }

  updateEndpointUrl(id: string, url: string): void {
    this.db
      .prepare<[string, number, string]>(
        'UPDATE bazaar_listings SET endpoint_url = ?, last_updated_at = ? WHERE id = ?'
      )
      .run(url, Date.now(), id);
  }

  updateStatus(id: string, status: string): void {
    this.db
      .prepare<[string, string]>(
        'UPDATE bazaar_listings SET status = ? WHERE id = ?'
      )
      .run(status, id);
  }
}
