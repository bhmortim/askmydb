'use strict';

// ---------------------------------------------------------------------------
// Pure-JS special functions and distribution CDFs / quantiles.
// No dependencies. Everything composes from three primitives:
//   gammaln (Lanczos), lowerRegGamma (P), regIncBeta (I_x).
// Accuracy is ~1e-8, verified against R/scipy constants in the test suite.
// Algorithms follow Numerical Recipes.
// ---------------------------------------------------------------------------

const FPMIN = 1e-300;
const EPS = 1e-14;
const SQRT2 = Math.SQRT2;
const LN_SQRT_2PI = 0.9189385332046727; // 0.5 * ln(2π)

// Lanczos g=7, n=9
const LANCZOS = [
  0.99999999999980993,
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7
];

/** ln Γ(x) for x > 0 (reflection handles x < 0.5). */
function gammaln(x) {
  if (x <= 0) {
    if (Number.isInteger(x)) return Infinity;
    // reflection: lnΓ(x) = ln(π/|sin πx|) − lnΓ(1−x)
    return Math.log(Math.abs(Math.PI / Math.sin(Math.PI * x))) - gammaln(1 - x);
  }
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - gammaln(1 - x);
  }
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return LN_SQRT_2PI + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized lower incomplete gamma P(a, x). */
function lowerRegGamma(a, x) {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 0;
  if (x < a + 1) {
    // series
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 1000; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * EPS) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - gammaln(a));
  }
  // continued fraction for Q, then P = 1 − Q (Lentz)
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  const q = Math.exp(-x + a * Math.log(x) - gammaln(a)) * h;
  return 1 - q;
}

function upperRegGamma(a, x) {
  return 1 - lowerRegGamma(a, x);
}

/** Continued fraction for the incomplete beta (Lentz). */
function betacf(x, a, b) {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
function regIncBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(x, a, b)) / a;
  return 1 - (bt * betacf(1 - x, b, a)) / b;
}

/** Error function via P(1/2, x²). */
function erf(x) {
  const s = x < 0 ? -1 : 1;
  return s * lowerRegGamma(0.5, x * x);
}
function erfc(x) {
  return 1 - erf(x);
}

// ---- Normal ----------------------------------------------------------------

function normalCdf(x, mu = 0, sigma = 1) {
  return 0.5 * erfc(-((x - mu) / (sigma * SQRT2)));
}

// Acklam's rational approximation to the inverse normal CDF (~1e-9).
function normalPpf(p, mu = 0, sigma = 1) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q;
  let z;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    z = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= phigh) {
    q = p - 0.5;
    const r = q * q;
    z = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    z = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  return mu + sigma * z;
}

// ---- Student's t ------------------------------------------------------------

function studentTCdf(t, df) {
  if (df <= 0) return NaN;
  const x = df / (df + t * t);
  const ib = 0.5 * regIncBeta(x, df / 2, 0.5);
  return t > 0 ? 1 - ib : ib;
}

// ---- Chi-square -------------------------------------------------------------

function chiSquareCdf(x, df) {
  if (x <= 0) return 0;
  return lowerRegGamma(df / 2, x / 2);
}

// ---- F ----------------------------------------------------------------------

function fCdf(x, d1, d2) {
  if (x <= 0) return 0;
  return regIncBeta((d1 * x) / (d1 * x + d2), d1 / 2, d2 / 2);
}

// ---- Quantiles via bisection on the monotone CDF ----------------------------

function bisectQuantile(cdf, p, lo, hi, iters = 80) {
  if (p <= 0) return lo;
  if (p >= 1) return hi;
  for (let i = 0; i < iters; i++) {
    const mid = 0.5 * (lo + hi);
    if (cdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

function studentTPpf(p, df) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  return bisectQuantile((t) => studentTCdf(t, df), p, -1e6, 1e6);
}

function chiSquarePpf(p, df) {
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  return bisectQuantile((x) => chiSquareCdf(x, df), p, 0, 1e7);
}

/**
 * Two-tailed (or one-tailed) p-value for a symmetric-around-zero statistic
 * whose survival is given by (1 − cdf). tails: 1 or 2.
 */
function twoTailedFromCdf(cdfValue, tails = 2) {
  const oneTail = Math.min(cdfValue, 1 - cdfValue);
  return tails === 2 ? Math.min(1, 2 * oneTail) : oneTail;
}

module.exports = {
  gammaln,
  lowerRegGamma,
  upperRegGamma,
  regIncBeta,
  erf,
  erfc,
  normalCdf,
  normalPpf,
  studentTCdf,
  studentTPpf,
  chiSquareCdf,
  chiSquarePpf,
  fCdf,
  twoTailedFromCdf
};
