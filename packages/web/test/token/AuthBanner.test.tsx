/// AuthBanner — covers the four auth states the admin console drives copy
/// and CTAs from. Each branch needs to be unambiguous at a glance, so the
/// canonical strings are asserted here.

import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {AuthBanner} from "@/components/admin/AuthBanner";

const ADMIN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const PENDING = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

describe("AuthBanner", () => {
  it("DISCONNECTED → 'Connect a wallet to manage'", () => {
    const {container} = render(<AuthBanner state="DISCONNECTED" admin={ADMIN} pendingAdmin={null} />);
    expect(container.textContent).toContain("Connect a wallet to manage");
  });

  it("READ_ONLY → 'not the admin' + current admin shown", () => {
    const {container} = render(<AuthBanner state="READ_ONLY" admin={ADMIN} pendingAdmin={null} />);
    expect(container.textContent).toContain("Read-only");
    expect(container.textContent).toContain("not the admin");
    // Short address (first 6, last 4) should appear.
    expect(container.textContent).toContain("0xaaaa");
  });

  it("ADMIN → 'You are the admin' affirmative", () => {
    const {container} = render(<AuthBanner state="ADMIN" admin={ADMIN} pendingAdmin={null} />);
    expect(container.textContent).toContain("You are the admin of this token");
  });

  it("PENDING → 'You've been nominated' + cross-link to accept", () => {
    const {container} = render(
      <AuthBanner state="PENDING" admin={ADMIN} pendingAdmin={PENDING} onScrollToAccept={() => {}} />,
    );
    expect(container.textContent).toContain("nominated as the new admin");
    expect(container.textContent).toContain("Jump to accept");
  });

  it("READ_ONLY with pendingAdmin → also surfaces pending", () => {
    const {container} = render(<AuthBanner state="READ_ONLY" admin={ADMIN} pendingAdmin={PENDING} />);
    expect(container.textContent).toContain("Pending admin");
  });
});
