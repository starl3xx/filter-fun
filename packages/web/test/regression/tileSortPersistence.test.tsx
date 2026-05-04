/// Epic 1.19 regression — tile sort persistence.
///
/// The dispatch locks four sort modes (HP-desc / by status / by recent
/// activity / by recent HP delta) and persists the user's choice as
/// `arena_sort` in localStorage so a reload keeps it. Default is the
/// canonical HP-desc — matching the row view's sort so flipping between
/// modes preserves the user's mental model of "which tokens are top".
import {fireEvent, render, screen} from "@testing-library/react";
import {beforeEach, describe, expect, it} from "vitest";

import {
  ARENA_SORT_KEY,
  ARENA_SORT_OPTIONS,
  ArenaSortDropdown,
  readStoredSortMode,
  writeStoredSortMode,
  type ArenaSortMode,
} from "../../src/components/arena/ArenaSortDropdown.js";

describe("Epic 1.19 — tile sort persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("default mode on first visit is 'hp-desc'", () => {
    expect(readStoredSortMode()).toBe("hp-desc");
  });

  it("storage key is 'arena_sort' (do not rename)", () => {
    expect(ARENA_SORT_KEY).toBe("arena_sort");
  });

  it("persists 'status' through writeStoredSortMode and re-reads on rehydration", () => {
    writeStoredSortMode("status");
    expect(window.localStorage.getItem(ARENA_SORT_KEY)).toBe("status");
    expect(readStoredSortMode()).toBe("status");
  });

  it("falls back to 'hp-desc' on an unrecognised stored value", () => {
    window.localStorage.setItem(ARENA_SORT_KEY, "garbage");
    expect(readStoredSortMode()).toBe("hp-desc");
  });

  it("dropdown surfaces exactly the four spec-locked modes", () => {
    const modes = ARENA_SORT_OPTIONS.map((o) => o.mode).sort();
    expect(modes).toEqual(["activity", "delta", "hp-desc", "status"].sort());
  });

  it("changing the dropdown invokes onChange with the selected mode", () => {
    let selected: ArenaSortMode = "hp-desc";
    const onChange = (m: ArenaSortMode) => {
      selected = m;
      writeStoredSortMode(m);
    };
    render(<ArenaSortDropdown value={selected} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/sort tile view/i), {target: {value: "status"}});
    expect(selected).toBe("status");
    expect(window.localStorage.getItem(ARENA_SORT_KEY)).toBe("status");
  });
});
