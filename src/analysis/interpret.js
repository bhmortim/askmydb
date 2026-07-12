'use strict';

// Reduce a computed analysis to (a) a compact "stat card" of labeled numbers
// for direct UI rendering and (b) an LLM narration context. The context carries
// ONLY the reduced card + caveats + question — never raw rows and never any
// arithmetic — so a small model has nothing to hallucinate from and can only
// narrate the numbers JS already computed.

function num(v, digits = 3) {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '—';
  if (typeof v !== 'number') return String(v);
  if (Number.isInteger(v)) return v.toLocaleString('en-US');
  return (Math.round(v * 10 ** digits) / 10 ** digits).toLocaleString('en-US', { maximumFractionDigits: digits });
}
function pval(p) {
  if (typeof p !== 'number' || !Number.isFinite(p)) return '—';
  return p < 0.0001 ? '< 0.0001' : num(p, 4);
}

/** Build a display card: { title, headline:[{label,value}], detail:[{label,value}], chart? }. */
function buildStatCard(kind, result, profile) {
  const H = (label, value) => ({ label, value });
  switch (kind) {
    case 'pearson':
    case 'spearman': {
      const rLabel = kind === 'spearman' ? 'ρ (Spearman)' : 'r (Pearson)';
      return {
        title: result.error ? 'Correlation' : `${cap(result.strength)} ${result.direction} correlation`,
        headline: [H(rLabel, num(result.r ?? result.rho, 3)), H('p-value', pval(result.p)), H('n', num(result.n))],
        detail: [H('R²', num(result.r2, 3)), H('95% CI', result.ci ? `[${num(result.ci[0], 3)}, ${num(result.ci[1], 3)}]` : '—')],
        chart: 'scatter'
      };
    }
    case 'linearRegression':
      return {
        title: 'Linear regression',
        headline: [H('slope', num(result.slope, 4)), H('p (slope)', pval(result.pSlope)), H('R²', num(result.r2, 3))],
        detail: [H('intercept', num(result.intercept, 4)), H('equation', result.equation), H('n', num(result.n))],
        chart: 'scatter'
      };
    case 'multipleRegression':
      return {
        title: 'Multiple regression',
        headline: [H('R²', num(result.r2, 3)), H('adj R²', num(result.adjR2, 3)), H('F p-value', pval(result.fPValue))],
        detail: (result.coefficients || []).map((c) => H(c.name, `${num(c.estimate, 3)} (p=${pval(c.p)})`)),
        chart: null
      };
    case 'twoSampleT':
      return {
        title: 'Two-group comparison (t-test)',
        headline: [H('mean A', num(result.meanA)), H('mean B', num(result.meanB)), H('p-value', pval(result.p))],
        detail: [H('difference', num(result.diff)), H("Cohen's d", num(result.cohensD, 2)), H('df', num(result.df, 1))],
        chart: 'groupCompare'
      };
    case 'anova':
      return {
        title: 'Group comparison (one-way ANOVA)',
        headline: [H('F', num(result.f, 3)), H('p-value', pval(result.p)), H('groups', num(result.k))],
        detail: [H('η² (effect size)', num(result.etaSquared, 3)), H('df', `${result.dfBetween}, ${result.dfWithin}`)],
        chart: 'groupCompare'
      };
    case 'chiSquare':
      return {
        title: 'Association (chi-square)',
        headline: [H('χ²', num(result.chi2, 3)), H('p-value', pval(result.p)), H('df', num(result.df))],
        detail: [H("Cramér's V", num(result.cramersV, 3)), H('min expected', num(result.minExpected, 2))],
        chart: null
      };
    case 'trend':
      return {
        title: `Trend: ${result.direction}`,
        headline: [H('slope (Theil–Sen)', num(result.theilSenSlope, 4)), H('p (Mann–Kendall)', pval(result.mannKendallP)), H('R²', num(result.r2, 3))],
        detail: [H('OLS slope', num(result.olsSlope, 4)), H('n', num(result.n))],
        chart: 'line'
      };
    case 'describe':
      return {
        title: 'Distribution summary',
        headline: [H('mean', num(result.mean)), H('median', num(result.median)), H('std dev', num(result.stdDev))],
        detail: [H('min', num(result.min)), H('Q1', num(result.q1)), H('Q3', num(result.q3)), H('max', num(result.max)),
          H('skew', num(result.skewness, 2)), H('n', num(result.n))],
        chart: 'histogram'
      };
    case 'outliers':
      return {
        title: 'Outlier scan',
        headline: [H('outliers', num(result.count)), H('of n', num(result.n)), H('proportion', num(result.proportion, 3))],
        detail: [H('lower fence', num(result.lowFence)), H('upper fence', num(result.highFence)), H('IQR', num(result.iqr))],
        chart: 'histogram'
      };
    case 'correlationMatrix':
      return {
        title: 'Correlation matrix',
        headline: [H('variables', num((result.names || []).length))],
        detail: strongestPairs(result).map((s) => H(s.pair, `r=${num(s.r, 2)}`)),
        chart: 'heatmap'
      };
    default:
      return { title: kind, headline: [], detail: [], chart: null };
  }
}

function strongestPairs(result) {
  const out = [];
  const { names, matrix } = result;
  if (!names || !matrix) return out;
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (Number.isFinite(matrix[i][j])) out.push({ pair: `${names[i]} × ${names[j]}`, r: matrix[i][j] });
    }
  }
  return out.sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, 5);
}

/** Render a stat card as compact text for the LLM prompt. */
function statCardToText(card) {
  const lines = [card.title];
  for (const h of card.headline) lines.push(`${h.label}: ${h.value}`);
  for (const dt of card.detail) lines.push(`${dt.label}: ${dt.value}`);
  return lines.join('\n');
}

/**
 * Build the LLM interpretation context. Returns { card, statText, caveats }.
 * The route hands statText + caveats + question to the model — no raw rows.
 */
function buildInterpretationContext(kind, result, profile, audit, question) {
  const card = buildStatCard(kind, result, profile);
  return {
    card,
    statText: statCardToText(card),
    caveats: (audit && audit.caveats ? audit.caveats : []).map((c) => c.message),
    question: String(question || '')
  };
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

module.exports = { buildStatCard, buildInterpretationContext, statCardToText };
