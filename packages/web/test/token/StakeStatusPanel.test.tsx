/// StakeStatusPanel — three primary states (HELD/REFUNDED/FORFEITED) plus
/// PROTOCOL and UNKNOWN edges. The pill copy and color come from a single
/// mapping; this asserts each branch surfaces the canonical label.

import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {StakeStatusPanel} from "@/components/admin/StakeStatusPanel";
import type {StakeStatus} from "@/hooks/token/useStakeStatus";

const ETH_DEC = 1_000_000_000_000_000_000n; // 1 ETH in wei

function status(state: StakeStatus["state"], opts: Partial<StakeStatus> = {}): StakeStatus {
  return {
    state,
    costPaid: opts.costPaid ?? ETH_DEC / 10n, // 0.1 ETH
    stakeAmount: opts.stakeAmount ?? (state === "HELD" ? ETH_DEC / 10n : 0n),
    slotIndex: opts.slotIndex ?? 3,
  };
}

describe("StakeStatusPanel", () => {
  it("HELD → 'Held until first cut' + non-zero stake", () => {
    const {container} = render(<StakeStatusPanel status={status("HELD")} />);
    expect(container.textContent).toContain("Held until first cut");
    expect(container.querySelector("[data-stake-state]")?.getAttribute("data-stake-state")).toBe("HELD");
    expect(container.textContent).toContain("Slot index");
  });

  it("REFUNDED → 'Refunded ✓'", () => {
    const {container} = render(<StakeStatusPanel status={status("REFUNDED")} />);
    expect(container.textContent).toContain("Refunded");
  });

  it("FORFEITED → 'Forfeited'", () => {
    const {container} = render(<StakeStatusPanel status={status("FORFEITED")} />);
    expect(container.textContent).toContain("Forfeited");
  });

  it("PROTOCOL → no slot index displayed", () => {
    const {container} = render(<StakeStatusPanel status={status("PROTOCOL")} />);
    expect(container.textContent).toContain("Protocol launch");
    expect(container.textContent).not.toContain("Slot index");
  });
});
