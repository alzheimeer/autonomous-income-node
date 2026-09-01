/**
 * Tests for HealthChecker and MetricsCollector
 *
 * Unit tests: specific behaviour examples
 * Property tests (fast-check): universal invariants
 *
 * Validates: Requirements 11.1, 11.2, 11.4, 11.5, 11.6
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { HealthChecker, type ModuleHealthStatus } from './health-checker.js';
import { MetricsCollector } from './metrics-collector.js';
import type { HeartbeatRepository } from '../state/repositories/heartbeat.repo.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(overrides?: Partial<HeartbeatRepository>): HeartbeatRepository {
  return {
    insertHeartbeat: vi.fn().mockReturnValue(1),
    getLatestHeartbeat: vi.fn().mockReturnValue(null),
    findHeartbeats: vi.fn().mockReturnValue([]),
    insertCrash: vi.fn().mockReturnValue(1),
    markRecovered: vi.fn(),
    getUnrecoveredCrash: vi.fn().mockReturnValue(null),
    ...overrides,
  } as unknown as HeartbeatRepository;
}

function healthyStatus(): ModuleHealthStatus {
  return { status: 'healthy', lastCheck: Date.now(), consecutiveFailures: 0 };
}

function unhealthyStatus(): ModuleHealthStatus {
  return { status: 'unhealthy', lastCheck: Date.now(), consecutiveFailures: 1 };
}

// ---------------------------------------------------------------------------
// HealthChecker – unit tests
// ---------------------------------------------------------------------------

describe('HealthChecker', () => {
  let checker: HealthChecker;
  let repo: HeartbeatRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    repo = makeRepo();
    checker = new HealthChecker(repo);
  });

  afterEach(() => {
    checker.stop();
    vi.useRealTimers();
  });

  // --- Requirement 11.1: emit health check event every 30 seconds ---

  it('emits heartbeat:health after 30 seconds', () => {
    const handler = vi.fn();
    checker.on('heartbeat:health', handler);
    checker.start();

    vi.advanceTimersByTime(30_000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('emits heartbeat:health multiple times for multiple intervals', () => {
    const handler = vi.fn();
    checker.on('heartbeat:health', handler);
    checker.start();

    vi.advanceTimersByTime(90_000); // 3 × 30 s
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('does not emit before 30 seconds have elapsed', () => {
    const handler = vi.fn();
    checker.on('heartbeat:health', handler);
    checker.start();

    vi.advanceTimersByTime(29_999);
    expect(handler).not.toHaveBeenCalled();
  });

  // --- Requirement 11.2: alert after 2 consecutive unhealthy cycles ---

  it('emits alert:module-degraded after 2 consecutive unhealthy ticks', () => {
    const alertHandler = vi.fn();
    checker.on('alert:module-degraded', alertHandler);
    checker.start();

    // First unhealthy report
    checker.setModuleStatus('trading', unhealthyStatus());
    vi.advanceTimersByTime(30_000); // tick 1

    // Second unhealthy report (status already tracked as consecutive = 1)
    // setModuleStatus increments on each tick if the status remains unhealthy
    checker.setModuleStatus('trading', unhealthyStatus());
    vi.advanceTimersByTime(30_000); // tick 2

    expect(alertHandler).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'trading' })
    );
  });

  it('does NOT emit alert:module-degraded on first unhealthy cycle', () => {
    const alertHandler = vi.fn();
    checker.on('alert:module-degraded', alertHandler);
    checker.start();

    checker.setModuleStatus('trading', unhealthyStatus());
    vi.advanceTimersByTime(30_000); // only 1 tick

    expect(alertHandler).not.toHaveBeenCalled();
  });

  it('resets consecutive failures when module recovers to healthy', () => {
    checker.start();
    checker.setModuleStatus('trading', unhealthyStatus());
    vi.advanceTimersByTime(30_000);

    // Module recovers
    checker.setModuleStatus('trading', healthyStatus());
    const { modules } = checker.getHealthStatus();
    expect(modules['trading']?.consecutiveFailures).toBe(0);
  });

  // --- getHealthStatus overall ---

  it('returns healthy overall when all modules are healthy', () => {
    checker.setModuleStatus('identity', healthyStatus());
    checker.setModuleStatus('trading', healthyStatus());
    expect(checker.getHealthStatus().overall).toBe('healthy');
  });

  it('returns unhealthy overall when any module is unhealthy', () => {
    checker.setModuleStatus('identity', healthyStatus());
    checker.setModuleStatus('trading', unhealthyStatus());
    expect(checker.getHealthStatus().overall).toBe('unhealthy');
  });

  // --- Requirement 11.4: fallback log when repo.insertHeartbeat throws ---

  it('does not throw and still emits heartbeat:health when insertHeartbeat throws', () => {
    const failingRepo = makeRepo({
      insertHeartbeat: vi.fn().mockImplementation(() => {
        throw new Error('DB unavailable');
      }),
    });

    const faultyChecker = new HealthChecker(failingRepo);
    const handler = vi.fn();
    faultyChecker.on('heartbeat:health', handler);
    faultyChecker.start();
    vi.advanceTimersByTime(30_000);
    faultyChecker.stop();

    // Heartbeat event must still be emitted even when SQLite fails
    expect(handler).toHaveBeenCalledTimes(1);
    expect(failingRepo.insertHeartbeat).toHaveBeenCalled();
  });

  // --- Requirement 11.6: crash recovery on startup ---

  it('marks unrecovered crash as recovered on start', () => {
    const crashRepo = makeRepo({
      getUnrecoveredCrash: vi.fn().mockReturnValue({
        id: 42,
        lastKnownState: null,
        crashedAt: Date.now() - 10_000,
        recoveredAt: null,
      }),
    });

    const c = new HealthChecker(crashRepo);
    c.start();
    c.stop();

    expect(crashRepo.markRecovered).toHaveBeenCalledWith(42, expect.any(Number));
  });

  it('emits heartbeat:crash-recovered when unrecovered crash is found', () => {
    const crashRepo = makeRepo({
      getUnrecoveredCrash: vi.fn().mockReturnValue({
        id: 7,
        lastKnownState: null,
        crashedAt: 12345,
        recoveredAt: null,
      }),
    });

    const c = new HealthChecker(crashRepo);
    const handler = vi.fn();
    c.on('heartbeat:crash-recovered', handler);
    c.start();
    c.stop();

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ crashId: 7 })
    );
  });

  // --- stop() prevents further ticks ---

  it('stops emitting after stop() is called', () => {
    const handler = vi.fn();
    checker.on('heartbeat:health', handler);
    checker.start();

    vi.advanceTimersByTime(30_000);
    expect(handler).toHaveBeenCalledTimes(1);

    checker.stop();
    vi.advanceTimersByTime(60_000);
    expect(handler).toHaveBeenCalledTimes(1); // no new calls
  });

  // --- setModuleStatus passthrough ---

  it('persists set status in getHealthStatus', () => {
    const status: ModuleHealthStatus = {
      status: 'degraded',
      lastCheck: Date.now(),
      consecutiveFailures: 0,
    };
    checker.setModuleStatus('social', status);
    const hs = checker.getHealthStatus();
    expect(hs.modules['social']?.status).toBe('degraded');
  });
});

// ---------------------------------------------------------------------------
// MetricsCollector – unit tests
// ---------------------------------------------------------------------------

describe('MetricsCollector', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    vi.useFakeTimers();
    metrics = new MetricsCollector();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 0 uptime before start', () => {
    expect(metrics.getMetrics().uptimeMs).toBe(0);
  });

  it('tracks uptime after start', () => {
    metrics.start();
    vi.advanceTimersByTime(5_000);
    expect(metrics.getMetrics().uptimeMs).toBeGreaterThanOrEqual(5_000);
  });

  it('increments totalCycles on recordCycle', () => {
    metrics.start();
    metrics.recordCycle();
    metrics.recordCycle();
    expect(metrics.getMetrics().totalCycles).toBe(2);
  });

  it('accumulates totalIncomeUsdc', () => {
    metrics.start();
    metrics.recordIncome(1_000000n); // $1
    metrics.recordIncome(500000n);   // $0.50
    expect(metrics.getMetrics().totalIncomeUsdc).toBe(1_500000n);
  });

  it('increments totalErrors on recordError', () => {
    metrics.start();
    metrics.recordError();
    expect(metrics.getMetrics().totalErrors).toBe(1);
  });

  it('computes successRate correctly', () => {
    metrics.start();
    metrics.recordCycle(); // cycle 1 – success
    metrics.recordCycle(); // cycle 2 – success
    metrics.recordCycle(); // cycle 3
    metrics.recordError(); // this is an error on cycle 3
    const snap = metrics.getMetrics();
    // 3 cycles, 1 error → (3-1)/3 = 0.666…
    expect(snap.successRate).toBeCloseTo(2 / 3, 5);
  });

  it('successRate is 1 when there are no cycles', () => {
    metrics.start();
    expect(metrics.getMetrics().successRate).toBe(1);
  });

  it('computes cyclesPerHour correctly', () => {
    metrics.start();
    vi.advanceTimersByTime(3_600_000); // 1 hour
    metrics.recordCycle();
    const snap = metrics.getMetrics();
    expect(snap.cyclesPerHour).toBeCloseTo(1, 1);
  });

  it('does not accumulate income for 0 amounts', () => {
    metrics.start();
    metrics.recordIncome(0n);
    expect(metrics.getMetrics().totalIncomeUsdc).toBe(0n);
  });

  it('resets all counters after stop()', () => {
    metrics.start();
    metrics.recordCycle();
    metrics.recordError();
    metrics.recordIncome(500000n);
    metrics.stop();
    const snap = metrics.getMetrics();
    expect(snap.totalCycles).toBe(0);
    expect(snap.totalErrors).toBe(0);
    expect(snap.totalIncomeUsdc).toBe(0n);
    expect(snap.uptimeMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

/**
 * Validates: Requirements 11.5
 *
 * Property 1: successRate is always in [0, 1]
 */
describe('MetricsCollector – PBT', () => {
  it('successRate is always in [0, 1] for any cycle/error combination', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (cycles, errors) => {
          const mc = new MetricsCollector();
          mc.start();
          for (let i = 0; i < cycles; i++) mc.recordCycle();
          for (let i = 0; i < errors; i++) mc.recordError();
          const { successRate } = mc.getMetrics();
          return successRate >= 0 && successRate <= 1;
        }
      )
    );
  });

  /**
   * Validates: Requirements 11.5
   *
   * Property 2: totalIncomeUsdc equals the sum of all recorded income amounts
   */
  it('totalIncomeUsdc is the exact sum of all positive recorded income amounts', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 0n, max: 1_000_000_000n }), { maxLength: 200 }),
        (amounts) => {
          const mc = new MetricsCollector();
          mc.start();
          for (const a of amounts) mc.recordIncome(a);
          const expected = amounts.reduce((acc, v) => acc + (v > 0n ? v : 0n), 0n);
          return mc.getMetrics().totalIncomeUsdc === expected;
        }
      )
    );
  });

  /**
   * Validates: Requirements 11.5
   *
   * Property 3: cyclesPerHour is always non-negative
   */
  it('cyclesPerHour is always >= 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        (cycles) => {
          const mc = new MetricsCollector();
          mc.start();
          for (let i = 0; i < cycles; i++) mc.recordCycle();
          return mc.getMetrics().cyclesPerHour >= 0;
        }
      )
    );
  });
});

/**
 * Validates: Requirements 11.1, 11.2
 *
 * Property 4: HealthChecker overall is 'unhealthy' whenever any module is 'unhealthy'
 */
describe('HealthChecker – PBT', () => {
  it("overall health is 'unhealthy' whenever at least one module is 'unhealthy'", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            name: fc.string({ minLength: 1, maxLength: 20 }),
            status: fc.constantFrom('healthy', 'degraded', 'unhealthy') as fc.Arbitrary<
              'healthy' | 'degraded' | 'unhealthy'
            >,
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (entries) => {
          const c = new HealthChecker(null);
          for (const { name, status } of entries) {
            c.setModuleStatus(name, {
              status,
              lastCheck: Date.now(),
              consecutiveFailures: status === 'unhealthy' ? 1 : 0,
            });
          }
          const { overall } = c.getHealthStatus();
          const hasUnhealthy = entries.some((e) => e.status === 'unhealthy');
          if (hasUnhealthy) return overall === 'unhealthy';
          const hasDegraded = entries.some((e) => e.status === 'degraded');
          if (hasDegraded) return overall === 'degraded';
          return overall === 'healthy';
        }
      )
    );
  });
});
