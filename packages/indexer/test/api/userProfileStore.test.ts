/// `createPgUserProfileStore` — schema-init resilience.
///
/// Bugbot M PR #102 pass-10 caught a real bug: `ensureSchema` cached the
/// in-flight DDL promise in `schemaReady` indefinitely. If the very first
/// request triggered a transient pg failure (connection blip, restart, lock
/// timeout), the rejected promise was permanently cached and every later
/// caller saw the same failure even after the DB recovered. The fix mirrors
/// `getUserProfileStore`'s in-flight-Promise pattern: on rejection, null
/// the cache so the next call retries.

import {describe, expect, it, vi} from "vitest";

import {
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
