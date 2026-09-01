/**
 * Repository for the `identity` table.
 * Stores wallet address, public key, and ERC-8004 registration data.
 */

import type { Database } from '../database.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface IdentityRecord {
  id: number;
  walletAddress: string;
  publicKey: string;
  registrationTxHash: string | null;
  registrationBlock: number | null;
  confirmed: boolean;
  createdAt: number;
}

export interface CreateIdentityInput {
  walletAddress: string;
  publicKey: string;
  createdAt?: number;
}

export interface UpdateRegistrationInput {
  registrationTxHash: string;
  registrationBlock: number;
  confirmed: boolean;
}

// ---------------------------------------------------------------------------
// Row type (SQLite returns plain objects with snake_case columns)
// ---------------------------------------------------------------------------

interface IdentityRow {
  id: number;
  wallet_address: string;
  public_key: string;
  registration_tx_hash: string | null;
  registration_block: number | null;
  confirmed: number; // SQLite BOOLEAN is stored as 0/1
  created_at: number;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class IdentityRepository {
  constructor(private readonly db: Database) {}

  /** Insert a new identity record. Returns the inserted id. */
  create(input: CreateIdentityInput): number {
    const stmt = this.db.prepare<
      [string, string, number],
      IdentityRow
    >(`
      INSERT INTO identity (wallet_address, public_key, created_at)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(
      input.walletAddress,
      input.publicKey,
      input.createdAt ?? Date.now()
    );
    return result.lastInsertRowid as number;
  }

  /** Retrieve the single identity record (there is only ever one). */
  get(): IdentityRecord | null {
    const row = this.db
      .prepare<[], IdentityRow>('SELECT * FROM identity LIMIT 1')
      .get() as IdentityRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  /** Find by wallet address. */
  findByAddress(walletAddress: string): IdentityRecord | null {
    const row = this.db
      .prepare<[string], IdentityRow>(
        'SELECT * FROM identity WHERE wallet_address = ?'
      )
      .get(walletAddress) as IdentityRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  /** Update ERC-8004 registration fields after on-chain confirmation. */
  updateRegistration(id: number, input: UpdateRegistrationInput): void {
    this.db
      .prepare<[string, number, number, number]>(`
        UPDATE identity
        SET registration_tx_hash = ?,
            registration_block   = ?,
            confirmed            = ?
        WHERE id = ?
      `)
      .run(
        input.registrationTxHash,
        input.registrationBlock,
        input.confirmed ? 1 : 0,
        id
      );
  }

  // ---------------------------------------------------------------------------
  // Mapping helpers
  // ---------------------------------------------------------------------------

  private toRecord(row: IdentityRow): IdentityRecord {
    return {
      id: row.id,
      walletAddress: row.wallet_address,
      publicKey: row.public_key,
      registrationTxHash: row.registration_tx_hash,
      registrationBlock: row.registration_block,
      confirmed: Boolean(row.confirmed),
      createdAt: row.created_at,
    };
  }
}
