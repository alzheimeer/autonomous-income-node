/**
 * CopyTradingOrchestrator Tests - Tasks 23.1, 23.2, 23.3, 23.4
 *
 * Tests for the orchestrator lifecycle, signal flow, position restoration,
 * and graceful shutdown.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  CopyTradingOrchestrator,
  createCopyTradingOrchestrator,
  type CopyTradingOrchestratorDeps,
  type ShutdownResult,
} from '../CopyTradingOrchestrator.js';
import type { CopyTradingConfig } from '../config/CopyTradingConfig.js';
import type { CopyPosition, CopySignal, EnrichedSignal, IExitManager } from '../interfaces/types.js';
import type { PositionRestorationResult } from '../modules/CopyMetricsRecorder.js';

// =============================================================================
// MOCK FACTORIES
// =============================================================================

function createMockConfig(): CopyTradingConfig {
  return {
    wsRpcUrl: 'wss://test-rpc.example.com',
    httpRpcUrl: 'https://test-rpc.example.com',
    pollingIntervalMs: 5000,
    initialCapitalUsdc: 1000,
    maxPositionUsdc: 100,
    maxConcurrentPositions: 5,
    maxDailyCapitalPct: 20,
    maxLossStreak: 3,
    maxDrawdownPct: 15,
    minReservePct: 10,
    circuitBreakerHours: 24,
    copyRatio: 0.1,
    takeProfitPct: 50,
    stopLossPct: 20,
    timeStopHours: 48,
    trailActivationPct: 10,
    trailDistancePct: 5,
    maxSlippagePct: 3,
    maxGasGwei: 50,
    executionDelayMinMs: 1000,
    executionDelayMaxMs: 5000,
    maxBaitFlags: 3,
    baitFlagWindowDays: 30,
    maxVolumeFootprintPct: 10,
    apiKey: 'test-api-key',
    apiPort: 3000,
  };
}

function createMockSignal(): CopySignal {
  return {
    id: 'sig-001',
    sourceWallet: '0x1234567890123456789012345678901234567890',
    walletTier: 'S_TIER',
    tokenAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
    poolAddress: '0xpool1234567890abcdef1234567890abcdef1234',
    action: 'BUY',
    tradeAmountUsdc: 1000,
    entryPrice: 100n,
    blockNumber: 12345678,
    txHash: '0xtxhash123',
    detectedAt: Date.now(),
    detectionLatencyMs: 50,
  };
}

function createMockPosition(): CopyPosition {
  return {
    id: 'pos-001',
    signalId: 'sig-001',
    sourceWallet: '0x1234567890123456789012345678901234567890',
    tokenAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
    poolAddress: '0xpool1234567890abcdef1234567890abcdef1234',
    entryPrice: 100n,
    positionSizeUsdc: 50,
    tokenAmount: 500000n,
    takeProfit: 150n,
    stopLoss: 80n,
    trailingStopTrigger: 120n,
    trailingStopLevel: null,
    timeStop: Date.now() + 48 * 60 * 60 * 1000,
    status: 'OPEN',
    openedAt: Date.now(),
    closedAt: null,
    exitPrice: null,
    pnlUsdc: null,
    exitReason: null,
  };
}

function createMockWalletWatcher() {
  const emitter = new EventEmitter();
  return {
    start: vi.fn(),
    stop: vi.fn(),
    onSignal: vi.fn((callback: (signal: CopySignal) => void) => {
      emitter.on('signal', callback);
    }),
    emitSignal: (signal: CopySignal) => emitter.emit('signal', signal),
  };
}

function createMockSignalEnricher() {
  return {
    enrich: vi.fn().mockResolvedValue({
      ...createMockSignal(),
      approved: true,
      rejectReason: null,
    } as EnrichedSignal),
  };
}

function createMockAntiBaitingModule() {
  return {
    check: vi.fn().mockResolvedValue({
      approved: true,
      suggestedDelay: 0,
    }),
  };
}

function createMockExecutor() {
  const positions = new Map<string, CopyPosition>();
  return {
    execute: vi.fn().mockResolvedValue({
      success: true,
      positionId: 'pos-001',
    }),
    getPosition: vi.fn((id: string) => positions.get(id)),
    getOpenPositions: vi.fn(() => Array.from(positions.values())),
    addPosition: (pos: CopyPosition) => positions.set(pos.id, pos),
  };
}

function createMockExitManager() {
  const emitter = new EventEmitter();
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    registerPosition: vi.fn(),
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      emitter.on(event, callback);
    }),
    emitExit: (event: { position: CopyPosition }) => emitter.emit('exit', event),
  };
}

function createMockMetricsRecorder() {
  return {
    flushSignalBatch: vi.fn().mockResolvedValue(undefined),
    updatePosition: vi.fn().mockResolvedValue(undefined),
    recordPositionOpen: vi.fn().mockResolvedValue(undefined),
    recordPositionClose: vi.fn().mockResolvedValue(undefined),
    restorePositions: vi.fn().mockResolvedValue({
      totalLoaded: 2,
      restored: 2,
      expiredTimeStop: 0,
      errors: 0,
    } as PositionRestorationResult),
  };
}

function createMockApi() {
  return {
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('CopyTradingOrchestrator', () => {
  let mockConfig: CopyTradingConfig;
  let mockWalletWatcher: ReturnType<typeof createMockWalletWatcher>;
  let mockSignalEnricher: ReturnType<typeof createMockSignalEnricher>;
  let mockAntiBaitingModule: ReturnType<typeof createMockAntiBaitingModule>;
  let mockExecutor: ReturnType<typeof createMockExecutor>;
  let mockExitManager: ReturnType<typeof createMockExitManager>;
  let mockMetricsRecorder: ReturnType<typeof createMockMetricsRecorder>;
  let mockApi: ReturnType<typeof createMockApi>;
  let orchestrator: CopyTradingOrchestrator;

  beforeEach(() => {
    mockConfig = createMockConfig();
    mockWalletWatcher = createMockWalletWatcher();
    mockSignalEnricher = createMockSignalEnricher();
    mockAntiBaitingModule = createMockAntiBaitingModule();
    mockExecutor = createMockExecutor();
    mockExitManager = createMockExitManager();
    mockMetricsRecorder = createMockMetricsRecorder();
    mockApi = createMockApi();
  });

  afterEach(async () => {
    if (orchestrator && orchestrator.isRunning()) {
      await orchestrator.stop();
    }
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create orchestrator with dependencies', () => {
      const deps: CopyTradingOrchestratorDeps = {
        config: mockConfig,
      };
      orchestrator = new CopyTradingOrchestrator(deps);
      expect(orchestrator).toBeInstanceOf(CopyTradingOrchestrator);
      expect(orchestrator.getStatus()).toBe('STOPPED');
    });

    it('should create orchestrator with all modules', () => {
      orchestrator = new CopyTradingOrchestrator({
        config: mockConfig,
        walletWatcher: mockWalletWatcher as unknown as CopyTradingOrchestratorDeps['walletWatcher'],
        signalEnricher: mockSignalEnricher as unknown as CopyTradingOrchestratorDeps['signalEnricher'],
        antiBaitingModule: mockAntiBaitingModule as unknown as CopyTradingOrchestratorDeps['antiBaitingModule'],
        executor: mockExecutor as unknown as CopyTradingOrchestratorDeps['executor'],
        exitManager: mockExitManager as unknown as CopyTradingOrchestratorDeps['exitManager'],
        metricsRecorder: mockMetricsRecorder as unknown as CopyTradingOrchestratorDeps['metricsRecorder'],
        api: mockApi as unknown as CopyTradingOrchestratorDeps['api'],
      });
      expect(orchestrator.getConfig()).toBe(mockConfig);
    });
  });

  describe('start/stop lifecycle', () => {
    beforeEach(() => {
      orchestrator = new CopyTradingOrchestrator({
        config: mockConfig,
        walletWatcher: mockWalletWatcher as unknown as CopyTradingOrchestratorDeps['walletWatcher'],
        exitManager: mockExitManager as unknown as CopyTradingOrchestratorDeps['exitManager'],
        metricsRecorder: mockMetricsRecorder as unknown as CopyTradingOrchestratorDeps['metricsRecorder'],
      });
    });

    it('should start successfully', async () => {
      await orchestrator.start();
      expect(orchestrator.getStatus()).toBe('RUNNING');
      expect(orchestrator.isRunning()).toBe(true);
      expect(mockExitManager.start).toHaveBeenCalled();
      expect(mockWalletWatcher.start).toHaveBeenCalled();
    });

    it('should not start twice', async () => {
      await orchestrator.start();
      await orchestrator.start();
      expect(orchestrator.getStatus()).toBe('RUNNING');
    });

    it('should stop successfully', async () => {
      await orchestrator.start();
      const result = await orchestrator.stop();
      expect(orchestrator.getStatus()).toBe('STOPPED');
      expect(orchestrator.isRunning()).toBe(false);
      expect(result.success).toBe(true);
    });

    it('should handle stop when not running', async () => {
      const result = await orchestrator.stop();
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Not running');
    });

    it('should track uptime', async () => {
      await orchestrator.start();
      await new Promise((r) => setTimeout(r, 50));
      const uptime = orchestrator.getUptime();
      expect(uptime).toBeGreaterThanOrEqual(50);
    });
  });

  describe('graceful shutdown (Task 23.4)', () => {
    beforeEach(() => {
      orchestrator = new CopyTradingOrchestrator({
        config: mockConfig,
        walletWatcher: mockWalletWatcher as unknown as CopyTradingOrchestratorDeps['walletWatcher'],
        exitManager: mockExitManager as unknown as CopyTradingOrchestratorDeps['exitManager'],
        metricsRecorder: mockMetricsRecorder as unknown as CopyTradingOrchestratorDeps['metricsRecorder'],
        executor: mockExecutor as unknown as CopyTradingOrchestratorDeps['executor'],
        api: mockApi as unknown as CopyTradingOrchestratorDeps['api'],
      });
    });

    it('should stop WalletWatcher on shutdown', async () => {
      await orchestrator.start();
      await orchestrator.stop();
      expect(mockWalletWatcher.stop).toHaveBeenCalled();
    });

    it('should stop API server on shutdown', async () => {
      await orchestrator.start();
      await orchestrator.stop();
      expect(mockApi.stop).toHaveBeenCalled();
    });

    it('should stop ExitManager on shutdown', async () => {
      await orchestrator.start();
      await orchestrator.stop();
      expect(mockExitManager.stop).toHaveBeenCalled();
    });

    it('should flush metrics on shutdown', async () => {
      await orchestrator.start();
      await orchestrator.stop();
      expect(mockMetricsRecorder.flushSignalBatch).toHaveBeenCalled();
    });

    it('should persist open positions on shutdown', async () => {
      const position = createMockPosition();
      mockExecutor.addPosition(position);
      mockExecutor.getOpenPositions.mockReturnValue([position]);

      await orchestrator.start();
      const result = await orchestrator.stop();

      expect(mockMetricsRecorder.updatePosition).toHaveBeenCalledWith(position);
      expect(result.positionsPersisted).toBe(1);
    });

    it('should return shutdown result with metrics', async () => {
      await orchestrator.start();
      const result = await orchestrator.stop();

      expect(result).toMatchObject({
        success: true,
        metricsFlushSuccess: true,
        errors: [],
      });
      expect(result.shutdownDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('should handle metrics flush failure gracefully', async () => {
      mockMetricsRecorder.flushSignalBatch.mockRejectedValue(new Error('Flush failed'));

      await orchestrator.start();
      const result = await orchestrator.stop();

      expect(result.metricsFlushSuccess).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Metrics flush failed');
    });

    it('should handle position persistence failure gracefully', async () => {
      const position = createMockPosition();
      mockExecutor.addPosition(position);
      mockExecutor.getOpenPositions.mockReturnValue([position]);
      mockMetricsRecorder.updatePosition.mockRejectedValue(new Error('DB error'));

      await orchestrator.start();
      const result = await orchestrator.stop();

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Position persistence failed');
    });
  });

  describe('gracefulShutdown with timeout', () => {
    beforeEach(() => {
      orchestrator = new CopyTradingOrchestrator({
        config: mockConfig,
        walletWatcher: mockWalletWatcher as unknown as CopyTradingOrchestratorDeps['walletWatcher'],
        exitManager: mockExitManager as unknown as CopyTradingOrchestratorDeps['exitManager'],
        metricsRecorder: mockMetricsRecorder as unknown as CopyTradingOrchestratorDeps['metricsRecorder'],
      });
    });

    it('should complete shutdown before timeout', async () => {
      await orchestrator.start();
      const result = await orchestrator.gracefulShutdown(5000);

      expect(result.success).toBe(true);
      expect(result.shutdownDurationMs).toBeLessThan(5000);
    });

    it('should timeout if shutdown takes too long', async () => {
      // Make flushSignalBatch take forever
      mockMetricsRecorder.flushSignalBatch.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 10000))
      );

      await orchestrator.start();
      const result = await orchestrator.gracefulShutdown(100);

      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.includes('timeout'))).toBe(true);
    });
  });

  describe('position restoration (Task 23.3)', () => {
    beforeEach(() => {
      orchestrator = new CopyTradingOrchestrator({
        config: mockConfig,
        exitManager: mockExitManager as unknown as CopyTradingOrchestratorDeps['exitManager'],
        metricsRecorder: mockMetricsRecorder as unknown as CopyTradingOrchestratorDeps['metricsRecorder'],
      });
    });

    it('should restore positions on start', async () => {
      await orchestrator.start();
      expect(mockMetricsRecorder.restorePositions).toHaveBeenCalledWith(mockExitManager);
    });

    it('should handle restoration failure gracefully', async () => {
      mockMetricsRecorder.restorePositions.mockRejectedValue(new Error('Restoration failed'));

      // Should not throw
      await orchestrator.start();
      expect(orchestrator.isRunning()).toBe(true);
    });
  });

  describe('signal processing stats', () => {
    beforeEach(() => {
      orchestrator = new CopyTradingOrchestrator({
        config: mockConfig,
      });
    });

    it('should return initial stats as zero', () => {
      const stats = orchestrator.getStats();
      expect(stats.signalsReceived).toBe(0);
      expect(stats.signalsEnriched).toBe(0);
      expect(stats.signalsApprovedByEnricher).toBe(0);
      expect(stats.signalsRejectedByEnricher).toBe(0);
      expect(stats.tradesExecuted).toBe(0);
    });
  });

  describe('module accessors', () => {
    it('should return undefined for unset modules', () => {
      orchestrator = new CopyTradingOrchestrator({ config: mockConfig });
      
      expect(orchestrator.getWalletWatcher()).toBeUndefined();
      expect(orchestrator.getSignalEnricher()).toBeUndefined();
      expect(orchestrator.getAntiBaitingModule()).toBeUndefined();
      expect(orchestrator.getExecutor()).toBeUndefined();
      expect(orchestrator.getExitManager()).toBeUndefined();
      expect(orchestrator.getRiskManager()).toBeUndefined();
      expect(orchestrator.getMetricsRecorder()).toBeUndefined();
      expect(orchestrator.getCurator()).toBeUndefined();
      expect(orchestrator.getApi()).toBeUndefined();
    });

    it('should return set modules', () => {
      orchestrator = new CopyTradingOrchestrator({
        config: mockConfig,
        walletWatcher: mockWalletWatcher as unknown as CopyTradingOrchestratorDeps['walletWatcher'],
        exitManager: mockExitManager as unknown as CopyTradingOrchestratorDeps['exitManager'],
      });

      expect(orchestrator.getConfig()).toBe(mockConfig);
      expect(orchestrator.getWalletWatcher()).toBe(mockWalletWatcher);
      expect(orchestrator.getExitManager()).toBe(mockExitManager);
    });
  });
});

describe('createCopyTradingOrchestrator factory', () => {
  it('should create orchestrator instance', () => {
    const deps: CopyTradingOrchestratorDeps = {
      config: createMockConfig(),
    };
    const orchestrator = createCopyTradingOrchestrator(deps);
    expect(orchestrator).toBeInstanceOf(CopyTradingOrchestrator);
  });
});
