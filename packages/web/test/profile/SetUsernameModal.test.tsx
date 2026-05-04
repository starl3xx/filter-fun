/// SetUsernameModal — Epic 1.24 (PR #102 pass-4 regression).
///
/// Bugbot M PR #102: a network failure inside `submitUsername` (DNS, offline,
/// indexer 5xx) propagated as an unhandled rejection — the user saw the
/// button re-enable with zero feedback. The fix wraps the call in an outer
/// catch that sets `submitError` to a generic "Network error — try again."
/// This test locks that behavior in.

import {act, fireEvent, render, waitFor} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("wagmi", () => ({
  useSignMessage: () => ({
    signMessageAsync: vi.fn().mockResolvedValue("0xdeadbeef"),
  }),
}));

vi.mock("@/lib/arena/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/arena/api")>("@/lib/arena/api");
  return {
    ...actual,
    fetchUsernameAvailability: vi.fn(),
    submitUsername: vi.fn(),
  };
});

import {fetchUsernameAvailability, submitUsername, type UserProfileBlock} from "@/lib/arena/api";
import {SetUsernameModal} from "@/components/profile/SetUsernameModal";

const ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

const initial: UserProfileBlock = {
  address: ADDR,
  username: null,
  usernameDisplay: null,
  hasUsername: false,
};

const fetchMock = vi.mocked(fetchUsernameAvailability);
const submitMock = vi.mocked(submitUsername);

beforeEach(() => {
  fetchMock.mockReset();
  submitMock.mockReset();
});

describe("SetUsernameModal — submit error handling (PR #102 pass-4)", () => {
  it("surfaces a 'Network error' message when submitUsername throws", async () => {
    fetchMock.mockResolvedValue({available: true});
    submitMock.mockRejectedValue(new Error("fetch failed"));

    const {container, getByText} = render(
      <SetUsernameModal
        address={ADDR}
        initial={initial}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    const input = container.querySelector("input")!;
    await act(async () => {
      fireEvent.change(input, {target: {value: "starbreaker"}});
    });
    // Let the 300ms availability debounce fire so the submit button enables.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), {timeout: 1000});
    await waitFor(() => expect(container.textContent).toContain("Available"));

    const submitBtn = getByText("Sign and save");
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => expect(container.textContent).toContain("Network error"));
    // Button must re-enable so the user can retry — it'd be a worse bug to
    // leave the modal stuck after a transient failure.
    await waitFor(() => expect((submitBtn as HTMLButtonElement).disabled).toBe(false));
  });
});
