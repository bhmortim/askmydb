'use strict';

// Hypothesis tests: t-tests, chi-square independence, one-way ANOVA, Levene.

const { clean, cleanPairs, mean, variance, stdDev } = require('./descriptive');
const { studentTCdf, chiSquareCdf, fCdf } = require('./distributions');

// A correct t p-value needs the hypothesized direction. 'two-sided' is the
// default; 'greater'/'less' are proper one-sided tests (directional, so a
// result contradicting the alternative correctly yields a large p).
function tPValue(t, df, alternative = 'two-sided') {
  if (!Number.isFinite(t)) return NaN;
  const cdf = studentTCdf(t, df);
  if (alternative === 'greater') return 1 - cdf; // H1: effect > 0 (upper tail)
  if (alternative === 'less') return cdf;         // H1: effect < 0 (lower tail)
  return Math.min(1, 2 * Math.min(cdf, 1 - cdf)); // two-sided
}

/** One-sample t-test against a hypothesized mean mu0. */
function oneSampleT(rawValues, mu0 = 0, { alternative = 'two-sided' } = {}) {
  const a = clean(rawValues);
  const n = a.length;
  if (n < 2) return { error: 'need at least 2 values', n };
  const m = mean(a);
  const sd = stdDev(a, true);
  const se = sd / Math.sqrt(n);
  const df = n - 1;
  const t = se === 0 ? NaN : (m - mu0) / se;
  return {
    kind: 'oneSampleT', n, df, mean: m, mu0, sd, se, t, alternative,
    p: tPValue(t, df, alternative)
  };
}

/** Welch's two-sample t-test (does not assume equal variance). */
function twoSampleT(rawA, rawB, { alternative = 'two-sided' } = {}) {
  const a = clean(rawA);
  const b = clean(rawB);
  if (a.length < 2 || b.length < 2) return { error: 'each group needs at least 2 values', nA: a.length, nB: b.length };
  const ma = mean(a);
  const mb = mean(b);
  const va = variance(a, true);
  const vb = variance(b, true);
  const na = a.length;
  const nb = b.length;
  const se = Math.sqrt(va / na + vb / nb);
  const t = se === 0 ? NaN : (ma - mb) / se;
  // Welch–Satterthwaite df
  const df = (va / na + vb / nb) ** 2 /
    (((va / na) ** 2) / (na - 1) + ((vb / nb) ** 2) / (nb - 1));
  const pooledSd = Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2));
  return {
    kind: 'twoSampleT', method: 'welch',
    nA: na, nB: nb, meanA: ma, meanB: mb, diff: ma - mb,
    df, t, se, alternative,
    p: tPValue(t, df, alternative),
    cohensD: pooledSd === 0 ? NaN : (ma - mb) / pooledSd
  };
}

/** Paired t-test. */
function pairedT(rawA, rawB, { alternative = 'two-sided' } = {}) {
  const { x, y } = cleanPairs(rawA, rawB);
  const n = x.length;
  if (n < 2) return { error: 'need at least 2 complete pairs', n };
  const diffs = x.map((v, i) => v - y[i]);
  const res = oneSampleT(diffs, 0, { alternative });
  return { ...res, kind: 'pairedT', n, meanDiff: res.mean };
}

/**
 * Chi-square test of independence on a contingency table (rows × cols counts).
 * Returns statistic, df, p, expected counts, and Cramér's V.
 */
function chiSquareTest(table) {
  const rows = table.length;
  const cols = table[0].length;
  const rowSums = table.map((r) => r.reduce((s, v) => s + v, 0));
  const colSums = new Array(cols).fill(0);
  let total = 0;
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) { colSums[j] += table[i][j]; total += table[i][j]; }
  if (total === 0) return { error: 'empty table' };

  const expected = Array.from({ length: rows }, () => new Array(cols));
  let chi2 = 0;
  let minExpected = Infinity;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const e = (rowSums[i] * colSums[j]) / total;
      expected[i][j] = e;
      minExpected = Math.min(minExpected, e);
      if (e > 0) chi2 += (table[i][j] - e) ** 2 / e;
    }
  }
  const df = (rows - 1) * (cols - 1);
  const p = 1 - chiSquareCdf(chi2, df);
  const cramersV = Math.sqrt(chi2 / (total * Math.min(rows - 1, cols - 1)));
  return { kind: 'chiSquare', chi2, df, p, expected, minExpected, total, cramersV };
}

/** One-way ANOVA across groups (array of numeric arrays). */
function oneWayAnova(rawGroups) {
  const groups = rawGroups.map(clean).filter((g) => g.length > 0);
  const k = groups.length;
  if (k < 2) return { error: 'need at least 2 non-empty groups', k };
  const all = groups.flat();
  const grand = mean(all);
  const N = all.length;
  let ssBetween = 0;
  let ssWithin = 0;
  const groupMeans = [];
  for (const g of groups) {
    const gm = mean(g);
    groupMeans.push(gm);
    ssBetween += g.length * (gm - grand) ** 2;
    for (const v of g) ssWithin += (v - gm) ** 2;
  }
  const dfBetween = k - 1;
  const dfWithin = N - k;
  if (dfWithin <= 0) return { error: 'not enough observations within groups', k };
  const msBetween = ssBetween / dfBetween;
  const msWithin = ssWithin / dfWithin;
  const f = msWithin === 0 ? NaN : msBetween / msWithin;
  const p = 1 - fCdf(f, dfBetween, dfWithin);
  const etaSquared = (ssBetween + ssWithin) === 0 ? NaN : ssBetween / (ssBetween + ssWithin);
  return {
    kind: 'anova', k, N, groupMeans,
    ssBetween, ssWithin, dfBetween, dfWithin, msBetween, msWithin,
    f, p, etaSquared
  };
}

/** Brown–Forsythe / Levene test for equal variance (uses median centers). */
function leveneTest(rawGroups) {
  const groups = rawGroups.map(clean).filter((g) => g.length > 1);
  if (groups.length < 2) return { error: 'need at least 2 groups with ≥2 values' };
  const { median } = require('./descriptive');
  // Brown–Forsythe: absolute deviations from each group's median
  const z = groups.map((g) => {
    const med = median(g);
    return g.map((v) => Math.abs(v - med));
  });
  const res = oneWayAnova(z);
  return { ...res, kind: 'levene', method: 'brown-forsythe' };
}

module.exports = { oneSampleT, twoSampleT, pairedT, chiSquareTest, oneWayAnova, leveneTest };
