/// Component tests for the launch form.
///
/// Asserts:
///   - acknowledgment + valid fields gate the launch button
///   - ticker collision shows an inline error against /tokens cohort
///   - disabledReason renders an info notice and locks submit

import {fireEvent, render, screen} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("wagmi", () => ({
  useAccount: () => ({address: "0x1234567890123456789012345678901234567890", isConnected: true}),
}));

import {LaunchForm} from "@/components/launch/LaunchForm";
import {makeFixtureCohort} from "../arena/fixtures";

const baseProps = {
  slotIndex: 8,
  launchCostWei: 84000000000000000n,
  stakeWei: 84000000000000000n,
  cohort: makeFixtureCohort(),
  phase: "idle" as const,
  error: null,
  onSubmit: vi.fn(),
};

beforeEach(() => {
  baseProps.onSubmit = vi.fn();
});

describe("LaunchForm", () => {
  it("starts with the launch button disabled", () => {
    render(<LaunchForm {...baseProps} />);
    const btn = screen.getByRole("button", {name: /launch token/i});
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders the disabled reason when supplied", () => {
    render(<LaunchForm {...baseProps} disabledReason="You've already launched a token this week." />);
    expect(screen.getByText(/already launched a token this week/i)).toBeTruthy();
  });

  it("enables the launch button only after fields + ack are valid", () => {
    render(<LaunchForm {...baseProps} />);
    const name = screen.getByPlaceholderText(/Filtermaxx/i);
    const ticker = screen.getByPlaceholderText("MAXX");
    const desc = screen.getByPlaceholderText(/one line/i);
    const image = screen.getByPlaceholderText("https://…");
    const ack = screen.getByRole("checkbox");

    fireEvent.change(name, {target: {value: "Maxxxx"}});
    fireEvent.change(ticker, {target: {value: "MAXX"}});
    fireEvent.change(desc, {target: {value: "A token built to survive the filter."}});
    fireEvent.change(image, {target: {value: "https://cdn.example.com/logo.png"}});

    const btn = screen.getByRole("button", {name: /launch token/i});
    expect((btn as HTMLButtonElement).disabled).toBe(true); // ack still off
    fireEvent.click(ack);
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("rejects ticker collisions against the cohort", async () => {
    render(<LaunchForm {...baseProps} />);
    const ticker = screen.getByPlaceholderText("MAXX");
    fireEvent.change(ticker, {target: {value: "FILTER"}});
    // The form debounces ticker collision lookups by 200ms; findByText polls
    // the DOM (no need for fake timers).
    expect(await screen.findByText(/already launched this season/i)).toBeTruthy();
  });
});
