# Infrastructure Handoff Spec — V2 Sales Intelligence Platform

**Prepared:** May 2026  
**Prepared by:** Dashboard development team  
**For:** Software / database engineering team  
**Repo:** `Sales_Dashboard_2nd_Iteration`

---

## 1. Executive Summary

### What V2 Does

The V2 Sales Intelligence Platform is a browser-based analytics dashboard for Kellis sales reps. It surfaces four views: an **Account Performance** landing page that shows every account in a rep's territory with health tiers, YTD vs. prior-year comparisons, and trend charts; a **Customer Account** deep-dive that shows a single customer's category breakdown, order history, and an AI-generated sales pitch; an **Item Performance** drill-down that shows category-level revenue, individual item rankings, and 90-day item KPIs; and a **Leaderboard** that ranks every rep in the territory by YTD revenue, health score, and year-over-year improvement.

### Who Uses It

Active Kellis sales reps (user group `KGS`, security code `SALES`). Reps log in once per session, select their rep ID from a picker, and then browse their own accounts. The Leaderboard tab is territory-wide and visible to all reps. There is currently no authentication beyond network access.

### Why This Handoff Is Happening

Every number the dashboard shows is computed in real time: the Node.js proxy server fetches raw rows from the Counterpoint REST API, aggregates them in JavaScript, and returns the result to the browser. Loading the Account Performance tab for a rep with ~200 accounts fires ~200 sequential `sales-by-category` API calls (one per customer). The Leaderboard fires those same calls for every customer across all reps — potentially 1,000+ calls — even with concurrency capping and in-process caching. Item Performance performs a 2,000-row `ticket-history-lines` fetch on every category drill-down. This architecture works for a demo but does not scale to production: cold loads take 5–30 seconds, caches are process-local and lost on restart, and there is no way to pre-aggregate data that requires joining across tables the REST API exposes separately.

### What the Software Team Is Being Asked to Build

Pre-computed SQL views (or materialized tables, depending on your preference) that the dashboard can query with a single fast lookup per page load. The proxy server will be updated to call these views instead of grinding through raw ticket-history lines. The software team owns schema shape, endpoint design, and authentication; this document specifies the analytical logic — what to compute, what fields the dashboard needs, and how those fields are currently derived.

---

## 2. Current Data Flow Inventory

### 2.1 Account Performance Tab

**What it displays:**
- KPI bar: total account count, total YTD sales, # accounts behind target, # accounts with no orders in 30+ days, # growing, # declining
- Three charts: top-15 accounts horizontal bar (colored by health tier), tier distribution donut, YTD vs. prior-YTD scatter
- Sortable/filterable table: customer name, account number, state, health tier, YTD sales, target, % to target, prior YTD, % change, days since last order, last order date

**Raw data fetched today:**

1. `GET /api/v1/Customers?filter=salesRep:eq:{rep}&fields=custNo,name,state,salesRep,lastSaleDate,lastSaleAmount&pageSize=200`  
   Paginated — returns all customers for the selected rep. Typically 100–300 customers depending on the rep.

2. For **each** customer: `GET /api/v1/Customers/{custNo}/sales-by-category`  
   Returns an array of category rows, each with `categoryCode`, `description`, `currentYtdAmount`, `priorYtdAmount`, `currentUniqQty`, `priorUniqQty`, `dollarChange`. The proxy sums `currentYtdAmount` across all rows to get `ytdSales`, and sums `priorYtdAmount` to get `priorYtd`.

**Where aggregation happens:** Node.js proxy (`server/routes/customers.js`, `GET /proxy/accounts`). All ~200 `sales-by-category` calls fire in parallel via `Promise.all`. Results are cached in-process for 5 minutes per rep ID.

**Data volume:** ~200 customers × 1 API call each = ~200 concurrent HTTP requests per cold load. Each `sales-by-category` response is typically 5–30 rows (one per active category for that customer).

**Observed timing:** 5–15 seconds on a cold load (no cache). Sub-second on a warm cache hit.

**Fragile today:**
- Cache is process-local. A server restart or a different Node process instance gets no benefit from a prior load.
- `pctToTarget` uses `priorYtd` as the target proxy — there is no actual target field in Counterpoint. If a customer has zero prior-year data, `pctToTarget` is set to `0` or `1` depending on whether they have any current sales.
- `daysSinceOrder` is computed from `customer.lastSaleDate`. This field appears to be updated by Counterpoint's point-of-sale system; its reliability has not been independently verified.
- `target` in the dashboard is literally equal to `priorYtd`. There is no separate target table.

---

### 2.2 Customer Account Tab

**What it displays:**
- Header: customer name, account number, state, rep, segment label, last order date, days since last order, tier badge
- KPI row: YTD sales, % to target (with progress bar), prior YTD, % change YoY, MTD sales, MTD order-day count
- Category breakdown table: per-category current YTD, prior YTD, quantity, $ change, and a % change indicator
- Three charts: current vs. prior YTD by category (bar), category revenue mix (donut), monthly sales trend (placeholder — no data source today; see Section 4)
- Order history: date, ticket number, amount, with on-demand expansion to line items
- AI chat drawer: auto-populated with a 4-bullet account summary and 4-bullet sales strategy; supports follow-up conversation

**Raw data fetched today** (four parallel calls on tab open):

1. `GET /proxy/customer/{custNo}` → `GET /api/v1/Customers/{custNo}`  
   Full customer object: name, address, state, salesRep, lastSaleDate, etc.

2. `GET /proxy/categories/{custNo}` → `GET /api/v1/Customers/{custNo}/sales-by-category`  
   Per-category YTD breakdown for this customer. Returned fields: `categoryCode`, `description`, `currentYtdAmount`, `currentUniqQty`, `priorYtdAmount`, `priorUniqQty`, `dollarChange`.

3. `GET /proxy/mtd/{custNo}` → paginated `GET /api/v1/pos/ticket-history?filter=custNo:eq:{custNo},businessDate:gte:{mtdStart},businessDate:lte:{mtdEnd}&fields=custNo,total,businessDate`  
   Fetches all ticket headers for the current calendar month. Proxy sums `total` for MTD revenue and counts distinct `businessDate` values for `orderDays`.

4. `GET /proxy/orders/{custNo}` → paginated `GET /api/v1/Customers/{custNo}/sales-history`  
   Up to 2 years of order history. Each row: `businessDate`, `ticketNo`, `total`, `lineCount`.

5. On order expansion (lazy): `GET /proxy/order-lines/{ticketNo}` → `GET /api/v1/pos/ticket-history/{ticketNo}`  
   Line items for one ticket: `itemNo`, `description`, `quantity`, `price`, `extPrice`. Cached per `ticketNo` for the session.

6. On AI panel open: streaming SSE to `/proxy/ai` → Claude API  
   Not a database concern — stays in the proxy layer.

**Where aggregation happens:** Mostly in the Counterpoint API itself (`sales-by-category` is a Counterpoint endpoint that returns pre-aggregated YTD data). MTD aggregation (sum + distinct date count) happens in the proxy. Category chart data is used directly from the `sales-by-category` response.

**Data volume:** 4 API calls total. Each is fast (under 500ms individually); the slowest is order history, which may paginate if the customer has a dense 2-year record.

**Observed timing:** 1–3 seconds on cold load. The AI pitch adds a 3–6 second streaming delay on top.

**Fragile today:**
- MTD query paginates through `ticket-history` — if a high-volume customer has many tickets in the current month, this can be slow.
- The monthly sales trend chart panel exists in the layout but is never populated — `renderCACharts` does not include a monthly chart. **This is a known gap; see Section 4.**
- `segment` label shown in the header is currently always empty — it is passed as `cust.segment || ''` and the Counterpoint customer record contains no useful segment data. **This is a known gap; see Section 4.**

---

### 2.3 Item Performance Tab

**What it displays:**

**Level 1 — Category Overview:**
- Stat bar: total categories, total territory YTD, total prior YTD, YoY change
- Two charts: paired current/prior YTD bar (top 10 categories), revenue-mix donut (top 7 + Other)
- Sortable table: category code, description, current YTD, prior YTD, YoY % change, account count

**Level 2 — Category Drill-Down:**
- Top 15 items by 90-day revenue (horizontal bar)
- Revenue-share donut (top 7 items + Other)
- Ranked table: item number, description, 90-day revenue, 90-day units

**Level 3 — Item Deep-Dive:**
- 5 KPI cards: 90-day revenue, 30-day revenue, 7-day revenue, average sell price, gross margin %
- Dual-axis trend line (revenue + units, daily or weekly toggle, weekdays only)
- Period donut: 7d / 8–30d / 31–90d revenue buckets
- Weekly revenue bar

**Raw data fetched today:**

*Level 1:*  
`GET /proxy/all-categories` → reads from `categoryCache` if warm (populated when `/proxy/accounts` was called); otherwise fires `GET /api/v1/Customers/{custNo}/sales-by-category` for every customer in the rep's territory and aggregates in the proxy. Each row in the response has `categoryCode`, `description`, `currentYtdAmt`, `priorYtdAmt`, `accountCount`, `avgPerAccount`.

*Level 2:*  
`GET /proxy/category-top-items/{category}` → `GET /api/v1/pos/ticket-history-lines?filter=categoryCode:eq:{category},businessDate:gte:{90daysAgo},businessDate:lte:{today}&pageSize=2000&page=1`  
Single-page fetch (intentional — no pagination, 2000-row cap for speed). Proxy aggregates by `itemNo`: sums `extPrice` → `rev90`, sums `quantity` → `units90`. Returns top 50 by revenue. Cached 5 minutes.

*Level 3:*  
`GET /proxy/item-stats/{itemNo}` — two parallel calls:
- `GET /api/v1/Items/{itemNo}` — item master: `description`, `categoryCode`, `statusCode`, `profCod1` (best-seller flag)
- Paginated `GET /api/v1/pos/ticket-history-lines?filter=itemNo:eq:{itemNo},businessDate:gte:{90daysAgo},businessDate:lte:{today}&fields=itemNo,description,quantity,extPrice,price,unitCost,businessDate,categoryCode&pageSize=1000`  
  Proxy aggregates: 90/30/7-day revenue and units windows, average sell price (mean of `price` across priced lines), average unit cost (mean of `unitCost` across costed lines), gross margin `((avgSell - avgCost) / avgSell * 100)`, and a 90-day daily array padded with zeros. Cached 5 minutes.

**Where aggregation happens:** Entirely in the Node.js proxy for Levels 2 and 3. Level 1 reuses the aggregation already done during the Account Performance load if that cache is warm.

**Data volume:** Level 2 fetches up to 2,000 line-item rows per category request. Level 3 fetches all line items for one item over 90 days (typically 20–500 rows depending on item velocity). Level 1 is free if the accounts cache is warm; otherwise it's ~200 API calls.

**Observed timing:** Level 1: sub-second if warm, 5–15 seconds if cold. Level 2: 2–6 seconds (single large fetch). Level 3: 1–3 seconds.

**Fragile today:**
- Level 2 is capped at the first 2,000 ticket-history-line rows. For high-velocity categories this may undersample, causing lower-ranked items to appear higher than their true position.
- Level 3 `avgSell` and `avgCost` are computed as a simple average of the `price` and `unitCost` fields on individual line rows, not a weighted average. If a single line has an unusual price (e.g., a correction ticket), it skews the averages.
- **In-progress / Phase 1 approved but not yet shipped:** Segment-filtered item analytics. The goal is to show item performance broken out by customer segment — e.g., "this item sells $12k to Convenience Store accounts vs $4k to Restaurant accounts." This requires a two-step join: `ticket-history-lines.ticketNo → ticket-history.custNo → customer.segment`. The `custNo` field is present on ticket headers but **not** on line items. The current proxy cannot do this join efficiently at runtime. It is explicitly called out in Section 3 as a required view.

---

### 2.4 Leaderboard Tab

**What it displays:**
- KPI bar: territory total revenue, total accounts, leader name, most-improved rep
- Visual podium (top 3 reps, gold/silver/bronze)
- Horizontal bar chart: all reps, current YTD vs. prior YTD
- Full rankings table: rank (with medals), rep name, YTD revenue, % to target (with progress bar), YoY % change, account count, health score (composite), critical/at-risk account counts

**Raw data fetched today:**
`GET /proxy/leaderboard` — a single endpoint that internally:
1. Fires `GET /api/v1/System/users?filter=wrkgrpId:eq:KGS,secCod:eq:SALES` to get all reps
2. Fires paginated `GET /api/v1/Customers?fields=custNo,salesRep,lastSaleDate` to get all customers territory-wide
3. For any customer whose rep is **not** already in the 5-minute `accountsCache`, fires `GET /api/v1/Customers/{custNo}/sales-by-category` (up to 1,000+ calls on a cold boot, capped at 20 concurrent via `parallelLimit`)
4. Aggregates per rep: sums `ytdSales`, `priorYtd`, computes `pctToTarget`, `pctChange`, runs `computeTier` per account, tallies tier distribution, computes `healthScore`

Cached 15 minutes.

**Health score formula (computed in proxy, not client):**
```
healthScore = Math.round(
  (Healthy × 100 + Attention × 60 + AtRisk × 25 + Critical × 0) / accountCount
)
```

**Data volume:** Up to 1,000+ `sales-by-category` calls on a full cold load. With `parallelLimit(20)`, this serializes into batches of 20 concurrent requests.

**Observed timing:** 15–60 seconds on a cold load (no accountsCache warm). 1–2 seconds if the accounts cache was recently populated for all reps.

---

## 3. Proposed SQL Views

The following sections specify the analytical views the dashboard needs. Each includes the exact logic currently computed in JavaScript/Node, translated into SQL, so the software team can verify the semantics match before building. Table and column names below use reasonable guesses based on the Counterpoint API field names (`custNo`, `salesRep`, `categoryCode`, `extPrice`, `businessDate`, `unitCost`, `price`); the software team should map these to the actual Counterpoint schema.

> **Convention:** `thl` = `ticket_history_lines`, `th` = `ticket_history` (ticket headers), `c` = `customers`, `u` = `users`/`reps`.

---

### 3.1 `v_customer_ytd_rollup`

**Purpose:** One row per customer with current and prior YTD sales totals, health tier, and days-since-last-order — drives the Account Performance table and Customer Account KPI bar.

**Grain:** One row per `cust_no`.

**Required columns:**

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `cust_no` | VARCHAR | No | Primary key join |
| `name` | VARCHAR | No | Display name |
| `state` | VARCHAR | Yes | Two-letter state code |
| `sales_rep` | VARCHAR | No | Rep ID (e.g. `BRIANH-ACT`) |
| `last_order_date` | DATE | Yes | Most recent `business_date` from ticket headers |
| `days_since_order` | INT | No | `CURRENT_DATE - last_order_date`, or 999 if null |
| `ytd_sales` | DECIMAL(12,2) | No | Sum of `ext_price` for current calendar year, non-void tickets |
| `prior_ytd_sales` | DECIMAL(12,2) | No | Sum of `ext_price` for same date range in prior calendar year |
| `pct_to_target` | DECIMAL(6,4) | Yes | `ytd_sales / prior_ytd_sales`; null if `prior_ytd_sales = 0` |
| `pct_change` | DECIMAL(6,4) | Yes | `(ytd_sales - prior_ytd_sales) / prior_ytd_sales`; null if prior = 0 |
| `health_tier` | VARCHAR(12) | No | `'Critical'`, `'AtRisk'`, `'Attention'`, or `'Healthy'` — see tier logic below |

**Health tier logic** (must match `computeTier` in `server/routes/customers.js` exactly):

```
day_of_year  = DAY_OF_YEAR(CURRENT_DATE)
run_rate     = day_of_year / 365.0

IF days_since_order >= 90
    THEN 'Critical'
ELSE IF prior_ytd_sales > 0 AND ytd_sales < prior_ytd_sales * 0.5
    THEN 'Critical'
ELSE IF days_since_order >= 45
    THEN 'AtRisk'
ELSE IF prior_ytd_sales > 0 AND pct_to_target < (run_rate - 0.25)
    THEN 'AtRisk'
ELSE IF prior_ytd_sales = 0 AND days_since_order <= 30 AND ytd_sales > 0
    THEN 'Healthy'
ELSE IF prior_ytd_sales = 0 AND days_since_order <= 45
    THEN 'Attention'
ELSE IF prior_ytd_sales = 0
    THEN 'AtRisk'
ELSE IF days_since_order <= 30 AND pct_to_target >= (run_rate - 0.10)
    THEN 'Healthy'
ELSE IF days_since_order <= 45
    THEN 'Attention'
ELSE
    'AtRisk'
```

**Suggested SQL:**

```sql
WITH current_ytd AS (
    SELECT
        th.cust_no,
        SUM(thl.ext_price) AS ytd_sales
    FROM ticket_history_lines thl
    JOIN ticket_history th ON th.ticket_no = thl.ticket_no
    WHERE th.business_date >= DATE_TRUNC('year', CURRENT_DATE)
      AND th.business_date <= CURRENT_DATE
      AND th.void_flag IS DISTINCT FROM 'Y'    -- exclude voided tickets
    GROUP BY th.cust_no
),
prior_ytd AS (
    SELECT
        th.cust_no,
        SUM(thl.ext_price) AS prior_ytd_sales
    FROM ticket_history_lines thl
    JOIN ticket_history th ON th.ticket_no = thl.ticket_no
    WHERE th.business_date >= DATE_TRUNC('year', CURRENT_DATE) - INTERVAL '1 year'
      AND th.business_date <= (CURRENT_DATE - INTERVAL '1 year')
      AND th.void_flag IS DISTINCT FROM 'Y'
    GROUP BY th.cust_no
),
last_order AS (
    SELECT
        cust_no,
        MAX(business_date) AS last_order_date
    FROM ticket_history
    WHERE void_flag IS DISTINCT FROM 'Y'
    GROUP BY cust_no
)
SELECT
    c.cust_no,
    c.name,
    c.state,
    c.sales_rep,
    lo.last_order_date,
    COALESCE(CURRENT_DATE - lo.last_order_date, 999)  AS days_since_order,
    COALESCE(cy.ytd_sales,   0)                        AS ytd_sales,
    COALESCE(py.prior_ytd_sales, 0)                    AS prior_ytd_sales,
    CASE
        WHEN COALESCE(py.prior_ytd_sales, 0) > 0
        THEN COALESCE(cy.ytd_sales, 0) / py.prior_ytd_sales
        ELSE NULL
    END                                                AS pct_to_target,
    CASE
        WHEN COALESCE(py.prior_ytd_sales, 0) > 0
        THEN (COALESCE(cy.ytd_sales, 0) - py.prior_ytd_sales) / py.prior_ytd_sales
        ELSE NULL
    END                                                AS pct_change,
    -- Health tier (matches computeTier logic exactly)
    CASE
        WHEN COALESCE(CURRENT_DATE - lo.last_order_date, 999) >= 90
            THEN 'Critical'
        WHEN COALESCE(py.prior_ytd_sales, 0) > 0
             AND COALESCE(cy.ytd_sales, 0) < py.prior_ytd_sales * 0.5
            THEN 'Critical'
        WHEN COALESCE(CURRENT_DATE - lo.last_order_date, 999) >= 45
            THEN 'AtRisk'
        WHEN COALESCE(py.prior_ytd_sales, 0) > 0
             AND COALESCE(cy.ytd_sales, 0) / NULLIF(py.prior_ytd_sales, 0)
                 < (EXTRACT(DOY FROM CURRENT_DATE) / 365.0 - 0.25)
            THEN 'AtRisk'
        WHEN COALESCE(py.prior_ytd_sales, 0) = 0
             AND COALESCE(CURRENT_DATE - lo.last_order_date, 999) <= 30
             AND COALESCE(cy.ytd_sales, 0) > 0
            THEN 'Healthy'
        WHEN COALESCE(py.prior_ytd_sales, 0) = 0
             AND COALESCE(CURRENT_DATE - lo.last_order_date, 999) <= 45
            THEN 'Attention'
        WHEN COALESCE(py.prior_ytd_sales, 0) = 0
            THEN 'AtRisk'
        WHEN COALESCE(CURRENT_DATE - lo.last_order_date, 999) <= 30
             AND COALESCE(cy.ytd_sales, 0) / NULLIF(py.prior_ytd_sales, 0)
                 >= (EXTRACT(DOY FROM CURRENT_DATE) / 365.0 - 0.10)
            THEN 'Healthy'
        WHEN COALESCE(CURRENT_DATE - lo.last_order_date, 999) <= 45
            THEN 'Attention'
        ELSE 'AtRisk'
    END                                                AS health_tier
FROM customers c
LEFT JOIN current_ytd cy  ON cy.cust_no  = c.cust_no
LEFT JOIN prior_ytd   py  ON py.cust_no  = c.cust_no
LEFT JOIN last_order  lo  ON lo.cust_no  = c.cust_no
WHERE c.status_code IS DISTINCT FROM 'I'   -- exclude inactive customers
```

**Refresh cadence:** Nightly materialized view is acceptable for the Account Performance tab (reps check it at the start of the day). If MTD accuracy is required throughout the day, refresh every 1–4 hours. A fully real-time view would be too expensive given the volume of underlying line-item rows.

> **Ambiguity flag:** The proxy reads `ext_price` from `ticket-history-lines`. Verify whether `ext_price` already excludes discounts and returns, or whether a separate adjustment field exists in the Counterpoint schema. The proxy makes no adjustment — it sums raw `extPrice` as returned by the API.

---

### 3.2 `v_customer_category_ytd`

**Purpose:** One row per customer per category with current and prior YTD revenue — drives the category breakdown table on the Customer Account tab and the all-categories aggregate on the Item Performance tab.

**Grain:** One row per `(cust_no, category_code)` with both periods as columns.

**Required columns:**

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `cust_no` | VARCHAR | No | |
| `category_code` | VARCHAR | No | |
| `category_description` | VARCHAR | Yes | From category master or item master |
| `current_ytd_amt` | DECIMAL(12,2) | No | |
| `current_ytd_qty` | DECIMAL(10,0) | No | Unit quantity, current YTD |
| `prior_ytd_amt` | DECIMAL(12,2) | No | |
| `prior_ytd_qty` | DECIMAL(10,0) | No | Unit quantity, prior YTD |
| `dollar_change` | DECIMAL(12,2) | No | `current_ytd_amt - prior_ytd_amt` |
| `pct_change` | DECIMAL(6,4) | Yes | `dollar_change / prior_ytd_amt`; null if prior = 0 |

**Suggested SQL:**

```sql
WITH current_period AS (
    SELECT
        th.cust_no,
        thl.category_code,
        SUM(thl.ext_price)  AS current_ytd_amt,
        SUM(thl.quantity)   AS current_ytd_qty
    FROM ticket_history_lines thl
    JOIN ticket_history th ON th.ticket_no = thl.ticket_no
    WHERE th.business_date >= DATE_TRUNC('year', CURRENT_DATE)
      AND th.business_date <= CURRENT_DATE
      AND th.void_flag IS DISTINCT FROM 'Y'
    GROUP BY th.cust_no, thl.category_code
),
prior_period AS (
    SELECT
        th.cust_no,
        thl.category_code,
        SUM(thl.ext_price)  AS prior_ytd_amt,
        SUM(thl.quantity)   AS prior_ytd_qty
    FROM ticket_history_lines thl
    JOIN ticket_history th ON th.ticket_no = thl.ticket_no
    WHERE th.business_date >= DATE_TRUNC('year', CURRENT_DATE) - INTERVAL '1 year'
      AND th.business_date <= (CURRENT_DATE - INTERVAL '1 year')
      AND th.void_flag IS DISTINCT FROM 'Y'
    GROUP BY th.cust_no, thl.category_code
)
SELECT
    COALESCE(cp.cust_no,       pp.cust_no)       AS cust_no,
    COALESCE(cp.category_code, pp.category_code) AS category_code,
    cat.description                               AS category_description,
    COALESCE(cp.current_ytd_amt, 0)               AS current_ytd_amt,
    COALESCE(cp.current_ytd_qty, 0)               AS current_ytd_qty,
    COALESCE(pp.prior_ytd_amt,   0)               AS prior_ytd_amt,
    COALESCE(pp.prior_ytd_qty,   0)               AS prior_ytd_qty,
    COALESCE(cp.current_ytd_amt, 0)
      - COALESCE(pp.prior_ytd_amt, 0)             AS dollar_change,
    CASE
        WHEN COALESCE(pp.prior_ytd_amt, 0) > 0
        THEN (COALESCE(cp.current_ytd_amt, 0) - pp.prior_ytd_amt) / pp.prior_ytd_amt
        ELSE NULL
    END                                           AS pct_change
FROM current_period cp
FULL OUTER JOIN prior_period pp
    ON pp.cust_no = cp.cust_no AND pp.category_code = cp.category_code
LEFT JOIN categories cat
    ON cat.category_code = COALESCE(cp.category_code, pp.category_code)
WHERE COALESCE(cp.current_ytd_amt, 0) > 0
   OR COALESCE(pp.prior_ytd_amt, 0) > 0
```

**Territory aggregate (for Item Performance Level 1):** The dashboard also needs a territory-wide rollup across all customers for the same period. This is a `GROUP BY category_code` aggregate over `v_customer_category_ytd`, plus `account_count = COUNT(DISTINCT cust_no WHERE current_ytd_amt > 0)`. This can be a second view (`v_territory_category_ytd`) or computed from the customer-level view at query time filtered by `sales_rep`.

**Wide vs. narrow tradeoff:**
- **Wide (one row per cust+category with both period columns, as written above):** Easier to query for a single customer (`WHERE cust_no = ?`). Slightly larger rows but fewer of them. Recommended for the Customer Account tab.
- **Narrow (one row per cust+category+period):** More flexible for windowed comparisons, but requires a pivot at query time. Not worth the complexity here.

**Refresh cadence:** Same as `v_customer_ytd_rollup` — nightly or every 1–4 hours.

---

### 3.3 `v_item_sales_90d`

**Purpose:** One row per item per calendar date for the trailing 90 days, with daily revenue, unit count, and margin inputs — drives Item Performance Level 3 (item deep-dive) and Level 2 (category rankings).

**Grain:** One row per `(item_no, business_date)`.

**Required columns:**

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `item_no` | VARCHAR | No | |
| `description` | VARCHAR | No | From item master; fall back to line-item description |
| `category_code` | VARCHAR | No | From item master |
| `status_code` | VARCHAR | Yes | Active / Inactive flag from item master |
| `is_best_seller` | BOOLEAN | No | `prof_cod1 = 'Y'` in item master |
| `business_date` | DATE | No | |
| `daily_revenue` | DECIMAL(12,2) | No | Sum of `ext_price` for this item on this date |
| `daily_units` | DECIMAL(10,2) | No | Sum of `quantity` for this item on this date |
| `avg_sell_price` | DECIMAL(10,4) | Yes | Simple mean of `price` across lines for this item+date where `price > 0` |
| `avg_unit_cost` | DECIMAL(10,4) | Yes | Simple mean of `unit_cost` across lines where `unit_cost > 0` |

**Note on margin computation:** The dashboard computes `avg_sell` and `avg_unit_cost` as simple means (not weighted means) of the individual line-row `price` and `unit_cost` fields. This matches the current proxy behavior. If the software team has access to a better cost source (e.g., average landed cost from inventory), that would produce more accurate margin figures — but changing the computation here would require a corresponding update to the dashboard display logic. Flag this as a decision point.

**Suggested SQL:**

```sql
SELECT
    thl.item_no,
    COALESCE(im.description, thl.description, thl.item_no)  AS description,
    COALESCE(im.category_code, thl.category_code)           AS category_code,
    im.status_code,
    CASE WHEN im.prof_cod1 = 'Y' THEN TRUE ELSE FALSE END   AS is_best_seller,
    th.business_date,
    SUM(thl.ext_price)                                       AS daily_revenue,
    SUM(thl.quantity)                                        AS daily_units,
    AVG(NULLIF(thl.price,     0))                            AS avg_sell_price,
    AVG(NULLIF(thl.unit_cost, 0))                            AS avg_unit_cost
FROM ticket_history_lines thl
JOIN ticket_history th ON th.ticket_no = thl.ticket_no
LEFT JOIN item_master im ON im.item_no = thl.item_no
WHERE th.business_date >= CURRENT_DATE - INTERVAL '90 days'
  AND th.business_date <= CURRENT_DATE
  AND th.void_flag IS DISTINCT FROM 'Y'
  AND thl.item_no IS NOT NULL
GROUP BY
    thl.item_no,
    COALESCE(im.description, thl.description, thl.item_no),
    COALESCE(im.category_code, thl.category_code),
    im.status_code,
    im.prof_cod1,
    th.business_date
```

**Aggregated KPI view on top of this:** The dashboard's Level 3 KPI cards need 90/30/7-day window totals. These can be derived at query time from this view with window filters, or pre-aggregated into a companion `v_item_kpis_90d` view with one row per item:

```sql
-- Optional companion: v_item_kpis_90d
SELECT
    item_no,
    description,
    category_code,
    status_code,
    is_best_seller,
    SUM(CASE WHEN business_date >= CURRENT_DATE - INTERVAL '90 days' THEN daily_revenue ELSE 0 END) AS rev_90d,
    SUM(CASE WHEN business_date >= CURRENT_DATE - INTERVAL '30 days' THEN daily_revenue ELSE 0 END) AS rev_30d,
    SUM(CASE WHEN business_date >= CURRENT_DATE - INTERVAL '7 days'  THEN daily_revenue ELSE 0 END) AS rev_7d,
    SUM(CASE WHEN business_date >= CURRENT_DATE - INTERVAL '90 days' THEN daily_units   ELSE 0 END) AS units_90d,
    SUM(CASE WHEN business_date >= CURRENT_DATE - INTERVAL '30 days' THEN daily_units   ELSE 0 END) AS units_30d,
    SUM(CASE WHEN business_date >= CURRENT_DATE - INTERVAL '7 days'  THEN daily_units   ELSE 0 END) AS units_7d,
    AVG(NULLIF(avg_sell_price, 0)) AS avg_sell,
    AVG(NULLIF(avg_unit_cost,  0)) AS avg_cost,
    CASE
        WHEN AVG(NULLIF(avg_sell_price, 0)) > 0
        THEN (AVG(NULLIF(avg_sell_price, 0)) - AVG(NULLIF(avg_unit_cost, 0)))
             / AVG(NULLIF(avg_sell_price, 0)) * 100
        ELSE NULL
    END                            AS margin_pct
FROM v_item_sales_90d
GROUP BY item_no, description, category_code, status_code, is_best_seller
```

**Category top-items ranking (for Level 2):** The dashboard's Level 2 shows top 50 items by `rev_90d` within a category. This is a `WHERE category_code = ? ORDER BY rev_90d DESC LIMIT 50` query against `v_item_kpis_90d`.

**Refresh cadence:** Nightly. The 90-day window means a single day's lag is not meaningful for item trend analysis.

---

### 3.4 `v_item_segment_sales_90d`

**Purpose:** One row per item per customer segment per calendar date — enables the **Phase 1 approved** feature of showing how item performance breaks down by customer segment. This view solves the two-step join problem (`ticket-history-lines → ticket-history.cust_no → customer segment`) that cannot be done efficiently at proxy runtime.

**Grain:** One row per `(item_no, segment_label, business_date)`.

**Required columns:**

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `item_no` | VARCHAR | No | |
| `description` | VARCHAR | No | |
| `category_code` | VARCHAR | No | |
| `segment_label` | VARCHAR | No | From `v_customer_segment_lookup`; `'Unknown'` if no segment defined |
| `business_date` | DATE | No | |
| `daily_revenue` | DECIMAL(12,2) | No | |
| `daily_units` | DECIMAL(10,2) | No | |
| `cust_count` | INT | No | Distinct customers purchasing this item on this date |

**Suggested SQL:**

```sql
SELECT
    thl.item_no,
    COALESCE(im.description, thl.description, thl.item_no)  AS description,
    COALESCE(im.category_code, thl.category_code)           AS category_code,
    COALESCE(seg.segment_label, 'Unknown')                   AS segment_label,
    th.business_date,
    SUM(thl.ext_price)                                       AS daily_revenue,
    SUM(thl.quantity)                                        AS daily_units,
    COUNT(DISTINCT th.cust_no)                               AS cust_count
FROM ticket_history_lines thl
JOIN ticket_history th    ON th.ticket_no  = thl.ticket_no
LEFT JOIN item_master im  ON im.item_no    = thl.item_no
LEFT JOIN v_customer_segment_lookup seg ON seg.cust_no = th.cust_no
WHERE th.business_date >= CURRENT_DATE - INTERVAL '90 days'
  AND th.business_date <= CURRENT_DATE
  AND th.void_flag IS DISTINCT FROM 'Y'
  AND thl.item_no IS NOT NULL
GROUP BY
    thl.item_no,
    COALESCE(im.description, thl.description, thl.item_no),
    COALESCE(im.category_code, thl.category_code),
    COALESCE(seg.segment_label, 'Unknown'),
    th.business_date
```

**Note:** This view is only useful once `v_customer_segment_lookup` (Section 3.5) has meaningful segment labels populated. Until the segment override table exists and is populated by Kellis management, all rows will have `segment_label = 'Unknown'`, which is not wrong but is not displayable in the dashboard.

**Refresh cadence:** Nightly (same as `v_item_sales_90d`).

---

### 3.5 `v_customer_segment_lookup`

**Purpose:** One row per customer with a reliable, human-readable segment label — used as the foreign key for segment-filtered analytics throughout the platform.

**Background:** The Counterpoint `customers.category_code` field is not a useful business segment — investigation showed approximately 96% of customers have `categoryCode = 'CANDYCORNR'`, which appears to be a Counterpoint default. The dashboard currently displays no segment label. Segment labeling will require a **manual override table** maintained by the Kellis team.

**Grain:** One row per `cust_no`.

**Required columns:**

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `cust_no` | VARCHAR | No | |
| `cp_category_code` | VARCHAR | Yes | Raw `category_code` from Counterpoint customers table |
| `segment_override` | VARCHAR | Yes | Manually entered segment label (from override table) |
| `segment_label` | VARCHAR | No | `COALESCE(segment_override, cp_category_code, 'Unclassified')` |
| `override_source` | VARCHAR | Yes | `'manual'` or `'counterpoint'` — provenance for the dashboard header |

**Manual override table (new table required — software team must create):**

```sql
CREATE TABLE customer_segment_overrides (
    cust_no        VARCHAR      NOT NULL PRIMARY KEY,
    segment_label  VARCHAR(100) NOT NULL,
    updated_by     VARCHAR(100),
    updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

This table is populated by Kellis management (not reps). Until it is created and populated, `v_customer_segment_lookup` can be a simple passthrough of `customers.category_code`.

**Suggested SQL:**

```sql
SELECT
    c.cust_no,
    c.category_code                                             AS cp_category_code,
    ov.segment_label                                            AS segment_override,
    COALESCE(ov.segment_label, c.category_code, 'Unclassified') AS segment_label,
    CASE
        WHEN ov.segment_label IS NOT NULL THEN 'manual'
        WHEN c.category_code  IS NOT NULL THEN 'counterpoint'
        ELSE NULL
    END                                                         AS override_source
FROM customers c
LEFT JOIN customer_segment_overrides ov ON ov.cust_no = c.cust_no
```

**Refresh cadence:** Real-time SQL view (no aggregation). Can remain a standard view rather than a materialized table since it is cheap to query and changes infrequently.

---

### 3.6 `v_rep_leaderboard`

**Purpose:** One row per active sales rep with territory-wide aggregated stats — drives the Leaderboard tab. Eliminating the 1,000+ `sales-by-category` calls on cold load is the primary performance win from this handoff.

**Grain:** One row per active rep ID.

**Required columns:**

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `rep_id` | VARCHAR | No | e.g. `BRIANH-ACT` |
| `rep_name` | VARCHAR | No | Human-readable name, `-ACT`/`-ACTIVE` suffix stripped |
| `ytd_sales` | DECIMAL(12,2) | No | Sum of all customer `ytd_sales` for this rep |
| `prior_ytd_sales` | DECIMAL(12,2) | No | |
| `pct_to_target` | DECIMAL(6,4) | Yes | `ytd_sales / prior_ytd_sales`; null if prior = 0 |
| `pct_change` | DECIMAL(6,4) | Yes | `(ytd_sales - prior_ytd_sales) / prior_ytd_sales`; null if prior = 0 |
| `account_count` | INT | No | Total customers assigned to rep |
| `health_score` | INT | No | Composite 0–100; see formula |
| `cnt_healthy` | INT | No | |
| `cnt_attention` | INT | No | |
| `cnt_at_risk` | INT | No | |
| `cnt_critical` | INT | No | |
| `rank` | INT | No | Dense rank by `ytd_sales DESC` among reps with `account_count > 0` |

**Health score formula:**
```
health_score = ROUND(
  (cnt_healthy * 100 + cnt_attention * 60 + cnt_at_risk * 25 + cnt_critical * 0)
  / NULLIF(account_count, 0)
)
```

**Suggested SQL:**

```sql
WITH rep_accounts AS (
    SELECT
        r.rep_id,
        r.rep_name,
        COUNT(*)                                                           AS account_count,
        SUM(cr.ytd_sales)                                                  AS ytd_sales,
        SUM(cr.prior_ytd_sales)                                            AS prior_ytd_sales,
        SUM(CASE WHEN cr.health_tier = 'Healthy'   THEN 1 ELSE 0 END)     AS cnt_healthy,
        SUM(CASE WHEN cr.health_tier = 'Attention' THEN 1 ELSE 0 END)     AS cnt_attention,
        SUM(CASE WHEN cr.health_tier = 'AtRisk'    THEN 1 ELSE 0 END)     AS cnt_at_risk,
        SUM(CASE WHEN cr.health_tier = 'Critical'  THEN 1 ELSE 0 END)     AS cnt_critical
    FROM v_customer_ytd_rollup cr
    JOIN (
        -- Active reps only: usrId ends in -ACT or -ACTIVE
        SELECT
            usr_id  AS rep_id,
            REGEXP_REPLACE(name, '\s*[-–]\s*(ACTIVE|ACT)$', '', 'i') AS rep_name
        FROM sys_users
        WHERE wrkgrp_id = 'KGS'
          AND sec_cod    = 'SALES'
          AND (UPPER(usr_id) LIKE '%-ACT' OR UPPER(usr_id) LIKE '%-ACTIVE')
    ) r ON r.rep_id = cr.sales_rep
    GROUP BY r.rep_id, r.rep_name
)
SELECT
    rep_id,
    rep_name,
    ytd_sales,
    prior_ytd_sales,
    CASE WHEN prior_ytd_sales > 0
         THEN ytd_sales / prior_ytd_sales
         ELSE NULL END                                                      AS pct_to_target,
    CASE WHEN prior_ytd_sales > 0
         THEN (ytd_sales - prior_ytd_sales) / prior_ytd_sales
         ELSE NULL END                                                      AS pct_change,
    account_count,
    ROUND(
        (cnt_healthy * 100.0 + cnt_attention * 60.0 + cnt_at_risk * 25.0)
        / NULLIF(account_count, 0)
    )                                                                       AS health_score,
    cnt_healthy,
    cnt_attention,
    cnt_at_risk,
    cnt_critical,
    DENSE_RANK() OVER (ORDER BY ytd_sales DESC)                             AS rank
FROM rep_accounts
WHERE account_count > 0
```

**Dependency:** This view depends on `v_customer_ytd_rollup`. Both must be refreshed in the same nightly window, with `v_customer_ytd_rollup` running first.

**Refresh cadence:** Nightly. The Leaderboard UI has a manual "Refresh" button; that button should trigger a cache-busting re-query against this view rather than recomputing from scratch.

---

### 3.7 `v_customer_monthly_sales`

**Purpose:** One row per customer per calendar month — drives the monthly sales trend chart on the Customer Account tab, which is currently a placeholder with no data.

**Grain:** One row per `(cust_no, year, month)`.

**Required columns:**

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `cust_no` | VARCHAR | No | |
| `year` | INT | No | Calendar year |
| `month` | INT | No | 1–12 |
| `month_label` | VARCHAR | No | e.g. `'Jan 2025'` for display |
| `monthly_revenue` | DECIMAL(12,2) | No | |
| `order_count` | INT | No | Distinct ticket count |
| `order_days` | INT | No | Distinct business dates with at least one order |

**Suggested SQL:**

```sql
SELECT
    th.cust_no,
    EXTRACT(YEAR  FROM th.business_date)::INT   AS year,
    EXTRACT(MONTH FROM th.business_date)::INT   AS month,
    TO_CHAR(th.business_date, 'Mon YYYY')       AS month_label,
    SUM(th.total)                               AS monthly_revenue,
    COUNT(DISTINCT th.ticket_no)                AS order_count,
    COUNT(DISTINCT th.business_date)            AS order_days
FROM ticket_history th
WHERE th.business_date >= CURRENT_DATE - INTERVAL '24 months'
  AND th.void_flag IS DISTINCT FROM 'Y'
GROUP BY
    th.cust_no,
    EXTRACT(YEAR  FROM th.business_date),
    EXTRACT(MONTH FROM th.business_date),
    TO_CHAR(th.business_date, 'Mon YYYY')
```

> **Ambiguity flag:** The proxy currently uses ticket header `total` for MTD, and line-level `ext_price` for YTD. These two should agree, but if Counterpoint applies header-level adjustments (freight, discounts) not reflected in line `ext_price`, the numbers will differ. The monthly chart should use whichever field is used in `v_customer_ytd_rollup` to stay consistent. The software team should verify which field is authoritative before building this view.

**Refresh cadence:** Nightly.

---

---

### 3.8 `v_customer_csat` (future — Phase 2)

**Purpose:** One row per customer with a resolved CSAT score (0–100) and its source — enables persistence of rep-entered overrides beyond the browser's localStorage and makes CSAT queryable across reps.

**Background:** V2 ships with a client-side CSAT implementation. The score is derived from behavioral signals (order recency, YTD growth, pace vs. run-rate) and stored in the dashboard JavaScript as a 0–100 integer. Reps can override the derived score with their own assessment; that override is currently written to browser `localStorage` under the key `ks_csat_{custNo}`. This works for a single rep on a single machine but does not persist across devices or rep handoffs.

**Derived score logic** (must match `computeCSAT()` in `js/csat.js` exactly):

```
recency_component (0–40):
  days_since_order ≤ 14  → 40
  days_since_order ≤ 30  → 30
  days_since_order ≤ 45  → 20
  days_since_order ≤ 60  → 10
  days_since_order ≤ 90  → 5
  days_since_order > 90  → 0

growth_component (0–40):
  pct_change >= +0.15     → 40
  pct_change >= +0.05     → 32
  pct_change >= -0.05     → 24
  pct_change >= -0.15     → 12
  pct_change >= -0.30     → 4
  pct_change <  -0.30     → 0
  pct_change IS NULL      → 20  (neutral; no prior year data)

pace_component (0–20):
  pct_to_target >= 1.00   → 20
  pct_to_target >= 0.85   → 16
  pct_to_target >= 0.70   → 12
  pct_to_target >= 0.50   → 6
  pct_to_target <  0.50   → 0

derived_csat = recency_component + growth_component + pace_component
```

**Rep override table (new table required for Phase 2):**

```sql
CREATE TABLE customer_csat_overrides (
    cust_no        VARCHAR      NOT NULL PRIMARY KEY,
    override_score INT          NOT NULL CHECK (override_score BETWEEN 0 AND 100),
    set_by_rep     VARCHAR(100),
    updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Grain:** One row per `cust_no`.

**Required columns:**

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `cust_no` | VARCHAR | No | |
| `derived_score` | INT | No | Computed from `v_customer_ytd_rollup` signals |
| `override_score` | INT | Yes | Rep-entered value from `customer_csat_overrides` |
| `resolved_score` | INT | No | `COALESCE(override_score, derived_score)` |
| `score_source` | VARCHAR | No | `'rep'` or `'derived'` |
| `score_label` | VARCHAR | No | `'Excellent'` (≥80), `'Good'` (≥60), `'Fair'` (≥40), `'Poor'` (<40) |

**Suggested SQL:**

```sql
WITH derived AS (
    SELECT
        cust_no,
        -- recency component
        CASE
            WHEN days_since_order <= 14 THEN 40
            WHEN days_since_order <= 30 THEN 30
            WHEN days_since_order <= 45 THEN 20
            WHEN days_since_order <= 60 THEN 10
            WHEN days_since_order <= 90 THEN 5
            ELSE 0
        END +
        -- growth component
        CASE
            WHEN pct_change IS NULL      THEN 20
            WHEN pct_change >= 0.15      THEN 40
            WHEN pct_change >= 0.05      THEN 32
            WHEN pct_change >= -0.05     THEN 24
            WHEN pct_change >= -0.15     THEN 12
            WHEN pct_change >= -0.30     THEN 4
            ELSE 0
        END +
        -- pace component
        CASE
            WHEN pct_to_target >= 1.00   THEN 20
            WHEN pct_to_target >= 0.85   THEN 16
            WHEN pct_to_target >= 0.70   THEN 12
            WHEN pct_to_target >= 0.50   THEN 6
            ELSE 0
        END                              AS derived_score
    FROM v_customer_ytd_rollup
)
SELECT
    d.cust_no,
    d.derived_score,
    ov.override_score,
    COALESCE(ov.override_score, d.derived_score)  AS resolved_score,
    CASE WHEN ov.override_score IS NOT NULL THEN 'rep' ELSE 'derived' END AS score_source,
    CASE
        WHEN COALESCE(ov.override_score, d.derived_score) >= 80 THEN 'Excellent'
        WHEN COALESCE(ov.override_score, d.derived_score) >= 60 THEN 'Good'
        WHEN COALESCE(ov.override_score, d.derived_score) >= 40 THEN 'Fair'
        ELSE 'Poor'
    END                                           AS score_label
FROM derived d
LEFT JOIN customer_csat_overrides ov ON ov.cust_no = d.cust_no
```

**Refresh cadence:** Real-time view (joins from `v_customer_ytd_rollup` which refreshes nightly; override table is tiny and changes rarely). If `v_customer_ytd_rollup` is a materialized table rather than a live view, this can be a live view on top of it.

**Migration path from V2 localStorage:** When Phase 2 ships, the dashboard should offer a one-time migration that reads `ks_csat_*` keys from localStorage and POSTs them to a `/proxy/csat-override` endpoint that writes to `customer_csat_overrides`. After migration, localStorage is no longer the source of truth.

---

## 4. Data Points Needed but Not Yet in Any Computation

### 4.1 Customer Segment Label
The Customer Account tab header has a `segment` slot used in the AI context builder (`buildPromptContext`). This field is passed as `cust.segment || ''` — it is always empty because `customer.segment` is never set by the Counterpoint API or the proxy. Once `v_customer_segment_lookup` (Section 3.5) exists, the proxy's `/proxy/customer/:custNo` endpoint must be updated to join against it and return `segment_label` in the response object.

### 4.2 Monthly Sales Trend Chart
The Customer Account tab renders a chart panel for monthly sales trend. The chart panel container exists in the DOM and the chart area is allocated, but `renderCACharts` in `js/views/customer-account.js` does not populate it — no monthly data is fetched today. The data source would be `v_customer_monthly_sales` (Section 3.7). Both a new proxy endpoint and new chart rendering code are needed.

### 4.3 Actual Sales Targets per Customer
Today `target = priorYtd` throughout the codebase (see `customers.js` line 163: `const target = priorYtd;`). There is no actual quota or target in Counterpoint. The % to target progress bar on the Customer Account tab and the "Behind Target" KPI on the Account Performance tab both use this proxy. If Kellis ever defines per-customer annual targets, those would live in a new `customer_targets` table and `v_customer_ytd_rollup` would need to join to it, replacing `prior_ytd_sales` as the denominator for `pct_to_target`.

### 4.4 Weighted Average Sell Price and Cost
The dashboard's margin % on the Item Deep-Dive is `(avgSell - avgCost) / avgSell * 100`, where `avgSell` and `avgCost` are simple arithmetic means of the `price` and `unit_cost` fields on individual line rows. For items sold in variable quantities, a revenue-weighted average (`SUM(ext_price) / SUM(quantity)`) would be more accurate. This is a known analytical limitation preserved intentionally for the initial build. The suggested SQL in Section 3.3 matches current behavior.

### 4.5 Prior-Period Comparison for Item Deep-Dive (Level 3)
The Item Deep-Dive currently shows trailing 90/30/7-day KPI cards for the current period only. There is no prior-period comparison (e.g., "90-day revenue vs. same 90 days last year"). Adding this would require extending `v_item_sales_90d` with a `prior_year_daily_revenue` column, or a separate `v_item_sales_90d_prior` view covering `business_date` in the same 90-day window one year ago. Not yet requested; noted as a likely Phase 2 addition.

### 4.6 UPC and Pack Size on Recommended Items
The "Product List" modal on the Customer Account tab shows recommended items with UPC and pack size. The proxy tries multiple field names to find these: `upcCode`, `upc`, `upc1`, `primaryUpc` for UPC; `qtyPerCase`, `sellMult`, `caseQty`, `packSize` for pack size. In practice, these fields often return empty. The software team should confirm the canonical field names in the Counterpoint item master so the proxy can read them reliably.

### 4.7 Category-Level Item Rank History
The Item Performance Level 2 table ranks items by trailing 90-day revenue. The rank is computed fresh at query time — there is no stored rank or rank-change indicator. If the dashboard ever adds "this item moved from #7 to #3 this month," a `rank` column using `DENSE_RANK() OVER (PARTITION BY category_code ORDER BY rev_90d DESC)` in `v_item_kpis_90d` would need to be persisted daily. Not currently requested.

---

## 5. Performance Constraints and Assumptions

### Pages that must render in under 1 second (warm state)

| Use case | How it's achieved today | Expected behavior with DB views |
|---|---|---|
| Account Performance tab (warm cache) | 5-minute in-process cache hit | Single query to `v_customer_ytd_rollup WHERE sales_rep = ?` |
| Customer Account KPIs | `sales-by-category` is a fast Counterpoint endpoint | Single row lookup from `v_customer_ytd_rollup` |
| Leaderboard (warm cache) | 15-minute in-process cache hit | Single query to `v_rep_leaderboard` |

### Pages that can tolerate 3–5 seconds with a loading skeleton

| Use case | Current cold timing | Notes |
|---|---|---|
| Account Performance cold boot | 5–15s | Acceptable during transition period while DB views are being built |
| Item Performance Level 2 (category drill) | 2–6s | Acceptable; becomes instant once `v_item_kpis_90d` exists |
| Item Performance Level 3 (item stats + daily trend) | 1–3s | The daily array (90 rows of zeros + actuals) is the slow part |
| Customer Account tab (cold, all 4 parallel calls) | 1–3s | Acceptable |

### Batch-acceptable (user-triggered, no SLA)

| Use case | Notes |
|---|---|
| Leaderboard "Refresh" button | User explicitly requests fresh data; 5–10s is fine |
| All-categories cold load (before accounts cache is warm) | Shows a spinner; should rarely occur in production if nightly refresh runs |

### Current caching strategy and staleness tolerance

All caches below are **in-process** (lost on server restart) and **per Node instance** (not shared across load-balanced instances).

| Cache | TTL | Staleness tolerance | Replace with |
|---|---|---|---|
| `accountsCache` (per rep) | 5 min | Reps check at start of day — 5-min lag fine | Nightly `v_customer_ytd_rollup` refresh |
| `leaderboardCache` | 15 min | Leaderboard is motivational — 15-min lag fine | Nightly `v_rep_leaderboard` refresh |
| `allCatCache` (per rep) | 5 min | Same as accountsCache | Nightly `v_customer_category_ytd` + `v_territory_category_ytd` refresh |
| `catTopItemsCache` (per category) | 5 min | Item rankings don't change minute-to-minute | Nightly `v_item_kpis_90d` refresh |
| `itemStatsCache` (per itemNo) | 5 min | Item trend data doesn't need real-time | Nightly `v_item_sales_90d` refresh |
| `itemSearchCache` (per query string) | 2 min | Search autocomplete should feel fresh | Real-time query against item master; no pre-aggregation needed |
| `itemCatCache` (category items list) | 30 min | Item master rarely changes | Real-time query against item master |

---

## 6. What's Explicitly Out of Scope for This Handoff

- **API endpoint design:** The software team decides how the views are exposed — new REST endpoints, GraphQL, direct DB connection, extending the Counterpoint REST API, or any other approach. This document specifies only the data and the analytical logic.
- **Authentication and RBAC:** Currently the proxy uses a single shared `X-Api-Key`. Rep-level data isolation (ensuring a rep can only see their own accounts) is not implemented today. How authentication works in the database-backed version is the software team's call.
- **AI sales pitch logic:** The Claude AI integration stays in the proxy layer (`server/routes/ai.js`). The context it receives (`buildPromptContext` in `js/ai-prompt-config.js`) will benefit from the customer segment label becoming available (Section 4.1), but the AI logic itself requires no database-layer changes.
- **Frontend changes:** No frontend code changes are in scope for this handoff. The proxy endpoints remain stable; only the data source behind them changes. The one exception is the monthly sales trend chart (Section 4.2), which requires both a new proxy endpoint and new front-end chart code — but that feature is currently a placeholder, so it's a net-new addition rather than a change to existing behavior.
- **V1 references:** The original Kellis Sales Dashboard (v1 repo) is entirely separate and is not affected by this work.
- **Counterpoint schema DDL:** This document writes SQL against assumed table and column names derived from the Counterpoint REST API field names. The software team must map these to the actual Counterpoint database schema. The analytical logic is specified precisely; the physical schema mapping is not.
- **Data migration or backfill:** The `customer_segment_overrides` table (Section 3.5) is net-new. Populating it is a Kellis business operation — the software team creates the table and provides a way to edit it, but the segment labels themselves are defined by Kellis management.
