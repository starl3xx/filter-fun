/// Handler-layer tests for the username write surface + availability +
/// identifier resolution. The store is the in-memory fake; the recoverer is
/// a deterministic stub keyed off the message contents.

import {describe, expect, it} from "vitest";

import {
  checkUsernameAvailability,
  resolveProfileIdentifier,
  setUsernameHandler,
  userProfileBlockFromRow,
  type RecoverFn,
} from "../../src/api/userProfileHandler.js";
import {
  buildSetUsernameMessage,
  USERNAME_COOLDOWN_MS,
} from "../../src/api/username.js";
import {
  createInMemoryUserProfileStore,
  type UserProfileRow,
} from "../../src/api/userProfileStore.js";

const NOW = new Date("2026-05-04T12:00:00.000Z");
const fixedNow = (): Date => NOW;

function addr(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
}

const ADDR_A = addr(0xa1);
const ADDR_B = addr(0xb2);

/// Stub recoverer: returns whichever address the test message claims (we
/// pre-build the message ourselves and pass it through). The signing client
/// would normally do `personal_sign` over the same message body; we shortcut
/// the keccak by trusting the test-side fixture.
function makeRecoverFor(returningAddress: `0x${string}`): RecoverFn {
  return async () => returningAddress;
}

const ALWAYS_THROWING_RECOVER: RecoverFn = async () => {
  throw new Error("malformed signature");
};

const ZERO_SIG = "0x" + "0".repeat(130) as `0x${string}`;

// ============================================================ availability

describe("checkUsernameAvailability", () => {
  it("available for a valid never-taken handle", async () => {
    const store = createInMemoryUserProfileStore();
    const r = await checkUsernameAvailability(store, "starbreaker");
    expect(r).toEqual({available: true});
  });

  it("invalid-format with formatDetail when too short", async () => {
    const store = createInMemoryUserProfileStore();
    const r = await checkUsernameAvailability(store, "ab");
    expect(r).toEqual({
      available: false,
      reason: "invalid-format",
      formatDetail: "too-short",
    });
  });

  it("blocklisted for baseline reserved word", async () => {
    const store = createInMemoryUserProfileStore();
    const r = await checkUsernameAvailability(store, "admin");
    expect(r).toEqual({available: false, reason: "blocklisted"});
  });

  it("blocklisted for operator-extended word", async () => {
    const store = createInMemoryUserProfileStore({
      operatorBlockedSet: new Set(["badword"]),
    });
    const r = await checkUsernameAvailability(store, "badword");
    expect(r).toEqual({available: false, reason: "blocklisted"});
  });

  it("taken when another wallet owns the handle", async () => {
    const store = createInMemoryUserProfileStore();
    store._seed({
      address: ADDR_A,
      username: "starbreaker",
      usernameDisplay: "StarBreaker",
      createdAt: NOW,
      updatedAt: NOW,
      usernameUpdatedAt: NOW,
    });
    const r = await checkUsernameAvailability(store, "STARBREAKER");
    expect(r).toEqual({available: false, reason: "taken"});
  });
});

// ============================================================ set username

describe("setUsernameHandler", () => {
  it("rejects malformed address with 400", async () => {
    const store = createInMemoryUserProfileStore();
    const r = await setUsernameHandler({
      store,
      recover: makeRecoverFor(ADDR_A),
      rawAddress: "not-an-address",
      body: {username: "ok", signature: ZERO_SIG, nonce: "n1"},
      now: fixedNow,
    });
    expect(r.status).toBe(400);
  });

  it("rejects body with missing fields", async () => {
    const store = createInMemoryUserProfileStore();
    const r = await setUsernameHandler({
      store,
      recover: makeRecoverFor(ADDR_A),
      rawAddress: ADDR_A,
      body: {username: "valid"},
      now: fixedNow,
    });
    expect(r.status).toBe(400);
    if (r.status === 400) {
      expect(r.body.error).toBe("invalid request body");
    }
  });

  it("rejects format errors before invoking recovery", async () => {
    const store = createInMemoryUserProfileStore();
    let recoverCalled = false;
    const recoverSpy: RecoverFn = async () => {
      recoverCalled = true;
      return ADDR_A;
    };
    const r = await setUsernameHandler({
      store,
      recover: recoverSpy,
      rawAddress: ADDR_A,
      body: {username: "ab", signature: ZERO_SIG, nonce: "n1"},
      now: fixedNow,
    });
    expect(r.status).toBe(400);
    expect(recoverCalled).toBe(false);
  });

  it("returns 401 when recovered address does NOT match path address", async () => {
    const store = createInMemoryUserProfileStore();
    const r = await setUsernameHandler({
      store,
      recover: makeRecoverFor(ADDR_B), // different address!
      rawAddress: ADDR_A,
      body: {username: "starbreaker", signature: ZERO_SIG, nonce: "n1"},
      now: fixedNow,
    });
    expect(r.status).toBe(401);
    if (r.status === 401) {
      expect(r.body.error).toBe("signature mismatch");
    }
  });

  it("returns 401 on recovery throw (malformed signature)", async () => {
    const store = createInMemoryUserProfileStore();
    const r = await setUsernameHandler({
      store,
      recover: ALWAYS_THROWING_RECOVER,
      rawAddress: ADDR_A,
      body: {username: "starbreaker", signature: ZERO_SIG, nonce: "n1"},
      now: fixedNow,
    });
    expect(r.status).toBe(401);
  });

  it("happy path: stores the row and returns 200 with profile block", async () => {
    const store = createInMemoryUserProfileStore();
    const r = await setUsernameHandler({
      store,
      recover: makeRecoverFor(ADDR_A),
      rawAddress: ADDR_A,
      body: {username: "StarBreaker", signature: ZERO_SIG, nonce: "n1"},
      now: fixedNow,
    });
    expect(r.status).toBe(200);
    if (r.status === 200) {
      expect(r.body.profile.address).toBe(ADDR_A);
      expect(r.body.profile.username).toBe("starbreaker");
      expect(r.body.profile.usernameDisplay).toBe("StarBreaker");
      expect(r.body.profile.hasUsername).toBe(true);
    }
    // Verify it persisted
    const persisted = await store.getByAddress(ADDR_A);
    expect(persisted?.username).toBe("starbreaker");
  });

  it("rejects baseline reserved word with 400 even with valid signature", async () => {
    const store = createInMemoryUserProfileStore();
    const r = await setUsernameHandler({
      store,
      recover: makeRecoverFor(ADDR_A),
      rawAddress: ADDR_A,
      body: {username: "admin", signature: ZERO_SIG, nonce: "n1"},
      now: fixedNow,
    });
    expect(r.status).toBe(400);
    if (r.status === 400) {
      expect(r.body.error).toBe("blocklisted username");
    }
  });

  it("rejects taken-by-other with 409", async () => {
    const store = createInMemoryUserProfileStore();
    store._seed({
      address: ADDR_B,
      username: "starbreaker",
      usernameDisplay: "starbreaker",
      createdAt: NOW,
      updatedAt: NOW,
      usernameUpdatedAt: NOW,
    });
    const r = await setUsernameHandler({
      store,
      recover: makeRecoverFor(ADDR_A),
      rawAddress: ADDR_A,
      body: {username: "starbreaker", signature: ZERO_SIG, nonce: "n1"},
      now: fixedNow,
    });
    expect(r.status).toBe(409);
    if (r.status === 409) {
      expect(r.body.error).toBe("taken");
    }
  });

  it("rejects active cooldown with 409 + nextEligibleAt", async () => {
    const store = createInMemoryUserProfileStore();
    const fifteenDaysAgo = new Date(NOW.getTime() - 15 * 24 * 60 * 60 * 1000);
    store._seed({
      address: ADDR_A,
      username: "old-handle",
      usernameDisplay: "old-handle",
      createdAt: fifteenDaysAgo,
      updatedAt: fifteenDaysAgo,
      usernameUpdatedAt: fifteenDaysAgo,
    });
    const r = await setUsernameHandler({
      store,
      recover: makeRecoverFor(ADDR_A),
      rawAddress: ADDR_A,
      body: {username: "new-handle", signature: ZERO_SIG, nonce: "n2"},
      now: fixedNow,
    });
    expect(r.status).toBe(409);
    if (r.status === 409) {
      expect(r.body.error).toBe("cooldown-active");
      expect(r.body.nextEligibleAt).toBe(
        new Date(fifteenDaysAgo.getTime() + USERNAME_COOLDOWN_MS).toISOString(),
      );
    }
  });

  it("idempotent re-set: repeating own handle returns 200 without revving cooldown", async () => {
    const store = createInMemoryUserProfileStore();
    const fifteenDaysAgo = new Date(NOW.getTime() - 15 * 24 * 60 * 60 * 1000);
    store._seed({
      address: ADDR_A,
      username: "starbreaker",
      usernameDisplay: "StarBreaker",
      createdAt: fifteenDaysAgo,
      updatedAt: fifteenDaysAgo,
      usernameUpdatedAt: fifteenDaysAgo,
    });
    const r = await setUsernameHandler({
      store,
      recover: makeRecoverFor(ADDR_A),
      rawAddress: ADDR_A,
      body: {username: "starbreaker", signature: ZERO_SIG, nonce: "n2"},
      now: fixedNow,
    });
    expect(r.status).toBe(200);
    // Cooldown timestamp must NOT have moved
    const persisted = await store.getByAddress(ADDR_A);
    expect(persisted?.usernameUpdatedAt?.toISOString()).toBe(fifteenDaysAgo.toISOString());
  });

  it("upsert-time blocklist gate catches post-pre-flight blocklist adds (PR #102 pass-8)", async () => {
    // Bugbot L PR #102 pass-8: the original `upsertUsername` SQL didn't
    // re-assert the operator blocklist atomically with the commit, so a
    // request that passed `evaluateSetUsername`'s pre-flight could still
    // succeed if an operator added the handle to the blocklist between
    // the read and the write. Simulate the race by giving the handler a
    // store whose `isOperatorBlocked` reports false (pre-flight passes)
    // but whose `upsertUsername` returns `blocklisted-operator` (commit
    // catches the race). Asserts the handler maps the variant to the
    // wire 400 the user sees.
    const racingStore = createInMemoryUserProfileStore();
    const wrapped = {
      ...racingStore,
      isOperatorBlocked: async () => false,
      upsertUsername: async () =>
        ({ok: false, error: "blocklisted-operator"}) as const,
    };
    const r = await setUsernameHandler({
      store: wrapped,
      recover: makeRecoverFor(ADDR_A),
      rawAddress: ADDR_A,
      body: {username: "starbreaker", signature: ZERO_SIG, nonce: "n-race"},
      now: fixedNow,
    });
    expect(r.status).toBe(400);
    if (r.status === 400) {
      expect(r.body.error).toBe("blocklisted username");
    }
  });

  it("idempotent re-set is REJECTED if operator blocklisted the handle post-claim (PR #102 pass-6)", async () => {
    // The user owned `starbreaker`, then an operator added it to the
    // blocklist. A re-confirm POST must NOT short-circuit to 200 — that
    // would let incumbents permanently retain a freshly-banned handle. The
    // indexer should treat the row as if the handle were freshly invalid
    // and force them through a rename via `evaluateSetUsername`.
    const store = createInMemoryUserProfileStore({
      operatorBlockedSet: new Set(["starbreaker"]),
    });
    const fifteenDaysAgo = new Date(NOW.getTime() - 15 * 24 * 60 * 60 * 1000);
    store._seed({
      address: ADDR_A,
      username: "starbreaker",
      usernameDisplay: "StarBreaker",
      createdAt: fifteenDaysAgo,
      updatedAt: fifteenDaysAgo,
      usernameUpdatedAt: fifteenDaysAgo,
    });
    const r = await setUsernameHandler({
      store,
      recover: makeRecoverFor(ADDR_A),
      rawAddress: ADDR_A,
      body: {username: "starbreaker", signature: ZERO_SIG, nonce: "n2"},
      now: fixedNow,
    });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({error: "blocklisted username"});
    // Existing row must remain untouched (no mutation on rejection).
    const persisted = await store.getByAddress(ADDR_A);
    expect(persisted?.usernameUpdatedAt?.toISOString()).toBe(fifteenDaysAgo.toISOString());
  });

  it("post-cooldown: new handle replaces the old", async () => {
    const store = createInMemoryUserProfileStore();
    const thirtyOneDaysAgo = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000);
    store._seed({
      address: ADDR_A,
      username: "old-handle",
      usernameDisplay: "old-handle",
      createdAt: thirtyOneDaysAgo,
      updatedAt: thirtyOneDaysAgo,
      usernameUpdatedAt: thirtyOneDaysAgo,
    });
    const r = await setUsernameHandler({
      store,
      recover: makeRecoverFor(ADDR_A),
      rawAddress: ADDR_A,
      body: {username: "new-handle", signature: ZERO_SIG, nonce: "n3"},
      now: fixedNow,
    });
    expect(r.status).toBe(200);
    const persisted = await store.getByAddress(ADDR_A);
    expect(persisted?.username).toBe("new-handle");
    expect(persisted?.usernameUpdatedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("recoverer receives the canonical signed message", async () => {
    const store = createInMemoryUserProfileStore();
    let receivedMessage: string | null = null;
    const recoverSpy: RecoverFn = async ({message}) => {
      receivedMessage = message;
      return ADDR_A;
    };
    await setUsernameHandler({
      store,
      recover: recoverSpy,
      rawAddress: ADDR_A,
      body: {username: "StarBreaker", signature: ZERO_SIG, nonce: "n9"},
      now: fixedNow,
    });
    // The message should match what the client must sign — exact format
    expect(receivedMessage).toBe(buildSetUsernameMessage(ADDR_A, "starbreaker", "n9"));
  });
});

// ============================================================ resolveProfileIdentifier

describe("resolveProfileIdentifier", () => {
  it("address path: resolves to address with no profile row when none exists", async () => {
    const store = createInMemoryUserProfileStore();
    const r = await resolveProfileIdentifier(store, ADDR_A);
    expect(r).toEqual({address: ADDR_A, profileRow: null});
  });

  it("address path: includes profile row when one exists", async () => {
    const store = createInMemoryUserProfileStore();
    store._seed({
      address: ADDR_A,
      username: "starbreaker",
      usernameDisplay: "StarBreaker",
      createdAt: NOW,
      updatedAt: NOW,
      usernameUpdatedAt: NOW,
    });
    const r = await resolveProfileIdentifier(store, ADDR_A);
    expect(r?.address).toBe(ADDR_A);
    expect(r?.profileRow?.username).toBe("starbreaker");
  });

  it("username path: resolves to the stored address (case-insensitive)", async () => {
    const store = createInMemoryUserProfileStore();
    store._seed({
      address: ADDR_A,
      username: "starbreaker",
      usernameDisplay: "StarBreaker",
      createdAt: NOW,
      updatedAt: NOW,
      usernameUpdatedAt: NOW,
    });
    const r = await resolveProfileIdentifier(store, "STARBREAKER");
    expect(r?.address).toBe(ADDR_A);
    expect(r?.profileRow?.usernameDisplay).toBe("StarBreaker");
  });

  it("username path: returns null on unknown handle", async () => {
    const store = createInMemoryUserProfileStore();
    const r = await resolveProfileIdentifier(store, "ghost");
    expect(r).toBeNull();
  });

  it("invalid identifier returns null", async () => {
    const store = createInMemoryUserProfileStore();
    expect(await resolveProfileIdentifier(store, "")).toBeNull();
    expect(await resolveProfileIdentifier(store, "ab")).toBeNull();
    expect(await resolveProfileIdentifier(store, "foo bar")).toBeNull();
  });
});

describe("userProfileBlockFromRow", () => {
  it("zero-fills when row is null", () => {
    const block = userProfileBlockFromRow(ADDR_A, null);
    expect(block).toEqual({
      address: ADDR_A,
      username: null,
      usernameDisplay: null,
      hasUsername: false,
    });
  });

  it("hasUsername reflects username presence", () => {
    const row: UserProfileRow = {
      address: ADDR_A,
      username: "starbreaker",
      usernameDisplay: "StarBreaker",
      createdAt: NOW,
      updatedAt: NOW,
      usernameUpdatedAt: NOW,
    };
    const block = userProfileBlockFromRow(ADDR_A, row);
    expect(block.hasUsername).toBe(true);
    expect(block.username).toBe("starbreaker");
  });
});
