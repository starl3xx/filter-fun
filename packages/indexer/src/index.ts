// Ponder discovers handler files via `src/**/*.ts`. Importing them here is optional but makes
// it explicit which event sources are active and avoids accidental orphan handlers.
import "./FilterLauncher";
import "./SeasonVault";
import "./FilterLpLocker";
import "./BonusDistributor";

// HTTP API routes (Epic 1.3 parts 1+2/3) — `/season` + `/tokens` + `/token/:address` + `/events`
// (SSE). Mounts on Ponder's built-in Hono server (default port 42069). See the package README
// for endpoint docs.
import "./api/index";
import "./api/events/index";
