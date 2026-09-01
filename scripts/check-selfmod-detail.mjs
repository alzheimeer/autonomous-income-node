// Check self_mod_history for detailed sandbox output
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('./data/agent.db', { open: true });

// First get schema
console.log('=== Table Schema ===\n');
const schemaRows = db.prepare(`PRAGMA table_info(self_mod_history)`).all();
for (const col of schemaRows) {
  console.log(`  ${col.name}: ${col.type}`);
}

// Then get recent rows
console.log('\n=== Recent Self-Mod Attempts ===\n');
const rows = db.prepare(`
  SELECT *
  FROM self_mod_history
  ORDER BY rowid DESC
  LIMIT 5
`).all();

for (const row of rows) {
  console.log(`ID: ${row.id}`);
  console.log(`File: ${row.file_path}`);
  console.log(`Status: ${row.status}`);
  console.log(`Sandbox Output:\n${row.sandbox_output || '(empty)'}`);
  console.log('-'.repeat(80));
}

db.close();
