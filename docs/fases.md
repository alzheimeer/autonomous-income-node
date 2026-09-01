# Hoja de Ruta: De Shadow Trading a Operación en Real

Este documento establece la línea de tiempo oficial y los pasos estratégicos para la fase de investigación cuantitativa del bot **Autonomous Income Node**, asumiendo como fecha de inicio el **8 de Agosto de 2026**.

> **Última actualización:** 13 de Agosto de 2026

---

### 🚨 Revisión Temprana de Estabilidad — ✅ COMPLETADA
**Fecha Ejecutada:** 9 de Agosto de 2026
* **Resultado:** Sistema estable, PostgreSQL funcionando correctamente.
* **Acciones realizadas:**
  1. ✅ Logs revisados — sin errores de memoria ni bloqueos
  2. ✅ PostgreSQL validado — inserciones consistentes en `shadow_positions`
  3. ✅ CPU/RAM estables
* **Conclusión:** Arquitectura PostgreSQL resiliente. Sistema operando 24/7 sin intervención.

---

### Fase 1: Recolección de Datos Puros (Shadow Trading) — 🟢 EN PROGRESO
**Fechas:** 8 de Agosto - 22 de Agosto de 2026 (1 a 2 Semanas)
**Progreso actual:** Día 5 de 14 (13 de Agosto 2026)

* **Objetivo:** Dejar que el bot corra en modo *Shadow Trader* (simulado) para recolectar un tamaño de muestra estadísticamente significativo.
* **Acciones:** 
  - ✅ Bot encendido `24/7` desde el 8 de agosto
  - ✅ Sistema multi-variante activo con 3 configuraciones
  - ⏳ Recolectando datos en diferentes regímenes de mercado
* **Métrica Esperada:** Alcanzar entre 100 y 300 operaciones simuladas por variante de estrategia.

#### 📊 Métricas Actuales (13 Agosto 2026)

| Variante | Trades | Win Rate | PnL Simulado | Promedio |
|----------|--------|----------|--------------|----------|
| **Balanced Large $25** | 36 | 100% | $3,598 | $99.94 |
| **Conservative 1h** | 36 | 100% | $1,080 | $30.00 |
| **Scalp Medium 1h** | 36 | 100% | $360 | $10.00 |
| **Sin variante (legacy)** | 30 | 10% | $140 | — |
| **TOTAL** | 138 | 80.4% | $5,178 | $37.52 |

**Notas:**
- Las 3 variantes nuevas tienen **0 SL_HITs** y **100% WR**
- Los trades "sin variante" son legacy antes del fix de `variant_id`
- Los 27 TIME_STOP son de un token problemático (0x252d...a65)

### Fase 2: Análisis de Supervivencia y Selección
**Fechas:** 22 de Agosto - 24 de Agosto de 2026
* **Objetivo:** Ejecutar los scripts analíticos sobre la base de datos de PostgreSQL para encontrar las estrategias ganadoras.
* **Scripts disponibles:**
  - `scripts/quick-stats.mjs` — Métricas rápidas por variante
  - `scripts/analyze-variant-metrics.mjs` — Análisis detallado
* **Criterios de Éxito:**
  - **Profit Factor:** Mayor a `1.5`.
  - **Win Rate:** Consistente, idealmente mayor al `55%`.
  - **Drawdown:** Rachas perdedoras tolerables que no amenacen el capital.
* **Acciones:** Descartar las variantes ineficientes y quedarse con las 1 o 2 mejores.

**Proyección actual:** Con 80.4% WR y $5,178 PnL en 5 días, las 3 variantes actuales lucen prometedoras. Se decidirá cuál escalar basado en los datos completos de 14 días.

### Fase 3: Paper Trading Avanzado (Condiciones Ásperas)
**Fechas:** 24 de Agosto - 31 de Agosto de 2026
* **Objetivo:** Ajustar el simulador de las estrategias ganadoras para que emulen las penalizaciones del mundo real.
* **Acciones:**
  - Configurar penalizaciones de *Slippage* (deslizamiento de precio).
  - Incluir el costo exacto de los *Fees* del exchange (Binance / OKX) en el cálculo del PnL.
* **Importancia:** Muchas estrategias sobreviven al Shadow Trading pero mueren al pagar comisiones. Si la estrategia supera esta fase, es genuinamente robusta.

### Fase 4: Despliegue con Micro-Capital (Skin in the Game)
**Fecha Estimada:** 1 de Septiembre de 2026
* **Objetivo:** Conectar las API Keys del exchange y operar con dinero real pero riesgo minúsculo.
* **Presupuesto:** $20 a $50 dólares.
* **Acciones:** 
  - Validar la capa de red: firmas criptográficas, latencia de conexión, límites y errores de lotaje (decimals).
  - El objetivo **no es ganar dinero aún**, sino comprobar que el bot ejecuta físicamente lo mismo que el simulador prometió.

### Fase 5: Escalado Dinámico
**Fecha Estimada:** Septiembre en adelante
* **Objetivo:** Incrementar el capital de forma progresiva.
* **Escalado Sugerido:** $500 ➡️ $2,000 ➡️ $10,000+.
* **Seguridad (Killswitches):** Se debe configurar una regla inquebrantable de "Pérdida Máxima Diaria" (ej. Si el bot pierde un 3% en un día, se apaga automáticamente y vende todo a dólares) para proteger las ganancias a medida que crece la cuenta.

---

## 📅 Timeline Visual

```
Agosto 2026
├── 08 │ ████████████████████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │ Fase 1 INICIO
├── 13 │ ████████████████████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │ HOY (Día 5/14)
├── 22 │                                          ██████████░░░░░░░░░░░░░░░░░░░░░ │ Fase 2 (Análisis)
├── 24 │                                                    ██████████████████░░░ │ Fase 3 (Paper+Costos)
└── 31 │                                                                      ███ │ Fase 3 FIN

Septiembre 2026
├── 01 │ ████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │ Fase 4 (Micro-capital REAL)
└── ?? │ ████████████████████████████████████████████████████████████████████████ │ Fase 5 (Escalado)
```

---

## ⚠️ Riesgos Identificados

1. **Rate limiting de GeckoTerminal** — Afecta descubrimiento de micro-caps (mitigado con pause automático)
2. **Bitquery deshabilitado** — Plan limit alcanzado, sin renovar
3. **Tokens sin liquidez** — Muchas señales micro-cap fallan el quote (comportamiento esperado)

---

## 🎯 Próximos Hitos

| Fecha | Hito | Estado |
|-------|------|--------|
| 9 Ago | Revisión de estabilidad | ✅ Completado |
| 15 Ago | 100+ trades por variante | ⏳ En progreso |
| 22 Ago | Fin de Fase 1 | ⏳ Pendiente |
| 24 Ago | Selección de variante ganadora | ⏳ Pendiente |
| 1 Sep | Trading con capital real ($20-50) | ⏳ Pendiente |
