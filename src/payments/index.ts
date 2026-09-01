/**
 * Payments module barrel export.
 *
 * Re-exports:
 *  - PaymentValidatorImpl and its types  → x402 proof validation + USDC on-chain verify
 *  - PaymentLedgerImpl and its types     → SQLite-backed payment ledger
 *  - X402ServerImpl and its types        → Fastify x402 HTTP server (Req 4.1, 4.2, 4.3, 4.6)
 *
 * Usage:
 *   import { PaymentValidatorImpl, PaymentLedgerImpl, createX402Server } from './payments/index.js';
 */

export { PaymentValidatorImpl, USDC_ADDRESS_BASE } from './payment-validator.js';
export type { PaymentValidator, ValidationResult } from './payment-validator.js';

export { PaymentLedgerImpl } from './ledger.js';
export type {
  PaymentLedger,
  PaymentRecord,
  CreatePaymentOptions,
  PaymentTotals,
} from './ledger.js';

export { X402ServerImpl, createX402Server } from './x402-server.js';
export type {
  X402Server,
  X402Request,
  X402Response,
  ServiceDescriptor,
  ServiceHandler,
  RegisteredService,
  X402ServerOptions,
} from './x402-server.js';
