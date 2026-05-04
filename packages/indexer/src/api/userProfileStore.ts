/// Off-chain storage for the `userProfile` row (Epic 1.24).
///
/// This table is the **only** mutable state the indexer surface owns that
/// isn't derived from on-chain events. Ponder's `onchainTable`s are
/// reorg-safe and reset-aware; that machinery is the wrong fit for an
/// off-chain identity layer (a reorg should not blow away usernames). So
/// `userProfile` lives in a separate Postgres table connected via the
/// standard `pg` client against the same `DATABASE_URL` Ponder uses, but in
/// a name-space that ponder does not manage. Lazy-init: the first call to
/// `ensureSchema()` creates the table + indexes if absent.
///
/// Test path: `UserProfileStore` is an interface, with a concrete pg-backed
/// impl below + an in-memory fake (`createInMemoryUserProfileStore`) the
/// vitest suite uses without a live Postgres. Handler tests inject the fake.
///
/// Concurrency. Username uniqueness is enforced by a partial-unique index on
/// `lower(username)` (only when not null). Two simultaneous writers
/// attempting the same handle race at the index level — the loser sees
/// PG error code 23505 and the adapter maps that to `"taken"` so the API
/// returns the right error. The cooldown check is read-modify-write inside
/// a single `UPDATE ... WHERE` so a wallet can't bypass cooldown by racing
/// itself (the WHERE clause re-asserts the time bound).

/// Minimal `pg.Pool` shape we depend on. Inlined here to avoid pulling in
/// `@types/pg` for the handful of methods we use (`query`). Matches the
/// public API of the `pg` package's `Pool` class. If the surface ever needs
/// to grow (transactions, listeners, pool stats), prefer adding `@types/pg`
/// to devDependencies over hand-extending this declaration.
interface PgQueryResult<T = unknown> {
  rows: T[];
  rowCount: number | null;
}
export interface Pool {
  // The real `pg.Pool.query` is generic; we mirror that so callers get typed
  // rows back without `as` everywhere.
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PgQueryResult<T>>;
}

export interface UserProfileRow {
  address: `0x${string}`;
  /// Lowercased canonical username (stored). NULL = no username chosen.
  username: string | null;
  /// User's preferred case for rendering. NULL when username is NULL.
  usernameDisplay: string | null;
  createdAt: Date;
  updatedAt: Date;
  /// Set whenever `username` is changed. Drives the cooldown gate.
  /// NULL when the row was created without a username (we keep the door open
  /// for storing operator-flagged-only rows in the future, though v1 only
  /// inserts on first set).
  usernameUpdatedAt: Date | null;
}

export type UpsertUsernameError =
  | "taken"
  | "cooldown-active"
  | "blocklisted-operator";

export interface UserProfileStore {
  /// Idempotent table + index creation. Must be called before any other
  /// method. The pg-backed impl runs `CREATE TABLE IF NOT EXISTS` + indexes;
  /// the in-memory fake is a no-op.
  ensureSchema(): Promise<void>;

  /// Lookup by lowercased address. Returns null when no row exists.
  getByAddress(address: `0x${string}`): Promise<UserProfileRow | null>;

  /// Lookup by canonical (lowercased) username. Returns null when no row
  /// exists with that handle.
  getByUsername(canonical: string): Promise<UserProfileRow | null>;

  /// True iff `canonical` is owned by some address other than `address`.
  /// Used by the live-availability endpoint and by `evaluateSetUsername`.
  isUsernameTakenByOther(canonical: string, address: `0x${string}`): Promise<boolean>;

  /// True iff `canonical` is in the operator-extended blocklist (the static
  /// `RESERVED_USERNAMES` are checked separately by the username module).
  isOperatorBlocked(canonical: string): Promise<boolean>;

  /// Upsert the `(username, usernameDisplay)` for `address`. The caller MUST
  /// have already passed `evaluateSetUsername` against an in-flight read of
  /// the cooldown / uniqueness state — this method is the *commit* step. It
  /// returns the updated row on success, or an error code on the rare race
  /// where uniqueness changed between read and write (`taken`) or the
  /// cooldown elapsed differently than the caller saw (`cooldown-active`).
  ///
  /// `now` is injected so tests can pin the timestamp.
  upsertUsername(input: {
    address: `0x${string}`;
    canonical: string;
    display: string;
    now: Date;
    cooldownMs: number;
  }): Promise<{ok: true; row: UserProfileRow} | {ok: false; error: UpsertUsernameError}>;

  /// Display-casing update for an existing row that already owns the
  /// matching canonical handle. The caller is responsible for confirming
  /// `existing.username === canonical(input.display)` before invoking;
  /// this method only touches `username_display` + `updated_at` and does
  /// NOT advance `username_updated_at`, so re-styling a handle does not
  /// burn a cooldown window.
  ///
  /// (Bugbot M PR #102 pass-11.) Returns the updated row, or null if no
  /// row exists for `address` or it has no canonical handle yet.
  updateDisplayCase(input: {
    address: `0x${string}`;
    display: string;
    now: Date;
  }): Promise<UserProfileRow | null>;
}

// ============================================================ Postgres impl

const TABLE_DDL = `
CREATE TABLE IF NOT EXISTS user_profile (
  address              TEXT PRIMARY KEY,
  username             TEXT,
  username_display     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  username_updated_at  TIMESTAMPTZ
);

-- Partial-unique index on lowercased username, NULLs excluded so a million
-- empty rows can coexist (we'd never write empty rows in v1, but the index
-- semantics are the documentation).
CREATE UNIQUE INDEX IF NOT EXISTS user_profile_username_lower_uq
  ON user_profile (lower(username))
  WHERE username IS NOT NULL;

-- Operator-extended blocklist. Same shape as the static RESERVED_USERNAMES
-- but mutable at runtime (the multisig can append banned handles via a
-- future operator endpoint without a deploy).
CREATE TABLE IF NOT EXISTS username_operator_blocklist (
  canonical    TEXT PRIMARY KEY,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason       TEXT
);
`;

interface PgUserProfileRow {
  address: string;
  username: string | null;
  username_display: string | null;
  created_at: Date;
  updated_at: Date;
  username_updated_at: Date | null;
}

function rowFromPg(r: PgUserProfileRow): UserProfileRow {
  return {
    address: r.address.toLowerCase() as `0x${string}`,
    username: r.username,
    usernameDisplay: r.username_display,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    usernameUpdatedAt: r.username_updated_at,
  };
}

export function createPgUserProfileStore(pool: Pool): UserProfileStore {
  let schemaReady: Promise<void> | null = null;

  return {
    async ensureSchema() {
      // Bugbot M PR #102 pass-10: clear `schemaReady` on rejection so a
      // transient pg blip during the first request doesn't permanently
      // poison the store. Without this, the rejected promise was cached
      // and every subsequent caller saw the same failure even after the
      // DB recovered. Mirrors the in-flight Promise pattern used by
      // `getUserProfileStore` in `index.ts`.
      if (schemaReady === null) {
        schemaReady = pool
          .query(TABLE_DDL)
          .then(() => {
            /* swallow query result */
          })
          .catch((err: unknown) => {
            schemaReady = null;
            throw err;
          });
      }
      await schemaReady;
    },
    async getByAddress(address) {
      const r = await pool.query<PgUserProfileRow>(
        `SELECT address, username, username_display, created_at, updated_at, username_updated_at
         FROM user_profile WHERE address = $1`,
        [address.toLowerCase()],
      );
      const row = r.rows[0];
      return row ? rowFromPg(row) : null;
    },
    async getByUsername(canonical) {
      const r = await pool.query<PgUserProfileRow>(
        `SELECT address, username, username_display, created_at, updated_at, username_updated_at
         FROM user_profile WHERE lower(username) = $1`,
        [canonical.toLowerCase()],
      );
      const row = r.rows[0];
      return row ? rowFromPg(row) : null;
    },
    async isUsernameTakenByOther(canonical, address) {
      const r = await pool.query(
        `SELECT address FROM user_profile
         WHERE lower(username) = $1 AND address <> $2 LIMIT 1`,
        [canonical.toLowerCase(), address.toLowerCase()],
      );
      return r.rowCount !== null && r.rowCount > 0;
    },
    async isOperatorBlocked(canonical) {
      const r = await pool.query(
        `SELECT canonical FROM username_operator_blocklist WHERE canonical = $1 LIMIT 1`,
        [canonical.toLowerCase()],
      );
      return r.rowCount !== null && r.rowCount > 0;
    },
    async upsertUsername({address, canonical, display, now, cooldownMs}) {
      // Single-statement upsert: insert if missing, otherwise update only when
      // the cooldown gate passes. Both branches re-assert that the canonical
      // handle is NOT in the operator blocklist — closing the TOCTOU gap
      // bugbot L PR #102 pass-8 caught: between `evaluateSetUsername`'s read
      // of `isOperatorBlocked` and this commit, an operator can add the
      // username to the blocklist; without the inline gate the write would
      // still succeed. The `WHERE` clauses on both INSERT-via-SELECT and the
      // UPDATE re-check the blocklist as part of the same statement.
      //
      // 0-row return is now ambiguous (blocklist OR cooldown). Disambiguate
      // with a follow-up read so the handler's exhaustive switch over
      // `UpsertUsernameError` gets the right variant.
      const lowerAddress = address.toLowerCase();
      const lowerCanonical = canonical.toLowerCase();
      const cooldownThreshold = new Date(now.getTime() - cooldownMs);
      try {
        const r = await pool.query<PgUserProfileRow>(
          `INSERT INTO user_profile (address, username, username_display, created_at, updated_at, username_updated_at)
           SELECT $1, $2, $3, $4, $4, $4
           WHERE NOT EXISTS (
             SELECT 1 FROM username_operator_blocklist WHERE canonical = $6
           )
           ON CONFLICT (address) DO UPDATE
             SET username = EXCLUDED.username,
                 username_display = EXCLUDED.username_display,
                 updated_at = EXCLUDED.updated_at,
                 username_updated_at = EXCLUDED.username_updated_at
             WHERE
               (user_profile.username_updated_at IS NULL
                OR user_profile.username_updated_at <= $5)
               AND NOT EXISTS (
                 SELECT 1 FROM username_operator_blocklist WHERE canonical = $6
               )
           RETURNING address, username, username_display, created_at, updated_at, username_updated_at`,
          [lowerAddress, canonical, display, now, cooldownThreshold, lowerCanonical],
        );
        if (r.rowCount === 0) {
          // 0 rows means EITHER the blocklist gate fired OR the cooldown
          // gate fired (on the conflict-update path). Disambiguate.
          const blockedR = await pool.query(
            `SELECT 1 FROM username_operator_blocklist WHERE canonical = $1 LIMIT 1`,
            [lowerCanonical],
          );
          if (blockedR.rowCount !== null && blockedR.rowCount > 0) {
            return {ok: false, error: "blocklisted-operator"};
          }
          return {ok: false, error: "cooldown-active"};
        }
        return {ok: true, row: rowFromPg(r.rows[0]!)};
      } catch (err) {
        // 23505 = unique_violation (the partial-unique on lower(username))
        if (isUniqueViolation(err)) return {ok: false, error: "taken"};
        throw err;
      }
    },
    async updateDisplayCase({address, display, now}) {
      const r = await pool.query<PgUserProfileRow>(
        `UPDATE user_profile
           SET username_display = $2, updated_at = $3
         WHERE address = $1 AND username IS NOT NULL
         RETURNING address, username, username_display, created_at, updated_at, username_updated_at`,
        [address.toLowerCase(), display, now],
      );
      const row = r.rows[0];
      return row ? rowFromPg(row) : null;
    },
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as {code: unknown}).code === "23505"
  );
}

// ============================================================ In-memory fake

/// Vitest fixture. Mirrors the pg impl's semantics — partial uniqueness on
/// `lower(username)`, cooldown-aware upsert, operator-blocklist read — but
/// keeps everything in maps so the test suite doesn't need a live Postgres.
/// Used by both handler tests and any integration test that doesn't care
/// about the SQL layer.
export function createInMemoryUserProfileStore(opts: {
  operatorBlockedSet?: ReadonlySet<string>;
} = {}): UserProfileStore & {
  /// Test-only seeding: insert a row directly bypassing all rules. Useful
  /// for setting up a "previous username at T-15d" cooldown scenario.
  _seed(row: UserProfileRow): void;
} {
  const byAddress = new Map<string, UserProfileRow>();
  const operatorBlocked = new Set(
    [...(opts.operatorBlockedSet ?? new Set())].map((s) => s.toLowerCase()),
  );

  return {
    async ensureSchema() {
      /* no-op */
    },
    async getByAddress(address) {
      return byAddress.get(address.toLowerCase()) ?? null;
    },
    async getByUsername(canonical) {
      const target = canonical.toLowerCase();
      for (const row of byAddress.values()) {
        if (row.username && row.username.toLowerCase() === target) return row;
      }
      return null;
    },
    async isUsernameTakenByOther(canonical, address) {
      const target = canonical.toLowerCase();
      const lowerAddress = address.toLowerCase();
      for (const row of byAddress.values()) {
        if (
          row.username &&
          row.username.toLowerCase() === target &&
          row.address.toLowerCase() !== lowerAddress
        ) {
          return true;
        }
      }
      return false;
    },
    async isOperatorBlocked(canonical) {
      return operatorBlocked.has(canonical.toLowerCase());
    },
    async upsertUsername({address, canonical, display, now, cooldownMs}) {
      const lowerAddress = address.toLowerCase() as `0x${string}`;
      const lowerCanonical = canonical.toLowerCase();
      // Mirror pg: re-assert the operator blocklist atomically with the
      // commit. Without this, the in-memory fake would silently let a
      // racing blocklist add slip past, and the handler test exercising
      // `blocklisted-operator` from the store would have no coverage.
      // (Bugbot L PR #102 pass-8.)
      if (operatorBlocked.has(lowerCanonical)) {
        return {ok: false, error: "blocklisted-operator"};
      }
      // Mirror pg uniqueness: bail before mutating if a different address
      // owns this handle.
      for (const row of byAddress.values()) {
        if (
          row.username &&
          row.username.toLowerCase() === lowerCanonical &&
          row.address.toLowerCase() !== lowerAddress
        ) {
          return {ok: false, error: "taken"};
        }
      }
      const existing = byAddress.get(lowerAddress);
      if (existing && existing.usernameUpdatedAt !== null) {
        const elapsed = now.getTime() - existing.usernameUpdatedAt.getTime();
        if (elapsed < cooldownMs) {
          return {ok: false, error: "cooldown-active"};
        }
      }
      const next: UserProfileRow = {
        address: lowerAddress,
        username: canonical,
        usernameDisplay: display,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        usernameUpdatedAt: now,
      };
      byAddress.set(lowerAddress, next);
      return {ok: true, row: next};
    },
    async updateDisplayCase({address, display, now}) {
      const lowerAddress = address.toLowerCase() as `0x${string}`;
      const existing = byAddress.get(lowerAddress);
      if (!existing || existing.username === null) return null;
      const next: UserProfileRow = {
        ...existing,
        usernameDisplay: display,
        updatedAt: now,
        // Note: usernameUpdatedAt is INTENTIONALLY left untouched — a
        // casing fix must not rev the 30-day cooldown.
      };
      byAddress.set(lowerAddress, next);
      return next;
    },
    _seed(row) {
      byAddress.set(row.address.toLowerCase(), row);
    },
  };
}
