import {describe, expect, it} from "vitest";
import type {Address, Hash} from "viem";

import {
  advancePhase,
  advancePhaseCall,
  Phase,
  runPhaseArc,
  setFinalists,
  setFinalistsCall,
  startSeason,
  startSeasonCall,
  type ContractCallShape,
  type TransactionDriver,
} from "../src/index.js";

const LAUNCHER: Address = "0x000000000000000000000000000000000000face";
const TOKEN_A: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

class FakeDriver implements TransactionDriver {
  sent: ContractCallShape[] = [];
  receipts: Hash[] = [];
  private nonce = 0;
  async writeContract(call: ContractCallShape): Promise<Hash> {
    const hash = `0x${(this.nonce++).toString(16).padStart(64, "0")}` as Hash;
    this.sent.push(call);
    return hash;
  }
  async waitForReceipt(hash: Hash): Promise<void> {
    this.receipts.push(hash);
  }
}

describe("call builders", () => {
  it("startSeasonCall takes no args", () => {
    const c = startSeasonCall(LAUNCHER);
    expect(c.address).toBe(LAUNCHER);
    expect(c.functionName).toBe("startSeason");
    expect(c.args).toEqual([]);
  });

  it("advancePhaseCall packs (seasonId, phaseEnum)", () => {
    const c = advancePhaseCall(LAUNCHER, 7n, Phase.Filter);
    expect(c.functionName).toBe("advancePhase");
    expect(c.args).toEqual([7n, 1]); // Phase.Filter == 1
  });

  it("setFinalistsCall packs (seasonId, finalists[])", () => {
    const c = setFinalistsCall(LAUNCHER, 7n, [TOKEN_A, TOKEN_B]);
    expect(c.functionName).toBe("setFinalists");
    expect(c.args).toEqual([7n, [TOKEN_A, TOKEN_B]]);
  });
});

describe("Phase enum", () => {
  it("matches the contract's IFilterLauncher.Phase ordering", () => {
    expect(Phase.Launch).toBe(0);
    expect(Phase.Filter).toBe(1);
    expect(Phase.Finals).toBe(2);
    expect(Phase.Settlement).toBe(3);
    expect(Phase.Closed).toBe(4);
  });
});

describe("single-step helpers", () => {
  it("startSeason sends the call and waits for the receipt", async () => {
    const driver = new FakeDriver();
    const hash = await startSeason(driver, LAUNCHER);
    expect(driver.sent[0]?.functionName).toBe("startSeason");
    expect(driver.receipts).toEqual([hash]);
  });

  it("advancePhase sends the call and waits for the receipt", async () => {
    const driver = new FakeDriver();
    await advancePhase(driver, LAUNCHER, 1n, Phase.Filter);
    expect(driver.sent[0]?.functionName).toBe("advancePhase");
    expect(driver.sent[0]?.args).toEqual([1n, 1]);
  });

  it("setFinalists sends the call and waits for the receipt", async () => {
    const driver = new FakeDriver();
    await setFinalists(driver, LAUNCHER, 1n, [TOKEN_A]);
    expect(driver.sent[0]?.functionName).toBe("setFinalists");
  });
});

describe("runPhaseArc", () => {
  it("drives Launch→Filter→setFinalists→Finals→Settlement in that order", async () => {
    const driver = new FakeDriver();
    const result = await runPhaseArc(driver, LAUNCHER, 1n, [TOKEN_A, TOKEN_B]);

    expect(driver.sent.map((s) => s.functionName)).toEqual([
      "advancePhase", // → Filter
      "setFinalists",
      "advancePhase", // → Finals
      "advancePhase", // → Settlement
    ]);
    // Phase targets: 1, _, 2, 3
    expect(driver.sent[0]!.args).toEqual([1n, Phase.Filter]);
    expect(driver.sent[2]!.args).toEqual([1n, Phase.Finals]);
    expect(driver.sent[3]!.args).toEqual([1n, Phase.Settlement]);

    expect(result.toFilterTx).toBe(driver.receipts[0]);
    expect(result.toSettlementTx).toBe(driver.receipts[3]);
  });

  it("rejects empty finalist set", async () => {
    const driver = new FakeDriver();
    await expect(runPhaseArc(driver, LAUNCHER, 1n, [])).rejects.toThrow(/non-empty/);
    expect(driver.sent).toHaveLength(0);
  });
});
