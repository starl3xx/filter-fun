import {describe, it, expect} from "vitest";
import {runScenario} from "../../src/harness/index.js";
import {dustSybilScenario} from "../../src/harness/scenarios/dust-sybil.js";
import {washTradeScenario} from "../../src/harness/scenarios/wash-trade.js";
import {whalePumpScenario} from "../../src/harness/scenarios/whale-pump.js";

describe("harness — canonical scenarios smoke", () => {
  it("wash-trade: assertions pass + final tick exists", () => {
    const r = runScenario(washTradeScenario);
    expect(r.timeseries.length).toBeGreaterThan(0);
    if (!r.assertionsPassed) {
      console.error("wash-trade results:", r.assertionResults);
      const last = r.timeseries[r.timeseries.length - 1];
      console.error("last tick:", last);
    }
    expect(r.assertionsPassed).toBe(true);
  });

  it("whale-pump: assertions pass", () => {
    const r = runScenario(whalePumpScenario);
    expect(r.timeseries.length).toBeGreaterThan(0);
    if (!r.assertionsPassed) {
      console.error("whale-pump results:", r.assertionResults);
    }
    expect(r.assertionsPassed).toBe(true);
  });

  it("dust-sybil: assertions pass", () => {
    const r = runScenario(dustSybilScenario);
    expect(r.timeseries.length).toBeGreaterThan(0);
    if (!r.assertionsPassed) {
      console.error("dust-sybil results:", r.assertionResults);
    }
    expect(r.assertionsPassed).toBe(true);
  });
});
