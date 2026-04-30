import {describe, it, expect} from "vitest";
import {runScenario} from "../../src/harness/index.js";
import {Scenario} from "../../src/harness/scenario.js";
import {dustSybilScenario} from "../../src/harness/scenarios/dust-sybil.js";
import {washTradeScenario} from "../../src/harness/scenarios/wash-trade.js";
import {whalePumpScenario} from "../../src/harness/scenarios/whale-pump.js";
import {mulberry32} from "../../src/harness/prng.js";
import type {Address} from "../../src/types.js";

const TOKEN = "0x000000000000000000000000000000000000000a" as Address;
const W = (n: number): Address =>
  `0x${n.toString(16).padStart(40, "0")}` as Address;
const WETH = 1_000_000_000_000_000_000n;

describe("harness — determinism", () => {
  it("same seed + same scenario → byte-identical timeseries", () => {
    const a = runScenario(washTradeScenario, {seed: 42});
    const b = runScenario(washTradeScenario, {seed: 42});
    expect(serialize(a.timeseries)).toBe(serialize(b.timeseries));
  });

  it("byte-identical across all three canonical scenarios", () => {
    for (const scen of [washTradeScenario, whalePumpScenario, dustSybilScenario]) {
      const a = runScenario(scen, {seed: 7});
      const b = runScenario(scen, {seed: 7});
      expect(serialize(a.timeseries)).toBe(serialize(b.timeseries));
    }
  });

  it("identical event streams without a scenario produce identical output", () => {
    // Build a manual event list; run twice through runScenario(events[]).
    const events = new Scenario({seed: 0, startTs: 1_000n})
      .launch(TOKEN, 5n * WETH)
      .buy(W(1), TOKEN, WETH)
      .advance(60)
      .buy(W(2), TOKEN, WETH)
      .advance(60)
      .sell(W(1), TOKEN, WETH / 2n)
      .build();
    const a = runScenario(events);
    const b = runScenario(events);
    expect(serialize(a.timeseries)).toBe(serialize(b.timeseries));
  });

  it("mulberry32 produces a reproducible sequence per seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({length: 100}, () => a());
    const seqB = Array.from({length: 100}, () => b());
    expect(seqA).toEqual(seqB);
    // And different seeds should diverge — sanity that we're not just
    // returning the same sequence regardless of input.
    const c = mulberry32(43);
    const seqC = Array.from({length: 100}, () => c());
    expect(seqA).not.toEqual(seqC);
  });
});

/// JSON.stringify with bigint coercion. The harness output already has
/// bigints serialized as strings inside `raw`, so this helper is mostly a
/// safety net for any future fields that introduce bigints.
function serialize(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}
