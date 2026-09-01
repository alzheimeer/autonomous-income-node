// Check detailed rejection info from self_mod_history
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('./data/agent.db');

console.log('=== DETAILED Self-Mod History ===\n');

const records = db.prepare(`SELECT * FROM self_mod_history ORDER BY applied_at DESC`).all();

for (const rec of records) {
  console.log('━'.repeat(60));
  console.log(`📝 ID: ${rec.id}`);
  console.log(`📁 File: ${rec.file_path}`);
  console.log(`📊 Status: ${rec.status}`);
  console.log(`🕐 Applied: ${rec.applied_at ? new Date(rec.applied_at).toISOString() : 'N/A'}`);
  console.log(`🕐 Reverted: ${rec.reverted_at ? new Date(rec.reverted_at).toISOString() : 'N/A'}`);
  console.log(`💾 Backup: ${rec.backup_path}`);
  console.log('');
  console.log('📝 LLM Reasoning:');
  console.log(rec.llm_reasoning || 'N/A');
  console.log('');
  console.log('🔬 Sandbox Output:');
  console.log(rec.sandbox_output || 'N/A');
  console.log('');
  console.log('📜 Diff (first 500 chars):');
  console.log((rec.diff || 'N/A').slice(0, 500));
  console.log('');
}

db.close();
