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
  scoreRisk?: number; // 0 (100% loss) to 100 (0% loss)
}

export interface AuditEvidence {
  sourceType: 'github' | 'community_opinion' | 'economic_model' | 'market_demand';
  description: string;
  url?: string;
  sentiment: 'positive' | 'negative' | 'neutral';
}

export interface AuditResult {
  opportunityId: string;
  verdict: 'VERIFIED_LEGIT' | 'REJECTED_SCAM' | 'REJECTED_HISTORICAL' | 'REJECTED_RISK' | 'REJECTED_DUPLICATE' | 'INCONCLUSIVE';
  trustScore: number; // 0 - 100
  riskPercent: number; // 0 - 100 (porcentaje de riesgo real estimado)
  deepseekAnalysis?: string; // Análisis cualitativo y cuantitativo final de DeepSeek
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
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly timeout = 30_000;

  constructor() {
    this.apiKey = process.env['OPENAI_API_KEY'] ?? '';
    const rawBase = process.env['OPENAI_BASE_URL'] ?? 'https://api.deepseek.com';
    this.baseURL = `${rawBase.replace(/\/+$/, '')}/chat/completions`;
    this.model = process.env['TRIAGE_MODEL'] || process.env['SIGNAL_MODEL'] || 'deepseek-chat';
  }

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
        riskPercent: 100,
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
        riskPercent: 95,
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

    // 3. Comprobación preliminar de riesgo: si score_risk es <= 50, el riesgo porcentual es >= 50%
    if (opp.scoreRisk !== undefined && opp.scoreRisk <= 50) {
      const initialRisk = 100 - opp.scoreRisk;
      console.log(`[DeepAuditor] 🛑 Riesgo preliminar inaceptable (${initialRisk}% >= 50%) para: "${opp.title}"`);
      return {
        opportunityId: opp.id,
        verdict: 'REJECTED_RISK',
        trustScore: 20,
        riskPercent: initialRisk,
        salesTrapDetected: false,
        technicalFeasibility: 'MEDIUM',
        economicModelViability: 'THEORETICAL',
        evidenceCollected: [
          {
            sourceType: 'economic_model',
            description: `Riesgo de pérdida de capital excesivo (${initialRisk}%). Solo se admiten iniciativas con riesgo < 50%.`,
            sentiment: 'negative',
          },
        ],
        summaryConclusion: `Rechazado por riesgo de capital elevado (${initialRisk}%). El límite máximo tolerado es inferior al 50%.`,
        auditTimestamp: Date.now(),
      };
    }

    // 4. Auditoría de Oportunidad Legítima (Análisis Heurístico Riguroso)
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

    // 5. Análisis Final con DeepSeek
    const deepseekEval = await this.evaluateWithDeepSeek(opp);

    const calculatedRiskPercent = deepseekEval 
      ? deepseekEval.riskPercent 
      : (opp.scoreRisk !== undefined ? (100 - opp.scoreRisk) : 35);

    // Regla Estricta: Solo iniciativas con RIESGO ABAJO DEL 50%
    if (calculatedRiskPercent >= 50) {
      console.log(`[DeepAuditor] 🛑 Rechazada por DeepSeek: Riesgo ${calculatedRiskPercent}% >= 50% para "${opp.title}"`);
      return {
        opportunityId: opp.id,
        verdict: 'REJECTED_RISK',
        trustScore: Math.min(score, 45),
        riskPercent: calculatedRiskPercent,
        deepseekAnalysis: deepseekEval?.deepAnalysis ?? 'Riesgo evaluado superior al 50%.',
        salesTrapDetected: false,
        technicalFeasibility: deepseekEval?.technicalFeasibility ?? 'MEDIUM',
        economicModelViability: 'THEORETICAL',
        evidenceCollected: [
          ...evidence,
          {
            sourceType: 'economic_model',
            description: `Evaluación de riesgo final: ${calculatedRiskPercent}%. Excede el máximo permitido (< 50%).`,
            sentiment: 'negative',
          },
        ],
        summaryConclusion: `Rechazado por riesgo de capital inaceptable (${calculatedRiskPercent}%). Solo se admiten iniciativas con riesgo estrictamente menor al 50%.`,
        auditTimestamp: Date.now(),
      };
    }

    // Regla: Si DeepSeek detecta duplicación de estrategia por cambio superficial de activo
    if (deepseekEval?.isCurrencyVariantDuplicate) {
      console.log(`[DeepAuditor] 🛑 Descartada por DeepSeek: Duplicado de estrategia variando únicamente la moneda/par para "${opp.title}"`);
      return {
        opportunityId: opp.id,
        verdict: 'REJECTED_DUPLICATE',
        trustScore: 30,
        riskPercent: calculatedRiskPercent,
        deepseekAnalysis: deepseekEval.deepAnalysis,
        salesTrapDetected: false,
        technicalFeasibility: deepseekEval.technicalFeasibility,
        economicModelViability: 'THEORETICAL',
        evidenceCollected: [
          ...evidence,
          {
            sourceType: 'market_demand',
            description: 'Estrategia duplicada detectada: misma mecánica base repitiendo únicamente la criptomoneda.',
            sentiment: 'negative',
          },
        ],
        summaryConclusion: 'Rechazado por duplicidad: variante idéntica de una estrategia ya analizada que solo cambia la criptomoneda.',
        auditTimestamp: Date.now(),
      };
    }

    // Viabilidad económica y veredicto
    const isHighConviction = score >= 85 && (!deepseekEval || deepseekEval.verdict === 'VERIFIED_LEGIT');
    const verdict = isHighConviction ? 'VERIFIED_LEGIT' : 'INCONCLUSIVE';

    console.log(`[DeepAuditor] ⚖️ Veredicto para "${opp.title}": ${verdict} (Score final: ${score}, Riesgo: ${calculatedRiskPercent}%)`);

    return {
      opportunityId: opp.id,
      verdict,
      trustScore: Math.min(100, Math.max(0, score)),
      riskPercent: calculatedRiskPercent,
      deepseekAnalysis: deepseekEval?.deepAnalysis,
      salesTrapDetected: false,
      technicalFeasibility: deepseekEval?.technicalFeasibility ?? (isHighConviction ? 'HIGH' : 'MEDIUM'),
      economicModelViability: deepseekEval?.economicModelViability ?? (isHighConviction ? 'PROVEN_DEMAND' : 'THEORETICAL'),
      evidenceCollected: evidence,
      summaryConclusion: deepseekEval?.conclusion ?? (isHighConviction 
        ? 'Oportunidad verificada con fundamentos técnicos y económicos sólidos, riesgo menor al 50% y sin banderas rojas.'
        : 'Oportunidad inconclusa. No cuenta con suficiente evidencia o demanda comprobada para justificar inversión de tiempo.'),
      actionableSteps: deepseekEval?.actionableSteps ?? (isHighConviction ? [
        'Validar demanda entrevistando potenciales clientes o testeando un prototipo mínimo (MVP) manual.',
        'Calcular costes de infraestructura/API y márgenes operativos antes de construir software.',
        'Verificar competidores consolidados y ventaja algorítmica real.'
      ] : undefined),
      auditTimestamp: Date.now(),
    };
  }

  /**
   * Invoca a DeepSeek para el análisis exhaustivo final previo a aprobación, guardado y Telegram
   */
  private async evaluateWithDeepSeek(opp: AuditInput): Promise<{
    riskPercent: number;
    verdict: 'VERIFIED_LEGIT' | 'REJECTED';
    technicalFeasibility: 'HIGH' | 'MEDIUM' | 'LOW' | 'IMPOSSIBLE';
    economicModelViability: 'PROVEN_DEMAND' | 'THEORETICAL' | 'PONZI_UNSUSTAINABLE';
    isCurrencyVariantDuplicate: boolean;
    deepAnalysis: string;
    conclusion: string;
    actionableSteps: string[];
  } | null> {
    if (!this.apiKey) {
      console.warn('[DeepAuditor] No hay API key configurada para DeepSeek — omitiendo evaluación LLM profunda');
      return null;
    }

    const prompt = `Actúa como un Auditor Principal de Riesgos Cuantitativos y Seguridad Técnica de Software Financiero.
Evalúa con extremo rigor si esta iniciativa debe ser aprobada para desarrollo autónomo y notificación al inversor.

OPORTUNIDAD A AUDITAR:
- ID: ${opp.id}
- Título: ${opp.title}
- Categoría: ${opp.category}
- Descripción: ${opp.description}
- URL de Origen: ${opp.sourceUrl || 'N/A'}
- Score Preliminar: ${opp.rawScore}/100

CRITERIOS ESTRICTOS DE EVALUACIÓN:
1. RIESGO PORCENTUAL (0 - 100%):
   - Estima la probabilidad real de pérdida o fracaso del capital/recursos invertidos.
   - REGLA MANDATORIA: Si el riesgo es >= 50%, la iniciativa DEBE SER RECHAZADA. Solo iniciativas con riesgo < 50% pueden ser aprobadas.
2. DEDUPLICACIÓN DE MONEDAS / PARES:
   - ¿Es esta una estrategia genérica (ej. arbitraje de funding rate, yield farming, swap bot) que simplemente repite la misma idea cambiando de token/moneda (ej. BTCUSDT vs ETHUSDT vs SOLUSDT)? 
   - Marca "isCurrencyVariantDuplicate": true si no aporta una mecánica diferencial y solo cambia el activo.
3. FACTIBILIDAD TÉCNICA Y VIABILIDAD ECONÓMICA:
   - ¿Es ejecutable en Node.js/TypeScript? ¿Requiere capital desmedido o KYC imposible?

RESPONDE ÚNICAMENTE CON UN OBJETO JSON VÁLIDO (sin markdown, sin texto adicional) con esta estructura:
{
  "riskPercent": <número entero entre 0 y 100>,
  "verdict": "VERIFIED_LEGIT" | "REJECTED",
  "technicalFeasibility": "HIGH" | "MEDIUM" | "LOW" | "IMPOSSIBLE",
  "economicModelViability": "PROVEN_DEMAND" | "THEORETICAL" | "PONZI_UNSUSTAINABLE",
  "isCurrencyVariantDuplicate": <true o false>,
  "deepAnalysis": "<Análisis exhaustivo de 2-3 párrafos detallando riesgos, viabilidad y mecánicas cuantitativas>",
  "conclusion": "<Conclusión ejecutiva directa de 1-2 oraciones>",
  "actionableSteps": ["<Paso 1>", "<Paso 2>", "<Paso 3>"]
}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(this.baseURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1200,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'You are an elite quantitative and technical risk auditor. You must always return a strictly valid JSON object matching the user specification.'
            },
            {
              role: 'user',
              content: prompt
            }
          ]
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        console.warn(`[DeepAuditor] DeepSeek API error (${response.status}): ${errText}`);
        return null;
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const rawContent = data.choices?.[0]?.message?.content;
      if (!rawContent) return null;

      const parsed = JSON.parse(rawContent) as {
        riskPercent: number;
        verdict: 'VERIFIED_LEGIT' | 'REJECTED';
        technicalFeasibility: 'HIGH' | 'MEDIUM' | 'LOW' | 'IMPOSSIBLE';
        economicModelViability: 'PROVEN_DEMAND' | 'THEORETICAL' | 'PONZI_UNSUSTAINABLE';
        isCurrencyVariantDuplicate?: boolean;
        deepAnalysis: string;
        conclusion: string;
        actionableSteps: string[];
      };

      return {
        riskPercent: Number.isFinite(parsed.riskPercent) ? Math.max(0, Math.min(100, parsed.riskPercent)) : 50,
        verdict: parsed.verdict === 'VERIFIED_LEGIT' ? 'VERIFIED_LEGIT' : 'REJECTED',
        technicalFeasibility: parsed.technicalFeasibility || 'MEDIUM',
        economicModelViability: parsed.economicModelViability || 'THEORETICAL',
        isCurrencyVariantDuplicate: Boolean(parsed.isCurrencyVariantDuplicate),
        deepAnalysis: parsed.deepAnalysis || 'Análisis completado.',
        conclusion: parsed.conclusion || 'Evaluación de viabilidad y riesgo finalizada.',
        actionableSteps: Array.isArray(parsed.actionableSteps) ? parsed.actionableSteps : [],
      };
    } catch (err) {
      console.warn('[DeepAuditor] Error llamando a DeepSeek para auditoría final:', (err as Error).message);
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
