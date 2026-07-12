'use strict';

const { clean, quantile, mean, stdDev, median } = require('./descriptive');

/** Detect outliers by the 1.5·IQR rule and by modified z-score (MAD). */
function outliers(rawValues, { iqrK = 1.5, zThreshold = 3.5 } = {}) {
  const a = clean(rawValues);
  const n = a.length;
  if (n < 4) return { error: 'need at least 4 values', n };
  const q1 = quantile(a, 0.25);
  const q3 = quantile(a, 0.75);
  const iqr = q3 - q1;
  const lowFence = q1 - iqrK * iqr;
  const highFence = q3 + iqrK * iqr;

  const med = median(a);
  const mad = median(a.map((v) => Math.abs(v - med))) || 1e-12;

  const flagged = [];
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    const byIqr = v < lowFence || v > highFence;
    const modZ = (0.6745 * (v - med)) / mad;
    const byZ = Math.abs(modZ) > zThreshold;
    if (byIqr || byZ) flagged.push({ index: i, value: v, modifiedZ: modZ, byIqr, byZ });
  }
  return {
    kind: 'outliers', n,
    q1, q3, iqr, lowFence, highFence,
    count: flagged.length,
    proportion: flagged.length / n,
    outliers: flagged.slice(0, 100)
  };
}

module.exports = { outliers };
