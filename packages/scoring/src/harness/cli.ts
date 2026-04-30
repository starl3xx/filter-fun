#!/usr/bin/env node
/// CLI entry for the harness. Two run modes:
///
/// 1. **Built-in canonical scenarios** —
///    `npm run harness -- wash-trade` (or `whale-pump` / `dust-sybil`).
///    Loads from `./scenarios/<name>.ts` and runs through the engine.
///
/// 2. **JSON event stream** — `npm run harness -- ./path/to/events.json`.
///    File must be a JSON array conforming to `HarnessEvent` (see
///    `./events.ts`); bigints serialized as decimal strings are accepted.
///    Useful for Track E historical replays where the corpus adapter
///    dumps a JSON event list.
///
/// Output goes to stdout by default; pass `--out <path>` to write to file.
/// `--seed <N>` overrides the PRNG seed (default 1).
///
/// Output format: `{ scenario, seed, config, timeseries, finalHP,
/// assertionResults }` JSON. `Map`s serialize as `{address: hp}` objects;
/// bigints serialize as decimal strings already (per `TickRecord.raw`).

import {readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {DEFAULT_HARNESS_CONFIG, runScenario, type HarnessEvent, type ScenarioDefinition} from "./index.js";
import {dustSybilScenario} from "./scenarios/dust-sybil.js";
import {washTradeScenario} from "./scenarios/wash-trade.js";
import {whalePumpScenario} from "./scenarios/whale-pump.js";

const CANONICAL: Record<string, ScenarioDefinition> = {
  "wash-trade": washTradeScenario,
  "whale-pump": whalePumpScenario,
  "dust-sybil": dustSybilScenario,
};

interface ParsedArgs {
  target: string;
  outPath?: string;
  seed: number;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const args = argv.slice(2);
  let target: string | undefined;
  let outPath: string | undefined;
  let seed = 1;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--out") {
      outPath = args[++i];
    } else if (a.startsWith("--out=")) {
      outPath = a.slice("--out=".length);
    } else if (a === "--seed") {
      seed = Number(args[++i]);
    } else if (a.startsWith("--seed=")) {
      seed = Number(a.slice("--seed=".length));
    } else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    } else if (!a.startsWith("--")) {
      target = a;
    }
  }
  if (!target) {
    printUsage();
    process.exit(1);
  }
  if (Number.isNaN(seed)) {
    process.stderr.write(`error: --seed must be a number\n`);
    process.exit(1);
  }
  return {target, outPath, seed};
}

function printUsage(): void {
  process.stderr.write(
    [
      "Usage: harness <scenario> [--out <path>] [--seed <n>]",
      "",
      "  <scenario>       Canonical name (wash-trade | whale-pump | dust-sybil)",
      "                   or path to a JSON file with a HarnessEvent[] array.",
      "  --out <path>     Write output JSON to file. Defaults to stdout.",
      "  --seed <n>       PRNG seed (default 1).",
      "",
    ].join("\n"),
  );
}

function loadJsonEvents(path: string): HarnessEvent[] {
  const raw = readFileSync(resolve(path), "utf8");
  const parsed = JSON.parse(raw, (_k, v) => {
    // Permit bigints expressed as `{$bigint: "1234"}` or as plain strings
    // ending in "n" (e.g. "1234n"). Rest fall through.
    if (v && typeof v === "object" && typeof (v as {$bigint?: string}).$bigint === "string") {
      return BigInt((v as {$bigint: string}).$bigint);
    }
    return v;
  });
  if (!Array.isArray(parsed)) {
    throw new Error(`harness: ${path} must be a JSON array of HarnessEvent`);
  }
  // Coerce ts + amount fields to bigint so the engine sees the right shape.
  return parsed.map((e) => coerceEvent(e));
}

function coerceEvent(e: Record<string, unknown>): HarnessEvent {
  const out = {...e} as Record<string, unknown>;
  for (const key of ["ts", "amountWeth", "initialLpWeth"]) {
    const v = out[key];
    if (typeof v === "string") out[key] = BigInt(v);
    else if (typeof v === "number") out[key] = BigInt(v);
  }
  return out as unknown as HarnessEvent;
}

function main(): void {
  const args = parseArgs(process.argv);
  const canonical = CANONICAL[args.target];
  let result;
  let scenarioName: string;
  if (canonical) {
    scenarioName = canonical.name;
    result = runScenario(canonical, {seed: args.seed});
  } else {
    scenarioName = args.target;
    const events = loadJsonEvents(args.target);
    result = runScenario(events, {seed: args.seed});
  }

  // `Map`s and `bigint`s aren't JSON-native; flatten before stringifying.
  const finalHpObj: Record<string, number> = {};
  for (const [token, hp] of result.finalHP) finalHpObj[token] = hp;

  const output = {
    scenario: scenarioName,
    seed: args.seed,
    config: DEFAULT_HARNESS_CONFIG,
    timeseries: result.timeseries,
    finalHP: finalHpObj,
    assertionResults: result.assertionResults,
    assertionsPassed: result.assertionsPassed,
  };

  // Custom replacer: bigints in `config` (DEFAULT_HARNESS_CONFIG.scoringConfig)
  // need string serialization. TickRecord.raw is already strings.
  const json = JSON.stringify(
    output,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );

  if (args.outPath) {
    writeFileSync(resolve(args.outPath), json);
    process.stderr.write(`harness: wrote ${result.timeseries.length} ticks to ${args.outPath}\n`);
  } else {
    process.stdout.write(json + "\n");
  }

  if (!result.assertionsPassed) {
    process.stderr.write(`harness: ${result.assertionResults.filter((r) => !r.passed).length} assertion(s) FAILED\n`);
    process.exit(2);
  }
}

main();
