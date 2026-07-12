'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const d = require('../src/stats/distributions');

const near = (a, b, tol = 1e-4) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (±${tol})`);

test('gammaln matches known values', () => {
  near(d.gammaln(1), 0, 1e-9);
  near(d.gammaln(2), 0, 1e-9);
  near(d.gammaln(5), Math.log(24), 1e-8);   // Γ(5) = 4! = 24
  near(d.gammaln(0.5), Math.log(Math.sqrt(Math.PI)), 1e-8);
  near(d.gammaln(10), 12.801827480081469, 1e-6);
});

test('erf / erfc', () => {
  near(d.erf(0), 0, 1e-9);
  near(d.erf(1), 0.8427007929497149, 1e-6);
  near(d.erf(-1), -0.8427007929497149, 1e-6);
  near(d.erf(2), 0.9953222650189527, 1e-6);
  near(d.erfc(1), 0.1572992070502851, 1e-6);
});

test('normal CDF at standard points', () => {
  near(d.normalCdf(0), 0.5, 1e-9);
  near(d.normalCdf(1.96), 0.9750021048517795, 1e-6);
  near(d.normalCdf(-1.96), 0.0249978951482205, 1e-6);
  near(d.normalCdf(1), 0.8413447460685429, 1e-6);
  near(d.normalCdf(2.5758293035489), 0.995, 1e-5);
});

test('normal PPF (inverse) round-trips', () => {
  near(d.normalPpf(0.975), 1.959963984540054, 1e-4);
  near(d.normalPpf(0.5), 0, 1e-6);
  near(d.normalPpf(0.025), -1.959963984540054, 1e-4);
  for (const p of [0.01, 0.1, 0.3, 0.6, 0.9, 0.99]) {
    near(d.normalCdf(d.normalPpf(p)), p, 1e-6);
  }
});

test('Student t CDF', () => {
  near(d.studentTCdf(0, 10), 0.5, 1e-9);
  // t = 2.228 at df=10 is the 0.975 quantile
  near(d.studentTCdf(2.228138852, 10), 0.975, 1e-5);
  near(d.studentTCdf(-2.228138852, 10), 0.025, 1e-5);
  // large df approaches normal
  near(d.studentTCdf(1.96, 100000), d.normalCdf(1.96), 1e-4);
});

test('Student t PPF', () => {
  near(d.studentTPpf(0.975, 10), 2.228138852, 1e-3);
  near(d.studentTPpf(0.975, 1), 12.706204736, 1e-2);
  near(d.studentTPpf(0.5, 5), 0, 1e-6);
});

test('chi-square CDF and PPF', () => {
  // χ²(0.95, df=1) = 3.841459
  near(d.chiSquareCdf(3.8414588207, 1), 0.95, 1e-5);
  near(d.chiSquareCdf(11.070497694, 5), 0.95, 1e-5);
  near(d.chiSquarePpf(0.95, 1), 3.8414588207, 1e-3);
  near(d.chiSquarePpf(0.95, 10), 18.307038053, 1e-2);
});

test('F CDF', () => {
  // F(0.95; 3, 10) = 3.708
  near(d.fCdf(3.708264757, 3, 10), 0.95, 1e-4);
  near(d.fCdf(1, 5, 5), 0.5, 1e-4);
});

test('regularized incomplete beta symmetry', () => {
  near(d.regIncBeta(0.5, 2, 2), 0.5, 1e-9);
  near(d.regIncBeta(0.3, 2, 3) + d.regIncBeta(0.7, 3, 2), 1, 1e-9);
});

test('two-tailed p from cdf', () => {
  near(d.twoTailedFromCdf(d.normalCdf(1.96), 2), 0.05, 1e-4);
  near(d.twoTailedFromCdf(d.normalCdf(-1.96), 2), 0.05, 1e-4);
  near(d.twoTailedFromCdf(d.normalCdf(1.96), 1), 0.025, 1e-4);
});
