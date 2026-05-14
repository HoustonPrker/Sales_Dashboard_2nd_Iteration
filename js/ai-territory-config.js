// ============================================================
// TERRITORY AI — System prompt + context builder
// Used by the Account Performance AI drawer (territory briefing)
// ============================================================

const TERRITORY_SYSTEM_PROMPT = `You are an AI sales analyst helping a B2B sales rep understand their territory performance and plan effectively. You have access to real-time data from their sales platform.

ROLE:
- Provide a clear, prioritized territory briefing every morning (or on demand)
- Identify which accounts need attention today, what is working, and what is not
- Surface actionable insights the rep can act on this week

RULES — FOLLOW STRICTLY:
- Base ALL analysis ONLY on the data provided in the user message — NEVER invent, estimate, or hallucinate numbers not given to you
- Do NOT recalculate provided metrics — use them as-is (they were pre-computed server-side)
- If data is missing or insufficient to answer, say so explicitly
- Dollar amounts: use $ prefix and comma formatting (e.g. $12,450)
- Percentages: round to 1 decimal place

RESPONSE FORMAT — Territory Briefing:
Structure every initial briefing in this exact order:

**Territory Pulse**
2–3 sentence summary of overall territory health. Hit the most important KPI signals. Be direct.

**Today's Priorities**
Numbered list of 3–5 specific accounts or actions the rep should focus on TODAY. For each: name the account, state why it is a priority, suggest a concrete action.

**What's Working**
Bullet points (2–4) of positive signals in the territory. Name specific accounts or trends.

**What Isn't Working**
Bullet points (2–4) of concerns or risks. Name specific accounts or patterns.

End every response (briefing or follow-up) with exactly 2–3 numbered follow-up questions the rep is likely to want to ask next. Label this section "**What would you like to dig into?**"

TONE: Direct, concise, actionable. Think sharp sales manager, not academic report. Avoid filler phrases like "Great question!" or "Certainly!".`;


function buildTerritoryContext(accountsData, overviewData, repName) {
  if (!accountsData || !overviewData) return 'Territory data not available.';

  const now   = new Date();
  const yr    = now.getFullYear();
  const mm    = String(now.getMonth() + 1).padStart(2, '0');
  const dd    = String(now.getDate()).padStart(2, '0');
  const today = `${yr}-${mm}-${dd}`;

  const fmt$ = v => '$' + (v || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtPct = v => (v * 100).toFixed(1) + '%';

  const d   = overviewData;
  const m   = d.monthly || {};
  const avg = d.avg     || {};
  const mr  = d.monthRunRate || {};

  // ── Territory overview ───────────────────────────────────────
  const totalAccts     = accountsData.length;
  const activeAccts    = m.activeAccounts || 0;
  const mtdActiveAccts = m.mtdActiveAccounts || 0;

  const tierCounts = { Healthy: 0, Attention: 0, AtRisk: 0, Critical: 0 };
  accountsData.forEach(a => { if (tierCounts[a.tier] !== undefined) tierCounts[a.tier]++; });

  const totalYtd        = accountsData.reduce((s, a) => s + (a.ytdSales    || 0), 0);
  const totalPriorYtd   = accountsData.reduce((s, a) => s + (a.priorYtd   || 0), 0);
  const totalAnnualTgt  = accountsData.reduce((s, a) => s + ((a.pyFullYear || 0) * 1.05), 0);
  const totalMonthGoal  = accountsData.reduce((s, a) => s + (a.monthGoal   || 0), 0);
  const totalBsUnits    = accountsData.reduce((s, a) => s + (a.bsUnits     || 0), 0);
  const totalAllUnits   = accountsData.reduce((s, a) => s + (a.totalUnits  || 0), 0);

  const ytdVsPrior  = totalPriorYtd > 0 ? ((totalYtd - totalPriorYtd) / totalPriorYtd * 100).toFixed(1) : null;
  const annualPct   = totalAnnualTgt > 0 ? (totalYtd / totalAnnualTgt * 100).toFixed(1) : null;
  const bsPct       = totalAllUnits  > 0 ? (totalBsUnits / totalAllUnits * 100).toFixed(1) : null;
  const mtdPct      = totalMonthGoal > 0 ? (m.mtd / totalMonthGoal * 100).toFixed(1) : null;

  // ── Top 10 accounts by YTD ───────────────────────────────────
  const top10 = [...accountsData]
    .sort((a, b) => (b.ytdSales || 0) - (a.ytdSales || 0))
    .slice(0, 10);

  // ── At-risk + critical accounts ──────────────────────────────
  const atRiskCritical = accountsData
    .filter(a => a.tier === 'AtRisk' || a.tier === 'Critical')
    .sort((a, b) => (b.ytdSales || 0) - (a.ytdSales || 0));

  // ── Attention accounts ───────────────────────────────────────
  const attentionAccts = accountsData
    .filter(a => a.tier === 'Attention')
    .sort((a, b) => (b.ytdSales || 0) - (a.ytdSales || 0))
    .slice(0, 10);

  // ── Active but not ordered MTD ───────────────────────────────
  const notOrderedMTD = accountsData
    .filter(a => (a.daysSince || 999) <= 180 && (a.daysSince || 999) > 0)
    .sort((a, b) => (b.ytdSales || 0) - (a.ytdSales || 0))
    .slice(0, 15);

  // ── YTD losers (pctChange < -10%) ────────────────────────────
  const declining = accountsData
    .filter(a => (a.priorYtd || 0) > 1000 && (a.pctChange || 0) < -0.10)
    .sort((a, b) => (a.pctChange || 0) - (b.pctChange || 0))
    .slice(0, 10);

  // ── Build text ───────────────────────────────────────────────
  const acctRow = a => {
    const chg = a.priorYtd > 0
      ? ((a.ytdSales - a.priorYtd) / a.priorYtd * 100).toFixed(1) + '%'
      : 'N/A';
    return `  - ${a.name} (${a.custNo}) | YTD: ${fmt$(a.ytdSales)} | PY: ${fmt$(a.priorYtd)} | Chg: ${chg} | Tier: ${a.tier} | Last order: ${a.lastOrder || 'N/A'} (${a.daysSince ?? '?'} days ago)`;
  };

  const lines = [];
  lines.push(`TERRITORY BRIEFING — ${today} (Rep: ${repName || 'unknown'})`);
  lines.push('');

  lines.push('=== TERRITORY OVERVIEW ===');
  lines.push(`Date: ${today}`);
  lines.push(`Total accounts: ${totalAccts} | Active (180 days): ${activeAccts} | Ordered MTD: ${mtdActiveAccts}`);
  lines.push(`Health tiers: Healthy ${tierCounts.Healthy} | Attention ${tierCounts.Attention} | At Risk ${tierCounts.AtRisk} | Critical ${tierCounts.Critical}`);
  lines.push('');
  lines.push(`YTD Sales: ${fmt$(totalYtd)}${ytdVsPrior !== null ? ` (${ytdVsPrior}% vs prior YTD)` : ''}`);
  lines.push(`Annual Target: ${totalAnnualTgt > 0 ? fmt$(totalAnnualTgt) : 'N/A'}${annualPct !== null ? ` | % to Target: ${annualPct}%` : ''}`);
  lines.push(`Monthly Goal: ${fmt$(totalMonthGoal)} | MTD: ${fmt$(m.mtd || 0)}${mtdPct !== null ? ` (${mtdPct}% of goal)` : ''}`);
  lines.push(`Remaining business days in month: ${m.remainingBusinessDays ?? 'N/A'} | Daily needed to hit goal: ${m.remainingBusinessDays > 0 && (totalMonthGoal - (m.mtd || 0)) > 0 ? fmt$((totalMonthGoal - (m.mtd || 0)) / m.remainingBusinessDays) : '—'}`);
  lines.push(`Month run rate: ${mr.pctElapsed != null ? mr.pctElapsed.toFixed(1) + '%' : 'N/A'} elapsed (${mr.elapsed ?? '?'} of ${mr.total ?? '?'} biz days)`);
  lines.push(`Year run rate: ${d.yearRunRate != null ? (d.yearRunRate * 100).toFixed(1) + '%' : 'N/A'} (${d.businessDaysElapsed ?? '?'} of ${d.businessDaysTotal ?? '?'} days elapsed)`);
  lines.push(`Best Seller % (lines): ${bsPct !== null ? bsPct + '%' : 'N/A'} (${totalBsUnits.toLocaleString()} BS lines / ${totalAllUnits.toLocaleString()} total lines)`);
  lines.push(`Avg Ticket: ${fmt$(avg.ticketCurrent)} (PY: ${fmt$(avg.ticketPrior)}) | Avg Lines: ${(avg.linesCurrent || 0).toFixed(1)} (PY: ${(avg.linesPrior || 0).toFixed(1)})`);
  lines.push('');

  lines.push('=== TOP 10 ACCOUNTS BY YTD SALES ===');
  top10.forEach(a => lines.push(acctRow(a)));
  lines.push('');

  lines.push('=== AT-RISK & CRITICAL ACCOUNTS ===');
  if (atRiskCritical.length === 0) {
    lines.push('  (none)');
  } else {
    atRiskCritical.forEach(a => lines.push(acctRow(a)));
  }
  lines.push('');

  lines.push('=== ATTENTION ACCOUNTS (top 10 by YTD) ===');
  if (attentionAccts.length === 0) {
    lines.push('  (none)');
  } else {
    attentionAccts.forEach(a => lines.push(acctRow(a)));
  }
  lines.push('');

  lines.push('=== ACTIVE ACCOUNTS — NOT YET ORDERED THIS MONTH (top 15 by YTD) ===');
  if (notOrderedMTD.length === 0) {
    lines.push('  (all active accounts have ordered MTD)');
  } else {
    notOrderedMTD.forEach(a => lines.push(acctRow(a)));
  }
  lines.push('');

  lines.push('=== MOST DECLINED ACCOUNTS YTD (>10% down, >$1k prior YTD) ===');
  if (declining.length === 0) {
    lines.push('  (none with >10% decline)');
  } else {
    declining.forEach(a => lines.push(acctRow(a)));
  }
  lines.push('');

  lines.push('---');
  lines.push('DATA DICTIONARY:');
  lines.push('YTD = Jan 1 to today current year | PY = same Jan 1 to today prior year | Tier = Healthy/Attention/AtRisk/Critical based on order frequency, pace, and trend signals | Best Seller lines = order lines with profCod1=Y flagged items');
  lines.push('');
  lines.push('Please provide the territory briefing now.');

  return lines.join('\n');
}
