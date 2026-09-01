import { Pool } from 'pg';

/**
 * Cerebro Analítico (PostgreSQL + TimescaleDB)
 * 
 * Este pool maneja todas las operaciones asíncronas masivas (HFT):
 * - shadow_positions
 * - event_log
 * - tx_intents (historial)
 * - price_ticks
 */

export const pgPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'ain_trading',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Configurar zona horaria en cada nueva conexión
pgPool.on('connect', (client) => {
  // Usar callback para evitar el DeprecationWarning de pg@8 con query() anidado
  client.query('SET TIME ZONE UTC', (err) => {
    if (err) console.error('[pgPool] Failed to set timezone:', err.message);
  });
});

pgPool.on('error', (err) => {
  console.error('Error inesperado en PostgreSQL:', err);
});

export async function initPostgresSchema() {
  const client = await pgPool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS sniper_signals (
        id SERIAL,
        signal_id VARCHAR(255) NOT NULL,
        contract_address VARCHAR(255) NOT NULL,
        ticker VARCHAR(50) NOT NULL,
        source VARCHAR(50) NOT NULL,
        ingestion_time BIGINT NOT NULL,
        validated_at BIGINT NOT NULL,
        total_latency_ms INTEGER NOT NULL,
        passed SMALLINT NOT NULL,
        reject_reason TEXT,
        result TEXT,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (id, created_at)
      );

      -- Create TimescaleDB hypertable
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'sniper_signals'
        ) THEN
          PERFORM create_hypertable('sniper_signals', 'created_at', chunk_time_interval => 86400000);
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_signals_contract ON sniper_signals(contract_address, ingestion_time DESC);
      CREATE INDEX IF NOT EXISTS idx_signals_created ON sniper_signals(created_at DESC);

      CREATE TABLE IF NOT EXISTS shadow_positions (
        id VARCHAR(255) PRIMARY KEY,
        signal_id VARCHAR(255) NOT NULL,
        contract_address VARCHAR(255) NOT NULL,
        entry_price TEXT NOT NULL,
        take_profit TEXT NOT NULL,
        stop_loss TEXT NOT NULL,
        time_stop BIGINT NOT NULL,
        trade_size TEXT NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'OPEN',
        opened_at BIGINT NOT NULL,
        closed_at BIGINT,
        exit_price TEXT,
        pnl_usdc REAL,
        created_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_positions_status ON shadow_positions(status, opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_positions_contract ON shadow_positions(contract_address);

      CREATE TABLE IF NOT EXISTS alert_events (
        id                TEXT             NOT NULL PRIMARY KEY,
        contract_address  TEXT             NOT NULL,
        severity          TEXT             NOT NULL,
        reason            TEXT             NOT NULL,
        detected_at       BIGINT           NOT NULL,
        position_id       TEXT             NOT NULL,
        pnl_usdc          DOUBLE PRECISION,
        transaction_hash  TEXT,
        created_at        BIGINT           NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_alert_events_contract
        ON alert_events (contract_address, detected_at DESC);

      CREATE INDEX IF NOT EXISTS idx_alert_events_position
        ON alert_events (position_id);

      CREATE TABLE IF NOT EXISTS event_log (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(100) NOT NULL,
        event_data JSONB,
        timestamp BIGINT NOT NULL
      );
    `);
    console.log('✅ Tablas PostgreSQL inicializadas correctamente.');
  } catch (error) {
    console.error('❌ Error inicializando tablas Postgres:', error);
  } finally {
    client.release();
  }
}

// Inicializar automáticamente las tablas al importar el módulo
initPostgresSchema().catch(console.error);

