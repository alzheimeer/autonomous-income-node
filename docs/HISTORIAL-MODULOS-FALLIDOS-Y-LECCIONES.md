# 📜 Informe Histórico: Módulos Probados, Resultados en Shadow Mode y Lecciones Aprendidas

**Fecha de Consolidación:** Septiembre 2026  
**Proyecto:** Autonomous Income Node (AIN)  
**Autor:** Antigravity AI & Mauricio Quintero

---

## 1. Contexto General
Durante las etapas de desarrollo de `autonomous-income-node`, se implementaron y testearon diversos módulos orientados a generar ingresos autónomos en la blockchain (especialmente en la red L2 **Base**) y en internet. Todos los sistemas pasaron por extensas fases de validación y **Shadow Mode** (operaciones simuladas en tiempo real con datos de mercado reales).

A continuación se detalla el análisis exhaustivo de cada módulo, sus resultados y las razones técnicas/económicas por las cuales fueron catalogados como inviables o descartados.

---

## 2. Desglose de Módulos Probados

### 🎯 A. Micro-Cap Hybrid Sniper (`src/hybrid-sniper/`)
* **Mercado y Entorno:**
  * Red: Base (Ethereum L2).
  * Protocolos DEX: Uniswap V3 y Aerodrome.
  * Fuentes de Ingesta: DexScreener (polling 30s), GeckoTerminal (polling 25s), Bitquery WebSocket y Webhooks de eventos de creación de pares.
  * Objetivo: Detectar y "snipear" tokens recién creados con liquidez inicial antes de que suban de precio.
* **Resultados en Shadow Mode:**
  * Al inicio arrojó un **Win Rate aparente del 99.5%**, lo cual resultó ser un **falso positivo crítico**.
  * **Causa del falso positivo:** Cuando un creador ejecutaba un *rug pull* o retiraba la liquidez, el quoter de Uniswap/Aerodrome lanzaba un error al cotizar la salida (`quote() failed`). El código capturaba la excepción con un simple `continue;`, manteniendo la posición abierta indefinidamente o cerrándola con $0 de PnL en vez de registrar una pérdida del -100%.
  * Una vez corregido el bug de detección de rug pulls y forzado el stop-loss tras 3 fallos de cotización, el **Win Rate real cayó a prácticamente 0%**.
* **Por qué no sirvió (Inviabilidad Real):**
  1. **Asimetría de Infraestructura (Bots MEV):** Para batir a los bots de sniping profesionales en mainnet se requieren RPCs privados de ultra-baja latencia y builders de bloques dedicados (Jito/Flashbots/nodos dedicados), cuya infraestructura cuesta entre $50,000 y $200,000 USD anuales. Usar APIs públicas o WebSockets estándar deja al agente siempre al final de la cola.
  2. **Naturaleza del Mercado de Micro-Caps:** Más del 97% de los tokens creados en L2 son scams premeditados (*honeypots* dinámicos, impuestos ocultos de venta cambiados tras la creación del bloque, remoción de liquidez no bloqueada).
  3. **Comisiones y Slippage:** El deslizamiento en pares de baja liquidez devora cualquier beneficio marginal.

---

### 📈 B. Spot Trading con Análisis Técnico Clásico (`src/trading-validation/`, `src/strategies/`)
* **Mercado y Entorno:**
  * Par: WETH/USDC en Uniswap V3 (Base).
  * Estrategias: Indicadores matemáticos clásicos (EMA 20/50/200, RSI 14, MACD, Bandas de Bollinger, ATR para sizing y Exponente de Hurst para detección de régimen).
* **Resultados en Shadow Mode:**
  * **Win Rate real:** ~10%.
  * Drawdown continuo. El sistema activaba repetidamente el filtro de tendencia macro (`MACRO TREND FILTER`), bloqueando operaciones durante semanas enteras debido a la persistente tendencia lateral o bajista.
* **Por qué no sirvió:**
  1. **Ineficacia de Indicadores Clásicos en Cripto Intradía:** El análisis técnico convencional basado en medias móviles y RSI sobre velas de 5m/15m genera constantes señales falsas por el "ruido" de mercado y la manipulación de ballenas.
  2. **Costes Operativos vs Beneficio:** El spread entre el pool de Uniswap V3 (0.05%), el slippage y el costo de gas de L2 hace que las operaciones con objetivos de ganancia del 1-2% queden anuladas o en negativo.

---

### 🌐 C. Servicios x402 y Conway Cloud (`src/conway/`, `src/services/`)
* **Mercado y Entorno:**
  * Protocolo x402 (HTTP 402 Payment Required): Venta de APIs y servicios de scraping o inteligencia cobrados por petición en micro-pagos USDC.
  * Conway Cloud: Ejecución de microservicios descentralizados.
* **Resultados:**
  * **0 clientes reales.**
  * Conway Cloud sufrió inestabilidades críticas de servicio y quedó sin soporte.
* **Por qué no sirvió:**
  * Ausencia total de adopción y demanda orgánica para el estándar x402 por parte de usuarios externos. Desarrollar infraestructura para un protocolo sin ecosistema de consumidores representó un gasto inútil de recursos.

---

### 🧬 D. Auto-Modificación de Código y Sandbox (`src/self-mod/`)
* **Mecanismo:**
  * Propuestas generadas por LLM (Claude Sonnet / DeepSeek) que escribían código TypeScript en caliente, lo probaban con `pnpm test` en un entorno de pruebas restringido (*sandbox*) y lo aplicaban automáticamente con backups.
* **Resultados:**
  * **Inestabilidad Crítica en Producción:** Solo se logró 1 aplicación exitosa tras decenas de intentos.
  * La generación de código dinámico generaba errores sutiles de tipado, bucles infinitos en ejecución, problemas con librerías nativas y falsos negativos/positivos en las suites de pruebas.
* **Por qué no sirvió:**
  * Permitir que un agente modifique su propio código fuente sin supervisión humana directa introduce una fragilidad arquitectónica inaceptable para un entorno que busca confiabilidad 24/7.

---

## 3. Principios y Memoria Histórica para la Investigación Futura

A partir de estas experiencias empíricas, se establecen las siguientes **Reglas de Oro** que el motor de investigación de AIN debe memorizar de forma permanente:

1. **Rechazo de Mercados de Alta Frecuencia / Sniping:**
   * Descartar automáticamente cualquier oportunidad que dependa de "ser el más rápido" frente a infraestructura MEV o bots con hardware de colocación.
2. **Rechazo de Modelos "Get-Rich-Quick" / Micro-Caps:**
   * Vetar propuestas de tokens de nueva creación, esquemas Ponzi DeFi con APYs astronómicos (>50%) o trading sin ventaja estadística probada (*edge* cuantificable).
3. **Validación de Demanda Real:**
   * Vetar ideas basadas en tecnologías o protocolos abstractos donde no exista un flujo demostrado de clientes y dinero real dispuesto a pagar hoy.
4. **Supervisión Humana en Arquitectura:**
   * La IA investiga, audita, recopila pruebas y estructura los planes de negocio, pero no modifica su propio código de manera autónoma en producción.
