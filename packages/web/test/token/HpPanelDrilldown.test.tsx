/// HpPanel HP-component drilldown — Epic 1.23 admin console v2 closeout.
///
/// Covers:
///   - Toggle open/close per component.
///   - localStorage persistence (`adminConsoleDrilldownOpen`).
///   - Lazy fetch — closed drilldowns don't fire a request.
///   - Per-row rendering (delta, taker, side, age, tx link).

import {act, fireEvent, render, waitFor} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("@/lib/arena/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/arena/api")>("@/lib/arena/api");
  return {
    ...actual,
    fetchComponentDeltas: vi.fn(),
  };
});

import {fetchComponentDeltas, type ComponentDeltasResponse, type TokenResponse} from "@/lib/arena/api";

import {HpPanel} from "@/components/admin/HpPanel";

const fetchMock = vi.mocked(fetchComponentDeltas);

const TOKEN_ADDR = "0x1111111111111111111111111111111111111111" as const;

function tokenFixture(overrides: Partial<TokenResponse> = {}): TokenResponse {
  return {
    token: TOKEN_ADDR,
    ticker: "$ABC",
    rank: 1,
    hp: 8000,
    status: "FINALIST",
    price: "0",
    priceChange24h: 0,
    volume24h: "0",
    liquidity: "0",
    holders: 0,
    components: {
      velocity: 0.7,
      effectiveBuyers: 0.6,
      stickyLiquidity: 0.5,
      retention: 0.4,
      momentum: 0.3,
    },
    bagLock: {isLocked: false, unlockTimestamp: null, creator: TOKEN_ADDR},
    ...overrides,
  };
}

function deltasFixture(overrides: Partial<ComponentDeltasResponse> = {}): ComponentDeltasResponse {
  return {
    token: TOKEN_ADDR,
    computedAt: 1_730_000_000,
    threshold: 0.05,
    components: {
      velocity: [],
      effectiveBuyers: [],
      stickyLiquidity: [],
      retention: [],
      momentum: [],
    },
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  if (typeof window !== "undefined") {
    window.localStorage.removeItem("adminConsoleDrilldownOpen");
  }
});

describe("HpPanel — component drilldown (Epic 1.23)", () => {
  it("does NOT fire a fetch while every drilldown is closed", async () => {
    const {container} = render(<HpPanel token={tokenFixture()} />);
    // Initial render shows component bars but no drilldowns.
    expect(container.textContent).toContain("Buying activity");
    // Give React + the lazy hook a microtask to settle.
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opening a component fires the fetch + persists to localStorage", async () => {
    fetchMock.mockResolvedValue(deltasFixture());
    const {container} = render(<HpPanel token={tokenFixture()} />);
    const btn = container.querySelectorAll("button")[0]!;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const persisted = JSON.parse(window.localStorage.getItem("adminConsoleDrilldownOpen") ?? "{}");
    expect(persisted).toHaveProperty("velocity", true);
  });

  it("hydrates open state from localStorage on mount", async () => {
    window.localStorage.setItem(
      "adminConsoleDrilldownOpen",
      JSON.stringify({retention: true}),
    );
    fetchMock.mockResolvedValue(deltasFixture());
    const {container} = render(<HpPanel token={tokenFixture()} />);
    // The retention component should have its drilldown region rendered after
    // hydration — wait for the next tick.
    await waitFor(() => {
      expect(container.querySelector("#hp-drilldown-retention")).not.toBeNull();
    });
  });

  it("renders a swap-impact row with delta + taker + tx link", async () => {
    fetchMock.mockResolvedValue(
      deltasFixture({
        components: {
          velocity: [
            {
              timestamp: Math.floor(Date.now() / 1000) - 60,
              delta: 0.42,
              swap: {
                side: "BUY",
                taker: "0xabc1230000000000000000000000000000000123" as `0x${string}`,
                wethValue: "500000000000000000",
                txHash: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`,
              },
            },
          ],
          effectiveBuyers: [],
          stickyLiquidity: [],
          retention: [],
          momentum: [],
        },
      }),
    );
    const {container} = render(<HpPanel token={tokenFixture()} />);
    const btn = container.querySelectorAll("button")[0]!;
    await act(async () => {
      fireEvent.click(btn);
    });
    // Bugbot PR #101 (Medium): drilldown MUST render the user-facing label
    // ("Buying activity") not the internal field name ("velocity").
    await waitFor(() => expect(container.textContent).toContain("+0.42 Buying activity"));
    expect(container.textContent).not.toContain("+0.42 velocity");
    expect(container.textContent).toContain("0.5 ETH buy");
    // Truncated address rendering — 6-char head + 4-char tail.
    expect(container.textContent).toContain("0xabc1");
    // Tx link points at Basescan (testnet default in tests since
    // NEXT_PUBLIC_CHAIN is unset → falls through to base-sepolia).
    const txLink = container.querySelector('a[href*="basescan.org/tx/"]');
    expect(txLink).not.toBeNull();
    expect(txLink!.getAttribute("href")).toContain("0xdeadbeef");
  });
});
