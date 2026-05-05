"""
math_pipeline.py — Pure Python math, no API calls.
Called as a module function from export_data.py.
"""

import math
from scipy import stats


def run_pipeline(items, sales_agg):
    """
    Parameters
    ----------
    items      : list of dicts from Phase 1
                 keys: itemNo, description, status, categoryCode,
                       subcategoryCode, price1, lastCost, MARGIN_PCT
    sales_agg  : dict keyed by itemNo ->
                 {SALES_90D, SALES_30D, SALES_7D, REV_90D, REV_30D, REV_7D}

    Returns
    -------
    list of dicts with all output columns
    """

    # ------------------------------------------------------------------ #
    # 1. Attach sales aggregates and compute LOG_SALES_90D                #
    # ------------------------------------------------------------------ #
    enriched = []
    for item in items:
        key = item["itemNo"]
        agg = sales_agg.get(key, {
            "SALES_90D": 0, "SALES_30D": 0, "SALES_7D": 0,
            "REV_90D": 0.0, "REV_30D": 0.0, "REV_7D": 0.0,
        })
        sales_90d = agg.get("SALES_90D", 0) or 0
        log_sales = math.log(sales_90d + 1) if sales_90d > 0 else 0.0

        enriched.append({
            "ITEM_NO":       key,
            "DESCR":         item.get("description", ""),
            "CATEGORY":      item.get("categoryCode", ""),
            "SUBCAT":        item.get("subcategoryCode", ""),
            "PRICE":         item.get("price1", None),
            "LAST_COST":     item.get("lastCost", None),
            "MARGIN_PCT":    item.get("MARGIN_PCT", None),
            "SALES_90D":     sales_90d,
            "SALES_30D":     agg.get("SALES_30D", 0),
            "SALES_7D":      agg.get("SALES_7D", 0),
            "REV_90D":       agg.get("REV_90D", 0.0),
            "REV_30D":       agg.get("REV_30D", 0.0),
            "REV_7D":        agg.get("REV_7D", 0.0),
            "LOG_SALES_90D": log_sales,
            "STATUS":        "ACTIVE" if item.get("status") == "A" else "INACTIVE",
            # filled below
            "SUBCAT_MEAN":   None,
            "SUBCAT_STD":    None,
            "Z_SCORE":       None,
            "PERCENTILE":    None,
            "RANK_METHOD":   None,
            "SUBCAT_RANK":   None,
            "SUBCAT_TOTAL":  None,
        })

    # ------------------------------------------------------------------ #
    # 2. Group by subcategoryCode                                          #
    # ------------------------------------------------------------------ #
    from collections import defaultdict
    subcat_groups = defaultdict(list)
    for row in enriched:
        subcat_groups[row["SUBCAT"]].append(row)

    # ------------------------------------------------------------------ #
    # 3. Rank within each subcategory group                               #
    # ------------------------------------------------------------------ #
    for subcat, group in subcat_groups.items():
        n = len(group)
        log_vals = [r["LOG_SALES_90D"] for r in group]
        mean_log = sum(log_vals) / n if n > 0 else 0.0
        std_log = (
            math.sqrt(sum((v - mean_log) ** 2 for v in log_vals) / n)
            if n > 1 else 0.0
        )

        for r in group:
            r["SUBCAT_TOTAL"] = n
            r["SUBCAT_MEAN"] = mean_log
            r["SUBCAT_STD"] = std_log

        # Determine rank method
        if n < 3:
            rank_method = "QTY-RANK"
        elif n > 5000:
            rank_method = "EMPIRICAL"
        else:
            try:
                _, p_value = stats.shapiro(log_vals)
                rank_method = "Z-SCORE" if p_value > 0.05 else "EMPIRICAL"
            except Exception:
                rank_method = "EMPIRICAL"

        if rank_method == "Z-SCORE":
            for r in group:
                z = (r["LOG_SALES_90D"] - mean_log) / std_log if std_log > 0 else 0.0
                r["Z_SCORE"] = z
                r["PERCENTILE"] = float(stats.norm.cdf(z))
                r["RANK_METHOD"] = "Z-SCORE"
        else:
            # EMPIRICAL or QTY-RANK — percentile by rank / count
            sorted_group = sorted(group, key=lambda r: r["SALES_90D"])
            for rank_0, r in enumerate(sorted_group):
                r["PERCENTILE"] = (rank_0 + 1) / n
                r["Z_SCORE"] = None
                r["RANK_METHOD"] = rank_method

        # SUBCAT_RANK: 1 = highest performer (highest PERCENTILE)
        ranked = sorted(group, key=lambda r: r["PERCENTILE"], reverse=True)
        for rank_1, r in enumerate(ranked):
            r["SUBCAT_RANK"] = rank_1 + 1

    return enriched
