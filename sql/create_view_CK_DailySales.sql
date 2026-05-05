-- ============================================================
-- CK ANALYTICS — CREATE VIEW vw_CK_DailySales
--
-- Purpose:
--   Provides the 90-day daily sales trend data used by the
--   CK Analytics Dashboard (90-Day Sales Trend chart and
--   30D / 7D KPI cards on the Item Zoom tab).
--
--   The dashboard fetches rows from:
--     GET /api/v1/tables/vw_CK_DailySales/rows
--       ?filter=ITEM_NO:eq:4000
--       &pageSize=200
--
-- Notes:
--   • Covers the last 90 days of sales lines.
--   • Excludes stores HQ and 100 (warehouse/internal).
--   • Includes only sale lines (LIN_TYP = 'S').
--   • ITEM_NO values are trimmed to remove leading/trailing spaces.
--   • The dashboard groups rows by ITEM_NO + POST_DATE client-side.
--
-- Run once in SSMS against the Counterpoint company database.
-- ============================================================

IF OBJECT_ID('dbo.vw_CK_DailySales', 'V') IS NOT NULL
    DROP VIEW dbo.vw_CK_DailySales;
GO

CREATE VIEW dbo.vw_CK_DailySales AS

SELECT
    RTRIM(LTRIM(l.ITEM_NO))   AS ITEM_NO,
    l.BUS_DAT                 AS POST_DATE,
    SUM(l.QTY_SOLD)           AS QTY_SOLD,
    SUM(l.EXT_PRC)            AS EXT_PRC

FROM dbo.PS_TKT_HIST_LIN l
    INNER JOIN dbo.PS_TKT_HIST h
        ON h.DOC_ID = l.DOC_ID

WHERE l.BUS_DAT >= DATEADD(DAY, -90, CAST(GETDATE() AS DATE))
  AND l.STR_ID   NOT IN ('HQ', '100')
  AND l.LIN_TYP  = 'S'
  AND l.CATEG_COD IN (
        'BABY', 'BALLOONS', 'COMFORT', 'DRINKWARE',
        'ELECTRONIC', 'FASHION', 'GAMES', 'GIFT BAG',
        'GIFTS', 'GREETCARD', 'HBA', 'INSPR',
        'KELLILOON', 'LOGOWEAR', 'MENS', 'NURSE',
        'PLUSH', 'SEASONAL', 'SNACKS', 'TOYS', 'WRITING'
  )

GROUP BY
    RTRIM(LTRIM(l.ITEM_NO)),
    l.BUS_DAT;

GO

-- ============================================================
-- VERIFICATION
-- ============================================================
-- SELECT COUNT(*)   AS total_rows  FROM dbo.vw_CK_DailySales;
-- SELECT TOP 10 *   FROM dbo.vw_CK_DailySales ORDER BY POST_DATE DESC;
-- SELECT TOP 10 *   FROM dbo.vw_CK_DailySales WHERE ITEM_NO = '4000' ORDER BY POST_DATE;
