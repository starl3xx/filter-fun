/// Phase 3 — parameterized fixture runner (spec §6.13).
///
/// Each fixture is a JSON file: `(input_bundle, expected_output, weightsVersion)`.
/// The runner loads every fixture under `test/fixtures/`, materializes the
/// `TokenStats` shape from the JSON, calls the appropriate scoring helper,
/// and asserts the deterministic output.
///
/// **CI gate.** A PR that bumps `HP_WEIGHTS_VERSION` MUST update fixture
/// expected values OR explicitly add a `version-bump-fixtures-deferred`
/// label. The runner asserts each fixture's `weightsVersion` matches the
/// active `HP_WEIGHTS_VERSION` and fails loud otherwise — see the version
/// gate test in `runFixtures.test.ts`.
///
/// **Determinism.** Component fixtures call the package's component helpers
/// directly (pure functions of (input, currentTime)) so a single failure
/// surfaces a misaligned formula, not cohort interaction. Composite
/// fixtures call `score()` with the cohort and assert the integer HP plus
/// rank order under fixed-reference normalization.

import {readFileSync, readdirSync, statSync} from "node:fs";
import {join, relative, dirname} from "node:path";
import {fileURLToPath} from "node:url";

import {
  computeHolderConcentration,
  HP_WEIGHTS_VERSION,
  score,
  type Address,
  type ScoredToken,
  type ScoringConfig,
  type TokenStats,
} from "../../src/index.js";
import {DEFAULT_CONFIG} from "../../src/types.js";

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

/// Component-fixture JSON shape.
export interface ComponentFixture {
  /// Human-readable name; matches the file name minus `.json`.
  name: string;
  /// Free-form description used in test failure messages.
  description: string;
  /// `HP_WEIGHTS_VERSION` this fixture was authored against. Must match
  /// the active version or the runner fails (see CI gate).
  weightsVersion: string;
  /// Which component to evaluate. Used to dispatch to the right helper.
  component:
    | "velocity"
    | "effectiveBuyers"
    | "stickyLiquidity"
    | "retention"
    | "holderConcentration";
  /// Wall-clock for the scoring call, unix seconds.
  nowSec: number;
  /// `TokenStats`-shaped input. Numeric WETH-denominated fields can be
  /// expressed in float WETH for readability — the loader converts to wei.
  input: SerializedTokenStats;
  /// Expected normalized component score in [0, 1]. The runner asserts
  /// `Math.abs(actual - expected) <= tolerance`.
  expected: number;
  /// Acceptable absolute error. Default 1e-9 for byte-equivalent fixtures;
  /// looser for fixtures that involve floating-point chains.
  tolerance?: number;
}

/// Composite-fixture JSON shape — exercises the full `score()` path.
export interface CompositeFixture {
  name: string;
  description: string;
  weightsVersion: string;
  nowSec: number;
  /// Cohort of token inputs. Order matters for cohort-input order checks.
  cohort: ReadonlyArray<{token: string; input: SerializedTokenStats}>;
  /// Optional config override (e.g. flags to flip momentum on for a fixture
  /// that exercises the momentum path). Defaults to `DEFAULT_CONFIG`.
  config?: Partial<ScoringConfig>;
  /// Expected per-token HP + rank. Indexed by lower-cased token address.
  /// `hpTolerance` is per-row absolute error on the integer HP value
  /// (default 0 — exact match).
  expected: ReadonlyArray<{token: string; hp: number; rank: number; hpTolerance?: number}>;
}

/// JSON-friendly TokenStats. Maps + Sets become arrays + objects; bigints
/// become decimal-string fields (wei) or float fields (WETH) per convention.
export interface SerializedTokenStats {
  token: string;
  /// Map<wallet, walletVolumeWei> serialized as object.
  volumeByWallet?: Record<string, string>;
  buys?: ReadonlyArray<{wallet: string; tsSec: number; amountWeth: number}>;
  sells?: ReadonlyArray<{wallet: string; tsSec: number; amountWeth: number}>;
  liquidityDepthWeth?: number;
  avgLiquidityDepthWeth?: number;
  recentLiquidityRemovedWeth?: number;
  currentHolders?: ReadonlyArray<string>;
  holdersAtRetentionAnchor?: ReadonlyArray<string>;
  holdersAtRecentAnchor?: ReadonlyArray<string>;
  holderBalances?: ReadonlyArray<string>; // wei
  holderBalancesAtRetentionAnchor?: Record<string, string>; // wei
  holderFirstSeenAt?: Record<string, number>; // unix sec
  totalSupply?: string; // wei
  lpEvents?: ReadonlyArray<{tsSec: number; amountWethSigned: number}>;
  priorBaseComposite?: number;
  launchedAtSec?: number;
}

const WETH_PER_WEI = 1e18;

function wethToWei(weth: number): bigint {
  return BigInt(Math.round(weth * WETH_PER_WEI));
}

/// Materialize a `TokenStats` from the JSON shape. Wallet keys lower-cased;
/// timestamps converted from unix-seconds to bigint; WETH-floats to wei.
function materialize(s: SerializedTokenStats): TokenStats {
  const t: TokenStats = {
    token: s.token.toLowerCase() as Address,
    volumeByWallet: new Map(
      Object.entries(s.volumeByWallet ?? {}).map(([k, v]) => [
        k.toLowerCase() as Address,
        BigInt(v),
      ]),
    ),
    buys: (s.buys ?? []).map((b) => ({
      wallet: b.wallet.toLowerCase() as Address,
      ts: BigInt(b.tsSec),
      amountWeth: wethToWei(b.amountWeth),
    })),
    sells: (s.sells ?? []).map((b) => ({
      wallet: b.wallet.toLowerCase() as Address,
      ts: BigInt(b.tsSec),
      amountWeth: wethToWei(b.amountWeth),
    })),
    liquidityDepthWeth: wethToWei(s.liquidityDepthWeth ?? 0),
    currentHolders: new Set((s.currentHolders ?? []).map((a) => a.toLowerCase() as Address)),
    holdersAtRetentionAnchor: new Set(
      (s.holdersAtRetentionAnchor ?? []).map((a) => a.toLowerCase() as Address),
    ),
  };
  if (s.avgLiquidityDepthWeth !== undefined) t.avgLiquidityDepthWeth = wethToWei(s.avgLiquidityDepthWeth);
  if (s.recentLiquidityRemovedWeth !== undefined) {
    t.recentLiquidityRemovedWeth = wethToWei(s.recentLiquidityRemovedWeth);
  }
  if (s.holdersAtRecentAnchor) {
    t.holdersAtRecentAnchor = new Set(
      s.holdersAtRecentAnchor.map((a) => a.toLowerCase() as Address),
    );
  }
  if (s.holderBalances) t.holderBalances = s.holderBalances.map((b) => BigInt(b));
  if (s.holderBalancesAtRetentionAnchor) {
    t.holderBalancesAtRetentionAnchor = new Map(
      Object.entries(s.holderBalancesAtRetentionAnchor).map(([k, v]) => [
        k.toLowerCase() as Address,
        BigInt(v),
      ]),
    );
  }
  if (s.holderFirstSeenAt) {
    t.holderFirstSeenAt = new Map(
      Object.entries(s.holderFirstSeenAt).map(([k, v]) => [
        k.toLowerCase() as Address,
        BigInt(v),
      ]),
    );
  }
  if (s.totalSupply !== undefined) t.totalSupply = BigInt(s.totalSupply);
  if (s.lpEvents) {
    t.lpEvents = s.lpEvents.map((e) => ({
      ts: BigInt(e.tsSec),
      amountWethSigned:
        e.amountWethSigned >= 0
          ? wethToWei(e.amountWethSigned)
          : -wethToWei(-e.amountWethSigned),
    }));
  }
  if (s.priorBaseComposite !== undefined) t.priorBaseComposite = s.priorBaseComposite;
  if (s.launchedAtSec !== undefined) t.launchedAt = BigInt(s.launchedAtSec);
  return t;
}

/// Walk a fixtures subtree returning every `.json` file path (relative to
/// the fixtures root for stable test names).
export function findFixtureFiles(subdir: string): string[] {
  const root = join(FIXTURES_DIR, subdir);
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith(".json")) out.push(full);
    }
  }
  if (readdirSyncSafe(root)) walk(root);
  return out.sort();
}

function readdirSyncSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function loadComponentFixture(file: string): ComponentFixture {
  const raw = JSON.parse(readFileSync(file, "utf8")) as ComponentFixture;
  return raw;
}

export function loadCompositeFixture(file: string): CompositeFixture {
  const raw = JSON.parse(readFileSync(file, "utf8")) as CompositeFixture;
  return raw;
}

export function fixtureRelativeName(file: string): string {
  return relative(FIXTURES_DIR, file);
}

/// Run a single component fixture. Returns the (actual, expected, tolerance)
/// triple so the caller can assert with vitest's `expect`.
///
/// Note: velocity / effectiveBuyers / stickyLiquidity raw values are
/// internal — fixtures evaluate the *normalized* score that flows through
/// `score()`. We invoke `score()` with a single-token cohort and read the
/// component's `.score` field, which matches what production writes to
/// `hpSnapshot`.
export function runComponentFixture(fix: ComponentFixture): {actual: number; expected: number; tolerance: number} {
  const t = materialize(fix.input);
  const tolerance = fix.tolerance ?? 1e-9;

  let actual: number;
  if (fix.component === "holderConcentration") {
    // HHI computed directly — no cohort interaction needed.
    actual = computeHolderConcentration(t);
  } else {
    const ranked = score([t], BigInt(fix.nowSec), DEFAULT_CONFIG);
    const r = ranked[0];
    if (!r) throw new Error(`fixture ${fix.name}: scoring returned empty`);
    const c = r.components;
    switch (fix.component) {
      case "velocity":
        actual = c.velocity.score;
        break;
      case "effectiveBuyers":
        actual = c.effectiveBuyers.score;
        break;
      case "stickyLiquidity":
        actual = c.stickyLiquidity.score;
        break;
      case "retention":
        actual = c.retention.score;
        break;
      default:
        throw new Error(`fixture ${fix.name}: unknown component`);
    }
  }
  return {actual, expected: fix.expected, tolerance};
}

export interface CompositeFixtureRun {
  scored: ScoredToken[];
  expected: CompositeFixture["expected"];
}

export function runCompositeFixture(fix: CompositeFixture): CompositeFixtureRun {
  const cohort = fix.cohort.map((c) => ({
    ...materialize(c.input),
    token: c.token.toLowerCase() as Address,
  }));
  const config: ScoringConfig = {...DEFAULT_CONFIG, ...(fix.config ?? {})};
  const scored = score(cohort, BigInt(fix.nowSec), config);
  return {scored, expected: fix.expected};
}

export function activeWeightsVersion(): string {
  return HP_WEIGHTS_VERSION;
}
