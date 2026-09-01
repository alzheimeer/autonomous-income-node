import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('./data/agent.db', { open: true });

console.log('=== 3 Most Recent Self-Mod Attempts (by rowid) ===\n');

try {
  const rows = db.prepare(`
    SELECT id, file_path, status, sandbox_output, llm_reasoning
    FROM self_mod_history 
    ORDER BY rowid DESC 
    LIMIT 3
  `).all();
  
  rows.forEach((r, i) => {
    console.log(`[${i + 1}] ID: ${r.id}`);
    console.log(`    File: ${r.file_path}`);
    console.log(`    Status: ${r.status}`);
    console.log(`    Reasoning: ${(r.llm_reasoning || '').substring(0, 100)}...`);
    console.log(`    Sandbox Output:`);
    console.log(`    ${r.sandbox_output || 'N/A'}`);
    console.log('---');
  });
} catch (e) {
  console.log('Error:', e.message);
}

db.close();
