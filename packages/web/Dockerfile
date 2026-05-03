# Build the Next.js web app from the monorepo root so workspace deps resolve.
# Same pattern as packages/indexer/Dockerfile: build context is the repo root,
# COPY paths walk up to capture the workspace lock and the source of any package
# the web app imports (oracle, scheduler, and scoring transitively).

FROM node:20-bookworm-slim AS deps
WORKDIR /repo

# 1. Workspace lockfile + root manifest. Cache layer for npm install.
COPY package.json package-lock.json ./

# 2. All workspace package manifests so npm sees the full graph.
COPY packages/cadence/package.json packages/cadence/
COPY packages/contracts/package.json packages/contracts/
COPY packages/indexer/package.json packages/indexer/
COPY packages/oracle/package.json packages/oracle/
COPY packages/scheduler/package.json packages/scheduler/
COPY packages/scoring/package.json packages/scoring/
COPY packages/web/package.json packages/web/

# 3. Install everything (incl. dev deps — Next build needs typescript, @types/*, etc.).
RUN npm ci


FROM node:20-bookworm-slim AS builder
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/package.json ./package.json
COPY --from=deps /repo/package-lock.json ./package-lock.json
COPY --from=deps /repo/packages ./packages

# 4. Source. Web depends on oracle + scheduler at compile time (transpilePackages),
#    scheduler re-exports from cadence, scheduler depends on oracle, oracle depends
#    on scoring — copy all five.
COPY packages/cadence ./packages/cadence
COPY packages/oracle ./packages/oracle
COPY packages/scoring ./packages/scoring
COPY packages/scheduler ./packages/scheduler
COPY packages/web ./packages/web

# 5. NEXT_PUBLIC_* build args.
#
# Production incident (2026-05-03): Next.js inlines `process.env.NEXT_PUBLIC_*`
# references at build time as string literals — but Docker builds do NOT
# forward host env vars into the build container unless explicitly declared
# as ARG. So even with `NEXT_PUBLIC_INDEXER_URL` and `NEXT_PUBLIC_BASE_*_RPC_URL`
# set on Railway, `npm run build` saw them as `undefined`, baked the defaults
# into the bundle (indexer → http://localhost:42069 → mixed-content blocked
# in production; RPC → undefined → wagmi throw before PR #85's soft-fail), and
# every visitor's browser hit a broken bundle.
#
# Railway forwards service-level env vars as `--build-arg` automatically when
# their names match declared ARGs in the Dockerfile, so declaring them here is
# the full fix on the Railway side. The ENV lines re-export each ARG into the
# environment so Next.js's webpack DefinePlugin scan picks them up during the
# `npm run build` below.
#
# Each is intentionally optional (no default) — at build time, an unset var
# produces an empty string in the bundle, which the consuming code is already
# defensive against (wagmi.ts warns + falls back; api.ts's INDEXER_URL `??`s
# to localhost which is the dev-target default; etc.). The .env.example file
# documents which vars production needs.
ARG NEXT_PUBLIC_INDEXER_URL
ARG NEXT_PUBLIC_CHAIN
ARG NEXT_PUBLIC_BASE_RPC_URL
ARG NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL
ARG NEXT_PUBLIC_WC_PROJECT_ID
ENV NEXT_PUBLIC_INDEXER_URL=$NEXT_PUBLIC_INDEXER_URL
ENV NEXT_PUBLIC_CHAIN=$NEXT_PUBLIC_CHAIN
ENV NEXT_PUBLIC_BASE_RPC_URL=$NEXT_PUBLIC_BASE_RPC_URL
ENV NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL=$NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL
ENV NEXT_PUBLIC_WC_PROJECT_ID=$NEXT_PUBLIC_WC_PROJECT_ID

WORKDIR /repo/packages/web
RUN npm run build


# Runtime image: standalone output bundles server.js + traced node_modules, so we
# don't need npm/dev deps here. Static assets and public/ are copied separately
# because Next's standalone bundler doesn't include them.
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Standalone server (server.js + minimal node_modules).
COPY --from=builder /repo/packages/web/.next/standalone ./
# Static assets — Next serves these from /app/packages/web/.next/static at runtime.
COPY --from=builder /repo/packages/web/.next/static ./packages/web/.next/static

EXPOSE 3000
CMD ["node", "packages/web/server.js"]
