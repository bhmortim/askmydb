'use strict';

// Descriptive statistics and data cleaning. Row cells can arrive as numbers,
// numeric strings (out-of-range bigints), or null (see src/db/util.js), so
// every consumer must coerce with toNumber / clean first.

function toNumber(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Coerce to finite numbers, dropping anything non-numeric. */
function clean(values) {
  const out = [];
  for (const v of values) {
    const n = toNumber(v);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Drop rows where either paired value is non-finite. Returns {x, y}. */
function cleanPairs(xs, ys) {
  const x = [];
  const y = [];
  const n = Math.min(xs.length, ys.length);
  for (let i = 0; i < n; i++) {
    const a = toNumber(xs[i]);
    const b = toNumber(ys[i]);
    if (Number.isFinite(a) && Number.isFinite(b)) { x.push(a); y.push(b); }
  }
  return { x, y };
}

function sum(a) { return a.reduce((s, v) => s + v, 0); }
function mean(a) { return a.length ? sum(a) / a.length : NaN; }

// Single-pass min/max. Never spread a large array into Math.min/Math.max —
// that overflows the call stack past ~125k elements.
function minMax(a) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return { min: lo, max: hi };
}

function variance(a, sample = true) {
  const n = a.length;
  if (n < (sample ? 2 : 1)) return NaN;
  const m = mean(a);
  let ss = 0;
  for (const v of a) ss += (v - m) * (v - m);
  return ss / (n - (sample ? 1 : 0));
}

function stdDev(a, sample = true) {
  const v = variance(a, sample);
  return Number.isFinite(v) ? Math.sqrt(v) : NaN;
}

/** Linear-interpolated quantile (type 7, R default). q in [0,1]. */
function quantile(a, q) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  if (q <= 0) return s[0];
  if (q >= 1) return s[s.length - 1];
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const frac = pos - lo;
  return s[lo] + (s[lo + 1] - s[lo]) * frac;
}

function median(a) { return quantile(a, 0.5); }

// Adjusted Fisher–Pearson standardized moment (sample skewness), matching
// Excel SKEW / scipy skew(bias=False).
function skewness(a) {
  const n = a.length;
  if (n < 3) return NaN;
  const m = mean(a);
  const s = stdDev(a, true); // sample std
  if (s === 0) return NaN;
  let acc = 0;
  for (const v of a) acc += ((v - m) / s) ** 3;
  return (n / ((n - 1) * (n - 2))) * acc;
}

/** Excess kurtosis (0 = normal), sample-corrected. */
function kurtosis(a) {
  const n = a.length;
  if (n < 4) return NaN;
  const m = mean(a);
  const sd = stdDev(a, true);
  if (sd === 0) return NaN;
  let s = 0;
  for (const v of a) s += ((v - m) / sd) ** 4;
  const num = (n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3));
  const adj = (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
  return num * s - adj;
}

/** Full descriptive summary of a numeric vector (raw, uncleaned input). */
function describe(rawValues) {
  const nTotal = rawValues.length;
  const a = clean(rawValues);
  const n = a.length;
  if (!n) {
    return { n: 0, nMissing: nTotal, error: 'no numeric values' };
  }
  const m = mean(a);
  const sd = stdDev(a, true);
  const { min, max } = minMax(a);
  return {
    n,
    nMissing: nTotal - n,
    mean: m,
    median: median(a),
    stdDev: sd,
    variance: variance(a, true),
    min,
    max,
    range: max - min,
    q1: quantile(a, 0.25),
    q3: quantile(a, 0.75),
    iqr: quantile(a, 0.75) - quantile(a, 0.25),
    skewness: skewness(a),
    kurtosis: kurtosis(a),
    sum: sum(a),
    // standard error of the mean + 95% CI (normal approx / t for small n)
    sem: sd / Math.sqrt(n),
    cv: m !== 0 ? sd / Math.abs(m) : NaN
  };
}

/** Equal-width histogram bins over cleaned values. */
function histogram(rawValues, binCount = 0) {
  const a = clean(rawValues);
  if (a.length < 2) return { bins: [], n: a.length };
  const { min: lo, max: hi } = minMax(a);
  if (lo === hi) return { bins: [{ start: lo, end: hi, count: a.length }], n: a.length };
  // Sturges' rule when binCount not given
  const k = binCount || Math.max(1, Math.ceil(Math.log2(a.length) + 1));
  const width = (hi - lo) / k;
  const bins = Array.from({ length: k }, (_, i) => ({
    start: lo + i * width,
    end: lo + (i + 1) * width,
    count: 0
  }));
  for (const v of a) {
    let idx = Math.floor((v - lo) / width);
    if (idx >= k) idx = k - 1;
    bins[idx].count++;
  }
  return { bins, n: a.length, binWidth: width };
}

/** Frequency table of categorical values (raw, keeps nulls as a bucket). */
function frequencyTable(values, topN = 20) {
  const counts = new Map();
  let missing = 0;
  for (const v of values) {
    if (v === null || v === undefined || v === '') { missing++; continue; }
    const key = String(v);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const total = values.length;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, topN).map(([value, count]) => ({
    value, count, proportion: count / total
  }));
  return {
    total,
    distinct: counts.size,
    missing,
    entries: top,
    truncated: sorted.length > topN
  };
}

module.exports = {
  toNumber, clean, cleanPairs, sum, mean, variance, stdDev,
  quantile, median, skewness, kurtosis, describe, histogram, frequencyTable
};
