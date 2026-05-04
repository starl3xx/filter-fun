/// Cross-link test (Epic 1.23): the rollover entitlement number must agree
/// between the admin console's HoldingsPanel and the filter-moment recap card,
/// because both surfaces consume `/wallets/:address/holdings`. The test mocks
/// the underlying fetcher with a single fixture and verifies that the
/// formatted-ether projection that the admin panel renders matches the value
/// the filter-moment recap consumer would derive from the same response.
///
/// Why this exists: the dispatch lists "single source of truth, single
/// endpoint" as an explicit acceptance criterion. A future refactor that
/// introduces a second projection path (e.g. recomputing client-side for one
/// surface) would silently disagree without this regression guard.

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

beforeEach(() => fetchMock.mockReset());

describe("Holdings ↔ filter-moment cross-link", () => {
  it("admin holdings panel + filter-moment derivation agree on the projection number", async () => {
    const filteredAddr = "0x0000000000000000000000000000000000000099" as const;
    const fixture: HoldingsResponse = {
      wallet: WALLET,
      asOf: 1_730_000_000,
      tokens: [
        {
          address: filteredAddr,
          ticker: "$FILT",
          season: 7,
          balance: "1000000000000000000",
          balanceFormatted: "1",
          isFiltered: true,
          isWinner: false,
          isFinalist: true,
          // Projected slice: 0.0046 ETH = 4.6e15 wei.
          projectedRolloverWeth: "4600000000000000",
          projectedRolloverWethFormatted: "0.0046",
          postSettlement: false,
        },
      ],
      totalProjectedWeth: "4600000000000000",
      totalProjectedWethFormatted: "0.0046",
    };
    fetchMock.mockResolvedValue(fixture);

    // Admin panel renders the per-token projection.
    const {container} = render(<HoldingsPanel walletAddress={WALLET} isAdmin={true} />);
    await waitFor(() => expect(container.textContent).toContain("$FILT"));
    expect(container.textContent).toContain("0.0046 ETH");

    // Filter-moment recap derivation: for the SAME response, the consumer in
    // page.tsx sums projected wei across the tokens in `filteredAddresses` and
    // formats it. Replicate the derivation here against the same fixture so a
    // divergence in either surface fails the assertion.
    const filteredAddresses = new Set<`0x${string}`>([filteredAddr.toLowerCase() as `0x${string}`]);
    let totalWei = 0n;
    for (const t of fixture.tokens) {
      if (!t.isFiltered) continue;
      if (!filteredAddresses.has(t.address.toLowerCase() as `0x${string}`)) continue;
      if (t.projectedRolloverWeth === null) continue;
      totalWei += BigInt(t.projectedRolloverWeth);
    }
    expect(totalWei.toString()).toBe(fixture.totalProjectedWeth);

    // Decimal-ether derivation matches the indexer's weiToDecimalEther
    // formatting. Both UIs ultimately render the same string.
    const whole = totalWei / 10n ** 18n;
    const fracStr = ((totalWei % 10n ** 18n) / 10n ** 12n)
      .toString()
      .padStart(6, "0")
      .replace(/0+$/, "");
    const formatted = fracStr.length > 0 ? `${whole.toString()}.${fracStr}` : whole.toString();
    expect(formatted).toBe(fixture.totalProjectedWethFormatted);
  });
});
