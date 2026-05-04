-- Epic 1.18 — composite-HP integer-scale cutover (2026-05-05).
--
-- The HP composite scale flipped from float [0, 100] to integer [0, 10000]
-- (spec §6.5 "Composite scale + tie-break"). The hp_snapshot.hp column was
-- already declared as `integer` in ponder.schema.ts — what changed is the
-- value range and the `weights_version` stamp. Existing rows on Sepolia
-- still encode the prior 0-100 wire format; rather than multiply them by
-- 100 (which would introduce a synthetic precision they don't have), we
-- drop them. Mainnet ships clean from the int10k cutover.
--
-- Run order during the indexer redeploy:
--   1. `psql -f migrate-int10k.sql` against the indexer Postgres
--   2. Restart the indexer (it will repopulate hp_snapshot from genesis
--      blocks via the BLOCK_TICK / SWAP / HOLDER_SNAPSHOT handlers)
--   3. Verify `select count(*) from hp_snapshot where weights_version != '2026-05-04-v4-locked-int10k-formulas'` == 0
--
-- Rollback: there is no clean rollback for the value-range change. To
-- revert, restore from the pre-migration backup the operator runbook
-- captures before any destructive migration. Code-side, the prior
-- `hpAsInt100` builder + `HP_WEIGHTS_VERSION = "2026-05-03-v4-locked"`
-- constants are recoverable from git (commit before this PR).

BEGIN;

-- Drop pre-1.18 rows. The schema column type stays the same; only the
-- semantic range changes, so a TRUNCATE is sufficient. We DON'T drop the
-- column itself or alter its type.
TRUNCATE TABLE hp_snapshot;

-- Sanity-check that the table is empty before commit. Postgres will roll
-- back the transaction if this fails, and the operator sees an explicit
-- error rather than silently shipping a half-migrated state.
DO $$
DECLARE
  remaining bigint;
BEGIN
  SELECT count(*) INTO remaining FROM hp_snapshot;
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'migrate-int10k.sql: hp_snapshot still has % rows after TRUNCATE', remaining;
  END IF;
END $$;

COMMIT;
