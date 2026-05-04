/// Epic 1.19 — bugbot Low finding regression (PR #91, commit 278b16d).
///
/// `useArenaSortMode` and `useArenaViewMode` return a `[value, setter]`
/// pair. Pre-fix the setter was a fresh closure on every render — a
/// subtle perf hazard for any consumer that captures it inside a
/// `useMemo`/`useCallback` dep array (it'd bust the memo every render).
/// Post-fix both are wrapped in `useCallback` with an empty dep list so
/// the reference is stable across renders.
///
/// We pin identity directly (rather than going through render-prop
/// gymnastics) by mounting a tiny harness, capturing the setter on
/// mount and the next render, and asserting `===`.
import {render} from "@testing-library/react";
import {useEffect, useState} from "react";
import {describe, expect, it} from "vitest";

import {useArenaSortMode, type ArenaSortMode} from "../../src/components/arena/ArenaSortDropdown.js";
import {useArenaViewMode, type ArenaViewMode} from "../../src/components/arena/ViewToggle.js";

describe("Epic 1.19 — arena hook setters have stable identity across renders", () => {
  it("useArenaViewMode setter reference is stable across an unrelated re-render", () => {
    const captured: Array<(m: ArenaViewMode) => void> = [];

    function Harness({tick}: {tick: number}) {
      const [, set] = useArenaViewMode();
      // Capture on every render so we can compare identities post-mount.
      captured.push(set);
      return <span data-testid="tick">{tick}</span>;
    }

    const {rerender} = render(<Harness tick={0} />);
    rerender(<Harness tick={1} />);
    rerender(<Harness tick={2} />);

    // First captured setter is the SSR-default render; subsequent
    // captures must all be `===` to it.
    expect(captured.length).toBeGreaterThanOrEqual(2);
    const first = captured[0];
    for (const s of captured.slice(1)) {
      expect(s).toBe(first);
    }
  });

  it("useArenaSortMode setter reference is stable across an unrelated re-render", () => {
    const captured: Array<(m: ArenaSortMode) => void> = [];

    function Harness({tick}: {tick: number}) {
      const [, set] = useArenaSortMode();
      captured.push(set);
      return <span data-testid="tick">{tick}</span>;
    }

    const {rerender} = render(<Harness tick={0} />);
    rerender(<Harness tick={1} />);
    rerender(<Harness tick={2} />);

    expect(captured.length).toBeGreaterThanOrEqual(2);
    const first = captured[0];
    for (const s of captured.slice(1)) {
      expect(s).toBe(first);
    }
  });

  it("useArenaViewMode setter remains stable even when its OWN call mutates the value", () => {
    // The harshest test: trigger a state update from inside the hook
    // (via the rehydrate useEffect on mount) and confirm the setter
    // identity survives the subsequent re-render.
    const captured: Array<(m: ArenaViewMode) => void> = [];

    function Harness() {
      const [mode, set] = useArenaViewMode();
      const [, force] = useState(0);
      captured.push(set);
      useEffect(() => {
        force((n) => n + 1);
      }, [mode]);
      return null;
    }

    render(<Harness />);
    expect(captured.length).toBeGreaterThanOrEqual(2);
    const first = captured[0];
    for (const s of captured.slice(1)) {
      expect(s).toBe(first);
    }
  });
});
