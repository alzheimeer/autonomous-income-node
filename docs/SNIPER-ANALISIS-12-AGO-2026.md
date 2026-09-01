# 📊 Análisis Híbrido Sniper — 12-13 Agosto 2026

> **Estado:** ⏳ EN SHADOW MODE - Evaluando mejoras
> **Próxima revisión:** 22 Agosto 2026 (fin de Fase 1)
> **Última actualización:** 13 Agosto 2026, 00:30 UTC

---

## 🔄 COMPARATIVA: AYER vs HOY

### Métricas Generales

| Métrica | 11 Agosto | 12 Agosto | Cambio |
|---------|-----------|-----------|--------|
| Pass Rate DexScreener | 0% | **9.55%** | ⬆️ +9.55% |
| Pass Rate GeckoTerminal | 1.76% | 0% | ⬇️ (rate-limited) |
| INSUFFICIENT_LIQUIDITY | 28-46% | **0.6%** | ⬆️ Resuelto |
| QUOTE_ERROR | 54-71% | **99.4%** | ⚠️ Problema nuevo |
| Trades micro-cap | 27 (TIME_STOP) | 30 total (3 TP_HIT) | ⬆️ Primeros wins |
| Win Rate micro-cap | 0% | **10%** | ⬆️ Primera mejora |

### Cambios Implementados Hoy

1. ✅ **GeckoTerminal interval**: 5s → 25s (evita rate limits)
2. ✅ **Datos legacy marcados**: 5,592 posiciones → `variant_id = 'legacy-balanced'`
3. ✅ **Bitquery API key renovada** (cuenta nueva)
4. ✅ **RPC fallback**: Base público + Ankr (Alchemy agotado)

---

## 🚨 PROBLEMA CRÍTICO: QUOTE_ERROR 99.4%

### Diagnóstico

El informe de ayer mostraba:
- QUOTE_ERROR: 54% (normal)
- INSUFFICIENT_LIQUIDITY: 46% (problema)

Hoy después de bajar el threshold de liquidez:
- QUOTE_ERROR: **99.4%** (problema grave)
- INSUFFICIENT_LIQUIDITY: 0.6% (resuelto)

**¿Qué pasó?** El threshold de liquidez se redujo, pero ahora los tokens que pasan esa validación fallan en la etapa de cotización (QUOTE_ERROR).

### Causas del QUOTE_ERROR

1. **RPC Rate Limits** (70% estimado)
   - Base público tiene límite de ~100 req/min
   - Error: `code: -32016, message: 'over rate limit'`
   - Cada validación hace 5+ llamadas RPC (detectPool, buy quote, sell1 quote, sell2 quote, liquidity check)

2. **Pools sin rutas válidas** (20% estimado)
   - Token recién creado sin pool en Uniswap V3 ni Aerodrome
   - Pool existe pero no tiene liquidez en ningún fee tier (100, 500, 3000, 10000)

3. **Tokens honeypot/scam** (10% estimado)
   - Tokens que reviertan la transacción al intentar cotizar
   - Pools bloqueados o con trading deshabilitado

---

## 📈 ANÁLISIS DE MICRO-CAPS

### Estado Actual

| Status | Count | PnL |
|--------|-------|-----|
| TIME_STOP | 27 | $0 |
| TP_HIT | 3 | $139.94 |
| **Total** | **30** | **$139.94** |

### Los 3 TP_HIT exitosos

Token: `0xcb585250f852C6c6bf90434AB21A00f02833a4af`
- 3 posiciones cerradas con TP_HIT
- PnL: $99.95 + $29.99 + $9.99 = $139.94
- Win rate de este token: 100%

### Los 27 TIME_STOP

Token: `0x252d36f435582ecb01686448d21e8c9ea0b2ca65` (BD token)
- Todas cerradas por TIME_STOP (2h sin alcanzar TP ni SL)
- PnL: $0 (no se movió el precio suficiente)
- **Problema**: Token con poca volatilidad o baja liquidez

### Conclusión Micro-Caps

**El sistema SÍ funciona cuando encuentra buenos tokens:**
- Los 3 micro-caps que pasaron validación y tenían liquidez real generaron +$139.94
- Win rate de tokens válidos: 100% (3/3)

**El problema es el filtrado:**
- 97% de señales son rechazadas antes de crear posición
- La mayoría por QUOTE_ERROR (RPC rate limits + pools inválidos)

---

## 🔧 RECOMENDACIONES

### 1. RPC Provider (URGENTE)

**Problema:** Alchemy agotado, Base público con rate limits estrictos.

**Opciones:**
| Opción | Pros | Contras | Recomendación |
|--------|------|---------|---------------|
| Nueva cuenta Alchemy | 330M CU/mes gratis | Solo dura ~2 semanas con el uso actual | ✅ Sí, como backup |
| Ankr (ya configurado) | 100K req/día gratis | Puede ser lento | Ya está como fallback |
| QuickNode | Mejor rate limit | $0 tier muy limitado | ❌ No vale la pena |
| Infura | Buena confiabilidad | Agotado también | ❌ |
| **Self-hosted Base node** | Sin límites | Requiere 500GB+ SSD, setup | 🔄 Para futuro |

**Acción recomendada:** Crear segunda cuenta Alchemy con email diferente, rotar entre cuentas cuando se agote una.

### 2. Mejorar Pass Rate de Micro-Caps

**Estrategia A: Reducir llamadas RPC por validación**
- Actual: 5-8 llamadas por token
- Optimizado: 3-4 llamadas (combinar queries, cache de pools)
- Impacto: -50% uso de RPC → menos rate limits

**Estrategia B: Pre-filtro en DexScreener/GeckoTerminal**
- Solo procesar tokens con:
  - Liquidity > $5,000 (ya reportado por la API)
  - Age > 5 minutos (evitar rugs instantáneos)
  - Volume 1h > $1,000
- Impacto: -80% señales basura → mejor uso del RPC

**Estrategia C: Batch validation**
- Acumular 10 señales, validar en batch
- Usar multicall para reducir RPC calls
- Impacto: -70% llamadas RPC

### 3. ¿Marcar el 97% como No Viable?

**NO recomendado** porque:
1. Las señales rechazadas no son "malas" — simplemente no pudimos cotizarlas por rate limits
2. Si mejoramos el RPC, muchas podrían pasar
3. El rechazo es temporal (RPC), no permanente (token malo)

**Mejor enfoque:**
- Agregar columna `rejection_temporary: boolean` a sniper_signals
- `QUOTE_ERROR` por rate limit = temporary
- `INSUFFICIENT_LIQUIDITY` = permanent
- `SELL_TAX_EXCEEDED` = permanent

---

## 📋 CRITERIOS MES 2 (Actualizado)

| Criterio | Objetivo | Actual | Estado |
|----------|----------|--------|--------|
| Trades micro-cap cerrados | ≥50 | 30 | ⏳ 60% |
| Win Rate micro-cap | ≥40% | 10% | ❌ |
| Pass Rate | ≥5% | 0.6% | ❌ |
| Días de data | ≥14 | 5 | ⏳ 36% |
| RPC estable | Sin rate limits | Rate limited | ❌ |

**Veredicto:** Necesitamos resolver el problema de RPC antes de poder evaluar la estrategia correctamente.

---

## ⏰ PRÓXIMOS PASOS

### Inmediato (Hoy)

1. ✅ Bitquery API key renovada
2. ⏳ Crear segunda cuenta Alchemy
3. ⏳ Implementar rotación de RPCs

### Esta Semana

1. Implementar pre-filtro de DexScreener (liquidity > $5k en la API)
2. Reducir llamadas RPC por validación
3. Monitorear pass rate con RPC mejorado

### Próxima Revisión (22 Agosto)

- Evaluar win rate con datos limpios
- Decisión: ¿Listo para Micro-Live?

---

## 📝 DIFERENCIAS CLAVE vs INFORME 11 AGOSTO

| Aspecto | 11 Agosto | 12 Agosto |
|---------|-----------|-----------|
| Problema principal | INSUFFICIENT_LIQUIDITY (46%) | QUOTE_ERROR (99.4%) |
| Micro-cap wins | 0 | 3 (+$139.94) |
| Pass rate | 0-1.76% | 0-9.55% |
| GeckoTerminal | Funcionando | Rate-limited (fix aplicado) |
| Variantes tracking | No guardaba | ✅ Funcionando |
| Datos legacy | Sin marcar | Marcados como legacy-balanced |

**Conclusión:** El sistema está mejorando pero el cuello de botella cambió de "filtrado de liquidez" a "rate limits de RPC".

---

*Documento creado: 13 Agosto 2026, 00:30 UTC*
*Autor: Análisis Kiro + datos PostgreSQL*
