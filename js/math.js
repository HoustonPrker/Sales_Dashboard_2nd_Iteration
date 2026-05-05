// ============================================================
// MATH — normalCDF and percentile computation
// Uses globals: pipelineData, normalityMap (set by data-loader.js)
// ============================================================

function normalCDF(z) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return Math.round((0.5 * (1.0 + sign * y)) * 10000) / 100;
}

function computePercentile(item) {
  const normKey = `${item.CATEG_COD}|${item.SUBCAT_COD}`;
  const norm = normalityMap[normKey];
  const hasZ = item.Z_SCORE !== '' && item.Z_SCORE !== 'NULL' && item.Z_SCORE !== null
               && !isNaN(parseFloat(item.Z_SCORE));
  const peers = pipelineData.filter(
    i => i.CATEG_COD === item.CATEG_COD && i.SUBCAT_COD === item.SUBCAT_COD
  );
  if (peers.length <= 1) return { pct: 50, method: 'only item in sub-category' };

  // QTY-RANK items or items without a z-score → empirical on raw qty
  if (item.RANK_METHOD === 'QTY-RANK' || !hasZ) {
    const myQty = parseFloat(item.RAW_QTY_90D) || 0;
    const below = peers.filter(i => (parseFloat(i.RAW_QTY_90D) || 0) < myQty).length;
    return {
      pct: Math.round((below / Math.max(peers.length - 1, 1)) * 10000) / 100,
      method: 'empirical rank (fewer than 3 peers; using qty sold)'
    };
  }

  const myZ = parseFloat(item.Z_SCORE);

  // Normally distributed sub-category → Z-table CDF
  if (norm && norm.NORMAL === 'Yes') {
    return {
      pct: normalCDF(myZ),
      method: `Z-table CDF (Shapiro-Wilk W=${parseFloat(norm.W_STAT || 0).toFixed(4)}, p=${parseFloat(norm.P_VALUE || 0).toFixed(4)}, normal)`
    };
  }

  // Non-normal → empirical on z-scores
  const validPeers = peers.filter(i => !isNaN(parseFloat(i.Z_SCORE)));
  const below = validPeers.filter(i => parseFloat(i.Z_SCORE) < myZ).length;
  return {
    pct: Math.round((below / Math.max(validPeers.length - 1, 1)) * 10000) / 100,
    method: norm
      ? `empirical rank (Shapiro-Wilk W=${parseFloat(norm.W_STAT || 0).toFixed(4)}, p=${parseFloat(norm.P_VALUE || 0).toFixed(4)}, non-normal)`
      : 'empirical rank (sub-category not in normality results)'
  };
}
