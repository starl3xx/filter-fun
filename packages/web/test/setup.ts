/// Vitest setup — runs before every test file. Pulls in jsdom-only globals
/// that React's test renderer expects.

import {cleanup} from "@testing-library/react";
import {afterEach} from "vitest";

// `globals: false` in vitest config means React Testing Library's auto-cleanup
// (which hooks `afterEach`) doesn't fire — without this, every render's DOM
// leaks into the next test in the file and breaks `getAllByRole` ordering.
afterEach(() => {
  cleanup();
});

// matchMedia isn't implemented in jsdom; arena's row click code calls it to
// decide whether to open the bottom-sheet. Stub a no-op that always returns
// "doesn't match" so desktop branches are exercised by default. Tests that
// need a different result override per-call.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
