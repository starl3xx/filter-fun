/// /wallets/:address/holdings handler tests (Epic 1.23).
///
/// Pure handler exercise — pins the wire shape, the projection math (spec §11
/// + SeasonVault losers-pot split), and the null-result rules (post-settlement
/// suppression, sub-dust holders, no-cut-snapshot fallback).

import {describe, expect, it} from "vitest";

import {
  getHoldingsHandler,
  rolloverSliceFromProceeds,
  type CutSnapshotForToken,
  type HoldingsQueries,
  type HoldingsResponse,
  type HoldingTokenRow,
} from "../../src/api/holdings.js";

function addr(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
}

function fixtureQueries(opts: {
  positions?: HoldingTokenRow[];
  cuts?: Map<string, CutSnapshotForToken | null>;
}): HoldingsQueries {
  return {
    holdingsForUser: async () => opts.positions ?? [],
    cutSnapshotForToken: async (tokenAddr) =>
      (opts.cuts ?? new Map()).get(tokenAddr.toLowerCase()) ?? null,
  };
}

const FIXED_NOW_SEC = 1_730_000_000;
const fixedNowSec = (): number => FIXED_NOW_SEC;

describe("/wallets/:address/holdings", () => {
  it("rejects malformed address with 400", async () => {
    const r = await getHoldingsHandler(fixtureQueries({}), "garbage", fixedNowSec);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({error: "invalid address"});
  });

  it("normalizes mixed-case address to lowercase before lookup", async () => {
    let queriedWith: `0x${string}` | null = null;
    const q: HoldingsQueries = {
      holdingsForUser: async (a) => {
        queriedWith = a;
        return [];
      },
      cutSnapshotForToken: async () => null,
    };
    const lower = addr(0xa1b2);
    const upper = lower.toUpperCase().replace("0X", "0x");
    const r = await getHoldingsHandler(q, upper, fixedNowSec);
    expect(r.status).toBe(200);
    expect(queriedWith).toBe(lower);
    expect((r.body as HoldingsResponse).wallet).toBe(lower);
  });

  it("empty wallet returns 200 with zero totals + asOf timestamp", async () => {
    const r = await getHoldingsHandler(fixtureQueries({positions: []}), addr(1), fixedNowSec);
    expect(r.status).toBe(200);
    const body = r.body as HoldingsResponse;
    expect(body.tokens).toEqual([]);
    expect(body.totalProjectedWeth).toBe("0");
    expect(body.totalProjectedWethFormatted).toBe("0");
    expect(body.asOf).toBe(FIXED_NOW_SEC);
  });

  it("multi-state: filtered (with CUT row) + active + winner + post-settlement", async () => {
    const wallet = addr(0xcafe);
    const tokA = addr(0xa1); // filtered with CUT row → projection
    const tokB = addr(0xb2); // active, not filtered → null projection
    const tokC = addr(0xc3); // winner → null projection
    const tokD = addr(0xd4); // post-settlement filtered → null projection (claim is on-chain)
    const cuts = new Map<string, CutSnapshotForToken | null>([
      // wallet held 25% of the cut supply on tokA. Projection should be 25% of
      // the rollover slice computed from 1 ETH proceeds.
      [tokA.toLowerCase(), {walletCutBalance: 250n * 10n ** 18n, totalCutBalance: 1_000n * 10n ** 18n}],
    ]);
    const r = await getHoldingsHandler(
      fixtureQueries({
        positions: [
          {
            token: tokA,
            symbol: "ABC",
            seasonId: 7n,
            liquidated: true,
            isFinalist: false,
            liquidationProceeds: 10n ** 18n, // 1 ETH proceeds
            balance: 250n * 10n ** 18n,
            seasonWinner: null, // not yet finalized
            winnerSettledAt: null,
          },
          {
            token: tokB,
            symbol: "DEF",
            seasonId: 7n,
            liquidated: false,
            isFinalist: false,
            liquidationProceeds: null,
            balance: 5n * 10n ** 16n,
            seasonWinner: null,
            winnerSettledAt: null,
          },
          {
            token: tokC,
            symbol: "$XYZ",
            seasonId: 7n,
            liquidated: false,
            isFinalist: true,
            liquidationProceeds: null,
            balance: 5n * 10n ** 18n,
            seasonWinner: tokC, // this token is the winner
            winnerSettledAt: null,
          },
          {
            token: tokD,
            symbol: "OLD",
            seasonId: 5n,
            liquidated: true,
            isFinalist: false,
            liquidationProceeds: 2n * 10n ** 18n, // 2 ETH proceeds
            balance: 100n * 10n ** 18n,
            seasonWinner: addr(0xdead), // someone else won
            winnerSettledAt: 1_729_000_000n, // post-settlement → suppress
          },
        ],
        cuts,
      }),
      wallet,
      fixedNowSec,
    );
    expect(r.status).toBe(200);
    const body = r.body as HoldingsResponse;
    expect(body.tokens).toHaveLength(4);

    const byAddr = new Map(body.tokens.map((t) => [t.address.toLowerCase(), t]));
    const a = byAddr.get(tokA.toLowerCase())!;
    expect(a.ticker).toBe("$ABC");
    expect(a.season).toBe(7);
    expect(a.isFiltered).toBe(true);
    expect(a.isWinner).toBe(false);
    expect(a.postSettlement).toBe(false);
    // 1 ETH proceeds * 9750/10000 (after bounty) * 4500/10000 (rollover slice)
    // = 0.43875 ETH; wallet holds 25% so projection = 0.109687500 ETH
    // (0.4387500 * 0.25 = 0.10968750000000000 ETH; precision in wei).
    const expectedSlice = (10n ** 18n * 9_750n * 4_500n) / (10_000n * 10_000n);
    const expectedProjection = (expectedSlice * 250n) / 1_000n;
    expect(a.projectedRolloverWeth).toBe(expectedProjection.toString());

    const b = byAddr.get(tokB.toLowerCase())!;
    expect(b.isFiltered).toBe(false);
    expect(b.projectedRolloverWeth).toBeNull();

    const c = byAddr.get(tokC.toLowerCase())!;
    expect(c.isWinner).toBe(true);
    expect(c.projectedRolloverWeth).toBeNull();

    const d = byAddr.get(tokD.toLowerCase())!;
    expect(d.postSettlement).toBe(true);
    expect(d.isFiltered).toBe(true);
    // Post-settlement suppresses projection — claim has moved to the on-chain Merkle.
    expect(d.projectedRolloverWeth).toBeNull();

    expect(body.totalProjectedWeth).toBe(expectedProjection.toString());
  });

  it("filtered token with no CUT-snapshot row: projection null, position still listed", async () => {
    const wallet = addr(0xb33f);
    const tokA = addr(0xa1);
    const r = await getHoldingsHandler(
      fixtureQueries({
        positions: [
          {
            token: tokA,
            symbol: "GHI",
            seasonId: 9n,
            liquidated: true,
            isFinalist: false,
            liquidationProceeds: 5n * 10n ** 17n,
            balance: 1n * 10n ** 18n,
            seasonWinner: null,
            winnerSettledAt: null,
          },
        ],
        cuts: new Map(), // no CUT row → wallet was sub-dust at the cut OR didn't index
      }),
      wallet,
      fixedNowSec,
    );
    const body = r.body as HoldingsResponse;
    expect(body.tokens[0]?.isFiltered).toBe(true);
    expect(body.tokens[0]?.projectedRolloverWeth).toBeNull();
    expect(body.totalProjectedWeth).toBe("0");
  });

  it("rollover slice math matches SeasonVault BPS (9750 × 4500 / 1e8)", () => {
    // 1 ETH proceeds → bounty = 0.025 ETH, remainder = 0.975 ETH, rollover = 0.4 387 500…
    expect(rolloverSliceFromProceeds(10n ** 18n)).toBe(
      (10n ** 18n * 9_750n * 4_500n) / (10_000n * 10_000n),
    );
    expect(rolloverSliceFromProceeds(0n)).toBe(0n);
    expect(rolloverSliceFromProceeds(-1n)).toBe(0n);
  });

  it("aggregates totalProjectedWeth across multiple filtered tokens", async () => {
    const wallet = addr(0x1234);
    const tokA = addr(0xa1);
    const tokB = addr(0xb2);
    // Half-share of 2 ETH proceeds + tenth-share of 5 ETH proceeds.
    const cuts = new Map<string, CutSnapshotForToken | null>([
      [tokA.toLowerCase(), {walletCutBalance: 1n * 10n ** 18n, totalCutBalance: 2n * 10n ** 18n}],
      [tokB.toLowerCase(), {walletCutBalance: 1n * 10n ** 18n, totalCutBalance: 10n * 10n ** 18n}],
    ]);
    const r = await getHoldingsHandler(
      fixtureQueries({
        positions: [
          {
            token: tokA,
            symbol: "A",
            seasonId: 1n,
            liquidated: true,
            isFinalist: false,
            liquidationProceeds: 2n * 10n ** 18n,
            balance: 1n * 10n ** 18n,
            seasonWinner: null,
            winnerSettledAt: null,
          },
          {
            token: tokB,
            symbol: "B",
            seasonId: 1n,
            liquidated: true,
            isFinalist: false,
            liquidationProceeds: 5n * 10n ** 18n,
            balance: 1n * 10n ** 18n,
            seasonWinner: null,
            winnerSettledAt: null,
          },
        ],
        cuts,
      }),
      wallet,
      fixedNowSec,
    );
    const body = r.body as HoldingsResponse;
    const sliceA = rolloverSliceFromProceeds(2n * 10n ** 18n) / 2n;
    const sliceB = rolloverSliceFromProceeds(5n * 10n ** 18n) / 10n;
    expect(body.totalProjectedWeth).toBe((sliceA + sliceB).toString());
    expect(body.tokens.find((t) => t.address === tokA)?.projectedRolloverWeth).toBe(sliceA.toString());
    expect(body.tokens.find((t) => t.address === tokB)?.projectedRolloverWeth).toBe(sliceB.toString());
  });
});
