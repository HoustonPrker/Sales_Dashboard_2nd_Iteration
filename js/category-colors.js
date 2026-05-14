// ============================================================
// CATEGORY_COLORS — vivid categorical palette, shared across all charts
// SEQUENTIAL_BLUE — single-hue gradient for time-series charts
// ============================================================

const CATEGORY_COLORS = {
  'HBA':             '#1E5FCC',
  'HEALTH & BEAUTY': '#1E5FCC',
  'HEALTH':          '#1E5FCC',
  'FASHION':         '#FF6B1A',
  'FASHN':           '#FF6B1A',
  'CANDY':           '#E8244C',
  'PLUSH':           '#00B8A9',
  'INSPIRATIONAL':   '#22C55E',
  'KELLILOON':       '#FFC107',
  'SEASONAL':        '#A855F7',
  'KGS SEASONAL':    '#A855F7',
  'GIFTS':           '#EC4899',
  'HOMEOFFICE':      '#B45309',
  'HOME OFFICE':     '#B45309',
  'HOME & OFFICE':   '#B45309',
  'ELECTRONICS':     '#0EA5E9',
  'ELECTRONIC':      '#0EA5E9',
  'BABY':            '#7DD3FC',
  'TOYS':            '#FACC15',
  'BALLOON':         '#10D982',
  'BALLOONS':        '#10D982',
  'BALLOON WTS':     '#86EFAC',
  'BOUQUET':         '#FB7185',
  'CHANGEMAKER':     '#7C3AED',
  'KGS CHANGEMAKER': '#5B21B6',
  'KGS CHANGEMAKERS':'#5B21B6',
  'KELCHNGMKR':      '#5B21B6',
  'FIXTURES':        '#64748B',
  'ANNOUNCEMENT':    '#F59E0B',
  'HOME DÉCOR':      '#D97706',
  'HOME DECOR':      '#D97706',
  'OTHER':           '#94A3B8',
};

// Light → dark blue for sequential (time-series) charts
const SEQUENTIAL_BLUE = [
  '#93C5FD', '#60A5FA', '#3B82F6',
  '#2563EB', '#1D4ED8', '#1E40AF',
];

const FALLBACK_COLOR = '#94A3B8';

function getCategoryColor(categoryName) {
  const key = (categoryName || '').toUpperCase().trim();
  return CATEGORY_COLORS[key] || FALLBACK_COLOR;
}

function getSequentialColor(index) {
  return SEQUENTIAL_BLUE[Math.min(index, SEQUENTIAL_BLUE.length - 1)];
}
