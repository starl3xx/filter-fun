import {describe, it, expect} from "vitest";
import {DEFAULT_HARNESS_CONFIG, ReplayEngine} from "../../src/harness/engine.js";
import {Scenario} from "../../src/harness/scenario.js";
import type {Address} from "../../src/types.js";

const TOKEN = "0x000000000000000000000000000000000000000a" as Address;
const TOKEN_B = "0x000000000000000000000000000000000000000b" as Address;
const W = (n: number): Address =>
  `0x${n.toString(16).padStart(40, "0")}` as Address;
const WETH = 1_000_000_000_000_000_000n;

describe("ReplayEngine — event application", () => {
  it("returns empty for empty input", () => {
    const e = new ReplayEngine([], DEFAULT_HARNESS_CONFIG);
    expect(e.run()).toEqual([]);
  });

  it("rejects events for tokens that haven't been launched", () => {
    const s = new Scenario({seed: 1});
    s.buy(W(1), TOKEN, WETH);
    expect(() => new ReplayEngine(s.build(), DEFAULT_HARNESS_CONFIG).run())
      .toThrow(/before LAUNCH/);
  });

  it("emits one TickRecord per (live token, tick) and orders by score result", () => {
    const s = new Scenario({seed: 1, startTs: 1_000n})
      .launch(TOKEN, WETH)
      .launch(TOKEN_B, WETH)
      .buy(W(1), TOKEN, WETH)
      .advance(60)
      .buy(W(2), TOKEN_B, WETH);
    const records = new ReplayEngine(s.build(), DEFAULT_HARNESS_CONFIG).run();
    expect(records.length).toBeGreaterThan(0);
    // Both tokens appear in every tick once both are live.
    const lastTick = records[records.length - 1]!.tick;
    const finalRecords = records.filter((r) => r.tick === lastTick);
    const tokens = new Set(finalRecords.map((r) => r.tokenId));
    expect(tokens.size).toBe(2);
  });

  it("LP_REMOVE with protocol=true is excluded from recent-withdrawal penalty", () => {
    // Two tokens, identical except one has a market LP_REMOVE and the other
    // has a protocol-flagged LP_REMOVE of the same size. The market remove
    // must show up in `recentLpRemovedWeth`; the protocol one must not.
    const market = new Scenario({seed: 1})
      .launch(TOKEN, 100n * WETH)
      .advance(60)
      .lpRemove(TOKEN, 50n * WETH, {protocol: false});
    const protocolPull = new Scenario({seed: 1})
      .launch(TOKEN, 100n * WETH)
      .advance(60)
      .lpRemove(TOKEN, 50n * WETH, {protocol: true});

    const eMarket = new ReplayEngine(market.build(), DEFAULT_HARNESS_CONFIG).run();
    const eProtocol = new ReplayEngine(protocolPull.build(), DEFAULT_HARNESS_CONFIG).run();

    const lastMarket = eMarket[eMarket.length - 1]!;
    const lastProtocol = eProtocol[eProtocol.length - 1]!;
    expect(BigInt(lastMarket.raw.recentLpRemovedWeth)).toBe(50n * WETH);
    expect(BigInt(lastProtocol.raw.recentLpRemovedWeth)).toBe(0n);
  });

  it("BUY credits balance + cumulative volume; SELL debits balance only", () => {
    const s = new Scenario({seed: 1})
      .launch(TOKEN, WETH)
      .buy(W(1), TOKEN, 5n * WETH)
      .advance(60)
      .sell(W(1), TOKEN, 2n * WETH);
    const records = new ReplayEngine(s.build(), DEFAULT_HARNESS_CONFIG).run();
    const last = records[records.length - 1]!;
    // Cumulative buy volume tracks gross buys, not net of sells (this is
    // what the scoring package expects in volumeByWallet).
    expect(BigInt(last.raw.totalVolumeWeth)).toBe(5n * WETH);
    // Balance after: 5 - 2 = 3 WETH; wallet still holds → holderCount=1.
    expect(last.raw.holderCount).toBe(1);
    expect(last.raw.uniqueWallets).toBe(1);
  });

  it("SELL down to zero removes the wallet from holders", () => {
    const s = new Scenario({seed: 1})
      .launch(TOKEN, WETH)
      .buy(W(1), TOKEN, WETH)
      .advance(60)
      .sell(W(1), TOKEN, WETH);
    const records = new ReplayEngine(s.build(), DEFAULT_HARNESS_CONFIG).run();
    const last = records[records.length - 1]!;
    expect(last.raw.holderCount).toBe(0);
    // Cumulative buys still 1 WETH (volumeByWallet is gross-buys-cumulative,
    // unchanged by sells).
    expect(BigInt(last.raw.totalVolumeWeth)).toBe(WETH);
  });

  it("PHASE event switches scoring weights mid-stream", () => {
    const s = new Scenario({seed: 1, startTs: 0n})
      .launch(TOKEN, WETH)
      .buy(W(1), TOKEN, WETH)
      .advance(60)
      .setPhase("finals");
    const records = new ReplayEngine(s.build(), DEFAULT_HARNESS_CONFIG).run();
    // First tick (before PHASE): pre-filter (scoringConfig default).
    // Last tick (after PHASE): finals.
    const last = records[records.length - 1]!;
    expect(last.phase).toBe("finals");
    // The phase event lives in the middle of the stream — at least one
    // pre-filter tick should exist before the switch.
    expect(records.some((r) => r.phase === "preFilter")).toBe(true);
  });

  it("avgLpDepth converges toward current depth as the window saturates", () => {
    // Add 100 WETH at t=0; query over a window that fully contains the
    // first hour. Expected avg ≈ 100 WETH (constant depth).
    const s = new Scenario({seed: 1, startTs: 0n})
      .launch(TOKEN, 100n * WETH)
      .advance(3600);
    const records = new ReplayEngine(s.build(), {
      ...DEFAULT_HARNESS_CONFIG,
      avgLpWindowSec: 3600,
    }).run();
    const last = records[records.length - 1]!;
    expect(BigInt(last.raw.avgLpDepthWeth)).toBe(100n * WETH);
    expect(BigInt(last.raw.lpDepthWeth)).toBe(100n * WETH);
  });
});
