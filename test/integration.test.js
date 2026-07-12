'use strict';

// End-to-end pipeline tests that mirror what the /recommend, /analyze and
// /correlate routes do, without needing a browser or a live model. These prove
// the advanced capabilities work as a whole, not just in isolation.

const { test } = require('node:test');
const assert = require('node:assert');

const { profileColumns } = require('../src/analysis/profile');
const { recommendAnalyses } = require('../src/analysis/recommender');
const { prepareArgs } = require('../src/analysis/prepare');
const { runAnalysis } = require('../src/stats');
const { auditAnalysis } = require('../src/analysis/audit');
const { buildInterpretationContext } = require('../src/analysis/interpret');

let createStore;
try { ({ createStore } = require('../src/analysis/store')); } catch { /* Node < 22.5 */ }

function resultOf(columns, rows) { return { columns, rows, truncated: false, durationMs: 1 }; }

test('full single-DB analysis pipeline: recommend → analyze → audit → interpret', () => {
  // a realistic result: price vs units_sold, clearly related, n=30
  const rows = [];
  for (let i = 0; i < 30; i++) {
    const price = 10 + i;
    const units = 500 - price * 8 + (i % 5) * 6; // negative relationship + noise
    rows.push([price, units]);
  }
  const result = resultOf(['price', 'units_sold'], rows);

  // 1. profile + recommend
  const profile = profileColumns(result);
  const recs = recommendAnalyses(profile, 'is price related to units sold?');
  assert.ok(recs.length > 0, 'should produce recommendations');
  const top = recs[0];
  assert.strictEqual(top.kind, 'pearson');

  // 2. prepare args from the recommendation's column mapping + run
  const args = prepareArgs(top.kind, result, top.columns);
  const analysis = runAnalysis(top.kind, args);
  assert.ok(!analysis.error);
  assert.ok(analysis.r < -0.9, `expected strong negative correlation, got ${analysis.r}`);
  assert.ok(analysis.p < 0.001);

  // 3. audit adds the causation caveat (and no small-n at n=30)
  const audit = auditAnalysis(top.kind, analysis, profile, { sampleForNormality: args.y });
  assert.ok(audit.caveats.some((c) => c.code === 'causation'));
  assert.ok(!audit.caveats.some((c) => c.code === 'small-n' && c.level === 'strong'));

  // 4. interpretation context carries the computed numbers + caveats, no rows
  const ctx = buildInterpretationContext(top.kind, analysis, profile, audit, 'is price related to units sold?');
  assert.match(ctx.statText, /r \(Pearson\)/);
  for (const c of audit.caveats) assert.ok(ctx.caveats.includes(c.message));
  assert.ok(ctx.statText.length < 300);
});

test('full cross-DB correlation pipeline mirrors the /correlate route', () => {
  if (!createStore) return; // node:sqlite unavailable
  // Two result sets standing in for two separate databases, keyed by state.
  const dbA = resultOf(['state', 'applications'], [
    ['CA', 469], ['TX', 416], ['WA', 304], ['NY', 192], ['CO', 261],
    ['AZ', 240], ['IL', 228], ['MA', 169], ['NC', 271], ['NJ', 148]
  ]);
  const dbB = resultOf(['state', 'median_income'], [
    ['CA', 84000], ['TX', 67000], ['WA', 82000], ['NY', 74000], ['CO', 80000],
    ['AZ', 65000], ['IL', 68000], ['MA', 85000], ['NC', 60000], ['NJ', 85000]
  ]);

  const store = createStore();
  try {
    const L = store.ingest('left', dbA);
    const R = store.ingest('right', dbB);
    const joined = store.align(
      `SELECT l."applications" AS x, r."median_income" AS y FROM "${L.table}" l JOIN "${R.table}" r ON l."state" = r."state"`
    );
    assert.strictEqual(joined.rows.length, 10, 'all 10 states join');

    const x = joined.rows.map((r) => r[0]);
    const y = joined.rows.map((r) => r[1]);
    const analysis = runAnalysis('pearson', { x, y });
    assert.ok(!analysis.error);
    assert.ok(Number.isFinite(analysis.r));

    const audit = auditAnalysis('pearson', analysis, null, { sampleForNormality: y });
    assert.ok(audit.caveats.some((c) => c.code === 'causation'));
    // n=10 → small-sample caveat present, proving guardrails fire on real joins
    assert.ok(audit.caveats.some((c) => c.code === 'small-n'));
  } finally {
    store.close();
  }
});

test('recommender + analyze handles a group comparison (ANOVA) end-to-end', () => {
  const rows = [];
  const groups = ['free', 'pro', 'enterprise'];
  for (let i = 0; i < 60; i++) {
    const g = groups[i % 3];
    const base = g === 'free' ? 20 : g === 'pro' ? 50 : 90;
    rows.push([g, base + (i % 7)]);
  }
  const result = resultOf(['plan', 'monthly_spend'], rows);
  const profile = profileColumns(result);
  const recs = recommendAnalyses(profile, 'does spend differ by plan?');
  const anova = recs.find((r) => r.kind === 'anova');
  assert.ok(anova, 'should recommend ANOVA for 3-group comparison');

  const args = prepareArgs('anova', result, anova.columns);
  const res = runAnalysis('anova', args);
  assert.strictEqual(res.k, 3);
  assert.ok(res.p < 0.001, 'the three plans clearly differ');
});
