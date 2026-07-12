'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

let createStore;
try {
  ({ createStore } = require('../src/analysis/store'));
} catch { /* handled per-test */ }

const { runAnalysis } = require('../src/stats');

function resultOf(columns, rows) { return { columns, rows, truncated: false, durationMs: 1 }; }

test('analytical store joins two separate result sets (cross-DB correlation)', () => {
  let store;
  try { store = createStore(); }
  catch (e) { return; /* node:sqlite unavailable (Node < 22.5) — skip */ }

  try {
    // Stand-ins for a MySQL result and a Postgres result, keyed by region.
    const sales = resultOf(['region', 'revenue'], [
      ['north', 100], ['south', 200], ['east', 150], ['west', 300], ['central', 250]
    ]);
    const marketing = resultOf(['area', 'ad_spend'], [
      ['north', 10], ['south', 22], ['east', 14], ['west', 33], ['central', 27]
    ]);

    const L = store.ingest('sales', sales);
    const R = store.ingest('marketing', marketing);
    const joined = store.align(
      `SELECT l."revenue" AS x, r."ad_spend" AS y FROM "${L.table}" l JOIN "${R.table}" r ON l."region" = r."area"`
    );
    assert.strictEqual(joined.rows.length, 5, 'all 5 regions should match');

    const x = joined.rows.map((row) => row[0]);
    const y = joined.rows.map((row) => row[1]);
    const r = runAnalysis('pearson', { x, y });
    // revenue and ad_spend move together strongly here
    assert.ok(r.r > 0.95, `expected strong cross-DB correlation, got ${r.r}`);
  } finally {
    store.close();
  }
});

test('store.align rejects a non-SELECT through the shared guardrail', () => {
  let store;
  try { store = createStore(); } catch { return; }
  try {
    store.ingest('t', resultOf(['a'], [[1], [2]]));
    assert.throws(() => store.align('DROP TABLE t'), /guardrail|read-only/i);
  } finally {
    store.close();
  }
});

test('store ingests messy column names and null values safely', () => {
  let store;
  try { store = createStore(); } catch { return; }
  try {
    const r = resultOf(['weird name!', 'weird name!', 'ok'], [[1, 2, null], [3, 4, 'x']]);
    const info = store.ingest('messy', r);
    assert.strictEqual(info.columns.length, 3);
    const out = store.align(`SELECT COUNT(*) AS n FROM "${info.table}"`);
    assert.strictEqual(Number(out.rows[0][0]), 2);
  } finally {
    store.close();
  }
});
