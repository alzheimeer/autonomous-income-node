import { Client } from 'pg';

async function run() {
  const client = new Client({
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: 'postgres', // default timescale image password
    database: 'ain_trading',
  });

  try {
    await client.connect();
    
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
      
      CREATE TABLE IF NOT EXISTS event_log (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(100) NOT NULL,
        event_data JSONB,
        timestamp BIGINT NOT NULL
      );
    `);
    
    console.log('Postgres schema initialized successfully');
  } catch (err) {
    console.error('Error initializing schema:', err);
  } finally {
    await client.end();
  }
}

run();
