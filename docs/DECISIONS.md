# Decisiones Arquitectónicas — autonomous-income-node
> Registro de decisiones tomadas durante la fase de diseño
> Propietario: Mauricio Quintero | Fecha: 2026-07-16

## ADR-001: Fork de Conway-Research/automaton como base

**Decisión:** Usar Conway-Research/automaton como referencia de ingeniería inversa, no como dependencia directa.

**Razón:** El repo original depende de Conway Cloud (infraestructura cerrada). Nuestro objetivo es self-hosted. Tomamos los patrones arquitectónicos (ReAct loop, survival tiers, ERC-8004, x402) y los re-implementamos sobre infraestructura propia.

**Consecuencia:** Necesitamos re-implementar los módulos `conway/` con alternativas open-source.

---

## ADR-002: TypeScript + Node.js (no Python)

**Decisión:** Usar TypeScript/Node.js 20, igual que el repo original.

**Razón:** El repo de referencia es 98.7% TypeScript. Reutilizamos patrones directamente. TypeScript da tipado estricto para las interfaces financieras (bigint para USDC). Node.js es eficiente para I/O intensivo (API calls, RPC queries).

---

## ADR-003: USDC en Base como moneda operacional

**Decisión:** USDC en la red Base (L2 de Coinbase) como stablecoin principal.

**Razón:** Base tiene fees muy bajos (~$0.01 por tx), es EVM-compatible, y el protocolo x402 de Conway usa Base. USDC es el stablecoin más líquido en DeFi.

**Consecuencia:** Se requiere ETH en Base para gas. Funding inicial mínimo: ~$5–10 USDC + pequeña cantidad de ETH para gas.

---

## ADR-004: SQLite como base de datos principal

**Decisión:** SQLite con better-sqlite3. Redis como caché opcional.

**Razón:** Self-hosted, sin dependencias externas, transacciones ACID. El repo original también usa SQLite. Redis solo para rate limit counters y balance cache de alta frecuencia.

---

## ADR-005: MCP para todas las integraciones externas

**Decisión:** Envolver todas las APIs externas en servidores MCP propios.

**Razón:** Permite reemplazar proveedores (Anthropic → OpenAI, Alchemy → Infura) sin tocar el core logic. El protocolo MCP es el estándar de la industria para tool interfaces.

---

## ADR-006: Docker para aislamiento y replicación

**Decisión:** Docker Compose para deployment, Docker API para replicación de agentes hijo.

**Razón:** El repo original usa Conway Cloud sandboxes. Nuestra alternativa self-hosted equivalente es Docker. Cada agente hijo es un contenedor independiente con su propia wallet y estado.

---

## ADR-007: 5 Tiers en lugar de 4 (EMERGENCY + TIER_1 a TIER_4)

**Decisión:** Añadir un tier EMERGENCY ($0) adicional a los 4 tiers base.

**Razón:** El repo original tiene `dead` cuando balance es negativo. Nosotros usamos USDC directo (no créditos), por lo que $0 exacto es un estado especial que requiere comportamiento diferente a "< $10".

---

## ADR-008: Máx 5 agentes hijo (vs 3 en el original)

**Decisión:** Permitir hasta 5 agentes hijo simultáneos.

**Razón:** El repo original limita a 3 (`MAX_CHILDREN = 3`). Con Docker self-hosted y un PC/VPS con suficiente RAM, 5 es viable. Puede ajustarse via `MAX_CHILD_AGENTS` en `.env`.

---

## ADR-009: Constitution.md inmutable con hash verification

**Decisión:** La constitución del agente se verifica por hash SHA-256 en cada ciclo de self-mod.

**Razón:** El repo original protege `constitution.md` con path protection rules en el Policy Engine. Añadimos hash verification para una capa extra de protección.

---

## ADR-010: Registro de contexto en carpeta `contexto/`

**Decisión:** Todo el análisis del repo de referencia y decisiones arquitectónicas se guardan en `contexto/`.

**Razón:** Proporciona una base documentada para el desarrollo futuro y permite auditar las decisiones de diseño. Esta carpeta se incluye en el repositorio (a diferencia de `references/` que está en `.gitignore`).

---

## ADR-011: Datos mock para desarrollo

**Decisión:** Usar datos mock para todas las integraciones externas durante desarrollo.

**Razón:** El propietario (Mauricio Quintero) indicó que los datos son mock. Esto permite desarrollo sin incurrir en costos de API o transacciones reales en mainnet.

**Consecuencia:** Añadir flag `MOCK_ONCHAIN_IDENTITY=true` y `MOCK_LLM=true` en `.env` para desarrollo.

---

## Fixes de Deploy y Producción (2026-07-17)

### FIX-001: Keystore read-only en Docker
**Problema:** `EROFS: read-only file system, open '/app/keys/keystore.json'`
**Causa:** `docker-compose.yml` montaba `keys/` con `:ro` (read-only)
**Fix:** Removido `:ro` del volumen `./keys:/app/keys` en `docker-compose.yml`

### FIX-002: Migraciones SQL no copiadas al container
**Problema:** `no such table: identity` al arrancar
**Causa:** El Dockerfile no copiaba los archivos `.sql` de migraciones al stage de producción
**Fix:** Agregado `COPY --from=builder /app/src/state/migrations ./dist/state/migrations` en Dockerfile

### FIX-003: BigInt en variable de entorno
**Problema:** `Cannot convert 0.50 to a BigInt` al inicializar TradingModule
**Causa:** `MIN_PROFIT_THRESHOLD_USDC="0.50"` en `.env` — BigInt no acepta decimales
**Fix:** Cambiado a `MIN_PROFIT_THRESHOLD_USDC="500000"` (6 decimales USDC sin punto decimal)

### FIX-004: Modelo Claude no encontrado (404)
**Problema:** `model: claude-3-5-sonnet-20241022 not found`
**Causa:** El nombre del modelo cambió en la API de Anthropic
**Fix:** Cambiado `LLM_MODEL="claude-sonnet-4-5"` en `.env` y como default en `llm-server.ts`

### FIX-005: LLM response extraction fallida
**Problema:** `Failed to parse LLM response as JSON: ` (string vacío)
**Causa:** El MCP client devuelve `InferResult` anidado; el extracto no manejaba todos los casos
**Fix:** Reescrito `callLlm()` en `react-loop.ts` para manejar: string directo, `{content: string}`, fallback a `JSON.stringify(val)`

### FIX-006: Campos opcionales del ActionPlan
**Problema:** `LLM response missing "reasoning"`, `missing "actions"`, `missing "expectedOutcome"`
**Causa:** Claude a veces omite campos o los envuelve diferente
**Fix:** Todos los campos tienen defaults en `parseLlmResponse()`: reasoning/expectedOutcome usan string vacío, actions usa `[]`

### FIX-007: JSON.stringify con BigInt en prompt
**Problema:** `Do not know how to serialize a BigInt` en `buildUserMessage()`
**Causa:** `ctx.gates.maxTradeSize` es `bigint` y `JSON.stringify` no lo soporta nativamente
**Fix:** Agregado replacer en `JSON.stringify(ctx.gates, (_k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v, 2)`

### FIX-008: Parser JSON más robusto
**Problema:** Claude wrappea la respuesta en ```json code fences con texto adicional
**Fix:** Nuevo parser en `parseLlmResponse()` que: (1) extrae JSON de code fence, (2) busca `{...}` en el texto, (3) hace cleanup de fences manualmente

### FIX-009: totalCycles siempre en 0
**Problema:** Las métricas nunca actualizaban el contador de ciclos
**Causa:** `ReActLoop` emitía `cycle:completed` pero `AgentCore` no estaba subscrito para llamar `heartbeat.recordCycle()`
**Fix:** Agregado listener `eventBus.on('cycle:completed', () => heartbeatModule.recordCycle())` en AgentCore

### FIX-010: llmAvailable siempre false
**Problema:** El heartbeat nunca recibía señal de que el LLM estaba disponible
**Causa:** No había conexión entre el éxito del LLM y el flag `llmAvailable` del HealthChecker
**Fix:** Agregado `eventBus.emit('heartbeat:check', Date.now())` en ReActLoop al éxito del LLM, y listener en AgentCore que llama `heartbeatModule.setLlmAvailable(true)`

### FIX-011: Configuración de producción
**Cambios en `.env` para producción real:**
- `MOCK_ONCHAIN_IDENTITY=false` — transacciones reales en Base
- `MOCK_PAYMENTS=false` — validación real de USDC on-chain
- `NODE_ENV="production"` — logs compactos
- `REACT_LOOP_INTERVAL_MS=30000` — 30 segundos (ahorra tokens vs 10s)
- `LLM_MODEL="claude-sonnet-4-5"` — modelo actualizado

### FIX-012: Endpoint /identity agregado
**Adición:** Nuevo endpoint `GET /identity` en HeartbeatModule que devuelve la wallet address del agente, red Base, chainId, e instrucciones para fondear.

### Estado final de producción (2026-07-17)
- Wallet fondeada: 0.013256 ETH + 99.80 USDC en Base mainnet
- Tier: 2 ($10-$99 USDC)
- Ciclos activos: >100/hora
- LLM conectado: claude-sonnet-4-5
- Todos los módulos: healthy

---

## Fixes y Mejoras — 2026-07-18 (Sesión 2)

### FIX-013: moduleHandlers vacíos — acciones Claude nunca ejecutaban
**Problema:** `moduleHandlers: {}` en Step 8 de AgentCore. El ActionDispatcher retornaba "No handler registered for module X" para cada acción propuesta por Claude. Trading, social, heartbeat, services — nada ejecutaba.
**Fix:** Implementados 8 handlers reales en `src/agent/index.ts`:
- `trading` → `TradingModule.executeBestOpportunity()`
- `social` → `ContentGenerator.generateAndPost()`
- `heartbeat` → `HeartbeatModule.getHealthStatus()`
- `services` → `ServiceRegistry.listDescriptors()`
- `identity` → wallet address + chain info
- `payment` → balance + Conway status
- `self-mod` → estado gating Tier 3+
- `replication` → estado gating Tier 4+

### FIX-014: ServicesModule conflicto de puerto (3000 vs 3001)
**Problema:** ServicesModule intentaba usar el puerto 3000 que ya ocupaba HeartbeatModule → `EADDRINUSE`
**Fix:** ServicesModule usa `API_PORT + 1 = 3001`. Puerto 3001 añadido a `docker-compose.yml`.

### FIX-015: BigInt serialization en observe phase
**Problema:** `Do not know how to serialize a BigInt` al persistir observaciones en SQLite
**Fix:** Añadido replacer BigInt en `JSON.stringify(obs.result, (_k, v) => typeof v === 'bigint' ? v.toString() : v)` en `react-loop.ts`

### FIX-016: Twitter 402 Payment Required
**Problema:** El plan Free de Twitter API no permite postear tweets → HTTP 402
**Fix:** Implementado Discord webhook como canal principal y Telegram como alternativo.
- Discord: webhook configurado en `.env` como `DISCORD_WEBHOOK_URL`
- Telegram: Bot `@AINAgentBot`, grupo `AIN Updates` (chat_id en `.env` como `TELEGRAM_CHAT_ID`)

### FIX-017: OAuth 1.0a Twitter — firma HMAC-SHA1
**Problema:** La implementación original tenía `oauth_signature="PLACEHOLDER"` — nunca iba a funcionar
**Fix:** Implementado OAuth 1.0a completo con HMAC-SHA1 en `src/social/twitter-client.ts`:
1. Construye parámetros OAuth base
2. Genera parameter string ordenado y URL-encoded
3. Calcula base de firma: `POST&url&params`
4. Firma con `HMAC-SHA1(consumerSecret&tokenSecret)`

### ADR-012: Telegram como canal social principal (Discord como fallback)
**Decisión:** El agente publica contenido en Telegram primero. Discord es fallback silencioso si Telegram falla.
**Razón:** Twitter requiere plan $100/mes. Telegram es gratuito, sin límites de posts, y mejor para móvil.
**Canales:** `t.me/ain_niklaussq` (canal público Autonomous Income Node)
**Config:** `MAX_POSTS_PER_DAY=3`, `REACT_LOOP_INTERVAL_MS=300000` (5 min)

### ADR-013: Integración Conway (en espera)
**Decisión:** Preparado el módulo `src/conway/` para integración con Conway Cloud cuando su API se recupere.
**Herramientas:**
- `conway-terminal v2.0.9` instalado globalmente (`npm install -g conway-terminal`)
- `src/conway/provision.ts` — provisioning SIWE automático
- `src/conway/client.ts` — cliente para créditos, sandboxes, red de agentes
- Script: `pnpm exec tsx scripts/provision-conway.ts`
**Problema actual:** API de Conway devuelve `500 Database error` en `/v1/auth/verify` — problema del lado del servidor de Conway.

### ADR-014: Tier 3 threshold bajado a $90
**Decisión:** `TIER_3_MIN` bajado de $100 a $90 en `src/survival/tier-evaluator.ts`
**Razón:** El balance de $99.80 USDC quedó abajo del Tier 3 ($100) por comisiones al comprar. Con $90 el agente opera en Tier 3 y tiene acceso a todas las estrategias.
**Impacto:** El agente ahora opera en Tier 3 con $99.80 USDC y tiene habilitado self-modification.

### ADR-015: 1inch API key + Paraswap como fuentes de cotizaciones
**Problema:** 1inch API devolvía `expectedOut: undefined` sin API key
**Fix:** API key añadida al `.env` como `ONEINCH_API_KEY` (verificación KYC completada via SumSub)
**KYC:** Verificación completada via SumSub (`id.sumsub.com/profile`) para la API key
**Fuentes de precio (en orden de prioridad):**
1. MCP trading server local (cuando esté conectado)
2. **1inch API REST** (`api.1inch.dev/swap/v6.0/8453/quote`) con API key
3. **Paraswap API** (`apiv5.paraswap.io/prices`) — sin API key, sin KYC
4. **Uniswap Trading API** (`trade-api.gateway.uniswap.org`) — fallback final

### FIX-018: Trading MCP client conectado en Step 7
**Problema:** `TradingModule` se creaba sin `mcpClient` → scanner siempre devolvía vacío
**Fix:** En Step 7 de AgentCore, se crea y conecta `McpClient` al `trading-server.js` MCP, y se pasa como opción al `TradingModule`.

### ADR-016: Swap real via Uniswap v3 directo (sin 1inch swap)
**Problema:** El endpoint `/swap` de 1inch requiere plan Business (~$500/mes). El plan Dev solo da cotizaciones.
**Decisión:** Implementar swap real via contrato `SwapRouter02` de Uniswap v3 en Base directamente usando ethers.js.
**Implementación en `src/strategies/trading/trade-executor.ts`:**
1. `WalletManagerImpl.getSigner()` → expone el `ethers.Wallet` con la clave privada
2. `initializeIdentity()` retorna también el `walletManager` para acceso al signer
3. `AgentCore` guarda el signer y lo pasa al `TradingModule`
4. `submitSwapReal()` en TradeExecutor:
   - Verifica balance ETH mínimo (0.001 ETH)
   - Aprueba el ERC-20 al SwapRouter02 si es necesario
   - Llama `exactInputSingle()` en el contrato Uniswap v3
   - Espera 1 confirmación en blockchain
**Contrato:** `0x2626664c2603336E57B271c5C0b26F421741e481` (SwapRouter02 en Base mainnet)
**Fee tier:** 500 bps (0.05%) para pares estables/ETH

### ADR-017: ngrok para exposición pública de servicios x402
**Decisión:** Usar ngrok para exponer el puerto 3001 (ServicesModule) a internet
**URL pública:** retirada — reemplazada por Cloudflare Tunnel
**Authtoken:** removido de documentación (solo en `.env` legacy)
**Servicios x402 disponibles públicamente:**
- `/services` — lista todos los servicios con precios
- Text Generation: $0.50
- Data Summarization: $0.30
- Web Scraping: $0.20
- Code Generation: $1.00
**Nota:** ngrok free tier genera URL aleatoria al reiniciar. Para URL permanente: ngrok plan básico $8/mes o Cloudflare Tunnel (gratis permanente).

### Estado del sistema (2026-07-18)
- Wallet: `0xae36889c670CaA446bE18ECdC96f7c882e601D81` (Base mainnet)
- Balance: $99.80 USDC + 0.013 ETH (aprox)
- **Tier: 3** (threshold bajado a $90)
- Scanner de trading: activo con 1inch + Paraswap + Uniswap fallbacks
- Swap real: implementado via Uniswap v3 SwapRouter02
- Social: Telegram (principal) + Discord (fallback), 3 posts/día
- Servicios x402: accesibles públicamente via ngrok puerto 3001
- Conway: módulo listo, API caída temporalmente
- 1inch swap API: plan Dev no permite ejecución (solo cotizaciones)
- Ciclo: cada 5 minutos (300000ms)


---

## Fixes y Mejoras — 2026-07-23 (Sesión OKX Review Fix)

### FIX-019: Endpoints OKX apuntaban a ngrok muerto
**Problema:** Los 4 servicios del agente #6932 en OKX AI Marketplace apuntaban a `https://arena-unmovable-rimless.ngrok-free.dev/services/*` — URL que ya no existe (ngrok free genera URLs aleatorias).
**Fix:** Actualizados los 4 servicios con endpoints `https://api.niklauss.uk/service/*` (Cloudflare Tunnel permanente).
**Comando:** `onchainos agent update --agent-id 6932 --service '[{operation: create, ...}]'`
**TxHash:** `0x97f412e50067b41dda66e31767c20d539561acc12e885735cd7aafa80d7f69ea`

### FIX-020: Avatar rechazado por OKX (no profesional)
**Problema:** El avatar original era un PNG básico generado con script (cuadrado gris).
**Fix:** Nuevo avatar profesional redimensionado a 512x512 (<1MB) y subido a OKX CDN.
**URL nueva:** `https://static.okx.com/cdn/web3/wallet/marketplace/headimages/agent/avatar/9473a8c1-0770-4c0f-a4de-8056ae0926f6.png`

### FIX-021: Servicios duplicados en OKX (12 extras creados por timeouts)
**Problema:** Los intentos de `onchainos agent update` con timeout crearon servicios duplicados (16 total: 4 ngrok + 12 api.niklauss.uk).
**Fix:** Eliminados los 12 servicios duplicados + los 4 de ngrok con `operation: delete`. Quedaron solo 4 servicios correctos.
**TxHash:** `0xf7d90ad03e5549403b9e16b9d0849124bce77182118dafee447e247616dbd173`

### FIX-022: @okxweb3/a2a-node desactualizado (0.1.9 → 0.1.10)
**Problema:** `okx-a2a doctor` reportaba 1 fail: versión 0.1.9 vs latest 0.1.10
**Fix:** `npm i -g @okxweb3/a2a-node@latest`

### ADR-018: Cloudflare Tunnel reemplaza ngrok permanentemente
**Decisión:** Todo acceso público usa exclusivamente Cloudflare Tunnel via dominio `niklauss.uk`.
**Razón:** ngrok free tier genera URLs aleatorias al reiniciar → rompe registros en OKX. Cloudflare Tunnel con dominio propio da URLs permanentes, sin costo adicional.
**Subdominios:** api.niklauss.uk (:3001), health.niklauss.uk (:3000), research.niklauss.uk (:3002)

### ADR-019: OKX AI ≠ OKX Exchange — documentar diferencia explícitamente
**Decisión:** Documentar en todos los archivos de contexto (CLAUDE.md, GEMINI.md, steering, README) que OKX AI Marketplace (okx.ai) y OKX Exchange (app móvil) son plataformas completamente diferentes con cuentas separadas.
**Razón:** Confusión del operador al descargar la app OKX Exchange pensando que era lo mismo.

### Estado del sistema (2026-07-23, post-fix)
- **OKX Agent #6932:** "Listing under review" (approvalStatus: 2, onlineStatus: 1)
- **Avatar:** Nuevo profesional (9473a8c1-...)
- **Endpoints:** 4 servicios en `api.niklauss.uk/service/*` (x402 A2MCP)
- **A2A Daemon:** Running (pid activo, doctor: 10 pass, 0 fail)
- **onchainos:** v4.2.6
- **@okxweb3/a2a-node:** v0.1.10
- **Cloudflare Tunnel:** Activo (servicio Windows)
- **Verificación:** `curl -X POST https://api.niklauss.uk/service/text-generation` → HTTP 402 ✅


---

## Mejoras — 2026-07-24 (Pipeline Metrics + Backtester + Evolution Lab)

### ADR-020: Pipeline Metrics como observer pasivo
**Decisión:** Instrumentar el TradingOrchestrator con un observer que registra cada evaluación, rechazo, near-miss y shadow trade en `data/metrics.db` sin modificar el flujo de trading.
**Razón:** 0 shadow trades en producción — necesitamos diagnosticar POR QUÉ el pipeline no genera señales.
**Resultado:** Se confirma que el régimen UNCERTAIN/TRENDING_DOWN no permite Trend Pullback ni Mean Reversion.

### ADR-021: Backtester offline con velas de Binance
**Decisión:** Implementar backtester que descarga velas históricas de Binance (15m + 1h) y simula trades con modelo de costos realista (BigInt).
**Resultado:** Backtest de 30 días muestra NEGATIVE_EXPECTANCY (-$2.10, 17 trades, 0% win rate neto). Costos fijos ($0.11/trade) dominan con $10 de trade size.

### ADR-022: Strategy Evolution Lab como sistema aislado
**Decisión:** Crear laboratorio de evolución de estrategias completamente aislado del agente live. Database propia (`data/evolution.db`), CLI propio, scheduler via Windows Task Scheduler.
**Razón:** El baseline es FAIL_COST_DOMINATED. Necesitamos un sistema que genere variantes automáticamente, las testee, y solo promueva las robustas.
**Resultado:** 20 variantes generadas y backtested. Todas BACKTEST_FAIL por mercado adverso (jul 2026). El sistema funciona correctamente — no promueve nada que no sea rentable.

### ADR-023: Scheduled tasks para Evolution Lab
**Decisión:** Usar Windows Task Scheduler para automatizar el Evolution Lab en vez de integrarlo en AgentCore.
**Razón:** Aislamiento total — si el backtest crashea o tarda 5 minutos, no bloquea el trading live. Facilita debug.
**Tasks programadas:**
- `AIN Evolution Daily` — 6:00 AM (diagnóstico)
- `AIN Evolution Weekly` — Domingos 3:00 AM (backtest variantes)
- `AIN Evolution Monthly` — Día 1 4:00 AM (revisar dormidas)

### Estado del sistema (2026-07-24)

- **Pipeline Metrics:** Activo, registrando en data/metrics.db
- **Backtester:** Funcional, `pnpm backtest --days 30` → 1.7s
- **Evolution Lab:** Ciclo completo ejecutado (diagnose → 20 variants → 20 backtests → report)
- **Chart Dashboard:** Live en `https://health.niklauss.uk/chart`
- **Databases:** agent.db (trading), metrics.db (pipeline), evolution.db (evolución), research.db (investigación)
- **Scheduled tasks:** 3 tareas Windows configuradas
- **Docker:** ain-agent (healthy), ain-redis (healthy), ain-research (healthy)

---

## Mejoras — 2026-08-08 a 2026-08-13 (Hybrid Sniper + PostgreSQL Migration)

### ADR-024: Migración de SQLite a PostgreSQL para shadow trades

**Decisión:** Migrar el almacenamiento de shadow positions de SQLite a PostgreSQL containerizado.
**Razón:** SQLite se bloqueaba con escrituras concurrentes del multi-variant executor. PostgreSQL maneja mejor la concurrencia y permite queries analíticos más potentes.
**Implementación:**

- Container: `ain-postgres` (puerto 5433 externo → 5432 interno)
- Database: `ain_shadow`
- Tabla: `shadow_positions` con campos para variantes y métricas
- Connection string: `postgresql://ain:secretpass@localhost:5433/ain_shadow`

### ADR-025: Hybrid Sniper como módulo de trading principal

**Decisión:** Reemplazar el TradingModule legacy por el nuevo Hybrid Sniper con capacidades multi-variante.
**Razón:** El sistema anterior tenía NEGATIVE_EXPECTANCY (-$2.10 en 30 días). El nuevo sistema permite exploración paralela de múltiples configuraciones.
**Componentes:**

- `multi-variant-executor.ts` — ejecuta N variantes en paralelo
- `shadow-executor.ts` — simula trades sin capital real
- `metrics-recorder.ts` — persiste en PostgreSQL
- `exploration-config.ts` — define variantes activas

### ADR-026: Tres variantes de exploración activas

**Decisión:** Correr 3 variantes simultáneamente para encontrar configuración óptima.
**Variantes:**

| Variante | TP% | SL% | Time Stop | Size |
|----------|-----|-----|-----------|------|
| **Balanced Large $25** | 40% | 15% | 2h | $25 |
| **Conservative 1h** | 25% | 8% | 1h | $15 |
| **Scalp Medium 1h** | 20% | 10% | 1h | $10 |

**Razón:** Diferentes perfiles de riesgo/recompensa para diferentes condiciones de mercado.

### FIX-023: variant_id, variant_name, signal_source NULL en DB

**Problema:** Estos campos no se guardaban en PostgreSQL aunque el código los generaba.
**Causa:** Faltaban en el INSERT statement de `metrics-recorder.ts`
**Fix:** Añadidos los campos al INSERT:
```sql
INSERT INTO shadow_positions (
  ..., variant_id, variant_name, signal_source
) VALUES ($1, ..., $16, $17, $18)
```

### FIX-024: GeckoTerminal rate limiting agresivo

**Problema:** `GeckoTerminal rate-limited (429)` cada 60-90 segundos, pausando descubrimiento.
**Causa:** Polling muy frecuente sin cache.
**Mitigación:** El sistema pausa 60s automáticamente. Pendiente implementar cache de tokens.

### FIX-025: Bitquery plan limit (402)

**Problema:** `Bitquery 402 — plan limit reached`
**Impacto:** Fuente de señales deshabilitada permanentemente hasta renovar plan.
**Estado:** Deshabilitado — sistema usa GeckoTerminal + Uniswap como alternativas.

### Estado del sistema (2026-08-13)

- **Modo:** Shadow Trading (Fase 1 activa desde 8 agosto)
- **Días corriendo:** 5 de 14 programados
- **Total trades:** 138 (solo micro-cap con variantes nuevas)
- **Win Rate:** 80.4% (111 TP_HIT, 27 TIME_STOP, 0 SL_HIT)
- **PnL simulado:** $5,178
- **Variantes activas:** 3 (balanced-large, conservative-1h, scalp-medium-1h)
- **Containers:** ain-agent, ain-postgres, ain-redis, ain-research, omniai-engine
- **PostgreSQL:** Funcionando en puerto 5433
- **Wallet:** `0xae36889c670CaA446bE18ECdC96f7c882e601D81` (~$99.80 USDC)

---

## Mejoras — 2026-08-13 (Research Agent Dedup + Limpieza)

### FIX-026: Research Agent repetía propuestas descartadas

**Problema:** El Research Agent re-investigaba oportunidades que ya habían sido descartadas o procesadas anteriormente.
**Causa:** El dedup solo comparaba `dedup_key` de la DB, pero no tenía memoria de propuestas ya evaluadas.
**Fix:** Mejorado el sistema de dedup en `src/research/engine.ts`:

1. **Dedup mejorado:** Ahora incluye TODAS las propuestas de la DB (incluso descartadas, code_generated, failed_no_revenue) para no re-investigar.

2. **Blacklist mínimo (solo seguridad):**
   - Contenido CSAM: ⛔ PROHIBIDO siempre
   - DeFi con APY > 5000%: Matemáticamente insostenible (probable scam)

**NOTA:** El Research Agent NO tiene nicho fijo. Explora CUALQUIER forma de generar dinero sin importar categoría (deportes, crypto, contenido, servicios, etc.).

**Archivo:** `src/research/engine.ts` — método `deduplicate()` y `matchesBlacklistPattern()`

### ADR-027: Archivo HISTORIAL_PROPUESTAS.md como memoria persistente

**Decisión:** Crear `investigacion/HISTORIAL_PROPUESTAS.md` para documentar todas las propuestas investigadas.
**Razón:** Referencia manual para el operador y base para futuros filtros automáticos.
**Contenido:**
- Lista de 57+ artículos con código generado
- Lista de propuestas descartadas (DeFi, deportes, sensible)
- Top 5 priorizadas para implementar
- Reglas de filtrado para nuevas propuestas

### Limpieza de archivos realizada

| Acción | Cantidad | Detalles |
|--------|----------|----------|
| Scripts obsoletos eliminados | 7 | analyze-strategies*.mjs, check-shadow.mjs, etc. |
| JSONs de propuestas eliminados | 132 | strategy_proposal_*.json en investigacion/ |
| Documentos movidos a docs/ | 3 | decisions.md, INFORME_53_PROPUESTAS.md, SNIPER_REPORT |

### Estado final de carpetas

```
docs/           → 14 archivos (documentación operacional)
investigacion/  → 3 archivos (master_log.md, HISTORIAL_PROPUESTAS.md, .gitkeep)
scripts/        → 30 archivos (7 eliminados)
contexto/       → vacío (solo .gitkeep)
```

---

## Mejoras — 2026-08-13 (Feasibility Assessment)

### FIX-027: Código auto-generado fallaba por falta de setup manual

**Problema:** El sistema generaba código para oportunidades que requerían configuración manual (crear cuentas, obtener API keys, etc.) y el código fallaba silenciosamente en `execute()`.

**Ejemplo:**
- Oportunidad: "Integrar Twitter API para contenido automatizado"
- Código generado: ✅ Sintácticamente correcto
- Validación de estructura: ✅ Tiene clase con `execute()`
- Runtime: ❌ `API key not found` o `401 Unauthorized`
- Resultado anterior: Warning ignorado, código aplicado, módulo inútil

**Fix:** Sistema de Feasibility Assessment en 3 capas:

#### Capa 1: FeasibilityAssessor (pre-generación)
- **Archivo:** `src/intelligence/feasibility-assessor.ts`
- Evalúa ANTES de generar código si la oportunidad es automatable
- Categorías:
  - `FULLY_AUTOMATABLE`: Puede implementarse y probarse ahora
  - `REQUIRES_SETUP`: Necesita setup manual, luego es autónomo
  - `REQUIRES_ONGOING_MANUAL`: Necesita intervención humana continua (rechazar)
  - `NOT_FEASIBLE`: No implementable con el stack actual (rechazar)
- Pre-filtro por regex + confirmación LLM
- Oportunidades `REQUIRES_SETUP` van a `manualSetupQueue` con lista de pasos

#### Capa 2: AdaptiveEvolver integrado
- **Archivo:** `src/intelligence/adaptive-evolver.ts`
- Nuevos estados: `needs_manual_setup`, `not_feasible`
- Nuevo campo: `feasibilityAssessment` en `ImplementationResult`
- Métodos nuevos:
  - `getManualSetupQueue()`: Lista oportunidades esperando setup
  - `markManualSetupComplete(id)`: Re-encola para implementación

#### Capa 3: AutonomousValidator mejorado (post-generación)
- **Archivo:** `src/self-mod/autonomous-validator.ts`
- Detecta errores de runtime que indican setup faltante:
  - `api key not found/missing/invalid`
  - `401/403/unauthorized`
  - `credentials missing`
  - `not configured/setup`
- Nuevo campo en `ValidationResult`: `requiresManualSetup`, `manualSetupReason`
- Si detecta setup error: falla con `REQUIRES_MANUAL_SETUP` en vez de warning

#### Capa 4: CodePatcher actualizado
- **Archivo:** `src/self-mod/code-patcher.ts`
- Nuevo error code: `REQUIRES_MANUAL_SETUP`
- Pasa `requiresManualSetup` y `manualSetupReason` en `ModificationResult`

**Flujo mejorado:**
```
Oportunidad
    │
    ▼
┌───────────────────────┐
│ FeasibilityAssessor   │ ◄── NUEVA CAPA
│ ¿Es automatable?      │
└───────────────────────┘
    │
    ├── REQUIRES_SETUP ──► manualSetupQueue (esperar setup manual)
    ├── NOT_FEASIBLE ────► Descartar
    ├── ONGOING_MANUAL ──► Descartar
    │
    ▼ FULLY_AUTOMATABLE
┌───────────────────────┐
│ Generar código (LLM)  │
└───────────────────────┘
    │
    ▼
┌───────────────────────┐
│ AutonomousValidator   │
│ - Sintaxis            │
│ - Estructura          │
│ - Anti-patrones       │
│ - Runtime (execute()) │ ◄── MEJORADO: Detecta setup errors
└───────────────────────┘
    │
    ├── REQUIRES_MANUAL_SETUP ──► Rechazar con razón específica
    │
    ▼ PASSED
┌───────────────────────┐
│ CodePatcher.apply()   │
└───────────────────────┘
```

**Beneficios:**
1. No gasta tokens LLM en oportunidades no automatizables
2. Cola de "setup pendiente" para seguimiento
3. Errores de runtime clasificados correctamente
4. Logs claros de por qué una oportunidad fue rechazada


---

### FIX-028: Sistema de Consolidación de Propuestas

**Problema:** Las propuestas procesadas (implementadas, fallidas, descartadas) no se movían a una lista de "ya investigado", permitiendo que el Research Agent las re-investigara.

**Solución:** Nuevo módulo `ProposalConsolidator` que corre cada 24 horas.

#### Intervalo elegido: 24 horas

**Razones:**
1. **Research cycles son cada 1-2h** → 24h da ~12-24 ciclos para acumular datos
2. **No demasiado frecuente** → No gasta recursos en consolidaciones constantes
3. **No demasiado espaciado** → No deja propuestas stale acumularse
4. **Sincroniza con "día operacional"** → Reporte diario natural

#### Flujo de consolidación

```
┌─────────────────────────────────────────────────────────────────┐
│                    ProposalConsolidator                         │
│                    (cada 24 horas)                              │
└─────────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
   Clasificar por        Detectar STALE       Generar reporte
   estado actual         (>7 días sin          diario
                         progreso)
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│ TERMINAL        │   │ Marcar como     │   │ Totales:        │
│ - implementada  │   │ "descartada"    │   │ - Implemented   │
│ - failed_no_rev │   │                 │   │ - Failed        │
│ - descartada    │   │                 │   │ - Pending       │
└────────┬────────┘   └────────┬────────┘   │ - NeedsSetup    │
         │                     │            │ - Stale         │
         └──────────┬──────────┘            └─────────────────┘
                    ▼
         ┌─────────────────────┐
         │ Mover a history.json│
         │ + Agregar a         │
         │ blacklist.json      │
         └─────────────────────┘
                    │
                    ▼
         ┌─────────────────────┐
         │ Research Engine     │
         │ lee blacklist.json  │
         │ en cada ciclo       │
         └─────────────────────┘
```

#### Archivos generados

| Archivo | Propósito |
|---------|-----------|
| `data/research-blacklist.json` | Títulos que NO deben re-investigarse |
| `data/proposal-history.json` | Historial completo de propuestas procesadas |

#### Estructura de blacklist.json
```json
[
  {
    "title": "Título de la propuesta fallida",
    "reason": "Status: failed_no_revenue",
    "addedAt": 1723564800000,
    "originalId": "opp-12345"
  }
]
```

#### Integración con Research Engine

El método `loadBlacklistedPatterns()` ahora:
1. Carga patterns hardcoded (CSAM, APY > 5000%)
2. Carga `data/research-blacklist.json` del consolidator
3. Normaliza títulos para matching fuzzy
4. Bloquea propuestas que coincidan

#### Estados y su tratamiento

| Estado | Clasificación | Acción |
|--------|---------------|--------|
| `implementada` | Terminal ✅ | → history (implemented) + blacklist |
| `failed_no_revenue` | Terminal ❌ | → history (failed) + blacklist |
| `descartada` | Terminal 🗑️ | → history (discarded) + blacklist |
| `new`, `activa`, `profundización` | Activo | Mantener, verificar stale |
| `pendiente_aprobacion` | Needs Setup | Reportar, no mover |
| `code_generated` | Activo | Mantener, verificar stale |
| `revenue_tracking` | Activo | Mantener |

#### Detección de STALE

- **Threshold:** 7 días sin cambio en `lastEvaluatedAt`
- **Acción:** Marcar como `descartada` con razón "Stale: no progress for 7 days"
- **Consecuencia:** Se agrega a blacklist para no re-investigar

**Archivo:** `src/intelligence/proposal-consolidator.ts`


---

### FIX-029: Sistema de Refinamiento de Propuestas (Second Chance)

**Problema:** Propuestas con potencial eran descartadas permanentemente cuando la versión original no era viable, aunque una versión modificada SÍ podría serlo.

**Ejemplo real:**
```
ORIGINAL (Descartada):
├── "YouTube monetization"
├── Requisitos: 4000h watch time + 1000 subs
├── Problema: Timeline indefinido
└── Score: 55 → DESCARTADA

REFINADA (Viable):
├── "2 AI tutorial channels with cross-posting"
├── Nicho específico: AI/ML tutorials
├── Estrategia: Reuso de contenido (shorts → long form)
├── Milestones claros: 100 subs (30d), 1000 subs (90d)
├── Score: 72 → ACEPTADA
└── Timeline: 3-6 meses para monetización
```

#### Estrategias de Refinamiento

| Estrategia | Descripción | Ejemplo |
|------------|-------------|---------|
| `constraint_relaxation` | Reducir requisitos | 10 canales → 2 canales |
| `scope_reduction` | Enfocar en nicho | "contenido general" → "AI tutorials" |
| `strategy_pivot` | Cambiar enfoque | "ads" → "affiliate" |
| `resource_optimization` | Reutilizar recursos | shorts → long form |
| `timeline_extension` | Aceptar más tiempo | inmediato → 3-6 meses |
| `hybrid` | Combinación | Varias estrategias juntas |

#### Flujo de Refinamiento

```
┌─────────────────────────────────────────────────────────────────┐
│                    AdaptiveEvolver                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    FeasibilityAssessor
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
         AUTOMATABLE    REQUIRES_SETUP   NOT_FEASIBLE
              │               │               │
              ▼               ▼               │
         Implementar    manualSetupQueue     │
                                             │
                              ┌──────────────┘
                              ▼
                    ¿Score >= 50?
                              │
              ┌───────────────┼───────────────┐
              ▼                               ▼
             NO                              SÍ
              │                               │
              ▼                               ▼
         Descartar                  ┌───────────────────┐
                                    │ ProposalRefiner   │
                                    │ (LLM analysis)    │
                                    └─────────┬─────────┘
                                              │
                              ┌───────────────┼───────────────┐
                              ▼               ▼               ▼
                         UNREFINABLE    REFINED (≥65)    FAILED (<65)
                              │               │               │
                              ▼               ▼               ▼
                         Descartar     refinedQueue      Descartar
                                             │
                                             ▼
                                    ┌───────────────────┐
                                    │ acceptRefined-    │
                                    │ Proposal()        │
                                    └─────────┬─────────┘
                                              │
                                              ▼
                                    Nueva entrada en
                                    knowledge_base
                                    (status: actionable)
```

#### Configuración

| Parámetro | Valor | Descripción |
|-----------|-------|-------------|
| `minScoreForRefinement` | 50 | Score mínimo para intentar refinamiento |
| `minRefinedScore` | 65 | Score mínimo para aceptar refinamiento |
| `maxRefinementAttempts` | 2 | Máximo intentos por propuesta |
| `batchIntervalMs` | 7 días | Intervalo para batch refinement |

#### Batch Refinement (Semanal)

Además del refinamiento on-demand, el sistema ejecuta un batch semanal que:
1. Busca todas las propuestas `descartada` con score >= 50
2. Intenta refinar hasta 5 por batch (control de costos LLM)
3. Las exitosas se añaden a `refinedQueue`

#### Propuestas NO refinables

Algunas propuestas son fundamentalmente no refinables:
- Contenido CSAM
- Esquemas Ponzi/piramidales
- Money laundering
- KYC bypass

#### Estructura de RefinedProposal

```typescript
interface RefinedProposal {
  originalId: string;
  originalTitle: string;
  originalRejectionReason: string;
  refinedTitle: string;
  refinedDescription: string;
  strategy: {
    type: 'constraint_relaxation' | 'scope_reduction' | ...;
    description: string;
    changes: string[];
  };
  refinedScore: number;
  feasibility: 'FULLY_AUTOMATABLE' | 'REQUIRES_SETUP';
  manualStepsRequired: ManualSetupStep[];
  timelineToRevenue: string;
  milestones: Array<{
    description: string;
    estimatedDays: number;
    metric: string;
  }>;
  confidence: number;
  reasoning: string;
  refinedAt: number;
}
```

#### Métodos disponibles en AdaptiveEvolver

| Método | Descripción |
|--------|-------------|
| `getRefinedQueue()` | Propuestas refinadas pendientes de aceptación |
| `getAllRefinedProposals()` | Todas las propuestas refinadas (historial) |
| `acceptRefinedProposal(id)` | Aceptar y crear nueva entrada en KB |

**Archivo:** `src/intelligence/proposal-refiner.ts`


#### Modelo LLM usado

El `ProposalRefiner` usa **DeepSeek v4 Flash** (configurable via `CODER_MODEL`):
- Temperatura: 0.3 (baja para respuestas más consistentes)
- Max tokens: 2048
- Costo aproximado: ~$0.001 por refinamiento

#### Flujo de descarte post-refinamiento

```
Propuesta NOT_FEASIBLE
    │
    ▼
¿Score >= 50?
    │
    ├── NO ──────────────────────────────────────────┐
    │                                                │
    └── SÍ                                           │
         │                                           │
         ▼                                           │
    ProposalRefiner.refineProposal()                 │
         │                                           │
         ├── ✅ SUCCESS (score >= 65)                │
         │         │                                 │
         │         ▼                                 │
         │    refinedQueue                           │
         │         │                                 │
         │         ▼                                 │
         │    acceptRefinedProposal()                │
         │         │                                 │
         │         ▼                                 │
         │    Nueva entrada KB                       │
         │    (status: actionable)                   │
         │                                           │
         └── ❌ FAILED                               │
                  │                                  │
                  ▼                                  │
         trackFailedRefinement()                     │
                  │                                  │
                  └──────────────────────────────────┤
                                                     │
                                                     ▼
                                          markAsFailed()
                                                     │
                                                     ▼
                                          status = 'descartada'
                                                     │
                                                     ▼
                                      ProposalConsolidator (24h)
                                                     │
                                                     ▼
                                      ┌──────────────────────────┐
                                      │ → history.json           │
                                      │ → blacklist.json         │
                                      │   (NO re-investigar)     │
                                      └──────────────────────────┘
```

#### Tracking de refinamientos fallidos

El `ProposalRefiner` mantiene un registro de propuestas que no pudieron refinarse:

```typescript
failedRefinements: Map<string, {
  title: string;
  reason: string;
  attempts: number;      // Cuántos intentos se hicieron
  lastAttempt: number;   // Timestamp del último intento
}>
```

Métodos disponibles:
- `getFailedRefinements()` — Lista todas las propuestas que fallaron refinamiento
- `isRefinementExhausted(id)` — Verifica si se agotaron los intentos

