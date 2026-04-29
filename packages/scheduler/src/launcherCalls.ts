import type {Address} from "viem";

import {FilterLauncherAbi, Phase} from "./launcherAbi.js";

/// Same shape as `ContractCall` from calls.ts, but specialized to the FilterLauncher ABI.
/// Kept separate so callers don't have to deal with abi-union types.
export interface LauncherCall<TFunctionName extends string> {
  address: Address;
  abi: typeof FilterLauncherAbi;
  functionName: TFunctionName;
  args: ReadonlyArray<unknown>;
}

export function startSeasonCall(launcher: Address): LauncherCall<"startSeason"> {
  return {
    address: launcher,
    abi: FilterLauncherAbi,
    functionName: "startSeason",
    args: [],
  };
}

export function advancePhaseCall(
  launcher: Address,
  seasonId: bigint,
  target: Phase,
): LauncherCall<"advancePhase"> {
  return {
    address: launcher,
    abi: FilterLauncherAbi,
    functionName: "advancePhase",
    args: [seasonId, target],
  };
}

export function setFinalistsCall(
  launcher: Address,
  seasonId: bigint,
  finalists: ReadonlyArray<Address>,
): LauncherCall<"setFinalists"> {
  return {
    address: launcher,
    abi: FilterLauncherAbi,
    functionName: "setFinalists",
    args: [seasonId, finalists],
  };
}
