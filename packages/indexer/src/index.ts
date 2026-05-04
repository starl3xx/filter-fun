// Ponder discovers handler files via `src/**/*.ts`. Importing them here is optional but makes
// it explicit which event sources are active and avoids accidental orphan handlers.
import "./FilterLauncher";
import "./LaunchEscrow";
import "./LauncherStakeAdmin";
import "./FilterFactory";
import "./SeasonVault";
import "./FilterLpLocker";
import "./FilterToken";
import "./BonusDistributor";
import "./CreatorCommitments";
// Epic 1.16 (perpetual creator-fee rollup: Accrued/Claimed/Redirected/Disabled handlers)
// + Epic 1.21 (operator audit-trail mirror from `OperatorActionEmitted`).
import "./CreatorFeeDistributor";
import "./TournamentRegistry";
import "./V4PoolManager";
import "./HpSnapshot";
import "./HpFinalityAdvancer";

// HTTP API routes — see `src/api/index.ts` (REST: /season, /tokens, /token/:address,
// /profile/:address, /tokens/:address/history) and `src/api/events/index.ts` (SSE).
// Mounts on Ponder's built-in Hono server (default port 42069). See the package README
// for endpoint docs.
import "./api/index";
import "./api/events/index";
// Epic 1.21 — `/operator/*` routes (financial-overview, settlement-history, alerts,
// alerts/stream, actions). Operator-gated via SIWE-style signed-message auth + the
// OPERATOR_WALLETS env allow-list.
import "./api/operator";
