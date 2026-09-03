# 🔧 Fixes Implementados — 12 Agosto 2026

## Resumen de Cambios

### 1. Separación de Métricas por Tipo de Token ✅
**Archivos:** `src/hybrid-sniper/metrics-recorder.ts`

- Nueva columna `signal_type` en `shadow_positions`
- Auto-detección: WETH/USDC/DAI/cbETH/cbBTC → "established", resto → "micro-cap"
- Migración SQL aplicada a datos existentes

**Por qué:** Los trades de pares establecidos tienen spread ~0 y siempre ganan, contaminando las métricas reales de micro-cap.

### 2. Reducción del Threshold de Liquidez ✅
**Archivo:** `src/hybrid-sniper/contract-validator.ts`

| Parámetro | Antes | Después |
|-----------|-------|---------|
| MIN_LIQUIDITY_USDC | $3,000 | $1,000 |
| MIN_LIQUIDITY_WETH | N/A | 0.4 ETH |

**Resultado:** INSUFFICIENT_LIQUIDITY bajó de 46% a 28%

### 3. Restauración de Posiciones al Reiniciar ✅
**Archivos:** 
- `src/hybrid-sniper/shadow-executor.ts` - Nuevo método `restoreOpenPositions()`
- `src/hybrid-sniper/metrics-recorder.ts` - Nuevo método `getOpenPositions()`

**Problema resuelto:** 27 posiciones micro-cap quedaban OPEN en DB pero nunca cerraban tras reiniciar container.

**Comportamiento:**
1. Al iniciar, lee posiciones OPEN de DB
2. Si `time_stop < now`: cierra con TIME_STOP, pnl=0
3. Si aún válida: restaura a memoria para continuar monitoreo

### 4. Cierre Manual de Posiciones Expiradas ✅
**Query ejecutada:**
```sql
UPDATE shadow_positions 
SET status = 'TIME_STOP', closed_at = NOW(), exit_price = entry_price, pnl_usdc = 0 
WHERE status = 'OPEN' AND signal_type = 'micro-cap' AND time_stop < NOW();
```

**Resultado:** 27 posiciones cerradas con TIME_STOP

---

## Estado Actual (12 Agosto 2026, 01:17 UTC)

### Métricas de Posiciones
| Tipo | Status | Count | PnL |
|------|--------|-------|-----|
| established | TP_HIT | 4,149 | +$134,470 |
| micro-cap | TIME_STOP | 27 | $0 |
| unknown | TP_HIT | 18 | +$567 |

### Pass Rate (últimas 24h)
| Día | Total | Pasaron | Pass Rate | INSUFFICIENT_LIQ |
|-----|-------|---------|-----------|------------------|
| 12 ago | 177 | 2 | 1.13% | 28% |
| 11 ago | 6,502 | 59 | 0.91% | 46% |
| 10 ago | 5,433 | 0 | 0.00% | 44% |

### Módulos
- ✅ hybrid-sniper: healthy
- ✅ trading: healthy
- ✅ react-loop: healthy
- ✅ Todos los módulos: healthy

---

## Verificación

### Confirmar restauración de posiciones funciona:
```bash
docker logs ain-agent | findstr "restoreOpenPositions"
# Debe mostrar: "restoreOpenPositions: completed"
```

### Confirmar threshold de liquidez funciona:
```bash
docker logs ain-agent | findstr "liquiditySource"
# Debe mostrar algunas con "WETH" (antes solo USDC)
```

### Ver métricas separadas:
```bash
docker exec ain-postgres psql -U postgres -d ain_trading -c \
  "SELECT signal_type, status, COUNT(*), SUM(pnl_usdc) FROM shadow_positions GROUP BY signal_type, status;"
```

---

## Próximos Pasos

1. **Monitorear 24-48h** para ver si pass rate sube a >2%
2. **Esperar primeros trades micro-cap reales** (no TIME_STOP)
3. **Evaluar win rate micro-cap** cuando haya 50+ trades cerrados
4. **Decisión para Mes 2:** 22 Agosto 2026
