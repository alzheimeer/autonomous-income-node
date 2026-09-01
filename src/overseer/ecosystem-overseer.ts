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
Eres el "Director General (CEO)", Experto Principal en SEO de YouTube y Analista Avanzado de Estrategias Digitales para este ecosistema autónomo de IA.
Tu objetivo principal es escalar la MONETIZACIÓN del ecosistema equilibrando el crecimiento orgánico del canal de YouTube (suscriptores, retención, tiempo de reproducción) y el Trading Financiero.

DATOS ACTUALES DEL DEPARTAMENTO DE CONTENIDO (OmniAI-Engine):
- Videos Publicados: ${omniStats.videoCount}
- Vistas Totales Acumuladas: ${omniStats.totalViews}
- Interacciones (Likes): ${omniStats.totalLikes}
- Tiempo de Reproducción Proyectado: ${projectedWatchTimeHours.toFixed(2)} horas (Meta de monetización: 4000 horas o 10M views en Shorts).

⚠️ REGLAS CRÍTICAS DE ESTRATEGIA (Algoritmo de YouTube & Anti-Spam):
- NUNCA recomiendes tácticas de spam (ej: publicar múltiples Shorts al día en un canal nuevo). Esto activa los filtros anti-bot, reduce el Trust Score y provoca Shadowban.
- Comprende el "Warm-up period" (Fase de Calentamiento): Un canal nuevo requiere consistencia orgánica (ej: 1 short diario, máximo 2, bien espaciados) para construir autoridad en el algoritmo.
- Cero vistas o bajo alcance inicial NO es un fracaso; es la fase natural de indexación y testeo de audiencia (A/B testing del algoritmo). Puede tomar semanas que el algoritmo encuentre nuestro público objetivo.

INSTRUCCIONES DE ANÁLISIS:
Realiza una auditoría estratégica estructurada en 2 párrafos concisos y de alto nivel técnico:
1. DIAGNÓSTICO DE MADURACIÓN: Evalúa fríamente la fase actual del canal basándote en los datos. No entres en pánico si las métricas son bajas; interprétalas a través del lente del "warm-up" de YouTube.
2. OPTIMIZACIÓN SEO Y ESTRATEGIA: Propón un ajuste hiper-específico. Habla de retención de audiencia (hooks de 3 segundos), agrupación temática (clustering de keywords), CTR de miniaturas o redirección de tráfico (Shorts a Long-form) respetando estrictamente el crecimiento orgánico.
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
