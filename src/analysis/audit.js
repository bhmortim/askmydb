'use strict';

// Statistical guardrails. After an analysis runs, auditAnalysis attaches graded
// caveats (info / warn / strong) so the result is never presented as more
// certain than the data supports. These caveats are rendered directly in the UI
// AND injected verbatim into the LLM interpretation prompt, so the model cannot
// silently drop a small-n or causation warning.

const { clean, skewness, kurtosis } = require('../stats/descriptive');
const { chiSquareCdf } = require('../stats/distributions');

const CAUSATION = 'Correlation/association here does not establish causation.';

/**
 * @param kind     analysis kind
 * @param result   the analysis result object
 * @param profile  the column profile (optional but recommended)
 * @param opts     { alpha=0.05, comparisons=1, sampleForNormality=[] }
 * @returns { caveats: [{level, code, message}], trustworthy }
 */
function auditAnalysis(kind, result, profile = null, opts = {}) {
  const alpha = opts.alpha ?? 0.05;
  const comparisons = opts.comparisons ?? 1;
  const caveats = [];
  const add = (level, code, message) => caveats.push({ level, code, message });

  if (result && result.error) {
    add('strong', 'error', result.error);
    return { caveats, trustworthy: false };
  }

  const n = result.n ?? result.N ?? (profile && profile.nRows) ?? null;

  // small sample
  if (n != null) {
    if (n < 8) add('strong', 'small-n', `Very small sample (n=${n}); statistics are unstable and p-values unreliable.`);
    else if (n < 30) add('warn', 'small-n', `Small sample (n=${n}); interpret with caution.`);
  }

  // causation for relational analyses
  if (['pearson', 'spearman', 'correlationMatrix', 'linearRegression', 'multipleRegression', 'chiSquare'].includes(kind)) {
    add('info', 'causation', CAUSATION);
  }

  // borderline p-value
  const p = result.p ?? result.pSlope ?? result.fPValue ?? result.mannKendallP;
  if (typeof p === 'number' && Number.isFinite(p)) {
    if (p > alpha && p < alpha * 2) add('warn', 'borderline', `p=${fmt(p)} is only marginally non-significant at α=${alpha}.`);
    if (p <= alpha && p > alpha / 5) add('info', 'weak-evidence', `p=${fmt(p)} is significant but not strong evidence.`);
  }

  // multiple comparisons
  if (comparisons > 1 && typeof p === 'number') {
    const bonf = alpha / comparisons;
    add('warn', 'multiple-comparisons',
      `${comparisons} tests were run; with a Bonferroni-adjusted threshold (α=${fmt(bonf)}) this result ${p <= bonf ? 'still holds' : 'no longer holds'}.`);
  }

  // normality check for Pearson / t-tests when we have the raw sample
  if (['pearson', 'linearRegression'].includes(kind) && Array.isArray(opts.sampleForNormality)) {
    const jb = jarqueBera(opts.sampleForNormality);
    if (jb && jb.p < 0.05) {
      add('warn', 'non-normal',
        `The data departs from normality (Jarque–Bera p=${fmt(jb.p)}); consider Spearman correlation, which does not assume normality.`);
    }
  }

  // chi-square expected-cell rule
  if (kind === 'chiSquare' && typeof result.minExpected === 'number' && result.minExpected < 5) {
    add('warn', 'low-expected', `Some expected cell counts are below 5 (min ${fmt(result.minExpected)}); the chi-square approximation may be inaccurate — consider Fisher's exact test.`);
  }

  // ANOVA equal-variance reminder
  if (kind === 'anova') {
    add('info', 'anova-assumption', 'ANOVA assumes similar variance across groups; a Levene test can confirm this.');
  }

  // regression collinearity
  if (kind === 'multipleRegression' && result.collinear) {
    add('strong', 'collinear', 'Predictors are highly collinear; individual coefficients are unreliable even if overall fit is good.');
  }

  // outlier distortion warning for measure analyses
  if (['pearson', 'linearRegression', 'twoSampleT', 'anova'].includes(kind) && Array.isArray(opts.sampleForNormality)) {
    const k = kurtosis(clean(opts.sampleForNormality));
    if (Number.isFinite(k) && k > 3) add('info', 'heavy-tails', 'Heavy-tailed data (high kurtosis); outliers may be influencing the result.');
  }

  const trustworthy = !caveats.some((c) => c.level === 'strong');
  return { caveats, trustworthy };
}

/** Jarque–Bera normality test from skewness and kurtosis. */
function jarqueBera(rawValues) {
  const a = clean(rawValues);
  const n = a.length;
  if (n < 8) return null;
  const S = skewness(a);
  const K = kurtosis(a); // already excess
  if (!Number.isFinite(S) || !Number.isFinite(K)) return null;
  const jb = (n / 6) * (S * S + (K * K) / 4);
  const p = 1 - chiSquareCdf(jb, 2);
  return { jb, p, skewness: S, excessKurtosis: K };
}

/** Bonferroni-adjusted significance decisions. */
function bonferroni(pvals, alpha = 0.05) {
  const thr = alpha / pvals.length;
  return pvals.map((p) => ({ p, significant: p <= thr, threshold: thr }));
}

/** Benjamini–Hochberg FDR control. */
function benjaminiHochberg(pvals, alpha = 0.05) {
  const idx = pvals.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const m = pvals.length;
  let maxK = -1;
  for (let k = 0; k < m; k++) if (idx[k][0] <= ((k + 1) / m) * alpha) maxK = k;
  const sig = new Array(m).fill(false);
  for (let k = 0; k <= maxK; k++) sig[idx[k][1]] = true;
  return pvals.map((p, i) => ({ p, significant: sig[i] }));
}

function fmt(x) { return Math.abs(x) < 0.0001 ? x.toExponential(2) : (Math.round(x * 10000) / 10000).toString(); }

module.exports = { auditAnalysis, jarqueBera, bonferroni, benjaminiHochberg };
