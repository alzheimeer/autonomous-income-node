// Script para limpiar oportunidades de baja prioridad
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('./data/research.db');

// 1. Descartar oportunidades con score < 65
const result1 = db.prepare(`
  UPDATE opportunities 
  SET status = 'descartada', status_changed_at = ?
  WHERE status = 'new' AND score < 65
`).run(Date.now());

console.log('Descartadas por score < 65:', result1.changes);

// 2. Ver estado actual
const stats = db.prepare(`
  SELECT status, COUNT(*) as count 
  FROM opportunities 
  GROUP BY status 
  ORDER BY count DESC
`).all();

console.log('\nEstado actual:');
console.table(stats);

// 3. Ver las que quedan en "new"
const remaining = db.prepare(`
  SELECT source, category, COUNT(*) as count, ROUND(AVG(score), 1) as avg_score
  FROM opportunities 
  WHERE status = 'new'
  GROUP BY source, category
  ORDER BY count DESC
`).all();

console.log('\nOportunidades "new" restantes:');
console.table(remaining);

db.close();
