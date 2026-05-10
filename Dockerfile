# ─────────────────────────────────────────────────────────────────────────────
# Italian Financial Regulation MCP — multi-stage Dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# Build:  docker build -t italian-financial-regulation-mcp .
# Run:    docker run --rm -p 3000:3000 italian-financial-regulation-mcp
#
# The image bakes the CONSOB database at /app/data/consob.db.
# CI workflow (ghcr-build.yml) downloads database.db.gz from the latest
# GitHub Release into ./data/database.db before docker build.
# Override with CONSOB_DB_PATH for a custom location.
# ─────────────────────────────────────────────────────────────────────────────

# --- Stage 1: Build TypeScript + native modules ---
FROM node:20-slim AS builder

WORKDIR /app

# Build deps for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# Full install (incl. dev deps + native bindings via postinstall)
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Trim devDependencies but KEEP the better-sqlite3 native binding intact.
RUN npm prune --omit=dev

# --- Stage 2: Production ---
FROM node:20-slim AS production

WORKDIR /app
ENV NODE_ENV=production
ENV CONSOB_DB_PATH=/app/data/consob.db

# Bring node_modules (with native bindings) from the builder rather than
# re-running `npm ci` here — that path strips better-sqlite3's prebuilt
# binding and yields ENOENT at runtime.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist/ dist/
COPY package.json ./

# Bake database (provisioned by CI from GitHub Release into data/database.db)
COPY data/database.db data/consob.db

# Non-root user for security
RUN addgroup --system --gid 1001 mcp && \
    adduser --system --uid 1001 --ingroup mcp mcp && \
    chown -R mcp:mcp /app
USER mcp

# Health check: verify HTTP server responds
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/src/http-server.js"]
