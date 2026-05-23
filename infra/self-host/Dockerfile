# Atlas — production image for self-host (Oracle Cloud Ampere A1 or any linux/arm64).
#
# Multi-stage build:
#   1. deps         — installs full deps (incl. dev) for the build
#   2. builder      — runs `prisma generate` + `next build`
#   3. runner       — slim runtime with just the build artifacts + prod deps
#
# Notable choices:
#   - Node 22 (matches Vercel runtime; Next 16 supports Node 20+)
#   - pnpm via corepack (no global install needed)
#   - NO Python. Atlas dropped marker-pdf in v0.5.x; PDF parsing is now Mistral OCR
#     over HTTP (lib/pdf-parse.ts) so the image stays small and pure-Node.
#   - We run `prisma migrate deploy` at container start (in CMD), not at build time,
#     so the image doesn't bake in a DB connection.
#
# Build context: project root (../..). The compose file passes context: ../..
# so paths below are relative to the Atlas repo root.

# ──────────────────────────────────────────────────────────────────────────────
# Stage 1 — deps
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-slim AS deps
WORKDIR /app

# Enable pnpm via corepack (no `npm i -g`).
RUN corepack enable

# System deps that the prisma engine + sharp (Next image opt) need at install/run.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml ./
# Pin store dir so it doesn't get cached outside the layer.
RUN pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

# ──────────────────────────────────────────────────────────────────────────────
# Stage 2 — builder
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app
RUN corepack enable
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client + build Next.
# Note: `pnpm build` runs `prisma generate && next build` per package.json scripts.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ──────────────────────────────────────────────────────────────────────────────
# Stage 3 — runner
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-slim AS runner
WORKDIR /app
RUN corepack enable
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl \
      ca-certificates \
      wget \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# Non-root user.
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs nextjs

# Copy the built app + the things `next start` needs at runtime.
# We copy node_modules wholesale rather than using the `standalone` output
# because Prisma's generated client + adapter need their own dependency tree
# resolved from node_modules at runtime.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts
# Generated prisma client lives under app/generated/ per prisma.config.ts:
COPY --from=builder --chown=nextjs:nodejs /app/app ./app
COPY --from=builder --chown=nextjs:nodejs /app/lib ./lib
COPY --from=builder --chown=nextjs:nodejs /app/components ./components
COPY --from=builder --chown=nextjs:nodejs /app/instrumentation.ts ./instrumentation.ts
COPY --from=builder --chown=nextjs:nodejs /app/proxy.ts ./proxy.ts
COPY --from=builder --chown=nextjs:nodejs /app/trigger.config.ts ./trigger.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/trigger ./trigger
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json

USER nextjs
EXPOSE 3000

# Apply pending migrations on container start, then boot Next.
# `migrate deploy` is idempotent and safe to run on every restart.
CMD ["sh", "-c", "pnpm prisma migrate deploy && pnpm start"]
