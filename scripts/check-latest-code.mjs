import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('./data/agent.db', { open: true });

console.log('=== Most Recent Generated Code (from diff) ===\n');

try {
  const row = db.prepare(`
    SELECT id, file_path, diff, sandbox_output
    FROM self_mod_history 
    ORDER BY rowid DESC 
    LIMIT 1
  `).get();
  
  if (row) {
    console.log(`ID: ${row.id}`);
    console.log(`File: ${row.file_path}`);
    console.log(`\n--- Generated Code (from diff) ---\n`);
    
    // The diff contains the new code - extract it
    const diff = row.diff || '';
    // If it's a unified diff, extract just the + lines
    if (diff.includes('@@')) {
      const lines = diff.split('\n').filter(l => l.startsWith('+')).map(l => l.slice(1));
      console.log(lines.join('\n'));
    } else {
      console.log(diff);
    }
    
    console.log(`\n--- Sandbox Output ---`);
    console.log(row.sandbox_output || 'N/A');
  }
} catch (e) {
  console.log('Error:', e.message);
}

db.close();
