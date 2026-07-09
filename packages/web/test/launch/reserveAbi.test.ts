/// Part 0 regression — the launch write path is `reserve`, not `launchToken`.
///
/// History: the web's ABI fragment drifted to a `launchToken(name, symbol,
/// metadataURI)` entry point that never shipped — the deployed contract's
/// ONLY public entry is `reserve(string ticker, string metadataURI)` (spec
/// §46.9), which made every launch submit revert with an opaque selector on
/// any chain. This test pins the ABI shape at the source of truth so the
/// drift can't recur: function name, the two string inputs, payability, the
/// absence of launchToken, and the custom-error surface viem needs to decode
/// reverts into the humanError copy.

import {describe, expect, it} from "vitest";

import {FilterLauncherLaunchAbi} from "@/lib/launch/abi";

type AbiEntry = (typeof FilterLauncherLaunchAbi)[number];

function fns(): Extract<AbiEntry, {type: "function"}>[] {
  return FilterLauncherLaunchAbi.filter(
    (e): e is Extract<AbiEntry, {type: "function"}> => e.type === "function",
  );
}

describe("FilterLauncherLaunchAbi — reserve() write path (Part 0 regression)", () => {
  it("declares reserve(string ticker, string metadataURI) payable", () => {
    const reserve = fns().find((f) => f.name === "reserve");
    expect(reserve).toBeDefined();
    expect(reserve!.stateMutability).toBe("payable");
    expect(reserve!.inputs).toHaveLength(2);
    expect(reserve!.inputs.map((i) => i.type)).toEqual(["string", "string"]);
    // Argument ORDER is load-bearing: (ticker, metadataURI). Swapping them
    // would pass the type check and put an ipfs:// URI through TickerLib.
    expect(reserve!.inputs.map((i) => ("name" in i ? i.name : ""))).toEqual([
      "ticker",
      "metadataURI",
    ]);
  });

  it("does NOT declare the never-shipped launchToken entry point", () => {
    // Widen to string — TS narrows the const-asserted union so tightly that a
    // direct comparison is a compile error once launchToken is gone (which is
    // the point: this guards a RE-ADDITION, where the type would widen again).
    expect(fns().some((f) => (f.name as string) === "launchToken")).toBe(false);
  });

  it("declares no lens-only views — getLaunchStatus/getLaunchSlots/canReserve live on LauncherLensAbi", () => {
    // Epic 1.15a drift guard, part two: the launcher externalized its read
    // views to LauncherLens (EIP-170). Re-adding them to the LAUNCHER fragment
    // would compile fine and revert on-chain — the same silent failure mode as
    // launchToken. `canLaunch`/`launchesByWallet`/`maxLaunchesPerWallet` are
    // gone from the contracts entirely (spec §46 structural per-wallet cap).
    const names = fns().map((f) => f.name as string);
    for (const gone of [
      "getLaunchStatus",
      "getLaunchSlots",
      "canReserve",
      "canLaunch",
      "launchesByWallet",
      "maxLaunchesPerWallet",
      "launchCost",
    ]) {
      expect(names, `${gone} must not be on the launcher fragment`).not.toContain(gone);
    }
  });

  it("declares the reserve() custom-error surface for viem revert decoding", () => {
    const errorNames = FilterLauncherLaunchAbi.filter((e) => e.type === "error").map(
      (e) => (e as {name: string}).name,
    );
    // One error per validation gate (spec §46.9). Missing entries degrade
    // humanError to an opaque hex selector — the exact failure mode the
    // Part 0 fix removed.
    for (const name of [
      "WrongPhase",
      "SeasonAlreadyAborted",
      "WindowClosed",
      "AlreadyReserved",
      "SlotsExhausted",
      "InvalidTickerFormat",
      "TickerBlocklisted",
      "TickerWinnerReserved",
      "TickerTaken",
      "InsufficientEscrow",
      "RefundFailed",
    ]) {
      expect(errorNames, `missing error ${name}`).toContain(name);
    }
    // The old mapping referenced errors that don't exist on the contract —
    // keep them out so a copy-paste revival is loud.
    expect(errorNames).not.toContain("InsufficientPayment");
    expect(errorNames).not.toContain("LaunchWindowClosed");
  });
});
