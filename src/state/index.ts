/**
 * State layer barrel export.
 * Re-exports the database wrapper, all typed repositories, and the cache wrapper.
 *
 * Usage:
 *   import { getDatabase, PaymentsRepository, getCache } from '@state/index.js';
 */

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
export {
  AgentDatabase,
  DatabaseIntegrityError,
  getDatabase,
  resetDatabaseInstance,
} from './database.js';
export type { DatabaseConfig } from './database.js';

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
export { AgentCache, getCache, resetCacheInstance } from './cache.js';
export type { CacheConfig } from './cache.js';

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------
export { IdentityRepository } from './repositories/identity.repo.js';
export type {
  IdentityRecord,
  CreateIdentityInput,
  UpdateRegistrationInput,
} from './repositories/identity.repo.js';

export { PaymentsRepository } from './repositories/payments.repo.js';
export type {
  PaymentRecord,
  CreatePaymentInput,
  PaymentDirection,
  PaymentStatus,
} from './repositories/payments.repo.js';

export { TradesRepository } from './repositories/trades.repo.js';
export type {
  TradeRecord,
  CreateTradeInput,
  UpdateTradeInput,
  TradeStatus,
  TradeNetwork,
  TradeSource,
} from './repositories/trades.repo.js';

export { ObservationsRepository } from './repositories/observations.repo.js';
export type {
  ObservationRecord,
  CreateObservationInput,
} from './repositories/observations.repo.js';

export { SocialPostsRepository } from './repositories/social-posts.repo.js';
export type {
  SocialPostRecord,
  CreateSocialPostInput,
  SocialPostStatus,
} from './repositories/social-posts.repo.js';

export { SelfModRepository } from './repositories/self-mod.repo.js';
export type {
  SelfModRecord,
  CreateSelfModInput,
  SelfModStatus,
} from './repositories/self-mod.repo.js';

export { ChildAgentsRepository } from './repositories/child-agents.repo.js';
export type {
  ChildAgentRecord,
  CreateChildAgentInput,
  ChildAgentStatus,
} from './repositories/child-agents.repo.js';

export { McpInvocationsRepository } from './repositories/mcp-invocations.repo.js';
export type {
  McpInvocationRecord,
  CreateMcpInvocationInput,
} from './repositories/mcp-invocations.repo.js';

export { HeartbeatRepository } from './repositories/heartbeat.repo.js';
export type {
  HeartbeatEvent,
  CreateHeartbeatInput,
  CrashEvent,
  CreateCrashInput,
} from './repositories/heartbeat.repo.js';

export { BalanceHistoryRepository } from './repositories/balance-history.repo.js';
export type {
  BalanceHistoryRecord,
  CreateBalanceHistoryInput,
} from './repositories/balance-history.repo.js';

export { ServiceInvocationsRepository } from './repositories/service-invocations.repo.js';
export type {
  ServiceInvocationRecord,
  CreateServiceInvocationInput,
  ServiceStats,
} from './repositories/service-invocations.repo.js';
