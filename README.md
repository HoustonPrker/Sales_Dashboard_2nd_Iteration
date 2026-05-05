# CK Analytics Dashboard

A full-stack analytics dashboard for Cloverkey retail operations. Provides item-level sales analysis, statistical performance ranking, category drill-downs, and store comparisons — all driven by a nightly Python export pipeline and served through a Node.js proxy.

---

## Table of Contents

- [Architecture](#architecture)
- [Data Flow](#data-flow)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Proxy Server Routes](#proxy-server-routes)
- [Frontend Views](#frontend-views)
- [Export Pipeline](#export-pipeline-scripts)
- [Statistical Engine](#statistical-engine)
- [CSV Schemas](#csv-schemas)
- [API Integration](#api-integration)
- [File Structure](#file-structure)

---

## Architecture

```
Browser (localhost:3001)
        │
        ▼
proxy.js  ──── CSV files in /data/
        │
        ▼
CK API @ 172.16.20.185:8085
```

Three layers:

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | HTML + Vanilla JS + Chart.js | 3-tab SPA — item search, category drill-down, store comparison |
| Proxy | Node.js + Express | CORS bridge, CSV caching, search, per-store aggregation |
| Data | Python pipeline | Nightly export from CK API → ranked CSVs |

---

## Data Flow

### Nightly (export_data.py)

```
Phase 1  →  Fetch stores + items from CK API
Phase 2  →  Bulk fetch 90-day ticket history lines; aggregate by item/store/day
Phase 4  →  Math pipeline: z-scores, Shapiro-Wilk normality, percentile ranking
Phase 5a →  Build per-store aggregates from 90D data
Phase 5  →  Validate CSVs → archive previous → promote _new files to live
```

### On Dashboard Load

1. Proxy serves `index.html` and static assets
2. Browser fetches `/proxy/rankings` and `/proxy/store-data` (from CSV cache)
3. Daily sales per item are loaded on demand when a user searches

### Per Item Search

```
/proxy/item/:itemNo            → item metadata
/proxy/item/:itemNo/inventory  → inventory by store (API, 503-safe)
/proxy/item/:itemNo/daily-sales → 90D daily rows from CSV
/proxy/item/:itemNo/store-sales → 30D + 90D aggregates by store
```

---

## Getting Started

### Prerequisites

- Node.js v14+
- Python 3.9+
- Access to CK API at `172.16.20.185:8085`
- A `.env` file (see below)

### Install

```bash
npm install
pip install -r requirements.txt
```

### Start the dashboard

```bash
npm start
# or on Windows:
start.bat
```

Open `http://localhost:3001` in a browser.

### Run the nightly export

```bash
python scripts/export_data.py
```

Takes approximately 60 minutes for a full 90-day pull (~4,000 pages, ~513K ticket lines). The progress bar in Phase 2 shows live % complete and ETA.

### Dev mode (auto-restart proxy on file changes)

```bash
npm run dev
```

---

## Environment Variables

File: `.env` in project root.

```bash
API_BASE_URL=http://172.16.20.185:8085
API_KEY=<your-api-key>
PROXY_PORT=3001
```

Both `proxy.js` and `scripts/export_data.py` read from this file via `dotenv`.

---

## Proxy Server Routes

All routes are prefixed `/proxy/`.

| Route | Purpose |
|---|---|
| `GET /proxy/rankings` | Full `CK_math_pipeline_data.csv` as JSON |
| `GET /proxy/store-data` | Full `CK_store_data.csv` as JSON |
| `GET /proxy/daily-sales` | Full `CK_daily_sales.csv` as JSON |
| `GET /proxy/stores` | All stores from CK API |
| `GET /proxy/categories` | All item categories from CK API |
| `GET /proxy/items` | Paginated items from CK API (filterable by category/search) |
| `GET /proxy/items/search?q=` | Fast scored search by item # or name (CSV-backed) |
| `GET /proxy/item/:itemNo` | Single item metadata from CK API |
| `GET /proxy/item/:itemNo/inventory` | Inventory by store (graceful 503 fallback) |
| `GET /proxy/item/:itemNo/daily-sales` | Daily sales from CSV for 90-day window |
| `GET /proxy/item/:itemNo/ranking` | Z-score + percentile from rankings CSV |
| `GET /proxy/item/:itemNo/store-sales` | 30D + 90D sales aggregated by store |
| `GET /proxy/store/:storeId/category-sales` | 90D revenue by category for a store |

### Key proxy behaviors

- **CSV caching** — files are parsed once and reloaded only if the file's mtime changes
- **Parallel pagination** — fetches page 1, then fires remaining pages in parallel batches
- **Search scoring** — item# exact match → starts-with → name starts-with → name contains
- **503 fallback** — inventory endpoint returns empty array if CK API is unavailable

---

## Frontend Views

### Item Zoom (default tab)

Search by item number. Displays:

- **Header** — item name, category, sub-category, rank within sub-cat (e.g. "Rank 3 of 47")
- **7 KPI cards** — 90D sales, 30D sales, 7D sales, velocity, margin %, 90D profit, status
- **Rank strip** — percentile bar (green >50th, red <50th), sub-category rank, peer count
- **Charts:**
  - 90-Day Sales Trend (toggle daily/weekly, line/bar)
  - Store Stock Doughnut (stores with stock vs. without)
  - Actual vs Expected Bar (90D qty vs. quarterly average)
- **Inventory table** — per-store: 30D sales, 90D sales, on-hand, available, markdown qty, MOS

### Category Performance

- Overview: all categories sorted by 90D revenue with velocity indicators
- Bar chart (top categories) + doughnut (revenue share)
- Click a category → sub-category breakdown with accordion item lists
- Items color-coded by percentile: green >75%, yellow 25–75%, red <25%

### Store Performance

- Overview: all stores sorted by 90D revenue
- Tier filter buttons (All / Elite / High / Medium / Low)
- Bar chart (top 15 stores) + doughnut (revenue by tier) + scatter bubble (revenue vs velocity)
- Sortable table: store #, name, city, state, tier, annual rev, 90D qty/rev, velocity, txns, items stocked
- Click a store → detail view with 8 KPI cards, category pie chart, tier comparison bar, category breakdown table

---

## Export Pipeline (scripts/)

### export_data.py

Main orchestrator. Phases run sequentially:

| Phase | What it does |
|---|---|
| 1 | Fetch 54 stores and ~23,800 active selling-category items from CK API |
| 2 | Bulk fetch all 90-day POS ticket lines; accumulate 90D/30D/7D sales per item and per store |
| 4 | Run `math_pipeline.py`; write `CK_math_pipeline_data_new.csv` |
| 5a | Aggregate per-store 90D data; compute tiers; write `CK_store_data_new.csv` |
| 5 | Validate column names and row counts; archive live files; promote `_new` to live |

Phase 2 progress bar format:
```
  [████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░]  30.2%  page 1237/4094  elapsed 18m42s  ETA 43m21s
```

### math_pipeline.py

Pure-Python statistical ranking engine. Per sub-category:

1. Compute `log(SALES_90D + 1)` for each item
2. Compute mean and std dev of log-sales
3. Choose rank method:
   - `n < 3` → `QTY-RANK`
   - `n > 5000` → `EMPIRICAL`
   - `3 ≤ n ≤ 5000` → Shapiro-Wilk normality test
4. `Z-SCORE` method (normal): `z = (log_sales - mean) / std`, percentile from CDF
5. `EMPIRICAL` method (non-normal): rank by log_sales, percentile = rank / n

### validate.py

Checks each `_new.csv` for:
- Required column names
- Minimum row counts (`CK_math_pipeline_data_new.csv` ≥ 500, `CK_daily_sales_new.csv` ≥ 5000, `CK_store_data_new.csv` ≥ 10)

On failure, deletes `_new` files and exits with code 1. On success, archives previous live files and promotes `_new` to live.

---

## Statistical Engine

### Percentile calculation (js/math.js — `computePercentile`)

1. Find all peers (same `CATEGORY` + `SUBCAT`)
2. If `RANK_METHOD = 'QTY-RANK'` or no `Z_SCORE` → empirical rank by qty sold
3. If Shapiro-Wilk passes (p > 0.05) → use Z-table CDF (`normalCDF`)
4. Otherwise → empirical rank on z-scores

### Normality (CK_normality_results.csv)

Pre-computed Shapiro-Wilk results per sub-category. Loaded at boot into `normalityMap` keyed by `"CATEGORY|SUBCAT"`. Used by `computePercentile` to choose z-score vs. empirical method.

---

## CSV Schemas

### CK_math_pipeline_data.csv

| Column | Type | Description |
|---|---|---|
| ITEM_NO | string | Item identifier |
| DESCR | string | Item description |
| CATEGORY | string | Category code |
| SUBCAT | string | Sub-category code |
| PRICE | float | Current sell price |
| LAST_COST | float | Last purchase cost |
| MARGIN_PCT | float | (price - cost) / price |
| SALES_90D | int | Units sold — 90 days |
| SALES_30D | int | Units sold — 30 days |
| SALES_7D | int | Units sold — 7 days |
| REV_90D | float | Revenue — 90 days |
| REV_30D | float | Revenue — 30 days |
| REV_7D | float | Revenue — 7 days |
| LOG_SALES_90D | float | log(SALES_90D + 1) |
| SUBCAT_MEAN | float | Mean log-sales within sub-cat |
| SUBCAT_STD | float | Std dev log-sales within sub-cat |
| Z_SCORE | float\|null | Standardized score (null if empirical) |
| PERCENTILE | float | 0–100 ranking within sub-category |
| RANK_METHOD | string | `Z-SCORE`, `EMPIRICAL`, or `QTY-RANK` |
| SUBCAT_RANK | int | Rank within sub-category (1 = best) |
| SUBCAT_TOTAL | int | Total items in sub-category |
| STATUS | string | `ACTIVE` or `INACTIVE` |

### CK_daily_sales.csv

| Column | Type | Description |
|---|---|---|
| ITEM_NO | string | Item identifier |
| POST_DATE | date (YYYY-MM-DD) | Sale date |
| QTY_SOLD | int | Units sold that day |
| EXT_PRC | float | Revenue that day |

### CK_store_data.csv

| Column | Type | Description |
|---|---|---|
| STR_ID | string | Store identifier |
| STORE_NAME | string | Store name |
| CITY | string | City |
| STATE | string | State |
| STORE_TIER | string | `ELITE`, `HIGH`, `MEDIUM`, or `LOW` (`ELITE` manually assigned to top performers; others by 90D revenue thirds) |
| ANNUAL_REVENUE | float | 90D revenue × 4 |
| QTY_90D | int | Units sold — 90 days |
| AMT_90D | float | Revenue — 90 days |
| TXN_90D | int | Transaction count — 90 days (currently 0) |
| UNIQUE_ITEMS_90D | int | Unique items sold — 90 days |
| CATEGORIES_SOLD | int | Unique categories sold — 90 days |
| PCT_RECENT | float | % of annual revenue in last 90 days |
| QTY_ON_HND | int | On-hand qty (0 — inventory endpoint unavailable) |
| QTY_AVAIL | int | Available qty (0 — inventory endpoint unavailable) |
| ITEMS_STOCKED | int | Items stocked (0 — inventory endpoint unavailable) |

### CK_normality_results.csv

| Column | Type | Description |
|---|---|---|
| CATEG_COD | string | Category code |
| SUBCAT_COD | string | Sub-category code |
| NORMAL | string | `Yes` or `No` |
| W_STAT | float | Shapiro-Wilk W statistic |
| P_VALUE | float | p-value (> 0.05 = normal distribution) |

---

## API Integration

**Base URL:** `http://172.16.20.185:8085`  
**Auth:** `X-Api-Key` header

| Endpoint | Used by | Purpose |
|---|---|---|
| `GET /api/v1/Stores?pageSize=200` | Phase 1, proxy | Store list |
| `GET /api/v1/items?pageSize=200&filter=status:eq:A&fields=...` | Phase 1 | Active items |
| `GET /api/v1/pos/ticket-history-lines?filter=BusinessDate:gte:{date}&pageSize=200&fields=...` | Phase 2 | 90-day POS lines |
| `GET /api/v1/items/{itemNo}` | proxy | Single item metadata |
| `GET /api/v1/items/{itemNo}/inventory` | proxy | Per-store inventory (503-safe) |
| `GET /api/v1/items/categories?pageSize=200` | proxy | Category list |

All endpoints are paginated. The API returns `{ data: [...], hasNextPage, totalPages, totalCount }`. Phase 2 specifically uses `totalPages` for the progress bar.

---

## File Structure

```
CK-Analytics-DB/
├── .env                              environment variables
├── .gitignore
├── package.json                      npm metadata (express, cors, dotenv, node-fetch, csv-parse)
├── requirements.txt                  Python deps (requests, pandas, scipy, numpy, python-dotenv)
├── proxy.js                          Express server — routes, CSV cache, search, aggregation
├── index.html                        SPA entry point
├── start.bat                         Windows launcher (npm install + node proxy.js)
├── swagger_full.json                 CK API OpenAPI spec (reference only)
│
├── css/
│   └── styles.css                    Complete dashboard styling
│
├── js/
│   ├── app.js                        Global state, boot sequence, tab switching
│   ├── data-loader.js                Fetch rankings/stores at boot; loadItemData()
│   ├── utils.js                      Formatting helpers, getDailySalesForItem()
│   ├── math.js                       normalCDF(), computePercentile()
│   ├── charts.js                     Chart.js rendering (trend, doughnut, bar)
│   └── views/
│       ├── item-zoom.js              Item search + detail render
│       ├── category.js               Category overview + drill-down
│       └── store.js                  Store overview + detail
│
├── scripts/
│   ├── export_data.py                Nightly pipeline orchestrator (Phases 1,2,4,5a,5)
│   ├── math_pipeline.py              Z-score / empirical ranking engine
│   └── validate.py                   CSV column + row count validation
│
├── data/
│   ├── CK_math_pipeline_data.csv     ~23,800 items with rankings (live)
│   ├── CK_daily_sales.csv            ~154,000 daily transactions (live)
│   ├── CK_store_data.csv             54 stores with metrics (live)
│   ├── CK_stores.csv                 Store reference list
│   ├── CK_normality_results.csv      Shapiro-Wilk results per sub-category
│   └── archive/                      Previous exports: {name}_{YYYY-MM-DD}.csv
│
└── logs/
    └── export_run.log                export_data.py output when run via redirect
```
