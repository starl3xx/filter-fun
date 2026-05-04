/// Epic 1.19 regression — tile live HP_UPDATED → floating-delta overlay.
///
/// When an HP_UPDATED SSE frame arrives for a token, the tile shows a
/// `+12` (green) or `−34` (red) delta anchored to the HP integer that
/// rises ~30px and fades within ~2s. The component renders a sign +
/// magnitude with a thousands separator when the delta exceeds 999.
///
/// We can't observe the CSS transform/opacity drift in jsdom (no layout
/// engine), so the rendered DOM contract is the regression anchor:
///   1. Element renders with the correct sign and magnitude.
///   2. After `durationMs` the element unmounts (returns null) — covering
///      the "fades within 2s" part of the spec.
///   3. `data-delta-sign` reflects positive/negative for downstream
///      style-targeting tests.
import {render} from "@testing-library/react";
import {act} from "react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {FloatingHpDelta} from "../../src/components/arena/FloatingHpDelta.js";

describe("Epic 1.19 — FloatingHpDelta", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders +N with positive sign when delta > 0", () => {
    const {container} = render(<FloatingHpDelta delta={42} />);
    const el = container.querySelector('[data-floating-hp-delta="true"]');
    expect(el).not.toBeNull();
    expect(el!.getAttribute("data-delta-sign")).toBe("positive");
    expect(el!.textContent).toBe("+42");
  });

  it("renders −N (U+2212 minus) with negative sign when delta < 0", () => {
    const {container} = render(<FloatingHpDelta delta={-37} />);
    const el = container.querySelector('[data-floating-hp-delta="true"]');
    expect(el).not.toBeNull();
    expect(el!.getAttribute("data-delta-sign")).toBe("negative");
    expect(el!.textContent).toBe("−37");
    expect(el!.textContent).not.toContain("-");
  });

  it("formats four-digit deltas with a thousands separator", () => {
    const {container} = render(<FloatingHpDelta delta={1250} />);
    const el = container.querySelector('[data-floating-hp-delta="true"]');
    expect(el!.textContent).toBe("+1,250");
  });

  it("renders nothing when delta is exactly zero (no-op update)", () => {
    const {container} = render(<FloatingHpDelta delta={0} />);
    expect(container.querySelector('[data-floating-hp-delta="true"]')).toBeNull();
  });

  it("unmounts after the durationMs lifetime expires (fades within 2s)", () => {
    const onComplete = vi.fn();
    const {container} = render(<FloatingHpDelta delta={50} durationMs={2000} onComplete={onComplete} />);
    expect(container.querySelector('[data-floating-hp-delta="true"]')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(2001);
    });
    expect(container.querySelector('[data-floating-hp-delta="true"]')).toBeNull();
    expect(onComplete).toHaveBeenCalledOnce();
  });
});
