/// Hook test: useClubCredits (Epic 2.6 / spec §47.3.8) — the launch page's
/// Filter Club credit surface.
///
/// We mock wagmi's `useAccount` and `useReadContracts` directly (same
/// pattern as useEligibility.test.tsx). The hook is a thin composition of
/// one batched read pair — the tests pin the derivation (`hasCredit`,
/// loading discipline, disconnected/undeployed fallbacks), not wagmi
/// internals.

import {render} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";

const mockUseAccount = vi.fn();
const mockUseReadContracts = vi.fn();

vi.mock("wagmi", () => ({
  useAccount: () => mockUseAccount(),
  useReadContracts: (args: unknown) => mockUseReadContracts(args),
}));

// Pretend the pass is deployed for these tests; the hook guards on
// `isDeployed("filterClubPass")` and otherwise reports zero credits. The
// undeployed branch is exercised via `deployedFlag` below.
const {deployedFlag} = vi.hoisted(() => ({deployedFlag: {value: true}}));

vi.mock("@/lib/addresses", async () => {
  const real = await vi.importActual<typeof import("@/lib/addresses")>("@/lib/addresses");
  return {
    ...real,
    isDeployed: () => deployedFlag.value,
    contractAddresses: {
      ...real.contractAddresses,
      filterClubPass: "0x0000000000000000000000000000000000000c1b",
    },
  };
});

import {useClubCredits} from "@/hooks/launch/useClubCredits";

function Probe() {
  const r = useClubCredits();
  return (
    <div
      data-credits={r.totalCredits.toString()}
      data-passes={r.passCount.toString()}
      data-has={r.hasCredit ? "1" : "0"}
      data-loading={r.isLoading ? "1" : "0"}
    />
  );
}

beforeEach(() => {
  mockUseAccount.mockReset();
  mockUseReadContracts.mockReset();
  deployedFlag.value = true;
});

describe("useClubCredits", () => {
  it("exposes the summed credits + pass count for a holder", () => {
    mockUseAccount.mockReturnValue({address: "0x1", isConnected: true});
    mockUseReadContracts.mockReturnValue({
      data: [
        {result: 3n}, // creditsRemaining
        {result: 2n}, // balanceOf
      ],
      isLoading: false,
    });
    const {container} = render(<Probe />);
    const probe = container.firstElementChild!;
    expect(probe.getAttribute("data-credits")).toBe("3");
    expect(probe.getAttribute("data-passes")).toBe("2");
    expect(probe.getAttribute("data-has")).toBe("1");
    expect(probe.getAttribute("data-loading")).toBe("0");
  });

  it("reports hasCredit=false for a holder whose passes are drained", () => {
    mockUseAccount.mockReturnValue({address: "0x1", isConnected: true});
    mockUseReadContracts.mockReturnValue({
      data: [{result: 0n}, {result: 2n}],
      isLoading: false,
    });
    const {container} = render(<Probe />);
    const probe = container.firstElementChild!;
    expect(probe.getAttribute("data-has")).toBe("0");
    // Pass count survives — the UI can still say "0 credits left" rather
    // than pretending the wallet holds nothing.
    expect(probe.getAttribute("data-passes")).toBe("2");
  });

  it("reports loading while the batch read is in flight", () => {
    mockUseAccount.mockReturnValue({address: "0x1", isConnected: true});
    mockUseReadContracts.mockReturnValue({data: undefined, isLoading: true});
    const {container} = render(<Probe />);
    const probe = container.firstElementChild!;
    expect(probe.getAttribute("data-loading")).toBe("1");
    expect(probe.getAttribute("data-has")).toBe("0");
  });

  it("falls back to zero credits when disconnected", () => {
    mockUseAccount.mockReturnValue({address: undefined, isConnected: false});
    mockUseReadContracts.mockReturnValue({data: undefined, isLoading: false});
    const {container} = render(<Probe />);
    const probe = container.firstElementChild!;
    expect(probe.getAttribute("data-credits")).toBe("0");
    expect(probe.getAttribute("data-has")).toBe("0");
    expect(probe.getAttribute("data-loading")).toBe("0");
  });

  it("stays quiet (no credits, not loading) when the pass isn't deployed", () => {
    deployedFlag.value = false;
    mockUseAccount.mockReturnValue({address: "0x1", isConnected: true});
    // wagmi still returns isLoading:true for a disabled query's first tick
    // in some versions — the hook must mask it behind the `enabled` gate.
    mockUseReadContracts.mockReturnValue({data: undefined, isLoading: true});
    const {container} = render(<Probe />);
    const probe = container.firstElementChild!;
    expect(probe.getAttribute("data-has")).toBe("0");
    expect(probe.getAttribute("data-loading")).toBe("0");
  });

  it("disables the wagmi query until the pass is deployed AND a wallet connects", () => {
    mockUseAccount.mockReturnValue({address: undefined, isConnected: false});
    mockUseReadContracts.mockReturnValue({data: undefined, isLoading: false});
    render(<Probe />);
    const args = mockUseReadContracts.mock.calls[0]![0] as {
      query: {enabled: boolean};
    };
    expect(args.query.enabled).toBe(false);
  });
});
