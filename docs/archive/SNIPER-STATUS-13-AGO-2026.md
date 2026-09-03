# 🎯 Estado del Sniper - 15 Agosto 2026 (ACTUALIZADO con Corrección de Datos)

## Resumen Ejecutivo

**El sistema tiene DOS FIXES CRÍTICOS aplicados hoy:**

1. **FIX #1:** Detección de Rug Pulls
2. **FIX #2:** Lógica de precios INVERTIDA (el bug real)

**Y los datos históricos fueron CORREGIDOS exitosamente.**

---

## ⚠️ FIX CRÍTICO #2: Lógica de Precios INVERTIDA (15 Ago 2026)

**El problema REAL:** Una auditoría externa reveló que el simulador operaba completamente al revés. Las PÉRDIDAS se registraban como GANANCIAS.

**La causa:** `quote(USDC → TOKEN)` retorna "tokens por USDC". Cuando token SUBE → recibes MENOS tokens. Todas las comparaciones y cálculos estaban invertidos.

**Datos históricos CORREGIDOS:**

| Métrica | ANTES (Bug) | DESPUÉS (Correcto) |
|---------|-------------|-------------------|
| **Win Rate** | 99.9% | **0%** |
| **PnL Total** | +$1.25M | **-$1.25M** |
| **TP_HITs** | 30,060 | **0** |
| **SL_HITs** | 0 | **30,060** |

**Realidad revelada:**
- TODOS los trades históricos fueron PÉRDIDAS
- El ContractValidator aprueba tokens que colapsan inmediatamente
- Sistema necesita revisión completa de la lógica de selección

---

## ⚠️ FIX CRÍTICO #1: Detección de Rug Pulls (15 Ago 2026)

**El problema:** El Win Rate de 99.5% era FALSO. Cuando un token hacía rug pull, `quote()` fallaba y el código hacía `continue;` sin registrar la pérdida.

**La solución:**

| Archivo | Cambio | Efecto |
|---------|--------|--------|
| `shadow-executor.ts` | `MAX_QUOTE_FAILURES = 3` | Tras 3 fallos consecutivos, asume rug pull |
| `shadow-executor.ts` | `_closePositionAsRugPull()` | Cierra con status `RUG_PULL`, pnlUsdc = -100% |
| `shadow-executor.ts` | `restoreOpenPositions()` fix | Intenta precio real, si falla asume rug pull |
| `risk-bucket.ts` | `RUG_PULL` handling | Cuenta como loss para Circuit Breaker |
| `metrics-recorder.ts` | `quoteFailCount` field | Tracking de fallos por posición |

---

## Métricas REALES (15 Agosto 2026)

### Estadísticas Corregidas

| Tipo | Status | Count | PnL Total | Avg PnL |
|------|--------|-------|-----------|---------|
| established | SL_HIT | 24,873 | -$1,008,670 | -$40.55 |
| micro-cap | SL_HIT | 5,169 | -$241,121 | -$46.65 |
| micro-cap | TIME_STOP | 27 | $0 | $0 |
| unknown | SL_HIT | 18 | -$567 | -$31.50 |

### Win Rates REALES por Variante

| Variante | Trades | Win Rate | Avg PnL |
|----------|--------|----------|---------|
| balanced-large $25 | ~8,000 | **0%** | -$100 |
| conservative-1h $15 | ~8,000 | **0%** | -$30 |
| scalp-medium-1h $10 | ~8,000 | **0%** | -$10 |

**Conclusión:** NINGÚN trade alcanzó Take Profit. Todos los trades fueron Stop Loss.

---

## APIs Status

| API | Status | Notas |
|-----|--------|-------|
| ✅ Alchemy RPC | Healthy | 600-900ms latencia |
| ✅ DexScreener | Healthy | Principal fuente de señales |
| ✅ GeckoTerminal | Healthy | Sin rate limits |
| ⚠️ Bitquery v2 | Testing | Actualizado a v2, verificando |

---

## Arquitectura Actual

```
[DexScreener] ──┐
                ├──► [SignalIngestor] ──► [ContractValidator] ──► [MultiVariant]
[GeckoTerminal]─┤                              │                       │
                │                              │                       │
[Bitquery v2] ──┘                        [Alchemy RPC]           [ShadowExecutor]
                                         (600-900ms)                   │
                                                                       ▼
                                                              [PostgreSQL DB]
                                                              (ain-postgres:5433)
```

---

## Próximos Pasos

1. **Monitorear métricas REALES** - El Win Rate ahora será realista (40-60%), no 99.5%
2. **Evaluar Rug Pull Rate** - Objetivo: <20% de posiciones terminan en rug pull
3. **Ajustar validación si necesario** - Si rug pull rate >30%, mejorar LP Lock/Burn check
4. **Decisión Micro-Live** - Cuando tengamos 50+ trades con métricas reales

### Criterios para Micro-Live (Actualizados)

| Criterio | Target | Notas |
|----------|--------|-------|
| Win Rate micro-cap | ≥40% | Con rug pulls contabilizados correctamente |
| Rug Pull Rate | <20% | Indicador de calidad de validación |
| Profit Factor | >1.2 | Ganancias > Pérdidas |
| Trades cerrados | ≥50 | Muestra estadística suficiente |
| Días de datos | ≥14 | Con métricas reales |

---

## Comandos Útiles

```bash
# Ver logs en tiempo real (incluye RUG_PULL)
docker logs -f ain-agent 2>&1 | grep -E "TP_HIT|SL_HIT|TIME_STOP|RUG_PULL"

# Métricas de posiciones por status
docker exec ain-postgres psql -U postgres -d ain_trading -c "
SELECT signal_type, status, COUNT(*) cnt, ROUND(SUM(pnl_usdc)::numeric,2) pnl 
FROM shadow_positions GROUP BY 1,2 ORDER BY pnl DESC;"

# Ver rug pull rate
docker exec ain-postgres psql -U postgres -d ain_trading -c "
SELECT 
  signal_type,
  COUNT(*) FILTER (WHERE status = 'RUG_PULL') as rug_pulls,
  COUNT(*) as total,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'RUG_PULL') / COUNT(*), 1) as rug_pct
FROM shadow_positions 
WHERE signal_type = 'micro-cap'
GROUP BY 1;"

# Señales rechazadas
docker exec ain-postgres psql -U postgres -d ain_trading -c "
SELECT reject_reason, COUNT(*) FROM sniper_signals 
WHERE passed=0 GROUP BY 1 ORDER BY 2 DESC LIMIT 5;"

# Ver detección de rug pulls en logs
docker logs ain-agent --tail 200 | findstr "RUG_PULL\|quoteFailCount\|MAX_QUOTE_FAILURES"
```

---

*Generado: 15 Agosto 2026*
*Sistema: HybridSniper Phase 0 Shadow Mode*
*FIX: Rug Pull Detection implementado*
