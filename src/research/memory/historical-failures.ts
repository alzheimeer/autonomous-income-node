/**
 * Historical Failures & Lessons Learned Memory
 * 
 * Reglas de descarte inmediato basadas en la experiencia empírica real
 * del proyecto (Shadow Mode y producción Mayo - Agosto 2026).
 */

export interface FailurePattern {
  id: string;
  category: string;
  keywords: string[];
  rejectionReason: string;
  context: string;
}

export const HISTORICAL_FAILURE_PATTERNS: FailurePattern[] = [
  {
    id: 'MEM-001',
    category: 'MICROCAP_SNIPING',
    keywords: [
      'sniper', 'sniping', 'pump.fun', 'memecoin', 'launch sniper',
      'new pair', 'dexscreener bot', 'geckoterminal bot', 'liquidity snipe',
      'fair launch', 'raydium bot', 'uniswap v3 sniper'
    ],
    rejectionReason: 'Asimetría técnica insuperable: requiere nodos privados y builders MEV ($50k-$200k/año). 97%+ de tokens nuevos en L2 son honeypots o rug pulls.',
    context: 'Probado en Base (Uniswap V3 / Aerodrome) con 1,300+ señales. Win rate real ~0% tras corregir fallo en detección de rug pulls.'
  },
  {
    id: 'MEM-002',
    category: 'TECHNICAL_INDICATOR_SPOT_TRADING',
    keywords: [
      'ema cross', 'rsi strategy', 'macd scalping', 'bollinger bands bot',
      'grid bot crypto', 'technical analysis trading', 'intraday spot bot'
    ],
    rejectionReason: 'Los indicadores clásicos en temporalidades cortas (5m/15m) generan falsas señales masivas en cripto y el spread + comisiones devoran el beneficio.',
    context: 'Probado en WETH/USDC Uniswap V3. Win rate real ~10%, drawdown sistemático.'
  },
  {
    id: 'MEM-003',
    category: 'EMPTY_ECOSYSTEM_APIS',
    keywords: [
      'x402', 'http 402', 'conway cloud', 'micropayments api',
      'pay per request api without demand', 'agent to agent payment marketplace'
    ],
    rejectionReason: 'Crear servicios para ecosistemas sin demanda orgánica ni clientes pre-existentes resulta en 0 ingresos.',
    context: 'Servicios x402 implementados en junio 2026 registraron 0 clientes reales.'
  },
  {
    id: 'MEM-004',
    category: 'PONZI_DEFI_YIELD',
    keywords: [
      'apy 100%', 'apy 500%', 'high yield staking', 'node reward protocol',
      'rebase token', 'liquidity mining 300%'
    ],
    rejectionReason: 'Rendimientos no sostenibles matemáticamente. Riesgo de exploit o dilución del 100%.',
    context: 'Pérdida casi certera de capital.'
  },
  {
    id: 'MEM-005',
    category: 'AUTONOMOUS_SELF_MODIFICATION',
    keywords: [
      'self modifying code', 'auto code generator without review',
      'autonomous pr merge', 'runtime code rewrite'
    ],
    rejectionReason: 'Fragilidad arquitectónica severa: genera dependencias circulares, regresiones en tests y caída del runtime.',
    context: 'AdaptiveEvolver causó inestabilidad en producción en múltiples ciclos.'
  }
];

/**
 * Evalúa si una oportunidad contiene palabras clave o patrones de fallos históricos
 */
export function matchHistoricalFailure(text: string): FailurePattern | null {
  const normalized = text.toLowerCase();
  for (const pattern of HISTORICAL_FAILURE_PATTERNS) {
    const match = pattern.keywords.some((kw) => normalized.includes(kw.toLowerCase()));
    if (match) {
      return pattern;
    }
  }
  return null;
}
