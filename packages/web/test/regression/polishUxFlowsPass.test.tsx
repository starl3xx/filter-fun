/// PolishUxFlowsPass — Audit polish pass (Phase 1, 2026-05-03)
///
/// Bundled regressions for the code-touching items in the UX-flows polish PR.
/// Each test maps to one finding in `audit/2026-05-PHASE-1-AUDIT/ux-flows.md`
/// so a future revert that drops the change surfaces with the audit ID in
/// the failure label.
///
/// Findings covered (CODE rows only — DOC / DEFER / CLOSE-INCIDENTAL rows
/// are pinned by the status notes in ux-flows.md, not by this suite):
///   - M-Ux-1: ArenaTopBar hosts a wallet-connect CTA.
///   - M-Ux-3: Selecting a token writes the address to `?token=` via
///             `history.replaceState` (source-grep pin — the page is too
///             heavy to mount via vitest without mocking the entire wagmi
///             + indexer surface).
///   - M-Ux-4: CostPanel renders dashes when `costLoading` is true and
///             the launch page passes that flag while status is undefined.
///   - M-Ux-5: useEligibility — every non-eligible branch carries an
///             actionable message (>=80 chars; mentions a next step).
///   - M-Ux-7: admin page renders SkeletonStack while statsLoading.
///   - M-Ux-8: all four admin sub-forms use the same "Sign in wallet…"
///             / "Confirming…" 3-state pattern (source-grep pin).
///   - M-Ux-9: humanizeClaimError maps known revert selectors to friendly
///             copy (behavior tests against the helper directly).
///   - M-Ux-10: rollover claim page links to a recovery doc URL.
///   - L-Ux-1: bonus claim page surfaces the 14-day window.
///   - L-Ux-2: FilterMomentOverlay renders a slow-network fallback when
///             secondsUntilCut <= -10 and stage stuck in countdown.
///   - L-Ux-3: FilterEventReveal clamps survivors >= 1.

import {readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {render, screen} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";

// Mock the three wagmi hooks ArenaTopBar's ConnectWalletButton uses.
// Partial mock via importOriginal so the rest of wagmi (createConfig,
// other hooks pulled in by transitive imports — e.g. `lib/wagmi.ts`
// imports createConfig at module-load) keeps working. The tests that
// need a connected wallet swap the mock per-test via mockReturnValue.
// Loose return-type so per-test `mockReturnValue` calls can hand back a
// connected-state shape ({address: "0x…", isConnected: true}) without
// fighting the inferred `{address: undefined, isConnected: false}` type.
type MockAccount = {address: string | undefined; isConnected: boolean};
const mockUseAccount = vi.fn(
  (): MockAccount => ({address: undefined, isConnected: false}),
);
const mockUseConnect = vi.fn(() => ({connect: () => {}, connectors: [], status: "idle"}));
const mockUseDisconnect = vi.fn(() => ({disconnect: () => {}}));
vi.mock("wagmi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wagmi")>();
  return {
    ...actual,
    useAccount: () => mockUseAccount(),
    useConnect: () => mockUseConnect(),
    useDisconnect: () => mockUseDisconnect(),
  };
});

import {ArenaTopBar} from "../../src/app/../components/arena/ArenaTopBar.js";
import {CostPanel} from "../../src/components/launch/CostPanel.js";
import {FilterEventReveal} from "../../src/components/arena/filterMoment/FilterEventReveal.js";
import {humanizeClaimError} from "../../src/components/ClaimForm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
function readSource(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), "utf-8");
}

// M-Ux-1 ------------------------------------------------------------------
describe("M-Ux-1: ArenaTopBar hosts a wallet-connect CTA", () => {
  it("renders a Connect Wallet button when disconnected", () => {
    mockUseAccount.mockReturnValue({address: undefined, isConnected: false});
    render(<ArenaTopBar season={null} liveStatus="open" />);
    expect(screen.getByRole("button", {name: /connect wallet/i})).toBeTruthy();
  });

  it("renders the short wallet address (0x6…4) when connected", () => {
    mockUseAccount.mockReturnValue({
      address: "0xAbCdEf0123456789012345678901234567890123",
      isConnected: true,
    });
    const {container} = render(<ArenaTopBar season={null} liveStatus="open" />);
    // ConnectWalletButton formats as `${address.slice(0,6)}…${address.slice(-4)}`
    // → "0xAbCd…0123" (6 leading + ellipsis + 4 trailing). Search raw
    // textContent rather than testing-library's getByText because the
    // ellipsis character is split across the button's text node and
    // testing-library's text matcher collapses whitespace differently.
    expect(container.textContent ?? "").toMatch(/0xAbCd…0123/);
  });
});

// M-Ux-3 ------------------------------------------------------------------
describe("M-Ux-3: token selection syncs to ?token= URL param", () => {
  it("the home page calls window.history.replaceState with a token=… URL when selected changes", () => {
    // Source-grep pin — mounting `app/page.tsx` requires the full wagmi
    // + indexer + react-query stack, which is out of scope for a regression
    // test. Pin the wiring shape: an effect that uses replaceState and
    // builds a URL with searchParams.set('token', selected).
    const src = readSource("src/app/page.tsx");
    expect(src, "selected → URL effect missing").toMatch(/window\.history\.replaceState\s*\(/);
    expect(src, "URL effect must set the `token` searchParam").toMatch(/searchParams\.set\(\s*["']token["']/);
    // Anti-pin: ensure we use replaceState (not pushState) so the back
    // button doesn't replay every selection click.
    expect(src, "must NOT use pushState (would create back-button entries per click)").not.toMatch(/window\.history\.pushState\s*\(/);
  });
});

// M-Ux-4 ------------------------------------------------------------------
describe("M-Ux-4: CostPanel renders dashes when costLoading is true", () => {
  it("renders dashes (—) for cost values when costLoading is true", () => {
    render(
      <CostPanel
        slotIndex={0}
        launchCostWei={0n}
        stakeWei={0n}
        costLoading
      />,
    );
    // Dashes render in the value cells; check that "Ξ 0.0000" / "$0" are
    // NOT shown (false-precision the audit row called out).
    const text = document.body.textContent ?? "";
    expect(text, "must not render Ξ 0.0000 during load").not.toMatch(/Ξ\s*0\.000/);
    expect(text, "should show — placeholder").toMatch(/—/);
  });

  it("renders the real values when costLoading is false (or omitted)", () => {
    render(
      <CostPanel
        slotIndex={0}
        launchCostWei={1_000_000_000_000_000_000n}
        stakeWei={0n}
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text, "should render the real ETH value").toMatch(/Ξ\s*1\.0000/);
  });

  it("the launch page passes costLoading={status === undefined || !stakeReady} to LaunchForm", () => {
    const src = readSource("src/app/launch/page.tsx");
    expect(src, "launch page must pass costLoading flag").toMatch(/costLoading\s*=\s*\{.*status\s*===\s*undefined/);
  });
});

// M-Ux-5 ------------------------------------------------------------------
describe("M-Ux-5: useEligibility messages are actionable for every branch", () => {
  it("each non-eligible message is at least 60 chars and mentions a next step verb or a time reference", () => {
    const src = readSource("src/hooks/launch/useEligibility.ts");
    // Pull each message: string. The literal strings live inside the
    // useMemo result objects; grep each message and assert it's
    // non-trivial (> 60 chars) and contains an actionable cue.
    // Capture-group is `[^"]+` — NOT `[^"']+` — because the messages
    // contain apostrophes (e.g. "wallet's"). Using a class that excludes
    // single quotes would halt at the first apostrophe and capture only
    // "Reading your wallet" (19 chars), failing the >=60 assertion below
    // with the wrong reason. Same class of bug bugbot caught on PR #80
    // round-3 with the script-src regex; pinned here as a maintainer
    // reminder.
    const messages = [...src.matchAll(/message:\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(messages.length, "expected at least 5 message strings (5 branches)").toBeGreaterThanOrEqual(5);
    const actionableCues = /(connect|switch|reading|come back|head back|launch|reopen|window|monday)/i;
    for (const msg of messages) {
      expect(msg.length, `message too terse to be actionable: "${msg}"`).toBeGreaterThanOrEqual(60);
      expect(msg, `message must include an actionable cue: "${msg}"`).toMatch(actionableCues);
    }
  });
});

// M-Ux-7 ------------------------------------------------------------------
describe("M-Ux-7: admin page renders SkeletonStack while statsLoading", () => {
  it("admin page distinguishes statsLoading from not-in-cohort", () => {
    const src = readSource("src/app/token/[address]/admin/page.tsx");
    expect(src, "admin page must read statsLoading from useTokenStats").toMatch(/isLoading\s*:\s*statsLoading/);
    // The render branch is `statsLoading ? (\n  // comment\n  <SkeletonStack`
    // — match any whitespace + opening parens + comment block before
    // the SkeletonStack reference. The `[\s\S]*?` non-greedy class
    // crosses newlines (which `.` does not under default flags).
    expect(src, "admin page must render SkeletonStack while statsLoading").toMatch(/statsLoading\s*\?\s*\(?[\s\S]*?<SkeletonStack/);
    expect(src, "SkeletonStack helper must be defined in this file").toMatch(/function\s+SkeletonStack\s*\(/);
  });
});

// M-Ux-8 ------------------------------------------------------------------
describe("M-Ux-8: admin sub-forms share the 'Sign in wallet…' / 'Confirming…' pattern", () => {
  const subForms = [
    "src/components/admin/ClaimFeesPanel.tsx",
    "src/components/admin/MetadataForm.tsx",
    "src/components/admin/AdminTransferForms.tsx",
    "src/components/admin/BagLockCard.tsx",
  ];
  for (const file of subForms) {
    it(`${file} uses 'Sign in wallet…' for the submit-pending state`, () => {
      const src = readSource(file);
      expect(src, `${file} must use the canonical 'Sign in wallet…' copy`).toMatch(/Sign in wallet/);
      expect(src, `${file} must use 'Confirming…' for the mining state`).toMatch(/Confirming/);
      // Anti-pin: nobody should still be using the legacy "Submitting…"
      // copy after the M-Ux-8 normalization.
      expect(src, `${file} must not use the pre-normalization 'Submitting…' copy`).not.toMatch(/"Submitting…"/);
    });
  }
});

// M-Ux-9 ------------------------------------------------------------------
describe("M-Ux-9: humanizeClaimError maps known revert selectors", () => {
  it("InvalidProof() → mentions wallet binding", () => {
    expect(humanizeClaimError("InvalidProof()")).toMatch(/wallet/i);
    expect(humanizeClaimError("execution reverted: 0x09bde339")).toMatch(/wallet/i);
  });
  it("AlreadyClaimed() → mentions already redeemed", () => {
    expect(humanizeClaimError("AlreadyClaimed()")).toMatch(/already/i);
    expect(humanizeClaimError("0x646cf558")).toMatch(/already/i);
  });
  it("AlreadySettled() → mentions settlement timing", () => {
    expect(humanizeClaimError("AlreadySettled()")).toMatch(/settlement/i);
    expect(humanizeClaimError("0x560ff900")).toMatch(/settlement/i);
  });
  it("ClaimExceedsAllocation() → mentions exceeds allocated", () => {
    expect(humanizeClaimError("ClaimExceedsAllocation()")).toMatch(/exceeds/i);
    expect(humanizeClaimError("0x12f02dca")).toMatch(/exceeds/i);
  });
  it("user rejected → friendly retry message", () => {
    expect(humanizeClaimError("UserRejectedRequestError: User rejected the request")).toMatch(/rejected/i);
  });
  it("unknown reverts → 'Claim failed.' header + raw text", () => {
    const out = humanizeClaimError("execution reverted: 0xdeadbeef");
    expect(out).toMatch(/Claim failed/);
    expect(out).toMatch(/0xdeadbeef/);
  });
  it("null / undefined → safe default", () => {
    expect(humanizeClaimError(null)).toBe("Claim failed.");
    expect(humanizeClaimError(undefined)).toBe("Claim failed.");
  });
  it("very long viem stack traces are truncated to <=240 chars + ellipsis", () => {
    const long = "x".repeat(500);
    const out = humanizeClaimError(long);
    expect(out.length).toBeLessThan(280);
    expect(out).toMatch(/…$/);
  });
});

// M-Ux-10 -----------------------------------------------------------------
describe("M-Ux-10: rollover claim page links to claims directory", () => {
  it("includes a 'Need your claim JSON again?' link to the docs site", () => {
    const src = readSource("src/app/claim/rollover/page.tsx");
    expect(src).toMatch(/Need your claim JSON again/i);
    expect(src).toMatch(/docs\.filter\.fun\/claims\/recovery/);
    expect(src, "link should open in new tab").toMatch(/target="_blank"/);
    expect(src, "link should set rel for security").toMatch(/rel="noopener noreferrer"/);
  });
});

// L-Ux-1 ------------------------------------------------------------------
describe("L-Ux-1: bonus claim page surfaces the 14-day window", () => {
  it("renders a BonusWindowCard mentioning the 14-day window", () => {
    const src = readSource("src/app/claim/bonus/page.tsx");
    expect(src).toMatch(/BonusWindowCard/);
    expect(src).toMatch(/14 days/);
    expect(src).toMatch(/When does this open\?/);
  });
});

// L-Ux-2 ------------------------------------------------------------------
describe("L-Ux-2: FilterMomentOverlay shows slow-network fallback past the cut", () => {
  it("source defines FILTER_FIRED_GRACE_SEC and a SlowNetworkFallback component", () => {
    const src = readSource("src/components/arena/filterMoment/FilterMomentOverlay.tsx");
    expect(src).toMatch(/FILTER_FIRED_GRACE_SEC/);
    expect(src).toMatch(/function\s+SlowNetworkFallback\s*\(/);
    // Pin the trigger condition: secondsUntilCut <= -FILTER_FIRED_GRACE_SEC
    expect(src).toMatch(/secondsUntilCut\s*<=\s*-FILTER_FIRED_GRACE_SEC/);
    // Pin the user-facing copy.
    expect(src).toMatch(/refreshing the leaderboard/i);
  });
});

// L-Ux-3 ------------------------------------------------------------------
describe("L-Ux-3: FilterEventReveal clamps survivors to >= 1", () => {
  it("renders SURVIVE_COUNT (default 6) when survivors=0 is passed", () => {
    render(<FilterEventReveal survivors={0} filtered={6} />);
    // SURVIVE_COUNT is 6 protocol-wide; 0 → fall back to default.
    expect(screen.getByText(/6 SURVIVED/)).toBeTruthy();
  });
  it("renders SURVIVE_COUNT when survivors=NaN", () => {
    render(<FilterEventReveal survivors={NaN as never} filtered={6} />);
    expect(screen.getByText(/6 SURVIVED/)).toBeTruthy();
  });
  it("renders SURVIVE_COUNT when survivors=-1", () => {
    render(<FilterEventReveal survivors={-1} filtered={6} />);
    expect(screen.getByText(/6 SURVIVED/)).toBeTruthy();
  });
  it("renders the explicit value when survivors>=1", () => {
    render(<FilterEventReveal survivors={4} filtered={8} />);
    expect(screen.getByText(/4 SURVIVED/)).toBeTruthy();
    expect(screen.getByText(/8 FILTERED/)).toBeTruthy();
  });
  it("aria-label uses the clamped value, not the raw 0", () => {
    render(<FilterEventReveal survivors={0} filtered={6} />);
    expect(screen.getByRole("status").getAttribute("aria-label")).toMatch(/6 survived/i);
  });
});
