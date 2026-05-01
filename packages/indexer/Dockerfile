# Build the indexer from the monorepo root so workspace deps resolve.
# Railway's "Root Directory" setting points at packages/indexer (so this Dockerfile is
# picked up automatically), but the COPY paths walk back up to capture the workspace lock
# and the source of any package the indexer imports.
FROM node:20-bookworm-slim AS base
WORKDIR /repo

# 1. Workspace lockfile + root manifest. Copying these first lets us cache npm install
#    when only application code (not deps) changes.
COPY package.json package-lock.json ./

# 2. All workspace package manifests so npm sees the full graph.
COPY packages/cadence/package.json packages/cadence/
COPY packages/contracts/package.json packages/contracts/
COPY packages/indexer/package.json packages/indexer/
COPY packages/oracle/package.json packages/oracle/
COPY packages/scheduler/package.json packages/scheduler/
COPY packages/scoring/package.json packages/scoring/
COPY packages/web/package.json packages/web/

# 3. Install. --omit=dev keeps the image small; the indexer doesn't need dev deps to run
#    (`ponder start` is a runtime command).
RUN npm ci --omit=dev

# 4. Source. The indexer imports `@filter-fun/scoring` for HP composition and
#    `@filter-fun/cadence` for phase/cut anchors in its API handlers, so copy those
#    workspace packages too. Other workspace siblings (oracle, scheduler, contracts,
#    web) are not imported at runtime.
COPY packages/cadence ./packages/cadence
COPY packages/scoring ./packages/scoring
COPY packages/indexer ./packages/indexer

WORKDIR /repo/packages/indexer
# Ponder's HTTP server (GraphQL + the /season + /tokens API endpoints from src/api/) listens
# on PORT (Railway auto-injects, default 42069). Bind 0.0.0.0 in the Railway start command
# so traffic from outside the container reaches it.
EXPOSE 42069
CMD ["npx", "ponder", "start", "--hostname", "0.0.0.0"]
