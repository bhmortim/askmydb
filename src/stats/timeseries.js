'use strict';

const { clean, cleanPairs } = require('./descriptive');
const { simpleLinear } = require('./regression');
const { normalCdf, twoTailedFromCdf } = require('./distributions');

/**
 * Trend of a series over ordered time. If x (time index) is omitted, uses
 * 0..n-1. Reports OLS slope, Theil–Sen robust slope, and a Mann–Kendall
 * monotonic-trend test.
 */
function trend(valuesRaw, timeRaw = null) {
  const yAll = valuesRaw;
  const xAll = timeRaw || valuesRaw.map((_, i) => i);
  const { x, y } = cleanPairs(xAll, yAll);
  const n = y.length;
  if (n < 4) return { error: 'need at least 4 points', n };

  const ols = simpleLinear(x, y);

  // Theil–Sen median of pairwise slopes (subsampled if large)
  const slopes = [];
  const cap = 20000;
  const stride = (n * (n - 1)) / 2 > cap ? Math.ceil(n / Math.sqrt(2 * cap / 1)) : 1;
  for (let i = 0; i < n; i += stride) {
    for (let j = i + 1; j < n; j += stride) {
      if (x[j] !== x[i]) slopes.push((y[j] - y[i]) / (x[j] - x[i]));
    }
  }
  slopes.sort((p, q) => p - q);
  const theilSen = slopes.length ? slopes[Math.floor(slopes.length / 2)] : NaN;

  // Mann–Kendall S statistic with tie correction in the variance
  let S = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) S += Math.sign(y[j] - y[i]);
  }
  // variance, corrected for tied groups: subtract Σ t(t-1)(2t+5)/18
  const tieGroups = new Map();
  for (const v of y) tieGroups.set(v, (tieGroups.get(v) || 0) + 1);
  let tieTerm = 0;
  for (const t of tieGroups.values()) if (t > 1) tieTerm += t * (t - 1) * (2 * t + 5);
  const varS = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
  let z = 0;
  if (S > 0) z = (S - 1) / Math.sqrt(varS);
  else if (S < 0) z = (S + 1) / Math.sqrt(varS);
  const pTrend = twoTailedFromCdf(normalCdf(z), 2);

  return {
    kind: 'trend', n,
    olsSlope: ols.slope, olsPValue: ols.pSlope, r2: ols.r2,
    theilSenSlope: theilSen,
    mannKendallS: S, mannKendallZ: z, mannKendallP: pTrend,
    direction: theilSen > 0 ? 'increasing' : theilSen < 0 ? 'decreasing' : 'flat',
    significant: pTrend < 0.05
  };
}

/** Simple moving average (window w) over cleaned values, preserving length. */
function movingAverage(valuesRaw, w = 3) {
  const a = clean(valuesRaw);
  if (a.length < w) return { error: 'series shorter than window', n: a.length };
  const out = [];
  for (let i = 0; i <= a.length - w; i++) {
    let s = 0;
    for (let j = 0; j < w; j++) s += a[i + j];
    out.push(s / w);
  }
  return { kind: 'movingAverage', window: w, values: out };
}

module.exports = { trend, movingAverage };
