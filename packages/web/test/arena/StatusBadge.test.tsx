/// Status badge unit test — tiny but the four-status mapping is the
/// canonical source of truth, so a regression here would break every
/// surface that consumes the status.

import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {StatusBadge} from "@/components/arena/StatusBadge";

describe("StatusBadge", () => {
  const cases = [
    {status: "SAFE", label: "Safe"},
    {status: "AT_RISK", label: "At risk"},
    {status: "FINALIST", label: "Finalist"},
    {status: "FILTERED", label: "Filtered"},
  ] as const;

  for (const {status, label} of cases) {
    it(`renders ${status} with its expected copy`, () => {
      const {container} = render(<StatusBadge status={status} />);
      expect(container.textContent).toContain(label);
      expect(container.querySelector("[data-status]")?.getAttribute("data-status")).toBe(status);
    });
  }
});
