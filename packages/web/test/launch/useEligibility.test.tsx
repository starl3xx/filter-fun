/// Hook test: useEligibility — exercises every branch the page must render
/// (not-connected, already-launched, window-closed, eligible).
///
/// We mock wagmi's `useAccount` and `useReadContracts` directly. The hook
/// composes those two reads with a simple decision tree; mocking lets us
/// test the decision tree in isolation without a wagmi config / connector.

import {render} from "@testing-library/react";
import {describe, expect, it, vi, beforeEach} from "vitest";

const mockUseAccount = vi.fn();
const mockUseReadContracts = vi.fn();
const mockUseReadContract = vi.fn();

vi.mock("wagmi", () => ({
  useAccount: () => mockUseAccount(),
  useReadContracts: (args: unknown) => mockUseReadContracts(args),
  useReadContract: (args: unknown) => mockUseReadContract(args),
}));

// Pretend the launcher is deployed for these tests; the eligibility hook
// guards on `isDeployed("filterLauncher")` and otherwise returns "loading".
vi.mock("@/lib/addresses", async () => {
  const real = await vi.importActual<typeof import("@/lib/addresses")>("@/lib/addresses");
  return {
    ...real,
    isDeployed: () => true,
    contractAddresses: {
      filterLauncher: "0x0000000000000000000000000000000000000abc",
      filterFactory: "0x0000000000000000000000000000000000000def",
      filterToken: "0x0000000000000000000000000000000000000fff",
    },
  };
});

import {useEligibility} from "@/hooks/launch/useEligibility";

function Probe() {
  const r = useEligibility();
  return (
    <div data-state={r.state} data-form={r.formVisible ? "1" : "0"} data-msg={r.message} data-can={r.canSubmit ? "1" : "0"} />
  );
}

beforeEach(() => {
  mockUseReadContract.mockReset();
  mockUseReadContracts.mockReset();
  mockUseAccount.mockReset();
  // useLauncherSeason → useReadContract returns the seasonId
  mockUseReadContract.mockReturnValue({data: 2n, isLoading: false, error: null});
});

describe("useEligibility", () => {
  it("returns not-connected when no wallet", () => {
    mockUseAccount.mockReturnValue({address: undefined, isConnected: false});
    mockUseReadContracts.mockReturnValue({data: undefined, isLoading: false});
    const {container} = render(<Probe />);
    const probe = container.firstElementChild!;
    expect(probe.getAttribute("data-state")).toBe("not-connected");
    expect(probe.getAttribute("data-form")).toBe("0");
  });

  it("returns loading while contract reads pending", () => {
    mockUseAccount.mockReturnValue({address: "0x1", isConnected: true});
    mockUseReadContracts.mockReturnValue({data: undefined, isLoading: true});
    const {container} = render(<Probe />);
    expect(container.firstElementChild!.getAttribute("data-state")).toBe("loading");
  });

  it("returns already-launched when wallet has used its quota", () => {
    mockUseAccount.mockReturnValue({address: "0x1", isConnected: true});
    mockUseReadContracts.mockReturnValue({
      data: [
        {result: true},      // canLaunch
        {result: 1n},        // launchesByWallet
        {result: 1n},        // maxLaunchesPerWallet
      ],
      isLoading: false,
    });
    const {container} = render(<Probe />);
    expect(container.firstElementChild!.getAttribute("data-state")).toBe("already-launched");
  });

  it("returns window-closed when canLaunch=false", () => {
    mockUseAccount.mockReturnValue({address: "0x1", isConnected: true});
    mockUseReadContracts.mockReturnValue({
      data: [
        {result: false},
        {result: 0n},
        {result: 1n},
      ],
      isLoading: false,
    });
    const {container} = render(<Probe />);
    expect(container.firstElementChild!.getAttribute("data-state")).toBe("window-closed");
  });

  it("returns eligible when slot is open + wallet hasn't launched", () => {
    mockUseAccount.mockReturnValue({address: "0x1", isConnected: true});
    mockUseReadContracts.mockReturnValue({
      data: [
        {result: true},
        {result: 0n},
        {result: 1n},
      ],
      isLoading: false,
    });
    const {container} = render(<Probe />);
    const probe = container.firstElementChild!;
    expect(probe.getAttribute("data-state")).toBe("eligible");
    expect(probe.getAttribute("data-form")).toBe("1");
    expect(probe.getAttribute("data-can")).toBe("1");
  });
});
