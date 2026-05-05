"""
validate.py — Validation module for the CK Analytics export pipeline.
"""

import os
import csv


REQUIRED_COLUMNS = {
    "CK_math_pipeline_data_new.csv": [
        "ITEM_NO", "DESCR", "CATEGORY", "SUBCAT",
        "PERCENTILE", "RANK_METHOD", "SUBCAT_RANK", "SUBCAT_TOTAL",
    ],
    "CK_store_inventory_new.csv": [
        "ITEM_NO", "STR_ID", "QTY_ON_HAND", "QTY_AVAILABLE",
    ],
    "CK_daily_sales_new.csv": [
        "ITEM_NO", "POST_DATE", "QTY_SOLD", "EXT_PRC",
    ],
}


def validate(data_dir, min_rows):
    """
    Validate all _new CSV files.

    Parameters
    ----------
    data_dir : str   Path to the data directory
    min_rows : dict  {filename: minimum_row_count}

    Returns
    -------
    (True, {})                          if all files pass
    (False, {filename: {expected, actual}})  for failures
    """
    failures = {}

    for filename, threshold in min_rows.items():
        filepath = os.path.join(data_dir, filename)

        # --- existence check ---
        if not os.path.isfile(filepath):
            failures[filename] = {"expected": threshold, "actual": 0, "error": "file not found"}
            continue

        # --- read CSV ---
        try:
            with open(filepath, encoding="utf-8-sig", newline="") as f:
                reader = csv.DictReader(f)
                headers = reader.fieldnames or []
                rows = list(reader)
        except Exception as e:
            failures[filename] = {"expected": threshold, "actual": 0, "error": str(e)}
            continue

        actual = len(rows)

        # --- column check ---
        required = REQUIRED_COLUMNS.get(filename, [])
        missing_cols = [c for c in required if c not in headers]
        if missing_cols:
            failures[filename] = {
                "expected": threshold,
                "actual": actual,
                "error": f"missing columns: {missing_cols}",
            }
            continue

        # --- row count check ---
        if actual < threshold:
            failures[filename] = {"expected": threshold, "actual": actual}

    if failures:
        return False, failures
    return True, {}
