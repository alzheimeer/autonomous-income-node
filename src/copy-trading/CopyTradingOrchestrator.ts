/**
 * CopyTradingOrchestrator - Task 23.2: Connect complete signal flow
 * WalletWatcher → SignalEnricher → AntiBaitingModule → CopyExecutor
 * CopyExecutor → ExitManager (position registration)
 * ExitManager → CopyMetricsRecorder (exit recording)
 */
import { createLogger } from '../logger.js';
import type { CopyTradingConfig } from './config/CopyTradingConfig.js';
import type { WalletWatcher } from './modules/WalletWatcher.js';
import type { ExitManager, ExitEvent } from './modules/ExitManager.js';
import type { CopyExecutor } from './modules/CopyExecutor.js';
import type { CopyTradingRiskManager } from './modules/CopyTradingRiskManager.js';
import type { CopyMetricsRecorder } from './modules/CopyMetricsRecorder.js';
import type { CopyTradingAPI } from './routes/copy.js';
import type { CopySignal, EnrichedSignal, ISmartMoneyCurator, WalletTier } from './interfaces/types.js';
import type { SignalEnricher } from './modules/SignalEnricher.js';
import type { AntiBaitingModule } from './modules/AntiBaitingModule.js';
import type { RugAlertService } from '../rug-alert/index.js';
import type { ShadowPosition } from '../shared/metrics-recorder.js';

const log = createLogger('copy-trading-orchestrator');
const SHUTDOWN_PHASE_DELAY_MS = 500;

export interface CopyTradingOrchestratorDeps {
  config: CopyTradingConfig;
  curator?: ISmartMoneyCurator;
  walletWatcher?: WalletWatcher;
  signalEnricher?: SignalEnricher;
  antiBaitingModule?: AntiBaitingModule;
  executor?: CopyExecutor;
  exitManager?: ExitManager;
  riskManager?: CopyTradingRiskManager;
  metricsRecorder?: CopyMetricsRecorder;
  api?: CopyTradingAPI;
  rugAlertService?: RugAlertService | null;
}

export type OrchestratorStatus = 'STOPPED' | 'STARTING' | 'RUNNING' | 'SHUTTING_DOWN';

export interface ShutdownResult {
  success: boolean;
  shutdownDurationMs: number;
  positionsPersisted: number;
  metricsFlushSuccess: boolean;
  errors: string[];
}

export interface SignalProcessingStats {
  signalsReceived: number;
  signalsEnriched: number;
  signalsApprovedByEnricher: number;
  signalsRejectedByEnricher: number;
  signalsApprovedByAntiBaiting: number;
  signalsRejectedByAntiBaiting: number;
  tradesExecuted: number;
  tradesRejected: number;
  positionsOpened: number;
  positionsClosed: number;
  exitsRecorded: number;
}

export class CopyTradingOrchestrator {
  private readonly config: CopyTradingConfig;
  private readonly curator?: ISmartMoneyCurator;
  private readonly walletWatcher?: WalletWatcher;
  private readonly signalEnricher?: SignalEnricher;
  private readonly antiBaitingModule?: AntiBaitingModule;
  private readonly executor?: CopyExecutor;
  private readonly exitManager?: ExitManager;
  private readonly riskManager?: CopyTradingRiskManager;
  private readonly metricsRecorder?: CopyMetricsRecorder;
  private readonly api?: CopyTradingAPI;
  private readonly rugAlertService?: RugAlertService | null;
  private status: OrchestratorStatus = 'STOPPED';
  private readonly stats: SignalProcessingStats = {
    signalsReceived: 0, signalsEnriched: 0, signalsApprovedByEnricher: 0,
    signalsRejectedByEnricher: 0, signalsApprovedByAntiBaiting: 0,
    signalsRejectedByAntiBaiting: 0, tradesExecuted: 0, tradesRejected: 0,
    positionsOpened: 0, positionsClosed: 0, exitsRecorded: 0,
  };

  constructor(deps: CopyTradingOrchestratorDeps) {
    this.config = deps.config;
    this.curator = deps.curator;
    this.walletWatcher = deps.walletWatcher;
    this.signalEnricher = deps.signalEnricher;
    this.antiBaitingModule = deps.antiBaitingModule;
    this.executor = deps.executor;
    this.exitManager = deps.exitManager;
    this.riskManager = deps.riskManager;
    this.metricsRecorder = deps.metricsRecorder;
    this.api = deps.api;
    this.rugAlertService = deps.rugAlertService;
    log.info('CopyTradingOrchestrator created');
  }

  async start(): Promise<void> {
    if (this.status !== 'STOPPED') {
      log.warn('Orchestrator already running or starting', { status: this.status });
      return;
    }
    this.status = 'STARTING';
    log.info('Starting CopyTradingOrchestrator...');
    try {
      await this.restorePositions();
      if (this.exitManager) { await this.exitManager.start(); log.info('ExitManager started'); }
      this.wireSignalFlow();
      this.wirePositionFlow();
      if (this.walletWatcher) { await this.walletWatcher.start(); log.info('WalletWatcher started'); }
      this.status = 'RUNNING';
      log.info('CopyTradingOrchestrator started successfully');
    } catch (err) {
      this.status = 'STOPPED';
      log.error('Failed to start orchestrator', { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  private wireSignalFlow(): void {
    if (!this.walletWatcher) { log.warn('WalletWatcher not available'); return; }
    if (this.curator && this.walletWatcher.setWalletTierLookup) {
      const curatorRef = this.curator;
      this.walletWatcher.setWalletTierLookup((wallet: string): WalletTier => {
        const wallets = curatorRef.getWallets();
        const found = wallets.find(w => w.address.toLowerCase() === wallet.toLowerCase());
        return found?.tier ?? 'B_TIER';
      });
    }
    this.walletWatcher.onSignal(async (signal: CopySignal) => {
      try { await this.processSignal(signal); }
      catch (err) { log.error('Error processing signal', { signalId: signal.id, error: err instanceof Error ? err.message : String(err) }); }
    });
    log.info('Signal flow wired: WalletWatcher → processSignal pipeline');
  }

  private wirePositionFlow(): void {
    if (!this.exitManager) { log.warn('ExitManager not available'); return; }
    this.exitManager.on('exit', (evt: ExitEvent) => {
      this.handlePositionExit(evt).catch((err: unknown) => {
        log.error('Error handling exit', { positionId: evt.positionId, error: err instanceof Error ? err.message : String(err) });
      });
    });
    log.info('Position flow wired: ExitManager → MetricsRecorder');
  }

  async processSignal(signal: CopySignal): Promise<void> {
    this.stats.signalsReceived++;
    log.info('Processing signal', { signalId: signal.id, wallet: signal.sourceWallet.slice(0, 10) });
    if (this.metricsRecorder) this.metricsRecorder.bufferSignal(signal);
    if (!this.signalEnricher) { log.warn('No SignalEnricher'); return; }
    const enriched: EnrichedSignal = await this.signalEnricher.enrich(signal);
    this.stats.signalsEnriched++;
    if (!enriched.approved) {
      this.stats.signalsRejectedByEnricher++;
      log.info('Signal rejected by enricher', { signalId: signal.id, reason: enriched.rejectReason });
      if (this.metricsRecorder) await this.metricsRecorder.recordSignal(enriched, { enrichmentResult: 'REJECTED', enrichmentRejectReason: enriched.rejectReason });
      return;
    }
    this.stats.signalsApprovedByEnricher++;
    if (this.antiBaitingModule) {
      const baitRes = await this.antiBaitingModule.check(enriched);
      if (!baitRes.approved) {
        this.stats.signalsRejectedByAntiBaiting++;
        const flagsStr = Object.entries(baitRes.flags).filter(([,v]) => v).map(([k]) => k).join(',') || 'BAITING';
        log.info('Signal rejected by anti-baiting', { signalId: signal.id, flags: flagsStr });
        if (this.metricsRecorder) await this.metricsRecorder.recordSignal(enriched, { enrichmentResult: 'APPROVED', baitingResult: 'REJECTED', baitingRejectReason: flagsStr });
        return;
      }
      this.stats.signalsApprovedByAntiBaiting++;
      if (baitRes.suggestedDelay && baitRes.suggestedDelay > 0) await this.sleep(baitRes.suggestedDelay);
    }
    if (!this.executor) { log.warn('No CopyExecutor'); return; }
    const execRes = await this.executor.execute(enriched);
    if (!execRes.success) {
      this.stats.tradesRejected++;
      log.info('Trade execution failed', { signalId: signal.id, reason: execRes.reason });
      if (this.metricsRecorder) await this.metricsRecorder.recordSignal(enriched, { enrichmentResult: 'APPROVED', baitingResult: 'APPROVED', executionResult: 'REJECTED', executionRejectReason: execRes.reason });
      return;
    }
    this.stats.tradesExecuted++;
    this.stats.positionsOpened++;
    log.info('Trade executed', { signalId: signal.id, positionId: execRes.positionId });
    if (this.exitManager && this.executor) {
      const pos = this.executor.getOpenPositions().find(p => p.id === execRes.positionId);
      if (pos) {
        this.exitManager.registerPosition(pos);
        if (this.metricsRecorder) await this.metricsRecorder.recordPositionOpen(pos);
        if (this.rugAlertService) {
          // Construir objeto compatible con ShadowPosition para el RugAlertService
          const shadowLike: ShadowPosition = {
            id: pos.id,
            contractAddress: pos.tokenAddress,
            status: 'OPEN' as const,
            entryPrice: pos.entryPrice,
            tradeSize: BigInt(Math.round((pos.positionSizeUsdc ?? 0) * 1_000_000)),
            signalId: pos.signalId ?? '',
            takeProfit: pos.takeProfit,
            stopLoss: pos.stopLoss,
            timeStop: pos.timeStop,
            openedAt: pos.openedAt,
            closedAt: null,
            exitPrice: null,
            pnlUsdc: null,
          };
          this.rugAlertService.trackPosition(
            shadowLike,
            pos.poolAddress,
            pos.poolAddress, // LP token = pool address en Uniswap V2 / Aerodrome
          );
        }
      }
    }
    if (this.metricsRecorder) await this.metricsRecorder.recordSignal(enriched, { enrichmentResult: 'APPROVED', baitingResult: 'APPROVED', executionResult: 'EXECUTED', positionId: execRes.positionId });
  }

  private async handlePositionExit(evt: ExitEvent): Promise<void> {
    this.stats.positionsClosed++;
    this.stats.exitsRecorded++;
    log.info('Position exited', { positionId: evt.positionId, reason: evt.reason, pnlUsdc: evt.pnlUsdc.toFixed(2) });
    if (this.rugAlertService) {
      this.rugAlertService.untrackPosition(evt.positionId);
    }
    if (this.metricsRecorder) await this.metricsRecorder.recordPositionClose(evt.position);
  }

  private async restorePositions(): Promise<void> {
    if (!this.metricsRecorder || !this.exitManager) { log.warn('Cannot restore positions'); return; }
    try {
      const res = await this.metricsRecorder.restorePositions(this.exitManager);
      log.info('Positions restored', { totalLoaded: res.totalLoaded, restored: res.restored, expiredTimeStop: res.expiredTimeStop, errors: res.errors });
    } catch (err) { log.error('Failed to restore positions', { error: err instanceof Error ? err.message : String(err) }); }
  }

  async gracefulShutdown(): Promise<ShutdownResult> {
    if (this.status === 'STOPPED' || this.status === 'SHUTTING_DOWN') return { success: true, shutdownDurationMs: 0, positionsPersisted: 0, metricsFlushSuccess: true, errors: [] };
    const startTime = Date.now();
    this.status = 'SHUTTING_DOWN';
    log.info('Starting graceful shutdown...');
    const errors: string[] = [];
    let positionsPersisted = 0, metricsFlushSuccess = false;
    try {
      if (this.walletWatcher) { try { this.walletWatcher.stop(); await this.sleep(SHUTDOWN_PHASE_DELAY_MS); } catch (e) { errors.push(`WalletWatcher: ${e instanceof Error ? e.message : String(e)}`); } }
      if (this.metricsRecorder) { try { await this.metricsRecorder.flushSignalBatch(); metricsFlushSuccess = true; } catch (e) { errors.push(`Metrics: ${e instanceof Error ? e.message : String(e)}`); } }
      if (this.exitManager) { try { positionsPersisted = this.exitManager.getMonitoredPositions().length; this.exitManager.stop(); await this.sleep(SHUTDOWN_PHASE_DELAY_MS); } catch (e) { errors.push(`ExitManager: ${e instanceof Error ? e.message : String(e)}`); } }
      if (this.metricsRecorder) { try { await this.metricsRecorder.close(); } catch (e) { errors.push(`MetricsClose: ${e instanceof Error ? e.message : String(e)}`); } }
      if (this.rugAlertService) {
        try { await this.rugAlertService.stop(); } catch (e) { errors.push(`RugAlertService: ${e instanceof Error ? e.message : String(e)}`); }
      }
      this.status = 'STOPPED';
      log.info('Graceful shutdown complete', { shutdownDurationMs: Date.now() - startTime, positionsPersisted, metricsFlushSuccess, errorsCount: errors.length });
      return { success: errors.length === 0, shutdownDurationMs: Date.now() - startTime, positionsPersisted, metricsFlushSuccess, errors };
    } catch (e) {
      this.status = 'STOPPED';
      errors.push(`Unexpected: ${e instanceof Error ? e.message : String(e)}`);
      return { success: false, shutdownDurationMs: Date.now() - startTime, positionsPersisted, metricsFlushSuccess, errors };
    }
  }

  private sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
  getStatus(): OrchestratorStatus { return this.status; }
  getStats(): SignalProcessingStats { return { ...this.stats }; }
  getConfig(): CopyTradingConfig { return this.config; }
  getCurator(): ISmartMoneyCurator | undefined { return this.curator; }
  getWalletWatcher(): WalletWatcher | undefined { return this.walletWatcher; }
  getSignalEnricher(): SignalEnricher | undefined { return this.signalEnricher; }
  getAntiBaitingModule(): AntiBaitingModule | undefined { return this.antiBaitingModule; }
  getExecutor(): CopyExecutor | undefined { return this.executor; }
  getExitManager(): ExitManager | undefined { return this.exitManager; }
  getRiskManager(): CopyTradingRiskManager | undefined { return this.riskManager; }
  getMetricsRecorder(): CopyMetricsRecorder | undefined { return this.metricsRecorder; }
  getApi(): CopyTradingAPI | undefined { return this.api; }
  getRugAlertService(): RugAlertService | null | undefined { return this.rugAlertService; }
}
