// Check self-modification history
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('./data/agent.db');

// First get table structure
const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='self_mod_history'`).get();
console.log('Self-mod table schema:');
console.log(schema?.sql || 'Not found');
console.log('');

console.log('=== Self-Modification History ===\n');

const records = db.prepare(`SELECT * FROM self_mod_history ORDER BY applied_at DESC LIMIT 20`).all();

if (records.length === 0) {
  console.log('No self-modification records found.');
} else {
  for (const rec of records) {
    console.log(`📝 ID: ${rec.id}`);
    console.log(`   File: ${rec.file_path}`);
    console.log(`   Status: ${rec.status}`);
    console.log(`   Triggered by: ${rec.triggered_by || 'N/A'}`);
    console.log(`   Applied at: ${rec.applied_at ? new Date(rec.applied_at).toISOString() : 'N/A'}`);
    console.log(`   Reasoning: ${rec.llm_reasoning?.slice(0, 100) || 'N/A'}...`);
    console.log('');
  }
}

console.log('\n=== Knowledge Base Stats ===\n');

const kbStats = db.prepare(`
  SELECT status, COUNT(*) as count 
  FROM knowledge_base 
  GROUP BY status
`).all();

console.log('Knowledge entries by status:');
for (const s of kbStats) {
  console.log(`  ${s.status}: ${s.count}`);
}

// Check for integrated entries
const integrated = db.prepare(`
  SELECT protocol_name, type, viability_score 
  FROM knowledge_base 
  WHERE status = 'integrated'
  LIMIT 10
`).all();

if (integrated.length > 0) {
  console.log('\n📦 Integrated opportunities:');
  for (const i of integrated) {
    console.log(`  - ${i.protocol_name} (${i.type}, score: ${i.viability_score})`);
  }
}

db.close();
