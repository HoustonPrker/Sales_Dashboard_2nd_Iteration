"""
export_data.py — Main orchestrator for the CK Analytics nightly data export pipeline.
Phases 1-5: Reference data, Sales, Inventory, Math pipeline, Validate & promote.
"""

import os
import sys
import csv
import time
import shutil
from datetime import date, timedelta, datetime
from collections import defaultdict

import requests
from dotenv import load_dotenv

# Load .env from project root (two levels up from scripts/)
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(_ROOT, ".env"))

API_BASE = os.getenv("API_BASE", "http://172.16.20.185:8085")
API_KEY  = os.getenv("API_KEY",  "26G3t29ecBtvmGpbKOoVnql34eNYfUoy")
DATA_DIR = os.path.join(_ROOT, "data")
ARCH_DIR = os.path.join(DATA_DIR, "archive")

MIN_ROWS = {
    "CK_math_pipeline_data_new.csv": 500,
    "CK_daily_sales_new.csv":        5000,
    "CK_store_data_new.csv":         10,
}


# ------------------------------------------------------------------ #
# Logging helper                                                       #
# ------------------------------------------------------------------ #

def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


# ------------------------------------------------------------------ #
# HTTP session                                                         #
# ------------------------------------------------------------------ #

def make_session():
    s = requests.Session()
    s.headers.update({"X-Api-Key": API_KEY, "Content-Type": "application/json"})
    return s


# ------------------------------------------------------------------ #
# Generic paginator                                                    #
# ------------------------------------------------------------------ #

def get_all_pages(session, url):
    """Collect all records from a paginated GET endpoint."""
    records = []
    page = 1
    while True:
        sep = "&" if "?" in url else "?"
        resp = session.get(f"{url}{sep}page={page}", timeout=60)
        resp.raise_for_status()
        body = resp.json()
        data = body.get("data", body)
        if isinstance(data, list):
            # Records are directly in data
            page_records = data
            has_next = body.get("hasNextPage", False)
        elif isinstance(data, dict):
            # Records nested under items key, or fall back to data itself as list
            page_records = data.get("items") or []
            has_next = data.get("hasNextPage", body.get("hasNextPage", False))
        else:
            page_records = []
            has_next = False
        records.extend(page_records)
        log(f"  Pagination — page {page}, got {len(page_records)} records (hasNextPage={has_next})")
        if not has_next:
            break
        page += 1
    return records


# ------------------------------------------------------------------ #
# CSV writer helper                                                    #
# ------------------------------------------------------------------ #

def write_csv(filepath, fieldnames, rows):
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


# ================================================================== #
# Phase 1 — Reference data                                            #
# ================================================================== #

def phase1(session):
    log("Phase 1 — Fetching stores ...")

    # --- Stores ---
    stores_url = f"{API_BASE}/api/v1/Stores?pageSize=200"
    raw_stores = get_all_pages(session, stores_url)

    if raw_stores:
        log(f"Phase 1 — First raw store record: {raw_stores[0]}")

    store_rows = []
    for s in raw_stores:
        str_id  = (s.get("strId") or s.get("storeNo") or s.get("storeId")
                   or s.get("STR_ID") or s.get("id") or "")
        str_nam = (s.get("descr") or s.get("storeName") or s.get("name")
                   or s.get("STR_NAM") or s.get("description") or "")
        store_rows.append({
            "STR_ID":     str_id,
            "STR_NAM":    str_nam,
            "STORE_TYPE": "",   # backfilled in Phase 5
        })

    stores_path = os.path.join(DATA_DIR, "CK_stores.csv")
    write_csv(stores_path, ["STR_ID", "STR_NAM", "STORE_TYPE"], store_rows)

    # --- Items ---
    log("Phase 1 — Fetching items ...")
    SELLING_CATEGORIES = {
        "BABY", "BALLOONS", "COMFORT", "DRINKWARE", "ELECTRONIC",
        "FASHION", "GAMES", "GIFT BAG", "GIFTS", "GREETCARD", "HBA",
        "INSPR", "KELLILOON", "LOGOWEAR", "MENS", "NURSE", "PLUSH",
        "SEASONAL", "SNACKS", "TOYS", "WRITING"
    }
    items_url = (
        f"{API_BASE}/api/v1/items"
        f"?pageSize=200&filter=status:eq:A"
        f"&fields=itemNo,description,status,categoryCode,subcategoryCode,price1,lastCost"
    )
    raw_items = get_all_pages(session, items_url)

    items = []
    for it in raw_items:
        price1    = it.get("price1") or 0.0
        last_cost = it.get("lastCost") or 0.0
        try:
            price1    = float(price1)
            last_cost = float(last_cost)
        except (TypeError, ValueError):
            price1 = last_cost = 0.0

        margin = (price1 - last_cost) / price1 if price1 > 0 else None
        items.append({
            "itemNo":          it.get("itemNo", ""),
            "description":     it.get("description", ""),
            "status":          it.get("status", ""),
            "categoryCode":    it.get("categoryCode", ""),
            "subcategoryCode": it.get("subcategoryCode", ""),
            "price1":          price1,
            "lastCost":        last_cost,
            "MARGIN_PCT":      margin,
        })

    before_count = len(items)
    items = [
        it for it in items
        if it.get("categoryCode") in SELLING_CATEGORIES
        and str(it.get("itemNo", "")).strip() != ""
    ]
    log(f"Phase 1 — Category filter: {before_count} -> {len(items)} items "
        f"({before_count - len(items)} excluded)")

    log(f"Phase 1 — Fetched {len(store_rows)} stores, {len(items)} items")
    return store_rows, items


# ================================================================== #
# Phase 2 — Sales data (bulk fetch)                                   #
# ================================================================== #

def phase2(session, items):
    today   = date.today()
    date_90 = (today - timedelta(days=90)).isoformat()
    date_30 = (today - timedelta(days=30)).isoformat()
    date_7  = (today - timedelta(days=7)).isoformat()

    log(f"Phase 2 — Date windows: 90d={date_90}, 30d={date_30}, 7d={date_7}")

    # Build set of valid item numbers for fast lookup
    valid_items = {str(it["itemNo"]).strip() for it in items}

    # Aggregation structures
    sales_agg      = {}
    store_sales    = defaultdict(lambda: defaultdict(
        lambda: {"UNITS_SOLD_30D": 0, "REV_30D": 0.0}
    ))
    store_sales_90d = defaultdict(lambda: defaultdict(
        lambda: {"UNITS_SOLD_90D": 0, "REV_90D": 0.0}
    ))
    daily_sales = defaultdict(lambda: {"UNITS_SOLD": 0, "REVENUE": 0.0})

    def _accumulate(item_no, quantity, ext_price, dat, sid):
        if item_no not in sales_agg:
            sales_agg[item_no] = {
                "SALES_90D": 0, "SALES_30D": 0, "SALES_7D": 0,
                "REV_90D": 0.0, "REV_30D": 0.0, "REV_7D": 0.0,
            }
        ag = sales_agg[item_no]
        ag["SALES_90D"] += quantity
        ag["REV_90D"]   += ext_price
        # Always accumulate 90D store data
        store_sales_90d[item_no][sid]["UNITS_SOLD_90D"] += quantity
        store_sales_90d[item_no][sid]["REV_90D"]        += ext_price
        if dat >= date_30:
            ag["SALES_30D"] += quantity
            ag["REV_30D"]   += ext_price
            store_sales[item_no][sid]["UNITS_SOLD_30D"] += quantity
            store_sales[item_no][sid]["REV_30D"]        += ext_price
        if dat >= date_7:
            ag["SALES_7D"] += quantity
            ag["REV_7D"]   += ext_price
        daily_sales[(item_no, dat)]["UNITS_SOLD"] += quantity
        daily_sales[(item_no, dat)]["REVENUE"]    += ext_price

    # Bulk fetch all sales in 90-day window
    url = (
        f"{API_BASE}/api/v1/pos/ticket-history-lines"
        f"?filter=BusinessDate:gte:{date_90}"
        f"&pageSize=200"
        f"&fields=itemNo,storeId,quantity,extPrice,businessDate"
    )
    page        = 1
    total_pages = None
    total_records = 0
    skipped = 0
    phase2_start = time.time()

    def _progress_bar(current, total, elapsed):
        pct   = current / total if total else 0
        filled = int(40 * pct)
        bar   = "█" * filled + "░" * (40 - filled)
        eta   = ""
        if pct > 0:
            remaining = elapsed / pct * (1 - pct)
            m, s = divmod(int(remaining), 60)
            eta = f"  ETA {m}m{s:02d}s"
        elapsed_str = f"{int(elapsed//60)}m{int(elapsed%60):02d}s"
        print(f"\r  [{bar}] {pct*100:5.1f}%  page {current}/{total}  elapsed {elapsed_str}{eta}",
              end="", flush=True)

    while True:
        resp = None
        for attempt in range(3):
            try:
                resp = session.get(f"{url}&page={page}", timeout=(10, 20))
                resp.raise_for_status()
                break
            except Exception as e:
                log(f"Phase 2 — page {page} attempt {attempt+1} failed: {e}")
                if attempt < 2:
                    time.sleep(3)
        if resp is None or not resp.ok:
            log(f"Phase 2 — WARNING: skipping page {page} after 3 failed attempts")
            page += 1
            continue
        body = resp.json()
        records  = body.get("data", [])
        has_next = body.get("hasNextPage", False)
        if total_pages is None:
            total_pages = body.get("totalPages") or 0
        if not isinstance(records, list):
            records = []

        for rec in records:
            item_no   = str(rec.get("itemNo", "") or "").strip()
            quantity  = float(rec.get("quantity", 0) or 0)
            ext_price = float(rec.get("extPrice", 0) or 0)
            dat       = str(rec.get("businessDate", "") or "")[:10]
            sid       = str(rec.get("storeId", "") or "")

            if item_no not in valid_items:
                skipped += 1
                continue

            _accumulate(item_no, quantity, ext_price, dat, sid)
            total_records += 1

        if total_pages:
            _progress_bar(page, total_pages, time.time() - phase2_start)

        if not has_next:
            print()  # newline after progress bar
            break
        page += 1

    # Write daily sales CSV
    daily_rows = []
    for (item_no, bus_dat), vals in sorted(daily_sales.items()):
        daily_rows.append({
            "ITEM_NO":   item_no,
            "POST_DATE": bus_dat,
            "QTY_SOLD":  vals["UNITS_SOLD"],
            "EXT_PRC":   round(vals["REVENUE"], 4),
        })
    write_csv(
        os.path.join(DATA_DIR, "CK_daily_sales_new.csv"),
        ["ITEM_NO", "POST_DATE", "QTY_SOLD", "EXT_PRC"],
        daily_rows,
    )

    log(f"Phase 2 — Sales complete. {page} pages, {total_records} records, {skipped} skipped")
    return sales_agg, store_sales, store_sales_90d


# ================================================================== #
# Phase 4 — Math pipeline                                             #
# ================================================================== #

def phase4(items, sales_agg):
    log("Phase 4 — Running math pipeline ...")

    # Import relative to project root
    sys.path.insert(0, _ROOT)
    import scripts.math_pipeline as mp

    ranked = mp.run_pipeline(items, sales_agg)

    write_csv(
        os.path.join(DATA_DIR, "CK_math_pipeline_data_new.csv"),
        [
            "ITEM_NO", "DESCR", "CATEGORY", "SUBCAT",
            "PRICE", "LAST_COST", "MARGIN_PCT",
            "SALES_90D", "SALES_30D", "SALES_7D",
            "REV_90D", "REV_30D", "REV_7D",
            "LOG_SALES_90D", "SUBCAT_MEAN", "SUBCAT_STD",
            "Z_SCORE", "PERCENTILE", "RANK_METHOD",
            "SUBCAT_RANK", "SUBCAT_TOTAL", "STATUS",
        ],
        ranked,
    )

    log(f"Phase 4 — Math pipeline complete. {len(ranked)} items ranked")
    return ranked


# ================================================================== #
# Phase 5a — Build CK_store_data.csv from pipeline data               #
# ================================================================== #

def phase5a(store_rows, items, sales_agg, store_sales_90d):
    log("Phase 5a — Building store summary data ...")

    # Build store aggregates from 90D per-store data
    store_stats = {}

    for item_no, stores in store_sales_90d.items():
        item_meta = next((i for i in items if i["itemNo"] == item_no), None)
        for sid, vals in stores.items():
            if sid not in store_stats:
                store_stats[sid] = {
                    "QTY_90D": 0, "REV_90D": 0.0,
                    "UNIQUE_ITEMS_90D": 0,
                    "CATEGORIES": set(),
                }
            ss = store_stats[sid]
            ss["QTY_90D"] += vals["UNITS_SOLD_90D"]
            ss["REV_90D"] += vals["REV_90D"]
            if vals["UNITS_SOLD_90D"] > 0:
                ss["UNIQUE_ITEMS_90D"] += 1
            if item_meta:
                ss["CATEGORIES"].add(item_meta.get("categoryCode", ""))

    total_90d_rev = sum(agg.get("REV_90D", 0) for agg in sales_agg.values())

    store_data_rows = []
    for s in store_rows:
        str_id  = str(s.get("STR_ID", "")).strip()
        str_nam = s.get("STR_NAM", "")
        stats   = store_stats.get(str_id, {})

        qty_90d  = round(stats.get("QTY_90D", 0))
        rev_90d  = round(stats.get("REV_90D", 0.0), 2)
        unique   = stats.get("UNIQUE_ITEMS_90D", 0)
        cats     = len(stats.get("CATEGORIES", set()))
        annual   = round(rev_90d * 4, 2)
        pct      = round(rev_90d / total_90d_rev * 100, 1) if total_90d_rev > 0 else 0

        store_data_rows.append({
            "STR_ID":           str_id,
            "STORE_NAME":       str_nam,
            "CITY":             s.get("city",  s.get("CITY",  "")),
            "STATE":            s.get("state", s.get("STATE", "")),
            "STORE_TIER":       "",   # backfilled below
            "ANNUAL_REVENUE":   annual,
            "QTY_90D":          qty_90d,
            "AMT_90D":          rev_90d,
            "TXN_90D":          0,    # not tracked in current pipeline
            "UNIQUE_ITEMS_90D": unique,
            "CATEGORIES_SOLD":  cats,
            "PCT_RECENT":       pct,
            "QTY_ON_HND":       0,    # requires inventory endpoint (503)
            "QTY_AVAIL":        0,
            "ITEMS_STOCKED":    0,
        })

    if store_rows:
        log(f"Phase 5a — Sample store fields: {list(store_rows[0].keys())}")

    # Backfill STORE_TIER — top third HIGH, middle MEDIUM, bottom LOW by AMT_90D
    sorted_stores = sorted(store_data_rows, key=lambda x: x["AMT_90D"], reverse=True)
    n = len(sorted_stores)
    for rank, row in enumerate(sorted_stores):
        frac = rank / n if n > 0 else 0
        if frac < 1/3:
            row["STORE_TIER"] = "HIGH"
        elif frac < 2/3:
            row["STORE_TIER"] = "MEDIUM"
        else:
            row["STORE_TIER"] = "LOW"

    write_csv(
        os.path.join(DATA_DIR, "CK_store_data_new.csv"),
        ["STR_ID", "STORE_NAME", "CITY", "STATE", "STORE_TIER",
         "ANNUAL_REVENUE", "QTY_90D", "AMT_90D", "TXN_90D",
         "UNIQUE_ITEMS_90D", "CATEGORIES_SOLD", "PCT_RECENT",
         "QTY_ON_HND", "QTY_AVAIL", "ITEMS_STOCKED"],
        store_data_rows,
    )
    log(f"Phase 5a — Store data written. {len(store_data_rows)} stores.")
    return store_data_rows


# ================================================================== #
# Phase 5 — Validate and promote                                      #
# ================================================================== #

def phase5(store_rows):
    log("Phase 5 — Validating ...")

    # --- Validate ---
    sys.path.insert(0, _ROOT)
    import scripts.validate as val
    ok, failures = val.validate(DATA_DIR, MIN_ROWS)

    today_str = date.today().isoformat()

    if ok:
        # Count rows
        row_counts = {}
        for fname in MIN_ROWS:
            p = os.path.join(DATA_DIR, fname)
            with open(p, encoding="utf-8-sig") as f:
                row_counts[fname] = sum(1 for _ in f) - 1

        # Archive + promote
        promotions = {
            "CK_math_pipeline_data_new.csv": "CK_math_pipeline_data.csv",
            "CK_daily_sales_new.csv":        "CK_daily_sales.csv",
            "CK_store_data_new.csv":         "CK_store_data.csv",
        }
        os.makedirs(ARCH_DIR, exist_ok=True)
        for new_name, live_name in promotions.items():
            live_path = os.path.join(DATA_DIR, live_name)
            new_path  = os.path.join(DATA_DIR, new_name)
            if os.path.isfile(live_path):
                base, ext = os.path.splitext(live_name)
                arch_path = os.path.join(ARCH_DIR, f"{base}_{today_str}{ext}")
                shutil.copy2(live_path, arch_path)
                log(f"Phase 5 — Archived {live_name} -> archive/{base}_{today_str}{ext}")
            shutil.move(new_path, live_path)
            log(f"Phase 5 — Promoted {new_name} -> {live_name} ({row_counts[new_name]:,} rows)")

        log("Phase 5 — Validation passed. All files promoted.")
    else:
        for fname in MIN_ROWS:
            p = os.path.join(DATA_DIR, fname)
            if os.path.isfile(p):
                os.remove(p)
        log("Phase 5 — VALIDATION FAILED. Details:")
        for fname, info in failures.items():
            expected = info.get("expected", "?")
            actual   = info.get("actual",   "?")
            err      = info.get("error",    "")
            log(f"  {fname}: expected>={expected}, actual={actual}"
                + (f", error={err}" if err else ""))
        sys.exit(1)


# ================================================================== #
# Entry point                                                          #
# ================================================================== #

def main():
    t_start = time.time()
    log("Export pipeline starting ...")

    session = make_session()

    store_rows, items                       = phase1(session)
    sales_agg, store_sales, store_sales_90d = phase2(session, items)
    phase4(items, sales_agg)
    phase5a(store_rows, items, sales_agg, store_sales_90d)
    phase5(store_rows)

    elapsed = time.time() - t_start
    mins    = int(elapsed // 60)
    secs    = int(elapsed % 60)
    log(f"Export complete in {mins}m {secs}s")


if __name__ == "__main__":
    main()
