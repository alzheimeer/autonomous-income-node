# Configuración de Antigravity IDE para este proyecto

## Archivos de configuración ya creados

| Archivo | Propósito |
|---------|-----------|
| `GEMINI.md` | Contexto del proyecto (leído automáticamente) |
| `.agent/rules/project-context.md` | Reglas siempre activas del proyecto |
| `.agent/rules/typescript-standards.md` | Estándares de código TypeScript |

## Configuración Global (hacer una sola vez)

Crea el archivo de reglas globales en:
```
C:\Users\fogni\.gemini\GEMINI.md
```

Con este contenido:
```markdown
# Reglas Globales Antigravity — Mauricio Quintero

- Siempre verificar versiones de paquetes antes de instalar
- Responder en español salvo que el código exija inglés
- Para proyectos con .env, nunca mostrar valores de secrets
- Para proyectos blockchain, siempre usar bigint para balances
```

## Configuración MCP (opcional — para herramientas adicionales)

Crea el archivo en:
```
C:\Users\fogni\.gemini\antigravity\mcp_config.json
```

Con este contenido (ajustar paths según necesites):
```json
{
  "mcpServers": {}
}
```

## Cómo abre Antigravity este proyecto

1. Abre Antigravity IDE
2. Abre la carpeta: `C:\Users\fogni\OneDrive\Escritorio\proyecto1a\autonomous-income-node`
3. Antigravity leerá automáticamente `GEMINI.md` + `.agent/rules/*.md`
4. El agente ya tendrá contexto completo del proyecto

## Contexto completo

Ver `CLAUDE.md` para la documentación técnica completa del proyecto.
