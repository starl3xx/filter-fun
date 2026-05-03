"""Track-E v4: shared survived_to_day_7 gate.

Single source of truth for the survival-gate semantics (bugbot #66 finding
13: previously the same `holders ≥ X AND lp ≥ Y AND vol > Z` logic was
duplicated across `pipeline.py::_recompute_survived_to_day_7`,
`marino_xcheck.py::_recompute_survival`, and inline in
`calibrate_survival.py`'s sweep loop). All three now call into here.

The gate is intentionally NOT defined inside `pipeline.py` so
`fetch_corpus.py`'s extraction-time gate (which writes the initial
`survived_to_day_7` column to the CSV) and the post-hoc recompute path
both reference the same code.
"""

from __future__ import annotations

import pandas as pd

# Public list of the raw fetcher-emitted columns the gate reads. Importers
# can use this to detect "pre-v4 corpus, no raw fields" and skip recompute.
RAW_GATE_COLUMNS = (
    "holders_at_168h",
    "lp_depth_168h_eth",
    "vol_24h_at_168h_eth",
)


def survival_mask(
    df: pd.DataFrame,
    *,
    holders_min: int,
    lp_min_eth: float,
    vol_min_eth: float,
) -> pd.Series | None:
    """Return a 0/1 Series of survived_to_day_7 derived from the raw 168h
    gate components. Returns None if the corpus is missing those columns
    (i.e. predates CACHE_SCHEMA=6) — caller decides what to do.

    Gate semantics (single source of truth — `>=` for holders/lp, strict
    `>` for vol per the original v3 design):
        holders_at_168h     >= holders_min
        lp_depth_168h_eth   >= lp_min_eth
        vol_24h_at_168h_eth >  vol_min_eth
    """
    if not all(c in df.columns for c in RAW_GATE_COLUMNS):
        return None
    h = pd.to_numeric(df["holders_at_168h"], errors="coerce").fillna(0)
    l = pd.to_numeric(df["lp_depth_168h_eth"], errors="coerce").fillna(0.0)
    v = pd.to_numeric(df["vol_24h_at_168h_eth"], errors="coerce").fillna(0.0)
    return ((h >= holders_min) & (l >= lp_min_eth) & (v > vol_min_eth)).astype(int)
