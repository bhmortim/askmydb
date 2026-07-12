'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { profileColumns, inferType } = require('../src/analysis/profile');
const { recommendAnalyses } = require('../src/analysis/recommender');
const { auditAnalysis, jarqueBera, benjaminiHochberg } = require('../src/analysis/audit');
const { buildInterpretationContext } = require('../src/analysis/interpret');
const { runAnalysis } = require('../src/stats');

function resultOf(columns, rows) { return { columns, rows, truncated: false, durationMs: 1 }; }

test('profile infers analytic roles correctly', () => {
  const r = resultOf(
    ['customer_id', 'state', 'revenue', 'signup_date'],
    Array.from({ length: 40 }, (_, i) => [1000 + i, ['CA', 'TX', 'NY'][i % 3], 100 + i * 3.5, `2024-0${1 + (i % 9)}-15`])
  );
  const p = profileColumns(r);
  const byName = Object.fromEntries(p.columns.map((c) => [c.name, c]));
  assert.ok(byName.customer_id.isLikelyId, 'customer_id should be an id');
  assert.ok(!byName.customer_id.isLikelyMeasure, 'numeric id is NOT a measure');
  assert.ok(byName.revenue.isLikelyMeasure, 'revenue is a measure');
  assert.ok(byName.state.isLikelyDimension, 'state is a dimension');
  assert.strictEqual(byName.signup_date.inferredType, 'datetime');
});

test('low-cardinality integer is a dimension, not a measure', () => {
  const info = inferType([1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3], 'rating');
  assert.ok(info.isLikelyDimension);
});

test('recommender suggests correlation for two measures', () => {
  const r = resultOf(['price', 'sales'],
    Array.from({ length: 30 }, (_, i) => [i * 2 + 1, i * 5 + (i % 3)]));
  const recs = recommendAnalyses(profileColumns(r), 'is price related to sales?');
  assert.strictEqual(recs[0].kind, 'pearson');
  assert.match(recs[0].rationale, /price/);
  assert.match(recs[0].rationale, /sales/);
  assert.ok(recs[0].caveats.some((c) => /causation/i.test(c)));
});

test('recommender suggests group comparison for measure + 2-group dimension', () => {
  const r = resultOf(['plan', 'spend'],
    Array.from({ length: 40 }, (_, i) => [i % 2 ? 'pro' : 'free', 50 + (i % 2) * 40 + (i % 5)]));
  const recs = recommendAnalyses(profileColumns(r), 'do pro users spend more?');
  const top = recs.find((x) => x.kind === 'twoSampleT');
  assert.ok(top, 'should suggest a two-sample t-test');
  assert.match(top.rationale, /spend/);
});

test('recommender suggests trend for measure over date', () => {
  const r = resultOf(['month', 'signups'],
    Array.from({ length: 12 }, (_, i) => [`2024-${String(i + 1).padStart(2, '0')}-01`, 100 + i * 10]));
  const recs = recommendAnalyses(profileColumns(r), 'how have signups changed over time?');
  assert.strictEqual(recs[0].kind, 'trend');
});

test('audit attaches small-n and causation caveats', () => {
  const res = runAnalysis('pearson', { x: [1, 2, 3, 4], y: [2, 4, 5, 8] });
  const audit = auditAnalysis('pearson', res, null, {});
  assert.ok(audit.caveats.some((c) => c.code === 'small-n' && c.level === 'strong'));
  assert.ok(audit.caveats.some((c) => c.code === 'causation'));
});

test('audit flags multiple comparisons', () => {
  const res = runAnalysis('pearson', { x: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], y: [2, 3, 5, 4, 6, 7, 8, 7, 9, 11, 10, 13, 12, 14, 16, 15, 17, 19, 18, 21] });
  const audit = auditAnalysis('pearson', res, null, { comparisons: 10 });
  assert.ok(audit.caveats.some((c) => c.code === 'multiple-comparisons'));
});

test('Jarque-Bera flags a skewed sample', () => {
  const skewed = [1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 4, 20, 50, 90];
  const jb = jarqueBera(skewed);
  assert.ok(jb && jb.p < 0.05, 'heavily skewed data should be flagged non-normal');
});

test('Benjamini-Hochberg controls FDR', () => {
  const flags = benjaminiHochberg([0.001, 0.01, 0.2, 0.6, 0.9], 0.05);
  assert.ok(flags[0].significant);
  assert.ok(!flags[4].significant);
});

test('interpretation context contains card + every caveat but no raw rows', () => {
  const res = runAnalysis('pearson', { x: [1, 2, 3, 4, 5, 6, 7, 8], y: [2, 4, 5, 4, 6, 7, 9, 8] });
  const audit = auditAnalysis('pearson', res, null, {});
  const ctx = buildInterpretationContext('pearson', res, null, audit, 'are x and y related?');
  assert.match(ctx.statText, /r \(Pearson\)/);
  assert.match(ctx.statText, /p-value/);
  // every caveat present
  for (const c of audit.caveats) assert.ok(ctx.caveats.includes(c.message));
  // the card is a bounded reduction — it must not grow with the number of rows,
  // so a large result set can't dump raw data into the prompt
  const big = runAnalysis('pearson', { x: Array.from({ length: 5000 }, (_, i) => i), y: Array.from({ length: 5000 }, (_, i) => i * 2 + (i % 7)) });
  const bigCtx = buildInterpretationContext('pearson', big, null, auditAnalysis('pearson', big, null, {}), 'q');
  assert.ok(bigCtx.statText.length < 300, 'stat card must stay compact regardless of n');
  assert.ok(bigCtx.statText.split('\n').length <= 8, 'no per-row lines');
});
