# 📊 Análisis Híbrido Sniper — 11-12 Agosto 2026

> **Estado:** ⏳ NO LISTO para Fase "Mes 2 (Micro-Live)"
> **Próxima revisión:** 22 Agosto 2026 (fin de Fase 1)
> **Última actualización:** 12 Agosto 2026, 01:15 UTC

---

## 🚨 RESUMEN EJECUTIVO

| Métrica | Valor | Objetivo | Estado |
|---------|-------|----------|--------|
| Días de Shadow Trading | 5 | 14+ | ❌ |
| Trades micro-cap cerrados | 27 (TIME_STOP) | 50+ | ❌ |
| Win Rate micro-cap | 0% (todos TIME_STOP) | ≥40% | ❌ |
| Pass Rate (12 ago) | 1.13% | ≥5% | ⬆️ Mejorando |
| INSUFFICIENT_LIQUIDITY | 28% (era 46%) | <20% | ⬆️ Mejorando |
| Señales procesadas | 14,764+ | 10,000+ | ✅ |

**Veredicto:** Continuar en Shadow Mode hasta el 22 de Agosto.

---

### 4. FIX: Restauración de Posiciones al Reiniciar

**Archivo:** `src/hybrid-sniper/shadow-executor.ts` + `src/hybrid-sniper/metrics-recorder.ts`

**Problema detectado (12 Agosto 2026):**
- 27 posiciones micro-cap quedaron OPEN en la DB pero no se cerraban
- El ShadowExecutor solo mantenía posiciones en memoria (Map)
- Al reiniciar el container, las posiciones se "olvidaban" y nunca cerraban

**Solución implementada:**
1. Nuevo método `restoreOpenPositions()` en ShadowExecutor
2. Se llama automáticamente en `start()` antes del monitoring loop
3. Posiciones expiradas se cierran con TIME_STOP al restaurar
4. Nuevo método `getOpenPositions()` en MetricsRecorder para leer de DB

**Comportamiento:**
- Al iniciar: lee posiciones OPEN de DB
- Si `time_stop < now`: cierra con TIME_STOP, pnl=0
- Si aún válida: restaura a memoria para continuar monitoreo

**Verificación:**
```bash
# Antes de restart: verificar hay posiciones OPEN
docker exec ain-postgres psql -U postgres -d ain_trading -c \
  "SELECT COUNT(*) FROM shadow_positions WHERE status='OPEN';"

# Reiniciar container
docker compose up -d --build agent

# Después de restart: verificar logs
docker logs ain-agent --tail 50 | findstr "restoreOpenPositions"
# Debe mostrar: "restoreOpenPositions: completed"
```

---

## 🔍 PROBLEMA CRÍTICO IDENTIFICADO

### Datos Contaminados por Pares Establecidos

**Síntoma:** 100% win rate, +$133,954 PnL reportado

**Causa raíz:** El 100% de trades cerrados eran de pares establecidos (WETH/DAI), NO micro-caps reales:

| Contrato | Token | Tipo | Trades | PnL |
|----------|-------|------|--------|-----|
| `0x4200...0006` | WETH | established | 2,223 | +$103,740 |
| `0x50c5...0Cb` | DAI | established | 1,911 | +$30,214 |
| `0x252d...a65` | BD | **micro-cap** | 27 | **OPEN** |

**Por qué los established siempre ganan:** WETH/USDC y DAI/USDC tienen spread ~0.01%. Cualquier trade simulado con estos pares genera profit inmediato porque:
1. El precio de compra y venta es casi idéntico
2. No hay volatilidad real
3. El TP del 40% se alcanza "instantáneamente" en la simulación

**Conclusión:** Las métricas de established son IRRELEVANTES para evaluar la estrategia de micro-cap sniping.

---

## 🔧 CORRECCIONES IMPLEMENTADAS (11 Agosto 2026)

### 1. Separación de Métricas por Tipo de Token

**Archivo:** `src/hybrid-sniper/metrics-recorder.ts`

**Cambio:** Nueva columna `signal_type` en `shadow_positions`:
- `micro-cap`: Tokens nuevos descubiertos por DexScreener/GeckoTerminal
- `established`: WETH, USDC, DAI, cbETH, cbBTC

**Migración SQL aplicada:**
```sql
ALTER TABLE shadow_positions ADD COLUMN signal_type VARCHAR(20) DEFAULT 'unknown';
UPDATE shadow_positions SET signal_type = 
  CASE WHEN contract_address IN (
    '0x4200000000000000000000000000000000000006', -- WETH
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', -- USDC
    '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb'  -- DAI
  ) THEN 'established' ELSE 'micro-cap' END;
```

**Verificación:**
```bash
node analyze-sniper-metrics.mjs
# Debe mostrar métricas separadas por signal_type
```

---

### 2. Reducción del Threshold de Liquidez

**Archivo:** `src/hybrid-sniper/contract-validator.ts`

**Cambio:**
- `MIN_LIQUIDITY_USDC`: $3,000 → $1,000
- **NUEVO:** `MIN_LIQUIDITY_WETH`: 0.4 ETH (~$1,500)

**Razón:** 
- 46% de señales eran rechazadas por `INSUFFICIENT_LIQUIDITY`
- Muchos micro-caps en Base tienen pools token/WETH, no token/USDC
- Ahora acepta pools con $1,000 USDC **O** 0.4 ETH de liquidez

**Verificación:** Monitorear el pass rate en las próximas 24h:
```sql
SELECT DATE(to_timestamp(created_at/1000)) as day,
       COUNT(*) as total,
       SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) as passed,
       SUM(CASE WHEN reject_reason = 'INSUFFICIENT_LIQUIDITY' THEN 1 ELSE 0 END) as low_liq
FROM sniper_signals 
GROUP BY day ORDER BY day DESC LIMIT 3;
```

**Target:** Reducir `INSUFFICIENT_LIQUIDITY` de 46% a <25%

---

### 3. Script de Análisis Actualizado

**Archivo:** `analyze-sniper-metrics.mjs`

**Cambios:**
- Muestra métricas separadas por `signal_type`
- Resalta que solo micro-cap es relevante
- Incluye checklist de criterios para Mes 2
- Conexión directa a PostgreSQL puerto 5433

**Uso:**
```bash
cd autonomous-income-node
node analyze-sniper-metrics.mjs
```

---

## 📋 CRITERIOS PARA PASAR A MES 2 (MICRO-LIVE)

Según `fases.md`, estos son los requisitos para avanzar:

| Criterio | Descripción | Cómo verificar |
|----------|-------------|----------------|
| **Trades cerrados** | ≥50 micro-cap | `SELECT COUNT(*) FROM shadow_positions WHERE signal_type='micro-cap' AND status != 'OPEN'` |
| **Win Rate** | ≥40% en micro-cap | Script de análisis |
| **Profit Factor** | ≥1.2 | Wins/Losses ratio |
| **Días de data** | ≥14 | Desde 8 Agosto |
| **Drawdown** | <$10 en micro-cap | Max drawdown consecutivo |

---

## ⏰ POSICIONES MICRO-CAP ACTUALES

**Estado (12 Agosto 2026, 01:15 UTC):**

| Status | Count | PnL | Nota |
|--------|-------|-----|------|
| TIME_STOP | 27 | $0 | Cerradas manualmente + por fix de restauración |
| OPEN | 0 | - | Ninguna activa |

**Token anterior:** BD (`0x252d36f435582ecb01686448d21e8c9ea0b2ca65`)
- 27 posiciones cerradas con TIME_STOP y pnl=0
- **Razón del $0 PnL:** Las posiciones expiraron mientras el container estaba reiniciado, no se obtuvo precio de salida real

**Fix implementado (12 Agosto):** 
- ShadowExecutor ahora restaura posiciones OPEN de DB al iniciar
- Posiciones expiradas se cierran automáticamente con TIME_STOP
- Esto evita que posiciones queden "atrapadas" en OPEN

**Qué esperar ahora:**
1. Nuevas señales micro-cap deben generar posiciones con signal_type='micro-cap'
2. El sistema debe cerrarlas correctamente por TP/SL/TIME_STOP
3. Win rate real de micro-cap se calculará con los próximos trades

**Verificar estado:**
```sql
SELECT signal_type, status, COUNT(*) FROM shadow_positions 
WHERE signal_type = 'micro-cap' GROUP BY signal_type, status;
```

---

## 📈 ANÁLISIS DE RECHAZOS

### Última hora (12 Agosto 2026):
| Razón | Count | % | Tendencia |
|-------|-------|---|-----------|
| QUOTE_ERROR | 94 | 71% | Normal - tokens sin liquidez |
| INSUFFICIENT_LIQUIDITY | 37 | 28% | ⬇️ **Bajó de 46%** |
| (passed) | 2 | 1.5% | ⬆️ **Subió de 0%** |

### Histórico:
| Razón | Count | % | Acción |
|-------|-------|---|--------|
| QUOTE_ERROR | 7,948 | 54% | Normal - muchos tokens no tienen liquidez |
| INSUFFICIENT_LIQUIDITY | 6,739 | 46% | ⚠️ **CORREGIDO** - reducido threshold |
| SELL_TAX_EXCEEDED | 18 | 0.1% | OK - filtro de scams funcionando |

**Mejora observada:** El threshold reducido ($1,000 USDC / 0.4 ETH) está permitiendo más tokens.

---

## 🔄 PRÓXIMOS PASOS

### Esta semana (11-18 Agosto):
1. ✅ Separar métricas por tipo de token
2. ✅ Reducir threshold de liquidez
3. ⏳ Monitorear las 27 posiciones BD hasta que cierren
4. ⏳ Verificar que el pass rate aumenta con el nuevo threshold

### Semana que viene (18-22 Agosto):
1. Evaluar win rate de micro-cap con datos reales
2. Ajustar TP/SL si es necesario basado en resultados
3. Decisión: ¿Listo para Micro-Live el 1 de Septiembre?

---

## 📝 NOTAS PARA FUTURAS REVISIONES

### ¿Qué revisar primero?

1. **¿Hay trades micro-cap cerrados?**
   ```sql
   SELECT COUNT(*) FROM shadow_positions 
   WHERE signal_type='micro-cap' AND status != 'OPEN';
   ```
   Si es 0, seguir esperando.

2. **¿Cuál es el win rate de micro-cap?**
   ```bash
   node analyze-sniper-metrics.mjs
   ```
   Buscar la sección "MÉTRICAS POR TIPO DE TOKEN"

3. **¿El pass rate aumentó?**
   ```sql
   SELECT DATE(to_timestamp(created_at/1000)) as day,
          ROUND(SUM(CASE WHEN passed=1 THEN 1 ELSE 0 END)::numeric/COUNT(*)::numeric*100, 1) as pass_rate
   FROM sniper_signals GROUP BY day ORDER BY day DESC LIMIT 5;
   ```
   Target: >2% (antes 0.4%)

### Red Flags a monitorear:
- ❌ Win rate micro-cap < 30% → Revisar parámetros TP/SL
- ❌ Pass rate sigue < 1% → Revisar thresholds de validación
- ❌ Posiciones BD nunca cierran → Verificar ExitManager

---

*Documento creado: 11 Agosto 2026*
*Autor: Análisis automatizado + revisión humana*
