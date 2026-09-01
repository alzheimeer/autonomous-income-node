---
trigger: always_on
description: Estándares TypeScript y patrones del proyecto
---

# Estándares TypeScript — Autonomous Income Node

## Módulos y Imports

```typescript
// ✅ Correcto — ESM con extensión .js
import { SurvivalModule } from '../survival/index.js'
import type { ActionPlan } from '../agent/types.js'

// ❌ Incorrecto — CommonJS
const { SurvivalModule } = require('../survival')
```

## Tipos de Balance USDC

```typescript
// ✅ Correcto — bigint para USDC (6 decimales)
const balance: bigint = 99_800_000n  // = $99.80 USDC
const threshold: bigint = 500_000n   // = $0.50 USDC

// ❌ Incorrecto — number pierde precisión
const balance: number = 99.80
```

## Serialización BigInt

```typescript
// ✅ Correcto — replacer para JSON.stringify
JSON.stringify(obj, (_k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v)

// ❌ Incorrecto — lanza error
JSON.stringify({ balance: 99_800_000n })
```

## Variables de Entorno

```typescript
// ✅ Correcto — usar EnvValidator (Zod) en src/config/
import { config } from '../config/index.js'
const apiKey = config.ANTHROPIC_API_KEY

// ❌ Incorrecto — acceso directo
process.env.ANTHROPIC_API_KEY
```

## Tests

```typescript
// ✅ Correcto — Vitest con stubs en memoria
import { describe, it, expect, vi } from 'vitest'

// ❌ Incorrecto — no process.exit() en tests
// ❌ Incorrecto — no llamadas reales a blockchain en tests unitarios
```

## Modelos LLM

```typescript
// ✅ Modelo actual (julio 2026)
const model = 'claude-sonnet-4-5'

// ❌ Obsoleto
const model = 'claude-3-5-sonnet-20241022'  // 404
```
