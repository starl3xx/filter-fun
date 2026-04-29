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
COPY packages/contracts/package.json packages/contracts/
COPY packages/indexer/package.json packages/indexer/
COPY packages/oracle/package.json packages/oracle/
COPY packages/scheduler/package.json packages/scheduler/
COPY packages/scoring/package.json packages/scoring/
COPY packages/web/package.json packages/web/

# 3. Install. --omit=dev keeps the image small; the indexer doesn't need dev deps to run
#    (`ponder start` is a runtime command).
RUN npm ci --omit=dev

# 4. Source. Only the indexer is needed at runtime; oracle/scheduler/etc. are workspace
#    siblings the indexer doesn't import. If that changes, copy them here too.
COPY packages/indexer ./packages/indexer

WORKDIR /repo/packages/indexer
EXPOSE 42069
CMD ["npx", "ponder", "start"]
