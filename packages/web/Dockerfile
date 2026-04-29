# Build the Next.js web app from the monorepo root so workspace deps resolve.
# Same pattern as packages/indexer/Dockerfile: build context is the repo root,
# COPY paths walk up to capture the workspace lock and the source of any package
# the web app imports (oracle, scheduler, and scoring transitively).

FROM node:20-bookworm-slim AS deps
WORKDIR /repo

# 1. Workspace lockfile + root manifest. Cache layer for npm install.
COPY package.json package-lock.json ./

# 2. All workspace package manifests so npm sees the full graph.
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
#    scheduler depends on oracle, oracle depends on scoring — copy all four.
COPY packages/oracle ./packages/oracle
COPY packages/scoring ./packages/scoring
COPY packages/scheduler ./packages/scheduler
COPY packages/web ./packages/web

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
