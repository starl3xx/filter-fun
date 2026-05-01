/// HP history endpoint tests — drives the pure handler in src/api/history.ts.
///
/// We hit the validation/range/bucket logic and the wire-shape contract; the actual
/// `hpSnapshot` row writes happen in a Ponder block-interval handler that's not
/// exercisable from vitest. Coverage of that writer is tracked in the README under
/// "Enrichment indexes — testing notes."

import {describe, expect, it} from "vitest";

import {
  bucketize,
  getTokenHistoryHandler,
  HISTORY_DEFAULT_INTERVAL_SEC,
  HISTORY_DEFAULT_RANGE_SEC,
  HISTORY_MAX_RANGE_SEC,
  parseInterval,
  parseRange,
  type HistoryQueries,
  type HistoryResponse,
  type HpSnapshotRow,
} from "../../src/api/history.js";

const NOW_SEC = 1_700_700_000n; // pinned for deterministic defaults

function addr(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
}

function row(
  tokenAddr: `0x${string}`,
  snapshotAtSec: bigint,
  hp = 50,
  rank = 1,
  phase = "competition",
): HpSnapshotRow {
  return {
    token: tokenAddr,
    snapshotAtSec,
    hp,
    rank,
    velocity: 0.4,
    effectiveBuyers: 0.3,
    stickyLiquidity: 0.5,
    retention: 0.6,
    momentum: 0.2,
    phase,
  };
}

function fixtureQueries(rows: HpSnapshotRow[]): HistoryQueries {
  return {
    hpSnapshotsForToken: async (tokenAddr, fromSec, toSec) =>
      rows
        .filter(
          (r) =>
            r.token.toLowerCase() === tokenAddr.toLowerCase() &&
            r.snapshotAtSec >= fromSec &&
            r.snapshotAtSec <= toSec,
        )
        .sort((a, b) => (a.snapshotAtSec < b.snapshotAtSec ? -1 : 1)),
  };
}

describe("/tokens/:address/history — validation", () => {
  it("rejects malformed address with 400", async () => {
    const r = await getTokenHistoryHandler(fixtureQueries([]), "not-an-address", {}, {nowSec: NOW_SEC});
    expect(r.status).toBe(400);
    expect(r.body).toEqual({error: "invalid address"});
  });

  it("rejects interval below the minimum", () => {
    expect(parseInterval("30")).toBeNull(); // < 60
  });
  it("rejects interval above the maximum", () => {
    expect(parseInterval("90000")).toBeNull(); // > 86400
  });
  it("uses the default interval when omitted", () => {
    expect(parseInterval(undefined)).toBe(HISTORY_DEFAULT_INTERVAL_SEC);
  });
  it("rejects non-numeric interval", () => {
    expect(parseInterval("five")).toBeNull();
  });

  it("defaults to a 7-day trailing range when from/to omitted", () => {
    const r = parseRange(undefined, undefined, NOW_SEC);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.toSec).toBe(NOW_SEC);
      expect(r.fromSec).toBe(NOW_SEC - BigInt(HISTORY_DEFAULT_RANGE_SEC));
    }
  });

  it("rejects from >= to", () => {
    const r = parseRange("100", "100", NOW_SEC);
    expect("error" in r).toBe(true);
  });

  it("rejects ranges over the 30-day cap", () => {
    const tenDaysAgo = Number(NOW_SEC) - HISTORY_MAX_RANGE_SEC - 60;
    const r = parseRange(tenDaysAgo.toString(), Number(NOW_SEC).toString(), NOW_SEC);
    expect("error" in r).toBe(true);
  });

  it("returns 400 with helpful message when interval invalid", async () => {
    const r = await getTokenHistoryHandler(
      fixtureQueries([]),
      addr(1),
      {interval: "1"},
      {nowSec: NOW_SEC},
    );
    expect(r.status).toBe(400);
  });
});

describe("/tokens/:address/history — wire shape + bucketing", () => {
  it("returns sorted points with all expected components", async () => {
    const t = addr(0x1);
    const rows: HpSnapshotRow[] = [
      row(t, 1_700_000_000n, 70),
      row(t, 1_700_000_300n, 75), // +5 min
      row(t, 1_700_000_600n, 80), // +10 min
    ];
    const r = await getTokenHistoryHandler(
      fixtureQueries(rows),
      t,
      {from: "1699999000", to: "1700001000", interval: "300"},
      {nowSec: NOW_SEC},
    );
    expect(r.status).toBe(200);
    const body = r.body as HistoryResponse;
    expect(body.token).toBe(t);
    expect(body.points).toHaveLength(3);
    expect(body.points[0]?.timestamp).toBeLessThan(body.points[1]?.timestamp ?? 0);
    expect(body.points[0]).toMatchObject({
      hp: 70,
      rank: 1,
      phase: "competition",
      components: {
        velocity: 0.4,
        effectiveBuyers: 0.3,
        stickyLiquidity: 0.5,
        retention: 0.6,
        momentum: 0.2,
      },
    });
  });

  it("interval bucketing — multiple samples in a window collapse to the latest", () => {
    const t = addr(0x2);
    // Anchor against a clean bucket boundary so the math is unambiguous: pick a base
    // that's a multiple of 300, then put samples at +0, +120, +290 (all in the same
    // 300s window) plus one in the next window at +320.
    const base = 1_700_000_100n; // 1_700_000_100 % 300 === 0
    const rows = [
      row(t, base, 50),
      row(t, base + 120n, 55),
      row(t, base + 290n, 60), // latest in this bucket
      row(t, base + 320n, 65), // first sample in the next bucket
    ];
    const points = bucketize(rows, 300);
    expect(points).toHaveLength(2);
    expect(points[0]?.timestamp).toBe(Number(base));
    expect(points[0]?.hp).toBe(60); // latest of first bucket
    expect(points[1]?.timestamp).toBe(Number(base + 300n));
    expect(points[1]?.hp).toBe(65);
  });

  it("range cap — toSec - fromSec > 30d returns 400", async () => {
    const t = addr(0x3);
    const r = await getTokenHistoryHandler(
      fixtureQueries([]),
      t,
      {
        from: (Number(NOW_SEC) - HISTORY_MAX_RANGE_SEC - 1).toString(),
        to: Number(NOW_SEC).toString(),
      },
      {nowSec: NOW_SEC},
    );
    expect(r.status).toBe(400);
  });

  it("empty result for a token with no snapshots returns 200 + empty points", async () => {
    const r = await getTokenHistoryHandler(
      fixtureQueries([]),
      addr(0x4),
      {},
      {nowSec: NOW_SEC},
    );
    expect(r.status).toBe(200);
    expect((r.body as HistoryResponse).points).toEqual([]);
  });
});
