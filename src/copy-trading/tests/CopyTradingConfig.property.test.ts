/**
 * CopyTradingConfig — Property-Based Tests
 *
 * **Property 33: Configuration Default Values**
 *
 * Property-based tests for CopyTradingConfig using Vitest + fast-check.
 * Validates that configuration defaults are applied correctly when env vars
 * are missing, and invalid values fall back to defaults.
 *
 * **Validates: Requirements 10.1-10.12**
 *
 * Default values per requirements:
 * - COPY_INITIAL_CAPITAL_USDC: 500 (Req 10.1)
 * - COPY_MAX_POSITION_USDC: 100 (Req 10.2)
 * - COPY_RATIO: 0.10 (Req 10.3)
 * - COPY_TP_PCT: 50 (Req 10.4)
 * - COPY_SL_PCT: 20 (Req 10.5)
 * - COPY_TRAIL_ACTIVATION_PCT: 10 (Req 10.6)
 * - COPY_TRAIL_DISTANCE_PCT: 10 (Req 10.7)
 * - COPY_TIME_STOP_HOURS: 48 (Req 10.8)
 * - COPY_MAX_GAS_GWEI: 50 (Req 10.9)
 * - COPY_MAX_LOSS_STREAK: 3 (Req 10.11)
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  loadCopyTradingConfig,
  COPY_TRADING_DEFAULTS as DEFAULTS,
} from '../config/CopyTradingConfig.js';

// ═══════════════════════════════════════════════════════════════════════════
// Expected Default Values (from Requirements 10.1-10.12)
// ═══════════════════════════════════════════════════════════════════════════

const EXPECTED_DEFAULTS = {
  COPY_INITIAL_CAPITAL_USDC: 500,   // Req 10.1
  COPY_MAX_POSITION_USDC: 100,      // Req 10.2
  COPY_RATIO: 0.10,                 // Req 10.3
  COPY_TP_PCT: 50,                  // Req 10.4
  COPY_SL_PCT: 20,                  // Req 10.5
  COPY_TRAIL_ACTIVATION_PCT: 10,   // Req 10.6
  COPY_TRAIL_DISTANCE_PCT: 10,     // Req 10.7
  COPY_TIME_STOP_HOURS: 48,        // Req 10.8
  COPY_MAX_GAS_GWEI: 50,           // Req 10.9
  COPY_MAX_LOSS_STREAK: 3,         // Req 10.11
} as const;

// Required env var for any config load
const BASE_ENV = {
  COPY_WS_RPC_URL: 'wss://test.example.com',
};

// ═══════════════════════════════════════════════════════════════════════════
// Generators
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate invalid numeric strings (non-numeric values)
 */
const invalidNumericString = fc.oneof(
  fc.constantFrom('abc', 'NaN', 'undefined', 'null', '!!invalid!!', '@#$%'),
  fc.string().filter(s => isNaN(Number(s)) && s.trim() !== ''),
);

/**
 * Generate negative numbers (invalid for positive-only fields)
 */
const negativeNumber = fc.integer({ min: -10000, max: -1 }).map(n => n.toString());

/**
 * Generate valid positive numbers
 */
const validPositiveNumber = fc.integer({ min: 1, max: 10000 });

/**
 * Generate valid percentages (0-100)
 */
const validPercentage = fc.integer({ min: 0, max: 100 });

/**
 * Generate valid ratios (0-1)
 */
const validRatio = fc.double({ min: 0.01, max: 1, noNaN: true });

/**
 * Generate empty or whitespace strings
 */
const emptyOrWhitespace = fc.constantFrom('', '   ', '\t', '\n', '  \t  ');

/**
 * Generate a subset of config keys to override
 */
const configKeySubset = fc.subarray(
  [
    'COPY_INITIAL_CAPITAL_USDC',
    'COPY_MAX_POSITION_USDC',
    'COPY_RATIO',
    'COPY_TP_PCT',
    'COPY_SL_PCT',
    'COPY_TRAIL_ACTIVATION_PCT',
    'COPY_TRAIL_DISTANCE_PCT',
    'COPY_TIME_STOP_HOURS',
    'COPY_MAX_GAS_GWEI',
    'COPY_MAX_LOSS_STREAK',
  ] as const,
  { minLength: 0, maxLength: 10 },
);

// ═══════════════════════════════════════════════════════════════════════════
// Property Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('CopyTradingConfig - Property 33: Configuration Default Values', () => {

  // ═══════════════════════════════════════════════════════════════════════
  // Property 33.1: All defaults match requirements when env vars are missing
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 33.1: All defaults are applied when env vars are missing', () => {

    /**
     * **Validates: Requirements 10.1-10.12**
     *
     * When no configuration env vars are provided (except required RPC URL),
     * all defaults SHALL be applied correctly as specified in requirements.
     */
    it('applies all default values when env vars are missing', () => {
      const config = loadCopyTradingConfig(BASE_ENV);

      // Verify each default matches requirements
      expect(config.initialCapitalUsdc).toBe(EXPECTED_DEFAULTS.COPY_INITIAL_CAPITAL_USDC);
      expect(config.maxPositionUsdc).toBe(EXPECTED_DEFAULTS.COPY_MAX_POSITION_USDC);
      expect(config.copyRatio).toBe(EXPECTED_DEFAULTS.COPY_RATIO);
      expect(config.takeProfitPct).toBe(EXPECTED_DEFAULTS.COPY_TP_PCT);
      expect(config.stopLossPct).toBe(EXPECTED_DEFAULTS.COPY_SL_PCT);
      expect(config.trailActivationPct).toBe(EXPECTED_DEFAULTS.COPY_TRAIL_ACTIVATION_PCT);
      expect(config.trailDistancePct).toBe(EXPECTED_DEFAULTS.COPY_TRAIL_DISTANCE_PCT);
      expect(config.timeStopHours).toBe(EXPECTED_DEFAULTS.COPY_TIME_STOP_HOURS);
      expect(config.maxGasGwei).toBe(EXPECTED_DEFAULTS.COPY_MAX_GAS_GWEI);
      expect(config.maxLossStreak).toBe(EXPECTED_DEFAULTS.COPY_MAX_LOSS_STREAK);
    });

    /**
     * **Validates: Requirements 10.1-10.11**
     *
     * For any arbitrary subset of env vars missing, those missing vars
     * SHALL fall back to their defaults.
     */
    it('applies defaults for any missing subset of env vars', () => {
      fc.assert(
        fc.property(
          configKeySubset,
          (keysToProvide) => {
            // Build env with only the provided keys (set to valid values)
            const env: Record<string, string> = { ...BASE_ENV };

            for (const key of keysToProvide) {
              // Provide valid non-default values
              if (key === 'COPY_RATIO') {
                env[key] = '0.50'; // Different from default 0.10
              } else if (key.includes('PCT')) {
                env[key] = '75'; // Different from defaults
              } else {
                env[key] = '999'; // Different from defaults
              }
            }

            const config = loadCopyTradingConfig(env);

            // Verify unprovided keys have default values
            const allKeys = Object.keys(EXPECTED_DEFAULTS) as Array<keyof typeof EXPECTED_DEFAULTS>;

            for (const key of allKeys) {
              const isProvided = keysToProvide.includes(key);

              if (!isProvided) {
                // Should have default value
                const configKey = envKeyToConfigKey(key);
                const configValue = config[configKey as keyof typeof config];
                const expectedDefault = EXPECTED_DEFAULTS[key];

                expect(configValue).toBe(expectedDefault);
              }
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 33.2: Invalid values fall back to defaults
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 33.2: Invalid values fall back to defaults', () => {

    /**
     * **Validates: Requirements 10.12**
     *
     * For any non-numeric string value, the system SHALL use the default.
     * parseEnvNumber returns undefined for invalid strings, which lets Zod apply defaults.
     */
    it('uses defaults for non-numeric string values', () => {
      fc.assert(
        fc.property(
          invalidNumericString,
          (invalidValue) => {
            const env = {
              ...BASE_ENV,
              COPY_INITIAL_CAPITAL_USDC: invalidValue,
              COPY_MAX_POSITION_USDC: invalidValue,
              COPY_TP_PCT: invalidValue,
              COPY_SL_PCT: invalidValue,
              COPY_TIME_STOP_HOURS: invalidValue,
              COPY_MAX_GAS_GWEI: invalidValue,
              COPY_MAX_LOSS_STREAK: invalidValue,
            };

            const config = loadCopyTradingConfig(env);

            // All should fall back to defaults
            expect(config.initialCapitalUsdc).toBe(EXPECTED_DEFAULTS.COPY_INITIAL_CAPITAL_USDC);
            expect(config.maxPositionUsdc).toBe(EXPECTED_DEFAULTS.COPY_MAX_POSITION_USDC);
            expect(config.takeProfitPct).toBe(EXPECTED_DEFAULTS.COPY_TP_PCT);
            expect(config.stopLossPct).toBe(EXPECTED_DEFAULTS.COPY_SL_PCT);
            expect(config.timeStopHours).toBe(EXPECTED_DEFAULTS.COPY_TIME_STOP_HOURS);
            expect(config.maxGasGwei).toBe(EXPECTED_DEFAULTS.COPY_MAX_GAS_GWEI);
            expect(config.maxLossStreak).toBe(EXPECTED_DEFAULTS.COPY_MAX_LOSS_STREAK);
          }
        ),
        { numRuns: 30 }
      );
    });

    /**
     * **Validates: Requirements 10.12**
     *
     * For negative values in positive-only fields, the config uses defaults.
     * (parsePositiveNumber returns default when value is <= 0)
     */
    it('uses defaults for negative values in positive-only fields', () => {
      fc.assert(
        fc.property(
          negativeNumber,
          (negValue) => {
            const env = {
              ...BASE_ENV,
              COPY_INITIAL_CAPITAL_USDC: negValue,
              COPY_MAX_POSITION_USDC: negValue,
              COPY_TIME_STOP_HOURS: negValue,
              COPY_MAX_GAS_GWEI: negValue,
            };

            const config = loadCopyTradingConfig(env);

            // Should fall back to defaults for negative values
            expect(config.initialCapitalUsdc).toBe(EXPECTED_DEFAULTS.COPY_INITIAL_CAPITAL_USDC);
            expect(config.maxPositionUsdc).toBe(EXPECTED_DEFAULTS.COPY_MAX_POSITION_USDC);
            expect(config.timeStopHours).toBe(EXPECTED_DEFAULTS.COPY_TIME_STOP_HOURS);
            expect(config.maxGasGwei).toBe(EXPECTED_DEFAULTS.COPY_MAX_GAS_GWEI);
          }
        ),
        { numRuns: 30 }
      );
    });

    /**
     * **Validates: Requirements 10.12**
     *
     * For percentage values outside 0-100 range (> 100), the config uses defaults.
     * (parsePercentage returns default when value is out of range)
     */
    it('uses defaults for percentage values greater than 100', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 101, max: 1000 }).map(n => n.toString()),
          (invalidPct) => {
            const env = {
              ...BASE_ENV,
              COPY_TP_PCT: invalidPct,
              COPY_SL_PCT: invalidPct,
              COPY_TRAIL_ACTIVATION_PCT: invalidPct,
              COPY_TRAIL_DISTANCE_PCT: invalidPct,
            };

            const config = loadCopyTradingConfig(env);

            // Should fall back to defaults for out-of-range percentages
            expect(config.takeProfitPct).toBe(EXPECTED_DEFAULTS.COPY_TP_PCT);
            expect(config.stopLossPct).toBe(EXPECTED_DEFAULTS.COPY_SL_PCT);
            expect(config.trailActivationPct).toBe(EXPECTED_DEFAULTS.COPY_TRAIL_ACTIVATION_PCT);
            expect(config.trailDistancePct).toBe(EXPECTED_DEFAULTS.COPY_TRAIL_DISTANCE_PCT);
          }
        ),
        { numRuns: 30 }
      );
    });

    /**
     * **Validates: Requirements 10.12**
     *
     * For ratio values outside 0-1 range (> 1), the config uses defaults.
     * (parseRatio returns default when value is out of range)
     */
    it('uses defaults for ratio values greater than 1', () => {
      fc.assert(
        fc.property(
          fc.double({ min: 1.01, max: 10, noNaN: true }).map(n => n.toString()),
          (invalidRatioValue) => {
            const env = {
              ...BASE_ENV,
              COPY_RATIO: invalidRatioValue,
            };

            const config = loadCopyTradingConfig(env);

            // Should fall back to default for out-of-range ratio
            expect(config.copyRatio).toBe(EXPECTED_DEFAULTS.COPY_RATIO);
          }
        ),
        { numRuns: 30 }
      );
    });

    /**
     * **Validates: Requirements 10.12**
     *
     * For empty or whitespace-only values, use defaults.
     * parseEnvNumber returns undefined for empty/whitespace strings.
     */
    it('uses defaults for empty or whitespace-only values', () => {
      fc.assert(
        fc.property(
          emptyOrWhitespace,
          (emptyValue) => {
            const env = {
              ...BASE_ENV,
              COPY_INITIAL_CAPITAL_USDC: emptyValue,
              COPY_MAX_POSITION_USDC: emptyValue,
              COPY_RATIO: emptyValue,
              COPY_TP_PCT: emptyValue,
              COPY_SL_PCT: emptyValue,
              COPY_TRAIL_ACTIVATION_PCT: emptyValue,
              COPY_TRAIL_DISTANCE_PCT: emptyValue,
              COPY_TIME_STOP_HOURS: emptyValue,
              COPY_MAX_GAS_GWEI: emptyValue,
              COPY_MAX_LOSS_STREAK: emptyValue,
            };

            const config = loadCopyTradingConfig(env);

            // All should use defaults
            expect(config.initialCapitalUsdc).toBe(EXPECTED_DEFAULTS.COPY_INITIAL_CAPITAL_USDC);
            expect(config.maxPositionUsdc).toBe(EXPECTED_DEFAULTS.COPY_MAX_POSITION_USDC);
            expect(config.copyRatio).toBe(EXPECTED_DEFAULTS.COPY_RATIO);
            expect(config.takeProfitPct).toBe(EXPECTED_DEFAULTS.COPY_TP_PCT);
            expect(config.stopLossPct).toBe(EXPECTED_DEFAULTS.COPY_SL_PCT);
            expect(config.trailActivationPct).toBe(EXPECTED_DEFAULTS.COPY_TRAIL_ACTIVATION_PCT);
            expect(config.trailDistancePct).toBe(EXPECTED_DEFAULTS.COPY_TRAIL_DISTANCE_PCT);
            expect(config.timeStopHours).toBe(EXPECTED_DEFAULTS.COPY_TIME_STOP_HOURS);
            expect(config.maxGasGwei).toBe(EXPECTED_DEFAULTS.COPY_MAX_GAS_GWEI);
            expect(config.maxLossStreak).toBe(EXPECTED_DEFAULTS.COPY_MAX_LOSS_STREAK);
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 33.3: Valid values are accepted and override defaults
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 33.3: Valid values override defaults', () => {

    /**
     * **Validates: Requirements 10.1-10.11**
     *
     * For any valid positive number, the config SHALL use that value
     * instead of the default.
     */
    it('uses provided valid positive numbers instead of defaults', () => {
      fc.assert(
        fc.property(
          validPositiveNumber,
          (validValue) => {
            const env = {
              ...BASE_ENV,
              COPY_INITIAL_CAPITAL_USDC: validValue.toString(),
              COPY_TIME_STOP_HOURS: validValue.toString(),
              COPY_MAX_GAS_GWEI: validValue.toString(),
              COPY_MAX_LOSS_STREAK: validValue.toString(),
            };

            const config = loadCopyTradingConfig(env);

            expect(config.initialCapitalUsdc).toBe(validValue);
            expect(config.timeStopHours).toBe(validValue);
            expect(config.maxGasGwei).toBe(validValue);
            expect(config.maxLossStreak).toBe(validValue);
          }
        ),
        { numRuns: 50 }
      );
    });

    /**
     * **Validates: Requirements 10.4, 10.5, 10.6, 10.7**
     *
     * For any valid percentage (0-100), the config SHALL use that value.
     */
    it('uses provided valid percentages instead of defaults', () => {
      fc.assert(
        fc.property(
          validPercentage,
          (validPct) => {
            const env = {
              ...BASE_ENV,
              COPY_TP_PCT: validPct.toString(),
              COPY_SL_PCT: validPct.toString(),
              COPY_TRAIL_ACTIVATION_PCT: validPct.toString(),
              COPY_TRAIL_DISTANCE_PCT: validPct.toString(),
            };

            const config = loadCopyTradingConfig(env);

            expect(config.takeProfitPct).toBe(validPct);
            expect(config.stopLossPct).toBe(validPct);
            expect(config.trailActivationPct).toBe(validPct);
            expect(config.trailDistancePct).toBe(validPct);
          }
        ),
        { numRuns: 50 }
      );
    });

    /**
     * **Validates: Requirements 10.3**
     *
     * For any valid ratio (0-1), the config SHALL use that value.
     */
    it('uses provided valid ratios instead of defaults', () => {
      fc.assert(
        fc.property(
          validRatio,
          (ratio) => {
            const env = {
              ...BASE_ENV,
              COPY_RATIO: ratio.toString(),
            };

            const config = loadCopyTradingConfig(env);

            // Use approximate comparison due to floating point
            expect(config.copyRatio).toBeCloseTo(ratio, 10);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 33.4: Defaults match exported DEFAULTS constant
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 33.4: Exported defaults match requirements', () => {

    /**
     * **Validates: Requirements 10.1-10.11**
     *
     * The exported DEFAULTS constant SHALL match
     * the expected default values from requirements.
     */
    it('DEFAULTS constant matches requirements', () => {
      expect(DEFAULTS.COPY_INITIAL_CAPITAL_USDC).toBe(EXPECTED_DEFAULTS.COPY_INITIAL_CAPITAL_USDC);
      expect(DEFAULTS.COPY_MAX_POSITION_USDC).toBe(EXPECTED_DEFAULTS.COPY_MAX_POSITION_USDC);
      expect(DEFAULTS.COPY_RATIO).toBe(EXPECTED_DEFAULTS.COPY_RATIO);
      expect(DEFAULTS.COPY_TP_PCT).toBe(EXPECTED_DEFAULTS.COPY_TP_PCT);
      expect(DEFAULTS.COPY_SL_PCT).toBe(EXPECTED_DEFAULTS.COPY_SL_PCT);
      expect(DEFAULTS.COPY_TRAIL_ACTIVATION_PCT).toBe(EXPECTED_DEFAULTS.COPY_TRAIL_ACTIVATION_PCT);
      expect(DEFAULTS.COPY_TRAIL_DISTANCE_PCT).toBe(EXPECTED_DEFAULTS.COPY_TRAIL_DISTANCE_PCT);
      expect(DEFAULTS.COPY_TIME_STOP_HOURS).toBe(EXPECTED_DEFAULTS.COPY_TIME_STOP_HOURS);
      expect(DEFAULTS.COPY_MAX_GAS_GWEI).toBe(EXPECTED_DEFAULTS.COPY_MAX_GAS_GWEI);
      expect(DEFAULTS.COPY_MAX_LOSS_STREAK).toBe(EXPECTED_DEFAULTS.COPY_MAX_LOSS_STREAK);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 33.5: Idempotence - loading config twice produces same result
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 33.5: Configuration loading is idempotent', () => {

    /**
     * **Validates: Requirements 10.1-10.12**
     *
     * Loading configuration with the same env vars SHALL always
     * produce the same result.
     */
    it('loading config with same env vars produces identical results', () => {
      fc.assert(
        fc.property(
          fc.record({
            COPY_INITIAL_CAPITAL_USDC: fc.oneof(fc.constant(undefined), validPositiveNumber.map(String)),
            COPY_MAX_POSITION_USDC: fc.oneof(fc.constant(undefined), validPositiveNumber.map(String)),
            COPY_RATIO: fc.oneof(fc.constant(undefined), validRatio.map(String)),
            COPY_TP_PCT: fc.oneof(fc.constant(undefined), validPercentage.map(String)),
            COPY_SL_PCT: fc.oneof(fc.constant(undefined), validPercentage.map(String)),
            COPY_TRAIL_ACTIVATION_PCT: fc.oneof(fc.constant(undefined), validPercentage.map(String)),
            COPY_TRAIL_DISTANCE_PCT: fc.oneof(fc.constant(undefined), validPercentage.map(String)),
            COPY_TIME_STOP_HOURS: fc.oneof(fc.constant(undefined), validPositiveNumber.map(String)),
            COPY_MAX_GAS_GWEI: fc.oneof(fc.constant(undefined), validPositiveNumber.map(String)),
            COPY_MAX_LOSS_STREAK: fc.oneof(fc.constant(undefined), validPositiveNumber.map(String)),
          }),
          (envOverrides) => {
            // Filter out undefined values
            const cleanEnv: Record<string, string> = { ...BASE_ENV };
            for (const [key, value] of Object.entries(envOverrides)) {
              if (value !== undefined) {
                cleanEnv[key] = value;
              }
            }

            // Load config twice
            const config1 = loadCopyTradingConfig(cleanEnv);
            const config2 = loadCopyTradingConfig(cleanEnv);

            // Should be identical
            expect(config1.initialCapitalUsdc).toBe(config2.initialCapitalUsdc);
            expect(config1.maxPositionUsdc).toBe(config2.maxPositionUsdc);
            expect(config1.copyRatio).toBe(config2.copyRatio);
            expect(config1.takeProfitPct).toBe(config2.takeProfitPct);
            expect(config1.stopLossPct).toBe(config2.stopLossPct);
            expect(config1.trailActivationPct).toBe(config2.trailActivationPct);
            expect(config1.trailDistancePct).toBe(config2.trailDistancePct);
            expect(config1.timeStopHours).toBe(config2.timeStopHours);
            expect(config1.maxGasGwei).toBe(config2.maxGasGwei);
            expect(config1.maxLossStreak).toBe(config2.maxLossStreak);
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert env key to config property key
 */
function envKeyToConfigKey(envKey: string): string {
  const mapping: Record<string, string> = {
    'COPY_INITIAL_CAPITAL_USDC': 'initialCapitalUsdc',
    'COPY_MAX_POSITION_USDC': 'maxPositionUsdc',
    'COPY_RATIO': 'copyRatio',
    'COPY_TP_PCT': 'takeProfitPct',
    'COPY_SL_PCT': 'stopLossPct',
    'COPY_TRAIL_ACTIVATION_PCT': 'trailActivationPct',
    'COPY_TRAIL_DISTANCE_PCT': 'trailDistancePct',
    'COPY_TIME_STOP_HOURS': 'timeStopHours',
    'COPY_MAX_GAS_GWEI': 'maxGasGwei',
    'COPY_MAX_LOSS_STREAK': 'maxLossStreak',
  };
  return mapping[envKey] || envKey;
}
