/// PastTokensPanel — Epic 1.23 admin console v2 closeout.
///
/// Covers self-link suppression, ordering (most-recent first), the empty
/// "first launch" state, status copy variants, and the not-admin gate.

import {render, waitFor} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("@/lib/arena/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/arena/api")>("@/lib/arena/api");
  return {
    ...actual,
    fetchProfile: vi.fn(),
  };
});

import {fetchProfile, type ProfileResponse} from "@/lib/arena/api";

import {PastTokensPanel} from "@/components/admin/PastTokensPanel";

const fetchMock = vi.mocked(fetchProfile);

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const TOK_A = "0x0000000000000000000000000000000000000001" as const;
const TOK_B = "0x0000000000000000000000000000000000000002" as const;
const TOK_C = "0x0000000000000000000000000000000000000003" as const;

beforeEach(() => {
  fetchMock.mockReset();
});

function profileFixture(overrides: Partial<ProfileResponse> = {}): ProfileResponse {
  return {
    address: WALLET,
    createdTokens: [],
    stats: {
      wins: 0,
      filtersSurvived: 0,
      rolloverEarnedWei: "0",
      bonusEarnedWei: "0",
      lifetimeTradeVolumeWei: "0",
      tokensTraded: 0,
    },
    badges: [],
    computedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("PastTokensPanel", () => {
  it("not-admin: renders 'only visible to admin' hint", () => {
    const {container} = render(
      <PastTokensPanel walletAddress={WALLET} isAdmin={false} currentToken={TOK_A} />,
    );
    expect(container.textContent).toContain("only visible to admin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("first-launch / only token is the current one: shows empty state", async () => {
    fetchMock.mockResolvedValue(
      profileFixture({
        createdTokens: [
          {
            token: TOK_A,
            ticker: "$ABC",
            seasonId: 7,
            rank: 0,
            status: "ACTIVE",
            launchedAt: "2026-05-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const {container} = render(
      <PastTokensPanel walletAddress={WALLET} isAdmin={true} currentToken={TOK_A} />,
    );
    await waitFor(() => expect(container.textContent).toContain("first launch"));
  });

  it("self-link suppression + descending order by launchedAt", async () => {
    fetchMock.mockResolvedValue(
      profileFixture({
        createdTokens: [
          // The currently-viewed token MUST be filtered out, even though it's
          // the most recent.
          {
            token: TOK_A,
            ticker: "$ABC",
            seasonId: 7,
            rank: 1,
            status: "ACTIVE",
            launchedAt: "2026-05-04T00:00:00.000Z",
          },
          // Older tokens render newest-first.
          {
            token: TOK_B,
            ticker: "$XYZ",
            seasonId: 5,
            rank: 1,
            status: "WEEKLY_WINNER",
            launchedAt: "2026-04-20T00:00:00.000Z",
          },
          {
            token: TOK_C,
            ticker: "$DEF",
            seasonId: 4,
            rank: 9,
            status: "FILTERED",
            launchedAt: "2026-04-13T00:00:00.000Z",
          },
        ],
      }),
    );
    const {container} = render(
      <PastTokensPanel walletAddress={WALLET} isAdmin={true} currentToken={TOK_A} />,
    );
    await waitFor(() => expect(container.textContent).toContain("$XYZ"));
    expect(container.textContent).not.toContain("$ABC"); // self-link suppressed
    // Newest-first ordering: $XYZ should appear before $DEF in DOM order.
    const idxXyz = container.textContent!.indexOf("$XYZ");
    const idxDef = container.textContent!.indexOf("$DEF");
    expect(idxXyz).toBeGreaterThan(-1);
    expect(idxDef).toBeGreaterThan(-1);
    expect(idxXyz).toBeLessThan(idxDef);
    // Status copy variants.
    expect(container.textContent).toContain("WINNER · earning fees");
    expect(container.textContent).toContain("FILTERED · ranked #9");
  });

  it("each row links to /token/<address>/admin", async () => {
    fetchMock.mockResolvedValue(
      profileFixture({
        createdTokens: [
          {
            token: TOK_B,
            ticker: "$XYZ",
            seasonId: 5,
            rank: 1,
            status: "WEEKLY_WINNER",
            launchedAt: "2026-04-20T00:00:00.000Z",
          },
        ],
      }),
    );
    const {container} = render(
      <PastTokensPanel walletAddress={WALLET} isAdmin={true} currentToken={TOK_A} />,
    );
    await waitFor(() => expect(container.querySelector("a")).not.toBeNull());
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(`/token/${TOK_B}/admin`);
  });
});
