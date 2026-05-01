/// Recap card structural tests — survivors render, pool delta animates,
/// rollover sub-card only appears when the wallet held filtered tokens.

import {render, screen, fireEvent} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";

import {RecapCard} from "@/components/arena/filterMoment/RecapCard";

import {makeFixtureCohort, makeFixtureSeason} from "../fixtures";

describe("RecapCard", () => {
  it("renders the FILTER COMPLETE header + survivor tickers", () => {
    const cohort = makeFixtureCohort();
    render(
      <RecapCard
        survivors={cohort.slice(0, 6)}
        walletFilteredTickers={[]}
        championPoolDelta="3.24"
        championPoolNow="14.82"
        walletEntitlementEth={null}
        season={makeFixtureSeason()}
        onDismiss={() => {}}
        skipAnimation
      />,
    );
    expect(screen.getByText(/FILTER COMPLETE/)).toBeTruthy();
    // First six tickers from the fixture cohort show up.
    for (const t of cohort.slice(0, 6)) {
      expect(screen.getAllByText(t.ticker).length).toBeGreaterThan(0);
    }
  });

  it("renders the +Ξ pool delta when greater than zero", () => {
    render(
      <RecapCard
        survivors={makeFixtureCohort().slice(0, 6)}
        walletFilteredTickers={[]}
        championPoolDelta="3.24"
        championPoolNow="14.82"
        walletEntitlementEth={null}
        season={makeFixtureSeason()}
        onDismiss={() => {}}
        skipAnimation
      />,
    );
    expect(screen.getByText("+Ξ3.24")).toBeTruthy();
  });

  it("renders the rollover sub-card only when the wallet held filtered tokens", () => {
    // No tickers — sub-card hidden.
    const {rerender} = render(
      <RecapCard
        survivors={makeFixtureCohort().slice(0, 6)}
        walletFilteredTickers={[]}
        championPoolDelta="3.24"
        championPoolNow="14.82"
        walletEntitlementEth={null}
        season={makeFixtureSeason()}
        onDismiss={() => {}}
        skipAnimation
      />,
    );
    expect(screen.queryByText(/Your rollover/i)).toBeNull();

    rerender(
      <RecapCard
        survivors={makeFixtureCohort().slice(0, 6)}
        walletFilteredTickers={["$RUG", "$DUST"]}
        championPoolDelta="3.24"
        championPoolNow="14.82"
        walletEntitlementEth="0.42"
        season={makeFixtureSeason()}
        onDismiss={() => {}}
        skipAnimation
      />,
    );
    expect(screen.getByText(/Your rollover/i)).toBeTruthy();
    expect(screen.getByText(/\$RUG, \$DUST/)).toBeTruthy();
    expect(screen.getByText("Ξ0.42")).toBeTruthy();
  });

  it("renders a placeholder entitlement when the indexer hasn't shipped per-wallet projection", () => {
    render(
      <RecapCard
        survivors={makeFixtureCohort().slice(0, 6)}
        walletFilteredTickers={["$RUG"]}
        championPoolDelta="3.24"
        championPoolNow="14.82"
        walletEntitlementEth={null}
        season={makeFixtureSeason()}
        onDismiss={() => {}}
        skipAnimation
      />,
    );
    expect(screen.getByText("~Ξ ?")).toBeTruthy();
  });

  it("calls onDismiss when the View arena button is clicked", () => {
    const onDismiss = vi.fn();
    render(
      <RecapCard
        survivors={makeFixtureCohort().slice(0, 6)}
        walletFilteredTickers={[]}
        championPoolDelta="3.24"
        championPoolNow="14.82"
        walletEntitlementEth={null}
        season={makeFixtureSeason()}
        onDismiss={onDismiss}
        skipAnimation
      />,
    );
    fireEvent.click(screen.getByRole("button", {name: /view arena/i}));
    expect(onDismiss).toHaveBeenCalled();
  });
});
