// Script para limpiar propuestas no viables
import Database from 'better-sqlite3';

const db = new Database('/app/data/research.db');

console.log('=== Limpieza de Propuestas No Viables ===\n');

// 1. Descartar todas las de DeFi/Trading con APY insostenible
const defiDiscarded = db.prepare(`
  UPDATE opportunities 
  SET status = 'descartada', 
      reasoning = 'APY insostenible (>500%) - alto riesgo de scam/rug pull' 
  WHERE status = 'new' AND category = 'trading'
`).run();
console.log('DeFi descartadas:', defiDiscarded.changes);

// 2. Descartar TikTok trending de deportes/celebridades (fuera de nicho)
const tiktokDiscarded = db.prepare(`
  UPDATE opportunities 
  SET status = 'descartada', 
      reasoning = 'Trending topic fuera de nicho AI - deportes/celebridades' 
  WHERE status = 'new' 
    AND source = 'tiktok-trends' 
    AND (title LIKE '%dodgers%' 
      OR title LIKE '%raiders%' 
      OR title LIKE '%sox%' 
      OR title LIKE '%hutchinson%' 
      OR title LIKE '%carrington%' 
      OR title LIKE '%patriot games%')
`).run();
console.log('TikTok deportes descartadas:', tiktokDiscarded.changes);

// 3. Descartar el tema sensible de Meta CSAM
const csamDiscarded = db.prepare(`
  UPDATE opportunities 
  SET status = 'descartada', 
      reasoning = 'Tema extremadamente sensible - no tocar' 
  WHERE status = 'new' 
    AND (title LIKE '%CSAM%' OR title LIKE '%Child Sexual%')
`).run();
console.log('CSAM descartada:', csamDiscarded.changes);

// 4. Descartar papers académicos sin monetización
const academicDiscarded = db.prepare(`
  UPDATE opportunities 
  SET status = 'descartada', 
      reasoning = 'Paper académico sin potencial de monetización directa' 
  WHERE status = 'new' 
    AND source_url LIKE '%arxiv.org%'
`).run();
console.log('Papers académicos descartados:', academicDiscarded.changes);

// 5. Descartar el de hobby programming vs LLM (opinion sin revenue)
const hobbyDiscarded = db.prepare(`
  UPDATE opportunities 
  SET status = 'descartada', 
      reasoning = 'Opinion piece sin potencial de monetización' 
  WHERE status = 'new' 
    AND title LIKE '%Born Against%'
`).run();
console.log('Hobby opinion descartada:', hobbyDiscarded.changes);

// Verificar estado final
console.log('\n=== Estado Final ===');
const final = db.prepare(`SELECT status, COUNT(*) as cnt FROM opportunities GROUP BY status`).all();
final.forEach(r => console.log(`${r.status}: ${r.cnt}`));

// Mostrar propuestas restantes
console.log('\n=== Propuestas "new" Restantes ===');
const remaining = db.prepare(`
  SELECT title, source, category, score 
  FROM opportunities 
  WHERE status = 'new' 
  ORDER BY score DESC
`).all();
console.log(`Total: ${remaining.length}`);
remaining.forEach((r, i) => {
  console.log(`${i+1}. [${r.score}] ${r.source}/${r.category}: ${r.title.substring(0,60)}...`);
});

db.close();
