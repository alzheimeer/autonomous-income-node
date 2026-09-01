# Child Projects - autonomous-income-node

Este documento describe los proyectos "hijo" que fueron generados automáticamente
por el módulo de oportunidades (`/opportunities`) del agente autónomo.

## 1. OmniAI-Engine

**Ubicación:** `../OmniAI-Engine/`  
**Estado:** ✅ Implementado y activo  
**Origen:** Oportunidades de contenido AI detectadas por el agente  
**Fecha de creación:** 2026-08-02

### Descripción

OmniAI-Engine es un motor de contenido totalmente autónomo que genera y distribuye
contenido en múltiples plataformas sin intervención humana. Se especializa en el
nicho de **Autismo e Inteligencia Artificial**.

### Oportunidades Implementadas

Las siguientes oportunidades del módulo `/opportunities` dieron origen a este proyecto:

| ID | Título | Score | Status |
|----|--------|-------|--------|
| `92cb363c-5b4c-4545-b31f-824497bfe4d8` | AI content niche: From OLAP to Tableau to AI agents... | 92 | ✅ implementada |
| `81659c71-4cc6-4a4c-bbf8-bc5c92493a69` | AI content niche: From the pendulum glitch... | 92 | ✅ implementada |
| `a29b247e-d072-4166-b8b4-858be4788065` | AI content niche: From OLAP to Tableau... | 91 | ✅ implementada |
| `20a4ef7b-946e-489c-a26a-d72d5a616c30` | AI content niche: From the pendulum glitch... | 91 | ✅ implementada |
| `149e9890-b8c8-478c-8280-dc2555400ad4` | AI content niche: From the pendulum glitch... | 91 | ✅ implementada |
| `3ee2e780-b643-453a-864c-9941290d5440` | AI content niche: Mixture-of-Experts (MoE) LLMs | 88 | ✅ implementada |
| `de6359c5-28fe-4ceb-a35d-bf9deff88e74` | AI content niche: AI-Tokenomics... | 79 | ✅ implementada |

### Características

- **SEO Agent:** Analiza rendimiento histórico y genera temas virales
- **Script & Blog Generators:** Escribe shorts de 60s, documentales de 5min, y artículos de 1000+ palabras
- **Audio & Video Renderers:** Google Cloud TTS + Pexels + FFmpeg
- **Multi-Platform Publishers:** YouTube, Hashnode, Medium, Dev.to
- **Autonomous Orchestrator:** Cron scheduler para publicación automática

### Stack Técnico

- TypeScript / Node.js
- DeepSeek API (LLM)
- Google Cloud TTS & YouTube Data API v3
- Puppeteer (browser automation)
- FFmpeg (video rendering)
- node-cron (orchestration)

### Cómo Ejecutar

```bash
cd ../OmniAI-Engine
docker-compose up -d --build
```

El servidor web estará disponible en `http://localhost:3003/logs`

### Ingresos Estimados

- **Artículos:** $0.50-5/artículo (Medium Partner Program)
- **Videos:** Monetización YouTube después de alcanzar 1000 suscriptores
- **ROI esperado (30 días):** $15-150 (fase inicial, escalable)

### Relación con el Agente Padre

OmniAI-Engine reporta métricas al agente padre a través de:
1. Logs en Telegram (compartido con autonomous-income-node)
2. Base de datos SQLite local (`content/database.sqlite`)
3. Puerto 3003 para dashboard web

---

*Documento generado automáticamente por autonomous-income-node*
*Última actualización: 2026-08-04*
