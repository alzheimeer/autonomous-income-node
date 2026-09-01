/**
 * Copy Trading HTTP API Routes - Task 21.1-21.5
 * 
 * Endpoints:
 * - GET  /copy/status              - System health and circuit breaker state (Req 9.1)
 * - GET  /copy/wallets             - List monitored wallets with tiers/metrics (Req 9.2)
 * - POST /copy/wallets             - Add wallet to monitored list (Req 9.3)
 * - DELETE /copy/wallets/:address  - Remove wallet from monitored list (Req 9.4)
 * - GET  /copy/positions           - List open positions with unrealized PnL (Req 9.5)
 * - POST /copy/positions/:id/close - Manually close a position (Req 9.6)
 * - POST /copy/circuit-breaker/reset - Manually reset circuit breaker (Req 9.7)
 * - GET  /copy/metrics             - Aggregated performance metrics (Req 9.8)
 * 
 * @module copy-trading/routes/copy
 */

import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createLogger } from '../../logger.js';
import type { ISmartMoneyCurator, SmartMoneyWallet, WalletTier } from '../interfaces/types.js';
import type { ICopyExecutor } from '../interfaces/types.js';
import type { CopyTradingRiskManager } from '../modules/CopyTradingRiskManager.js';
import type { ICopyMetricsRecorder } from '../modules/CopyMetricsRecorder.js';
import type { IExitManager } from '../interfaces/types.js';
import type { IDexQuoter } from '../../shared/dex-quoter.js';

const log = createLogger('copy-trading-api');

// =============================================================================
// INTERFACES
// =============================================================================

/**
 * Dependencies required by the Copy Trading API routes
 */
export interface CopyTradingRouteDeps {
  /** Smart money wallet curator */
  curator?: ISmartMoneyCurator;
  /** Trade executor with position management */
  executor?: ICopyExecutor;
  /** Risk manager with circuit breaker */
  riskManager?: CopyTradingRiskManager;
  /** Metrics recorder for aggregated stats */
  metricsRecorder?: ICopyMetricsRecorder;
  /** Exit manager for position monitoring */
  exitManager?: IExitManager;
  /** DEX quoter for current price queries (Req 9.5) */
  dexQuoter?: IDexQuoter;
  /** API key for authentication - required for POST/DELETE endpoints (Req 9.10) */
  apiKey?: string | null;
}

/**
 * System status response (Requirement 9.1)
 * 
 * Primary fields (per task 21.1 specification):
 * - health: "ok" | "degraded" | "error"
 * - openPositionsCount: number
 * - circuitBreakerActive: boolean
 * - circuitBreakerReason: string | null
 * - timestamp: ISO timestamp
 * 
 * Additional fields for richer diagnostics:
 * - circuitBreaker: detailed circuit breaker state
 * - uptime: server uptime in seconds
 */
export interface SystemStatusResponse {
  /** System health status - "ok" | "degraded" | "error" */
  health: 'ok' | 'degraded' | 'error';
  /** Number of open positions */
  openPositionsCount: number;
  /** Whether circuit breaker is currently active */
  circuitBreakerActive: boolean;
  /** Reason for circuit breaker activation (null if not active) */
  circuitBreakerReason: string | null;
  /** Current timestamp in ISO format */
  timestamp: string;
  /** Detailed circuit breaker state for diagnostics */
  circuitBreaker: {
    active: boolean;
    blockedUntil: number | null;
    consecutiveLosses: number;
    activationReason?: string;
  };
  /** Server uptime in seconds */
  uptime: number;
}

/**
 * Wallet list response
 */
export interface WalletListResponse {
  wallets: Array<{
    address: string;
    tier: WalletTier;
    metrics: {
      winRate: number;
      totalPnlUsdc: number;
      tradeCount: number;
      sharpeRatio: number;
    };
    isActive: boolean;
    addedAt: number;
    lastEvaluatedAt: number;
  }>;
  total: number;
}

/**
 * Position with unrealized PnL (Req 9.5)
 * Returns open positions with current prices and unrealized PnL
 */
export interface PositionWithPnL {
  /** Position unique identifier */
  id: string;
  /** Token contract address */
  tokenAddress: string;
  /** Token symbol (if available) */
  tokenSymbol?: string;
  /** Entry price (token per USDC) as string for JSON serialization */
  entryPrice: string;
  /** Current price (token per USDC) as string */
  currentPrice: string;
  /** Unrealized profit/loss in USDC */
  unrealizedPnlUsdc: number;
  /** Unrealized profit/loss percentage */
  unrealizedPnlPct: number;
  /** Timestamp when position was opened */
  entryTimestamp: number;
  /** Source wallet that triggered the trade */
  sourceWallet: string;
  /** Position size in USDC */
  positionSizeUsdc: number;
  /** Pool address for the position */
  poolAddress: string;
  /** Position status */
  status: string;
}

/**
 * Positions list response (Req 9.5)
 */
export interface PositionsListResponse {
  positions: PositionWithPnL[];
  total: number;
}

/**
 * Position close request body (Req 9.6)
 */
export interface PositionCloseRequest {
  /** Optional reason for manual close */
  reason?: string;
}

/**
 * Position close response (Req 9.6)
 */
export interface PositionCloseResponse {
  message: string;
  positionId: string;
  /** Exit price as string for JSON serialization */
  exitPrice: string;
  /** Realized profit/loss in USDC */
  realizedPnlUsdc: number;
  closedAt: number;
}

/**
 * Circuit breaker reset response
 */
export interface CircuitBreakerResetResponse {
  success: boolean;
  message: string;
  previousState: {
    active: boolean;
    blockedUntil: number | null;
    consecutiveLosses: number;
  };
  resetAt: number;
}

/**
 * Aggregated metrics response (Req 9.8)
 */
export interface AggregatedMetricsResponse {
  totalPnl: number;
  winRate: number;
  totalTrades: number;
  avgPnlPerTrade: number;
  sharpeRatio: number | null;
  byTier: Record<WalletTier, {
    pnl: number;
    trades: number;
    winRate: number;
    sharpeRatio: number | null;
  }>;
  daily: Array<{
    date: string;
    pnl: number;
    trades: number;
    winRate: number;
  }>;
}

// =============================================================================
// ROUTE HANDLERS
// =============================================================================

/**
 * CopyTradingAPI - Fastify-based HTTP API for copy trading system
 */
export class CopyTradingAPI {
  private readonly port: number;
  private readonly deps: CopyTradingRouteDeps;
  private readonly startedAt: number;
  private server: FastifyInstance | null = null;

  constructor(deps: CopyTradingRouteDeps, port?: number) {
    this.port = port ?? parseInt(process.env['COPY_TRADING_API_PORT'] ?? '3003', 10);
    this.deps = deps;
    this.startedAt = Date.now();
  }

  /**
   * Validate API key for mutating endpoints (POST, DELETE) - Req 9.10
   * 
   * Reads API key from:
   * - X-API-Key header
   * - Authorization: Bearer <key> header
   * 
   * @returns true if authentication passes, false otherwise (401 sent)
   */
  private validateApiKey(request: FastifyRequest, reply: FastifyReply): boolean {
    // No API key configured (null, undefined, or empty string) - allow all requests
    if (!this.deps.apiKey || this.deps.apiKey.trim() === '') {
      return true;
    }

    const authHeader = request.headers['authorization'];
    const apiKeyHeader = request.headers['x-api-key'];

    // Check Authorization: Bearer <key> or X-API-Key header
    let providedKey: string | undefined;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      providedKey = authHeader.slice(7);
    } else if (typeof apiKeyHeader === 'string') {
      providedKey = apiKeyHeader;
    }

    if (providedKey !== this.deps.apiKey) {
      log.warn('API key authentication failed', { 
        hasAuthHeader: !!authHeader,
        hasApiKeyHeader: !!apiKeyHeader,
        path: request.url,
        method: request.method,
      });
      reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or missing API key' });
      return false;
    }

    return true;
  }

  /**
   * Validate Ethereum address format (Req 9.9)
   */
  private isValidAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  /**
   * Start the API server
   */
  async start(): Promise<void> {
    const app = Fastify({ logger: false });
    
    // ==========================================================================
    // GET /copy/status - System health (Req 9.1)
    // ==========================================================================
    app.get('/copy/status', async (): Promise<SystemStatusResponse> => {
      const openPositions = this.deps.executor?.getOpenPositions() ?? [];
      const cbState = this.deps.riskManager?.getCircuitBreakerState();

      // Determine health status per task 21.1 specification
      // "ok" = normal operation
      // "degraded" = circuit breaker active or partial functionality
      // "error" = critical components missing
      let health: 'ok' | 'degraded' | 'error' = 'ok';
      if (cbState?.active) {
        health = 'degraded';
      }
      if (!this.deps.curator && !this.deps.executor) {
        health = 'error';
      }

      // Circuit breaker reason (null if not active)
      const circuitBreakerReason = cbState?.active 
        ? (cbState.activationReason ?? 'UNKNOWN')
        : null;

      return {
        // Primary fields per task 21.1
        health,
        openPositionsCount: openPositions.length,
        circuitBreakerActive: cbState?.active ?? false,
        circuitBreakerReason,
        timestamp: new Date().toISOString(),
        // Additional diagnostic fields
        circuitBreaker: {
          active: cbState?.active ?? false,
          blockedUntil: cbState?.blockedUntil ?? null,
          consecutiveLosses: cbState?.consecutiveLosses ?? 0,
          activationReason: cbState?.activationReason,
        },
        uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      };
    });

    // ==========================================================================
    // GET /copy/wallets - List monitored wallets (Req 9.2)
    // ==========================================================================
    app.get('/copy/wallets', async (): Promise<WalletListResponse> => {
      const wallets = this.deps.curator?.getWallets() ?? [];

      return {
        wallets: wallets.map((w: SmartMoneyWallet) => ({
          address: w.address,
          tier: w.tier,
          metrics: {
            winRate: w.metrics.winRate,
            totalPnlUsdc: w.metrics.totalPnlUsdc,
            tradeCount: w.metrics.tradeCount,
            sharpeRatio: w.metrics.sharpeRatio,
          },
          isActive: w.isActive,
          addedAt: w.addedAt,
          lastEvaluatedAt: w.lastEvaluatedAt,
        })),
        total: wallets.length,
      };
    });

    // ==========================================================================
    // POST /copy/wallets - Add wallet (Req 9.3, 9.9)
    // ==========================================================================
    app.post('/copy/wallets', async (
      request: FastifyRequest<{ Body: { address: string } }>,
      reply: FastifyReply
    ) => {
      // Validate API key (Req 9.10)
      if (!this.validateApiKey(request, reply)) return;

      const { address } = request.body ?? {};

      // Validate address format (Req 9.9)
      if (!address || !this.isValidAddress(address)) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid wallet address. Must be a valid Ethereum address (0x...)',
        });
      }

      if (!this.deps.curator) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'Curator not initialized',
        });
      }

      try {
        const wallet = await this.deps.curator.addWallet(address);
        if (!wallet) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Wallet does not meet inclusion criteria or is already monitored',
          });
        }

        log.info('Wallet added via API', { address: wallet.address, tier: wallet.tier });

        return reply.code(201).send({
          message: 'Wallet added successfully',
          wallet: {
            address: wallet.address,
            tier: wallet.tier,
            isActive: wallet.isActive,
            addedAt: wallet.addedAt,
          },
        });
      } catch (error) {
        log.error('Failed to add wallet', { address, error: String(error) });
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to add wallet',
        });
      }
    });

    // ==========================================================================
    // DELETE /copy/wallets/:address - Remove wallet (Req 9.4)
    // ==========================================================================
    app.delete('/copy/wallets/:address', async (
      request: FastifyRequest<{ Params: { address: string } }>,
      reply: FastifyReply
    ) => {
      // Validate API key (Req 9.10)
      if (!this.validateApiKey(request, reply)) return;

      const { address } = request.params;

      // Validate address format (Req 9.9)
      if (!this.isValidAddress(address)) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Invalid wallet address format',
        });
      }

      if (!this.deps.curator) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'Curator not initialized',
        });
      }

      const wasMonitored = this.deps.curator.isMonitored(address);
      if (!wasMonitored) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Wallet not found in monitored list',
        });
      }

      this.deps.curator.removeWallet(address);
      log.info('Wallet removed via API', { address });

      return reply.code(200).send({
        message: 'Wallet removed successfully',
        address,
        removedAt: Date.now(),
      });
    });

    // ==========================================================================
    // GET /copy/positions - List open positions with unrealized PnL (Req 9.5)
    // ==========================================================================
    app.get('/copy/positions', async (): Promise<PositionsListResponse> => {
      const positions = this.deps.executor?.getOpenPositions() ?? [];

      // Build positions with current price and unrealized PnL
      const positionsWithPnL: PositionWithPnL[] = await Promise.all(
        positions.map(async (p) => {
          let currentPrice: bigint = p.entryPrice;
          let unrealizedPnlUsdc = 0;
          let unrealizedPnlPct = 0;

          // Get current price if DexQuoter is available
          if (this.deps.dexQuoter) {
            try {
              // Quote price: how much USDC for 1 token (1e18 units)
              currentPrice = await this.deps.dexQuoter.quote({
                tokenIn: p.tokenAddress,
                tokenOut: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
                amountIn: 10n ** 18n,
                poolAddress: p.poolAddress,
              });

              // Calculate unrealized PnL
              const entryPriceNum = Number(p.entryPrice);
              const currentPriceNum = Number(currentPrice);

              if (entryPriceNum > 0) {
                unrealizedPnlPct = ((currentPriceNum - entryPriceNum) / entryPriceNum) * 100;
                unrealizedPnlUsdc = p.positionSizeUsdc * (unrealizedPnlPct / 100);
              }
            } catch (error) {
              // Quote failed - use entry price as fallback
              log.warn('Failed to get current price for position', {
                positionId: p.id,
                tokenAddress: p.tokenAddress,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          return {
            id: p.id,
            tokenAddress: p.tokenAddress,
            tokenSymbol: undefined, // Token symbol lookup would require additional calls
            entryPrice: p.entryPrice.toString(),
            currentPrice: currentPrice.toString(),
            unrealizedPnlUsdc: Math.round(unrealizedPnlUsdc * 100) / 100,
            unrealizedPnlPct: Math.round(unrealizedPnlPct * 100) / 100,
            entryTimestamp: p.openedAt,
            sourceWallet: p.sourceWallet,
            positionSizeUsdc: p.positionSizeUsdc,
            poolAddress: p.poolAddress,
            status: p.status,
          };
        })
      );

      return {
        positions: positionsWithPnL,
        total: positions.length,
      };
    });

    // ==========================================================================
    // POST /copy/positions/:id/close - Close position manually (Req 9.6)
    // ==========================================================================
    app.post('/copy/positions/:id/close', async (
      request: FastifyRequest<{ Params: { id: string }; Body: PositionCloseRequest }>,
      reply: FastifyReply
    ): Promise<PositionCloseResponse | void> => {
      // Validate API key (Req 9.10)
      if (!this.validateApiKey(request, reply)) return;

      const { id } = request.params;
      const { reason } = request.body ?? {};

      if (!this.deps.executor) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'Executor not initialized',
        });
      }

      const position = this.deps.executor.getPosition(id);
      if (!position) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Position not found',
        });
      }

      if (position.status !== 'OPEN') {
        return reply.code(400).send({
          error: 'Bad Request',
          message: `Position is not open (status: ${position.status})`,
        });
      }

      try {
        // Get current price before closing (for exit price calculation)
        let exitPrice: bigint = position.entryPrice;
        if (this.deps.dexQuoter) {
          try {
            exitPrice = await this.deps.dexQuoter.quote({
              tokenIn: position.tokenAddress,
              tokenOut: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
              amountIn: 10n ** 18n,
              poolAddress: position.poolAddress,
            });
          } catch (quoteError) {
            log.warn('Failed to get exit price for position close', {
              positionId: id,
              error: quoteError instanceof Error ? quoteError.message : String(quoteError),
            });
            // Continue with entry price as fallback
          }
        }

        // Calculate realized PnL
        const entryPriceNum = Number(position.entryPrice);
        const exitPriceNum = Number(exitPrice);
        let realizedPnlUsdc = 0;

        if (entryPriceNum > 0) {
          const pnlPct = (exitPriceNum - entryPriceNum) / entryPriceNum;
          realizedPnlUsdc = position.positionSizeUsdc * pnlPct;
        }

        // Force close the position
        const closed = await this.deps.executor.forceClose(id);
        if (!closed) {
          return reply.code(500).send({
            error: 'Internal Server Error',
            message: 'Failed to close position',
          });
        }

        const closedAt = Date.now();

        log.info('Position closed via API', {
          positionId: id,
          exitPrice: exitPrice.toString(),
          realizedPnlUsdc: realizedPnlUsdc.toFixed(2),
          reason: reason ?? 'Manual close',
        });

        return {
          message: 'Position closed successfully',
          positionId: id,
          exitPrice: exitPrice.toString(),
          realizedPnlUsdc: Math.round(realizedPnlUsdc * 100) / 100,
          closedAt,
        };
      } catch (error) {
        log.error('Failed to close position', { positionId: id, error: String(error) });
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: 'Failed to close position',
        });
      }
    });

    // ==========================================================================
    // POST /copy/circuit-breaker/reset - Reset CB manually (Req 9.7)
    // ==========================================================================
    app.post('/copy/circuit-breaker/reset', async (
      request: FastifyRequest,
      reply: FastifyReply
    ): Promise<CircuitBreakerResetResponse | void> => {
      // Validate API key (Req 9.10)
      if (!this.validateApiKey(request, reply)) return;

      if (!this.deps.riskManager) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'Risk manager not initialized',
        });
      }

      // Capture previous state before reset
      const previousState = this.deps.riskManager.getCircuitBreakerState();

      // Return 400 if circuit breaker was not active (Task 21.4 requirement)
      if (!previousState.active) {
        log.debug('Circuit breaker reset attempted but CB was not active');
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Circuit breaker is not active',
          success: false,
          currentState: {
            active: previousState.active,
            blockedUntil: previousState.blockedUntil,
            consecutiveLosses: previousState.consecutiveLosses,
          },
        });
      }

      // Perform reset
      this.deps.riskManager.resetCircuitBreaker();

      const resetAt = Date.now();

      log.info('Circuit breaker manually reset via API', {
        previousActive: previousState.active,
        previousBlockedUntil: previousState.blockedUntil,
        previousConsecutiveLosses: previousState.consecutiveLosses,
        resetAt,
      });

      return {
        success: true,
        message: 'Circuit breaker reset successfully',
        previousState: {
          active: previousState.active,
          blockedUntil: previousState.blockedUntil,
          consecutiveLosses: previousState.consecutiveLosses,
        },
        resetAt,
      };
    });

    // ==========================================================================
    // GET /copy/metrics - Aggregated performance metrics (Req 9.8)
    // ==========================================================================
    app.get('/copy/metrics', async (
      _request: FastifyRequest,
      _reply: FastifyReply
    ): Promise<AggregatedMetricsResponse> => {
      // Initialize default response
      const response: AggregatedMetricsResponse = {
        totalPnl: 0,
        winRate: 0,
        totalTrades: 0,
        avgPnlPerTrade: 0,
        sharpeRatio: null,
        byTier: {
          S_TIER: { pnl: 0, trades: 0, winRate: 0, sharpeRatio: null },
          A_TIER: { pnl: 0, trades: 0, winRate: 0, sharpeRatio: null },
          B_TIER: { pnl: 0, trades: 0, winRate: 0, sharpeRatio: null },
        },
        daily: [],
      };

      // Try to get metrics from recorder
      if (this.deps.metricsRecorder) {
        try {
          // Get tier metrics for all time
          const tiers: WalletTier[] = ['S_TIER', 'A_TIER', 'B_TIER'];
          let totalTrades = 0;
          let totalWins = 0;
          let totalPnl = 0;
          const allPnls: number[] = [];

          for (const tier of tiers) {
            const tierMetrics = await this.deps.metricsRecorder.calculateTierMetrics(tier);
            
            if (tierMetrics) {
              response.byTier[tier] = {
                pnl: tierMetrics.totalPnl,
                trades: tierMetrics.tradesCount,
                winRate: tierMetrics.winRate,
                sharpeRatio: tierMetrics.sharpeRatio,
              };
              totalTrades += tierMetrics.tradesCount;
              totalWins += tierMetrics.winsCount;
              totalPnl += tierMetrics.totalPnl;
              
              // Collect data for overall Sharpe ratio calculation
              // Note: We can't aggregate Sharpe ratios directly, so we estimate from tier data
              if (tierMetrics.sharpeRatio !== null) {
                allPnls.push(tierMetrics.avgPnl * tierMetrics.tradesCount);
              }
            }
          }

          response.totalPnl = totalPnl;
          response.totalTrades = totalTrades;
          response.winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
          response.avgPnlPerTrade = totalTrades > 0 ? totalPnl / totalTrades : 0;

          // Estimate overall Sharpe ratio (approximate from tier data)
          // In a real implementation, we'd need to fetch all position PnLs for precise calculation
          if (allPnls.length > 0 && totalTrades > 1) {
            const avgPnl = totalPnl / totalTrades;
            // Estimate stddev from tier data - this is approximate
            const variance = allPnls.reduce((sum, p) => sum + Math.pow(p - avgPnl, 2), 0) / allPnls.length;
            const stddev = Math.sqrt(variance);
            response.sharpeRatio = stddev > 0 ? avgPnl / stddev : null;
          }

          // Get last 7 days metrics
          const now = new Date();
          const dailyMetrics: Array<{ date: string; pnl: number; trades: number; winRate: number }> = [];
          
          for (let i = 0; i < 7; i++) {
            const date = new Date(now);
            date.setDate(date.getDate() - i);
            date.setHours(0, 0, 0, 0);
            
            const dayMetrics = await this.deps.metricsRecorder.calculateDailyMetrics(date);
            
            dailyMetrics.push({
              date: date.toISOString().split('T')[0],
              pnl: dayMetrics?.totalPnlUsdc ?? 0,
              trades: dayMetrics?.totalTrades ?? 0,
              winRate: dayMetrics?.winRate ?? 0,
            });
          }

          response.daily = dailyMetrics;

        } catch (error) {
          log.error('Failed to calculate metrics', { error: String(error) });
          // Return default response on error
        }
      }

      return response;
    });

    // Start server
    await app.listen({ port: this.port, host: '0.0.0.0' });
    this.server = app;
    log.info(`CopyTradingAPI listening on http://0.0.0.0:${this.port}`);
  }

  /**
   * Stop the API server
   */
  async stop(): Promise<void> {
    if (this.server) {
      await this.server.close();
      this.server = null;
      log.info('CopyTradingAPI stopped');
    }
  }

  /**
   * Get the Fastify instance (for testing)
   */
  getServer(): FastifyInstance | null {
    return this.server;
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create and start the Copy Trading API
 */
export async function createCopyTradingAPI(
  deps: CopyTradingRouteDeps,
  port?: number
): Promise<CopyTradingAPI> {
  const api = new CopyTradingAPI(deps, port);
  await api.start();
  return api;
}

export default CopyTradingAPI;
