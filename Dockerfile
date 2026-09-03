# ============================================================
# Autonomous Income Node — Multi-stage Dockerfile
# Stage 1: builder  → compila TypeScript + copia migraciones SQL
# Stage 2: production → imagen mínima con solo los artefactos necesarios
# ============================================================

# ── Stage 1: Builder ────────────────────────────────────────────────────────
FROM node:24-slim AS builder
WORKDIR /app

# Instalar pnpm
RUN npm install -g pnpm@9

# Herramientas de build para módulos nativos (better-sqlite3 requiere python3 + make + g++)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copiar configuración del workspace primero (para cachear la capa de dependencias)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./

# Instalar todas las dependencias (incluyendo devDeps para compilación)
RUN pnpm install --frozen-lockfile || pnpm install

# Copiar todo el código fuente
COPY tsconfig.json tsconfig.build.json tsconfig.research.json ./
COPY src/ ./src/
COPY constitution.md ./

# Compilar TypeScript → dist/
RUN pnpm build

# Copiar migraciones SQL al dist/ (el script de build ya copia research/state/migrations si existe)
# También copiar las migraciones principales de state/
RUN mkdir -p dist/state/migrations && \
    cp -r src/state/migrations/*.sql dist/state/migrations/ 2>/dev/null || true

# Copiar migraciones del copy-trading (SQL para PostgreSQL)
RUN mkdir -p dist/copy-trading/migrations && \
    cp -r src/copy-trading/migrations/*.sql dist/copy-trading/migrations/ 2>/dev/null || true

# ── Stage 2: Production ──────────────────────────────────────────────────────
FROM node:24-slim AS production
WORKDIR /app

# Instalar utilidades de runtime y actualizar certificados CA
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl tini ca-certificates openssl && \
    update-ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Variables de entorno SSL para Node.js
ENV SSL_CERT_DIR=/etc/ssl/certs
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# Crear usuario no-root para seguridad
RUN groupadd -g 1001 ain && \
    useradd -r -u 1001 -g ain ain

# Copiar artefactos compilados desde builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/constitution.md ./

# Copiar node_modules del builder (incluye módulos nativos compilados como better-sqlite3)
COPY --from=builder /app/node_modules ./node_modules

# Crear directorios necesarios con ownership correcto
RUN mkdir -p data keys investigacion && chown -R ain:ain data keys investigacion

# Cambiar a usuario no-root
USER ain

# Exponer puerto: 3002 (Research Dashboard y Health API)
EXPOSE 3002

# Health check — esperar 30s al arranque
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3002/health || exit 1

# Usar tini como proceso init (manejo correcto de señales)
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/research/index.js"]
