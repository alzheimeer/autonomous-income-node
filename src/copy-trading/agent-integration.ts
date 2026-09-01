/**
 * copy-trading/agent-integration.ts
 *
 * Adaptador que permite al AgentCore inicializar el CopyTradingOrchestrator
 * sin duplicar el servidor HTTP ni las migraciones del bootstrap standalone.
 *
 * El AgentCore llama a buildCopyTradingForAgent() en el paso 5.6.
 * Las diferencias respecto al bootstrap.ts:
 *   - No levanta CopyTradingAPI (el AgentCore ya tiene Fastify)
 *   - No corre migraciones (las gestiona initPostgresSchema del sistema principal)
 *   - No conecta a PostgreSQL — el metricsRecorder funciona en modo degradado sin BD
 */

import { createLogger } from '../logger.js';
import { JsonRpcProvider, WebSocketProvider } from 'ethers';
import { loadCopyTradingConfig } from './config/CopyTradingConfig.js';
import { CopyTradingOrchestrator } from './CopyTradingOrchestrator.js';
import { SmartMoneyCurator } from './modules/SmartMoneyCurator.js';
import { WalletWatcher } from './modules/WalletWatcher.js';
import { SignalEnricher } from './modules/SignalEnricher.js';
import { createAntiBaitingModule } from './modules/AntiBaitingModule.js';
import { createCopyExecutor } from './modules/CopyExecutor.js';
import { ExitManager, createDefaultExitStrategyConfig } from './modules/ExitManager.js';
import { CopyTradingRiskManager } from './modules/CopyTradingRiskManager.js';
import { createCopyMetricsRecorder } from './modules/CopyMetricsRecorder.js';
import { DexQuoter } from '../shared/dex-quoter.js';
import type { RugAlertService } from '../rug-alert/index.js';

const log = createLogger('copy-trading-agent-integration');

/**
 * Construye y devuelve un CopyTradingOrchestrator listo para ser arrancado
 * por el AgentCore (Paso 5.6).
 *
 * No levanta HTTP API ni corre migraciones de base de datos.
 *
 * @param env - Variables de entorno (process.env)
 */
export async function buildCopyTradingForAgent(
  env: Record<string, string | undefined>,
): Promise<CopyTradingOrchestrator> {
  log.info('Building CopyTradingOrchestrator for AgentCore integration...');

  const config = loadCopyTradingConfig();

  // ── Ethers Provider ─────────────────────────────────────────────────────────
  const rpcUrl = config.wsRpcUrl ?? env['RPC_PROVIDER_URL'] ?? '';
  const provider =
    rpcUrl.startsWith('wss://') || rpcUrl.startsWith('ws://')
      ? new WebSocketProvider(rpcUrl)
      : new JsonRpcProvider(rpcUrl);
  log.info('Provider created', { type: rpcUrl.startsWith('ws') ? 'WebSocket' : 'HTTP' });

  // ── DexQuoter ───────────────────────────────────────────────────────────────
  const dexQuoter = new DexQuoter(provider);

  // ── Risk Manager ────────────────────────────────────────────────────────────
  const riskManager = new CopyTradingRiskManager({
    maxConcurrentPositions: config.maxConcurrentPositions,
    maxDailyCapitalPct: config.maxDailyCapitalPct / 100,
    dailyPnlLossThresholdPct: 15 / 100,
    maxPositionDrawdownPct: config.maxDrawdownPct / 100,
    minCapitalReservePct: config.minReservePct / 100,
    circuitBreakerDurationMs: config.circuitBreakerHours * 60 * 60 * 1000,
  });
  riskManager.setTotalCapital(config.initialCapitalUsdc);
  log.info('CopyTradingRiskManager ready');

  // ── Metrics Recorder ────────────────────────────────────────────────────────
  const metricsRecorder = createCopyMetricsRecorder();
  log.info('CopyMetricsRecorder ready');

  // ── Exit Strategy Config ────────────────────────────────────────────────────
  const exitStrategyConfig = createDefaultExitStrategyConfig();
  exitStrategyConfig.fixedExits.takeProfitPct = config.takeProfitPct;
  exitStrategyConfig.fixedExits.stopLossPct = config.stopLossPct;
  exitStrategyConfig.trailingStop.activationPct = config.trailActivationPct;
  exitStrategyConfig.trailingStop.trailingDistancePct = config.trailDistancePct;
  exitStrategyConfig.timeStopHours = config.timeStopHours;

  // ── Exit Manager ────────────────────────────────────────────────────────────
  const exitManager = new ExitManager({
    strategyConfig: exitStrategyConfig,
    dexQuoter,
    monitoringIntervalMs: 5_000,
  });
  log.info('ExitManager ready');

  // ── CopyExecutor ────────────────────────────────────────────────────────────
  const executor = createCopyExecutor({
    availableCapitalUsdc: config.initialCapitalUsdc,
    positionSizing: {
      copyRatio: config.copyRatio,
      maxPositionUsdc: config.maxPositionUsdc,
      minPositionUsdc: 10,
      maxCapitalPct: 0.05,
      tierMultipliers: { S_TIER: 1.5, A_TIER: 1.0, B_TIER: 0.5 },
    },
    execution: {
      minDelayMs: config.executionDelayMinMs,
      maxDelayMs: config.executionDelayMaxMs,
      splitThresholdUsdc: 50,
      splitCount: 3,
      splitDelayMs: 10_000,
      baseSlippagePct: 1,
      slippagePerMissingLiquidity: 0.5,
      maxSlippagePct: config.maxSlippagePct,
      maxGasGwei: config.maxGasGwei,
    },
    riskManager,
  });
  log.info('CopyExecutor ready');

  // ── AntiBaiting Module ──────────────────────────────────────────────────────
  const antiBaiting = createAntiBaitingModule(provider, {
    deployerLookbackDays: 30,
    maxMonitoredHoldersPct: 30,
    roundTripWindowMs: 60 * 60 * 1000,
    maxBaitFlags: config.maxBaitFlags,
    flagWindowMs: config.baitFlagWindowDays * 24 * 60 * 60 * 1000,
    maxVolumeFootprintPct: config.maxVolumeFootprintPct,
    executionDelayRange: {
      min: config.executionDelayMinMs,
      max: config.executionDelayMaxMs,
    },
  });
  log.info('AntiBaitingModule ready');

  // ── Signal Enricher ─────────────────────────────────────────────────────────
  const signalEnricher = new SignalEnricher(provider, dexQuoter, {
    minLiquidityUsdc: config.minLiquidityUsdc,
    maxTaxPct: config.maxTaxPct,
    maxSlippagePct: config.maxSlippagePct,
    minLiquidityWeth: config.minLiquidityWeth,
    minLpLockPct: config.minLpLockPct,
  });
  log.info('SignalEnricher ready');

  // ── Smart Money Curator ─────────────────────────────────────────────────────
  const curator = new SmartMoneyCurator();

  const seedWallets = (env['COPY_SEED_WALLETS'] ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a.startsWith('0x'));

  for (const address of seedWallets) {
    curator.addWalletWithMetrics(
      address,
      {
        winRate: 0.72,
        totalPnlUsdc: 55_000,
        tradeCount: 150,
        avgHoldingTimeSec: 7_200,
        volumeUsdc: 600_000,
        sharpeRatio: 1.4,
        maxDrawdownPct: 18,
        profitFactor: 2.1,
        profitableWeeksPct: 68,
      },
      {
        sameBlockTradePct: 0.02,
        hasDeployedTokensRecently: false,
        honeypotExposurePct: 0.01,
        receivedDeployerAirdrop: false,
        sameCounterpartyPct: 0.05,
      },
    );
  }

  log.info('SmartMoneyCurator ready', {
    wallets: curator.getWallets().length,
    seedWalletsProvided: seedWallets.length,
  });

  // ── WalletWatcher ───────────────────────────────────────────────────────────
  const walletWatcher = new WalletWatcher({
    watchedWallets: curator.getWallets().map((w) => w.address),
    ingestMethod: 'hybrid',
    wsRpcUrl: config.wsRpcUrl,
    httpRpcUrl: config.httpRpcUrl ?? config.wsRpcUrl,
    pollingIntervalMs: config.pollingIntervalMs,
    supportedRouters: {
      uniswapV3: '0x2626664c2603336E57B271c5C0b26F421741e481',
      aerodrome: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
      oneInch: '0x1111111254EEB25477B68fb85Ed929f73A960582',
    },
    minTransferValueUsdc: 100,
  });
  log.info('WalletWatcher ready');

  // ── RugAlertService (non-fatal) ─────────────────────────────────────────────
  let rugAlertService: RugAlertService | null = null;
  try {
    const { RugAlertService } = await import('../rug-alert/index.js');
    const { TelegramClient } = await import('../social/telegram-client.js');
    rugAlertService = new RugAlertService(
      provider as JsonRpcProvider,
      dexQuoter,
      null as any,
      null,
      null as any,
      riskManager as any,
      new TelegramClient(),
      env,
    );
    await rugAlertService.start();
    log.info('RugAlertService started (copy-trading mode)');
  } catch (err) {
    log.warn('RugAlertService failed to start for copy-trading (DEGRADED)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Orchestrator ────────────────────────────────────────────────────────────
  const orchestrator = new CopyTradingOrchestrator({
    config,
    curator,
    walletWatcher,
    signalEnricher,
    antiBaitingModule: antiBaiting,
    executor,
    exitManager,
    riskManager,
    metricsRecorder,
    // Sin api: el AgentCore ya tiene su propio servidor HTTP (Fastify)
    rugAlertService,
  });

  log.info('CopyTradingOrchestrator built for AgentCore (no HTTP API, no migrations)');
  return orchestrator;
}
