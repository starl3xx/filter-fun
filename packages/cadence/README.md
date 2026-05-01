# @filter-fun/cadence

Single source of truth for filter.fun season cadence (hour-anchors). Imported by both `@filter-fun/scheduler` (decides when to call `advancePhase()`) and `@filter-fun/indexer` (computes `nextCutAt` / `finalSettlementAt` for the public `/season` API).

## Locked timeline (spec §3.2 + §36.1.5 + §33.6, locked 2026-04-30)

| Hour       | Phase                                                             |
| ---------- | ----------------------------------------------------------------- |
| 0 – 48     | Launch window (12 slots, FCFS, dynamic cost)                      |
| 48 – 96    | Trading-only window (full field of 12, no eliminations)           |
| 96         | First filter — 12 → 6 (hard cut)                                  |
| 96 – 168   | Finals (6 tokens compete)                                         |
| 168        | Settlement                                                        |

Day-of-week mapping: Mon launch / Thu cut / Sun winner. **No Day 5 soft filter** — spec §33.6 resolved off; the `softFilterEnabled` flag exists for forward compatibility but no implementation ships.

## Usage

```ts
import {DEFAULT_CADENCE, loadCadence, hoursToSec} from "@filter-fun/cadence";

// Most consumers: read defaults
console.log(DEFAULT_CADENCE.hardCutHour); // 96n

// Production / Sepolia: read env overrides
const cadence = loadCadence(); // throws on invalid env

// Compute next-cut timestamp from on-chain `season.startedAt`
const nextCutAtSec = startedAtSec + hoursToSec(cadence.hardCutHour);
```

## Env overrides (all optional, all validated)

| Variable                       | Default | Constraint                        |
| ------------------------------ | ------- | --------------------------------- |
| `SEASON_LAUNCH_END_HOUR`       | `48`    | positive integer                  |
| `SEASON_HARD_CUT_HOUR`         | `96`    | positive integer; > launchEnd     |
| `SEASON_SETTLEMENT_HOUR`       | `168`   | positive integer; > hardCut       |
| `SEASON_SOFT_FILTER_ENABLED`   | `false` | `true` / `false` / `1` / `0`      |

`loadCadence()` throws on bad input — misconfiguring cadence on Phase 2 mainnet would mis-time settlement (data-loss-class bug). Bad values fail loudly at startup, never silently.

## Why a separate package?

- **No transitive deps** — `@filter-fun/cadence` has no `dependencies`, only dev-only `vitest` + `typescript`. Safe to import from anywhere without dragging in viem / scoring / etc.
- **Cross-package shared constant** — both scheduler and indexer must agree on the cadence. Putting it in either of those would force the other to take an unrelated dep.
- **Single point of truth** — when the cadence changes again, exactly one file changes; everything else re-reads the constants on next deploy.
