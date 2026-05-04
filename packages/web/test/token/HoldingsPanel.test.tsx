/// HoldingsPanel — Epic 1.23 admin console v2 closeout.
///
/// Covers the four panel states (no-wallet / not-admin / no-holdings /
/// many-holdings) plus the error surface, and pins the per-row status copy
/// across the five flag combinations the indexer can produce.

import {render, waitFor} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("@/lib/arena/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/arena/api")>("@/lib/arena/api");
  return {
    ...actual,
    fetchHoldings: vi.fn(),
  };
});

import {fetchHoldings, type HoldingsResponse} from "@/lib/arena/api";

import {HoldingsPanel} from "@/components/admin/HoldingsPanel";

const fetchMock = vi.mocked(fetchHoldings);

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

beforeEach(() => {
  fetchMock.mockReset();
});

function holdingsFixture(overrides: Partial<HoldingsResponse> = {}): HoldingsResponse {
  return {
    wallet: WALLET,
    asOf: 1_730_000_000,
    tokens: [],
    totalProjectedWeth: "0",
    totalProjectedWethFormatted: "0",
    ...overrides,
  };
}

describe("HoldingsPanel", () => {
  it("not-admin: renders 'only visible to admin' hint without firing a request", () => {
    const {container} = render(<HoldingsPanel walletAddress={WALLET} isAdmin={false} />);
    expect(container.textContent).toContain("only visible to admin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-wallet (admin gate, but disconnected): does not fire a request", () => {
    render(<HoldingsPanel walletAddress={null} isAdmin={true} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-holdings: shows empty-state copy", async () => {
    fetchMock.mockResolvedValue(holdingsFixture({tokens: []}));
    const {container} = render(<HoldingsPanel walletAddress={WALLET} isAdmin={true} />);
    await waitFor(() => expect(container.textContent).toContain("don't hold any filter.fun tokens"));
  });

  it("many-holdings: renders one row per token + total when projection > 0", async () => {
    fetchMock.mockResolvedValue(
      holdingsFixture({
        tokens: [
          {
            address: "0x0000000000000000000000000000000000000001",
            ticker: "$ABC",
            season: 7,
            balance: "1230000000000000000",
            balanceFormatted: "1.23",
            isFiltered: true,
            isWinner: false,
            isFinalist: true,
            projectedRolloverWeth: "4600000000000000",
            projectedRolloverWethFormatted: "0.0046",
            postSettlement: false,
          },
          {
            address: "0x0000000000000000000000000000000000000002",
            ticker: "$XYZ",
            season: 7,
            balance: "5000000000000000000",
            balanceFormatted: "5",
            isFiltered: false,
            isWinner: true,
            isFinalist: true,
            projectedRolloverWeth: null,
            projectedRolloverWethFormatted: null,
            postSettlement: false,
          },
          {
            address: "0x0000000000000000000000000000000000000003",
            ticker: "$DEF",
            season: 7,
            balance: "50000000000000000",
            balanceFormatted: "0.05",
            isFiltered: false,
            isWinner: false,
            isFinalist: false,
            projectedRolloverWeth: null,
            projectedRolloverWethFormatted: null,
            postSettlement: false,
          },
        ],
        totalProjectedWeth: "4600000000000000",
        totalProjectedWethFormatted: "0.0046",
      }),
    );
    const {container} = render(<HoldingsPanel walletAddress={WALLET} isAdmin={true} />);
    await waitFor(() => expect(container.textContent).toContain("$ABC"));
    expect(container.textContent).toContain("$XYZ");
    expect(container.textContent).toContain("$DEF");
    expect(container.textContent).toContain("projected rollover: 0.0046 ETH (filtered)");
    expect(container.textContent).toContain("winner (no rollover)");
    expect(container.textContent).toContain("pre-cut · projection N/A");
    expect(container.textContent).toContain("Total projected rollover");
  });

  it("post-settlement filtered token: surfaces 'claim available' instead of projection", async () => {
    fetchMock.mockResolvedValue(
      holdingsFixture({
        tokens: [
          {
            address: "0x0000000000000000000000000000000000000004",
            ticker: "$OLD",
            season: 5,
            balance: "100000000000000000",
            balanceFormatted: "0.1",
            isFiltered: true,
            isWinner: false,
            isFinalist: false,
            projectedRolloverWeth: null,
            projectedRolloverWethFormatted: null,
            postSettlement: true,
          },
        ],
      }),
    );
    const {container} = render(<HoldingsPanel walletAddress={WALLET} isAdmin={true} />);
    await waitFor(() => expect(container.textContent).toContain("claim available"));
  });

  it("error: shows ▼ Read failed card", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    const {container} = render(<HoldingsPanel walletAddress={WALLET} isAdmin={true} />);
    await waitFor(() => expect(container.textContent).toContain("Read failed"));
  });
});
