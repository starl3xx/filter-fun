/// `createPgUserProfileStore` — schema-init resilience + canonical-store
/// defenses.
///
/// PR #102 pass-10 caught a real bug: `ensureSchema` cached the in-flight
/// DDL promise in `schemaReady` indefinitely. If the very first request
/// triggered a transient pg failure (connection blip, restart, lock
/// timeout), the rejected promise was permanently cached and every later
/// caller saw the same failure even after the DB recovered. The fix
/// mirrors `getUserProfileStore`'s in-flight-Promise pattern: on rejection,
/// null the cache so the next call retries.
///
/// PR #102 pass-13 caught a defensiveness issue: the in-memory fake stored
/// the raw `canonical` parameter into `UserProfileRow.username`, but by
/// contract that column is the *lowercased* canonical. Today no caller
/// passes a non-lowered canonical (the handler runs `validateUsernameFormat`
/// upstream), but the store can't assume that — invariants belong inside
/// the boundary that documents them.

import {describe, expect, it, vi} from "vitest";

import {
  createInMemoryUserProfileStore,
  createPgUserProfileStore,
  type Pool,
} from "../../src/api/userProfileStore.js";

function makePool(queryImpl: (text: string) => Promise<unknown>): Pool {
  return {
    query: vi.fn(async (text: string) => {
      const r = await queryImpl(text);
      return {rows: (r as {rows?: unknown[]}).rows ?? [], rowCount: 0};
    }) as unknown as Pool["query"],
  };
}

describe("createPgUserProfileStore.ensureSchema (PR #102 pass-10)", () => {
  it("retries the DDL after a transient first-call failure", async () => {
    let attempts = 0;
    const pool = makePool(async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("connection terminated");
      }
      return {rows: []};
    });
    const store = createPgUserProfileStore(pool);

    await expect(store.ensureSchema()).rejects.toThrow(/connection terminated/);
    // After the failure, a fresh call should re-issue the DDL — the
    // rejected promise from attempt #1 must NOT be cached.
    await expect(store.ensureSchema()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("memoizes a successful DDL across calls (no re-issue on second call)", async () => {
    let attempts = 0;
    const pool = makePool(async () => {
      attempts++;
      return {rows: []};
    });
    const store = createPgUserProfileStore(pool);

    await store.ensureSchema();
    await store.ensureSchema();
    expect(attempts).toBe(1);
  });
});

describe("createInMemoryUserProfileStore.upsertUsername (PR #102 pass-13)", () => {
  it("stores the lowered canonical in `username` regardless of caller casing", async () => {
    const store = createInMemoryUserProfileStore();
    const ADDR = "0x" + "a".repeat(40) as `0x${string}`;
    // Pass a deliberately mixed-case canonical to confirm the store
    // defensively lowercases. By contract `UserProfileRow.username` is the
    // lowercased canonical (consumers compare via `username === canonical`
    // and the pg index runs on `lower(username)`); the fake must match.
    const r = await store.upsertUsername({
      address: ADDR,
      canonical: "StarBreaker",
      display: "StarBreaker",
      now: new Date("2026-05-04T12:00:00Z"),
      cooldownMs: 0,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row.username).toBe("starbreaker");
      expect(r.row.usernameDisplay).toBe("StarBreaker");
    }
    const reread = await store.getByAddress(ADDR);
    expect(reread?.username).toBe("starbreaker");
    expect(reread?.usernameDisplay).toBe("StarBreaker");
  });
});
