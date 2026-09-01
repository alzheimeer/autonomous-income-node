# Requirements Document — Hybrid Sniper

## Introduction

El módulo **Hybrid Sniper** es un satélite autónomo de alto riesgo dentro del agente AIN
(`src/hybrid-sniper/`). Opera en Base blockchain sobre tokens de micro-capitalización,
combinando señales híbridas (on-chain vía DexScreener y Bitquery GraphQL, más webhooks
externos) con validación matemática estricta de contratos inteligentes (anti-honeypot,
tax scanner, liquidez, flags). La **Fase 0** es Shadow Testing puro: ninguna transacción
real se emite; todas las operaciones son simuladas con precios reales (QuoterV2 /
Aerodrome), registradas en SQLite, y reportadas vía HTTP. El módulo es **non-fatal**:
un fallo en su inicialización no interrumpe el agente principal.

---

## Glossary

- **HybridSniper**: El módulo satélite completo en `src/hybrid-sniper/`.
- **SignalIngestor**: Componente responsable de recibir y normalizar señales de todas las
  fuentes (DexScreener, Bitquery, Webhook).
- **ContractValidator**: Componente que ejecuta la validación matemática de un contrato
  token antes de aceptar una señal.
- **ShadowExecutor**: Componente que simula la apertura, seguimiento y cierre de
  posiciones sin emitir transacciones reales.
- **RiskBucket**: Componente que gestiona el presupuesto de $15 USDC lógico, el tamaño
  por trade y el Circuit Breaker.
- **MetricsRecorder**: Componente que persiste métricas, latencias y resultados en
  `data/sniper-metrics.db` usando `node:sqlite` DatabaseSync.
- **SniperSignal**: Objeto normalizado que representa una oportunidad recibida por
  cualquier fuente, con campos `ticker`, `contractAddress`, `source`, y
  `ingestionTime`.
- **ValidationResult**: Resultado del ContractValidator, con campos `passed` (boolean),
  `rejectReason` (string | null), y `validatedAt` timestamp.
- **ShadowPosition**: Posición paper abierta por el ShadowExecutor, con precio de
  entrada, TP, SL y TimeStop derivados de los parámetros confirmados.
- **CircuitBreaker**: Mecanismo que bloquea nuevas señales durante 24 horas después de
  2 pérdidas consecutivas en shadow.
- **HoneypotTest**: Prueba multi-sell que simula 100 % de compra + 50 % de venta +
  50 % restante de venta vía `staticCall`. Un contrato es honeypot si cualquiera de
  las dos ventas retorna `amountOut = 0`.
- **FlagScanner**: Verificación de funciones de control presentes en el ABI del token:
  `isBlacklisted`, `maxTxAmount`, `maxWalletAmount`, `tradingActive`.
- **DexScreener**: API REST pública para polling de nuevos pares en Base.
- **Bitquery**: API GraphQL (free tier) para señales on-chain adicionales.
- **Aerodrome**: Fork Solidly (DEX común en micro-caps de Base), soportado de forma
  DEX-agnostic junto a Uniswap V3.
- **QuoterV2**: Contrato de Uniswap V3 usado para simular cotizaciones de entrada/
  salida sin gas real (también representa al quoter equivalente de Aerodrome).
- **Phase0**: Modo de operación donde HybridSniper corre enteramente en shadow, sin
  claves privadas ni gas real.
- **SniperDB**: Alias de `data/sniper-metrics.db`, la base SQLite dedicada del módulo.
- **WireSniper**: Función de integración que registra las rutas HTTP del módulo en el
  servidor Fastify existente (patrón `wireEvolution`).

---

## Requirements

### Requirement 1: Inicialización Non-Fatal y Activación Paralela

**User Story:** Como operador del agente AIN, quiero que el módulo Hybrid Sniper se
inicie en paralelo al agente principal sin interrumpirlo si falla, de modo que un error
en el módulo satélite nunca deje el nodo sin operar.

#### Acceptance Criteria

1. WHEN el agente AIN arranca, THE HybridSniper SHALL inicializarse dentro de un bloque
   `try/catch` independiente, de forma que cualquier excepción durante su construcción
   sea capturada, registrada en el logger principal y descartada sin propagar.
2. WHEN `SNIPER_ENABLED` es `false` o está ausente en el entorno, THE HybridSniper SHALL
   omitir toda inicialización y retornar sin error ni advertencia.
3. WHEN el HybridSniper se inicializa correctamente, THE HybridSniper SHALL registrar
   en el logger un mensaje de nivel `info` que confirme el arranque en Phase 0 Shadow
   Mode.
4. IF la SniperDB no puede abrirse o migrarse, THEN THE HybridSniper SHALL capturar la
   excepción, emitir un log de nivel `error` con el mensaje y desactivarse sin afectar
   al agente principal.
5. THE HybridSniper SHALL operar en Phase 0 de forma continua sin requerir claves
   privadas ni gas real bajo ninguna condición de entrada válida.

---

### Requirement 2: Ingestión de Señales Híbridas

**User Story:** Como operador, quiero que el módulo consuma señales de tres fuentes
(DexScreener, Bitquery, Webhook) y las normalice a un formato único, para que el resto
del pipeline las procese de forma homogénea.

#### Acceptance Criteria

1. WHEN el SignalIngestor está activo, THE SignalIngestor SHALL consultar la API REST de
   DexScreener en el endpoint de nuevos pares de Base con un intervalo de polling
   configurable (por defecto 30 segundos).
2. WHEN el SignalIngestor está activo, THE SignalIngestor SHALL enviar queries GraphQL a
   la API de Bitquery (free tier) para obtener tokens recientes en Base, usando
   `BITQUERY_API_KEY` como credencial.
3. WHEN un cliente externo envía una petición `POST /webhook/alpha` con cuerpo
   `{ ticker, contractAddress, source }`, THE SignalIngestor SHALL normalizar la
   señal, asignarle un `ingestionTime` en ms UNIX y enrutarla al pipeline de
   validación.
4. WHEN `POST /webhook/alpha` recibe un cuerpo con `contractAddress` ausente o vacío,
   THE SignalIngestor SHALL responder con HTTP 400 y un mensaje de error descriptivo.
5. WHEN una señal con el mismo `contractAddress` ya fue procesada en los últimos 60
   segundos, THE SignalIngestor SHALL descartar la señal duplicada y NO iniciar una
   segunda evaluación.
6. THE SignalIngestor SHALL asignar `ingestionTime` como el timestamp en ms UNIX en el
   momento exacto en que la señal ingresa al módulo, antes de cualquier validación.

---

### Requirement 3: Validación Matemática de Contratos (ContractValidator)

**User Story:** Como operador, quiero que cada señal pase por una validación estricta
del contrato token antes de que el shadow executor la tome, para reducir la exposición
a honeypots, rugpulls y tokens con impuestos abusivos.

#### Acceptance Criteria

1. WHEN el ContractValidator recibe una señal, THE ContractValidator SHALL ejecutar el
   HoneypotTest: simular via `staticCall` una compra del 100 % del trade size, luego
   una venta del 50 % del `amountOut` obtenido, luego una segunda venta del 50 %
   restante.
2. IF el `amountOut` de la primera venta (50 %) es 0, THEN THE ContractValidator SHALL
   marcar el contrato como honeypot, asignar `passed = false`, y registrar
   `rejectReason = "HONEYPOT_SELL1_ZERO"`.
3. IF el `amountOut` de la segunda venta (50 % restante) es 0, THEN THE
   ContractValidator SHALL marcar el contrato como honeypot, asignar `passed = false`,
   y registrar `rejectReason = "HONEYPOT_SELL2_ZERO"`.
4. WHEN el ContractValidator calcula el impuesto de venta (`sellTax`), THE
   ContractValidator SHALL derivarlo como la diferencia porcentual entre el `amountOut`
   esperado (sin impuesto) y el `amountOut` real del `staticCall`.
5. IF el `sellTax` calculado supera el 5 %, THEN THE ContractValidator SHALL asignar
   `passed = false` y registrar `rejectReason = "SELL_TAX_EXCEEDED"`.
6. WHEN el ContractValidator verifica la liquidez del pool principal, THE
   ContractValidator SHALL rechazar la señal IF el valor en USDC del pool es menor a
   $10,000, asignando `rejectReason = "INSUFFICIENT_LIQUIDITY"`.
7. WHEN el ContractValidator ejecuta el FlagScanner, THE ContractValidator SHALL
   verificar la existencia y el estado de las funciones `isBlacklisted`,
   `maxTxAmount`, `maxWalletAmount`, y `tradingActive` en el ABI del contrato.
8. IF `isBlacklisted` retorna `true` para la dirección del agente, THEN THE
   ContractValidator SHALL asignar `passed = false` y registrar
   `rejectReason = "BLACKLISTED"`.
9. THE ContractValidator SHALL soportar de forma DEX-agnostic tanto pools de Uniswap V3
   como de Aerodrome (fork Solidly), detectando el tipo de pool a partir de la
   interfaz del contrato antes de ejecutar las simulaciones.
10. WHEN el ContractValidator completa la validación, THE ContractValidator SHALL
    registrar `validatedAt` como el timestamp en ms UNIX al momento de finalizar todas
    las verificaciones.

---

### Requirement 4: Registro de Latencia

**User Story:** Como operador, quiero que el sistema calcule y persista la latencia
total de cada señal (desde ingestion hasta validación completa), para poder monitorear
el rendimiento del pipeline bajo carga real.

#### Acceptance Criteria

1. WHEN el MetricsRecorder persiste una señal procesada, THE MetricsRecorder SHALL
   calcular `totalLatencyMs` como la diferencia exacta entre `validatedAt` y
   `ingestionTime`.
2. THE MetricsRecorder SHALL almacenar `totalLatencyMs`, `ingestionTime`,
   `validatedAt`, `contractAddress`, `source`, `passed`, y `rejectReason` en la tabla
   `sniper_signals` de SniperDB para cada señal procesada.
3. WHEN `GET /sniper/status` es invocado, THE HybridSniper SHALL retornar las últimas
   10 señales procesadas, la latencia promedio de esas 10 señales, y el estado actual
   del CircuitBreaker.
4. THE MetricsRecorder SHALL abrir y mantener la SniperDB en `data/sniper-metrics.db`
   usando `node:sqlite` DatabaseSync, siguiendo el mismo patrón de `TradingDatabase`
   del módulo `trading-validation`.

---

### Requirement 5: Ejecución Shadow (ShadowExecutor)

**User Story:** Como operador, quiero que las señales que pasan validación sean
"ejecutadas" en shadow mode con precios reales de QuoterV2, con TP/SL/TimeStop fijos,
para obtener métricas de P&L simulado sin riesgo real.

#### Acceptance Criteria

1. WHEN una señal pasa la validación completa y el RiskBucket no está bloqueado, THE
   ShadowExecutor SHALL abrir una ShadowPosition con precio de entrada obtenido de una
   cotización real (QuoterV2 o equivalente Aerodrome), `takeProfit = entryPrice * 1.15`,
   `stopLoss = entryPrice * 0.95`, y `timeStop = ingestionTime + 7_200_000` ms.
2. WHEN una ShadowPosition está activa y el precio actual supera `takeProfit`, THE
   ShadowExecutor SHALL cerrar la posición con resultado `TP_HIT` y notificar al
   RiskBucket.
3. WHEN una ShadowPosition está activa y el precio actual cae por debajo de `stopLoss`,
   THE ShadowExecutor SHALL cerrar la posición con resultado `SL_HIT` y notificar al
   RiskBucket.
4. WHEN una ShadowPosition está activa y el tiempo actual supera `timeStop`, THE
   ShadowExecutor SHALL cerrar la posición con resultado `TIME_STOP` y notificar al
   RiskBucket.
5. IF el RiskBucket indica que el budget disponible es 0 trades, THEN THE
   ShadowExecutor SHALL rechazar la apertura de nuevas posiciones sin lanzar excepción.
6. THE ShadowExecutor SHALL obtener precios actuales a través de cotizaciones reales
   (sin estimaciones off-chain), usando el mismo contrato QuoterV2 que
   `trading-validation`, bajo `staticCall` para no consumir gas.

---

### Requirement 6: Gestión de Riesgo (RiskBucket)

**User Story:** Como operador, quiero que el módulo gestione un presupuesto lógico de
$15 USDC con un trade size configurable y un Circuit Breaker automático, para que las
pérdidas en shadow reflejen límites operacionales reales.

#### Acceptance Criteria

1. THE RiskBucket SHALL mantener un presupuesto total de `SNIPER_RISK_BUDGET_USDC`
   USDC (por defecto 15), expresado como número entero de trades disponibles calculado
   como `floor(budget / tradeSize)`.
2. WHEN el RiskBucket registra un cierre de posición con resultado `SL_HIT`, THE
   RiskBucket SHALL incrementar el contador `consecutiveLosses` en 1.
3. WHEN el RiskBucket registra un cierre de posición con resultado `TP_HIT` o
   `TIME_STOP`, THE RiskBucket SHALL resetear el contador `consecutiveLosses` a 0.
4. WHEN `consecutiveLosses` alcanza o supera `SNIPER_MAX_LOSS_STREAK` (por defecto 2),
   THE RiskBucket SHALL activar el CircuitBreaker, registrando `blockedUntil` como el
   timestamp actual más 86,400,000 ms (24 horas).
5. WHILE el CircuitBreaker está activo (`now < blockedUntil`), THE RiskBucket SHALL
   indicar al ShadowExecutor que el budget disponible es 0 y rechazar cualquier
   solicitud de apertura.
6. WHEN el timestamp actual supera `blockedUntil`, THE RiskBucket SHALL desactivar el
   CircuitBreaker automáticamente y restaurar el número de trades disponibles al valor
   inicial.
7. THE RiskBucket SHALL leer `SNIPER_TRADE_SIZE_USDC`, `SNIPER_RISK_BUDGET_USDC`, y
   `SNIPER_MAX_LOSS_STREAK` desde variables de entorno al inicializarse, usando los
   valores por defecto si no están definidas.

---

### Requirement 7: Integración Fastify (WireSniper)

**User Story:** Como operador, quiero que el módulo registre sus rutas HTTP en el
servidor Fastify existente del agente, siguiendo el patrón `wireEvolution`, para poder
consultarlo sin levantar un servidor adicional.

#### Acceptance Criteria

1. THE WireSniper SHALL exponer una función `wireSniper(fastify: FastifyInstance): void`
   que registre las rutas del módulo en el servidor Fastify existente, siguiendo el
   mismo patrón de `wireEvolution`.
2. WHEN `wireSniper` es invocado, THE WireSniper SHALL registrar la ruta
   `POST /webhook/alpha` para recibir señales externas.
3. WHEN `wireSniper` es invocado, THE WireSniper SHALL registrar la ruta
   `GET /sniper/status` que retorna las últimas 10 señales, latencia promedio y estado
   del CircuitBreaker.
4. IF el HybridSniper no está habilitado (`SNIPER_ENABLED !== 'true'`), THEN THE
   WireSniper SHALL registrar igualmente las rutas pero responderá con HTTP 503 y el
   mensaje `"Hybrid Sniper is disabled"`.
5. THE WireSniper SHALL ser invocado desde `buildFastifyServer` en
   `src/heartbeat/index.ts`, junto a `wireEvolution`, sin modificar la lógica del
   `TradingOrchestrator`.

---

### Requirement 8: Base de Datos Dedicada (SniperDB)

**User Story:** Como operador, quiero que el módulo persista todos sus datos en una
base SQLite independiente (`data/sniper-metrics.db`) sin tocar `agent.db`, para que el
módulo satélite sea completamente aislado del sistema principal.

#### Acceptance Criteria

1. THE MetricsRecorder SHALL crear y migrar la SniperDB en `data/sniper-metrics.db`
   al inicializarse, sin nunca abrir ni modificar `data/agent.db`.
2. THE MetricsRecorder SHALL crear la tabla `sniper_signals` con al menos las columnas:
   `id` (INTEGER PRIMARY KEY AUTOINCREMENT), `contractAddress` (TEXT), `source` (TEXT),
   `ingestionTime` (INTEGER), `validatedAt` (INTEGER), `totalLatencyMs` (INTEGER),
   `passed` (INTEGER), `rejectReason` (TEXT), `result` (TEXT), `createdAt` (INTEGER).
3. THE MetricsRecorder SHALL crear la tabla `shadow_positions` con columnas para
   registrar cada ShadowPosition: `id`, `contractAddress`, `entryPrice`, `entryTime`,
   `exitPrice`, `exitTime`, `exitReason`, `tradeSize`, `pnlUsdc`.
4. WHEN una señal válida es procesada, THE MetricsRecorder SHALL insertar un registro
   en `sniper_signals` con `result = 'PASS'` y todos los campos requeridos dentro de
   la misma operación síncrona de validación.
5. THE MetricsRecorder SHALL aplicar el PRAGMA `journal_mode = WAL` y
   `synchronous = NORMAL` a la SniperDB al abrirla, siguiendo el patrón de
   `TradingDatabase`.

---

### Requirement 9: Variables de Entorno y Configuración

**User Story:** Como operador, quiero que todos los parámetros del módulo sean
configurables vía variables de entorno con valores por defecto sensatos, para poder
ajustarlos sin recompilar.

#### Acceptance Criteria

1. THE HybridSniper SHALL leer las siguientes variables de entorno al inicializarse:
   `SNIPER_ENABLED`, `SNIPER_RISK_BUDGET_USDC`, `SNIPER_TRADE_SIZE_USDC`,
   `SNIPER_MAX_LOSS_STREAK`, `SNIPER_TP_PCT`, `SNIPER_SL_PCT`, `BITQUERY_API_KEY`.
2. IF una variable de entorno numérica está ausente o es inválida, THEN THE
   HybridSniper SHALL usar el valor por defecto: `SNIPER_RISK_BUDGET_USDC=15`,
   `SNIPER_TRADE_SIZE_USDC=5`, `SNIPER_MAX_LOSS_STREAK=2`, `SNIPER_TP_PCT=15`,
   `SNIPER_SL_PCT=5`.
3. THE HybridSniper SHALL documentar todas las variables nuevas en `.env.example` con
   comentarios en español y valores por defecto explícitos.
4. WHEN `BITQUERY_API_KEY` está vacía o ausente, THE SignalIngestor SHALL deshabilitar
   el polling de Bitquery de forma silenciosa, registrando un log de nivel `warn`, sin
   afectar a DexScreener ni al webhook.
