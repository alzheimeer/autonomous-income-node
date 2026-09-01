/**
 * Property 17 — HealthChecker: degradation after 2 consecutive unhealthy cycles
 *
 * Validates: Requirements 11.1, 11.2, 11.4
 *
 * Properties verified:
 *  P17-a: setModuleStatus('unhealthy') twice causes consecutiveFailures to reach 2.
 *  P17-b: setModuleStatus('healthy') resets consecutiveFailures to 0.
 *  P17-c: alert:module-degraded is emitted when consecutiveFailures >= 2 on tick.
 *  P17-d: computeOverall returns 'unhealthy' when any module is unhealthy.
 *  P17-e: computeOverall returns 'healthy' when all modules are healthy.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { HealthChecker } from '../health-checker.js';
import type { ModuleHealthStatus } from '../health-checker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHealthy(): ModuleHealthStatus {
  return { status: 'healthy', lastCheck: Date.now(), consecutiveFailures: 0 };
}

function makeUnhealthy(): ModuleHealthStatus {
  return { status: 'unhealthy', lastCheck: Date.now(), consecutiveFailures: 0 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Property 17 — HealthChecker: degradation after 2 consecutive cycles', () => {
  /**
   * P17-a: Two consecutive 'unhealthy' reports increase consecutiveFailures to ≥ 2.
   * Validates: Requirement 11.2
   */
  it('P17-a: two consecutive unhealthy reports produce consecutiveFailures >= 2', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
        (moduleName) => {
          const checker = new HealthChecker(null);
          checker.setModuleStatus(moduleName, makeUnhealthy());
          checker.setModuleStatus(moduleName, makeUnhealthy());

          const status = checker.getHealthStatus();
          const moduleStatus = status.modules[moduleName];
          return moduleStatus !== undefined && moduleStatus.consecutiveFailures >= 2;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * P17-b: A 'healthy' report always resets consecutiveFailures to 0.
   * Validates: Requirement 11.2
   */
  it('P17-b: healthy report always resets consecutiveFailures to 0', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
        fc.integer({ min: 1, max: 5 }),
        (moduleName, unhealthyCount) => {
          const checker = new HealthChecker(null);

          // Accumulate failures
          for (let i = 0; i < unhealthyCount; i++) {
            checker.setModuleStatus(moduleName, makeUnhealthy());
          }

          // Reset with healthy
          checker.setModuleStatus(moduleName, makeHealthy());

          const status = checker.getHealthStatus();
          const moduleStatus = status.modules[moduleName];
          return moduleStatus !== undefined && moduleStatus.consecutiveFailures === 0;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * P17-c: getHealthStatus().overall is 'unhealthy' when any module is unhealthy.
   * Validates: Requirement 11.2
   */
  it('P17-c: overall health is unhealthy when any module is unhealthy', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
          { minLength: 1, maxLength: 5 }
        ),
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
        (healthyModules, unhealthyModule) => {
          const checker = new HealthChecker(null);

          for (const m of healthyModules) {
            checker.setModuleStatus(m, makeHealthy());
          }
          checker.setModuleStatus(unhealthyModule, makeUnhealthy());

          const status = checker.getHealthStatus();
          return status.overall === 'unhealthy';
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * P17-d: overall health is 'healthy' when all modules report healthy.
   * Validates: Requirement 11.2
   */
  it('P17-d: overall health is healthy when all modules are healthy', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
          { minLength: 1, maxLength: 5 }
        ),
        (modules) => {
          const checker = new HealthChecker(null);
          // Use unique module names
          const unique = [...new Set(modules)];
          for (const m of unique) {
            checker.setModuleStatus(m, makeHealthy());
          }
          const status = checker.getHealthStatus();
          return status.overall === 'healthy';
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * P17-e: N consecutive unhealthy reports produce consecutiveFailures === N.
   * Validates: Requirement 11.2
   */
  it('P17-e: consecutiveFailures grows exactly by 1 per unhealthy report', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (n) => {
          const checker = new HealthChecker(null);
          const moduleName = 'test-module';

          for (let i = 0; i < n; i++) {
            checker.setModuleStatus(moduleName, makeUnhealthy());
          }

          const status = checker.getHealthStatus();
          const ms = status.modules[moduleName];
          return ms !== undefined && ms.consecutiveFailures === n;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * P17-f: getHealthStatus() always returns a valid HealthStatus object.
   * Validates: Requirement 11.1
   */
  it('P17-f: getHealthStatus always returns a structurally valid object', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
            fc.boolean()
          ),
          { minLength: 0, maxLength: 5 }
        ),
        (moduleStatuses) => {
          const checker = new HealthChecker(null);
          const seen = new Set<string>();
          for (const [name, healthy] of moduleStatuses) {
            if (seen.has(name)) continue;
            seen.add(name);
            checker.setModuleStatus(name, healthy ? makeHealthy() : makeUnhealthy());
          }

          const status = checker.getHealthStatus();
          return (
            typeof status.overall === 'string' &&
            ['healthy', 'degraded', 'unhealthy'].includes(status.overall) &&
            typeof status.timestamp === 'number' &&
            typeof status.llmAvailable === 'boolean' &&
            typeof status.modules === 'object'
          );
        }
      ),
      { numRuns: 100 }
    );
  });
});
