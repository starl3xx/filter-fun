# HP Scoring Weights — Off-chain Model + Verification

filter.fun's HP score combines six on-chain signals into a single 0–1 number. This page
documents **where the weights live, how to verify what's currently active, and the
procedure for changing them**.

> **Spec refs**: §6.4 (per-component definitions), §6.5 (locked weights), §6.4.5
> (momentum gate), §41 (holder concentration), §42.2.6 (oracle authority invariant).

> **Audience**: external auditors, traders verifying composite math, operators reviewing
> a proposed weight update.

---

## 1. Where the weights live (and why)

**Off-chain.** The active weight set is committed in
[`packages/scoring/src/types.ts`](https://github.com/starl3xx/filter-fun/blob/main/packages/scoring/src/types.ts)
as `LOCKED_WEIGHTS`. Contracts NEVER read these values — `SeasonVault.cut()` and
`SeasonVault.submitWinner()` consume the **oracle-published Merkle root of rankings**
instead. This is a deliberate design lock dated 2026-05-03 (spec §6.5) and preserves
the §42.2.6 oracle-authority invariant: the only privileged input the contracts trust is
the oracle-signed root, not the per-component coefficients.

**Implication for trust.** A weight change is enforceable only if the oracle reposts a
new Merkle root that ranks tokens under the new weights. Contracts can't validate
"these weights are correct"; they only validate "this root was signed by the oracle."
External auditors should monitor the oracle's public log of {weight version → root
hash → block} commitments to detect drift.

---

## 2. The active set (`HP_WEIGHTS_VERSION = "2026-05-03-v4-locked"`)

| Component | Coefficient | Plain English |
|---|---:|---|
| `velocity` | 0.30 | Decayed net buy inflow with sybil dampening + churn discount |
| `effectiveBuyers` | 0.15 | sqrt-dampened headcount of meaningful buyers |
| `stickyLiquidity` | 0.30 | Time-weighted LP depth penalised by recent withdrawals |
| `retention` | 0.15 | Two-anchor (long + short) holder retention fraction |
| `momentum` | 0.00 | Recent base-composite delta. **Disabled in v4** — coefficient zeroed and the `HP_MOMENTUM_ENABLED` flag defaults to `false`. |
| `holderConcentration` | 0.10 | HHI-mapped holder distribution (lower HHI → higher score) |

Sum: 1.00 exactly. No per-phase differentiation in v4 — both `preFilter` and `finals`
resolve to this single set. (The phase API survives as a thin wrapper so a future v5 can
revive per-phase weights without an indexer/oracle/web refactor.)

Provenance constants:

- `HP_WEIGHTS_VERSION = "2026-05-03-v4-locked"` — stamped on every `hpSnapshot` row.
- `HP_WEIGHTS_ACTIVATED_AT = "2026-05-03T00:00:00Z"` — wall-clock activation.
- `HP_WEIGHTS_SPEC_REF` — anchor to the spec §6.5 entry that authored this set.

### Validation status

| Run | Cohort | n | LOCKED ρ vs FDV | Outcome |
|---|---|---:|---:|---|
| Track E v4 main corpus | stratified 50/50 (Clanker V4) | 100 | — (composite signal; L2 fit) | Authored the lock |
| Track E v4 validation cohort | random-sample → FDV | 7 | +0.32 (p=0.48) | Inconclusive — too small |
| **Track E v5 validation cohort** | **liquidity-first → FDV (top-50/platform)** | **43** | **+0.364 (p=0.016)** | **Validated at α=0.05** |

The pre-v4 spec defaults (momentum=10%) edge LOCKED by Δρ≈0.045 on
the v5 cohort (ρ=+0.409, p=0.006 at n=43). LOCKED is
**validated, with momentum's drop flagged as the most fragile call in
§6.5** for post-mainnet refit. See `track-e/REPORT_v5_validation.md`
for the full analysis and v6 follow-up list.

---

## 3. How to verify what's live

```sh
curl -s https://api.filter.fun/scoring/weights | jq
```

The endpoint returns:

```json
{
  "version": "2026-05-03-v4-locked",
  "specRef": "https://github.com/starl3xx/filter-fun/blob/main/filter_fun_comprehensive_spec.md#65-hp-component-weights-locked-2026-05-03-per-track-e-v4",
  "activatedAt": "2026-05-03T00:00:00Z",
  "weights": {
    "velocity": 0.30,
    "effectiveBuyers": 0.15,
    "stickyLiquidity": 0.30,
    "retention": 0.15,
    "momentum": 0.00,
    "holderConcentration": 0.10
  },
  "flags": {
    "HP_MOMENTUM_ENABLED": false,
    "HP_CONCENTRATION_ENABLED": true
  },
  "phaseDifferentiation": false
}
```

**What to check:**

1. `version` — matches the version stamped on recent `hpSnapshot` rows. A mismatch
   indicates the indexer was redeployed without bumping the constant, or a row was
   written under a stale version.
2. `weights` sums to 1.0 exactly (under floating-point tolerance) and matches the
   spec §6.5 entry referenced by `specRef`.
3. `flags` reflects env-override state. The defaults (`momentum:false,
   concentration:true`) match v4; any deviation is itself a published change subject to
   the same notice procedure as a weight update.

**Cross-check against snapshot rows:**

```sh
psql $INDEXER_DATABASE_URL -c "
  SELECT weights_version, flags_active, COUNT(*)
  FROM hp_snapshot
  WHERE snapshot_at_sec > extract(epoch from now() - interval '1 hour')
  GROUP BY 1, 2;
"
```

Every row from the last hour should be tagged with the live version and the live
flag bundle. Rows tagged `pre-lock` are pre-Epic-1.17a; they cannot be retroactively
assigned a real version.

---

## 4. Feature flags

Two env-readable flags gate component activation independently of the weight values.
This is intentional: a future flag flip (e.g. re-enabling momentum after a Track E v5
study) shouldn't require a code release if the spec amendment is already published.

| Flag | Default | Effect |
|---|---|---|
| `HP_MOMENTUM_ENABLED` | `false` | When `false`, momentum component returns `0` unconditionally and the compute path is skipped (verified via test spy). When `true`, momentum is computed against `priorBaseComposite` and clipped to `momentumCap`. |
| `HP_CONCENTRATION_ENABLED` | `true` | When `false`, holderConcentration returns `0` and the remaining five weights renormalize to sum to 1.0 (preserves HP ∈ [0, 1]). |

Flag values are stamped per-row on `hpSnapshot.flagsActive` so historical replays can
reproduce the gating state. The renormalization path under `concentration:false` is
documented at the boundary helper `applyFlagsToWeights` in `packages/scoring/src/score.ts`.

---

## 5. Weight-update procedure

Weights are off-chain config but the contracts depend on the oracle reposting under any
new set. To change a weight:

1. **Empirical justification.** Run a Track E (or successor) analysis on a corpus of at
   least 200 tokens; report Spearman ρ + AUC vs the locked outcome label
   (`survived_to_day_7`) for the proposed change.
2. **Spec amendment.** Open a spec PR updating §6.5 with the new values, the
   justification, and the proposed `HP_WEIGHTS_VERSION` string (date-versioned). Get
   external review from at least one other operator.
3. **Public notice ≥ 7 days.** Once the spec PR is merged, post the proposed values to
   the protocol's public channel(s) ≥ 7 days before activation. The activation date is
   a hard floor — if the activation needs to slip, post the slip explicitly.
4. **Code change.** Update `LOCKED_WEIGHTS` and bump `HP_WEIGHTS_VERSION` in
   `packages/scoring/src/types.ts`. Add reference test cases in
   `packages/scoring/test/v4_lock_smoke.test.ts` (or a successor file) pinning the new
   weights' input → output behavior.
5. **Indexer redeploy.** Roll out the new indexer build at the announced activation
   time. The `/scoring/weights` endpoint and per-row `weightsVersion` stamps reflect
   the new set immediately.
6. **Oracle backfill.** The oracle's next Merkle-root post will rank under the new
   weights. Any settlement that fires after the activation block reads the new ranking.

**Hot-fix exception.** If a Track E analysis surfaces a security-relevant issue (e.g. a
component that's reliably gameable in a live cohort), the 7-day notice can collapse to
24h with operator + advisor sign-off. Document the exception in the spec amendment.

---

## 6. Anatomy of an `hpSnapshot` row

Every periodic snapshot the indexer writes carries enough provenance to be
re-derivable:

| Field | Source | Notes |
|---|---|---|
| `hp` | `score().hp × 100` | 0–100 integer |
| `velocity / effectiveBuyers / stickyLiquidity / retention / momentum` | `score().components[...].score` | 0–1 floats, pre-weighting |
| `weightsVersion` | `HP_WEIGHTS_VERSION` constant at write time | Indexed |
| `flagsActive` | JSON of `WeightFlags` at write time | `{"momentum":bool,"concentration":bool}` |
| `phase` | API phase string at write time | `launch`/`competition`/`finals`/`settled` |

> **Known gap (Epic 1.17a).** The `holderConcentration` per-component score is NOT
> stored on `hpSnapshot` rows in v1 of this lock — only the composite `hp` reflects it.
> The §6.5 design promise ("re-derive HP under hypothetical weight changes") is
> partially broken for the concentration term until a follow-up additive migration
> lands. This is tracked as a deferred line item; the workaround for auditors is to
> recompute HHI from `holder_balance` rows directly.

---

## 7. References

- `packages/scoring/src/types.ts` — `LOCKED_WEIGHTS`, `HP_WEIGHTS_VERSION`,
  `DEFAULT_FLAGS`, `flagsFromEnv`, `weightsForPhase`.
- `packages/scoring/src/score.ts` — `score()` entry point.
- `packages/scoring/src/components.ts` — `computeHolderConcentration`,
  `computeMomentumComponent` (spy-able for gate tests).
- `packages/indexer/src/api/scoringWeights.ts` — `/scoring/weights` handler.
- `packages/scoring/test/v4_lock_smoke.test.ts` — reference tests pinning v4 behavior.
- `track-e/REPORT.md` — Track E v4 final report; source of the locked coefficients.
