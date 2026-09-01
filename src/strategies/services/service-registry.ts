/**
 * ServiceRegistry — manages service descriptors, handlers, and invocation tracking.
 *
 * Responsibilities:
 *  - Hold the catalogue of all available services (built-in + dynamically added).
 *  - Execute a service by ID, recording latency, success/failure, and payment link.
 *  - Track invocations in the `service_invocations` SQLite table via
 *    ServiceInvocationsRepository (Req 7.6).
 *
 * Requirements: 7.1, 7.3, 7.6
 */

import type { ServiceInvocationsRepository } from '../../state/repositories/service-invocations.repo.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * JSON Schema object used to describe the parameters accepted by a service.
 */
export interface JSONSchema {
  type?: string | string[] | readonly string[];
  properties?: Record<string, JSONSchema>;
  required?: readonly string[];
  additionalProperties?: boolean | JSONSchema;
  items?: JSONSchema;
  description?: string;
  [key: string]: unknown;
}

/**
 * Result returned by every service handler.
 */
export interface ServiceResult {
  success: boolean;
  data?: unknown;
  error?: string;
  latencyMs: number;
}

/**
 * A function that performs the actual work for a service.
 * Receives the validated params object and returns a ServiceResult.
 */
export type ServiceHandler = (params: unknown) => Promise<ServiceResult>;

/**
 * Full descriptor of a service offered by the node.
 */
export interface ServiceDescriptor {
  id: string;
  name: string;
  description: string;
  /** Price in 6-decimal USDC units (e.g. 500_000n = $0.50). */
  priceUsdc: bigint;
  /** Maximum execution time in milliseconds before the handler is timed out. */
  timeoutMs: number;
  /** JSON Schema that the params object must conform to. */
  schema: JSONSchema;
}

/**
 * A service pairing a descriptor with its implementation.
 */
export interface RegisteredService {
  descriptor: ServiceDescriptor;
  handler: ServiceHandler;
}

// ---------------------------------------------------------------------------
// ServiceRegistry
// ---------------------------------------------------------------------------

export interface ServiceRegistryOptions {
  /**
   * Optional SQLite repository for invocation tracking.
   * When omitted, invocations are not persisted (useful in tests).
   */
  invocationsRepo?: ServiceInvocationsRepository;
  /**
   * Initial set of services to register.
   */
  services?: RegisteredService[];
}

export class ServiceRegistry {
  private readonly services = new Map<string, RegisteredService>();
  private readonly invocationsRepo: ServiceInvocationsRepository | null;

  constructor(opts: ServiceRegistryOptions = {}) {
    this.invocationsRepo = opts.invocationsRepo ?? null;

    // Register initial services
    for (const svc of opts.services ?? []) {
      this.register(svc);
    }
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Register a service. Overwrites any existing service with the same ID.
   */
  register(service: RegisteredService): void {
    this.services.set(service.descriptor.id, service);
  }

  /**
   * Remove a service from the registry.
   * Returns true if the service existed and was removed.
   */
  unregister(serviceId: string): boolean {
    return this.services.delete(serviceId);
  }

  /**
   * Return all registered service descriptors (without handlers).
   */
  listDescriptors(): ServiceDescriptor[] {
    return Array.from(this.services.values()).map((s) => s.descriptor);
  }

  /**
   * Get the full registered service (descriptor + handler) by ID, or undefined.
   */
  get(serviceId: string): RegisteredService | undefined {
    return this.services.get(serviceId);
  }

  /**
   * Check whether a service ID exists in the registry.
   */
  has(serviceId: string): boolean {
    return this.services.has(serviceId);
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  /**
   * Execute a service by ID, applying the timeout defined in the descriptor.
   *
   * Tracks the invocation (latency, success/failure) in SQLite if a repo is
   * available (Req 7.6). Accepts an optional `paymentId` to link the invocation
   * to a payment record.
   *
   * @returns ServiceResult — always resolves (never rejects).
   */
  async execute(
    serviceId: string,
    params: unknown,
    paymentId?: string,
  ): Promise<ServiceResult> {
    const svc = this.services.get(serviceId);

    if (!svc) {
      const result: ServiceResult = {
        success: false,
        error: `Service "${serviceId}" is not registered.`,
        latencyMs: 0,
      };
      // Track even failed lookups so the operator can see unknown service calls.
      this._trackInvocation(serviceId, result, paymentId);
      return result;
    }

    const startMs = Date.now();
    let result: ServiceResult;

    try {
      result = await this._executeWithTimeout(
        svc.handler(params),
        svc.descriptor.timeoutMs,
        `Service "${serviceId}" timed out after ${svc.descriptor.timeoutMs}ms`,
      );
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      result = {
        success: false,
        error: `Service "${serviceId}" threw an unexpected error: ${(err as Error).message}`,
        latencyMs,
      };
    }

    this._trackInvocation(serviceId, result, paymentId);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Run a promise with a hard timeout.
   * Rejects with a descriptive error if `timeoutMs` elapses first.
   */
  private _executeWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, timeoutMs);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /**
   * Persist an invocation record in the `service_invocations` table.
   * Silently swallows errors — tracking must never crash the service call.
   */
  private _trackInvocation(
    serviceId: string,
    result: ServiceResult,
    paymentId?: string,
  ): void {
    if (!this.invocationsRepo) return;

    try {
      this.invocationsRepo.insert({
        serviceId,
        paymentId,
        success: result.success,
        latencyMs: result.latencyMs,
        invokedAt: Date.now(),
      });
    } catch (err) {
      // Non-fatal: tracking failure must never propagate
      console.error('[ServiceRegistry] Failed to track invocation:', err);
    }
  }
}
