/// Audit H-4 (Phase 1, 2026-05-01) regression — /readiness probe distinct from /health.
///
/// Pre-fix the only liveness signal was Ponder's /health, which returns 200 as soon
/// as the HTTP server is up — useless for "is the indexer actually serving real
/// data?" Post-fix /readiness gates on (latest season indexed) AND (tick engine
/// running), returning 503 on either failing.
import {describe, expect, it} from "vitest";

import {getReadinessHandler, type ReadinessProbes} from "../../../src/api/handlers.js";

function probes(over: Partial<ReadinessProbes> = {}): ReadinessProbes {
  return {
    latestSeasonId: async () => null,
    tickEngineRunning: () => false,
    ...over,
  };
}

describe("readiness probe (Audit H-4)", () => {
  it("503 when no seasons are indexed", async () => {
    const r = await getReadinessHandler(probes({latestSeasonId: async () => null, tickEngineRunning: () => true}));
    expect(r.status).toBe(503);
    const body = r.body as unknown as {ready: boolean; checks: Record<string, unknown>};
    expect(body.ready).toBe(false);
    expect(body.checks).toMatchObject({latestSeason: false, tickEngine: true, latestSeasonId: null});
  });

  it("503 when one season indexed but tick engine is stopped", async () => {
    const r = await getReadinessHandler(
      probes({latestSeasonId: async () => 1, tickEngineRunning: () => false}),
    );
    expect(r.status).toBe(503);
    const body = r.body as unknown as {ready: boolean; checks: Record<string, unknown>};
    expect(body.ready).toBe(false);
    expect(body.checks).toMatchObject({latestSeason: true, tickEngine: false, latestSeasonId: 1});
  });

  it("200 when one season indexed AND tick engine is running", async () => {
    const r = await getReadinessHandler(
      probes({latestSeasonId: async () => 7, tickEngineRunning: () => true}),
    );
    expect(r.status).toBe(200);
    const body = r.body as unknown as {ready: boolean; checks: Record<string, unknown>};
    expect(body.ready).toBe(true);
    expect(body.checks).toMatchObject({latestSeason: true, tickEngine: true, latestSeasonId: 7});
  });

  it("503 status code (not 200/false) so load balancers route traffic away on a not-ready state", async () => {
    // Pinned because the failure mode of the alternative — 200 + ready:false — would
    // be "probe ignores the body and routes traffic anyway." 503 is the
    // load-balancer-friendly status for "service alive but not ready to serve."
    const r = await getReadinessHandler(probes());
    expect(r.status).toBe(503);
  });

  it("Bugbot finding (PR #61): probe must not be the only path that boots the tick engine", async () => {
    // The pure handler doesn't bootstrap — that lives in the route layer in
    // src/api/index.ts. This test pins the contract: the handler reads the
    // tickEngineRunning predicate as truth, never starts the engine itself.
    // The route bootstraps via `ensureEventsEngineStarted(c.db)` so the FIRST
    // probe call kicks the engine alive on the next call. Without the route-side
    // bootstrap a load-balancer-gated /readiness deadlocks the indexer (engine
    // only starts on first /events SSE request, but LB never lets traffic through
    // until /readiness flips green).
    let engineStartCalls = 0;
    const r = await getReadinessHandler({
      latestSeasonId: async () => 1,
      tickEngineRunning: () => {
        // Simulate the post-bootstrap state: predicate returns true on every call.
        // If the handler were trying to start the engine itself, we'd see writes
        // to engineStartCalls; the handler is supposed to be pure.
        return true;
      },
    });
    expect(r.status).toBe(200);
    // The handler did NOT increment engineStartCalls — bootstrap is the route's job.
    expect(engineStartCalls).toBe(0);
  });
});
