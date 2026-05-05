// ============================================================
// CHARTS — Chart.js rendering
// Uses globals: activeCharts, pipelineData
// ============================================================

let _trendView    = 'daily'; // 'daily' | 'weekly'
let _lastTrendItem = null;   // item object saved for re-render on toggle

function destroyCharts() {
  Object.values(activeCharts).forEach(c => { try { c.destroy(); } catch (_) {} });
  activeCharts = {};
}

function setTrendView(view) {
  _trendView = view;
  document.querySelectorAll('.trend-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`trend-btn-${view}`);
  if (btn) btn.classList.add('active');
  if (_lastTrendItem) renderTrendChart(_lastTrendItem);
}

function aggregateWeekly(daily) {
  // Group daily data into calendar weeks (Mon–Sun), summing qty and amt
  const weeks = {};
  daily.labels.forEach((lbl, i) => {
    const d   = new Date(lbl);
    const day = d.getDay();
    const diff = (day === 0 ? -6 : 1 - day);
    const mon = new Date(d);
    mon.setDate(d.getDate() + diff);
    const key = mon.toISOString().slice(0, 10);
    if (!weeks[key]) weeks[key] = { qty: 0, amt: 0 };
    weeks[key].qty += daily.qty[i];
    weeks[key].amt += daily.amt[i];
  });
  const keys = Object.keys(weeks).sort();
  return {
    labels: keys.map(k => {
      const d = new Date(k + 'T00:00:00');
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }),
    qty: keys.map(k => weeks[k].qty),
    amt: keys.map(k => weeks[k].amt),
  };
}

function renderTrendChart(item) {
  _lastTrendItem = item;
  const daily  = getDailySalesForItem(item.ITEM_NO);
  const isWeek = _trendView === 'weekly';
  const data   = isWeek ? aggregateWeekly(daily) : daily;

  // Destroy existing trend chart only
  if (activeCharts.trend) { try { activeCharts.trend.destroy(); } catch (_) {} delete activeCharts.trend; }

  const trendEl = document.getElementById('chart-trend');
  if (!trendEl) return;

  if (daily.qty.every(v => v === 0)) {
    trendEl.style.display = 'none';
    // Remove old message if present
    const old = trendEl.parentNode.querySelector('.no-data-msg');
    if (old) old.remove();
    const msg = document.createElement('div');
    msg.className = 'no-data-msg';
    msg.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:#9ca3af;font-size:13px';
    msg.textContent = 'No daily sales data available for this item.';
    trendEl.parentNode.appendChild(msg);
    return;
  }

  trendEl.style.display = '';
  const old = trendEl.parentNode.querySelector('.no-data-msg');
  if (old) old.remove();

  activeCharts.trend = new Chart(trendEl.getContext('2d'), {
    type: isWeek ? 'bar' : 'line',
    data: {
      labels: data.labels,
      datasets: [{
        data: data.qty,
        borderColor: '#0d9488',
        backgroundColor: 'rgba(13,148,136,0.08)',
        borderWidth: isWeek ? 1.5 : 1.5,
        fill: true,
        tension: 0.1,
        pointRadius: 0,
        pointHoverRadius: 3,
        borderRadius: 0,
      }]
    },
    options: {
      ...baseOpts,
      scales: {
        x: {
          ticks: { font: { size: 9, family: 'SF Mono, monospace' }, maxTicksLimit: isWeek ? 13 : 13, maxRotation: 0 },
          grid: { color: 'rgba(0,0,0,0.04)' }
        },
        y: {
          ticks: { font: { size: 9, family: 'SF Mono, monospace' }, maxTicksLimit: 5 },
          grid: { color: 'rgba(0,0,0,0.04)' },
          beginAtZero: true
        }
      }
    }
  });
}

const baseOpts = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      bodyFont: { family: 'SF Mono, Fira Code, monospace' },
      titleFont: { family: 'SF Mono, Fira Code, monospace' }
    }
  }
};

function renderCharts(item, qty90) {
  const qty12m    = parseFloat(item.RAW_QTY_12M_TOTAL) || 0;
  const stksW     = parseInt(item.STORES_WITH_STOCK)   || 0;
  const maxStores = Math.max(
    pipelineData.reduce((m, i) => Math.max(m, parseInt(i.STORE_COUNT) || 0), 0),
    stksW
  );
  const stksOut  = Math.max(0, maxStores - stksW);
  const expected = qty12m / 4;

  // ── 1. 90-Day Trend (daily or weekly) ───────────────────────
  renderTrendChart(item);

  // ── 2. Store Stock Doughnut ──────────────────────────────────
  const centerText = {
    id: 'doughnutCenter',
    beforeDraw(chart) {
      const { width, height, ctx } = chart;
      ctx.save();
      const text    = `${stksW} of ${maxStores}`;
      const subText = 'stores';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      const cx = width / 2;
      const cy = height / 2 - 10;
      ctx.font = `700 15px Inter, sans-serif`;
      ctx.fillStyle = '#1a2332';
      ctx.fillText(text, cx, cy);
      ctx.font = `12px Inter, sans-serif`;
      ctx.fillStyle = '#6b7280';
      ctx.fillText(subText, cx, cy + 18);
      ctx.restore();
    }
  };

  activeCharts.pie = new Chart(
    document.getElementById('chart-stores').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: [`With Stock (${stksW})`, `Without Stock (${stksOut})`],
      datasets: [{
        data: [stksW, stksOut],
        backgroundColor: ['#0d9488', '#d1d5db'],
        borderColor: ['#fff', '#fff'],
        borderWidth: 2
      }]
    },
    options: {
      ...baseOpts,
      plugins: {
        legend: {
          display: true, position: 'bottom',
          labels: { font: { size: 12, family: 'Inter, sans-serif' }, boxWidth: 12, padding: 8 }
        },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}` } }
      },
      cutout: '55%'
    },
    plugins: [centerText]
  });

  // ── 3. Actual vs Expected Bar ────────────────────────────────
  const velColor = qty90 >= expected ? '#0d9488' : '#dc2626';
  activeCharts.compare = new Chart(
    document.getElementById('chart-compare').getContext('2d'), {
    type: 'bar',
    data: {
      labels: ['Actual', 'Expected'],
      datasets: [{
        data: [qty90, Math.round(expected)],
        backgroundColor: [velColor, '#d1d5db'],
        borderColor: [velColor === '#0d9488' ? '#0f766e' : '#991b1b', '#9ca3af'],
        borderWidth: 1
      }]
    },
    options: {
      ...baseOpts,
      scales: {
        x: {
          ticks: { font: { size: 10, family: 'SF Mono, monospace' } },
          grid: { display: false }
        },
        y: {
          ticks: { font: { size: 9, family: 'SF Mono, monospace' }, maxTicksLimit: 5 },
          grid: { color: 'rgba(0,0,0,0.04)' },
          beginAtZero: true
        }
      },
      plugins: {
        ...baseOpts.plugins,
        tooltip: {
          callbacks: { label: ctx => ` ${fmtQty(ctx.parsed.y)} units` }
        }
      }
    }
  });
}
