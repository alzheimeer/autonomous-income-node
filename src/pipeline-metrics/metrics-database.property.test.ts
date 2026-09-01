/**
 * Property-Based Tests for MetricsDatabase
 *
 * Property 2: Event Recording Persists All Required Fields
 * - Generate arbitrary `PipelineEventType` and JSON-serializable details
 * - Verify persisted row matches input exactly (timestamp, event_type, details JSON round-trip, session_id)
 * - **Validates: Requirements 2.1, 2.2**
 *
 * Property 17: BigInt Persistence Round-Trip
 * - Tests that BigInt values stored as TEXT in `backtest_trades` can be read back without loss
 * - **Validates: Requirements 15.3**
 *
 * Uses Vitest + fast-check.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { createMetricsDatabase, MetricsDatabase, type PipelineEventType } from './metrics-database.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/**
 * All 18 valid PipelineEventType values as defined in requirements.md
 */
const ALL_EVENT_TYPES: PipelineEventType[] = [
  'evaluation_started',
  'evaluation_skipped_mutex',
  'evaluation_skipped_not_running',
  'evaluation_skipped_cannot_evaluate',
  'indicators_unavailable',
  'indicators_computed',
  'strategy_no_signal',
  'strategy_signal_generated',
  'daily_loss_limit_hit',
  'position_sizing_rejected',
  'position_sized',
  'bankroll_insufficient',
  'bankroll_approved',
  'aave_funds_unavailable',
  'aave_funds_secured',
  'gate_rejected',
  'gate_passed',
  'trade_executed',
];

// ═══════════════════════════════════════════════════════════════════════════
// Generators
// ═══════════════════════════════════════════════════════════════════════════

/** Generate arbitrary PipelineEventType from all 18 valid types */
const eventTypeArb: fc.Arbitrary<PipelineEventType> = fc.constantFrom(...ALL_EVENT_TYPES);

/** Generate valid Unix timestamp in milliseconds (2020-01-01 to 2030-01-01) */
const timestampArb: fc.Arbitrary<number> = fc.integer({
  min: 1577836800000,
  max: 1893456000000,
});

/** Generate valid session ID (UUID-like string) */
const sessionIdArb: fc.Arbitrary<string> = fc.uuid();

/** Generate JSON-serializable primitive values */
const jsonPrimitiveArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.boolean(),
  fc.constant(null),
);

/** Generate valid JSON object keys */
const jsonKeyArb = fc.string({ minLength: 1, maxLength: 20 })
  .filter(s => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s));

/** Generate JSON-serializable details object (nested up to 2 levels) */
const jsonDetailsArb: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  jsonKeyArb,
  fc.oneof(
    jsonPrimitiveArb,
    fc.array(jsonPrimitiveArb, { maxLength: 5 }),
    fc.dictionary(
      jsonKeyArb.filter(s => s.length <= 10),
      jsonPrimitiveArb,
      { minKeys: 0, maxKeys: 3 },
    ),
  ),
  { minKeys: 0, maxKeys: 5 },
);

// ═══════════════════════════════════════════════════════════════════════════
// Property 2: Event Recording Persists All Required Fields
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 2: Event Recording Persists All Required Fields', () => {
  /**
   * **Validates: Requirements 2.1, 2.2**
   *
   * For ANY valid event type, timestamp, details object, and session ID,
   * the event SHALL be persisted and retrieved with all fields exactly matching.
   */
  it('persisted event matches input exactly for all required fields', () => {
    fc.assert(
      fc.property(
        eventTypeArb,
        timestampArb,
        jsonDetailsArb,
        sessionIdArb,
        (eventType, timestamp, details, sessionId) => {
          // Create fresh DB for each iteration to ensure isolation
          const db = createMetricsDatabase(':memory:');
          try {
            // Insert the event
            const insertedId = db.insertEvent(timestamp, eventType, details, sessionId);

            // Verify insert succeeded
            expect(insertedId).toBeGreaterThan(0);

            // Query the event back (most recent first)
            const events = db.queryEvents({ limit: 1 });
            expect(events.length).toBe(1);

            const retrieved = events[0];

            // Verify all fields match exactly
            expect(retrieved.id).toBe(insertedId);
            expect(retrieved.timestamp).toBe(timestamp);
            expect(retrieved.event_type).toBe(eventType);
            expect(retrieved.session_id).toBe(sessionId);

            // Verify JSON round-trip: details should deeply equal input
            expect(retrieved.details).toEqual(details);
          } finally {
            db.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 2.1, 2.2**
   *
   * For ANY sequence of events with different types and details,
   * all events SHALL be persisted and retrievable without data loss.
   */
  it('multiple events with different types are all persisted correctly', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(eventTypeArb, timestampArb, jsonDetailsArb, sessionIdArb),
          { minLength: 1, maxLength: 10 },
        ),
        (eventInputs) => {
          // Create fresh DB for each iteration
          const db = createMetricsDatabase(':memory:');
          try {
            const insertedIds: number[] = [];

            // Insert all events
            for (const [eventType, timestamp, details, sessionId] of eventInputs) {
              const id = db.insertEvent(timestamp, eventType, details, sessionId);
              expect(id).toBeGreaterThan(0);
              insertedIds.push(id);
            }

            // Query all events back
            const events = db.queryEvents({ limit: eventInputs.length + 10 });
            expect(events.length).toBe(eventInputs.length);

            // Verify each event matches its input (find by ID since order may vary)
            for (let i = 0; i < eventInputs.length; i++) {
              const [eventType, timestamp, details, sessionId] = eventInputs[i];
              const insertedId = insertedIds[i];

              const retrieved = events.find(e => e.id === insertedId);
              expect(retrieved).toBeDefined();

              expect(retrieved!.timestamp).toBe(timestamp);
              expect(retrieved!.event_type).toBe(eventType);
              expect(retrieved!.session_id).toBe(sessionId);
              expect(retrieved!.details).toEqual(details);
            }
          } finally {
            db.close();
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * **Validates: Requirements 2.2**
   *
   * Complex nested details objects should survive JSON round-trip.
   */
  it('complex nested details objects round-trip correctly', () => {
    fc.assert(
      fc.property(
        eventTypeArb,
        timestampArb,
        sessionIdArb,
        fc.record({
          indicators: fc.record({
            rsi14: fc.double({ noNaN: true, noDefaultInfinity: true, min: 0, max: 100 }),
            ema20: fc.double({ noNaN: true, noDefaultInfinity: true, min: 0, max: 10000 }),
            volumeZScore: fc.double({ noNaN: true, noDefaultInfinity: true, min: -5, max: 5 }),
          }),
          regime: fc.constantFrom('TRENDING_UP', 'TRENDING_DOWN', 'RANGING', 'VOLATILE', 'UNCERTAIN'),
          nearMisses: fc.array(
            fc.record({
              indicator: fc.string({ minLength: 1, maxLength: 20 }),
              actual: fc.double({ noNaN: true, noDefaultInfinity: true }),
              threshold: fc.double({ noNaN: true, noDefaultInfinity: true }),
            }),
            { maxLength: 3 },
          ),
          metadata: fc.record({
            candidateId: fc.uuid(),
            strategy: fc.constantFrom('trend_pullback', 'mean_reversion'),
            processed: fc.boolean(),
          }),
        }),
        (eventType, timestamp, sessionId, complexDetails) => {
          // Create fresh DB for each iteration
          const db = createMetricsDatabase(':memory:');
          try {
            const insertedId = db.insertEvent(
              timestamp,
              eventType,
              complexDetails as Record<string, unknown>,
              sessionId,
            );

            expect(insertedId).toBeGreaterThan(0);

            const events = db.queryEvents({ limit: 1 });
            expect(events.length).toBe(1);

            const retrieved = events[0];
            expect(retrieved.details).toEqual(complexDetails);
          } finally {
            db.close();
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * **Validates: Requirements 2.1**
   *
   * All 18 event types should be accepted and stored correctly.
   */
  it('all 18 event types are accepted and stored', () => {
    const db = createMetricsDatabase(':memory:');
    try {
      const sessionId = 'test-session-all-types';
      const timestamp = Date.now();

      for (const eventType of ALL_EVENT_TYPES) {
        const details = { type: eventType, test: true };
        const id = db.insertEvent(timestamp, eventType, details, sessionId);
        expect(id).toBeGreaterThan(0);

        const events = db.queryEvents({ eventType, limit: 1 });
        expect(events.length).toBe(1);
        expect(events[0].event_type).toBe(eventType);
        expect(events[0].details).toEqual(details);
      }

      // Verify we have all 18 events
      const allEvents = db.queryEvents({ limit: 100 });
      expect(allEvents.length).toBe(18);
    } finally {
      db.close();
    }
  });

  /**
   * **Validates: Requirements 2.2**
   *
   * Empty details object should be stored and retrieved correctly.
   */
  it('empty details object is persisted correctly', () => {
    fc.assert(
      fc.property(
        eventTypeArb,
        timestampArb,
        sessionIdArb,
        (eventType, timestamp, sessionId) => {
          // Create fresh DB for each iteration
          const db = createMetricsDatabase(':memory:');
          try {
            const emptyDetails: Record<string, unknown> = {};

            const insertedId = db.insertEvent(timestamp, eventType, emptyDetails, sessionId);
            expect(insertedId).toBeGreaterThan(0);

            const events = db.queryEvents({ limit: 1 });
            expect(events.length).toBe(1);
            expect(events[0].details).toEqual({});
          } finally {
            db.close();
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  /**
   * **Validates: Requirements 2.2**
   *
   * Unicode strings in details should be preserved.
   */
  it('unicode strings in details are preserved', () => {
    fc.assert(
      fc.property(
        eventTypeArb,
        timestampArb,
        sessionIdArb,
        fc.unicodeString({ minLength: 1, maxLength: 100 }),
        (eventType, timestamp, sessionId, unicodeValue) => {
          // Create fresh DB for each iteration
          const db = createMetricsDatabase(':memory:');
          try {
            const details = { message: unicodeValue, emoji: '🚀📊💰' };

            const insertedId = db.insertEvent(timestamp, eventType, details, sessionId);
            expect(insertedId).toBeGreaterThan(0);

            const events = db.queryEvents({ limit: 1 });
            expect(events.length).toBe(1);
            expect(events[0].details).toEqual(details);
          } finally {
            db.close();
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 17: BigInt Persistence Round-Trip
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 17: BigInt Persistence Round-Trip', () => {
  let db: MetricsDatabase;

  beforeEach(() => {
    db = createMetricsDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  /**
   * Property: arbitrary BigInt values stored as TEXT in backtest_trades
   * round-trip correctly.
   *
   * - Generate arbitrary BigInt values (both positive and negative)
   * - Store as TEXT via insertBacktestTrade (size_usdc, pnl_usdc)
   * - Read back via queryBacktestTrades
   * - Verify original value is recovered exactly
   *
   * **Validates: Requirements 15.3**
   */
  it('BigInt values stored as TEXT round-trip exactly', () => {
    fc.assert(
      fc.property(
        // Generate arbitrary BigInt values, including negative for pnl
        fc.bigInt({ min: 0n, max: 10_000_000_000_000n }), // size_usdc (positive)
        fc.bigInt({ min: -10_000_000_000_000n, max: 10_000_000_000_000n }), // pnl_usdc (can be negative)
        (sizeUsdc, pnlUsdc) => {
          // Create a backtest run first (required for foreign key)
          const runId = db.insertBacktestRun(
            Date.now(),
            30, // days_simulated
            1,  // total_trades
            0.5, // win_rate
            1.5, // profit_factor
            10.0, // max_drawdown_pct
            '1000000', // total_pnl_usdc
            'POSITIVE_EXPECTANCY',
            'abc123',
            1000,
          );
          expect(runId).toBeGreaterThan(0);

          // Store BigInt values as TEXT strings
          const sizeUsdcStr = sizeUsdc.toString();
          const pnlUsdcStr = pnlUsdc.toString();

          const tradeId = db.insertBacktestTrade(
            runId,
            1700000000000, // entry_time
            1700001000000, // exit_time
            2500.0,        // entry_price
            2510.0,        // exit_price
            sizeUsdcStr,
            pnlUsdcStr,
            'trend_pullback',
            'TRENDING_UP',
            'take_profit',
          );
          expect(tradeId).toBeGreaterThan(0);

          // Read back from database
          const trades = db.queryBacktestTrades({ runId, limit: 1 });
          expect(trades).toHaveLength(1);

          const trade = trades[0];

          // Convert TEXT back to BigInt and verify round-trip
          const recoveredSizeUsdc = BigInt(trade.size_usdc);
          const recoveredPnlUsdc = BigInt(trade.pnl_usdc);

          expect(recoveredSizeUsdc).toBe(sizeUsdc);
          expect(recoveredPnlUsdc).toBe(pnlUsdc);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * Property: Edge cases for BigInt round-trip
   *
   * - Zero values
   * - Large positive values near JS Number.MAX_SAFE_INTEGER
   * - Large negative values
   * - Boundary values for 6-decimal USDC precision
   *
   * **Validates: Requirements 15.3**
   */
  it('BigInt round-trip handles edge cases correctly', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // Zero
          fc.constant(0n),
          // Small positive values
          fc.bigInt({ min: 1n, max: 1000n }),
          // Typical USDC values (6 decimals): $1 = 1_000_000
          fc.bigInt({ min: 1_000_000n, max: 1_000_000_000n }), // $1 to $1000
          // Large values that exceed Number.MAX_SAFE_INTEGER
          fc.bigInt({ min: BigInt(Number.MAX_SAFE_INTEGER) + 1n, max: BigInt(Number.MAX_SAFE_INTEGER) * 10n }),
          // Negative values (for P&L)
          fc.bigInt({ min: -1_000_000_000n, max: -1n }),
        ),
        (value) => {
          const runId = db.insertBacktestRun(
            Date.now(),
            7,
            1,
            0.5,
            1.0,
            5.0,
            value.toString(),
            'BREAKEVEN',
            'hash123',
            500,
          );
          expect(runId).toBeGreaterThan(0);

          const valueStr = value.toString();

          const tradeId = db.insertBacktestTrade(
            runId,
            1700000000000,
            1700001000000,
            2000.0,
            2005.0,
            valueStr, // Use same value for size_usdc
            valueStr, // Use same value for pnl_usdc
            'mean_reversion',
            'RANGING',
            'stop_loss',
          );
          expect(tradeId).toBeGreaterThan(0);

          const trades = db.queryBacktestTrades({ runId, limit: 1 });
          expect(trades).toHaveLength(1);

          const trade = trades[0];

          // Verify exact round-trip
          expect(BigInt(trade.size_usdc)).toBe(value);
          expect(BigInt(trade.pnl_usdc)).toBe(value);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property: Multiple trades with different BigInt values in the same run
   * all round-trip correctly.
   *
   * **Validates: Requirements 15.3**
   */
  it('Multiple BigInt values in same run round-trip correctly', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            sizeUsdc: fc.bigInt({ min: 1_000_000n, max: 100_000_000n }), // $1 to $100
            pnlUsdc: fc.bigInt({ min: -5_000_000n, max: 5_000_000n }),   // -$5 to +$5
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (trades) => {
          const runId = db.insertBacktestRun(
            Date.now(),
            14,
            trades.length,
            0.6,
            1.3,
            15.0,
            '5000000',
            'POSITIVE_EXPECTANCY',
            'multitrade123',
            2000,
          );
          expect(runId).toBeGreaterThan(0);

          // Insert all trades
          const insertedIds: number[] = [];
          for (let i = 0; i < trades.length; i++) {
            const trade = trades[i];
            const tradeId = db.insertBacktestTrade(
              runId,
              1700000000000 + i * 1000000, // Staggered entry times
              1700000500000 + i * 1000000, // Staggered exit times
              2500.0 + i,
              2500.0 + i + (Number(trade.pnlUsdc) > 0 ? 10 : -10),
              trade.sizeUsdc.toString(),
              trade.pnlUsdc.toString(),
              'trend_pullback',
              'TRENDING_UP',
              i % 2 === 0 ? 'take_profit' : 'stop_loss',
            );
            expect(tradeId).toBeGreaterThan(0);
            insertedIds.push(tradeId);
          }

          // Query all trades for this run
          const queriedTrades = db.queryBacktestTrades({ runId, limit: 100 });
          expect(queriedTrades).toHaveLength(trades.length);

          // Verify each trade's BigInt values (trades come back in reverse order by id)
          const sortedQueriedTrades = [...queriedTrades].sort((a, b) => a.id - b.id);

          for (let i = 0; i < trades.length; i++) {
            const original = trades[i];
            const queried = sortedQueriedTrades[i];

            expect(BigInt(queried.size_usdc)).toBe(original.sizeUsdc);
            expect(BigInt(queried.pnl_usdc)).toBe(original.pnlUsdc);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
