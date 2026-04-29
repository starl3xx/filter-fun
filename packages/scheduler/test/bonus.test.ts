import {describe, expect, it} from "vitest";
import type {Address, Hash, Hex} from "viem";

import {
  claimBonus,
  claimBonusCall,
  postBonusRoot,
  postBonusRootCall,
  type ContractCallShape,
  type TransactionDriver,
} from "../src/index.js";

const BONUS: Address = "0x000000000000000000000000000000000000b011";
const ALICE: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ROOT: Hex = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

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

describe("postBonusRootCall", () => {
  it("packs (seasonId, root)", () => {
    const c = postBonusRootCall(BONUS, 7n, ROOT);
    expect(c.address).toBe(BONUS);
    expect(c.functionName).toBe("postRoot");
    expect(c.args).toEqual([7n, ROOT]);
  });
});

describe("claimBonusCall", () => {
  it("packs (seasonId, amount, proof)", () => {
    const proof: Hex[] = ["0xdead", "0xbeef"];
    const c = claimBonusCall(BONUS, 7n, 100n, proof);
    expect(c.functionName).toBe("claim");
    expect(c.args).toEqual([7n, 100n, proof]);
  });

  it("accepts an empty proof (single-leaf tree)", () => {
    const c = claimBonusCall(BONUS, 7n, 100n, []);
    expect(c.args).toEqual([7n, 100n, []]);
  });
});

describe("postBonusRoot", () => {
  it("sends the call and waits for the receipt", async () => {
    const driver = new FakeDriver();
    const hash = await postBonusRoot(driver, BONUS, 7n, {
      root: ROOT,
      entries: [{user: ALICE, amount: 100n, proof: []}],
      totalAllocated: 100n,
    });
    expect(driver.sent[0]?.functionName).toBe("postRoot");
    expect(driver.sent[0]?.args).toEqual([7n, ROOT]);
    expect(driver.receipts).toEqual([hash]);
  });
});

describe("claimBonus", () => {
  it("sends the call and waits for the receipt", async () => {
    const driver = new FakeDriver();
    const proof: Hex[] = ["0xdead"];
    const hash = await claimBonus(driver, BONUS, 7n, 100n, proof);
    expect(driver.sent[0]?.functionName).toBe("claim");
    expect(driver.sent[0]?.args).toEqual([7n, 100n, proof]);
    expect(driver.receipts).toEqual([hash]);
  });
});
