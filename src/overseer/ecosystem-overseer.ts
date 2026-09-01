import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class EcosystemOverseer {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  public async evaluateEcosystem(): Promise<string> {
    console.log('[EcosystemOverseer] Evaluando el estado global de la empresa...');
    
    // 1. Conectar a OmniAI-Engine
    const omniDbPath = path.resolve(__dirname, '../../../OmniAI-Engine/content/database.sqlite');
    let omniStats = { totalViews: 0, totalLikes: 0, totalComments: 0, videoCount: 0 };
    
    if (fs.existsSync(omniDbPath)) {
      try {
        const db = new Database(omniDbPath, { readonly: true });
        const row = db.prepare('SELECT SUM(views) as v, SUM(likes) as l, SUM(comments) as c, COUNT(id) as count FROM published_videos').get() as any;
        omniStats = {
          totalViews: row.v || 0,
          totalLikes: row.l || 0,
          totalComments: row.c || 0,
          videoCount: row.count || 0,
        };
        db.close();
        console.log(`[EcosystemOverseer] OmniAI: ${omniStats.videoCount} videos, ${omniStats.totalViews} vistas.`);
      } catch (err) {
        console.warn('[EcosystemOverseer] Fallo al leer DB de OmniAI-Engine:', (err as Error).message);
      }
    } else {
      console.warn(`[EcosystemOverseer] No se encontró DB de OmniAI-Engine en ${omniDbPath}`);
    }

    // 2. Proyección de Watch Time (Shorts ~30s promedio por view = 0.5 mins)
    const projectedWatchTimeMinutes = omniStats.totalViews * 0.5;
    const projectedWatchTimeHours = projectedWatchTimeMinutes / 60;

    // 3. Evaluar con IA
    const prompt = `
Eres el CEO y Director General de un ecosistema autónomo de IA.
Nuestro objetivo principal es MONETIZAR a través de YouTube (suscriptores, tiempo de reproducción) y Trading Financiero.

Datos actuales del departamento de contenido (OmniAI-Engine):
- Videos Publicados: ${omniStats.videoCount}
- Vistas Totales: ${omniStats.totalViews}
- Likes Totales: ${omniStats.totalLikes}
- Tiempo de Reproducción Estimado: ${projectedWatchTimeHours.toFixed(2)} horas (Meta para monetizar: 4000 horas o 10M views en Shorts).

Haz un análisis crudo y directo de 2 párrafos:
1. ¿Vamos por buen camino? Si los números son bajos (ej: 0 vistas, 0 videos), dínoslo claro.
2. ¿Qué ajuste estratégico deberíamos hacer en el contenido o en el SEO para acelerar el despegue?
`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'system', content: prompt }],
      });
      
      const analysis = response.choices[0].message.content || 'Sin análisis.';
      console.log('--- REPORTE DEL DIRECTOR GENERAL (CEO) ---');
      console.log(analysis);
      console.log('------------------------------------------');
      return analysis;
    } catch (err) {
      console.error('[EcosystemOverseer] Error al consultar IA:', (err as Error).message);
      return 'Error en la IA.';
    }
  }
}
