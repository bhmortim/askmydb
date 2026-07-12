'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const desc = require('../src/stats/descriptive');
const { pearson, spearman } = require('../src/stats/correlation');
const { simpleLinear, multipleLinear } = require('../src/stats/regression');
const { twoSampleT, chiSquareTest, oneWayAnova, oneSampleT } = require('../src/stats/tests');
const { runAnalysis } = require('../src/stats');

const near = (a, b, tol = 1e-3) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (±${tol})`);

// Anscombe's quartet dataset I — a classic golden set.
const ANS_X = [10, 8, 13, 9, 11, 14, 6, 4, 12, 7, 5];
const ANS_Y1 = [8.04, 6.95, 7.58, 8.81, 8.33, 9.96, 7.24, 4.26, 10.84, 4.82, 5.68];

test('descriptive stats on a known vector', () => {
  const s = desc.describe([2, 4, 4, 4, 5, 5, 7, 9]);
  near(s.mean, 5, 1e-9);
  near(s.stdDev, 2.138089935, 1e-6);   // sample sd
  near(s.median, 4.5, 1e-9);
  assert.strictEqual(s.n, 8);
});

test('describe coerces numeric strings and drops nulls', () => {
  const s = desc.describe(['1', '2', null, '3', 'abc', 4]);
  assert.strictEqual(s.n, 4);      // 1,2,3,4
  assert.strictEqual(s.nMissing, 2);
  near(s.mean, 2.5, 1e-9);
});

test('Pearson on Anscombe I', () => {
  const r = pearson(ANS_X, ANS_Y1);
  near(r.r, 0.8164205, 1e-4);
  near(r.r2, 0.6665425, 1e-4);
  assert.strictEqual(r.direction, 'positive');
  assert.strictEqual(r.strength, 'strong');
  assert.ok(r.p < 0.01);
});

test('simple linear regression on Anscombe I', () => {
  const m = simpleLinear(ANS_X, ANS_Y1);
  near(m.slope, 0.5000909, 1e-4);
  near(m.intercept, 3.0000909, 1e-3);
  near(m.r2, 0.6665425, 1e-4);
});

test('constant column is handled, not NaN-crash', () => {
  const r = pearson([1, 1, 1, 1], [2, 3, 4, 5]);
  assert.ok(r.error, 'should report zero-variance error');
});

test('Spearman handles ties', () => {
  const r = spearman([1, 2, 2, 3, 4], [10, 20, 20, 30, 50]);
  assert.ok(r.rho > 0.9);
});

test("Welch two-sample t-test vs known result", () => {
  const a = [27, 25, 30, 29, 24];
  const b = [20, 18, 22, 19, 17];
  const res = twoSampleT(a, b);
  // group means 27 and 19.2, clearly different
  near(res.meanA, 27, 1e-9);
  near(res.meanB, 19.2, 1e-9);
  assert.ok(res.p < 0.001, `expected small p, got ${res.p}`);
  assert.ok(res.cohensD > 2);
});

test('one-way ANOVA on textbook data', () => {
  // three groups, known F
  const res = oneWayAnova([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  assert.strictEqual(res.dfBetween, 2);
  assert.strictEqual(res.dfWithin, 6);
  near(res.f, 27, 1e-6);      // MSbetween=27, MSwithin=1
  assert.ok(res.p < 0.01);
});

test('chi-square independence with Cramér V', () => {
  // clear association
  const res = chiSquareTest([[30, 10], [10, 30]]);
  assert.strictEqual(res.df, 1);
  near(res.chi2, 20, 1e-6);
  assert.ok(res.p < 0.001);
  assert.ok(res.cramersV > 0.4);
});

test('multiple regression recovers a planted linear relationship', () => {
  // y = 2 + 3*x1 - 1*x2 exactly
  const X = [];
  const y = [];
  for (let i = 0; i < 20; i++) {
    const x1 = i;
    const x2 = (i * 7) % 11;
    X.push([x1, x2]);
    y.push(2 + 3 * x1 - 1 * x2);
  }
  const m = multipleLinear(X, y, ['x1', 'x2']);
  near(m.coefficients[0].estimate, 2, 1e-6);
  near(m.coefficients[1].estimate, 3, 1e-6);
  near(m.coefficients[2].estimate, -1, 1e-6);
  near(m.r2, 1, 1e-6);
});

test('multiple regression flags too-few-rows instead of NaN', () => {
  const m = multipleLinear([[1, 2], [3, 4]], [5, 6], ['a', 'b']);
  assert.ok(m.error);
});

test('dispatch registry runs and rejects bad args', () => {
  const good = runAnalysis('pearson', { x: ANS_X, y: ANS_Y1 });
  near(good.r, 0.8164205, 1e-4);
  const bad = runAnalysis('pearson', { x: ANS_X });          // missing y
  assert.ok(bad.error);
  const unknown = runAnalysis('nope', {});
  assert.ok(unknown.error);
});

test('one-sample t-test', () => {
  const res = oneSampleT([5.1, 4.9, 5.0, 5.2, 4.8], 5.0);
  near(res.mean, 5.0, 1e-9);
  assert.ok(res.p > 0.5); // mean is basically 5.0
});

test('one-tailed t-test is directional (contradicting direction → large p)', () => {
  // data mean 2, well below mu0=10
  const greater = oneSampleT([1, 2, 3], 10, { alternative: 'greater' }); // H1: mean>10
  assert.ok(greater.p > 0.95, `contradicting one-tailed p should be ~1, got ${greater.p}`);
  const less = oneSampleT([1, 2, 3], 10, { alternative: 'less' });        // H1: mean<10
  assert.ok(less.p < 0.05, `supporting one-tailed p should be small, got ${less.p}`);
  // two-sided is between and symmetric
  const two = oneSampleT([1, 2, 3], 10, {});
  near(two.p, 2 * less.p, 1e-9);
});

test('Pearson CI is null at n=3, finite at n>=4', () => {
  const three = pearson([1, 2, 3], [2, 4, 5]);
  assert.strictEqual(three.ci, null, 'CI undefined at n=3');
  const four = pearson([1, 2, 3, 4], [2, 4, 5, 8]);
  assert.ok(Array.isArray(four.ci) && four.ci.every(Number.isFinite));
});

test('describe does not crash on a large column (no arg-spread overflow)', () => {
  const big = Array.from({ length: 200000 }, (_, i) => i % 997);
  const s = desc.describe(big);
  assert.strictEqual(s.n, 200000);
  assert.strictEqual(s.min, 0);
  assert.strictEqual(s.max, 996);
});
