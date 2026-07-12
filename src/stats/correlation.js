'use strict';

const { cleanPairs, clean, mean, stdDev } = require('./descriptive');
const { studentTCdf, twoTailedFromCdf, normalCdf } = require('./distributions');

/** Pearson product-moment correlation with a t-based p-value and Fisher-z CI. */
function pearson(xsRaw, ysRaw, { alpha = 0.05 } = {}) {
  const { x, y } = cleanPairs(xsRaw, ysRaw);
  const n = x.length;
  if (n < 3) return { error: 'need at least 3 complete pairs', n };
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) {
    return { error: 'a variable has zero variance (constant column)', n, r: NaN };
  }
  const r = sxy / Math.sqrt(sxx * syy);
  const rClamped = Math.max(-0.999999999, Math.min(0.999999999, r));
  const df = n - 2;
  const t = rClamped * Math.sqrt(df / (1 - rClamped * rClamped));
  const p = twoTailedFromCdf(studentTCdf(t, df), 2);

  // Fisher z-transform confidence interval. Undefined at n=3 (se = 1/√0),
  // where it degenerates to a meaningless [-1, 1] — return null instead.
  const z = Math.atanh(rClamped);
  const se = n > 3 ? 1 / Math.sqrt(n - 3) : Infinity;
  const zc = zCrit(alpha);
  const ci = Number.isFinite(se) ? [Math.tanh(z - zc * se), Math.tanh(z + zc * se)] : null;

  return {
    kind: 'pearson', n, r, df, t, p,
    r2: r * r,
    ci,
    strength: strengthLabel(Math.abs(r)),
    direction: r >= 0 ? 'positive' : 'negative'
  };
}

/** Spearman rank correlation (Pearson on ranks; average ranks for ties). */
function spearman(xsRaw, ysRaw, opts = {}) {
  const { x, y } = cleanPairs(xsRaw, ysRaw);
  const n = x.length;
  if (n < 3) return { error: 'need at least 3 complete pairs', n };
  const rx = rank(x);
  const ry = rank(y);
  const res = pearson(rx, ry, opts);
  if (res.error) return { ...res, kind: 'spearman' };
  return { ...res, kind: 'spearman', rho: res.r };
}

function rank(a) {
  const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const ranks = new Array(a.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; // 1-based average rank for the tie group
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
    i = j + 1;
  }
  return ranks;
}

/**
 * Pairwise Pearson correlation matrix over named numeric columns.
 * columns: [{ name, values }]. Returns { names, matrix, n }.
 */
function correlationMatrix(columns, opts = {}) {
  const names = columns.map((c) => c.name);
  const k = columns.length;
  const matrix = Array.from({ length: k }, () => new Array(k).fill(NaN));
  const pmatrix = Array.from({ length: k }, () => new Array(k).fill(NaN));
  for (let i = 0; i < k; i++) {
    matrix[i][i] = 1;
    pmatrix[i][i] = 0;
    for (let j = i + 1; j < k; j++) {
      const res = pearson(columns[i].values, columns[j].values, opts);
      const r = res.error ? NaN : res.r;
      const p = res.error ? NaN : res.p;
      matrix[i][j] = matrix[j][i] = r;
      pmatrix[i][j] = pmatrix[j][i] = p;
    }
  }
  return { kind: 'correlationMatrix', names, matrix, pmatrix };
}

function zCrit(alpha) {
  // two-sided normal critical value
  const { normalPpf } = require('./distributions');
  return normalPpf(1 - alpha / 2);
}

function strengthLabel(absR) {
  if (absR >= 0.7) return 'strong';
  if (absR >= 0.4) return 'moderate';
  if (absR >= 0.2) return 'weak';
  return 'negligible';
}

module.exports = { pearson, spearman, correlationMatrix, rank };
