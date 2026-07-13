'use strict';

// Public-data-source recommender. Loads a prebuilt pack (embeddings + metadata
// for ~10k US public datasets) and, given a question embedding, returns the
// datasets most relevant to that research goal — so the user can pull in data
// that would strengthen or clarify an answer. The pack is built offline by
// tools/build-datasource-pack.js; if it isn't present, the feature is simply off.

const fs = require('fs');
const path = require('path');

const PACK_DIR = path.join(__dirname, '..', '..', 'data', 'datasources');

let cache = null; // { meta, vectors: Float32Array, dim, count, model }

function loadPack(dir = PACK_DIR) {
  if (cache) return cache;
  try {
    const header = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const buf = fs.readFileSync(path.join(dir, 'vectors.f32'));
    const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (meta.length !== header.count || vectors.length !== header.count * header.dim) {
      throw new Error('pack size mismatch');
    }
    cache = { meta, vectors, dim: header.dim, count: header.count, model: header.model };
    return cache;
  } catch {
    return null;
  }
}

function isAvailable() {
  return Boolean(loadPack());
}

function packInfo() {
  const p = loadPack();
  return p ? { count: p.count, model: p.model, dim: p.dim } : null;
}

// Cosine of a query vector against row i of the packed matrix. Pack vectors are
// not pre-normalized, so normalize both.
function scoreRow(pack, q, qNorm, i) {
  const off = i * pack.dim;
  let dot = 0;
  let n = 0;
  for (let k = 0; k < pack.dim; k++) {
    const v = pack.vectors[off + k];
    dot += q[k] * v;
    n += v * v;
  }
  return n ? dot / (qNorm * Math.sqrt(n)) : 0;
}

/**
 * @param queryEmbedding number[] (from the embedding model)
 * @param opts { topK, topic, geo, minTier }
 * @returns [{ ...meta, score }]
 */
function recommend(queryEmbedding, opts = {}) {
  const pack = loadPack();
  if (!pack) return [];
  const q = queryEmbedding;
  // Guard against an embedding model whose dimension differs from the pack's
  // build model — otherwise the dot product reads past the vector and scores NaN.
  if (!Array.isArray(q) || q.length !== pack.dim) {
    const e = new Error(`Embedding dimension ${q ? q.length : 0} does not match the data-source pack (${pack.dim}). Use the same embedding model the pack was built with (${pack.model}), or rebuild the pack.`);
    e.code = 'DIM_MISMATCH';
    throw e;
  }
  const { topK = 8, topic, geo, minTier } = opts;
  let qNorm = 0;
  for (let k = 0; k < pack.dim; k++) qNorm += q[k] * q[k];
  qNorm = Math.sqrt(qNorm) || 1;

  const scored = [];
  for (let i = 0; i < pack.count; i++) {
    const m = pack.meta[i];
    if (topic && !(m.topics || []).includes(topic) && m.primary_topic !== topic) continue;
    if (minTier && (m.tier || 99) > minTier) continue;
    if (geo && !(m.geo || '').toLowerCase().includes(geo.toLowerCase())) continue;
    scored.push([i, scoreRow(pack, q, qNorm, i)]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, topK).map(([i, s]) => ({ ...pack.meta[i], score: s }));
}

/** Distinct topics present in the pack (for filter chips). */
function topics() {
  const pack = loadPack();
  if (!pack) return [];
  const counts = new Map();
  for (const m of pack.meta) counts.set(m.primary_topic, (counts.get(m.primary_topic) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([topic, count]) => ({ topic, count }));
}

module.exports = { loadPack, isAvailable, packInfo, recommend, topics };
