# AGENTS.md — guidance for AI agents working in this repo

This file is read by Claude / Cursor / similar coding agents on every session in this
repo. Treat it as additional context that overrides default behavior. Keep it short.

## URL canon

Three canonical hostnames (Option A, locked 2026-05-01):

| Surface | Canonical hostname | Purpose |
|---|---|---|
| Web app | `filter.fun` | The product. Next.js standalone build, Railway-hosted. |
| Product docs | `docs.filter.fun` | Mintlify docs site (separate `starl3xx/docs` repo). |
| Indexer HTTP API | `api.filter.fun` | Ponder + Hono HTTP surface; SSE + REST. |

**Never reference `*.up.railway.app` or `*.mintlify.app` in any published or user-facing
string** — README files, web metadata, env example defaults, runbooks, OG tags, etc.
Always use the canonical subdomains.

Allowed exceptions:

- `railway.json` / `railway.web.json` — deployment config, not user-facing references.
- CI smoke-test steps that hit the Railway origin directly to bypass DNS — those are
  intentional infrastructure probes, not published references.
- Test fixtures where a URL is example data validating a pattern, not a real reference.
- Comments referencing the Railway origin for archaeological / debugging context.

When asked to "canonicalize URLs" or "sweep URLs," replace:

  web-production-ad93e3.up.railway.app   →   filter.fun
  filter-fun-production.up.railway.app   →   api.filter.fun
  filterfun.mintlify.app                 →   docs.filter.fun

## PR-driven workflow

- Open a PR against `main` early; bugbot reviews each push.
- Address bugbot feedback in commits to the same PR (`address bugbot — <topic>` is the
  conventional commit subject).
- Don't merge without bugbot's all-clear unless its findings are genuinely out-of-scope.

## What lives where

- Smart contracts: `packages/contracts` (Foundry, Solidity 0.8.26).
- Indexer: `packages/indexer` (Ponder + Hono).
- Web app: `packages/web` (Next.js 14 + wagmi v2).
- Off-chain TS: `packages/oracle`, `packages/scheduler`, `packages/scoring`,
  `packages/cadence`.
- Operator runbooks: `docs/runbook-*.md`.
- Roadmap + epic structure: lives outside this repo (referenced from the docs site).

## Project memory

User-specific preferences and rolling context are persisted under
`~/.claude/projects/...` per-Claude-instance — that file is the primary source of
session-to-session continuity. This file is the repo-shared baseline; the agent's own
memory layers on top.
