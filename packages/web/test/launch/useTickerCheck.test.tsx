/// Hook tests for useTickerCheck — Epic 1.15c.
///
/// Mocks `fetchTickerCheck` and asserts the four verdict shapes map to the
/// right user-facing copy. Loading + abort behaviour is covered implicitly:
/// vitest's renderHook unmounts cleanly between tests, exercising the
/// hook's controller.abort() path.

import {describe, expect, it, vi, beforeEach} from "vitest";
import {renderHook, waitFor} from "@testing-library/react";

vi.mock("@/lib/arena/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/arena/api")>("@/lib/arena/api");
  return {
    ...actual,
    fetchTickerCheck: vi.fn(),
  };
});

import {fetchTickerCheck} from "@/lib/arena/api";
import {useTickerCheck} from "@/hooks/launch/useTickerCheck";

const fetchMock = vi.mocked(fetchTickerCheck);

beforeEach(() => {
  fetchMock.mockReset();
});

describe("useTickerCheck", () => {
  it("returns null error on `available`", async () => {
    fetchMock.mockResolvedValue({
      ok: "available",
      canonical: "PEPE",
      hash: "0xabc",
    });
    const {result} = renderHook(() => useTickerCheck("pepe", 1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(null);
    expect(result.current.canonical).toBe("PEPE");
  });

  it("returns blocklisted message on `blocklisted`", async () => {
    fetchMock.mockResolvedValue({
      ok: "blocklisted",
      canonical: "FILTER",
      hash: "0xabc",
    });
    const {result} = renderHook(() => useTickerCheck("filter", 1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/reserved by the protocol/i);
  });

  it("returns winner_taken copy on `winner_taken`", async () => {
    fetchMock.mockResolvedValue({
      ok: "winner_taken",
      canonical: "PEPEWIN",
      hash: "0xabc",
      reservedSeasonId: "1",
    });
    const {result} = renderHook(() => useTickerCheck("pepewin", 2));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/won a previous season/i);
  });

  it("returns season_taken copy on `season_taken`", async () => {
    fetchMock.mockResolvedValue({
      ok: "season_taken",
      canonical: "PEPE",
      hash: "0xabc",
      reservedBy: "0xc0de",
    });
    const {result} = renderHook(() => useTickerCheck("pepe", 3));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/already reserved this season/i);
  });

  it("skips the request when seasonId is null", () => {
    const {result} = renderHook(() => useTickerCheck("pepe", null));
    expect(result.current.error).toBe(null);
    expect(result.current.loading).toBe(false);
    expect(fetchTickerCheck).not.toHaveBeenCalled();
  });

  it("skips the request when ticker is too short", () => {
    const {result} = renderHook(() => useTickerCheck("X", 1));
    expect(result.current.error).toBe(null);
    expect(fetchTickerCheck).not.toHaveBeenCalled();
  });

  it("surfaces a generic failure message on network error", async () => {
    fetchMock.mockRejectedValue(new Error("network boom"));
    const {result} = renderHook(() => useTickerCheck("pepe", 1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/couldn't verify/i);
  });
});
