// ============================================================
// AI Prompt Configuration — Kellis Sales
// ============================================================

const SYSTEM_PROMPT = `You are a sales intelligence assistant for Kellis gift shop distribution reps.
Your job is to help reps prepare for and think through customer conversations by analyzing purchasing patterns and identifying opportunities.

On the first message (account brief), respond in two clearly labeled sections. Be extremely concise — this is a quick pre-call glance, not a full report.

**ACCOUNT SUMMARY**
Exactly 4 bullet points. Cover: overall health, YTD trajectory, recency of orders, and one standout fact.

**SALES STRATEGY**
Exactly 4 bullet points. Each is one specific, actionable thing the rep should say or push in the next call. No fluff.

After your Sales Strategy, end with a line break followed by **What would you like to explore?** and a numbered list of 3 follow-up options tailored to this account.

On follow-up messages, answer conversationally and helpfully. When it makes sense, end your reply with 2–3 numbered follow-up options so the conversation can continue naturally. Don't force options if the answer is complete.

When asked to draft an email, output the email in this exact format (no deviations):
SUBJECT: <subject line here>
BODY:
<email body here>
END_EMAIL
Place this block at the end of your response, after any intro text.

When asked to schedule, add, or create a calendar event or meeting, output the event in this exact format:
CALENDAR_EVENT:
TITLE: <event title>
DATE: <YYYY-MM-DD>
TIME: <HH:MM> (24-hour, use 09:00 if not specified)
DURATION: <minutes, default 60>
NOTES: <brief description or agenda>
END_CALENDAR
If the user does not specify a date or time, make a reasonable suggestion and confirm it in your response text. Place this block at the end of your response.

Be specific and data-driven. Use dollar amounts and percentages from the data. Keep the tone professional but conversational — like a smart colleague briefing the rep before a sales call.`;

function buildPromptContext(cust, catData, mtd) {
  const name      = cust.name || cust.custNo || 'Unknown';
  const custNo    = cust.custNo || '';
  const state     = cust.state || '—';
  const salesRep  = cust.salesRep || '—';
  const segment   = cust.categoryCode || '—';
  const lastSale  = cust.lastSaleDate ? cust.lastSaleDate.slice(0, 10) : '—';
  const daysSince = lastSale !== '—'
    ? Math.floor((Date.now() - new Date(lastSale)) / 86400000)
    : null;

  const ytdTotal   = catData.reduce((s, c) => s + c.currentYtdAmt, 0);
  const priorTotal = catData.reduce((s, c) => s + c.priorYtdAmt,   0);
  const pctChange  = priorTotal > 0 ? ((ytdTotal - priorTotal) / priorTotal * 100).toFixed(1) : null;
  const mtdTotal   = mtd?.total || 0;

  const topCats = [...catData]
    .sort((a, b) => b.currentYtdAmt - a.currentYtdAmt)
    .slice(0, 6)
    .map(c => {
      const chg = c.priorYtdAmt > 0
        ? ((c.currentYtdAmt - c.priorYtdAmt) / c.priorYtdAmt * 100).toFixed(1)
        : null;
      return `  - ${c.description || c.categoryCode}: $${c.currentYtdAmt.toFixed(0)} YTD` +
             (chg !== null ? ` (${parseFloat(chg) >= 0 ? '+' : ''}${chg}% vs prior)` : ' (no prior year data)');
    }).join('\n');

  const decliningCats = catData
    .filter(c => c.priorYtdAmt > 0 && c.currentYtdAmt < c.priorYtdAmt * 0.8)
    .sort((a, b) => (a.currentYtdAmt / a.priorYtdAmt) - (b.currentYtdAmt / b.priorYtdAmt))
    .slice(0, 3)
    .map(c => `  - ${c.description || c.categoryCode}: $${c.currentYtdAmt.toFixed(0)} vs $${c.priorYtdAmt.toFixed(0)} prior (-${((1 - c.currentYtdAmt/c.priorYtdAmt)*100).toFixed(0)}%)`)
    .join('\n');

  return `Customer Account Brief — ${name} (${custNo})

ACCOUNT DETAILS:
- State: ${state}
- Sales Rep: ${salesRep}
- Segment: ${segment}
- Last Order: ${lastSale}${daysSince !== null ? ` (${daysSince} days ago)` : ''}

YEAR-TO-DATE PERFORMANCE:
- YTD Sales: $${ytdTotal.toFixed(0)}
- Prior YTD (same period last year): $${priorTotal.toFixed(0)}
- YTD Change: ${pctChange !== null ? (parseFloat(pctChange) >= 0 ? '+' : '') + pctChange + '%' : 'N/A'}
- Month-to-Date: $${mtdTotal.toFixed(0)}
- Target (prior same period): $${priorTotal.toFixed(0)}
- % to Target: ${priorTotal > 0 ? (ytdTotal / priorTotal * 100).toFixed(1) + '%' : 'N/A'}

TOP CATEGORIES (by YTD sales):
${topCats || '  No category data available'}

${decliningCats ? `DECLINING CATEGORIES (>20% drop vs prior):\n${decliningCats}` : ''}

Generate an Account Summary and Sales Pitch for this rep's next call.`;
}
