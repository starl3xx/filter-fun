# HP Scoring Weights — Off-chain Model + Verification

filter.fun's HP score combines six on-chain signals into a single integer in `[0, 10000]`
(Epic 1.18 / spec §6.5 — bumped from `[0, 1]` to integer-stored to align with the BPS
convention used elsewhere in the protocol). Epic 1.22 (2026-05-04) locks the per-component
formulas + their named parameter constants and switches normalization from cohort-relative
percentile to fixed-reference per spec §6.7. This page documents **where the weights and
formula constants live, how to verify what's currently active, and the procedure for
changing either**.

> **Spec refs**: §6.4.x (per-component formula lock), §6.5 (locked weights + composite
> scale + tie-break), §6.7 (fixed-reference normalization), §6.9 (slot-fairness),
> §6.10 (cohort-edge tie-break), §6.12 (reorg/finality), §6.13 (test fixture coverage),
> §6.4.5 (momentum gate), §41 (holder concentration), §42.2.6 (oracle authority invariant).

> **Audience**: external auditors, traders verifying composite math, operators reviewing
> a proposed weight update.

---

## 1. Where the weights live (and why)

**Off-chain.** The active weight set is committed in
[`packages/scoring/src/types.ts`](https://github.com/starl3xx/filter-fun/blob/main/packages/scoring/src/types.ts)
as `LOCKED_WEIGHTS`. Contracts NEVER read these values — `SeasonVault.cut()` and
`SeasonVault.submitWinner()` consume the **oracle-published Merkle root of rankings**
instead. This is a deliberate design lock dated 2026-05-03 (spec §6.5; composite-scale
amendment dated 2026-05-05) and preserves the §42.2.6 oracle-authority invariant: the
only privileged input the contracts trust is the oracle-signed root, not the
per-component coefficients.

**Implication for trust.** A weight change is enforceable only if the oracle reposts a
new Merkle root that ranks tokens under the new weights. Contracts can't validate
"these weights are correct"; they only validate "this root was signed by the oracle."
External auditors should monitor the oracle's public log of {weight version → root
hash → block} commitments to detect drift.

---

## 2. The active set (`HP_WEIGHTS_VERSION = "2026-05-04-v4-locked-int10k-formulas"`)

> **Epic 1.22 changes** (2026-05-04 amendment): per-component formulas locked into named
> constants, normalization switched from cohort-percentile to fixed-reference (§6.7),
> slot-fairness ageFactor added to retention + sticky-liquidity (§6.9), three-tier tie-break
> (§6.10), `hpSnapshot.finality` column added (§6.12), parameterized fixture suite shipped
> (§6.13). The §6.5 weight values themselves are **unchanged** under this lock.

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

### Composite scale + tie-break (Epic 1.18, 2026-05-05)

- **Composite scale**: integer in `[0, 10000]`. Scoring computes
  `Math.round(weighted_sum × 10000)` (round-half-up); Track E's Python pipeline
  mirrors this with `int(weighted_sum × 10000 + 0.5)`. Same effective resolution as
  the prior float `[0, 1]` with two decimal places, but cleaner storage (integer
  column) and aligned to the BPS convention used in §9.2 / §9.4 / §11.1 / §41.4 (HHI).
- **Tie-break**: when two tokens land on the exact-same integer HP, the
  earlier-launched (`token.createdAt`) wins. Earlier-launched-wins because longevity
  is a weak legitimacy signal and the choice is public, predictable, and
  contract-immaterial (the on-chain settlement reads the oracle-posted Merkle root,
  not HP values directly). Without the secondary key, ties would resolve by whatever
  order `Array.sort` produced from the input — fine for replays, ambiguous when the
  indexer reads cohorts back from the DB in a different order.

Provenance constants:

- `HP_WEIGHTS_VERSION = "2026-05-04-v4-locked-int10k-formulas"` — stamped on every `hpSnapshot` row.
- `HP_WEIGHTS_ACTIVATED_AT = "2026-05-11T00:00:00Z"` — wall-clock activation.
- `HP_WEIGHTS_SPEC_REF` — anchor to the spec §6.5 entry that authored this set.
- `HP_COMPOSITE_SCALE = {min: 0, max: 10000, type: "integer"}` — surfaced on
  `/scoring/weights` so clients gating on absolute thresholds can read the scale
  rather than hardcoding it.

### Validation status

| Run | Cohort | n | LOCKED ρ vs FDV | Outcome |
|---|---|---:|---:|---|
| Track E v4 main corpus | stratified 50/50 (Clanker V4) | 100 | — (composite signal; L2 fit) | Authored the lock |
| Track E v4 validation cohort | random-sample → FDV | 7 | +0.32 (p=0.48) | Inconclusive — too small |
| Track E v5 validation cohort (percentile) | liquidity-first → FDV (top-50/platform) | 43 | +0.364 (p=0.016) | Validated at α=0.05 |
| **Track E v5 formula-lock refit (fixed-reference)** | **same cohort, Epic 1.22 lock** | **43** | **+0.421 (p=0.0049)** | **Validated; +0.057 above pre-lock baseline** |

The fixed-reference refit (Epic 1.22) is documented in
[`track-e/REPORT_v5_formula_lock.md`](../track-e/REPORT_v5_formula_lock.md).
Per the dispatch's `+0.36 ± 0.10` tolerance band the refit passes
comfortably; per-component contributions break down as
velocity ρ=+0.40, effectiveBuyers ρ=+0.32, stickyLiquidity ρ=+0.25.

---

## 3. How to verify what's live

```sh
curl -s https://api.filter.fun/scoring/weights | jq
```

The endpoint returns:

```json
{
  "version": "2026-05-04-v4-locked-int10k-formulas",
  "specRef": "https://github.com/starl3xx/filter-fun/blob/main/filter_fun_comprehensive_spec.md#65-hp-component-weights-locked-2026-05-03-per-track-e-v4",
  "activatedAt": "2026-05-11T00:00:00Z",
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
  "phaseDifferentiation": false,
  "compositeScale": {"min": 0, "max": 10000, "type": "integer"},
  "constants": {
    "VELOCITY_LOOKBACK_SEC": 345600,
    "VELOCITY_DECAY_HALFLIFE_SEC": 86400,
    "VELOCITY_PER_WALLET_CAP_WETH": 10,
    "VELOCITY_CHURN_WINDOW_SEC": 3600,
    "VELOCITY_CHURN_PENALTY_FACTOR": 2,
    "EFFECTIVE_BUYERS_LOOKBACK_SEC": 345600,
    "EFFECTIVE_BUYERS_DUST_WETH": 0.001,
    "LP_PENALTY_WINDOW_SEC": 86400,
    "LP_PENALTY_TAU_SEC": 21600,
    "RETENTION_DUST_SUPPLY_FRAC": 0.0001,
    "VELOCITY_REFERENCE": 1115.451,
    "EFFECTIVE_BUYERS_REFERENCE": 191.129,
    "STICKY_LIQUIDITY_REFERENCE": 67.275
  }
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
4. `constants` (Epic 1.22) — every parameter the locked formulas read. Cross-check against
   `packages/scoring/src/constants.ts`. Any drift means the indexer is running stale code.
   The `*_REFERENCE` values are calibrated from the v5 cohort 90th percentile per §6.7;
   re-calibration follows the same procedure as a weight change (§5 below).

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

## 5b. Formula-constant change procedure (Epic 1.22)

The §6.4.x formulas reference named parameter constants (`VELOCITY_DECAY_HALFLIFE_SEC`,
`VELOCITY_PER_WALLET_CAP_WETH`, `*_REFERENCE`, etc.). These constants are not weights,
but they shape the same composite — a re-tune of `VELOCITY_REFERENCE` shifts every
token's velocity score. **Constant changes follow the same procedure as weight changes
(§5).** The only divergences:

- **Empirical justification.** Re-run the Track E formula-lock refit
  (`track-e/REPORT_v5_formula_lock.md`) under the proposed constants and report the
  new Spearman ρ vs FDV. The dispatch tolerance band (`+0.36 ± 0.10`) applies; an
  out-of-band result requires per-component investigation before the spec amendment.
- **Spec amendment** updates §6.4.x or §6.7 (whichever section the constant appears in)
  rather than §6.5. The `HP_WEIGHTS_VERSION` string still bumps — the indexer's
  per-row stamp is what auditors use to bind a row to its constants set, and a
  silent constant change without a version bump would break that contract.
- **Code change** updates `packages/scoring/src/constants.ts` (single source of truth
  for the formula bodies) plus the `HP_WEIGHTS_VERSION` in `types.ts`.

The `/scoring/weights` endpoint exposes the active constants under `response.constants`
so an external auditor can fetch the live engine's parameters without checking out the
repo. Any drift between `response.constants` and the values cited in the spec amendment
is a deploy bug, not a spec ambiguity.

### Constants reference (locked at `2026-05-04-v4-locked-int10k-formulas`)

| Constant | Value | Section | Effect |
|---|---:|---|---|
| `VELOCITY_LOOKBACK_SEC` | 345 600 (96h) | §6.4.1 | Hard window for velocity event filter |
| `VELOCITY_DECAY_HALFLIFE_SEC` | 86 400 (24h) | §6.4.1 | Per-event time-decay half-life |
| `VELOCITY_PER_WALLET_CAP_WETH` | 10 | §6.4.1 | Single-wallet contribution cap (whale guard) |
| `VELOCITY_CHURN_PENALTY_FACTOR` | 2 | §6.4.1 | Net-buy clamp; gross-without-net penalty |
| `VELOCITY_REFERENCE` | 1115.451 | §6.7 | Fixed-reference normalizer (90th p of v5) |
| `EFFECTIVE_BUYERS_DUST_WETH` | 0.001 | §6.4.2 | Min spend to count as a real buyer |
| `EFFECTIVE_BUYERS_REFERENCE` | 191.129 | §6.7 | Fixed-reference normalizer |
| `LP_PENALTY_WINDOW_SEC` | 86 400 (24h) | §6.4.3 | Sticky-liquidity LP-removal penalty window |
| `LP_PENALTY_TAU_SEC` | 21 600 (6h) | §6.4.3 | Penalty exponential half-life |
| `STICKY_LIQUIDITY_REFERENCE` | 67.275 | §6.7 | Fixed-reference normalizer |
| `RETENTION_DUST_SUPPLY_FRAC` | 0.0001 | §6.4.4 | Min holder share for retention denominator |
| `SLOT_AGE_FACTOR_WINDOW_SEC` | 21 600 (6h) | §6.9 | Slot-fairness observed-vs-age window |
| `SETTLEMENT_FINALITY_BLOCKS` | 12 | §6.12 | CUT/FINALIZE wait before snapshot insert |

A future re-calibration of the `*_REFERENCE` constants requires re-running the refit
and confirming ρ stays in the band; the constants are versioned with the engine, not
inferred from each fresh cohort.

---

## 6. Anatomy of an `hpSnapshot` row

Every periodic snapshot the indexer writes carries enough provenance to be
re-derivable:

| Field | Source | Notes |
|---|---|---|
| `hp` | `score().hp` | Integer in `[0, 10000]` (Epic 1.18). Pre-1.18 was 0-100. |
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
- `packages/scoring/src/constants.ts` — formula-parameter constants (Epic 1.22);
  `FORMULA_CONSTANTS` bundle exposed via `/scoring/weights`.
- `packages/scoring/src/score.ts` — `score()` entry point; component raw helpers
  (`computeVelocityRaw`, `computeEffectiveBuyersRaw`, `computeStickyLiquidityRaw`).
- `packages/scoring/src/components.ts` — `computeHolderConcentration`,
  `computeMomentumComponent` (spy-able for gate tests).
- `packages/scoring/test/fixtures/` — parameterized fixture suite (Epic 1.22 §6.13);
  ≥5 per component + 10 composite, runner at `runFixtures.test.ts`.
- `packages/indexer/src/api/scoringWeights.ts` — `/scoring/weights` handler;
  populates `response.constants` from `FORMULA_CONSTANTS`.
- `packages/scoring/test/v4_lock_smoke.test.ts` — reference tests pinning v4 behavior.
- `track-e/REPORT.md` — Track E v4 final report; source of the locked coefficients.
- `track-e/REPORT_v5_validation.md` — v5 cohort validation under percentile rank.
- `track-e/REPORT_v5_formula_lock.md` — Epic 1.22 refit under fixed-reference
  normalization (ρ = +0.4212, p=0.0049, n=43).
