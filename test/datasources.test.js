'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const ds = require('../src/datasources');

// The pack is a large runtime asset (data/datasources/, gitignored). These
// tests only run when it's present; they skip cleanly otherwise.
const available = ds.isAvailable();

test('pack loads with a valid header when present', () => {
  if (!available) return;
  const info = ds.packInfo();
  assert.ok(info.count > 0);
  assert.ok(info.dim > 0);
  assert.ok(info.model);
});

test('recommend returns ranked sources for a query vector', () => {
  if (!available) return;
  const pack = ds.loadPack();
  // use an actual pack vector as the query → its own source should rank #1
  const dim = pack.dim;
  const q = Array.from({ length: dim }, (_, k) => pack.vectors[k]); // row 0
  const recs = ds.recommend(q, { topK: 3 });
  assert.strictEqual(recs.length, 3);
  assert.ok(recs[0].score > 0.99, 'a source queried by its own vector should match itself');
  assert.ok(recs[0].name && recs[0].url);
  // scores are descending
  assert.ok(recs[0].score >= recs[1].score && recs[1].score >= recs[2].score);
});

test('topic filter restricts results', () => {
  if (!available) return;
  const pack = ds.loadPack();
  const q = Array.from({ length: pack.dim }, () => 0.01);
  const recs = ds.recommend(q, { topK: 5, topic: 'worker_visas' });
  for (const r of recs) {
    assert.ok(r.primary_topic === 'worker_visas' || (r.topics || []).includes('worker_visas'));
  }
});

test('topics() returns counts', () => {
  if (!available) return;
  const t = ds.topics();
  assert.ok(t.length > 0);
  assert.ok(t[0].topic && t[0].count > 0);
});

test('recommend rejects a wrong-dimension query vector (no NaN garbage)', () => {
  if (!available) return;
  const pack = ds.loadPack();
  assert.throws(() => ds.recommend(new Array(pack.dim + 5).fill(0.1), { topK: 3 }), /dimension/i);
  assert.throws(() => ds.recommend([0.1, 0.2], { topK: 3 }), /dimension/i);
});
