# GUÍA DE DESARROLLO Y REGLAS DEL PROYECTO (GEMINI.md)

**Proyecto:** Autonomous Research & Intelligence Node (ARIN)  
**Módulo:** `autonomous-income-node`  
**Última actualización:** Septiembre 2026

---

## 🎯 Propósito del Módulo
`autonomous-income-node` ha sido transformado y estabilizado como un **Agente Autónomo de Investigación Continua y Auditoría Profunda**.
Su objetivo es rastrear la web, marketplaces y repositorios de código abierto 24/7 en busca de oportunidades de monetización verídicas, auditando rigurosamente cada candidato para descartar estafas, promesas falsas de venta y modelos inviables antes de notificar a Telegram.

---

## 🛠️ Stack y Entorno
- **Runtime:** Node.js 24 + TypeScript ESM estricto (`tsconfig.research.json`).
- **Gestor de paquetes:** `pnpm`.
- **Base de datos:** SQLite con `better-sqlite3` en `data/research.db` (única base activa).
- **Puerto de servicio:** `3002` (Dashboard y Health Check).
- **Docker:** `ain-research-agent` (basado en `Dockerfile` multi-stage ligero).

---

## 🚫 Módulos Retirados (NO Reintroducir)
Los siguientes componentes fueron probados empíricamente en **Shadow Mode** durante 2026 y catalogados como inviables. Están archivados en `legacy-backup/` y **NUNCA** deben reincorporarse:

1. **`hybrid-sniper/` (Micro-Cap Sniping en Base):** Inviable. Falso win rate inicial (99.5%) por fallos no capturados en `quote()`. Win rate real ~0% por asimetría insalvable frente a bots MEV con hardware de colocación.
2. **`trading-validation/` & `strategies/` (Spot Trading con TA):** Win rate de ~10%, ruido extremo en velas de 5m/15m y comisiones devorando márgenes.
3. **`self-mod/` (Auto-modificación de código en runtime):** Genera inestabilidad crítica, regresiones en tests y caídas de runtime.
4. **`conway/` & `services/` (Servicios x402):** 0 clientes reales y servicios externos discontinuados.

---

## 🧠 Memoria Histórica Obligatoria (`src/research/memory/historical-failures.ts`)
Toda nueva oportunidad descubierta por los scanners en Fase 1 debe pasar obligatoriamente por `matchHistoricalFailure()` antes de cualquier procesamiento:
- Si contiene palabras clave de sniping, memecoins, pump.fun, trading con cruces de EMA/RSI en temporalidades cortas, o APYs irreales (>50%), **se rechaza inmediatamente con veredicto `REJECTED_HISTORICAL`**.

---

## 🔬 Flujo de Trabajo en Dos Fases

### Fase 1: Descubrimiento Continuo (Scanners)
- Scanners modulares en `src/research/scanners/`:
  - `HighSpeedArbitrageScanner`: Poker Texas Hold'em (solvers GTO), arbitraje de apuestas deportivas y prediction markets (surebets), provably fair gaming y arquitecturas de scraping de alta velocidad (Redis Streams + WebSockets + Postgres).
  - `MarketplaceScanner`: Agentes de IA y micro-servicios (NEAR AI, OKX, etc.).
  - `RPAScanner`: Automatización de tareas, extracción y herramientas de datos.
  - `TradingScanner`: Rendimientos estructurales y arbitrajes sostenibles.
  - `GeneralScanner`: Repositorios y discusiones técnicas abiertas.

### Fase 2: Auditoría Profunda (`DeepAuditorEngine`)
- Implementado en `src/research/deep-auditor.ts`:
  - Evalúa factibilidad técnica.
  - Detecta "Sales Traps" (vendedores de cursos, grupos VIP, promesas de ganancias sin riesgo).
  - Veredictos estrictos: `VERIFIED_LEGIT`, `REJECTED_SCAM`, `REJECTED_HISTORICAL`, `INCONCLUSIVE`.

### Notificaciones a Telegram (`src/research/alerts.ts`)
- **Regla inmutable:** No enviar alertas crudas de Fase 1.
- Solo se despachan notificaciones con el **Dossier de Auditoría Completo** cuando la oportunidad obtiene veredicto `VERIFIED_LEGIT` y un **Trust Score $\ge 85$**.

---

## 💻 Comandos de Desarrollo

```bash
# Compilación del módulo activo
pnpm run build

# Pruebas unitarias de auditoría
npx vitest run tests/deep-auditor.test.ts

# Arrancar localmente
pnpm start

# Desplegar / Reconstruir contenedor Docker
docker compose up -d --build
```

---

## 📌 Reglas de Mantenimiento para Agentes de Código
1. **Mantener `data/` limpio:** Solo deben residir `research.db` (+ wal/shm), `research-blacklist.json` y `proposal-history.json`. No generar archivos temporales sueltos.
2. **No romper la independencia de otros proyectos:** Este módulo no debe vincularse ni depender de `agentSeo` ni de `OmniAI-Engine` ni de `CopyTrading`.
3. **Compilación limpia:** Todo cambio en `src/research/` debe validar que `pnpm run build` termine con código de salida 0.
