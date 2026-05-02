/// BagLockCard — covers the state branches the admin console actually paints:
///   - Unlocked + creator connected → form visible, presets enabled, audit
///     warning on Sepolia, "what doesn't do" expanded.
///   - Locked + creator connected → extend form, current unlock prominent,
///     date picker rejects values <= current unlock with a visible reason.
///   - Connected but not creator → button locked + "Creator only" copy.
///   - Tx lifecycle states (signing, mining, mined) all paint the right copy.
///   - Mainnet (`chain="base"`) hides the audit-gate warning; Sepolia shows it.
///
/// We mock wagmi's `useAccount` + `useWriteContract` + `useWaitForTransactionReceipt`
/// directly; the hook is a thin composition and the assertions exercise the
/// component logic, not the wagmi integration.

import {fireEvent, render, screen} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";

const mockUseAccount = vi.fn();
const mockWriteContract = vi.fn();
const mockReset = vi.fn();
const mockUseWriteContract = vi.fn();
const mockUseWaitForTransactionReceipt = vi.fn();

vi.mock("wagmi", () => ({
  useAccount: () => mockUseAccount(),
  useWriteContract: () => mockUseWriteContract(),
  useWaitForTransactionReceipt: (args: unknown) => mockUseWaitForTransactionReceipt(args),
}));

// Pretend the CreatorCommitments contract is deployed; the production address
// in the placeholder manifest is zero, which would otherwise short-circuit the
// form into a "not deployed" notice.
vi.mock("@/lib/addresses", async () => {
  const real = await vi.importActual<typeof import("@/lib/addresses")>("@/lib/addresses");
  return {
    ...real,
    isDeployed: (name: string) => name === "creatorCommitments",
    contractAddresses: {
      ...real.contractAddresses,
      creatorCommitments: "0x000000000000000000000000000000000000c01d",
    },
  };
});

import {BagLockCard} from "@/components/admin/BagLockCard";
import {makeFixtureBagLock} from "../arena/fixtures";

const TOKEN = "0x0000000000000000000000000000000000000111" as const;
const CREATOR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const STRANGER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

beforeEach(() => {
  mockUseAccount.mockReset();
  mockWriteContract.mockReset();
  mockReset.mockReset();
  mockUseWriteContract.mockReset();
  mockUseWaitForTransactionReceipt.mockReset();
  // Defaults — overridden per test.
  mockUseWriteContract.mockReturnValue({
    writeContract: mockWriteContract,
    data: undefined,
    isPending: false,
    error: null,
    reset: mockReset,
  });
  mockUseWaitForTransactionReceipt.mockReturnValue({isLoading: false, isSuccess: false});
});

describe("BagLockCard — unlocked state", () => {
  beforeEach(() => {
    mockUseAccount.mockReturnValue({address: CREATOR, isConnected: true});
  });

  it("renders the not-locked summary and the lock form", () => {
    render(
      <BagLockCard
        token={TOKEN}
        creator={CREATOR}
        bagLock={makeFixtureBagLock()}
        chain="base-sepolia"
      />,
    );
    const state = screen.getByTestId("baglock-state");
    expect(state.getAttribute("data-locked")).toBe("false");
    expect(state.textContent).toContain("Not locked");
    // Form / picker visible.
    expect(screen.getByTestId("baglock-datepicker")).toBeTruthy();
    // Submit button defaults to "Pick a date to lock" until the user picks.
    expect(screen.getByTestId("baglock-submit").textContent).toContain("Pick a date");
  });

  it("renders all preset duration buttons", () => {
    render(
      <BagLockCard
        token={TOKEN}
        creator={CREATOR}
        bagLock={makeFixtureBagLock()}
        chain="base-sepolia"
      />,
    );
    for (const days of [30, 60, 90, 182, 365]) {
      expect(screen.getByTestId(`baglock-preset-${days}`)).toBeTruthy();
    }
  });

  it("clicking a preset enables the submit button with the formatted date", () => {
    render(
      <BagLockCard
        token={TOKEN}
        creator={CREATOR}
        bagLock={makeFixtureBagLock()}
        chain="base-sepolia"
      />,
    );
    fireEvent.click(screen.getByTestId("baglock-preset-30"));
    const btn = screen.getByTestId("baglock-submit") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent?.toLowerCase()).toMatch(/lock until/);
  });

  it("submit calls writeContract with token + lockUntil", () => {
    render(
      <BagLockCard
        token={TOKEN}
        creator={CREATOR}
        bagLock={makeFixtureBagLock()}
        chain="base-sepolia"
      />,
    );
    fireEvent.click(screen.getByTestId("baglock-preset-30"));
    fireEvent.click(screen.getByTestId("baglock-submit"));
    expect(mockWriteContract).toHaveBeenCalledTimes(1);
    const call = mockWriteContract.mock.calls[0]![0]!;
    expect(call.functionName).toBe("commit");
    expect(call.args[0]).toBe(TOKEN);
    expect(typeof call.args[1]).toBe("bigint");
    // 30 days from now ± a small tolerance for test runtime.
    const target = call.args[1] as bigint;
    const expected = BigInt(Math.floor((Date.now() + 30 * 86400_000) / 1000));
    expect(Math.abs(Number(target - expected))).toBeLessThan(120);
  });
});

describe("BagLockCard — locked state", () => {
  const TWO_WEEKS_OUT = Math.floor((Date.now() + 14 * 86400_000) / 1000);

  beforeEach(() => {
    mockUseAccount.mockReturnValue({address: CREATOR, isConnected: true});
  });

  it("renders the locked summary, countdown, and Extend form", () => {
    render(
      <BagLockCard
        token={TOKEN}
        creator={CREATOR}
        bagLock={makeFixtureBagLock({isLocked: true, unlockTimestamp: TWO_WEEKS_OUT, creator: CREATOR})}
        chain="base-sepolia"
      />,
    );
    const state = screen.getByTestId("baglock-state");
    expect(state.getAttribute("data-locked")).toBe("true");
    expect(state.textContent).toContain("Locked");
    expect(screen.getByTestId("baglock-countdown").textContent).toMatch(/\d+d/);
    // Submit button label flips to "Extend".
    expect(screen.getByTestId("baglock-submit").textContent?.toLowerCase()).toContain("later date");
  });

  it("rejects a date <= current unlock with the verbatim 'extend forward' copy", () => {
    render(
      <BagLockCard
        token={TOKEN}
        creator={CREATOR}
        bagLock={makeFixtureBagLock({isLocked: true, unlockTimestamp: TWO_WEEKS_OUT, creator: CREATOR})}
        chain="base-sepolia"
      />,
    );
    // Type a value 1 day before the current unlock — that's the dangerous case.
    const tooSoon = new Date((TWO_WEEKS_OUT - 86400) * 1000);
    const localValue =
      `${tooSoon.getFullYear()}-${String(tooSoon.getMonth() + 1).padStart(2, "0")}-${String(tooSoon.getDate()).padStart(2, "0")}` +
      `T${String(tooSoon.getHours()).padStart(2, "0")}:${String(tooSoon.getMinutes()).padStart(2, "0")}`;
    fireEvent.change(screen.getByTestId("baglock-datepicker"), {target: {value: localValue}});
    expect(screen.getByTestId("baglock-too-soon").textContent).toContain("can only extend forward");
    const btn = screen.getByTestId("baglock-submit") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(mockWriteContract).not.toHaveBeenCalled();
  });

  it("preset clicks anchor to current unlock, not now (always strictly extends)", () => {
    render(
      <BagLockCard
        token={TOKEN}
        creator={CREATOR}
        bagLock={makeFixtureBagLock({isLocked: true, unlockTimestamp: TWO_WEEKS_OUT, creator: CREATOR})}
        chain="base-sepolia"
      />,
    );
    fireEvent.click(screen.getByTestId("baglock-preset-30"));
    fireEvent.click(screen.getByTestId("baglock-submit"));
    const target = mockWriteContract.mock.calls[0]![0]!.args[1] as bigint;
    // 14 days (current unlock) + 30 days (preset) = ~44 days from now.
    const expected = BigInt(Math.floor((Date.now() + 44 * 86400_000) / 1000));
    expect(Math.abs(Number(target - expected))).toBeLessThan(120);
  });
});

describe("BagLockCard — auth + lifecycle states", () => {
  it("connected non-creator → 'Creator only' button + explainer", () => {
    mockUseAccount.mockReturnValue({address: STRANGER, isConnected: true});
    render(
      <BagLockCard
        token={TOKEN}
        creator={CREATOR}
        bagLock={makeFixtureBagLock()}
        chain="base-sepolia"
      />,
    );
    expect(screen.getByTestId("baglock-submit").textContent).toContain("Creator only");
    expect(screen.getByTestId("baglock-not-creator").textContent?.toLowerCase()).toContain("launcher's identity");
  });

  it("disconnected → 'Connect wallet to lock' button", () => {
    mockUseAccount.mockReturnValue({address: undefined, isConnected: false});
    render(
      <BagLockCard
        token={TOKEN}
        creator={CREATOR}
        bagLock={makeFixtureBagLock()}
        chain="base-sepolia"
      />,
    );
    expect(screen.getByTestId("baglock-submit").textContent?.toLowerCase()).toContain("connect wallet");
  });

  it("submitting (isPending) → 'Sign in wallet…'", () => {
    mockUseAccount.mockReturnValue({address: CREATOR, isConnected: true});
    mockUseWriteContract.mockReturnValue({
      writeContract: mockWriteContract,
      data: undefined,
      isPending: true,
      error: null,
      reset: mockReset,
    });
    render(
      <BagLockCard
        token={TOKEN}
        creator={CREATOR}
        bagLock={makeFixtureBagLock()}
        chain="base-sepolia"
      />,
    );
    expect(screen.getByTestId("baglock-submit").textContent).toContain("Sign in wallet");
  });

  it("mining → 'Confirming on-chain…'", () => {
    mockUseAccount.mockReturnValue({address: CREATOR, isConnected: true});
    mockUseWriteContract.mockReturnValue({
      writeContract: mockWriteContract,
      data: "0xtxhash",
      isPending: false,
      error: null,
      reset: mockReset,
    });
    mockUseWaitForTransactionReceipt.mockReturnValue({isLoading: true, isSuccess: false});
    render(
      <BagLockCard
        token={TOKEN}
        creator={CREATOR}
        bagLock={makeFixtureBagLock()}
        chain="base-sepolia"
      />,
    );
    expect(screen.getByTestId("baglock-submit").textContent).toContain("Confirming on-chain");
  });

  it("mined → '▼ Locked ✓' success line", () => {
    mockUseAccount.mockReturnValue({address: CREATOR, isConnected: true});
    mockUseWriteContract.mockReturnValue({
      writeContract: mockWriteContract,
      data: "0xtxhash",
      isPending: false,
      error: null,
      reset: mockReset,
    });
    mockUseWaitForTransactionReceipt.mockReturnValue({isLoading: false, isSuccess: true});
    const {container} = render(
      <BagLockCard
        token={TOKEN}
        creator={CREATOR}
        bagLock={makeFixtureBagLock()}
        chain="base-sepolia"
      />,
    );
    expect(container.textContent).toContain("Locked ✓");
  });
});

describe("BagLockCard — chain-gated audit warning", () => {
  it("renders the audit-gate warning on Sepolia", () => {
    mockUseAccount.mockReturnValue({address: CREATOR, isConnected: true});
    render(
      <BagLockCard
        token={TOKEN}
        creator={CREATOR}
        bagLock={makeFixtureBagLock()}
        chain="base-sepolia"
      />,
    );
    const warn = screen.getByTestId("baglock-audit-warning");
    expect(warn.textContent).toContain("Sepolia testnet only");
    expect(warn.textContent).toContain("Epic 2.3");
  });

  it("warning is visible alongside the locked extend form too", () => {
    mockUseAccount.mockReturnValue({address: CREATOR, isConnected: true});
    render(
      <BagLockCard
        token={TOKEN}
        creator={CREATOR}
        bagLock={makeFixtureBagLock({isLocked: true, unlockTimestamp: Math.floor((Date.now() + 30 * 86400_000) / 1000), creator: CREATOR})}
        chain="base-sepolia"
      />,
    );
    expect(screen.getByTestId("baglock-audit-warning")).toBeTruthy();
  });

  it("hides the warning on mainnet", () => {
    mockUseAccount.mockReturnValue({address: CREATOR, isConnected: true});
    render(
      <BagLockCard
        token={TOKEN}
        creator={CREATOR}
        bagLock={makeFixtureBagLock()}
        chain="base"
      />,
    );
    expect(screen.queryByTestId("baglock-audit-warning")).toBeNull();
  });
});

describe("BagLockCard — limitations disclosure", () => {
  it("renders the 5 'doesn't do' items expanded by default", () => {
    mockUseAccount.mockReturnValue({address: CREATOR, isConnected: true});
    render(
      <BagLockCard
        token={TOKEN}
        creator={CREATOR}
        bagLock={makeFixtureBagLock()}
        chain="base-sepolia"
      />,
    );
    const disclosure = screen.getByTestId("baglock-does-not-do") as HTMLDetailsElement;
    expect(disclosure.open).toBe(true);
    expect(disclosure.textContent).toContain("Pre-commit transfers escape");
    expect(disclosure.textContent).toContain("Doesn't cover sibling wallets");
    expect(disclosure.textContent).toContain("Lost keys = permanent lock");
    expect(disclosure.textContent).toContain("Pre-1.13 tokens not gated");
    expect(disclosure.textContent).toContain("Inbound transfers still allowed");
  });
});
