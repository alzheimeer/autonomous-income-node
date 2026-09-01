# Requirements Document

## Introduction

El **Rug Alert Service (RAS)** monetiza el pipeline de detección de rugs y honeypots del Autonomous Income Node (AIN) como API REST pública. El servicio reutiliza los módulos `ContractValidator` y `DexQuoter` ya existentes y probados con más de 30,000 tokens en Base mainnet (chain_id 8453). Ofrece tres niveles de acceso (Free, Pro, Enterprise) con rate limiting, caché en Redis y protección del presupuesto de créditos RPC de Alchemy.

El servicio corre como contenedor Docker independiente (`ain-rug-alert`) en el puerto 3005, dentro de la red `ain-network` existente, con acceso a PostgreSQL y Redis ya disponibles.

## Glossary

- **RAS**: Rug Alert Service — el servicio descrito en este documento.
- **ContractValidator**: módulo `src/shared/contract-validator.ts` que ejecuta los checks on-chain de un token.
- **DexQuoter**: módulo `src/shared/dex-quoter.ts` que obtiene cotizaciones y datos de liquidez de DEX.
- **Token_Address**: dirección EVM válida en formato `0x` seguido de 40 caracteres hexadecimales.
- **Risk_Score**: entero en el rango [0, 100] que representa el nivel de riesgo de un token.
- **API_Key**: cadena de 64 caracteres hexadecimales usada para autenticar clientes.
- **Tier**: nivel de acceso del cliente; valores posibles: `free`, `pro`, `enterprise`.
- **Free_Tier**: tier sin costo; límite de 10 req/día y delay de 60 s en análisis nuevos.
- **Pro_Tier**: tier de pago ($29/mes); límite de 10,000 req/día, sin delay.
- **Enterprise_Tier**: tier de pago ($199/mes); sin límite de requests, webhooks habilitados.
- **CU**: Compute Unit de Alchemy; unidad de consumo de la API RPC.
- **Cache_TTL**: tiempo de vida del resultado en Redis; 300 s para Free_Tier, 30 s para Pro/Enterprise.
- **Webhook**: URL HTTPS registrada por clientes Enterprise para recibir notificaciones push.
- **Quick_Check**: análisis reducido que ejecuta únicamente los checks de honeypot y transfer tax.
- **Full_Analysis**: análisis completo que ejecuta todos los checks disponibles del ContractValidator.
- **x402**: protocolo de micropagos USDC on-chain para acceso pay-per-query.
- **OPERATOR_API_KEY**: clave de administración del AIN usada para autenticar al operador en endpoints `/admin/*`.

## Requirements

### Requirement 1: Análisis Completo de Token

**User Story:** Como desarrollador o bot de trading, quiero consultar el análisis on-chain completo de un token, para decidir si comprarlo o evitarlo antes de ejecutar una operación.

#### Acceptance Criteria

1. WHEN un cliente envía `GET /v1/token/{address}`, THE RAS SHALL retornar HTTP 200 con un cuerpo JSON que incluya los campos: `address` (string minúsculas), `chain` (string, valor `"base"`), `safe` (boolean), `riskScore` (integer 0-100), `checks` (object con subcampos `honeypot`, `transferTax`, `liquidity`, `deployer`), `cachedAt` (ISO 8601 o null), `cached` (boolean), y `analyzedAt` (ISO 8601 del momento en que se completó el Full_Analysis).
2. WHEN el parámetro `{address}` no cumple la expresión regular `/^0x[0-9a-fA-F]{40}$/`, THE RAS SHALL retornar HTTP 400 con `{ "error": "INVALID_ADDRESS" }`.
3. IF el parámetro de consulta `chain` está presente en la URL y su valor no es exactamente `"base"`, THEN THE RAS SHALL retornar HTTP 400 con `{ "error": "UNSUPPORTED_CHAIN" }`; IF el parámetro `chain` está ausente, THE RAS SHALL asumir `"base"` por defecto.
4. WHEN existe un resultado en caché en Redis cuya antigüedad es menor al Cache_TTL del Tier del cliente, THE RAS SHALL retornar ese resultado con `cached: true` sin invocar al ContractValidator.
5. WHEN no existe resultado en caché o el resultado ha expirado, THE RAS SHALL invocar al ContractValidator para ejecutar un Full_Analysis, almacenar el resultado en Redis y retornar la respuesta al cliente.
6. WHEN ContractValidator detecta un honeypot (sell simulado retorna 0), THE RAS SHALL establecer `safe: false`, incluir `checks.honeypot.detected: true` con un campo `confidence` en el rango [0.0, 1.0], y establecer `riskScore` ≥ 70.
7. WHEN ContractValidator detecta una transfer sell tax superior al 5%, THE RAS SHALL establecer `safe: false`, incluir `checks.transferTax.sellTaxPct` como el entero más cercano al porcentaje detectado (redondeado hacia arriba), y sumar exactamente 20 puntos al `riskScore` según la tabla de penalidades del Requisito 12.
8. WHEN la liquidez del pool es inferior a $5,000 USDC equivalente, THE RAS SHALL incluir `checks.liquidity.usdcEquivalent` con el valor medido y establecer `safe: false`.
9. WHEN la dirección del deployer del token aparece en la tabla PostgreSQL `blacklisted_deployers` (ya existente en el schema del AIN), THE RAS SHALL incluir `checks.deployer.flagged: true` con `reason: "previous_rug"` y establecer `riskScore` ≥ 60.
10. WHEN ContractValidator confirma que los LP tokens están bloqueados o quemados en ≥ 50% (es decir, ≥ 50% del supply del LP token está en dirección zero `0x0000...0000` o en un contrato de lock verificado), THE RAS SHALL incluir `checks.liquidity.locked: true`; en caso contrario THE RAS SHALL incluir `checks.liquidity.locked: false`.
11. WHEN todos los checks pasan (sin honeypot, sellTax ≤ 5%, liquidez ≥ $5K, deployer no en blacklist, LP `locked: true`), THE RAS SHALL establecer `safe: true` y `riskScore` ≤ 30.
12. IF ContractValidator retorna un error inesperado de RPC, THEN THE RAS SHALL retornar HTTP 503 con `{ "error": "ANALYSIS_UNAVAILABLE", "retryAfterMs": 30000 }`.
13. WHEN un cliente no proporciona el header `X-API-Key` y su IP ha agotado la cuota Free_Tier, THE RAS SHALL retornar HTTP 429 con `{ "error": "RATE_LIMIT_EXCEEDED", "tier": "free", "resetAt": "<ISO 8601>" }` antes de invocar al ContractValidator.

---

### Requirement 2: Quick Check (Análisis Rápido)

**User Story:** Como bot de trading de alta frecuencia, quiero un check rápido de honeypot y tax en menos de 2 segundos, para filtrar tokens durante una ventana de tiempo crítica.

#### Acceptance Criteria

1. WHEN un cliente envía `GET /v1/token/{address}/quick`, THE RAS SHALL retornar HTTP 200 con un cuerpo JSON que contenga únicamente: `address`, `chain`, `honeypot`, `transferTaxPct`, `riskScore`, `latencyMs`, y `cached`.
2. WHEN el Quick_Check completa el análisis antes del límite de 2,000 ms, THE RAS SHALL retornar el resultado disponible con HTTP 200, aunque el análisis haya tardado entre 1,999 ms y 2,000 ms.
3. IF el Quick_Check no ha retornado ningún resultado en 2,000 ms, THEN THE RAS SHALL cancelar la operación y retornar HTTP 504 con `{ "error": "ANALYSIS_TIMEOUT" }`; THE RAS SHALL NOT descartar un resultado ya obtenido dentro del límite.
4. WHEN existe un resultado de Full_Analysis en caché dentro del Cache_TTL, THE RAS SHALL derivar la respuesta del Quick_Check del caché sin realizar nuevas llamadas RPC.

---

### Requirement 3: Análisis en Lote (Batch)

**User Story:** Como desarrollador que escanea una lista de tokens, quiero enviar hasta 10 tokens en una sola solicitud, para reducir la latencia y el overhead de llamadas API en comparación con solicitudes secuenciales.

#### Acceptance Criteria

1. WHEN un cliente envía `POST /v1/tokens/batch` con un cuerpo `{ "addresses": ["0x..."], "chain": "base" }`, THE RAS SHALL retornar un array de resultados de análisis en el mismo orden que el array de entrada.
2. WHEN el array `addresses` contiene más de 10 entradas, THE RAS SHALL retornar HTTP 400 con `{ "error": "BATCH_LIMIT_EXCEEDED", "max": 10 }`.
3. WHEN el array `addresses` está vacío, THE RAS SHALL retornar HTTP 400 con `{ "error": "EMPTY_BATCH" }`.
4. WHEN una dirección individual del lote es inválida, THE RAS SHALL incluir `{ "address": "...", "error": "INVALID_ADDRESS" }` para esa entrada y continuar procesando las demás.
5. THE RAS SHALL ejecutar los análisis del lote de forma concurrente para minimizar el tiempo total de respuesta.
6. WHEN el cliente está en Free_Tier, THE RAS SHALL contabilizar cada dirección del lote de forma independiente contra la cuota diaria de requests.

---

### Requirement 4: Rate Limiting por Tier

**User Story:** Como operador del AIN, quiero aplicar límites de requests por tier, para que los usuarios free no agoten los créditos RPC de Alchemy y los tiers de pago tengan diferenciación real de valor.

#### Acceptance Criteria

1. WHEN un cliente Free_Tier ha enviado 10 o más requests en el día UTC actual, THE RAS SHALL retornar HTTP 429 con `{ "error": "RATE_LIMIT_EXCEEDED", "tier": "free", "resetAt": "<timestamp ISO 8601 de la próxima medianoche UTC>" }`.
2. WHEN un cliente Pro_Tier ha enviado 10,000 o más requests en el día UTC actual, THE RAS SHALL retornar HTTP 429 con `{ "error": "RATE_LIMIT_EXCEEDED", "tier": "pro", "resetAt": "<timestamp ISO 8601>" }`.
3. THE RAS SHALL almacenar contadores de rate limit en Redis usando claves con formato `ras:ratelimit:{apiKeyHash}:{YYYY-MM-DD}` con TTL de 25 horas.
4. WHEN un cliente no incluye el header `X-API-Key`, THE RAS SHALL tratar el request como Free_Tier usando la IP del cliente como clave de rate limit.
5. WHEN un cliente Enterprise_Tier envía un request, THE RAS SHALL no aplicar ningún límite de requests diarios.

---

### Requirement 5: Estrategia de Caché

**User Story:** Como operador del AIN, quiero que los resultados de análisis se almacenen en caché en Redis, para que requests repetidos del mismo token no consuman CUs de Alchemy innecesariamente.

#### Acceptance Criteria

1. WHEN un resultado de Full_Analysis se almacena en Redis para un request de cliente Free_Tier, THE RAS SHALL aplicar un Cache_TTL de 300 segundos.
2. WHEN un resultado de Full_Analysis se almacena en Redis para un request de cliente Pro_Tier o Enterprise_Tier, THE RAS SHALL aplicar un Cache_TTL de 30 segundos.
3. THE RAS SHALL usar claves Redis con el formato `ras:token:{chain}:{address_en_minúsculas}` para todos los resultados de análisis en caché.
4. WHEN se retorna un resultado en caché, THE RAS SHALL incluir el timestamp original `cachedAt` sin modificación.
5. IF la conexión a Redis no está disponible, THEN THE RAS SHALL ejecutar el Full_Analysis sin almacenar en caché, incluir `cached: false` en la respuesta, y omitir el campo `cachedAt` (o establecerlo en `null`) para indicar que no hay resultado en caché.

---

### Requirement 6: Delay de Respuesta para Free Tier

**User Story:** Como operador del AIN, quiero que las respuestas del Free Tier tengan un delay de 60 segundos en análisis nuevos, para que los datos en tiempo real justifiquen el upgrade a Pro.

#### Acceptance Criteria

1. WHEN un cliente Free_Tier solicita el análisis de un token que no está en caché, THE RAS SHALL aplicar un delay de 60 segundos después de que el ContractValidator complete el análisis antes de retornar la respuesta.
2. WHEN un cliente Free_Tier solicita un token cuyo resultado ya está en caché, THE RAS SHALL retornar el resultado en caché de forma inmediata sin delay adicional.
3. WHILE el RAS está esperando el delay de 60 segundos para un cliente Free_Tier, THE RAS SHALL mantener la conexión HTTP abierta y retornar el resultado completo al finalizar el delay.

---

### Requirement 7: Autenticación por API Key

**User Story:** Como suscriptor Pro o Enterprise, quiero autenticarme con una API key, para que mis límites más altos y TTLs de caché más bajos se apliquen correctamente.

#### Acceptance Criteria

1. THE RAS SHALL aceptar API keys via el header HTTP `X-API-Key` en todos los endpoints `/v1/*`.
2. WHEN el header `X-API-Key` está presente y corresponde a una clave válida en la base de datos, THE RAS SHALL resolver el Tier asociado y aplicar los rate limits y Cache_TTL correspondientes.
3. WHEN el header `X-API-Key` contiene un valor que no corresponde a ninguna clave en la base de datos, THE RAS SHALL retornar HTTP 401 con `{ "error": "INVALID_API_KEY" }`.
4. THE RAS SHALL almacenar las API keys en PostgreSQL usando su hash SHA-256; THE RAS SHALL NOT almacenar las claves en texto plano.
5. WHEN se crea una API key, THE RAS SHALL retornar la clave en texto plano exactamente una vez; las lecturas posteriores SHALL retornar únicamente el prefijo de 8 caracteres y el timestamp de creación.

---

### Requirement 8: Webhooks de Alertas (Enterprise)

**User Story:** Como suscriptor Enterprise, quiero registrar una URL de webhook para direcciones de tokens específicas, para recibir notificaciones push instantáneas cuando esos tokens sean analizados.

#### Acceptance Criteria

1. WHEN un cliente Enterprise_Tier envía `POST /v1/webhooks` con `{ "url": "https://...", "addresses": ["0x..."] }`, THE RAS SHALL persistir la suscripción en PostgreSQL y retornar HTTP 201 con el ID de suscripción.
2. WHEN un cliente Free_Tier o Pro_Tier llama a `POST /v1/webhooks`, THE RAS SHALL retornar HTTP 403 con `{ "error": "TIER_REQUIRED", "minimum": "enterprise" }`. IF un cliente Enterprise_Tier es incorrectamente clasificado como un tier inferior por error interno, THEN THE RAS SHALL loguear el incidente, corregir el tier al valor almacenado en base de datos y procesar el request con permisos Enterprise.
3. WHEN un Full_Analysis se completa para una Token_Address que tiene suscripciones de webhook activas, THE RAS SHALL enviar un HTTP POST a cada URL registrada dentro de los 5 segundos siguientes a la finalización del análisis.
4. IF una entrega de webhook falla (respuesta no-2xx o timeout), THEN THE RAS SHALL reintentar hasta 3 veces con backoff exponencial (delays de 1 s, 2 s y 4 s respectivamente).
5. IF una URL de webhook retorna respuesta no-2xx en los 3 reintentos, THEN THE RAS SHALL marcar la suscripción con `status: "failed"` y detener permanentemente las entregas futuras a esa URL; el cliente deberá registrar una nueva suscripción para reactivar las notificaciones.
6. THE RAS SHALL incluir en el payload del webhook todos los campos del Full_Analysis más los campos `webhookId` y `deliveredAt`.
7. WHEN un cliente envía `DELETE /v1/webhooks/{id}`, THE RAS SHALL desactivar la suscripción y retornar HTTP 204.

---

### Requirement 9: Endpoint de Estadísticas Públicas

**User Story:** Como visitante o potencial cliente, quiero ver estadísticas públicas del servicio, para evaluar su confiabilidad y cobertura antes de registrarme.

#### Acceptance Criteria

1. WHEN un cliente envía `GET /v1/stats`, THE RAS SHALL retornar HTTP 200 con un cuerpo JSON que incluya al menos: `tokensAnalyzed` (total de tokens únicos analizados), `honeypotDetectionRate` (porcentaje), `avgAnalysisMs` (latencia media), `uptimeHours`, y `alchemyCuUsedThisMonth`.
2. THE RAS SHALL servir `GET /v1/stats` sin requerir el header `X-API-Key`.
3. THE RAS SHALL incrementar el contador `tokensAnalyzed` de forma atómica en Redis después de cada nuevo Full_Analysis (no en caché).
4. THE RAS SHALL servir la respuesta de `/v1/stats` desde caché Redis con un TTL de 60 segundos para evitar agregaciones por-request en la base de datos.

---

### Requirement 10: Health Check Público

**User Story:** Como integrador externo o sistema de monitoreo, quiero verificar que el servicio está operativo, para detectar outages y evitar enviar tráfico a un servicio caído.

#### Acceptance Criteria

1. WHEN un cliente envía `GET /v1/status` y todos los subsistemas (Redis, PostgreSQL, RPC de Alchemy) responden correctamente, THE RAS SHALL retornar HTTP 200 con `{ "status": "ok", "version": "<semver>", "chain": "base", "uptime": <segundos>, "subsystems": { "redis": "ok", "postgres": "ok", "rpc": "ok" } }`.
2. IF Redis no está disponible, THEN THE RAS SHALL retornar HTTP 200 con `{ "status": "degraded", "subsystems": { "redis": "down", "postgres": "ok", "rpc": "ok" } }`.
3. IF PostgreSQL no está disponible, THEN THE RAS SHALL retornar HTTP 200 con `{ "status": "degraded", "subsystems": { "redis": "ok", "postgres": "down", "rpc": "ok" } }`.
4. THE RAS SHALL reportar `status: "ok"` únicamente cuando todos los subsistemas estén operativos; cualquier subsistema no operativo SHALL producir `status: "degraded"` independientemente de cuántos subsistemas estén funcionando.
5. THE RAS SHALL servir `GET /v1/status` sin requerir el header `X-API-Key`.
6. THE RAS SHALL completar el health check y retornar la respuesta en un máximo de 1,000 ms.

---

### Requirement 11: Protección del Presupuesto de Alchemy CUs

**User Story:** Como operador del AIN, quiero que el RAS nunca consuma más del 10% del presupuesto mensual de CUs de Alchemy, para que los módulos de trading core no queden sin capacidad RPC.

#### Acceptance Criteria

1. THE RAS SHALL rastrear el consumo acumulado de CUs de Alchemy en un contador Redis con clave `ras:alchemy:cu:{YYYY-MM}`.
2. WHEN el contador mensual de CUs alcanza 33,000,000, THE RAS SHALL rechazar todos los requests que requerirían nuevas llamadas on-chain con HTTP 503 y `{ "error": "RPC_BUDGET_EXHAUSTED" }`.
3. WHEN un request puede ser atendido íntegramente desde el caché Redis, THE RAS SHALL atenderlo incluso cuando el presupuesto de CUs esté agotado.
4. THE RAS SHALL estimar el costo de cada Full_Analysis en 500 CUs y cada Quick_Check en 200 CUs, e incrementar el contador antes de realizar las llamadas RPC.
5. THE RAS SHALL exponer el consumo actual de CUs en la respuesta de `/v1/stats` bajo el campo `alchemyCuUsedThisMonth`.

---

### Requirement 12: Cálculo del Risk Score

**User Story:** Como cliente del RAS, quiero un puntaje de riesgo normalizado de 0 a 100, para comparar el nivel de riesgo entre tokens de forma programática sin analizar múltiples campos booleanos.

#### Acceptance Criteria

1. THE RAS SHALL calcular `riskScore` como un entero en el rango [0, 100], aplicando las penalidades en el siguiente orden determinístico: (1) iniciar en 0, (2) sumar cada penalidad aplicable, (3) limitar el resultado a 100 con `Math.min(score, 100)`.
2. THE RAS SHALL aplicar exactamente las siguientes penalidades aditivas: honeypot detectado → +40, sellTax > 5% → +20, liquidez < $5K USDC → +15, deployer en tabla `blacklisted_deployers` → +20, `checks.liquidity.locked: false` → +10. Ninguna penalidad se aplica más de una vez por análisis.
3. WHEN `riskScore` ≤ 30 AND `checks.honeypot.detected` es `false` AND `checks.transferTax.sellTaxPct` ≤ 5 AND `checks.liquidity.usdcEquivalent` ≥ 5000 AND `checks.deployer.flagged` es `false` AND `checks.liquidity.locked` es `true`, THE RAS SHALL establecer `safe: true`; en todos los demás casos THE RAS SHALL establecer `safe: false`.
4. FOR ALL Token_Address válidas donde los 5 checks pasan sin penalidad, THE RAS SHALL producir un `riskScore` exactamente igual a 0.
5. WHEN la misma Token_Address es analizada dos veces dentro del Cache_TTL, THE RAS SHALL retornar el mismo `riskScore` en ambas respuestas (idempotencia garantizada por el caché Redis).

---

### Requirement 13: Historial de Análisis (Pro y Enterprise)

**User Story:** Como suscriptor Pro o Enterprise, quiero consultar el historial de análisis de un token, para rastrear cómo ha cambiado su perfil de riesgo a lo largo del tiempo.

#### Acceptance Criteria

1. WHEN un cliente Pro_Tier o Enterprise_Tier envía `GET /v1/token/{address}/history`, THE RAS SHALL retornar un array de resultados de Full_Analysis pasados para esa dirección, ordenados por `analyzedAt` descendente, con un máximo de 30 entradas.
2. WHEN un cliente Free_Tier llama a `GET /v1/token/{address}/history`, THE RAS SHALL retornar HTTP 403 con `{ "error": "TIER_REQUIRED", "minimum": "pro" }`.
3. THE RAS SHALL persistir cada nuevo resultado de Full_Analysis en la tabla PostgreSQL `token_analyses` con las columnas: `address`, `chain`, `safe`, `risk_score`, `checks_json`, `analyzed_at`.
4. WHEN no existen registros históricos para una Token_Address, THE RAS SHALL retornar un array vacío `[]` con HTTP 200.

---

### Requirement 14: Administración de API Keys (Operador)

**User Story:** Como operador del AIN, quiero crear, consultar y revocar API keys para clientes, para gestionar el acceso al servicio sin intervención manual en la base de datos.

#### Acceptance Criteria

1. WHEN el operador envía `POST /admin/api-keys` con el header `Authorization: Bearer {OPERATOR_API_KEY}` y el cuerpo `{ "tier": "pro"|"enterprise", "label": "..." }`, THE RAS SHALL crear una nueva API key, persistirla en PostgreSQL (hash SHA-256) y retornar HTTP 201 con `{ "key": "<plaintext>", "prefix": "<8 chars>", "tier": "...", "createdAt": "..." }`.
2. WHEN el operador envía `DELETE /admin/api-keys/{prefix}` con el header `Authorization: Bearer {OPERATOR_API_KEY}`, THE RAS SHALL marcar la key como revocada en PostgreSQL y retornar HTTP 204.
3. WHEN el operador envía `GET /admin/api-keys` con el header `Authorization: Bearer {OPERATOR_API_KEY}`, THE RAS SHALL retornar una lista de todas las keys con campos `prefix`, `tier`, `label`, `createdAt`, `status`, y `requestsToday`.
4. WHEN un request a un endpoint `/admin/*` llega sin el header `Authorization: Bearer {OPERATOR_API_KEY}`, THE RAS SHALL retornar HTTP 401 con `{ "error": "UNAUTHORIZED" }`.
5. THE RAS SHALL NO exponer los endpoints `/admin/*` fuera de la red Docker `ain-network`.

---

### Requirement 15: Pagos x402 (Pay-per-Query)

**User Story:** Como usuario sin suscripción mensual, quiero pagar por consulta individual usando USDC en Base mainnet via el protocolo x402, para obtener análisis Pro sin compromiso de suscripción.

#### Acceptance Criteria

1. WHEN un cliente envía `GET /v1/token/{address}` con el header `X-Payment: <x402_payment_proof>`, THE RAS SHALL validar el pago on-chain y, si es válido, retornar la respuesta sin delay y con Cache_TTL de 30 segundos (equivalente a Pro_Tier para esa consulta).
2. IF el `x402_payment_proof` es inválido, THEN THE RAS SHALL retornar HTTP 402 con `{ "error": "PAYMENT_INVALID", "requiredUsdc": "0.01" }`.
3. IF el monto del pago x402 es menor al mínimo requerido, THEN THE RAS SHALL retornar HTTP 402 con `{ "error": "PAYMENT_INSUFFICIENT", "receivedUsdc": "<monto>", "requiredUsdc": "0.01" }`.
4. THE RAS SHALL aceptar pagos x402 de un mínimo de 0.01 USDC (10,000 unidades de 6 decimales) por consulta individual de Full_Analysis.
5. THE RAS SHALL aceptar pagos x402 de un mínimo de 0.005 USDC (5,000 unidades de 6 decimales) por consulta individual de Quick_Check.
6. WHEN un cliente no provee ni `X-API-Key` ni `X-Payment`, THE RAS SHALL tratar el request como Free_Tier con rate limiting por IP.

---

### Requirement 16: Consistencia de Serialización JSON

**User Story:** Como desarrollador que integra el API, quiero estructuras de respuesta JSON consistentes, para que mi código cliente no se rompa entre requests ni versiones del servicio.

#### Acceptance Criteria

1. THE RAS SHALL serializar todos los cuerpos de respuesta como JSON codificado en UTF-8 con `Content-Type: application/json; charset=utf-8`.
2. THE RAS SHALL normalizar todas las Token_Address a minúsculas en claves Redis, registros de base de datos y campos `address` de respuesta, independientemente del case enviado por el cliente.
3. FOR ALL respuestas válidas de Full_Analysis, serializar la respuesta a JSON y luego deserializarla SHALL producir un objeto cuya representación JSON sea igual a la cadena original (propiedad de round-trip de serialización).
4. WHEN un campo numérico (`riskScore`, `sellTaxPct`, `usdcEquivalent`) tiene valor cero, THE RAS SHALL incluir el campo con valor `0` en lugar de omitirlo.
5. THE RAS SHALL usar el formato ISO 8601 (`YYYY-MM-DDTHH:mm:ssZ`) para todos los campos de timestamp (`cachedAt`, `analyzedAt`, `resetAt`, `deliveredAt`).
6. FOR ALL Token_Address enviadas con caracteres en mayúsculas, THE RAS SHALL retornar el campo `address` en minúsculas y el análisis SHALL ser idéntico al que se retornaría si el cliente hubiese enviado la dirección ya en minúsculas (propiedad de normalización).
