import {describe, expect, it} from "vitest";
import type {Address, Hash} from "viem";

import {
  buildFilterEventPayload,
  buildSettlementPayload,
  type FilterEventPayload,
  type SettlementPayload,
} from "@filter-fun/oracle";

import type {ContractCallShape} from "../src/calls.js";
import {runFilterEvent, runSettlement, type TransactionDriver} from "../src/runner.js";

const VAULT: Address = "0x000000000000000000000000000000000000fafe";
const W: Address = "0x9999999999999999999999999999999999999999";
const L1: Address = "0x1111111111111111111111111111111111111111";
const L2: Address = "0x2222222222222222222222222222222222222222";
const ALICE: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface Sent {
  call: ContractCallShape;
  hash: Hash;
}

class FakeDriver implements TransactionDriver {
  sent: Sent[] = [];
  receipts: Hash[] = [];
  // Allow tests to make a specific receipt fail.
  failingReceipt?: Hash;
  // Counter for deterministic tx hashes.
  private nonce = 0;

  async writeContract(call: ContractCallShape): Promise<Hash> {
    const hash = `0x${(this.nonce++).toString(16).padStart(64, "0")}` as Hash;
    this.sent.push({call, hash});
    return hash;
  }
  async waitForReceipt(hash: Hash): Promise<void> {
    if (hash === this.failingReceipt) throw new Error(`receipt failed: ${hash}`);
    this.receipts.push(hash);
  }
}

function sampleFilter(losers: ReadonlyArray<Address> = [L1]): FilterEventPayload {
  const recoverable = new Map<Address, bigint>(losers.map((l) => [l, 1_000_000_000_000_000_000n]));
  return buildFilterEventPayload({losers, recoverable, slippageBps: 0});
}

function sampleSettlement(): SettlementPayload {
  return buildSettlementPayload({winner: W, shares: new Map([[ALICE, 100n]])});
}

describe("runFilterEvent", () => {
  it("sends one processFilterEvent tx and waits for its receipt", async () => {
    const driver = new FakeDriver();
    const tx = await runFilterEvent(driver, VAULT, sampleFilter([L1, L2]));
    expect(driver.sent.map((s) => s.call.functionName)).toEqual(["processFilterEvent"]);
    expect(driver.receipts).toEqual([tx]);
  });
});

describe("runSettlement", () => {
  it("dispatches each pending filter event then submitWinner, in order", async () => {
    const driver = new FakeDriver();
    const result = await runSettlement(
      driver,
      VAULT,
      [sampleFilter([L1]), sampleFilter([L2])],
      sampleSettlement(),
    );

    expect(driver.sent.map((s) => s.call.functionName)).toEqual([
      "processFilterEvent",
      "processFilterEvent",
      "submitWinner",
    ]);
    expect(result.filterEventTxs).toEqual([driver.sent[0]!.hash, driver.sent[1]!.hash]);
    expect(result.submitWinnerTx).toBe(driver.sent[2]!.hash);
  });

  it("waits for each receipt before sending the next call", async () => {
    const driver = new FakeDriver();
    await runSettlement(driver, VAULT, [sampleFilter([L1])], sampleSettlement());
    expect(driver.receipts).toEqual(driver.sent.map((s) => s.hash));
  });

  it("aborts if a filter-event receipt reverts (does not send submitWinner)", async () => {
    const driver = new FakeDriver();
    const filterHash = `0x${(0).toString(16).padStart(64, "0")}` as Hash;
    driver.failingReceipt = filterHash;

    await expect(
      runSettlement(driver, VAULT, [sampleFilter([L1])], sampleSettlement()),
    ).rejects.toThrow(/receipt failed/);
    expect(driver.sent.map((s) => s.call.functionName)).toEqual(["processFilterEvent"]);
  });

  it("forwards slippage guards into submitWinner", async () => {
    const driver = new FakeDriver();
    const payload = buildSettlementPayload({
      winner: W,
      shares: new Map([[ALICE, 1n]]),
      minWinnerTokensRollover: 11n,
      minWinnerTokensPol: 22n,
    });
    await runSettlement(driver, VAULT, [], payload);
    const submit = driver.sent.find((s) => s.call.functionName === "submitWinner")!;
    expect(submit.call.args[3]).toBe(11n);
    expect(submit.call.args[4]).toBe(22n);
  });

  it("handles zero pending filter events (already-cut season)", async () => {
    const driver = new FakeDriver();
    const result = await runSettlement(driver, VAULT, [], sampleSettlement());
    expect(result.filterEventTxs).toEqual([]);
    expect(driver.sent.map((s) => s.call.functionName)).toEqual(["submitWinner"]);
  });
});
