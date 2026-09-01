-- ============================================================================
-- FIX: Corregir datos históricos con lógica de precios invertida
-- Fecha: 15 Agosto 2026
-- 
-- PROBLEMA:
--   El cálculo de PnL estaba invertido:
--     BUG: pnl% = (exit_price - entry_price) / entry_price
--     FIX: pnl% = (entry_price - exit_price) / entry_price
--
--   Esto significa que pnl_usdc tiene el SIGNO INVERTIDO.
--
-- SOLUCIÓN:
--   1. Invertir el signo de pnl_usdc para todas las posiciones cerradas
--   2. Recalcular el status basándose en la relación entry/exit
--   3. Actualizar los contadores de wins/losses
--
-- NOTA: Este script es IDEMPOTENTE - puede ejecutarse múltiples veces sin
--       causar problemas adicionales, pero SOLO DEBE EJECUTARSE UNA VEZ
--       después del fix del código.
-- ============================================================================

-- Paso 1: Crear backup de los datos actuales (por seguridad)
CREATE TABLE IF NOT EXISTS shadow_positions_backup_20260815 AS 
SELECT * FROM shadow_positions;

-- Paso 2: Mostrar estadísticas ANTES del fix
SELECT 'ANTES DEL FIX' as fase;
SELECT 
    status,
    signal_type,
    COUNT(*) as count,
    ROUND(SUM(pnl_usdc)::numeric, 2) as total_pnl,
    ROUND(AVG(pnl_usdc)::numeric, 4) as avg_pnl
FROM shadow_positions
WHERE status != 'OPEN' AND pnl_usdc IS NOT NULL
GROUP BY status, signal_type
ORDER BY signal_type, status;

-- Paso 3: Invertir el signo del PnL para todas las posiciones cerradas
-- IMPORTANTE: Esto solo invierte el signo, no recalcula desde cero
UPDATE shadow_positions
SET pnl_usdc = -pnl_usdc
WHERE status != 'OPEN' 
  AND pnl_usdc IS NOT NULL
  AND closed_at IS NOT NULL;

-- Paso 4: Recalcular el status basándose en la relación entry/exit
-- Si entry_price > exit_price → menos tokens al salir = token subió = TP_HIT
-- Si entry_price < exit_price → más tokens al salir = token bajó = SL_HIT
-- (TIME_STOP y RUG_PULL mantienen su status original)

-- Primero, corregimos los que deberían ser TP_HIT (token subió = menos tokens)
UPDATE shadow_positions
SET status = 'TP_HIT'
WHERE status IN ('TP_HIT', 'SL_HIT')  -- Solo corregimos TP/SL, no TIME_STOP/RUG_PULL
  AND entry_price IS NOT NULL
  AND exit_price IS NOT NULL
  AND exit_price != '0'  -- No es rug pull
  AND CAST(entry_price AS NUMERIC) > CAST(exit_price AS NUMERIC);  -- Menos tokens = ganancia

-- Luego, corregimos los que deberían ser SL_HIT (token bajó = más tokens)
UPDATE shadow_positions
SET status = 'SL_HIT'
WHERE status IN ('TP_HIT', 'SL_HIT')  -- Solo corregimos TP/SL, no TIME_STOP/RUG_PULL
  AND entry_price IS NOT NULL
  AND exit_price IS NOT NULL
  AND exit_price != '0'  -- No es rug pull
  AND CAST(entry_price AS NUMERIC) < CAST(exit_price AS NUMERIC);  -- Más tokens = pérdida

-- Paso 5: Mostrar estadísticas DESPUÉS del fix
SELECT 'DESPUÉS DEL FIX' as fase;
SELECT 
    status,
    signal_type,
    COUNT(*) as count,
    ROUND(SUM(pnl_usdc)::numeric, 2) as total_pnl,
    ROUND(AVG(pnl_usdc)::numeric, 4) as avg_pnl
FROM shadow_positions
WHERE status != 'OPEN' AND pnl_usdc IS NOT NULL
GROUP BY status, signal_type
ORDER BY signal_type, status;

-- Paso 6: Calcular Win Rate real
SELECT 
    signal_type,
    COUNT(*) FILTER (WHERE status = 'TP_HIT') as wins,
    COUNT(*) FILTER (WHERE status = 'SL_HIT') as losses,
    COUNT(*) FILTER (WHERE status = 'TIME_STOP') as time_stops,
    COUNT(*) FILTER (WHERE status = 'RUG_PULL') as rug_pulls,
    COUNT(*) as total,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE status = 'TP_HIT') / 
        NULLIF(COUNT(*) FILTER (WHERE status IN ('TP_HIT', 'SL_HIT')), 0)
    , 1) as win_rate_pct
FROM shadow_positions
WHERE status != 'OPEN'
GROUP BY signal_type;

-- Paso 7: Verificar algunos ejemplos
SELECT 'EJEMPLOS DE POSICIONES CORREGIDAS' as info;
SELECT 
    id,
    signal_type,
    status,
    entry_price,
    exit_price,
    ROUND(pnl_usdc::numeric, 2) as pnl_usdc,
    trade_size,
    -- Verificar que el cálculo es correcto
    ROUND(
        (CAST(trade_size AS NUMERIC) / 1000000) * 
        (CAST(entry_price AS NUMERIC) - CAST(exit_price AS NUMERIC)) / 
        NULLIF(CAST(entry_price AS NUMERIC), 0)
    , 2) as calculated_pnl
FROM shadow_positions
WHERE status != 'OPEN' 
  AND pnl_usdc IS NOT NULL
  AND signal_type = 'micro-cap'
LIMIT 10;
