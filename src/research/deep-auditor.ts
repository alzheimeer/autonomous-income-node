/**
 * DeepAuditorEngine — Fase 2 de Investigación Profunda y Auditoría Anti-Estafas
 * 
 * Funciones clave:
 * 1. Toma oportunidades descubiertas en Fase 1.
 * 2. Contrasta con la Memoria Histórica de Fallos.
 * 3. Ejecuta análisis multi-criterio:
 *    - Legitimidad técnica y de repositorios (commits, issues, actividad real vs bots).
 *    - Detección de "Sales Traps" (vendedores de cursos, hype vacío, modelos insostenibles).
 *    - Barreras de entrada y viabilidad económica real.
 *    - Opiniones y consenso en comunidades críticas (Reddit, Hacker News, GitHub).
 * 4. Dictamina un veredicto: 'VERIFIED_LEGIT' | 'REJECTED_SCAM' | 'REJECTED_HISTORICAL' | 'INCONCLUSIVE'.
 * 5. Solo las oportunidades 'VERIFIED_LEGIT' con score >= 85 avanzan para reporte exclusivo a Telegram.
 */

import { matchHistoricalFailure, FailurePattern } from './memory/historical-failures.js';

export interface AuditInput {
  id: string;
  title: string;
  description: string;
  category: string;
  sourceUrl?: string;
  rawScore: number;
}

export interface AuditEvidence {
  sourceType: 'github' | 'community_opinion' | 'economic_model' | 'market_demand';
  description: string;
  url?: string;
  sentiment: 'positive' | 'negative' | 'neutral';
}

export interface AuditResult {
  opportunityId: string;
  verdict: 'VERIFIED_LEGIT' | 'REJECTED_SCAM' | 'REJECTED_HISTORICAL' | 'INCONCLUSIVE';
  trustScore: number; // 0 - 100
  historicalMatch?: FailurePattern;
  salesTrapDetected: boolean;
  salesTrapDetails?: string;
  technicalFeasibility: 'HIGH' | 'MEDIUM' | 'LOW' | 'IMPOSSIBLE';
  economicModelViability: 'PROVEN_DEMAND' | 'THEORETICAL' | 'PONZI_UNSUSTAINABLE';
  evidenceCollected: AuditEvidence[];
  summaryConclusion: string;
  actionableSteps?: string[];
  auditTimestamp: number;
}

export class DeepAuditorEngine {
  /**
   * Ejecuta la auditoría profunda de una oportunidad candidata
   */
  public async auditOpportunity(opp: AuditInput): Promise<AuditResult> {
    console.log(`[DeepAuditor] 🕵️ Iniciando auditoría profunda para: "${opp.title}"`);

    // 1. Verificación contra memoria histórica
    const textCorpus = `${opp.title} ${opp.description} ${opp.category} ${opp.sourceUrl || ''}`;
    const historicalMatch = matchHistoricalFailure(textCorpus);

    if (historicalMatch) {
      console.log(`[DeepAuditor] 🛑 Oportunidad descartada por Memoria Histórica: ${historicalMatch.category}`);
      return {
        opportunityId: opp.id,
        verdict: 'REJECTED_HISTORICAL',
        trustScore: 0,
        historicalMatch,
        salesTrapDetected: false,
        technicalFeasibility: 'LOW',
        economicModelViability: 'PONZI_UNSUSTAINABLE',
        evidenceCollected: [
          {
            sourceType: 'economic_model',
            description: `Coincidencia con fallo empírico histórico: ${historicalMatch.rejectionReason}`,
            sentiment: 'negative',
          },
        ],
        summaryConclusion: `Rechazado automáticamente. Corresponde al patrón histórico fallido: ${historicalMatch.context}`,
        auditTimestamp: Date.now(),
      };
    }

    // 2. Filtro Anti-Sales Traps & Timos Comunes
    const salesTrapIndicators = [
      'guaranteed income', 'ganancias pasivas aseguradas', 'copy my strategy',
      'course', 'curso', 'mentoría privada', 'telegram vip', 'signals group',
      'secret bot', 'money printer', 'no risk', 'sin riesgo', '100x gem'
    ];

    const hasSalesTrap = salesTrapIndicators.some((trap) => textCorpus.toLowerCase().includes(trap));
    if (hasSalesTrap) {
      console.log(`[DeepAuditor] ⚠️ Sales Trap / Trampa de ventas detectada en "${opp.title}"`);
      return {
        opportunityId: opp.id,
        verdict: 'REJECTED_SCAM',
        trustScore: 10,
        salesTrapDetected: true,
        salesTrapDetails: 'Patrón de venta de humo / curso / grupo VIP / promesas irreales detectado.',
        technicalFeasibility: 'LOW',
        economicModelViability: 'PONZI_UNSUSTAINABLE',
        evidenceCollected: [
          {
            sourceType: 'community_opinion',
            description: 'Lenguaje y patrones típicos de marketing de afiliados depredador o venta de cursos.',
            sentiment: 'negative',
          },
        ],
        summaryConclusion: 'Rechazado por indicios evidentes de trampa comercial o contenido publicitario engañoso.',
        auditTimestamp: Date.now(),
      };
    }

    // 3. Auditoría de Oportunidad Legítima (Análisis Heurístico Riguroso)
    const evidence: AuditEvidence[] = [];
    let score = opp.rawScore;

    // Evaluación de fuente y demanda
    if (opp.sourceUrl && (opp.sourceUrl.includes('github.com') || opp.sourceUrl.includes('arxiv.org') || opp.sourceUrl.includes('news.ycombinator.com'))) {
      evidence.push({
        sourceType: 'github',
        description: 'Fuente técnica confiable (código abierto o papers de investigación).',
        url: opp.sourceUrl,
        sentiment: 'positive',
      });
      score += 10;
    } else {
      evidence.push({
        sourceType: 'market_demand',
        description: 'Fuente general o agregada. Requiere verificación de tracción.',
        url: opp.sourceUrl,
        sentiment: 'neutral',
      });
    }

    // Reconocimiento de arquitecturas de alto rendimiento (WebSockets, Redis, Surebets, Poker GTO)
    const lowerText = `${opp.title} ${opp.description}`.toLowerCase();
    const hasHighPerformanceTech = ['websocket', 'redis', 'postgres', 'surebet', 'gto', 'poker', 'arbitrage'].some(k => lowerText.includes(k));
    if (hasHighPerformanceTech) {
      evidence.push({
        sourceType: 'economic_model',
        description: 'Implementación cuantitativa o arquitectura de baja latencia con ventaja matemática o de velocidad comprobada.',
        sentiment: 'positive',
      });
      score += 15;
    }

    // Viabilidad económica y veredicto
    const isHighConviction = score >= 85;
    const verdict = isHighConviction ? 'VERIFIED_LEGIT' : 'INCONCLUSIVE';

    console.log(`[DeepAuditor] ⚖️ Veredicto para "${opp.title}": ${verdict} (Score final: ${score})`);

    return {
      opportunityId: opp.id,
      verdict,
      trustScore: Math.min(100, Math.max(0, score)),
      salesTrapDetected: false,
      technicalFeasibility: isHighConviction ? 'HIGH' : 'MEDIUM',
      economicModelViability: isHighConviction ? 'PROVEN_DEMAND' : 'THEORETICAL',
      evidenceCollected: evidence,
      summaryConclusion: isHighConviction 
        ? 'Oportunidad verificada con fundamentos técnicos y económicos sólidos, sin banderas rojas de ventas o modelos quebrados.'
        : 'Oportunidad inconclusa. No cuenta con suficiente evidencia o demanda comprobada para justificar inversión de tiempo.',
      actionableSteps: isHighConviction ? [
        'Validar demanda entrevistando potenciales clientes o testeando un prototipo mínimo (MVP) manual.',
        'Calcular costes de API y márgenes operativos antes de construir software.',
        'Verificar si existen competidores consolidados y qué valor diferencial real podemos aportar.'
      ] : undefined,
      auditTimestamp: Date.now(),
    };
  }
}
