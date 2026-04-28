import {describe, expect, it} from "vitest";
import type {Address, Hash} from "viem";

import {buildSettlementPayload} from "@filter-fun/oracle";

import type {ContractCall} from "../src/calls.js";
import {runSettlement, type TransactionDriver} from "../src/runner.js";

const VAULT: Address = "0x000000000000000000000000000000000000fafe";
const W: Address = "0x9999999999999999999999999999999999999999";
const L1: Address = "0x1111111111111111111111111111111111111111";
const L2: Address = "0x2222222222222222222222222222222222222222";
const ALICE: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface Sent {
  call: ContractCall<string>;
  hash: Hash;
}

class FakeDriver implements TransactionDriver {
  sent: Sent[] = [];
  receipts: Hash[] = [];
  // Allow tests to make a specific receipt fail.
  failingReceipt?: Hash;
  // Counter for deterministic tx hashes.
  private nonce = 0;

  async writeContract(call: ContractCall<string>): Promise<Hash> {
    const hash = `0x${(this.nonce++).toString(16).padStart(64, "0")}` as Hash;
    this.sent.push({call, hash});
    return hash;
  }
  async waitForReceipt(hash: Hash): Promise<void> {
    if (hash === this.failingReceipt) throw new Error(`receipt failed: ${hash}`);
    this.receipts.push(hash);
  }
}

function samplePayload() {
  return buildSettlementPayload({
    ranking: [W, L1, L2],
    recoverable: new Map([[L1, 1_000_000_000_000_000_000n], [L2, 2_000_000_000_000_000_000n]]),
    slippageBps: 0,
    shares: new Map([[ALICE, 100n]]),
    liquidationDeadline: 1_700_000_000n,
  });
}

describe("runSettlement", () => {
  it("submits in the right order: submitSettlement → liquidate(L1) → liquidate(L2) → finalize", async () => {
    const driver = new FakeDriver();
    const payload = samplePayload();
    const result = await runSettlement(driver, VAULT, payload);

    expect(driver.sent.map((s) => s.call.functionName)).toEqual([
      "submitSettlement",
      "liquidate",
      "liquidate",
      "finalize",
    ]);
    expect(result.liquidateTxs.map((t) => t.loser)).toEqual([L1, L2]);
    expect(result.submitTx).toBe(driver.sent[0]!.hash);
    expect(result.finalizeTx).toBe(driver.sent[3]!.hash);
  });

  it("waits for each receipt before sending the next call", async () => {
    const driver = new FakeDriver();
    await runSettlement(driver, VAULT, samplePayload());
    // Each sent tx has a corresponding receipt-wait in order.
    expect(driver.receipts).toEqual(driver.sent.map((s) => s.hash));
  });

  it("aborts if a liquidate receipt reverts (does not send finalize)", async () => {
    const driver = new FakeDriver();
    // Pre-compute the second-tx hash (index 1 = first liquidate). The fake driver mints
    // hashes deterministically, so we know it'll be 0x...01.
    const liquidate1Hash = `0x${(1).toString(16).padStart(64, "0")}` as Hash;
    driver.failingReceipt = liquidate1Hash;

    await expect(runSettlement(driver, VAULT, samplePayload())).rejects.toThrow(/receipt failed/);
    // submitSettlement + the failing liquidate were sent; no second liquidate, no finalize.
    expect(driver.sent.map((s) => s.call.functionName)).toEqual(["submitSettlement", "liquidate"]);
  });

  it("forwards minOutOverride for a specific loser", async () => {
    const driver = new FakeDriver();
    const overrides = new Map<Address, bigint>([[L2, 999n]]);
    await runSettlement(driver, VAULT, samplePayload(), {minOutOverrides: overrides});

    const liquidates = driver.sent.filter((s) => s.call.functionName === "liquidate");
    expect(liquidates[0]!.call.args).toEqual([L1, 0n]);
    expect(liquidates[1]!.call.args).toEqual([L2, 999n]);
  });

  it("forwards finalize slippage guards", async () => {
    const driver = new FakeDriver();
    await runSettlement(driver, VAULT, samplePayload(), {
      minWinnerTokensRollover: 11n,
      minWinnerTokensPol: 22n,
    });
    const finalize = driver.sent.find((s) => s.call.functionName === "finalize")!;
    expect(finalize.call.args).toEqual([11n, 22n]);
  });
});
