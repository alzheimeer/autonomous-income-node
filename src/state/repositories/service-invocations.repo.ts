/**
 * Repository for the `service_invocations` table.
 *
 * Tracks invocation counts, revenue, latency, and error rates per service type.
 * Requirement: 7.6
 */

import type { Database } from '../database.js';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface ServiceInvocationRecord {
  id: string;
  serviceId: string;
  paymentId: string | null;
  success: boolean;
  latencyMs: number | null;
  invokedAt: number;
}

export interface CreateServiceInvocationInput {
  id?: string;
  serviceId: string;
  paymentId?: string;
  success: boolean;
  latencyMs?: number;
  invokedAt?: number;
}

export interface ServiceStats {
  serviceId: string;
  totalInvocations: number;
  successfulInvocations: number;
  failedInvocations: number;
  errorRate: number;
  avgLatencyMs: number | null;
  /** Total revenue = number of successful invocations (caller multiplies by price) */
  totalSuccessCount: number;
}

// ---------------------------------------------------------------------------
// Row type (SQLite snake_case)
// ---------------------------------------------------------------------------

interface ServiceInvocationRow {
  id: string;
  service_id: string;
  payment_id: string | null;
  success: number; // SQLite stores booleans as 0/1
  latency_ms: number | null;
  invoked_at: number;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class ServiceInvocationsRepository {
  constructor(private readonly db: Database) {}

  /**
   * Insert a new service invocation record.
   * Returns the generated (or supplied) ID.
   */
  insert(input: CreateServiceInvocationInput): string {
    const id = input.id ?? uuidv4();

    this.db
      .prepare<
        [string, string, string | null, number, number | null, number]
      >(`
        INSERT INTO service_invocations
          (id, service_id, payment_id, success, latency_ms, invoked_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.serviceId,
        input.paymentId ?? null,
        input.success ? 1 : 0,
        input.latencyMs ?? null,
        input.invokedAt ?? Date.now(),
      );

    return id;
  }

  /**
   * Find a single invocation record by ID.
   */
  findById(id: string): ServiceInvocationRecord | null {
    const row = this.db
      .prepare<[string], ServiceInvocationRow>(
        'SELECT * FROM service_invocations WHERE id = ?',
      )
      .get(id) as ServiceInvocationRow | undefined;

    return row ? this._toRecord(row) : null;
  }

  /**
   * List invocations for a given serviceId, newest first.
   */
  findByServiceId(serviceId: string, limit = 100): ServiceInvocationRecord[] {
    return (
      this.db
        .prepare<[string, number], ServiceInvocationRow>(
          'SELECT * FROM service_invocations WHERE service_id = ? ORDER BY invoked_at DESC LIMIT ?',
        )
        .all(serviceId, limit) as ServiceInvocationRow[]
    ).map((r) => this._toRecord(r));
  }

  /**
   * Return aggregated statistics per service ID.
   * Requirement: 7.6 — track invocation counts, latency, error rates.
   */
  getStatsByServiceId(serviceId: string): ServiceStats {
    const row = this.db
      .prepare<
        [string],
        {
          total: number;
          success_count: number;
          avg_latency: number | null;
        }
      >(
        `SELECT
           COUNT(*) AS total,
           SUM(success) AS success_count,
           AVG(latency_ms) AS avg_latency
         FROM service_invocations
         WHERE service_id = ?`,
      )
      .get(serviceId) as
      | { total: number; success_count: number; avg_latency: number | null }
      | undefined;

    const total = row?.total ?? 0;
    const successCount = row?.success_count ?? 0;
    const failedCount = total - successCount;

    return {
      serviceId,
      totalInvocations: total,
      successfulInvocations: successCount,
      failedInvocations: failedCount,
      errorRate: total > 0 ? failedCount / total : 0,
      avgLatencyMs: row?.avg_latency ?? null,
      totalSuccessCount: successCount,
    };
  }

  /**
   * Return aggregated stats for all services (for dashboard / metrics).
   */
  getAllStats(): ServiceStats[] {
    const rows = this.db
      .prepare<
        [],
        {
          service_id: string;
          total: number;
          success_count: number;
          avg_latency: number | null;
        }
      >(
        `SELECT
           service_id,
           COUNT(*) AS total,
           SUM(success) AS success_count,
           AVG(latency_ms) AS avg_latency
         FROM service_invocations
         GROUP BY service_id`,
      )
      .all() as Array<{
        service_id: string;
        total: number;
        success_count: number;
        avg_latency: number | null;
      }>;

    return rows.map((r) => {
      const total = r.total;
      const successCount = r.success_count;
      const failedCount = total - successCount;
      return {
        serviceId: r.service_id,
        totalInvocations: total,
        successfulInvocations: successCount,
        failedInvocations: failedCount,
        errorRate: total > 0 ? failedCount / total : 0,
        avgLatencyMs: r.avg_latency,
        totalSuccessCount: successCount,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Mapping helpers
  // ---------------------------------------------------------------------------

  private _toRecord(row: ServiceInvocationRow): ServiceInvocationRecord {
    return {
      id: row.id,
      serviceId: row.service_id,
      paymentId: row.payment_id,
      success: row.success === 1,
      latencyMs: row.latency_ms,
      invokedAt: row.invoked_at,
    };
  }
}
