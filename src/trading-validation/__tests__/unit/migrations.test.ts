/**
 * Unit tests for Trading Validation Migrations
 *
 * Validates that runMigrations creates all expected tables and indexes,
 * is idempotent, and performs an integrity check on startup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type TradingDatabase } from '../../db.js';
import { runMigrations } from '../../migrations.js';

describe('runMigrations', () => {
  let db: TradingDatabase;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.pragma('journal_mode = WAL');
  });

  afterEach(() => {
    db.close();
  });

  it('creates all 11 tables', () => {
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('trading_phase');
    expect(tableNames).toContain('bankroll');
    expect(tableNames).toContain('tx_intents');
    expect(tableNames).toContain('positions');
    expect(tableNames).toContain('quotes_log');
    expect(tableNames).toContain('reconciliation_log');
    expect(tableNames).toContain('approvals');
    expect(tableNames).toContain('daily_metrics');
    expect(tableNames).toContain('nonce_registry');
    expect(tableNames).toContain('event_log');
    expect(tableNames).toContain('operator_commands');
  });

  it('creates all expected indexes', () => {
    runMigrations(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain('idx_tx_intents_nonce');
    expect(indexNames).toContain('idx_tx_intents_state');
    expect(indexNames).toContain('idx_positions_open');
    expect(indexNames).toContain('idx_positions_mode');
    expect(indexNames).toContain('idx_reconciliation_timestamp');
    expect(indexNames).toContain('idx_event_log_type');
  });

  it('is idempotent (can run multiple times without error)', () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('trading_phase table has correct schema', () => {
    runMigrations(db);

    const now = Date.now();
    db.prepare(`
      INSERT INTO trading_phase (id, mode, config_hash, started_at, updated_at)
      VALUES (1, 'shadow', 'abc123', ?, ?)
    `).run(now, now);

    const row = db.prepare('SELECT * FROM trading_phase WHERE id = 1').get() as Record<string, unknown>;
    expect(row.mode).toBe('shadow');
    expect(row.config_hash).toBe('abc123');
    expect(row.safe_mode).toBe(0);
    expect(row.low_cost_mode).toBe(0);
    expect(row.kill_switch_triggered).toBe(0);
    expect(row.auto_lender_disabled).toBe(0);
  });

  it('trading_phase rejects invalid mode', () => {
    runMigrations(db);

    const now = Date.now();
    expect(() => {
      db.prepare(`
        INSERT INTO trading_phase (id, mode, config_hash, started_at, updated_at)
        VALUES (1, 'invalid', 'abc', ?, ?)
      `).run(now, now);
    }).toThrow();
  });

  it('bankroll table stores BigInt as TEXT', () => {
    runMigrations(db);

    const now = Date.now();
    db.prepare(`
      INSERT INTO bankroll (id, total_usdc, active_usdc, reserve_usdc, day_start_bankroll, day_utc, updated_at)
      VALUES (1, '99630000', '25000000', '74630000', '99630000', '2025-01-01', ?)
    `).run(now);

    const row = db.prepare('SELECT * FROM bankroll WHERE id = 1').get() as Record<string, unknown>;
    expect(row.total_usdc).toBe('99630000');
    expect(row.active_usdc).toBe('25000000');
    expect(row.reserve_usdc).toBe('74630000');
    expect(row.daily_realized_pnl).toBe('0');
    expect(row.daily_gas_spent).toBe('0');
    expect(row.experiment_total_pnl).toBe('0');
  });

  it('tx_intents table validates state values', () => {
    runMigrations(db);

    const now = Date.now();

    // Valid state
    expect(() => {
      db.prepare(`
        INSERT INTO tx_intents (id, state, nonce, contract_address, function_name, gas_limit, created_at, updated_at, operation_type)
        VALUES ('intent-1', 'created', 0, '0xABC', 'swap', '100000', ?, ?, 'entry')
      `).run(now, now);
    }).not.toThrow();

    // Invalid state
    expect(() => {
      db.prepare(`
        INSERT INTO tx_intents (id, state, nonce, contract_address, function_name, gas_limit, created_at, updated_at, operation_type)
        VALUES ('intent-2', 'invalid_state', 1, '0xABC', 'swap', '100000', ?, ?, 'entry')
      `).run(now, now);
    }).toThrow();
  });

  it('positions table enforces mode constraint', () => {
    runMigrations(db);

    const now = Date.now();

    // Insert a tx_intent first (foreign key)
    db.prepare(`
      INSERT INTO tx_intents (id, state, nonce, contract_address, function_name, gas_limit, created_at, updated_at, operation_type)
      VALUES ('intent-pos', 'confirmed', 0, '0xABC', 'swap', '100000', ?, ?, 'entry')
    `).run(now, now);

    // Valid mode
    expect(() => {
      db.prepare(`
        INSERT INTO positions (id, intent_id, mode, strategy, entry_price, entry_timestamp, size_usdc, size_weth, stop_loss, take_profit, max_holding_ms, entry_regime, config_hash)
        VALUES ('pos-1', 'intent-pos', 'shadow', 'trend_pullback', 3500.0, ?, '5000000', '1400000000000000', 3450.0, 3600.0, 28800000, 'TRENDING_UP', 'hash123')
      `).run(now);
    }).not.toThrow();

    // Invalid mode
    expect(() => {
      db.prepare(`
        INSERT INTO positions (id, intent_id, mode, strategy, entry_price, entry_timestamp, size_usdc, size_weth, stop_loss, take_profit, max_holding_ms, entry_regime, config_hash)
        VALUES ('pos-2', 'intent-pos', 'invalid_mode', 'trend_pullback', 3500.0, ?, '5000000', '1400000000000000', 3450.0, 3600.0, 28800000, 'TRENDING_UP', 'hash123')
      `).run(now);
    }).toThrow();
  });

  it('quotes_log direction constraint works', () => {
    runMigrations(db);

    const now = Date.now();

    expect(() => {
      db.prepare(`
        INSERT INTO quotes_log (source, direction, amount_in, amount_out, timestamp)
        VALUES ('quoter_v2', 'entry', '5000000', '1400000000000000', ?)
      `).run(now);
    }).not.toThrow();

    expect(() => {
      db.prepare(`
        INSERT INTO quotes_log (source, direction, amount_in, amount_out, timestamp)
        VALUES ('quoter_v2', 'invalid', '5000000', '1400000000000000', ?)
      `).run(now);
    }).toThrow();
  });

  it('nonce_registry enforces single-row constraint', () => {
    runMigrations(db);

    const now = Date.now();

    db.prepare(`
      INSERT INTO nonce_registry (id, last_confirmed_nonce, next_nonce, updated_at)
      VALUES (1, 0, 1, ?)
    `).run(now);

    // Second row with id != 1 should fail due to CHECK constraint
    expect(() => {
      db.prepare(`
        INSERT INTO nonce_registry (id, last_confirmed_nonce, next_nonce, updated_at)
        VALUES (2, 0, 1, ?)
      `).run(now);
    }).toThrow();
  });

  it('event_log stores JSON details', () => {
    runMigrations(db);

    const now = Date.now();
    const details = JSON.stringify({ trigger: 'gas_critical', ethBalance: '0.001' });

    db.prepare(`
      INSERT INTO event_log (event_type, details, timestamp)
      VALUES ('safe_mode_entered', ?, ?)
    `).run(details, now);

    const row = db.prepare('SELECT * FROM event_log WHERE id = 1').get() as Record<string, unknown>;
    expect(row.event_type).toBe('safe_mode_entered');
    expect(JSON.parse(row.details as string)).toEqual({ trigger: 'gas_critical', ethBalance: '0.001' });
  });

  it('operator_commands records commands', () => {
    runMigrations(db);

    const now = Date.now();

    db.prepare(`
      INSERT INTO operator_commands (command, source, chat_id, authorized, timestamp)
      VALUES ('exit_safe_mode', 'telegram', '12345', 1, ?)
    `).run(now);

    const row = db.prepare('SELECT * FROM operator_commands WHERE id = 1').get() as Record<string, unknown>;
    expect(row.command).toBe('exit_safe_mode');
    expect(row.source).toBe('telegram');
    expect(row.chat_id).toBe('12345');
    expect(row.authorized).toBe(1);
  });

  it('daily_metrics uses day_utc as primary key', () => {
    runMigrations(db);

    db.prepare(`
      INSERT INTO daily_metrics (day_utc) VALUES ('2025-01-15')
    `).run();

    const row = db.prepare("SELECT * FROM daily_metrics WHERE day_utc = '2025-01-15'").get() as Record<string, unknown>;
    expect(row.trades_count).toBe(0);
    expect(row.total_gas_usd).toBe('0');
    expect(row.total_pnl).toBe('0');

    // Duplicate key should fail
    expect(() => {
      db.prepare(`INSERT INTO daily_metrics (day_utc) VALUES ('2025-01-15')`).run();
    }).toThrow();
  });

  it('reconciliation_log references tx_intents', () => {
    runMigrations(db);

    const now = Date.now();

    // Insert referenced intent
    db.prepare(`
      INSERT INTO tx_intents (id, state, nonce, contract_address, function_name, gas_limit, created_at, updated_at, operation_type)
      VALUES ('intent-recon', 'confirmed', 5, '0xABC', 'swap', '100000', ?, ?, 'entry')
    `).run(now, now);

    expect(() => {
      db.prepare(`
        INSERT INTO reconciliation_log (operation_type, intent_id, expected_usdc, actual_usdc, expected_weth, actual_weth, deviation_usdc, matched, timestamp)
        VALUES ('entry', 'intent-recon', '5000000', '4990000', '0', '0', '10000', 1, ?)
      `).run(now);
    }).not.toThrow();
  });

  it('approvals table stores token approval records', () => {
    runMigrations(db);

    const now = Date.now();

    db.prepare(`
      INSERT INTO approvals (token, spender, amount, tx_hash, timestamp)
      VALUES ('0xUSDC', '0xSwapRouter', '5000000', '0xhash123', ?)
    `).run(now);

    const row = db.prepare('SELECT * FROM approvals WHERE id = 1').get() as Record<string, unknown>;
    expect(row.token).toBe('0xUSDC');
    expect(row.spender).toBe('0xSwapRouter');
    expect(row.amount).toBe('5000000');
    expect(row.revoked).toBe(0);
  });
});
