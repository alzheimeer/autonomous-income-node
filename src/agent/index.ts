/**
 * AgentCore — Bootstrap and coordinating entry point.
 *
 * Startup sequence (strict order per design, Task 17.1):
 *   1. EnvValidator.validateEnv()               → EXIT(1) if fails
 *   2. AgentDatabase.initialize()               → EXIT(2) if integrity check fails
 *   3. IdentityModule.initializeIdentity()      → wallet + ERC-8004
 *   4. SurvivalModule(rpcUrl, walletAddress)    → tier evaluator + balance polling
 *   5. createHeartbeatModule()                  → health monitor + HTTP server
 *   6. createServicesModule() (lazy, no start)  → x402 HTTP server wired, not started
 *   7. createTradingModule()                    → trading module wired
 *   8. new ReActLoop(...)                       → wired, not started yet
 *   9. start() → start heartbeat + survival + services + react loop
 *
 * Behaviour:
 *   - Retry failed critical module once after 5 seconds; halt EXIT(1) on retry failure.
 *   - Emit `agent:started` with timestamp + module status map after full bootstrap.
 *   - Handle SIGTERM / SIGINT for graceful shutdown.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 12.2, 12.5, 14.1, 15.5, 15.7
 */

import { validateEnv } from '../config/env-validator.js';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentDatabase, DatabaseIntegrityError } from '../state/database.js';
import { initializeIdentity } from '../identity/index.js';
import { SurvivalModule } from '../survival/index.js';
import { type SurvivalTier } from '../survival/tier-evaluator.js';
import { createHeartbeatModule } from '../heartbeat/index.js';
import { AgentEventBus } from './event-bus.js';
import { createTradingModule, type TradingModule } from '../strategies/trading/index.js';
import { TradingKillSwitch } from '../strategies/trading/kill-switch.js';
import { createServicesModule, type ServicesModule } from '../strategies/services/index.js';
import { PaymentValidatorImpl } from '../payments/payment-validator.js';
import { PaymentLedgerImpl } from '../payments/ledger.js';
import { PaymentsRepository } from '../state/repositories/payments.repo.js';
import { ReActLoop } from './react-loop.js';
import { McpClient } from '../mcp/client/mcp-client.js';
import { MCP_SCHEMAS } from '../mcp/schemas/index.js';
import { ObservationsRepository } from '../state/repositories/observations.repo.js';
import type { EnvConfig } from '../config/types.js';
import { IdentityRepository } from '../state/repositories/identity.repo.js';
import { HeartbeatRepository } from '../state/repositories/heartbeat.repo.js';
// import { ContentGenerator } from '../strategies/content/index.js';
import { SocialPostsRepository } from '../state/repositories/social-posts.repo.js';
import type { ModuleHandlers } from './action-dispatcher.js';
import { ConwayClient, createConwayClient, provisionConwayApiKey } from '../conway/index.js';
import { StrategyPerformanceRepository } from '../state/repositories/strategy-performance.repo.js';
import { KnowledgeBaseRepository } from '../state/repositories/knowledge-base.repo.js';
import { MarketplaceTasksRepository } from '../state/repositories/marketplace-tasks.repo.js';
import { AavePositionsRepository } from '../state/repositories/aave-positions.repo.js';
import { LPPositionsRepository } from '../state/repositories/lp-positions.repo.js';
import { HyperliquidOrdersRepository } from '../state/repositories/hyperliquid-orders.repo.js';
import { BazaarListingsRepository } from '../state/repositories/bazaar-listings.repo.js';
import { StrategyTracker } from '../intelligence/strategy-tracker.js';
import { AaveLendingModule } from '../strategies/lending/aave-lending.js';
import { AutoLender } from '../strategies/lending/auto-lender.js';
import { SmartAutoLender, DEFAULT_SMART_AUTO_LENDER_CONFIG } from '../strategies/lending/smart-auto-lender.js';
import type { ISmartAutoLender } from '../strategies/lending/smart-auto-lender.js';
import { OpportunityDiscovery } from '../intelligence/opportunity-discovery.js';
import { KnowledgeAcquirer } from '../intelligence/knowledge-acquirer.js';
import { MarketplaceIntegrator } from '../strategies/marketplace/marketplace-integrator.js';
import { DEFAULT_CONFIG } from '../config/income-sustainability.config.js';
import { MultiSourceScanner } from '../strategies/trading/multi-source-scanner.js';
import { OneInchSource } from '../strategies/trading/quote-sources/oneinch-source.js';
import { ParaswapSource } from '../strategies/trading/quote-sources/paraswap-source.js';
import { UniswapQuoterSource } from '../strategies/trading/quote-sources/uniswap-quoter-source.js';
import { CostOptimizer } from './cost-optimizer.js';
import { ModelRouter } from './model-router.js';
import { DailyReport, type DailyMetrics } from './daily-report.js';
import type { TokenPair, ArbitrageOpportunity } from '../strategies/trading/quote-sources/types.js';
import { AdaptiveEvolver } from '../intelligence/adaptive-evolver.js';
import { ProposalConsolidator } from '../intelligence/proposal-consolidator.js';
import { SelfModModule } from '../self-mod/index.js';
import { SelfModRepository } from '../state/repositories/self-mod.repo.js';
import { OkxHeartbeatService, createOkxHeartbeatService } from '../infrastructure/okx-heartbeat.js';
import { FeatureEngine } from '../strategies/trading/feature-engine.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModuleStatus = 'healthy' | 'unhealthy' | 'starting';

export interface AgentStatus {
  walletAddress: string;
  tier: SurvivalTier;
  usdcBalance: bigint;
  cycleCount: number;
  uptime: number;
  modules: Record<string, ModuleStatus>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RETRY_DELAY_MS = 5_000;

// ---------------------------------------------------------------------------
// AgentCore
// ---------------------------------------------------------------------------

export class AgentCore {
  private env: EnvConfig | null = null;
  private db: AgentDatabase | null = null;
  private survivalModule: SurvivalModule | null = null;
  private heartbeatModule: ReturnType<typeof createHeartbeatModule> | null = null;
  // Step 6 — ServicesModule (lazy, created but not started in init)
  private servicesModule: ServicesModule | null = null;
  // Step 7 — TradingModule
  private tradingModule: TradingModule | null = null;
  private reactLoop: ReActLoop | null = null;
  private eventBus: AgentEventBus;
  // Content generator for social posts
  // private contentGenerator: ContentGenerator | null = null;
  // LLM MCP client (shared with ReActLoop for content generation)
  private llmClient: McpClient | null = null;
  // Conway client — red de agentes para ingresos via créditos
  private conwayClient: ConwayClient | null = null;
  // Wallet manager — expone el signer para firmar transacciones reales
  private walletManager: import('../identity/wallet-manager.js').WalletManagerImpl | null = null;
  // Income Sustainability Engine — new modules
  private aaveLending: AaveLendingModule | null = null;
  private opportunityDiscovery: OpportunityDiscovery | null = null;
  private knowledgeAcquirer: KnowledgeAcquirer | null = null;
  private marketplaceIntegrator: MarketplaceIntegrator | null = null;
  private strategyTracker: StrategyTracker | null = null;
  // Revenue Optimization Engine — new modules
  private autoLender: AutoLender | null = null;
  private smartAutoLender: ISmartAutoLender | null = null;
  private multiSourceScanner: MultiSourceScanner | null = null;
  private costOptimizer: CostOptimizer | null = null;
  private modelRouter: ModelRouter | null = null;
  private dailyReport: DailyReport | null = null;
  private tradingKillSwitch: TradingKillSwitch | null = null;
  private scannerResults: ArbitrageOpportunity[] = [];
  // Adaptive Evolver — bridge between discovery and self-improvement
  private adaptiveEvolver: AdaptiveEvolver | null = null;
  private selfModModule: SelfModModule | null = null;
  // Proposal Consolidator — daily cleanup and classification (FIX-028)
  private proposalConsolidator: ProposalConsolidator | null = null;
  // OKX Marketplace heartbeat
  private okxHeartbeat: OkxHeartbeatService | null = null;
  // Feature Engine — technical indicators for trading decisions
  private featureEngine: FeatureEngine | null = null;
  // HybridSniper — non-fatal satellite for opportunity sniping
  private hybridSniper: import('../hybrid-sniper/index.js').HybridSniperModule | null = null;
  // CopyTrading — non-fatal satellite para copy-trading de smart money wallets
  private copyTrading: import('../copy-trading/CopyTradingOrchestrator.js').CopyTradingOrchestrator | null = null;

  private walletAddress = '0x0000000000000000000000000000000000000000';
  private startedAt: number | null = null;
  private stopping = false;

  private readonly moduleStatuses: Record<string, ModuleStatus> = {
    config: 'starting',
    database: 'starting',
    identity: 'starting',
    survival: 'starting',
    heartbeat: 'starting',
    services: 'starting',
    trading: 'starting',
    'react-loop': 'starting',
    'hybrid-sniper': 'starting',
    'copy-trading': 'starting',
  };

  constructor() {
    this.eventBus = new AgentEventBus();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Full bootstrap sequence.
   * Starts all modules in order; retries each once on failure.
   */
  async start(): Promise<void> {
    this.registerSignalHandlers();

    // ── Step 1: EnvValidator ─────────────────────────────────────────────────
    console.log('[AgentCore] Step 1: Validating environment...');
    try {
      this.env = await this.withRetry(
        'config',
        () => Promise.resolve(validateEnv()),
      );
    } catch (err) {
      this.setModuleStatus('config', 'unhealthy');
      console.error('[AgentCore] Environment validation failed:', (err as Error).message);
      process.exit(1);
    }
    this.setModuleStatus('config', 'healthy');

    // ── Step 2: AgentDatabase ─────────────────────────────────────────────────
    console.log('[AgentCore] Step 2: Initializing database...');
    try {
      await this.withRetry('database', () => {
        const db = new AgentDatabase({
          dbPath: this.env!.DB_PATH,
          backupDir: this.env!.BACKUP_DIR,
        });
        db.initialize();
        this.db = db;
        return Promise.resolve();
      });
    } catch (err) {
      this.setModuleStatus('database', 'unhealthy');
      if (err instanceof DatabaseIntegrityError) {
        console.error('[AgentCore] SQLite integrity check failed:', err.message);
        process.exit(2);
      }
      console.error('[AgentCore] Database initialization failed:', (err as Error).message);
      process.exit(1);
    }
    this.setModuleStatus('database', 'healthy');

    // ── Step 3: IdentityModule ────────────────────────────────────────────────
    console.log('[AgentCore] Step 3: Initializing identity...');
    try {
      await this.withRetry('identity', async () => {
        const identityRepo = this.buildIdentityRepo();
        const identity = await initializeIdentity(
          identityRepo,
          this.env!.WALLET_PASSWORD,
          this.eventBus,
        );
        this.walletAddress = identity.address;
        this.walletManager = identity.walletManager;
      });
    } catch (err) {
      this.setModuleStatus('identity', 'unhealthy');
      console.error('[AgentCore] Identity initialization failed:', (err as Error).message);
      process.exit(1);
    }
    this.setModuleStatus('identity', 'healthy');

    // ── Step 3.5: Conway provisioning (automático via SIWE) ───────────────────
    // No requiere cuenta manual. El agente firma con su wallet y obtiene API key.
    console.log('[AgentCore] Step 3.5: Provisioning Conway API key (SIWE)...');
    try {
      const existingKey = process.env['CONWAY_API_KEY'];
      if (existingKey) {
        this.conwayClient = new ConwayClient(existingKey);
        const valid = await this.conwayClient.ping();
        if (valid) {
          console.log('[AgentCore] Conway API key loaded from env — valid ✅');
        } else {
          console.warn('[AgentCore] Conway API key in env is invalid, re-provisioning...');
          this.conwayClient = null;
        }
      }

      if (!this.conwayClient) {
        // Auto-provision via SIWE con la wallet del agente
        // Necesita la private key — la cargamos del keystore
        console.log('[AgentCore] Auto-provisioning Conway API key via SIWE...');
        // Por ahora, skip si no hay key — implementación completa en rebuild
        // cuando se tenga acceso a la PrivateKeyAccount del wallet manager
        console.log('[AgentCore] Conway provisioning skipped — set CONWAY_API_KEY in .env to enable');
      }

      if (this.conwayClient) {
        const balance = await this.conwayClient.getFormattedBalance();
        console.log(`[AgentCore] Conway connected — balance: ${balance}`);
        // Registrar el agente en la red Conway
        await this.conwayClient.registerAgent({
          agentId: this.walletAddress,
          agentAddress: this.walletAddress,
          creatorAddress: process.env['OWNER_EMAIL'] ?? 'niklaussmauricio@gmail.com',
          name: 'Autonomous Income Node',
          bio: 'Autonomous AI agent generating USDC income via DeFi, services, and content on Base blockchain.',
        });
      }
    } catch (err) {
      // Conway es no-fatal — el agente puede correr sin Conway
      console.warn('[AgentCore] Conway setup failed (non-fatal):', (err as Error).message);
    }

    // ── Step 4: SurvivalModule ─────────────────────────────────────────────────
    console.log('[AgentCore] Step 4: Starting survival module...');
    try {
      await this.withRetry('survival', async () => {
        const survival = new SurvivalModule(
          this.env!.RPC_PROVIDER_URL,
          this.walletAddress,
        );

        // Wire up tier transitions to heartbeat module (deferred — set up listener first)
        this.survivalModule = survival;

        await survival.start();
      });
    } catch (err) {
      this.setModuleStatus('survival', 'unhealthy');
      console.error('[AgentCore] Survival module failed:', (err as Error).message);
      process.exit(1);
    }
    this.setModuleStatus('survival', 'healthy');

    // ── Step 5: HeartbeatModule + HTTP server ──────────────────────────────────
    console.log('[AgentCore] Step 5: Starting heartbeat module...');
    try {
      await this.withRetry('heartbeat', async () => {
        const heartbeatRepo = this.buildHeartbeatRepo();
        const hb = createHeartbeatModule(heartbeatRepo, null);

        // Wire survival module into heartbeat
        if (this.survivalModule) {
          const currentTier = this.survivalModule.getCurrentTier();
          const currentBalance = this.survivalModule.getCurrentBalance();
          hb.setTier(currentTier);
          hb.setUsdcBalance(currentBalance);

          this.survivalModule.on('tier:transition', (event) => {
            hb.setTier(event.newTier);
          });
          this.survivalModule.on('balance:updated', (balance, tier) => {
            hb.setUsdcBalance(balance);
            hb.setTier(tier);
            // Send balance breakdown to heartbeat for /health endpoint visibility
            const breakdown = this.survivalModule!.getBalanceBreakdown();
            hb.setBalanceBreakdown(breakdown.walletUsdc, breakdown.aaveUsdc);
          });
        }

        hb.start();
        const port = this.env!.API_PORT;

        // Register /trading/* API routes BEFORE starting the HTTP server
        // (Fastify requires routes registered before listen())
        try {
          const { registerTradingRoutes } = await import('../trading-validation/api-routes.js');
          const { OperatorAuthenticator } = await import('../trading-validation/operator-authenticator.js');
          const { runMigrations } = await import('../trading-validation/migrations.js');

          // Ensure trading-validation tables exist in the database
          runMigrations(this.db!.getDb() as any);

          const operatorApiKey = process.env.OPERATOR_API_KEY ?? '';
          const telegramChatId = process.env.TELEGRAM_CHAT_ID ?? '';
          const { hashValue } = await import('../trading-validation/operator-authenticator.js');
          const operatorAuth = new OperatorAuthenticator(this.db!.getDb() as any, {
            apiKeyHash: hashValue(operatorApiKey),
            telegramChatId,
            telegramSecretHash: hashValue(telegramChatId),
            rateLimitPerMinute: 60,
          });

          // Create a mutable deps object so Step 5.5 (bootstrap) can replace stubs
          // with real managers after the orchestrator starts.
          const tradingApiDeps = {
            authenticator: operatorAuth,
            safeModeController: {
              getState: () => ({ state: 'normal', reason: undefined, since: undefined }),
              canTrade: () => true,
              canClosePosition: () => true,
            } as any,
            getBankrollState: () => ({
              totalUsdc: 99_630000n,
              activeUsdc: 25_000000n,
              reserveUsdc: 74_630000n,
              unrealizedPnl: 0n,
              dailyRealizedPnl: 0n,
              dailyGasSpent: 0n,
              experimentTotalPnl: 0n,
            }),
            getTradingMode: () => 'shadow' as const,
            getPositions: () => [],
            getExperimentReport: () => ({ mode: 'shadow', totalTrades: 0, status: 'waiting_for_signals' }),
            executeEmergencyStop: (_closePositions: boolean) => {
              console.log('[AgentCore] Emergency stop triggered via API');
            },
            logAccess: (endpoint: string, ip: string, authorized: boolean) => {
              if (!authorized) console.warn(`[API] Unauthorized access: ${endpoint} from ${ip}`);
            },
          };
          // Store reference so Step 5.5 bootstrap can update with real managers
          (this as any)._tradingApiDeps = tradingApiDeps;

          registerTradingRoutes(hb.fastify, tradingApiDeps);
          console.log('[AgentCore] Trading API routes registered on /trading/*');

          // Register pipeline-metrics route — needs MetricsDatabase from bootstrap (Step 5.5).
          // We store a lazy getter here; bootstrap will populate it after orchestrator starts.
          // The route itself checks db.isDegraded so a null db just returns 503 gracefully.
          try {
            const { registerPipelineMetricsRoute } = await import('../pipeline-metrics/api-route.js');
            // Mutable holder — populated after Step 5.5 bootstrap completes
            const metricsDbHolder: { current: import('../pipeline-metrics/metrics-database.js').MetricsDatabase | null } = { current: null };
            (this as any)._metricsDbHolder = metricsDbHolder;

            // Degraded-by-default stub that delegates to the real DB once wired
            const metricsDbProxy = {
              get isDegraded() {
                return metricsDbHolder.current === null || metricsDbHolder.current.isDegraded;
              },
              queryEvents(opts: Parameters<import('../pipeline-metrics/metrics-database.js').MetricsDatabase['queryEvents']>[0]) {
                return metricsDbHolder.current?.queryEvents(opts) ?? [];
              },
              queryNearMisses(opts: Parameters<import('../pipeline-metrics/metrics-database.js').MetricsDatabase['queryNearMisses']>[0]) {
                return metricsDbHolder.current?.queryNearMisses(opts) ?? [];
              },
              // stub unused write methods — never called by the API route
              insertEvent: () => -1,
              insertRejection: () => -1,
              insertNearMiss: () => -1,
              queryRejections: () => [],
            } as unknown as import('../pipeline-metrics/metrics-database.js').MetricsDatabase;

            registerPipelineMetricsRoute(hb.fastify, {
              db: metricsDbProxy,
              authenticator: operatorAuth,
            });
            console.log('[AgentCore] Pipeline metrics route registered on /trading/pipeline-metrics');
          } catch (pmErr) {
            console.warn('[AgentCore] Failed to register pipeline-metrics route (non-fatal):', (pmErr as Error).message);
          }
        } catch (routeErr) {
          console.warn('[AgentCore] Failed to register trading routes (non-fatal):', (routeErr as Error).message);
        }

        // Register chart routes (GET /chart and GET /chart/data)
        try {
          const { registerChartRoutes } = await import('../heartbeat/chart-routes.js');
          const self = this;
          registerChartRoutes(hb.fastify, () => {
            // Lazy provider: reads from tradingBootstrap.orchestrator and featureEngine
            const bootstrap = (self as any).tradingBootstrap;
            if (!bootstrap?.orchestrator) return null;
            const orchestrator = bootstrap.orchestrator;
            // Access MarketDataManager via the orchestrator's internal reference
            const marketData = (orchestrator as any).marketData ?? (orchestrator as any)._marketData;
            if (!marketData || typeof marketData.getCandles !== 'function') return null;

            return {
              getCandles(timeframe: '15m' | '1h') {
                return marketData.getCandles(timeframe);
              },
              getFeatures() {
                if (!self.featureEngine) return null;
                return self.featureEngine.getCachedFeatures() ?? null;
              },
              getLatestPrice() {
                return marketData.getLatestPrice?.() ?? null;
              },
            };
          });
          console.log('[AgentCore] Chart routes registered on /chart and /chart/data');
        } catch (chartErr) {
          console.warn('[AgentCore] Failed to register chart routes (non-fatal):', (chartErr as Error).message);
        }

        await hb.startHttpServer(port);
        this.heartbeatModule = hb;
        // Wire wallet address so /identity endpoint works
        hb.setWalletAddress(this.walletAddress);

      });
    } catch (err) {
      this.setModuleStatus('heartbeat', 'unhealthy');
      console.error('[AgentCore] Heartbeat module failed:', (err as Error).message);
      process.exit(1);
    }
    this.setModuleStatus('heartbeat', 'healthy');

    // ── Step 5.5: TradingOrchestrator (Shadow Mode) ──────────────────────────
    // Start the trading orchestrator in shadow mode so it connects to Binance,
    // evaluates real signals, and simulates trades without broadcasting any TX.
    // Uses bootstrapTradingOrchestrator which wires all modules and returns
    // real managers for API route integration.
    console.log('[AgentCore] Step 5.5: Starting TradingOrchestrator (shadow mode)...');
    try {
      const { bootstrapTradingOrchestrator } = await import('../trading-validation/bootstrap.js');
      const bootstrapResult = await bootstrapTradingOrchestrator({
        db: this.db!.getDb(),
        rpcUrl: this.env!.RPC_PROVIDER_URL,
        walletAddress: this.walletAddress,
      });

      // Store orchestrator for graceful shutdown
      (this as any).tradingOrchestrator = bootstrapResult.orchestrator;
      (this as any).tradingBootstrap = bootstrapResult;

      // Wire real managers into the trading API route context (replaces stubs)
      // The route handlers use function callbacks, so updating the shared reference
      // makes subsequent API calls use real data from the running orchestrator.
      if ((this as any)._tradingApiDeps) {
        const deps = (this as any)._tradingApiDeps;
        deps.safeModeController = bootstrapResult.safeModeController;
        deps.getBankrollState = () => bootstrapResult.bankrollManager.getState();
        deps.getExperimentReport = () => bootstrapResult.experimentTracker.getReport() as unknown as Record<string, unknown>;
        deps.executeEmergencyStop = (closePositions: boolean) => {
          bootstrapResult.safeModeController.trigger('kill_switch' as any, closePositions ? 'emergency_stop_close' : 'emergency_stop');
          console.log('[AgentCore] Emergency stop triggered via API (real SafeMode)');
        };
      }

      // Wire real MetricsDatabase into the pipeline-metrics route holder
      if ((this as any)._metricsDbHolder && bootstrapResult.metricsDb) {
        (this as any)._metricsDbHolder.current = bootstrapResult.metricsDb;
        console.log('[AgentCore] Pipeline metrics DB wired into /trading/pipeline-metrics route');
      }

      console.log('[AgentCore] TradingOrchestrator started in SHADOW mode (bootstrap)');
    } catch (err) {
      console.warn('[AgentCore] TradingOrchestrator failed to start (non-fatal):', (err as Error).message);
    }

    // ── Step 5.5: HybridSniper (non-fatal satellite) ─────────────────────────
    console.log('[AgentCore] Step 5.5: Initializing HybridSniper (non-fatal)...');
    try {
      if (process.env['SNIPER_ENABLED'] === 'true') {
        const { initHybridSniper, setHybridSniperModule } = await import('../hybrid-sniper/index.js');
        this.hybridSniper = await initHybridSniper(process.env as Record<string, string | undefined>);
        // wireSniper was already called with null when heartbeat built its Fastify server.
        // setHybridSniperModule updates the mutable holder so the already-registered
        // routes (/webhook/alpha, /sniper/status) start using the live module.
        setHybridSniperModule(this.hybridSniper);
        this.setModuleStatus('hybrid-sniper', 'healthy');
        console.log('[AgentCore] HybridSniper initialized in Phase 0 Shadow Mode');
      } else {
        console.log('[AgentCore] HybridSniper disabled (SNIPER_ENABLED != true)');
      }
    } catch (err) {
      console.error('[AgentCore] HybridSniper failed to start (non-fatal):', (err as Error).message);
      this.setModuleStatus('hybrid-sniper', 'unhealthy');
      // El agente principal continúa con normalidad
    }

    // ── Step 5.6: CopyTrading (non-fatal satellite) ───────────────────────────
    console.log('[AgentCore] Step 5.6: Initializing CopyTrading (non-fatal)...');
    try {
      if (process.env['COPY_TRADING_ENABLED'] === 'true') {
        const { buildCopyTradingForAgent } = await import('../copy-trading/agent-integration.js');
        this.copyTrading = await buildCopyTradingForAgent(process.env as Record<string, string | undefined>);
        await this.copyTrading.start();
        this.setModuleStatus('copy-trading', 'healthy');
        console.log('[AgentCore] CopyTrading initialized and running');
      } else {
        console.log('[AgentCore] CopyTrading disabled (COPY_TRADING_ENABLED != true)');
      }
    } catch (err) {
      console.error('[AgentCore] CopyTrading failed to start (non-fatal):', (err as Error).message);
      this.setModuleStatus('copy-trading', 'unhealthy');
      // El agente principal continúa con normalidad
    }

    // ── Step 6: ServicesModule (lazy, no start — Task 17.1) ───────────────────
    // Wire up ServicesModule with all its dependencies but do NOT call .start() yet.
    // The HTTP server will be started separately (in full deployment).
    console.log('[AgentCore] Step 6: Wiring ServicesModule (lazy — not started yet)...');
    try {
      await this.withRetry('services', async () => {
        this.servicesModule = this.buildServicesModule();
      });
    } catch (err) {
      this.setModuleStatus('services', 'unhealthy');
      console.error('[AgentCore] ServicesModule wiring failed:', (err as Error).message);
      process.exit(1);
    }
    this.setModuleStatus('services', 'healthy');

    // ── Step 7: TradingModule ──────────────────────────────────────────────────
    console.log('[AgentCore] Step 7: Wiring TradingModule...');
    try {
      await this.withRetry('trading', async () => {
        // Crear MCP client para el trading server
        const tradingMcpClient = new McpClient(
          {
            serverName: 'trading',
            command: 'node',
            args: ['/app/dist/mcp/servers/trading-server.js'],
            env: {
              MOCK_ONCHAIN_IDENTITY: process.env['MOCK_ONCHAIN_IDENTITY'] ?? 'false',
              ONEINCH_API_KEY: process.env['ONEINCH_API_KEY'] ?? '',
            },
            schemas: MCP_SCHEMAS.trading,
          },
          null,
        );
        // Conectar — no fatal si falla, el scanner simplifica a mock
        const tradingConnect = await tradingMcpClient.connect();
        if (!tradingConnect.ok) {
          console.warn('[AgentCore] Trading MCP connect failed (scanner will return empty):', tradingConnect.error.message);
        } else {
          console.log('[AgentCore] Trading MCP client connected successfully.');
        }

        this.tradingModule = createTradingModule({
          gatesDistributor: this.survivalModule!.getGatesDistributor(),
          initialTier: this.survivalModule!.getCurrentTier(),
          mcpClient: tradingConnect.ok ? tradingMcpClient : undefined,
          signer: this.walletManager?.getSigner(),
          rpcUrl: this.env!.RPC_PROVIDER_URL,
          killSwitch: this.tradingKillSwitch ?? undefined,
        });
      });
    } catch (err) {
      this.setModuleStatus('trading', 'unhealthy');
      console.error('[AgentCore] TradingModule wiring failed:', (err as Error).message);
      process.exit(1);
    }
    this.setModuleStatus('trading', 'healthy');

    // ── Step 7.5: Income Sustainability Engine — new modules ───────────────────
    console.log('[AgentCore] Step 7.5: Initializing Income Sustainability Engine modules...');
    try {
      // Create SQLite repositories
      const strategyPerfRepo = new StrategyPerformanceRepository(this.db!.getDb());
      const knowledgeRepo = new KnowledgeBaseRepository(this.db!.getDb());
      const marketplaceRepo = new MarketplaceTasksRepository(this.db!.getDb());
      const aaveRepo = new AavePositionsRepository(this.db!.getDb());
      const lpRepo = new LPPositionsRepository(this.db!.getDb());
      const hyperliquidRepo = new HyperliquidOrdersRepository(this.db!.getDb());
      const bazaarRepo = new BazaarListingsRepository(this.db!.getDb());

      // StrategyTracker
      this.strategyTracker = new StrategyTracker(strategyPerfRepo, DEFAULT_CONFIG.strategyTracker);

      // ════════════════════════════════════════════════════════════════════════════
      // AAVE PERMANENTLY DISABLED
      // ════════════════════════════════════════════════════════════════════════════
      // Aave lending is PERMANENTLY DISABLED during trading validation phase.
      // All USDC must remain in the wallet for trading operations.
      // To re-enable Aave in the future, remove this block and uncomment the
      // AaveLendingModule initialization below.
      //
      // IMPORTANT: Do NOT enable Aave until trading validation is complete and
      // a separate "idle funds" strategy is implemented with proper safeguards.
      // ════════════════════════════════════════════════════════════════════════════
      
      const AAVE_PERMANENTLY_DISABLED = true; // SAFETY FLAG - requires code change to re-enable
      
      if (AAVE_PERMANENTLY_DISABLED) {
        console.log('[AgentCore] ⛔ Aave lending PERMANENTLY DISABLED (AAVE_PERMANENTLY_DISABLED=true)');
        console.log('[AgentCore] ⛔ All funds must remain in wallet for trading validation.');
        this.aaveLending = null;
        this.autoLender = null;
        this.smartAutoLender = null;
      } else {
        // Original Aave initialization code (currently disabled)
        const signer = this.walletManager?.getSigner() ?? null;
        const aaveRpcUrl = this.env!.RPC_PROVIDER_URL;
        if (signer && aaveRpcUrl) {
          const { JsonRpcProvider } = await import('ethers');
          const connectedSigner = signer.connect(new JsonRpcProvider(aaveRpcUrl));
          const aaveConfig = { ...DEFAULT_CONFIG.aaveLending, rpcUrl: aaveRpcUrl };
          this.aaveLending = new AaveLendingModule(aaveConfig, connectedSigner as import('ethers').Wallet, aaveRepo, this.strategyTracker);
          console.log('[AgentCore] Aave lending module initialized.');
          this.autoLender = null;
          this.smartAutoLender = null;
        }
      }

      // MultiSourceScanner — multi-DEX arbitrage detection
      const scannerRpcUrl = this.env!.RPC_PROVIDER_URL || 'https://mainnet.base.org';
      const quoteSources = [
        new OneInchSource(),
        new ParaswapSource(),
        new UniswapQuoterSource(scannerRpcUrl),
      ];
      this.multiSourceScanner = new MultiSourceScanner(quoteSources, DEFAULT_CONFIG.multiSourceScanner);
      console.log('[AgentCore] MultiSourceScanner initialized with 3 quote sources.');

      // CostOptimizer — LLM call caching + adaptive intervals
      this.costOptimizer = new CostOptimizer(DEFAULT_CONFIG.costOptimizer);
      console.log('[AgentCore] CostOptimizer initialized.');

      // ModelRouter — multi-model routing for cost reduction (~60%)
      this.modelRouter = new ModelRouter();
      console.log('[AgentCore] ModelRouter initialized (triage via Haiku).');

      // TradingKillSwitch — emergency stop on excessive losses
      this.tradingKillSwitch = new TradingKillSwitch();
      console.log('[AgentCore] TradingKillSwitch initialized ($5/day, $15 total limits).');

      // Marketplace Integrator — needs LLM client (deferred to Step 8 when llmClient is available)
      // Store repos for later wiring
      (this as any)._marketplaceRepo = marketplaceRepo;

      console.log('[AgentCore] Income Sustainability Engine repositories initialized.');
    } catch (err) {
      console.warn('[AgentCore] Income Sustainability modules init failed (non-fatal):', (err as Error).message);
    }

    // ── Step 7.6: OKX Heartbeat Service ───────────────────────────────────────
    const okxHeartbeatEnabled = DEFAULT_CONFIG.okxMarketplace.heartbeatEnabled;
    if (okxHeartbeatEnabled) {
      try {
        this.okxHeartbeat = createOkxHeartbeatService({
          agentId: DEFAULT_CONFIG.okxMarketplace.agentId,
          intervalMs: DEFAULT_CONFIG.okxMarketplace.heartbeatIntervalMs,
        });
        this.okxHeartbeat.start();
        console.log(
          `[AgentCore] OKX heartbeat service started (agent #${DEFAULT_CONFIG.okxMarketplace.agentId}, every ${Math.round(DEFAULT_CONFIG.okxMarketplace.heartbeatIntervalMs / 60_000)}min).`,
        );
      } catch (err) {
        console.warn('[AgentCore] OKX heartbeat start failed (non-fatal):', (err as Error).message);
      }
    } else {
      console.log('[AgentCore] OKX heartbeat disabled (OKX_HEARTBEAT_ENABLED=false).');
    }

    // ── Step 8: ReActLoop — wire and start ────────────────────────────────────
    console.log('[AgentCore] Step 8: Starting ReAct loop...');
    try {
      await this.withRetry('react-loop', async () => {
        // Build MCP LLM client (stdio to llm-server.ts)
        const llmClient = new McpClient(
          {
            serverName: 'llm',
            command: 'node',
            args: ['/app/dist/mcp/servers/llm-server.js'],
            env: {
              ANTHROPIC_API_KEY: this.env!.ANTHROPIC_API_KEY ?? '',
              OPENAI_API_KEY: this.env!.OPENAI_API_KEY ?? '',
              OPENAI_BASE_URL: process.env['OPENAI_BASE_URL'] ?? '',
              OLLAMA_BASE_URL: process.env['OLLAMA_BASE_URL'] ?? 'http://host.docker.internal:11434',
              OLLAMA_MODEL: process.env['OLLAMA_MODEL'] ?? 'qwen3.5:9b',
              OLLAMA_LOCAL_MODELS: process.env['OLLAMA_LOCAL_MODELS'] ?? 'qwen3.5:9b,qwen2.5-coder:7b',
              LLM_PROVIDER: this.env!.LLM_PROVIDER ?? 'deepseek',
              LLM_MODEL: this.env!.LLM_MODEL ?? 'deepseek-v4-flash',
              TRIAGE_MODEL: process.env['TRIAGE_MODEL'] ?? 'deepseek-v4-flash',
              SIGNAL_MODEL: process.env['SIGNAL_MODEL'] ?? 'deepseek-v4-flash',
              CODER_MODEL: process.env['CODER_MODEL'] ?? 'deepseek-v4-pro',
              LLM_BUDGET_MULTIPLIER: String(
                this.survivalModule!.getGates().llmBudgetMultiplier
              ),
            },
            schemas: MCP_SCHEMAS.llm,
          },
          null,
        );

        const connectResult = await llmClient.connect();
        if (!connectResult.ok) {
          throw new Error(`LLM MCP connect failed: ${connectResult.error.message}`);
        }

        // Save LLM client for ContentGenerator
        this.llmClient = llmClient;

        // Build ContentGenerator for social module handler
        // const socialPostsRepo = new SocialPostsRepository(this.db!.getDb());
        // this.contentGenerator = new ContentGenerator(llmClient, socialPostsRepo);

        // ── Income Sustainability Engine — LLM-dependent modules ────────────────
        // Opportunity Discovery (always active — scans DeFi + marketplaces)
        const knowledgeRepo = new KnowledgeBaseRepository(this.db!.getDb());
        this.opportunityDiscovery = new OpportunityDiscovery(
          { ...DEFAULT_CONFIG.opportunityDiscovery, bazaarUrl: DEFAULT_CONFIG.bazaar.apiUrl },
          knowledgeRepo,
          llmClient,
        );
        this.opportunityDiscovery.start();
        console.log('[AgentCore] OpportunityDiscovery started.');

        // Knowledge Acquirer (always active — discovers new protocols)
        this.knowledgeAcquirer = new KnowledgeAcquirer(DEFAULT_CONFIG.knowledgeAcquirer, knowledgeRepo, llmClient);
        this.knowledgeAcquirer.start();
        console.log('[AgentCore] KnowledgeAcquirer started.');

        // ── AdaptiveEvolver — bridge between KnowledgeAcquirer and SelfModModule ──
        // Instantiate SelfModModule for the AdaptiveEvolver (requires Tier 3+)
        const selfModRepo = new SelfModRepository(this.db!.getDb());
        this.selfModModule = new SelfModModule(
          selfModRepo,
          () => this.survivalModule!.getGates(),
          'data', // Crash sentinel must go to /app/data/ (writable), not /app/ (read-only)
        );
        await this.selfModModule.initialize();

        this.adaptiveEvolver = new AdaptiveEvolver(
          DEFAULT_CONFIG.adaptiveEvolver,
          this.knowledgeAcquirer,
          this.selfModModule,
          llmClient,
          knowledgeRepo,
        );
        this.adaptiveEvolver.start();
        console.log('[AgentCore] AdaptiveEvolver started (evaluation every 1h, dryRun: ' + DEFAULT_CONFIG.adaptiveEvolver.dryRun + ').');

        // ── ProposalConsolidator — daily cleanup and classification (FIX-028) ──
        this.proposalConsolidator = new ProposalConsolidator(knowledgeRepo, {
          intervalMs: 24 * 60 * 60 * 1_000, // 24 hours
          staleThresholdMs: 7 * 24 * 60 * 60 * 1_000, // 7 days
        });
        this.proposalConsolidator.start();
        console.log('[AgentCore] ProposalConsolidator started (consolidation every 24h).');

        // Marketplace Integrator (LLM-powered task evaluation)
        const marketplaceRepo = (this as any)._marketplaceRepo as MarketplaceTasksRepository | undefined;
        if (marketplaceRepo && this.strategyTracker) {
          this.marketplaceIntegrator = new MarketplaceIntegrator(
            marketplaceRepo,
            this.strategyTracker,
            llmClient,
            {
              capabilities: ['text-gen', 'code-gen', 'summarize'],
              walletAddress: this.walletAddress,
            },
          );
          console.log('[AgentCore] MarketplaceIntegrator initialized.');
        }

        // Start ServicesModule HTTP server now that all deps are ready
        if (this.servicesModule) {
          try {
            await this.servicesModule.start();
            console.log('[AgentCore] ServicesModule HTTP server started.');
          } catch (err) {
            console.warn('[AgentCore] ServicesModule failed to start (non-fatal):', (err as Error).message);
          }
        }

        const observationsRepo = new ObservationsRepository(this.db!.getDb());

        // ── Build module handlers ─────────────────────────────────────────────
        // These handlers connect Claude's ActionPlan decisions to real module code.
        const moduleHandlers: ModuleHandlers = {

          // trading: execute best DeFi opportunity for current tier
          trading: async (_action) => {
            if (!this.tradingModule) return { skipped: true, reason: 'TradingModule not initialized' };
            const result = await this.tradingModule.executeBestOpportunity(
              this.walletAddress,
              this.survivalModule!.getCurrentBalance(),
            );
            if (result === null) {
              return { skipped: true, reason: 'Trading disabled for current tier or no opportunity found' };
            }
            // Record income if trade was profitable (netProfitUsdc is a string in TradeRecord)
            if (result.netProfitUsdc && this.heartbeatModule) {
              const profit = BigInt(result.netProfitUsdc);
              if (profit > 0n) {
                this.heartbeatModule.recordIncome(profit);
              }
            }
            return result;
          },

          // social: generate content and post
          // Telegram es el canal principal. Discord es backup si Telegram falla.
          // Twitter free plan no permite postear (HTTP 402).
          social: async (action) => {
            return { skipped: true, reason: 'Social module has been removed (handled by OmniAI-Engine)' };
          },

          // heartbeat: return current health status
          heartbeat: async (_action) => {
            if (!this.heartbeatModule) return { skipped: true, reason: 'HeartbeatModule not initialized' };
            return this.heartbeatModule.getHealthStatus();
          },

          // services: list available x402 services or status
          services: async (_action) => {
            if (!this.servicesModule) return { skipped: true, reason: 'ServicesModule not initialized' };
            const registry = this.servicesModule.getRegistry();
            return {
              available: registry.listDescriptors().map((s) => ({
                id: s.id,
                name: s.name,
                priceUsdc: s.priceUsdc.toString(),
              })),
            };
          },

          // identity: return wallet address and chain info
          identity: async (_action) => ({
            walletAddress: this.walletAddress,
            network: 'base',
            chainId: 8453,
            tier: this.survivalModule?.getCurrentTier() ?? 0,
            balanceUsdc: this.survivalModule?.getCurrentBalance().toString() ?? '0',
          }),

          // self-mod: report current code state (actual self-modification is Tier 3/4)
          'self-mod': async (_action) => {
            const tier = this.survivalModule?.getCurrentTier() ?? 0;
            return {
              tier,
              selfModEnabled: tier >= 3,
              message: tier < 3 ? 'Self-modification requires Tier 3 or higher' : 'Self-modification available',
            };
          },

          // replication: report replication state (Tier 4+)
          replication: async (_action) => {
            const tier = this.survivalModule?.getCurrentTier() ?? 0;
            return {
              tier,
              replicationEnabled: tier >= 4,
              children: [],
              message: tier < 4 ? 'Replication requires Tier 4' : 'Replication available',
            };
          },

          // conway: interactuar con la red Conway (créditos, sandboxes, otros agentes)
          payment: async (_action) => ({
            walletAddress: this.walletAddress,
            balanceUsdc: this.survivalModule?.getCurrentBalance().toString() ?? '0',
            tier: this.survivalModule?.getCurrentTier() ?? 0,
            conwayConnected: !!this.conwayClient,
            conwayBalance: this.conwayClient
              ? await this.conwayClient.getFormattedBalance().catch(() => 'error')
              : 'not connected',
          }),

          // ── Income Sustainability Engine handlers ──────────────────────────────

          // lending: Aave V3 USDC supply/monitoring
          lending: async (action) => {
            if (!this.aaveLending) return { error: 'Aave lending not available (no signer)' };
            const walletBalance = this.survivalModule!.getCurrentBalance();
            const tool = action.tool;
            const params = action.params as Record<string, unknown>;

            // aave_supply: deposit USDC into Aave V3
            if (tool === 'aave_supply' || tool === 'supply' || tool === 'deposit') {
              const amountRaw = params['amountRaw'] ?? params['amount'];
              if (!amountRaw) return { error: 'amountRaw required for aave_supply' };
              try {
                const amount = BigInt(String(amountRaw));
                // Safety cap: never deposit more than 80% of wallet balance
                const safeMax = (walletBalance * 80n) / 100n;
                const depositAmount = amount > safeMax ? safeMax : amount;
                if (depositAmount <= 0n) return { skipped: true, reason: 'Insufficient balance for deposit' };
                const result = await this.aaveLending.supply(depositAmount);
                console.log(`[AgentCore] Aave supply executed: ${depositAmount} aUSDC. TX: ${result.txHash}`);
                return { supplied: depositAmount.toString(), txHash: result.txHash };
              } catch (err) {
                return { error: `Aave supply failed: ${err instanceof Error ? err.message : String(err)}` };
              }
            }

            // aave_withdraw: withdraw USDC from Aave V3
            if (tool === 'aave_withdraw' || tool === 'withdraw') {
              const amountRaw = params['amountRaw'] ?? params['amount'];
              if (!amountRaw) return { error: 'amountRaw required for aave_withdraw' };
              try {
                const amount = BigInt(String(amountRaw));
                const result = await this.aaveLending.withdraw(amount);
                console.log(`[AgentCore] Aave withdraw executed: ${amount}. TX: ${result.txHash}`);
                return { withdrawn: amount.toString(), txHash: result.txHash };
              } catch (err) {
                return { error: `Aave withdraw failed: ${err instanceof Error ? err.message : String(err)}` };
              }
            }

            // Default: monitor current position
            return this.aaveLending.monitor(walletBalance);
          },

          // marketplace: autonomous task discovery & execution
          marketplace: async (_action) => {
            if (!this.marketplaceIntegrator) return { skipped: true, reason: 'MarketplaceIntegrator not initialized' };
            const tasks = await this.marketplaceIntegrator.pollForTasks();
            for (const task of tasks) {
              const evaluation = await this.marketplaceIntegrator.evaluateTask(task);
              if (evaluation.accept) {
                return this.marketplaceIntegrator.executeTask(task);
              }
            }
            return { tasksFound: tasks.length, accepted: 0 };
          },

          // perps: Hyperliquid perpetuals grid trading (stub)
          perps: async (_action) => {
            return { status: 'stub — Hyperliquid EIP-712 signing pending implementation' };
          },

          // lp: Stablecoin LP provisioning (stub)
          lp: async (_action) => {
            return { status: 'stub — LP module requires sufficient idle capital' };
          },
        };

        this.reactLoop = new ReActLoop(
          {
            llmClient,
            observationsRepo,
            eventBus: this.eventBus,
            costOptimizer: this.costOptimizer ?? undefined,
            modelRouter: this.modelRouter ?? undefined,
            preCycleHook: () => this.runPreCycleHooks(),
            getAgentState: () => ({
              walletAddress: this.walletAddress,
              balanceUsdc: this.survivalModule!.getCurrentBalance(),
              tier: this.survivalModule!.getCurrentTier(),
              gates: this.survivalModule!.getGates(),
              activeStrategies: [],
              pendingTasks: [],
              recentObservations: [],
              consecutiveLlmFailures: 0,
              cycleStartedAt: new Date().toISOString(),
              totalCycles: this.reactLoop?.getTotalCycles() ?? 0,
              // ── Income Sustainability Engine context ──────────────────────────
              topOpportunities: [
                // Opportunities from OpportunityDiscovery
                ...(this.opportunityDiscovery
                  ? this.opportunityDiscovery.getTopOpportunities(5).map(o => ({
                      title: o.title, type: o.type, estimatedYieldBps: o.estimatedYieldBps,
                      riskLevel: o.riskLevel, viabilityScore: o.viabilityScore,
                    }))
                  : []),
                // Arbitrage opportunities from MultiSourceScanner
                ...this.scannerResults.map(arb => ({
                  title: `Arb: ${arb.buySource.source} → ${arb.sellSource.source}`,
                  type: 'arbitrage' as const,
                  estimatedYieldBps: Number(arb.spreadBps),
                  riskLevel: 'medium' as const,
                  viabilityScore: 80,
                  netProfitUsdc: arb.netProfitUsdc.toString(),
                })),
              ],
              strategyRankings: (() => {
                if (!this.strategyTracker) return { top: [], bottom: [] };
                const r = this.strategyTracker.getRankings();
                return {
                  top: r.top.map(s => ({ source: s.source, pnlPerDayUsdc: s.pnlPerDayUsdc.toString(), enabled: s.enabled })),
                  bottom: r.bottom.map(s => ({ source: s.source, pnlPerDayUsdc: s.pnlPerDayUsdc.toString(), enabled: s.enabled })),
                };
              })(),
              actionableKnowledge: this.knowledgeAcquirer
                ? this.knowledgeAcquirer.getActionableEntries(3).map(e => ({
                    protocolName: e.protocolName, type: e.type,
                    estimatedApyBps: e.estimatedApyBps, viabilityScore: e.viabilityScore,
                  }))
                : [],
              // ── Technical Indicators from FeatureEngine ───────────────────────
              technicalIndicators: (() => {
                if (!this.featureEngine) return null;
                // Try multi-pair format first
                const allCached = new Map<string, any>();
                for (const pair of this.featureEngine['config'].pairs ?? ['ETHUSDC']) {
                  const cached = this.featureEngine.getCachedFeatures(pair);
                  if (cached) allCached.set(pair, cached);
                }
                if (allCached.size > 1) {
                  return this.featureEngine.formatAllForContext(allCached as any);
                }
                // Fallback: single pair detailed format
                const cached = this.featureEngine.getCachedFeatures();
                return cached ? this.featureEngine.formatForContext(cached) : null;
              })(),
            }),
            moduleHandlers,
          },
          {
            intervalMs: this.env!.REACT_LOOP_INTERVAL_MS,
            maxActionsPerCycle: this.env!.REACT_LOOP_MAX_ACTIONS,
            llmTimeoutMs: this.env!.LLM_TIMEOUT_MS,
          },
        );

        await this.reactLoop.start();
        // Wire LLM availability signal to heartbeat
        this.eventBus.on('heartbeat:check', () => {
          if (this.heartbeatModule) {
            this.heartbeatModule.setLlmAvailable(true);
          }
        });
        // Wire cycle completion to metrics
        this.eventBus.on('cycle:completed', () => {
          if (this.heartbeatModule) {
            this.heartbeatModule.recordCycle();
          }
        });
      });
    } catch (err) {
      // ReActLoop failure is non-fatal — agent runs in observation-only mode
      console.warn('[AgentCore] ReAct loop failed to start:', (err as Error).message);
      console.warn('[AgentCore] Agent running in monitoring-only mode (no LLM decisions).');
    }
    this.setModuleStatus('react-loop', 'healthy');

    // ── Emit agent:started ─────────────────────────────────────────────────────
    this.startedAt = Date.now();

    const statusMap = { ...this.moduleStatuses };
    this.eventBus.emit('agent:started', this.startedAt);

    if (this.heartbeatModule) {
      Object.entries(statusMap).forEach(([mod, status]) => {
        this.heartbeatModule!.setModuleStatus(mod, {
          status: status === 'healthy' ? 'healthy' : status === 'unhealthy' ? 'unhealthy' : 'healthy',
          lastCheck: Date.now(),
          consecutiveFailures: 0,
        });
      });
    }

    console.log('[AgentCore] Agent started successfully:', {
      walletAddress: this.walletAddress,
      timestamp: new Date(this.startedAt).toISOString(),
      modules: statusMap,
    });

    // ── Step 8.5: DailyReport — Telegram daily summary ────────────────────────
    try {
      this.dailyReport = new DailyReport({ reportHours: [16, 23, 9] }); // 11am, 6pm, 4am Colombia (UTC-5 → +5h → UTC 16, 23, 9)
      this.dailyReport.setMetricsProvider(() => this.collectDailyMetrics());
      // Wire Hybrid Sniper metrics recorder if the module is active
      if (this.hybridSniper?.metricsRecorder) {
        this.dailyReport.setSniperRecorder(this.hybridSniper.metricsRecorder);
      }
      // Wire AdaptiveEvolver if active — shows auto-implementations in Telegram report
      if (this.adaptiveEvolver) {
        this.dailyReport.setAdaptiveEvolver(this.adaptiveEvolver);
      }
      this.dailyReport.start();
      console.log('[AgentCore] DailyReport started (sends at 6am, 1pm, 11pm Colombia).');
    } catch (err) {
      console.warn('[AgentCore] DailyReport failed to start (non-fatal):', (err as Error).message);
    }

    // ── Step 8.6: FeatureEngine — Technical indicators ────────────────────────
    try {
      this.featureEngine = new FeatureEngine();
      // Pre-warm cache with initial fetch
      void this.featureEngine.getFeatures().then((f) => {
        if (f) {
          console.log(`[AgentCore] FeatureEngine ready — ${f.pair} regime: ${f.regime}, RSI: ${f.rsi14.toFixed(1)}`);
        } else {
          console.warn('[AgentCore] FeatureEngine: initial fetch returned null (will retry next cycle)');
        }
      }).catch((e) => {
        console.warn('[AgentCore] FeatureEngine initial fetch failed (non-fatal):', (e as Error).message);
      });
      console.log('[AgentCore] FeatureEngine initialized (Binance candles + indicators).');
    } catch (err) {
      console.warn('[AgentCore] FeatureEngine failed to initialize (non-fatal):', (err as Error).message);
    }

    // ── Step 8.7: RPC Watchdog ────────────────────────────────────────────────
    let rpcFailures = 0;
    setInterval(async () => {
      try {
        const res = await fetch(this.env!.RPC_PROVIDER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        rpcFailures = 0; // reset on success
      } catch (err) {
        console.error('[RpcWatchdog] RPC ping failed:', (err as Error).message);
        rpcFailures++;
        if (rpcFailures >= 3) {
          console.error('[RpcWatchdog] RPC failed 3 times in a row. Restarting container to recover JsonRpcProvider...');
          process.exit(1); // Exit to let Docker auto-restart
        }
      }
    }, 60000);

    // ── Step 9: Research Agent File Watcher ──────────────────────────────────
    // Watch ./investigacion/ for strategy_proposal_*.json files from Research Agent
    this.startResearchWatcher();
  }

  /**
   * Watch ./investigacion/ for strategy proposals from the Research Agent.
   * When found: read, pass to AdaptiveEvolver, write ACK.
   */
  private startResearchWatcher(): void {
    const dir = join(process.cwd(), 'investigacion');
    const processedFiles = new Set<string>();
    const POLL_MS = 30_000;
    const MAX_PROCESSED_FILES = 1_000; // cap memory — trim oldest when exceeded

    const poll = () => {
      try {
        const files = readdirSync(dir).filter(
          (f) => f.includes('strategy_proposal_') && f.endsWith('.json') && !f.includes('_ack') && !processedFiles.has(f),
        );

        for (const file of files) {
          try {
            const filepath = join(dir, file);
            const content = readFileSync(filepath, 'utf-8');
            const proposal = JSON.parse(content);

            console.log(`[AgentCore] Research proposal received: ${proposal.payload?.title ?? file}`);
            processedFiles.add(file);
            // Trim oldest entries if Set grows too large
            if (processedFiles.size > MAX_PROCESSED_FILES) {
              const oldest = [...processedFiles].slice(0, 100);
              oldest.forEach(f => processedFiles.delete(f));
            }

            // Pass to AdaptiveEvolver — queue for autonomous implementation
            let status: 'implemented' | 'failed' = 'failed'; // default: failed unless evolver queues it
            let error: string | null = null;

            if (this.adaptiveEvolver) {
              try {
                this.adaptiveEvolver.queueResearchProposal({
                  opportunityId: proposal.payload?.opportunityId ?? `research-${Date.now()}`,
                  title: proposal.payload?.title ?? file,
                  source: String(proposal.payload?.implementation ?? '').match(/Source: ([^\n]+)/)?.[1]?.trim() ?? 'research-agent',
                  estimatedRevenue: String(proposal.payload?.implementation ?? '').match(/Revenue: ([^\n]+)/)?.[1]?.trim() ?? 'Unknown',
                  priority: (proposal.priority as 'P1' | 'P2' | 'P3') ?? 'P2',
                });
                status = 'implemented'; // queued successfully — evolver takes it from here
                console.log(`[AgentCore] Research proposal queued for autonomous implementation: ${proposal.payload?.title}`);
              } catch (err) {
                status = 'failed';
                error = (err as Error).message;
                console.warn(`[AgentCore] Failed to queue research proposal: ${error}`);
              }
            } else {
              error = 'AdaptiveEvolver not initialized — proposal ignored';
              console.warn(`[AgentCore] AdaptiveEvolver null — proposal not queued: ${proposal.payload?.title}`);
            }

            // Write ACK file
            const ackFilename = file.replace('.json', '_ack.json');
            const ack = {
              type: 'ack',
              originalId: proposal.payload?.opportunityId ?? 'unknown',
              status,
              error,
            };
            writeFileSync(join(dir, ackFilename), JSON.stringify(ack, null, 2), 'utf-8');
            console.log(`[AgentCore] Research ACK written: ${ackFilename}`);
          } catch (err) {
            console.warn(`[AgentCore] Failed to process research file ${file}:`, (err as Error).message);
            processedFiles.add(file);
          }
        }
      } catch {
        // Directory may not exist yet — non-fatal
      }
    };

    setInterval(poll, POLL_MS);
    console.log('[AgentCore] Research file watcher started (polling ./investigacion/ every 30s).');
  }

  /**
   * Pre-cycle hooks: AutoLender + MultiSourceScanner.
   * Called before each ReActLoop cycle.
   */
  private async runPreCycleHooks(): Promise<void> {
    const balance = this.survivalModule?.getCurrentBalance() ?? 0n;

    // 1. SmartAutoLender / AutoLender — automatic deposit/withdraw
    // SmartAutoLender (evaluateIdle) is the preferred pre-cycle hook.
    // Falls back to legacy AutoLender if SmartAutoLender is not yet wired.
    // IMPORTANT: Needs WALLET-ONLY balance (not total with Aave),
    // because it decides what to deposit from available wallet funds.
    // getCurrentBalance() now includes Aave — so we subtract aUSDC position.
    if (this.smartAutoLender || this.autoLender) {
      try {
        let walletOnlyBalance = balance;
        if (this.aaveLending) {
          try {
            const position = await this.aaveLending.getPosition();
            walletOnlyBalance = balance > position.currentATokenBalance
              ? balance - position.currentATokenBalance
              : 0n;
          } catch {
            // If getPosition fails, use total balance as fallback (won't deposit extra)
          }
        }

        if (this.smartAutoLender) {
          // SmartAutoLender — trading-aware, regime-sensitive evaluation
          const result = await this.smartAutoLender.evaluateIdle(walletOnlyBalance);
          if (result.action !== 'none') {
            console.log(`[AgentCore] SmartAutoLender: ${result.action} ${result.amount} — ${result.reason}`);
            this.eventBus.emit('lending:auto-action' as any, result);
          }
        } else if (this.autoLender) {
          // Legacy AutoLender fallback
          const result = await this.autoLender.evaluate(walletOnlyBalance);
          if (result.action !== 'none') {
            console.log(`[AgentCore] AutoLender: ${result.action} ${result.amount} — ${result.reason}`);
            this.eventBus.emit('lending:auto-action' as any, result);
          }
        }
      } catch (err) {
        console.warn('[AgentCore] Lending pre-cycle hook error (non-fatal):', (err as Error).message);
      }
    }

    // 2. MultiSourceScanner — arbitrage detection
    if (this.multiSourceScanner) {
      try {
        const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
        const WETH = '0x4200000000000000000000000000000000000006';

        const pairs: TokenPair[] = [
          {
            tokenIn: USDC,
            tokenOut: WETH,
            tokenInDecimals: 6,
            tokenOutDecimals: 18,
            amountIn: 10_000000n, // $10 USDC
          },
        ];

        this.scannerResults = await this.multiSourceScanner.scan(pairs, balance);

        if (this.scannerResults.length > 0) {
          console.log(
            `[AgentCore] MultiSourceScanner: ${this.scannerResults.length} arbitrage opportunities found. ` +
            `Best: $${(Number(this.scannerResults[0]!.netProfitUsdc) / 1_000000).toFixed(4)} profit`,
          );
        }
      } catch (err) {
        console.warn('[AgentCore] MultiSourceScanner error (non-fatal):', (err as Error).message);
        this.scannerResults = [];
      }
    }

    // 3. FeatureEngine — refresh technical indicators (all pairs)
    if (this.featureEngine) {
      try {
        await this.featureEngine.getAllFeatures(); // refreshes cache for all configured pairs
      } catch (err) {
        console.warn('[AgentCore] FeatureEngine refresh error (non-fatal):', (err as Error).message);
      }
    }
  }

  /**
   * Graceful shutdown: stop all modules in reverse order.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    console.log('[AgentCore] Stopping agent...');

    // Step 8: Stop ReActLoop
    if (this.reactLoop) {
      try {
        await this.reactLoop.stop();
      } catch (err) {
        console.error('[AgentCore] Error stopping ReActLoop:', err);
      }
    }

    // Stop AdaptiveEvolver
    if (this.adaptiveEvolver) {
      try {
        this.adaptiveEvolver.stop();
      } catch (err) {
        console.error('[AgentCore] Error stopping AdaptiveEvolver:', err);
      }
    }

    // Stop ProposalConsolidator (FIX-028)
    if (this.proposalConsolidator) {
      try {
        this.proposalConsolidator.stop();
      } catch (err) {
        console.error('[AgentCore] Error stopping ProposalConsolidator:', err);
      }
    }

    // Stop DailyReport
    if (this.dailyReport) {
      try {
        this.dailyReport.stop();
      } catch (err) {
        console.error('[AgentCore] Error stopping DailyReport:', err);
      }
    }

    // Stop OKX Heartbeat
    if (this.okxHeartbeat) {
      try {
        this.okxHeartbeat.stop();
      } catch (err) {
        console.error('[AgentCore] Error stopping OKX heartbeat:', err);
      }
    }

    // Step 7: Destroy TradingModule
    if (this.tradingModule) {
      try {
        this.tradingModule.destroy();
      } catch (err) {
        console.error('[AgentCore] Error destroying trading module:', err);
      }
    }

    // Step 6: Stop ServicesModule (lazy — may not have been started)
    if (this.servicesModule) {
      try {
        await this.servicesModule.stop();
      } catch {
        // stop() can fail if not started — that's fine
      }
    }

    // Step 5.5: Stop TradingOrchestrator
    if ((this as any).tradingBootstrap) {
      try {
        (this as any).tradingBootstrap.stop();
      } catch (err) {
        console.error('[AgentCore] Error stopping TradingOrchestrator:', err);
      }
    }

    // Step 5.6: Stop CopyTrading
    if (this.copyTrading) {
      try {
        await this.copyTrading.gracefulShutdown();
        console.log('[AgentCore] CopyTrading stopped');
      } catch (err) {
        console.warn('[AgentCore] CopyTrading shutdown error:', (err as Error).message);
      }
    }

    // Step 5: Stop HeartbeatModule
    if (this.heartbeatModule) {
      try {
        await this.heartbeatModule.stop();
      } catch (err) {
        console.error('[AgentCore] Error stopping heartbeat:', err);
      }
    }

    // Step 4: Stop SurvivalModule
    if (this.survivalModule) {
      try {
        await this.survivalModule.stop();
      } catch (err) {
        console.error('[AgentCore] Error stopping survival module:', err);
      }
    }

    // Step 2: Close database
    if (this.db) {
      try {
        this.db.close();
      } catch (err) {
        console.error('[AgentCore] Error closing database:', err);
      }
    }

    this.eventBus.emit('agent:stopped', 'graceful');
    console.log('[AgentCore] Agent stopped.');
  }

  /**
   * Returns the current agent status snapshot.
   */
  getStatus(): AgentStatus {
    const tier = this.survivalModule?.getCurrentTier() ?? (0 as SurvivalTier);
    const usdcBalance = this.survivalModule?.getCurrentBalance() ?? 0n;
    const metrics = this.heartbeatModule?.getMetrics();
    const cycleCount = metrics?.totalCycles ?? 0;
    const uptime = this.startedAt ? Date.now() - this.startedAt : 0;

    return {
      walletAddress: this.walletAddress,
      tier,
      usdcBalance,
      cycleCount,
      uptime,
      modules: { ...this.moduleStatuses },
    };
  }

  /** Expose the event bus for external module wiring. */
  getEventBus(): AgentEventBus {
    return this.eventBus;
  }

  /** Expose the database instance for external module wiring. */
  getDatabase(): AgentDatabase | null {
    return this.db;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Collect metrics for the daily Telegram report.
   */
  private collectDailyMetrics(): DailyMetrics {
    const totalBalance = this.survivalModule?.getCurrentBalance() ?? 0n;
    const breakdown = this.survivalModule?.getBalanceBreakdown();
    const walletBalance = breakdown?.walletUsdc ?? totalBalance;
    const aaveBalance = breakdown?.aaveUsdc ?? 0n;

    const reactLoopStats = this.reactLoop;
    const llmCycles = reactLoopStats?.getTotalCycles() ?? 0;

    const modelRouterStats = this.modelRouter?.getStats();
    const triageSkips = modelRouterStats?.skippedLlmCalls ?? 0;
    const estimatedSavings = modelRouterStats?.estimatedSavingsCents ?? 0;

    // Estimate cost: each full LLM call ~$0.03, triage ~$0.001
    const fullCalls = llmCycles - triageSkips;
    const estimatedCostCents = (fullCalls * 3) + ((modelRouterStats?.totalTriages ?? 0) * 0.1);

    const killSwitchState = this.tradingKillSwitch?.getState();

    // Determine health status
    let healthStatus: 'healthy' | 'degraded' | 'critical' = 'healthy';
    let degradationReason: string | undefined;

    if (this.tradingKillSwitch?.isTriggered().triggered) {
      healthStatus = 'degraded';
      degradationReason = this.tradingKillSwitch.isTriggered().reason;
    }
    if (reactLoopStats?.isInFallbackMode()) {
      healthStatus = 'degraded';
      degradationReason = 'LLM in fallback mode';
    }

    return {
      totalBalanceUsdc: totalBalance,
      walletBalanceUsdc: walletBalance,
      aaveBalanceUsdc: aaveBalance,
      aaveYieldToday: 0n, // Requires Aave position delta tracking — not yet wired
      tradesExecuted: (() => {
        // Read from ExperimentTracker if TradingOrchestrator is running
        const bootstrap = (this as any).tradingBootstrap;
        if (bootstrap?.experimentTracker?.getReport) {
          return (bootstrap.experimentTracker.getReport() as { totalTrades: number }).totalTrades ?? 0;
        }
        return 0;
      })(),
      signalsRejected: 0, // Requires RiskManager rejection counter — not yet wired
      llmCycles,
      cacheHits: this.costOptimizer?.getMetrics().hits ?? 0,
      triageSkips,
      estimatedCostCents: Math.round(estimatedCostCents),
      opportunitiesFound: this.scannerResults.length,
      actionableOpportunities: this.scannerResults.filter(r => r.netProfitUsdc > 0n).length,
      healthStatus,
      degradationReason,
    };
  }

  /**
   * Run `fn()`. If it throws, wait RETRY_DELAY_MS and run once more.
   * If the retry also throws, re-throw so the caller can exit.
   *
   * Requirement: 1.4 — retry once after 5 seconds; halt with exit code 1.
   */
  private async withRetry<T>(
    moduleName: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      console.warn(
        `[AgentCore] ${moduleName} failed on first attempt. Retrying in ${RETRY_DELAY_MS}ms...`,
        (err as Error).message,
      );
      await sleep(RETRY_DELAY_MS);
      // Second attempt — if this throws, propagate to caller
      return await fn();
    }
  }

  private setModuleStatus(name: string, status: ModuleStatus): void {
    this.moduleStatuses[name] = status;
  }

  /** Register SIGTERM / SIGINT signal handlers for graceful shutdown. */
  private registerSignalHandlers(): void {
    const shutdown = async (signal: string) => {
      console.log(`[AgentCore] Received ${signal}. Starting graceful shutdown...`);
      await this.stop();
      process.exit(0);
    };

    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  }

  /**
   * Build a proper IdentityRepository backed by the SQLite database.
   */
  private buildIdentityRepo(): IdentityRepository {
    if (!this.db) {
      throw new Error('Database must be initialized before building repositories');
    }
    return new IdentityRepository(this.db.getDb());
  }

  /**
   * Build a proper HeartbeatRepository backed by the SQLite database.
   */
  private buildHeartbeatRepo(): HeartbeatRepository | null {
    if (!this.db) return null;
    return new HeartbeatRepository(this.db.getDb());
  }

  /**
   * Build ServicesModule with full dependency wiring (lazy — caller decides when to start).
   * Requires: database, survival module, env config.
   *
   * Requirement: Task 17.1 — step 6 (createServicesModule, lazy, no start)
   */
  private buildServicesModule(): ServicesModule {
    if (!this.db || !this.survivalModule || !this.env) {
      throw new Error(
        'Database, SurvivalModule, and env config must be initialised before building ServicesModule',
      );
    }

    const paymentsRepo = new PaymentsRepository(this.db.getDb());
    const paymentValidator = new PaymentValidatorImpl(this.env.RPC_PROVIDER_URL);
    const ledger = new PaymentLedgerImpl(paymentsRepo);

    return createServicesModule({
      x402Options: {
        paymentValidator,
        ledger,
        survivalModule: this.survivalModule,
        nodeAddress: this.walletAddress,
      },
      ledger,
      survivalModule: this.survivalModule,
      invocationsRepo: null, // optional — no invocations repo yet in this phase
      port: (this.env!.API_PORT ?? 3000) + 1, // puerto 3001 — Heartbeat usa 3000
    });
  }

  /** Expose the ServicesModule for external wiring (e.g., starting after bootstrap). */
  getServicesModule(): ServicesModule | null {
    return this.servicesModule;
  }

  /** Expose the TradingModule for external wiring. */
  getTradingModule(): TradingModule | null {
    return this.tradingModule;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Entry point — run if executed directly
// ---------------------------------------------------------------------------

// ESM: `import.meta.url` check equivalent
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] != null &&
  (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('index.ts'));

if (isMain) {
  const agent = new AgentCore();
  agent.start().catch((err) => {
    console.error('[AgentCore] Fatal startup error:', err);
    process.exit(1);
  });
}
