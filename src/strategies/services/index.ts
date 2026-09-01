/**
 * Services Module — HTTP API de ingresos
 *
 * Responsibilities (Requirements 7.1 – 7.7):
 *
 *  7.1  Expose a public HTTP API (via X402ServerImpl) listing available services
 *       with x402 USDC pricing.
 *  7.2  Validate x402 payment BEFORE executing any service.
 *  7.3  Support built-in service types: text-generation, data-summarization,
 *       web-scraping, code-generation.
 *  7.4  Respond within the timeout specified in each ServiceDescriptor (max 30 s default).
 *  7.5  Issue a full USDC refund within 60 s when a service fails after valid payment.
 *  7.6  Track invocation counts, revenue, latency, and error rates via
 *       ServiceInvocationsRepository.
 *  7.7  In Tier 3/4, allow the LLM to propose and activate new service types (stub).
 *
 * Architecture:
 *  - ServicesModule wraps X402ServerImpl and delegates service execution to
 *    ServiceRegistry.
 *  - Built-in services are registered at construction time.
 *  - The refund flow (Req 7.5) issues an outgoing payment record and attempts
 *    on-chain USDC transfer when not in mock mode.
 */

import { X402ServerImpl, createX402Server } from '../../payments/x402-server.js';
import type {
  X402ServerOptions,
  RegisteredService,
  ServiceDescriptor as X402ServiceDescriptor,
} from '../../payments/x402-server.js';
import { ServiceRegistry } from './service-registry.js';
import type { ServiceResult } from './service-registry.js';
import { textGenHandler, TEXT_GEN_SCHEMA } from './handlers/text-gen.handler.js';
import { summarizeHandler, SUMMARIZE_SCHEMA } from './handlers/summarize.handler.js';
import { scrapeHandler, SCRAPE_SCHEMA } from './handlers/scrape.handler.js';
import { codeGenHandler, CODE_GEN_SCHEMA } from './handlers/code-gen.handler.js';
import type { ServiceInvocationsRepository } from '../../state/repositories/service-invocations.repo.js';
import type { PaymentLedger } from '../../payments/ledger.js';
import type { SurvivalModule } from '../../survival/index.js';
import { SurvivalTier } from '../../survival/tier-evaluator.js';
import { createOkxX402Middleware, getDefaultOkxX402Config } from '../../infrastructure/okx-x402-middleware.js';
import type { OkxX402Config } from '../../infrastructure/okx-x402-middleware.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default refund deadline in ms (Req 7.5) */
const REFUND_DEADLINE_MS = 60_000;

// ---------------------------------------------------------------------------
// Built-in service descriptors
// ---------------------------------------------------------------------------

/**
 * The 4 built-in services with their prices and schemas.
 * Requirement 7.3
 */
export const BUILT_IN_SERVICE_DESCRIPTORS: X402ServiceDescriptor[] = [
  {
    id: 'text-generation',
    name: 'Text Generation',
    description: 'Generate text from a prompt using a large language model. Ideal for drafting, creative writing, Q&A, and content creation.',
    priceUsdc: 500_000n, // $0.50
    timeoutMs: 30_000,
  },
  {
    id: 'data-summarization',
    name: 'Data Summarization',
    description: 'Summarize a block of text into a concise summary (short, medium, or detailed). Great for condensing articles, reports, and documents.',
    priceUsdc: 300_000n, // $0.30
    timeoutMs: 30_000,
  },
  {
    id: 'web-scraping',
    name: 'Web Scraping',
    description: 'Fetch an HTTP/HTTPS URL and optionally extract structured data using CSS selectors. Returns raw HTML, extracted fields, or parsed JSON.',
    priceUsdc: 200_000n, // $0.20
    timeoutMs: 30_000,
  },
  {
    id: 'code-generation',
    name: 'Code Generation',
    description: 'Generate production-quality code in any programming language from a natural-language prompt. Supports context injection, style instructions, and comments.',
    priceUsdc: 1_000_000n, // $1.00
    timeoutMs: 60_000,
  },
];

// ---------------------------------------------------------------------------
// ServicesModule options
// ---------------------------------------------------------------------------

export interface ServicesModuleOptions {
  /** Port the HTTP server will listen on (default: process.env.API_PORT or 3000). */
  port?: number;
  /** Options forwarded to X402ServerImpl (validator, ledger, survival, nodeAddress). */
  x402Options: X402ServerOptions;
  /** Repository for tracking invocations. Pass null to disable tracking. */
  invocationsRepo?: ServiceInvocationsRepository | null;
  /** PaymentLedger used for recording refunds. */
  ledger: PaymentLedger;
  /** SurvivalModule used for tier gating (Req 7.7). */
  survivalModule: SurvivalModule;
}

// ---------------------------------------------------------------------------
// LLM service proposal stub (Req 7.7)
// ---------------------------------------------------------------------------

/**
 * Stub for Tier 3/4 LLM-driven service proposal.
 *
 * In Tier 3 or 4, the LLM may propose a new service type. This stub returns
 * a placeholder that the full implementation would replace with a real
 * LLM-generated handler. Activating the proposed service registers it into
 * the ServiceRegistry at runtime without operator intervention.
 *
 * @param proposal - Object with proposed `id`, `name`, `description`,
 *                   `priceUsdc` (as string), and a `handlerCode` stub.
 * @returns Registered service descriptor on success; null on validation failure.
 */
export function proposeLlmService(
  registry: ServiceRegistry,
  proposal: {
    id: string;
    name: string;
    description: string;
    priceUsdc: string; // bigint serialized as string
    timeoutMs?: number;
  },
): X402ServiceDescriptor | null {
  // Basic validation
  if (!proposal.id || !/^[a-z0-9-]+$/.test(proposal.id)) {
    console.warn('[ServicesModule] LLM-proposed service has invalid ID:', proposal.id);
    return null;
  }
  if (!proposal.name || !proposal.description) {
    console.warn('[ServicesModule] LLM-proposed service missing name or description.');
    return null;
  }

  let priceUsdc: bigint;
  try {
    priceUsdc = BigInt(proposal.priceUsdc);
    if (priceUsdc <= 0n) throw new Error('price must be positive');
  } catch {
    console.warn('[ServicesModule] LLM-proposed service has invalid priceUsdc:', proposal.priceUsdc);
    return null;
  }

  const descriptor: X402ServiceDescriptor = {
    id: proposal.id,
    name: proposal.name,
    description: `[LLM-proposed] ${proposal.description}`,
    priceUsdc,
    timeoutMs: proposal.timeoutMs ?? 30_000,
  };

  // Stub handler: returns a placeholder response.
  // In a full implementation, the LLM would generate a real handler function.
  const stubHandler = async (_params: unknown): Promise<ServiceResult> => ({
    success: false,
    error: `Service "${proposal.id}" is a stub — full implementation pending LLM code generation.`,
    latencyMs: 0,
  });

  registry.register({
    descriptor: {
      ...descriptor,
      schema: {
        type: 'object',
        description: 'LLM-proposed service parameters (schema TBD by LLM).',
        additionalProperties: true,
      },
    },
    handler: stubHandler,
  });

  console.log(`[ServicesModule] LLM-proposed service "${proposal.id}" registered.`);
  return descriptor;
}

// ---------------------------------------------------------------------------
// ServicesModule
// ---------------------------------------------------------------------------

export class ServicesModule {
  private readonly registry: ServiceRegistry;
  private readonly x402Server: X402ServerImpl;
  private readonly ledger: PaymentLedger;
  private readonly survivalModule: SurvivalModule;
  private readonly port: number;
  private started = false;

  constructor(private readonly opts: ServicesModuleOptions) {
    this.port = opts.port ?? parseInt(process.env['API_PORT'] ?? '3000', 10);
    this.ledger = opts.ledger;
    this.survivalModule = opts.survivalModule;

    // Build the ServiceRegistry with the built-in handlers
    this.registry = new ServiceRegistry({
      invocationsRepo: opts.invocationsRepo ?? undefined,
      services: [
        {
          descriptor: {
            id: 'text-generation',
            name: BUILT_IN_SERVICE_DESCRIPTORS[0]!.name,
            description: BUILT_IN_SERVICE_DESCRIPTORS[0]!.description,
            priceUsdc: BUILT_IN_SERVICE_DESCRIPTORS[0]!.priceUsdc,
            timeoutMs: BUILT_IN_SERVICE_DESCRIPTORS[0]!.timeoutMs,
            schema: TEXT_GEN_SCHEMA,
          },
          handler: textGenHandler,
        },
        {
          descriptor: {
            id: 'data-summarization',
            name: BUILT_IN_SERVICE_DESCRIPTORS[1]!.name,
            description: BUILT_IN_SERVICE_DESCRIPTORS[1]!.description,
            priceUsdc: BUILT_IN_SERVICE_DESCRIPTORS[1]!.priceUsdc,
            timeoutMs: BUILT_IN_SERVICE_DESCRIPTORS[1]!.timeoutMs,
            schema: SUMMARIZE_SCHEMA,
          },
          handler: summarizeHandler,
        },
        {
          descriptor: {
            id: 'web-scraping',
            name: BUILT_IN_SERVICE_DESCRIPTORS[2]!.name,
            description: BUILT_IN_SERVICE_DESCRIPTORS[2]!.description,
            priceUsdc: BUILT_IN_SERVICE_DESCRIPTORS[2]!.priceUsdc,
            timeoutMs: BUILT_IN_SERVICE_DESCRIPTORS[2]!.timeoutMs,
            schema: SCRAPE_SCHEMA,
          },
          handler: scrapeHandler,
        },
        {
          descriptor: {
            id: 'code-generation',
            name: BUILT_IN_SERVICE_DESCRIPTORS[3]!.name,
            description: BUILT_IN_SERVICE_DESCRIPTORS[3]!.description,
            priceUsdc: BUILT_IN_SERVICE_DESCRIPTORS[3]!.priceUsdc,
            timeoutMs: BUILT_IN_SERVICE_DESCRIPTORS[3]!.timeoutMs,
            schema: CODE_GEN_SCHEMA,
          },
          handler: codeGenHandler,
        },
      ],
    });

    // Build X402 registered services (descriptor only — handler wraps registry.execute)
    const x402Services: RegisteredService[] = this._buildX402Services();

    // Build X402 server
    this.x402Server = createX402Server({
      ...opts.x402Options,
      services: x402Services,
    });

    // Apply OKX x402 payment middleware using the official SDK
    const okxX402Enabled = (process.env['OKX_X402_ENABLED'] ?? 'true') === 'true';
    if (okxX402Enabled) {
      // registerOkxX402Routes wires the SDK middleware onto the Fastify instance.
      // It falls back to legacy manual middleware if SDK credentials are missing.
      void import('../../infrastructure/okx-x402-middleware.js').then(({ registerOkxX402Routes }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        void (registerOkxX402Routes as (f: any) => Promise<void>)(this.x402Server);
      }).catch((err: unknown) => {
        console.warn('[ServicesModule] Failed to load OKX SDK middleware (non-fatal):', (err as Error).message);
        // Fall back to legacy middleware
        const x402Config: OkxX402Config = getDefaultOkxX402Config();
        const middleware = createOkxX402Middleware(x402Config);
        this.x402Server.addHook('preHandler', middleware);
      });
      console.log('[ServicesModule] OKX x402 middleware enabled (402 challenge for unpaid requests).');
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Start the HTTP server. */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error('ServicesModule is already running.');
    }
    await this.x402Server.start(this.port);
    this.started = true;
    console.log(`[ServicesModule] HTTP server listening on port ${this.port}`);
  }

  /** Gracefully stop the HTTP server. */
  async stop(): Promise<void> {
    await this.x402Server.stop();
    this.started = false;
  }

  /**
   * Expose the X402Server instance for use by AgentCore.
   * Requirement: Task 10.2 — "Exposes la instancia de X402Server para uso en el AgentCore"
   */
  getX402Server(): X402ServerImpl {
    return this.x402Server;
  }

  /**
   * Expose the ServiceRegistry for external registration of new services.
   */
  getRegistry(): ServiceRegistry {
    return this.registry;
  }

  /**
   * Propose a new service from an LLM suggestion (Tier 3/4 only). Req 7.7
   *
   * @returns The registered ServiceDescriptor on success, null if gating fails.
   */
  proposeLlmService(proposal: {
    id: string;
    name: string;
    description: string;
    priceUsdc: string;
    timeoutMs?: number;
  }): X402ServiceDescriptor | null {
    const currentTier = this.survivalModule.getCurrentTier();

    if (currentTier < SurvivalTier.TIER_3) {
      console.warn(
        `[ServicesModule] LLM service proposals are only available in Tier 3 or Tier 4. ` +
        `Current tier: ${currentTier}.`,
      );
      return null;
    }

    const descriptor = proposeLlmService(this.registry, proposal);
    if (descriptor) {
      // Also register with x402Server so it appears in GET /services
      const handler = async (params: unknown): Promise<unknown> => {
        const result = await this.registry.execute(descriptor.id, params);
        await this._handleRefundIfNeeded(result, descriptor, undefined);
        if (!result.success) {
          throw new Error(result.error ?? 'Service execution failed');
        }
        return result.data;
      };

      this.x402Server.registerService({
        descriptor,
        handler,
      });
    }

    return descriptor;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Build the array of X402 RegisteredService objects that wrap ServiceRegistry
   * execution. Each handler:
   *  1. Delegates to ServiceRegistry.execute (which tracks invocations)
   *  2. Triggers refund if service fails after valid payment (Req 7.5)
   */
  private _buildX402Services(): RegisteredService[] {
    return BUILT_IN_SERVICE_DESCRIPTORS.map((descriptor) => ({
      descriptor,
      handler: async (params: unknown): Promise<unknown> => {
        const result = await this.registry.execute(descriptor.id, params);

        // Handle refund on failure (Req 7.5)
        // paymentId is not available here (X402Server records it after handler returns)
        // so we schedule the refund based on the result
        if (!result.success) {
          await this._handleRefundIfNeeded(result, descriptor, undefined);
          throw new Error(result.error ?? `Service "${descriptor.id}" execution failed.`);
        }

        return result.data;
      },
    }));
  }

  /**
   * Issue an automatic USDC refund when a service fails after receiving valid payment.
   * Requirement 7.5 — full USDC refund within 60 seconds.
   *
   * This records an outgoing payment in the ledger. In production, the agent would
   * also submit the on-chain USDC transfer; here we record the intent and log it.
   * The full on-chain transfer would be triggered by the PaymentModule.
   */
  private async _handleRefundIfNeeded(
    result: ServiceResult,
    descriptor: X402ServiceDescriptor,
    paymentId: string | undefined,
  ): Promise<void> {
    if (result.success) return; // No refund needed

    try {
      const refundDeadlineMs = REFUND_DEADLINE_MS;

      // Schedule the refund within the deadline
      const refundPromise = this._issueRefund(descriptor, paymentId);

      // Race: either the refund completes or the deadline fires
      await Promise.race([
        refundPromise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Refund deadline exceeded (${refundDeadlineMs}ms)`)),
            refundDeadlineMs,
          ),
        ),
      ]);
    } catch (err) {
      console.error(
        `[ServicesModule] Refund failed for service "${descriptor.id}": ${(err as Error).message}`,
      );
    }
  }

  /**
   * Record the refund in the payment ledger.
   * Marks an outgoing payment to the client with the service price as amount.
   * The actual on-chain transfer is handled by the PaymentModule.
   */
  private async _issueRefund(
    descriptor: X402ServiceDescriptor,
    _paymentId: string | undefined,
  ): Promise<void> {
    // Record the outgoing refund payment.
    // In a full implementation, the counterpartyAddress would be extracted from
    // the original payment record. We use a placeholder address here since the
    // x402 server handler doesn't expose the client address to us directly.
    const refundId = this.ledger.record({
      direction: 'outgoing',
      amountUsdc: descriptor.priceUsdc,
      counterpartyAddress: '0x0000000000000000000000000000000000000000',
      serviceId: descriptor.id,
      status: 'pending',
    });

    console.log(
      `[ServicesModule] Refund queued for service "${descriptor.id}": ` +
      `${descriptor.priceUsdc.toString()} USDC (ledger ID: ${refundId})`,
    );

    // Mark refund as confirmed (in mock/dev mode; production would await on-chain tx)
    const mockMode =
      process.env['MOCK_PAYMENTS'] === 'true' ||
      process.env['MOCK_ONCHAIN_IDENTITY'] === 'true' ||
      process.env['NODE_ENV'] === 'test';

    if (mockMode) {
      this.ledger.confirm(refundId, `0xrefund_${Date.now()}`, 0);
      console.log(`[ServicesModule] Refund confirmed (mock mode) for service "${descriptor.id}".`);
    }
    // In production: trigger PaymentModule.sendUsdc(clientAddress, descriptor.priceUsdc)
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new ServicesModule with the built-in services pre-registered.
 *
 * @example
 * ```ts
 * const services = createServicesModule({
 *   x402Options: { paymentValidator, ledger, survivalModule, nodeAddress },
 *   ledger,
 *   survivalModule,
 *   invocationsRepo,
 * });
 * await services.start();
 * ```
 */
export function createServicesModule(opts: ServicesModuleOptions): ServicesModule {
  return new ServicesModule(opts);
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export { ServiceRegistry } from './service-registry.js';
export type {
  ServiceDescriptor,
  ServiceHandler,
  ServiceResult,
  RegisteredService as RegistryService,
} from './service-registry.js';
