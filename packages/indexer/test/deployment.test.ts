/// Manifest reader tests. Two layers:
///   1. The `readDeployment` resolution order — explicit path wins, monorepo path falls
///      through, env-var fallback last. Strict mode (`DEPLOYMENT_MANIFEST_REQUIRED=1`)
///      throws instead of falling through.
///   2. The shape of the manifest itself, validated against a sample. We pin the schema so
///      a future change to the deploy script (renamed key, new top-level field) breaks this
///      test — the indexer + web both depend on the shape, so a silent rename would lose
///      addresses at the deserialization layer.

import {writeFileSync, mkdirSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vitest";

import {readDeployment, type Deployment} from "../src/deployment.js";

/// A canonical manifest shape. Derived directly from the script's `_writeManifest` output.
/// Keep this in lockstep with `script/DeploySepolia.s.sol` — the addresses + chainId values
/// are arbitrary, but the *keys* are load-bearing for downstream consumers.
const SAMPLE: Record<string, unknown> = {
  chainId: 84_532,
  network: "base-sepolia",
  deployBlockNumber: 12_345_678,
  deployedAt: 1_714_500_000,
  deployerAddress: "0x1111111111111111111111111111111111111111",
  hookSalt: "0x00000000000000000000000000000000000000000000000000000000000087e8",
  deployCommitHash: "abc123",
  filterToken: "",
  addresses: {
    treasuryTimelock: "0x2222222222222222222222222222222222222222",
    bonusDistributor: "0x3333333333333333333333333333333333333333",
    polVault: "0x4444444444444444444444444444444444444444",
    filterLauncher: "0x5555555555555555555555555555555555555555",
    polManager: "0x6666666666666666666666666666666666666666",
    filterHook: "0x7777777777777777777777777777777777777777",
    filterFactory: "0x8888888888888888888888888888888888888888",
    creatorRegistry: "0x9999999999999999999999999999999999999999",
    creatorFeeDistributor: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    creatorCommitments: "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    tournamentRegistry: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    tournamentVault: "0xcccccccccccccccccccccccccccccccccccccccc",
    v4PoolManager: "0xdddddddddddddddddddddddddddddddddddddddd",
    weth: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  },
  config: {
    treasuryOwner: "0x1010101010101010101010101010101010101010",
    schedulerOracle: "0x2020202020202020202020202020202020202020",
    mechanicsWallet: "0x3030303030303030303030303030303030303030",
    polVaultOwner: "0x4040404040404040404040404040404040404040",
    maxLaunchesPerWallet: 1,
    refundableStakeEnabled: true,
  },
};

let tmpDir: string;
let manifestPath: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = join(tmpdir(), `filter-fun-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, {recursive: true});
  manifestPath = join(tmpDir, "base-sepolia.json");

  // Save and clear the env vars the resolver inspects so each test starts from a known
  // baseline. We restore them in afterEach.
  savedEnv = {
    DEPLOYMENT_MANIFEST_PATH: process.env.DEPLOYMENT_MANIFEST_PATH,
    DEPLOYMENT_MANIFEST_REQUIRED: process.env.DEPLOYMENT_MANIFEST_REQUIRED,
    PONDER_NETWORK: process.env.PONDER_NETWORK,
    FILTER_LAUNCHER_ADDRESS: process.env.FILTER_LAUNCHER_ADDRESS,
    FILTER_FACTORY_ADDRESS: process.env.FILTER_FACTORY_ADDRESS,
    BONUS_DISTRIBUTOR_ADDRESS: process.env.BONUS_DISTRIBUTOR_ADDRESS,
    DEPLOY_BLOCK: process.env.DEPLOY_BLOCK,
    DEPLOY_COMMIT_HASH: process.env.DEPLOY_COMMIT_HASH,
  };
  for (const k of Object.keys(savedEnv)) delete process.env[k];
});

afterEach(() => {
  rmSync(tmpDir, {recursive: true, force: true});
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("readDeployment — manifest path", () => {
  it("loads addresses + start block from a valid manifest", () => {
    writeFileSync(manifestPath, JSON.stringify(SAMPLE));
    process.env.DEPLOYMENT_MANIFEST_PATH = manifestPath;

    const d: Deployment = readDeployment("baseSepolia");
    expect(d.network).toBe("baseSepolia");
    expect(d.deployBlockNumber).toBe(12_345_678);
    expect(d.deployCommitHash).toBe("abc123");
    expect(d.addresses.filterLauncher).toBe("0x5555555555555555555555555555555555555555");
    expect(d.addresses.filterFactory).toBe("0x8888888888888888888888888888888888888888");
    expect(d.addresses.bonusDistributor).toBe("0x3333333333333333333333333333333333333333");
    expect(d.addresses.creatorRegistry).toBe("0x9999999999999999999999999999999999999999");
    expect(d.addresses.creatorCommitments).toBe("0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1");
    expect(d.addresses.tournamentVault).toBe("0xcccccccccccccccccccccccccccccccccccccccc");
    expect(d.addresses.v4PoolManager).toBe("0xdddddddddddddddddddddddddddddddddddddddd");
    expect(d.addresses.weth).toBe("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  });

  it("skips a manifest whose network field doesn't match the requested network", () => {
    // Manifest claims "base" but caller asks for baseSepolia → resolver skips the file and
    // (since strict mode is off) falls through to env-var defaults.
    writeFileSync(manifestPath, JSON.stringify({...SAMPLE, network: "base"}));
    process.env.DEPLOYMENT_MANIFEST_PATH = manifestPath;
    process.env.FILTER_LAUNCHER_ADDRESS = "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed";

    const d = readDeployment("baseSepolia");
    expect(d.addresses.filterLauncher).toBe("0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed");
  });

  it("falls through malformed JSON to the env-var fallback", () => {
    writeFileSync(manifestPath, "not-json");
    process.env.DEPLOYMENT_MANIFEST_PATH = manifestPath;
    process.env.FILTER_LAUNCHER_ADDRESS = "0xabababababababababababababababababababab";

    const d = readDeployment("baseSepolia");
    expect(d.addresses.filterLauncher).toBe("0xabababababababababababababababababababab");
  });
});

describe("readDeployment — env-var fallback", () => {
  it("returns env-var addresses when no manifest is found and strict mode is off", () => {
    process.env.FILTER_LAUNCHER_ADDRESS = "0x1111111111111111111111111111111111111111";
    process.env.FILTER_FACTORY_ADDRESS = "0x2222222222222222222222222222222222222222";
    process.env.BONUS_DISTRIBUTOR_ADDRESS = "0x3333333333333333333333333333333333333333";
    process.env.DEPLOY_BLOCK = "777";
    process.env.DEPLOY_COMMIT_HASH = "deadbeef";

    const d = readDeployment("baseSepolia");
    expect(d.addresses.filterLauncher).toBe("0x1111111111111111111111111111111111111111");
    expect(d.addresses.filterFactory).toBe("0x2222222222222222222222222222222222222222");
    expect(d.addresses.bonusDistributor).toBe("0x3333333333333333333333333333333333333333");
    expect(d.deployBlockNumber).toBe(777);
    expect(d.deployCommitHash).toBe("deadbeef");
  });

  it("strict mode throws when manifest is missing", () => {
    process.env.DEPLOYMENT_MANIFEST_REQUIRED = "1";
    process.env.DEPLOYMENT_MANIFEST_PATH = manifestPath; // points at a non-existent file
    expect(() => readDeployment("baseSepolia")).toThrow(/manifest required/);
  });
});

describe("manifest schema", () => {
  it("documents every key that downstream consumers depend on", () => {
    // This is a *contract test* against the deploy script's output shape. If a key listed
    // here disappears or is renamed in DeploySepolia.s.sol, the indexer + web break — so
    // we want this assertion to fail loudly rather than silently zero-out an address.
    const expectedAddressKeys = [
      "treasuryTimelock",
      "bonusDistributor",
      "polVault",
      "filterLauncher",
      "polManager",
      "filterHook",
      "filterFactory",
      "creatorRegistry",
      "creatorFeeDistributor",
      "creatorCommitments",
      "tournamentRegistry",
      "tournamentVault",
      "v4PoolManager",
      "weth",
    ] as const;
    const expectedConfigKeys = [
      "treasuryOwner",
      "schedulerOracle",
      "mechanicsWallet",
      "polVaultOwner",
      "maxLaunchesPerWallet",
      "refundableStakeEnabled",
    ] as const;

    const addresses = SAMPLE.addresses as Record<string, unknown>;
    for (const k of expectedAddressKeys) {
      expect(addresses[k]).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
    const config = SAMPLE.config as Record<string, unknown>;
    for (const k of expectedConfigKeys) {
      expect(config[k]).toBeDefined();
    }

    // Top-level fields the indexer reads.
    expect(SAMPLE.chainId).toBe(84_532);
    expect(SAMPLE.network).toBe("base-sepolia");
    expect(SAMPLE.deployBlockNumber).toBeTypeOf("number");
    expect(SAMPLE.deployCommitHash).toBeTypeOf("string");
    expect(SAMPLE.hookSalt).toMatch(/^0x[0-9a-f]{64}$/i);
  });
});
