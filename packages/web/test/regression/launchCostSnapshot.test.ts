/// Audit H-Web-2 (Phase 1, 2026-05-01) regression — launch cost snapshot.
///
/// Pre-fix `/launch/page.tsx` kept a `costRef` that read the LATEST
/// `nextCostWei` at write-contract time. A slot tier rollover during the pin
/// step (which can take seconds against IPFS) would silently re-price the
/// user's launch. Post-fix the page snapshots `{slotIndex, nextCostWei,
/// stakeWei}` at submit click and passes `snap.nextCostWei + snap.stakeWei`
/// into the launch tx.
///
/// Component-testing the snapshot under wagmi mocks is heavyweight (the page
/// composes ~10 hooks), so this test pins the pattern at the source level —
/// the same approach jetbrainsMonoWeights / wagmiConnectors / arenaTopBarSpec
/// use. A regression that re-introduces the costRef pattern OR drops the
/// snapshot read at the launch() call surfaces here.
import * as fs from "node:fs";
import * as path from "node:path";

import {describe, expect, it} from "vitest";

const PAGE_PATH = path.resolve(__dirname, "../../src/app/launch/page.tsx");
const source = fs.readFileSync(PAGE_PATH, "utf8");

describe("launch cost snapshot pattern (Audit H-Web-2)", () => {
  it("does NOT keep a live `costRef` (the pre-fix anti-pattern)", () => {
    // The pre-fix code declared `const costRef = useRef({nextCostWei, ...})`
    // and read `costRef.current` inside onSubmit. Strip line comments before
    // grepping so the H-Web-2 NatSpec block (which names the dead pattern)
    // doesn't trigger the assertion. A regression to actual code use of
    // `costRef.current` or a ref declaration would still fail.
    const stripped = source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped).not.toMatch(/\bcostRef\b/);
  });

  it("captures a snapshot type with slotIndex + nextCostWei + stakeWei", () => {
    // Allow either inline `type LaunchSnapshot = {...}` or a shape literal —
    // the load-bearing thing is that all three fields are captured together.
    expect(source).toMatch(/LaunchSnapshot/);
    expect(source).toMatch(/slotIndex:\s*number/);
    expect(source).toMatch(/nextCostWei:\s*bigint/);
    expect(source).toMatch(/stakeWei:\s*bigint/);
  });

  it("calls launch() with valueWei sourced from the snapshot, not live cost", () => {
    // Pin the literal `snap.nextCostWei + snap.stakeWei` expression — a
    // regression to `liveCost + liveStake` (the costRef destructuring) or
    // `nextCostWei + stakeWei` (raw closure capture) would fail.
    expect(source).toMatch(/valueWei:\s*snap\.nextCostWei\s*\+\s*snap\.stakeWei/);
  });

  it("renders a SnapshotBadge during the in-flight window", () => {
    // The badge surfaces the locked-in cost commitment to the user — without
    // it the snapshot is invisible and a tier-rollover post-snapshot looks
    // identical to a no-op to the user.
    expect(source).toContain("SnapshotBadge");
    expect(source).toMatch(/snapshotInFlight/);
  });

  it("setSnapshot called inside onSubmit before the pin fetch", () => {
    // Snapshot must be set BEFORE the fetch — otherwise a tier rollover during
    // the pin step would race the snapshot. Verify the call exists and lives
    // ahead of the metadata POST.
    const setIdx = source.indexOf("setSnapshot(snap)");
    const fetchIdx = source.indexOf('fetch("/api/metadata"');
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(fetchIdx).toBeGreaterThan(setIdx);
  });
});
