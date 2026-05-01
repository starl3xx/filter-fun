// Ponder discovers handler files via `src/**/*.ts`. Importing them here is optional but makes
// it explicit which event sources are active and avoids accidental orphan handlers.
import "./FilterLauncher";
import "./FilterFactory";
import "./SeasonVault";
import "./FilterLpLocker";
import "./FilterToken";
import "./BonusDistributor";
import "./CreatorCommitments";
import "./TournamentRegistry";
import "./V4PoolManager";
import "./HpSnapshot";

// HTTP API routes — see `src/api/index.ts` (REST: /season, /tokens, /token/:address,
// /profile/:address, /tokens/:address/history) and `src/api/events/index.ts` (SSE).
// Mounts on Ponder's built-in Hono server (default port 42069). See the package README
// for endpoint docs.
import "./api/index";
import "./api/events/index";
