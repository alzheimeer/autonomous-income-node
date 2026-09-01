/**
 * X402Server — Fastify HTTP server that implements the x402 payment protocol.
 *
 * Exposes two endpoints:
 *  - GET  /services              — list available services with USDC prices
 *  - POST /service/:id           — receive payment proof, validate, execute, respond
 *
 * Payment flow (Req 4.1, 4.2):
 *  1. Client sends POST /service/:id with header X-Payment-Proof: <txHash>
 *  2. Server validates proof via PaymentValidator (on-chain USDC transfer check)
 *  3. On success: executes the requested service, records in ledger, returns result
 *  4. On missing proof: returns HTTP 402 with payment-required details
 *  5. Entire flow must complete within 5 seconds (Req 4.2)
 *
 * Outgoing payment suspension (Req 4.6):
 *  - Before any outgoing payment, the server checks SurvivalModule.getCurrentTier()
 *  - If tier < TIER_1 (i.e. EMERGENCY), the payment is rejected with a descriptive error
 *
 * Requirements: 4.1, 4.2, 4.3, 4.6
 */

import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PaymentValidator } from './payment-validator.js';
import type { PaymentLedger } from './ledger.js';
import type { SurvivalModule } from '../survival/index.js';
import { SurvivalTier } from '../survival/tier-evaluator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Total time budget for a single payment-service request, in ms (Req 4.2). */
const REQUEST_TIMEOUT_MS = 5_000;

/** Header clients must supply to prove payment. */
const PAYMENT_PROOF_HEADER = 'x-payment-proof';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface X402Request {
  serviceId: string;
  /** USDC amount in 6-decimal units (e.g. 500_000n = $0.50). */
  amount: bigint;
  /** Transaction hash of the USDC transfer (EIP-55 or lowercase). */
  paymentProof: string;
  clientAddress: string;
}

export interface X402Response {
  accepted: boolean;
  txHash?: string;
  resource?: unknown;
  error?: string;
}

/** Descriptor of a service the node offers. */
export interface ServiceDescriptor {
  id: string;
  name: string;
  description: string;
  /** Price in 6-decimal USDC units. */
  priceUsdc: bigint;
  timeoutMs: number;
}

/** Function that performs the actual work for a service. */
export type ServiceHandler = (params: unknown) => Promise<unknown>;

/** A registered service pairing descriptor + handler. */
export interface RegisteredService {
  descriptor: ServiceDescriptor;
  handler: ServiceHandler;
}

export interface X402ServerOptions {
  paymentValidator: PaymentValidator;
  ledger: PaymentLedger;
  survivalModule: SurvivalModule;
  /** Address of this node's wallet — used as the expected USDC recipient. */
  nodeAddress: string;
  /** Pre-registered services. More can be added via `registerService`. */
  services?: RegisteredService[];
}

// ---------------------------------------------------------------------------
// X402Server interface
// ---------------------------------------------------------------------------

export interface X402Server {
  /** Start the Fastify server on the given port. */
  start(port: number): Promise<void>;
  /** Gracefully stop the server. */
  stop(): Promise<void>;
  /** Register a new service at runtime. */
  registerService(service: RegisteredService): void;
  /**
   * Core payment-request handler — can be called directly (e.g. from tests)
   * without going through HTTP.
   */
  handlePaymentRequest(req: X402Request): Promise<X402Response>;
  /**
   * Guard for outgoing payments: checks current tier and rejects if below
   * TIER_1 (Req 4.6).
   *
   * @returns `null` when the payment is allowed; a descriptive error string otherwise.
   */
  checkOutgoingPaymentAllowed(): string | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class X402ServerImpl implements X402Server {
  private readonly app: FastifyInstance;
  private readonly services = new Map<string, RegisteredService>();
  private started = false;

  constructor(private readonly opts: X402ServerOptions) {
    // Build Fastify instance with a request timeout matching Req 4.2.
    this.app = Fastify({
      logger: false, // callers inject their own logger
      connectionTimeout: REQUEST_TIMEOUT_MS,
    });

    // Allow empty body with Content-Type: application/json (OKX testing sends this).
    // Without this, Fastify rejects with 400 before the route handler / x402 middleware runs.
    this.app.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_req, body, done) => {
        const text = typeof body === 'string' ? body : body.toString();
        if (!text || text.trim() === '') {
          done(null, {});
          return;
        }
        try {
          done(null, JSON.parse(text));
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );

    // Register initial services if provided.
    for (const svc of opts.services ?? []) {
      this.services.set(svc.descriptor.id, svc);
    }

    this._registerRoutes();
  }

  // ── X402Server interface ──────────────────────────────────────────────────

  async start(port: number): Promise<void> {
    if (this.started) {
      throw new Error('X402Server is already running.');
    }
    await this.app.listen({ port, host: '0.0.0.0' });
    this.started = true;
  }

  async stop(): Promise<void> {
    await this.app.close();
    this.started = false;
  }

  registerService(service: RegisteredService): void {
    this.services.set(service.descriptor.id, service);
  }

  /**
   * Add a Fastify preHandler hook to the internal server instance.
   * Useful for adding middleware like x402 payment gating.
   */
  addHook(hook: 'preHandler', handler: import('fastify').preHandlerHookHandler): void {
    this.app.addHook(hook, handler);
  }

  // ── Core handler (public for direct test access) ──────────────────────────

  async handlePaymentRequest(req: X402Request): Promise<X402Response> {
    const svc = this.services.get(req.serviceId);

    if (!svc) {
      return {
        accepted: false,
        error: `Service "${req.serviceId}" not found.`,
      };
    }

    // --- Step 1: validate proof (includes on-chain verification) ---
    const validation = await this.opts.paymentValidator.validateProof(
      req.paymentProof,
      svc.descriptor.priceUsdc,
    );

    if (!validation.valid) {
      return {
        accepted: false,
        error: validation.reason ?? 'Payment proof validation failed.',
      };
    }

    // --- Step 2: record incoming payment as pending ---
    const paymentId = this.opts.ledger.record({
      direction: 'incoming',
      amountUsdc: validation.amount ?? svc.descriptor.priceUsdc,
      counterpartyAddress: req.clientAddress,
      txHash: validation.txHash ?? req.paymentProof,
      blockNumber: validation.blockNumber,
      serviceId: req.serviceId,
      status: 'pending',
    });

    // --- Step 3: execute the service ---
    let resource: unknown;
    try {
      resource = await this._executeWithTimeout(
        svc.handler(req),
        svc.descriptor.timeoutMs,
        `Service "${req.serviceId}" execution timed out`,
      );
    } catch (err) {
      // Mark payment as failed on service error (Req 4.4 analogue for incoming).
      this.opts.ledger.fail(paymentId);
      return {
        accepted: false,
        error: `Service execution failed: ${(err as Error).message}`,
      };
    }

    // --- Step 4: confirm the ledger entry ---
    if (validation.txHash) {
      this.opts.ledger.confirm(
        paymentId,
        validation.txHash,
        validation.blockNumber ?? 0,
      );
    }

    return {
      accepted: true,
      txHash: validation.txHash,
      resource,
    };
  }

  // ── Outgoing payment guard (Req 4.6) ─────────────────────────────────────

  checkOutgoingPaymentAllowed(): string | null {
    const tier = this.opts.survivalModule.getCurrentTier();

    if (tier < SurvivalTier.TIER_1) {
      return (
        `Outgoing payments suspended: wallet balance is in EMERGENCY tier ` +
        `(balance has reached $0.00 USDC). All non-essential spending is ` +
        `halted until the balance is restored above the Tier 1 threshold ($0.000001 USDC).`
      );
    }

    return null; // payment is allowed
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Register Fastify routes:
   *  - GET  /services
   *  - POST /service/:id
   */
  private _registerRoutes(): void {
    // GET /services — list all registered services with prices (Req 7.1).
    this.app.get('/services', async (_req: FastifyRequest, reply: FastifyReply) => {
      const list = Array.from(this.services.values()).map((s) => ({
        id: s.descriptor.id,
        name: s.descriptor.name,
        description: s.descriptor.description,
        // Serialise bigint as string for JSON (JSON doesn't support bigint).
        priceUsdc: s.descriptor.priceUsdc.toString(),
        priceDisplay: this._formatUsdc(s.descriptor.priceUsdc),
        timeoutMs: s.descriptor.timeoutMs,
      }));

      return reply.status(200).send({ services: list });
    });

    // POST /service/:id — accept x402 payment + execute service.
    this.app.post(
      '/service/:id',
      async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const serviceId = req.params.id;
        const proofHeader = req.headers[PAYMENT_PROOF_HEADER];

        // --- 402 when no proof header is present ---
        if (!proofHeader || typeof proofHeader !== 'string' || proofHeader.trim() === '') {
          const svc = this.services.get(serviceId);
          const price = svc ? svc.descriptor.priceUsdc : null;

          return reply.status(402).send({
            error: 'payment-required',
            message:
              `Payment required. Include a valid USDC transaction hash ` +
              `in the "${PAYMENT_PROOF_HEADER}" header.`,
            ...(price !== null && {
              priceUsdc: price.toString(),
              priceDisplay: this._formatUsdc(price),
            }),
            header: PAYMENT_PROOF_HEADER,
          });
        }

        // --- Parse optional body for clientAddress / params ---
        const body = (req.body ?? {}) as Record<string, unknown>;
        const clientAddress =
          typeof body['clientAddress'] === 'string'
            ? body['clientAddress']
            : '0x0000000000000000000000000000000000000000';

        // --- Run the payment handler with an overall 5-second deadline ---
        let response: X402Response;
        try {
          response = await this._executeWithTimeout(
            this.handlePaymentRequest({
              serviceId,
              amount: 0n, // amount is resolved from service descriptor inside handler
              paymentProof: proofHeader.trim(),
              clientAddress,
            }),
            REQUEST_TIMEOUT_MS,
            'Payment processing timed out (5s limit)',
          );
        } catch (err) {
          return reply.status(504).send({
            error: 'timeout',
            message: (err as Error).message,
          });
        }

        if (!response.accepted) {
          return reply.status(402).send({
            error: 'payment-rejected',
            message: response.error ?? 'Payment was not accepted.',
          });
        }

        return reply.status(200).send({
          accepted: true,
          txHash: response.txHash,
          resource: response.resource,
        });
      },
    );
  }

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

  /** Format a 6-decimal USDC bigint as a human-readable dollar string, e.g. "$0.50". */
  private _formatUsdc(amount: bigint): string {
    const whole = amount / 1_000_000n;
    const frac = amount % 1_000_000n;
    const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '') || '00';
    return `$${whole}.${fracStr.slice(0, 2)}`;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new X402Server instance.
 *
 * @example
 * ```ts
 * const server = createX402Server({
 *   paymentValidator,
 *   ledger,
 *   survivalModule,
 *   nodeAddress: wallet.address,
 *   services: [myTextGenService],
 * });
 * await server.start(3000);
 * ```
 */
export function createX402Server(opts: X402ServerOptions): X402ServerImpl {
  return new X402ServerImpl(opts);
}
