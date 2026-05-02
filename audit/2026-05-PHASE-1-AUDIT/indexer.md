# Phase-1 Indexer Audit
filter.fun indexer (packages/indexer)
**Audit Date:** 2026-05-01

---

## CRITICAL

### [Indexer] Missing /tokens/:address/holders endpoint
**Status:** ✅ **DEFERRED to Phase 2** (Audit Finding C-4) — explicitly documented per the audit's recommended path. The data layer (`holderBalance` + `holderSnapshot` tables) is already populated; only the HTTP surface waits. Rationale and Phase-2 design constraints (cursor pagination, dust cutoff aligned with `HOLDER_SNAPSHOT_DUST_WEI`, bag-locked-creator flag) live in `packages/indexer/README.md` ("Known gaps" + "Outstanding"). The route docstring at `packages/indexer/src/api/index.ts:1-23` also lists the deferral inline so developers see it where they look first. Closing as deferred (not implemented) — promotion to Phase 2 follow-up requires the §41.3 concentration filter to land alongside it so the count and the list agree by construction.

**Severity:** Critical
**Files:** packages/indexer/src/api/index.ts
**Spec ref:** §26.4 / §41.3

**Description:**
Spec §41.3 describes address-based concentration filtering, which presumes a holders surface exists. The /tokens response carries `bagLock` (PR #45) but there is no dedicated holders endpoint, and the HP scoring has no integration with `holderConcentration` as the 6th component yet. May be intentional scope reduction, but should be explicit.

**Recommendation:** Either add `/tokens/:address/holders` (paginated, filtered) or document explicitly in the spec/ROADMAP that holder data is deferred to Phase 2.

**Effort:** M

### [Indexer] Cache TTL bug for /tokens/:address/history (60× under-cache)
**Status:** ✅ **FIXED** in audit-remediation PR (Audit Finding C-3). One-line wiring fix at `packages/indexer/src/api/middleware.ts:96` — `cacheCfg.tokensTtlMs` → `cacheCfg.profileTtlMs`, aligning the runtime behaviour with the surrounding comment's documented intent. Also exposed `LruTtlCache.ttlMs` as a public readonly so the regression test can introspect the wired TTL. Regression covered by `test/api/cache.test.ts` describe block "response-cache TTL wiring (audit finding C-3)" — pre-fix `historyResponseCache.ttlMs === tokensResponseCache.ttlMs` (5_000ms, NOT profile's 30_000ms); post-fix `historyResponseCache.ttlMs === profileResponseCache.ttlMs` and the bug-shape (history === tokens) is explicitly negated.

**Severity:** Critical
**Files:** packages/indexer/src/api/middleware.ts:96
**Spec ref:** §26 (cache TTLs)

**Description:**
The history cache is constructed with `ttlMs: cacheCfg.tokensTtlMs` (default 5 s), but the comment on line 93 states it should reuse the *profile* cache TTL (default 30 s, intent ~5 min per HP_SNAPSHOT_INTERVAL_BLOCKS). Result: history endpoint thrashes under any repeated request pattern; 60× more upstream load than intended.

**Evidence:**
```ts
// Reuse the profile-cache TTL knob since the data behind history changes on the
// same cadence as the per-token snapshot writer (5 min ≈ HP_SNAPSHOT_INTERVAL_BLOCKS)
historyCache = new LruTtlCache<unknown>({ttlMs: cacheCfg.tokensTtlMs, ...})
```

**Recommendation:** Switch to `profileTtlMs` (or introduce a dedicated `CACHE_TTL_HISTORY_MS` env var). Verify the actual snapshot cadence matches the TTL.

**Effort:** XS

---

## HIGH

### [Indexer] Concentration filtering not yet enforced
**Severity:** High
**Files:** packages/indexer/src/api/builders.ts (TokenRow placeholders)
**Spec ref:** §41.3

**Description:**
HP placeholders for `price`, `priceChange24h`, `volume24h`, `liquidity`, `holders` are hardcoded to "0" / 0 — known gap pending V4 PoolManager integration. Concentration filtering as the 6th HP component is described in §41.3 but not implemented. Requires backtest validation before shipping; flag explicitly so it does not slip into mainnet.

**Recommendation:** Add a feature gate / explicit no-op marker so the frontend can detect "data not yet available" instead of receiving 0 values that look real.

**Effort:** M

### [Indexer] Error handling inconsistency: 404 vs 200/empty
**Severity:** High
**Files:** packages/indexer/src/api/handlers.ts:71 (season 404), 88 (tokens 200/empty), 130 (token detail 404); profile.ts:172 (profile 200/empty)
**Spec ref:** §22 / §26

**Description:**
- /season → 404 when no season indexed
- /tokens → 200/empty array
- /token/:address → 404 for unknown
- /profile/:address → 200/empty for unknown wallet (intentional per §22 — avoids leaking "is this address ever a player")

The /season case is ambiguous: should it be 503 (not ready) or 200/empty until indexing begins? Spec doesn't clarify.

**Recommendation:** Align: either (a) return 200 with all fields zero until indexing begins, or (b) document the 404/503 distinction explicitly.

**Effort:** S

**Status:** ✅ FIXED in audit-remediation PR (Audit Finding H-2, indexer-high-batch-2 / 2026-05-02). Picked option (a) with a discriminated envelope rather than zero-fields:
- `/season` → `200 + {status: "not-ready", season: null}` when no season indexed (was `404`). Web/SDK consumers gate on `status` instead of catching a 404; uptime monitors stop seeing a confusing 404 on a healthy indexer.
- `/tokens` → unchanged (200 + []).
- `/token/:address` → unchanged (404 for unknown — named-singleton convention).
- `/profile/:address` → unchanged (200/empty, privacy-driven exception per §22).
- Convention documented in a top-of-file comment in `handlers.ts` and in `README.md`.
- Regression cover: `test/api/security/endpointStatusContract.test.ts` (5 tests).
- Web follow-up: `/season` consumer must handle `status === "not-ready"` (currently catches the 404). Tracked in PR description.

### [Indexer] Type safety — widespread `as unknown as MwContext` casts
**Severity:** High
**Files:** packages/indexer/src/api/index.ts (5 sites: /season, /tokens, /token/:address, /tokens/:address/history, /profile/:address)
**Spec ref:** n/a

**Description:**
Pattern `const mw = c as unknown as MwContext;` is a type-safety escape hatch. While MwContext is a narrow interface, the `as unknown` intermediate disables structural type-checking and could silently break if Ponder's Context type changes.

**Recommendation:** Narrow with a type guard or add a small `toMwContext(c: Context)` adapter that documents the assumed shape and asserts at runtime.

**Effort:** S

**Status:** ✅ FIXED in audit-remediation PR (Audit Finding H-3, indexer-high-batch-2 / 2026-05-02). Adapter approach:
- Added `src/api/mwContext.ts::toMwContext(c)` with runtime assertions on `.req`, `.req.url`, `.req.header`, `.header`, `.json`. Each missing surface throws with a named field so a Ponder upgrade that drifts the Context shape surfaces on the very first request rather than as silent middleware misbehaviour.
- All 5 cast sites in `index.ts` and 2 in `events/index.ts` replaced.
- Regression cover: `test/api/security/mwContextAdapter.test.ts` (9 tests including the operator-grep-friendly "Ponder Context shape changed" anchor in error messages).

### [Indexer] No /healthz or readiness check beyond Ponder default
**Severity:** High
**Files:** packages/indexer/src/api/index.ts:11-14
**Spec ref:** §26 (status concept)

**Description:**
Comment says `/health`, `/ready`, `/metrics` are "reserved paths" served by Ponder. Ponder's `/health` returns 200 immediately (independent of indexer sync) — fine for Railway healthcheck — but there's no explicit *readiness* check (has at least one season indexed? is the tick engine running?).

**Recommendation:** Add a custom `/readiness` handler that checks `latestSeason() !== null` AND `tickEngine.isRunning()`. Wire to deployment readiness probes.

**Effort:** S

**Status:** ✅ FIXED in audit-remediation PR (Audit Finding H-4, indexer-high-batch-2 / 2026-05-02).
- Added `GET /readiness` route returning `200` only when (a) latest-season indexed AND (b) `TickEngine.isRunning()`. Returns `503` (not 200/false) so load balancers route traffic away during startup / sync drops without killing the process.
- Added `TickEngine.isRunning()` method + exported `eventsEngineRunning()` helper from `src/api/events/index.ts`.
- Pure handler `getReadinessHandler` in `handlers.ts` so the verdict is testable without a live DB or SSE engine.
- README updated with the liveness (`/health`) vs readiness (`/readiness`) distinction.
- Regression cover: `test/api/security/readinessProbe.test.ts` (4 tests covering the three scenarios + the 503 status assertion).

### [Indexer] Holder snapshot timing not validated in code
**Severity:** High
**Files:** packages/indexer/src/api/index.ts:341 (`holderBadgeFlagsForUser`), 367, 372
**Spec ref:** §42

**Description:**
Queries `holderSnapshot` rows by `trigger = "CUT"` or `"FINALIZE"`. Spec §42 expects snapshots at hour 96 (cut) and hour 168 (finalize). No validation that wall-clock timing matches; if the on-chain emit is delayed, the snapshot is recorded but the trigger label may be misleading.

**Recommendation:** Add a comment / assertion mapping triggers to expected cadence; emit a warning if timestamp drift exceeds a threshold.

**Effort:** S

**Status:** ✅ FIXED in audit-remediation PR (Audit Finding H-5, indexer-high-batch-2 / 2026-05-02).
- New pure module `src/api/snapshotCadence.ts` with `validateSnapshotCadence(input)` returning a structured drift verdict (`drifted`, `driftSeconds`, `expectedHour`, `actualHourFloor`, `logFields`) and `checkAndLogCadence(input, logger)` that emits a structured warning when drift exceeds 5 minutes.
- Wired into `holderBadgeFlagsForUser` in `index.ts` — every snapshot row processed through the validator; verdict observed via the warn log line; never fails the request (operations decides whether observed drift is real).
- Drift threshold: 5 minutes (`DRIFT_THRESHOLD_SECONDS`). Cadence anchors: CUT @ hour 96, FINALIZE @ hour 168 per spec §42.
- Unknown trigger labels (e.g. a future contract change adding a third trigger) silently accepted — false-positive warnings on every request would be worse than the missing anchor.
- Regression cover: `test/api/security/snapshotCadenceDrift.test.ts` (8 tests).

### [Indexer] No CORS headers configured
**Severity:** High
**Files:** packages/indexer/src/api/middleware.ts (no CORS middleware found)
**Spec ref:** n/a

**Description:**
No middleware explicitly sets `Access-Control-Allow-Origin`. Ponder's HTTP server defaults may not match what /web (deployed on Vercel, different origin) expects. Cross-origin requests to /season, /tokens, /events will fail unless CORS is wired.

**Recommendation:** Add CORS middleware allowing the canonical origins (filter.fun, api.filter.fun, localhost:3000 for dev). Document allowed origins in env.

**Effort:** S

**Status:** ✅ FIXED in audit-remediation PR (Audit Finding H-6, indexer-high-batch-2 / 2026-05-02).
- New pure policy module `src/api/cors.ts` with `loadCorsConfigFromEnv()` (reads `CORS_ALLOWED_ORIGINS` comma-separated, falls back to defaults) and `originAllowed(origin, cfg)` (exact-equality match, returns the matched origin string — not `*` — so cached responses stay scoped).
- Default allow-list: `https://filter.fun`, `https://docs.filter.fun`, `http://localhost:3000`, `http://localhost:3001`.
- Wired via `ponder.use("*", cors({...}))` so every route + the SSE endpoint share one policy.
- `.env.example` documents `CORS_ALLOWED_ORIGINS` for production override without a code deploy.
- Regression cover: `test/api/security/corsAllowedOrigins.test.ts` (11 tests including the substring-match denial guard against `https://attacker-filter.fun`).

---

## MEDIUM

### [Indexer] BagLock creator field optional on TokenRow but not validated
**Severity:** Medium
**Files:** packages/indexer/src/api/builders.ts:81, 163
**Spec ref:** n/a

**Description:**
`TokenRow.creator?` is optional but `buildTokensResponse` falls back to `0x0000…000`. If a row legitimately lacks a creator, the UI shows a zero address as the lock owner (silent data loss). Drizzle schema likely requires creator on the row anyway, making the optional declaration misleading.

**Recommendation:** Make `creator` required on TokenRow, or add a runtime assertion that catches missing data instead of silently substituting 0x0.

**Effort:** XS

### [Indexer] Test coverage gap — /token/:address handler
**Severity:** Medium
**Files:** packages/indexer/test/handlers.test.ts (no test for getTokenDetailHandler)
**Spec ref:** n/a

**Description:**
handlers.test.ts covers /season and /tokens with detailed fixtures but does not exercise getTokenDetailHandler:
- invalid address format → 400
- unknown token address → 404
- valid token → 200 + shape validation

**Recommendation:** Add the three test cases above.

**Effort:** S

### [Indexer] Test coverage gap — /tokens/:address/history edge cases
**Severity:** Medium
**Files:** packages/indexer/test/history.test.ts
**Spec ref:** n/a

**Description:**
history.test.ts does not exercise:
- interval validation (< 60 s or > 86400 s)
- range validation (from > to, from/to outside the 30-day cap)
- empty result sets (token exists, no snapshots in range)

**Recommendation:** Add vitest cases for `parseInterval` and `parseRange`.

**Effort:** S

### [Indexer] SSE rate-limit retry-after fixed at 30s
**Severity:** Medium
**Files:** packages/indexer/src/api/ratelimit.ts:157
**Spec ref:** n/a

**Description:**
SSE connection denial returns `Retry-After: 30`. Doc comment acknowledges "there's no guaranteed time at which a slot frees" — clients are guessing.

**Recommendation:** Either document the 30 s rationale or add logic to estimate slot freeing based on average connection duration (track `lastClosedAt`).

**Effort:** S

### [Indexer] IP rate-limit fallback collapses unknown clients to a single bucket
**Severity:** Medium
**Files:** packages/indexer/src/api/ratelimit.ts:196
**Spec ref:** n/a

**Description:**
`return socketAddr || "unknown"` — if socket parse fails for one client, all such clients share the "unknown" bucket; a DoS against unknown collapses every client behind the same proxy.

**Recommendation:** Log a warning + use a stable hash of request headers (UA + Accept-Language) as a fallback identifier.

**Effort:** S

### [Indexer] Logging — console.error in tick.ts without structured context
**Severity:** Medium
**Files:** packages/indexer/src/api/events/tick.ts:145
**Spec ref:** n/a

**Description:**
A bare `console.error(...)` in the tick loop has no request id, no PII redaction, and could log wallet addresses if exception bubbles up.

**Recommendation:** Use a structured logger (pino) with explicit redaction for `address`, `holder`, `signer` fields.

**Effort:** S

---

## LOW

### [Indexer] Profile endpoint asymmetric error semantics
**Severity:** Low
**Files:** packages/indexer/src/api/index.ts:153, profile.ts:149,172
**Spec ref:** §22

**Description:**
profile returns 400 for invalid address but 200/empty for unknown wallets. Asymmetry is correct but undocumented.

**Recommendation:** Add a short JSDoc comment in index.ts explaining the rationale.

**Effort:** XS

### [Indexer] No pagination on /tokens
**Severity:** Low
**Files:** packages/indexer/src/api/handlers.ts (getTokensHandler)
**Spec ref:** §26.4

**Description:**
/tokens returns all tokens unsorted. Spec doesn't mandate pagination; if seasons exceed ~100 tokens, clients pay full payload cost.

**Recommendation:** Add optional `?limit=N&offset=M` (forward-compatible) before scaling.

**Effort:** S

### [Indexer] BagLock unlockTimestamp comparison assumes positive bigint
**Severity:** Low
**Files:** packages/indexer/src/api/builders.ts:156
**Spec ref:** n/a

**Description:**
`unlockTimestamp > nowSec` — if `unlockTimestamp` is ever 0 or negative the comparison yields surprising behavior.

**Recommendation:** Add an assertion / comment that the value is always a positive Unix-seconds bigint.

**Effort:** XS

### [Indexer] Holder snapshot trigger values hardcoded as strings
**Severity:** Low
**Files:** packages/indexer/src/api/index.ts:367, 372
**Spec ref:** n/a

**Description:**
`r.trigger === "CUT"` and `r.trigger === "FINALIZE"` are string-literal comparisons.

**Recommendation:** Define `type HolderSnapshotTrigger = "CUT" | "FINALIZE"` (or const enum) and reuse across indexer + ponder schema.

**Effort:** XS

---

## INFO

### [Indexer] Known gap: price/volume/liquidity/holders all "0"
**Severity:** Info
**Files:** packages/indexer/src/api/builders.ts:121,173-177
**Spec ref:** n/a

**Description:**
Placeholders pending V4 PoolManager integration; documented in code comment.

**Recommendation:** Track explicit story for V4 data flow integration.

**Effort:** L (separate epic)

**Status:** ✅ FIXED in audit-remediation PR (Audit Finding H-1, indexer-high-batch-2 / 2026-05-02). Severity-rated High in batch dispatch despite the original Info classification — frontend cannot distinguish "value is genuinely zero" from "data not yet wired" so it surfaced "0 holders / $0 liquidity" across every row.
- Placeholder fields (`price`/`priceChange24h`/`volume24h`/`liquidity`/`holders`) now return `null` (web renders "—") instead of `0`/`"0"`.
- New `dataAvailability: {v4Reads, holderEnumeration}` block on every TokenRow tells the renderer whether to read the value cells at all. Both flags hard-coded `false` until the V4 read integration + `/tokens/:address/holders` endpoint ship; flipping a flag without wiring the underlying source would be a regression.
- Single source of truth: `TOKEN_DATA_AVAILABILITY` constant in `src/api/builders.ts`.
- Regression cover: `test/api/security/tokenRowPlaceholderHonesty.test.ts` (5 tests).
- V4 PoolManager wiring is a separate epic; this PR only stops the response from lying.

### [Indexer] EventsQueries.latestSeason takenAtSec captured at query time
**Severity:** Info
**Files:** packages/indexer/src/api/events/tick.ts:137
**Spec ref:** n/a

**Description:**
If a tick takes 10+ seconds, takenAtSec drifts from the actual snapshot time.

**Recommendation:** Document that takenAtSec must be captured at snapshot assembly time, not read time.

**Effort:** XS

### [Indexer] No API version endpoint
**Severity:** Info
**Files:** packages/indexer/src/api/index.ts
**Spec ref:** n/a

**Description:**
No `/api/version` for forward-compatibility.

**Recommendation:** Optional — add `{version, schemaVersion}` endpoint when first breaking change arrives.

**Effort:** XS

### [Indexer] Concentration filtering deferred per spec §41.2
**Severity:** Info
**Files:** packages/indexer/ (no holderConcentration)
**Spec ref:** §41.2-§41.3

**Description:**
Tracked deferral; ensure Phase-2 roadmap names explicit test gates.

**Recommendation:** Add to ROADMAP with backtest pre-conditions.

**Effort:** L (Phase 2)

---

TOTAL: Critical=2 High=6 Medium=6 Low=4 Info=4
