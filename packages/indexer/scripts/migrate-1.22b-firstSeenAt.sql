-- Epic 1.22b — backfill `holder_balance.first_seen_at` (2026-05-04+).
--
-- The schema added a `first_seen_at` column with a default of 0. The HP
-- scoring projection's retention component uses `firstSeenAt ≤ now − 24h`
-- to approximate the long anchor. A row with `first_seen_at = 0` looks
-- like "first seen at the unix epoch" — which puts every legacy holder in
-- the long anchor unconditionally, slightly overstating retention for the
-- first 24h post-deploy.
--
-- Cleanest cutover: backfill `first_seen_at = block_timestamp` on every
-- pre-1.22b row. The block_timestamp recorded on the row is the timestamp
-- of the most recent transfer that touched the (token, holder) — the best
-- approximation we have without replaying the chain. This is "the wallet
-- has held this token at least since `block_timestamp`," which is the
-- same shape a fresh row gets when it's inserted post-1.22b.
--
-- Run order during the indexer redeploy:
--   1. Stop the indexer.
--   2. `psql -f migrate-1.22b-firstSeenAt.sql` against the indexer Postgres.
--   3. Verify `select count(*) from holder_balance where first_seen_at = 0` == 0.
--   4. Restart the indexer.
--
-- This is non-destructive (UPDATE only, no schema changes — Drizzle will
-- have already added the column with default 0). Idempotent: re-running
-- on a clean DB is a no-op.
--
-- Mainnet ships clean from this version, so the migration is a Sepolia /
-- staging concern only.

BEGIN;

UPDATE holder_balance
SET first_seen_at = block_timestamp
WHERE first_seen_at = 0;

DO $$
DECLARE
  remaining bigint;
BEGIN
  SELECT count(*) INTO remaining FROM holder_balance WHERE first_seen_at = 0;
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'migrate-1.22b-firstSeenAt.sql: % rows still have first_seen_at = 0 (block_timestamp also zero?)', remaining;
  END IF;
END $$;

COMMIT;
