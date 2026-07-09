/// Page tests: /club mint surface (Epic 2.6 / spec §47.3.8).
///
/// Wagmi hooks are mocked directly (useEligibility.test.tsx pattern) and the
/// indexer's `GET /club` is stubbed at the global-fetch level. Covers the
/// states the spec calls out: indexer zero-state ("mint not live"), on-chain
/// sold-out (mint disabled), pass-not-deployed, and the happy mintable path.
/// Quantity-clamp MATH is pinned separately in clampMintQty.test.ts — these
/// tests only assert the page wires the clamp into the stepper.

import {render, screen, waitFor} from "@testing-library/react";
import {parseEther} from "viem";
import {beforeEach, describe, expect, it, vi} from "vitest";

const mockUseAccount = vi.fn();
const mockUseReadContracts = vi.fn();
const mockUseWriteContract = vi.fn();
const mockUsePublicClient = vi.fn();

vi.mock("wagmi", () => ({
  useAccount: () => mockUseAccount(),
  useReadContracts: (args: unknown) => mockUseReadContracts(args),
  useWriteContract: () => mockUseWriteContract(),
  usePublicClient: () => mockUsePublicClient(),
}));

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

import ClubPage from "@/app/club/page";
import type {ClubResponse} from "@/lib/arena/api";

/// On-chain read results in useClubSupply's batch order:
/// [totalMinted, maxSupply, mintPrice, walletMintCap, mintedBy, paused].
function supplyReads({
  totalMinted = 12n,
  maxSupply = 250n,
  mintPrice = parseEther("0.05"),
  walletMintCap = 2,
  mintedBy = 0,
  paused = false,
}: {
  totalMinted?: bigint;
  maxSupply?: bigint;
  mintPrice?: bigint;
  walletMintCap?: number;
  mintedBy?: number;
  paused?: boolean;
} = {}) {
  return {
    data: [
      {result: totalMinted},
      {result: maxSupply},
      {result: mintPrice},
      {result: walletMintCap},
      {result: mintedBy},
      {result: paused},
    ],
    isLoading: false,
    error: null,
  };
}

function clubResponse(overrides: Partial<ClubResponse> = {}): ClubResponse {
  return {
    minted: 12,
    maxSupply: 250,
    mintPriceWei: parseEther("0.05").toString(),
    proceedsWei: parseEther("0.6").toString(),
    credits: {issued: 24, consumed: 3, reclaimed: 1, outstanding: 22},
    holders: [
      {address: "0x00000000000000000000000000000000000000a1", tokenIds: [1, 2], creditsRemaining: 4},
    ],
    recentRedemptions: [
      {
        seasonId: 2,
        creator: "0x00000000000000000000000000000000000000a1",
        tokenId: 1,
        status: "CONSUMED",
        consumedAt: 1_700_000_000,
        reclaimedAt: null,
      },
    ],
    ...overrides,
  };
}

function stubClubFetch(body: ClubResponse) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => body,
    })),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  mockUseAccount.mockReset();
  mockUseReadContracts.mockReset();
  mockUseWriteContract.mockReset();
  mockUsePublicClient.mockReset();
  deployedFlag.value = true;
  mockUseAccount.mockReturnValue({address: "0x1", isConnected: true});
  mockUseWriteContract.mockReturnValue({writeContract: vi.fn(), data: undefined, reset: vi.fn()});
  mockUsePublicClient.mockReturnValue(undefined);
});

describe("/club — indexer zero-state", () => {
  it("renders the 'mint not live' skeleton when /club reports maxSupply 0", async () => {
    mockUseReadContracts.mockReturnValue({data: undefined, isLoading: true, error: null});
    stubClubFetch(
      clubResponse({
        minted: 0,
        maxSupply: 0,
        proceedsWei: "0",
        credits: {issued: 0, consumed: 0, reclaimed: 0, outstanding: 0},
        holders: [],
        recentRedemptions: [],
      }),
    );
    render(<ClubPage />);
    expect(await screen.findByTestId("club-mint-not-live")).toBeTruthy();
    // No roster / holder table renders off the zero-state.
    expect(screen.queryByTestId("club-roster")).toBeNull();
  });
});

describe("/club — sold-out state", () => {
  it("shows the SOLD OUT chip and disables the mint button", async () => {
    mockUseReadContracts.mockReturnValue(supplyReads({totalMinted: 250n, maxSupply: 250n}));
    stubClubFetch(clubResponse({minted: 250}));
    render(<ClubPage />);
    expect(screen.getByTestId("club-sold-out")).toBeTruthy();
    const button = screen.getByTestId("club-mint-submit") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toMatch(/sold out/i);
    await waitFor(() => expect(screen.getByTestId("club-roster")).toBeTruthy());
  });
});

describe("/club — pass not deployed", () => {
  it("renders the not-deployed card instead of the mint box", async () => {
    deployedFlag.value = false;
    mockUseReadContracts.mockReturnValue({data: undefined, isLoading: false, error: null});
    stubClubFetch(
      clubResponse({
        minted: 0,
        maxSupply: 0,
        proceedsWei: "0",
        credits: {issued: 0, consumed: 0, reclaimed: 0, outstanding: 0},
        holders: [],
        recentRedemptions: [],
      }),
    );
    render(<ClubPage />);
    expect(screen.getByTestId("club-not-deployed")).toBeTruthy();
    expect(screen.queryByTestId("club-mint-box")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("club-mint-not-live")).toBeTruthy());
  });
});

describe("/club — mintable state", () => {
  it("renders supply progress, clamps the stepper to the wallet cap, and arms the button", async () => {
    mockUseReadContracts.mockReturnValue(supplyReads());
    stubClubFetch(clubResponse());
    render(<ClubPage />);

    // Supply progress from the on-chain read.
    expect(screen.getByTestId("club-supply").textContent).toContain("12 / 250");

    // Stepper starts at 1, max = min(walletMintCap − mintedBy, remaining) = 2.
    expect(screen.getByTestId("club-qty").textContent).toBe("1");
    expect(screen.getByText(/max 2 for this wallet/i)).toBeTruthy();

    const button = screen.getByTestId("club-mint-submit") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toMatch(/mint pass/i);

    // Roster social proof lands from the /club fetch.
    await waitFor(() => expect(screen.getByTestId("club-roster")).toBeTruthy());
    expect(screen.getByText(/founding members \(1\)/i)).toBeTruthy();
  });

  it("shows the connect-wallet state when no wallet is connected", () => {
    mockUseAccount.mockReturnValue({address: undefined, isConnected: false});
    mockUseReadContracts.mockReturnValue(supplyReads());
    stubClubFetch(clubResponse());
    render(<ClubPage />);
    const button = screen.getByTestId("club-mint-submit") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toMatch(/connect wallet to mint/i);
  });
});
