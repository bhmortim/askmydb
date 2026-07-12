'use strict';

// Embedding-based schema linking. Small local models have small context
// windows, so on a large database we must NOT dump every table into the prompt.
// Instead we embed each table once, embed the user's question, and keep only
// the most relevant tables — plus their foreign-key neighbors so joins still
// resolve. This is the single biggest accuracy win for limited models on wide
// schemas. Falls back to "use everything" when embeddings are unavailable or
// the schema is already small.

const llm = require('./llm');

// Below this many tables, retrieval isn't worth the round-trip — send all.
const RETRIEVAL_THRESHOLD = 12;

/** Compact text describing a table, used both for embedding and matching. */
function tableText(table) {
  const cols = table.columns.map((c) => {
    let s = c.name;
    if (c.samples && c.samples.length) s += ` (e.g. ${c.samples.slice(0, 3).join(', ')})`;
    return s;
  });
  return `${table.name}: ${cols.join(', ')}`;
}

/** Build (or reuse) an embedding index for a schema. Returns null on failure. */
async function buildSchemaIndex(schema, llmCfg, { signal } = {}) {
  if (!llmCfg.embeddingModel) return null;
  try {
    const texts = schema.tables.map(tableText);
    const vectors = await llm.embed(llmCfg, texts, { signal });
    if (!vectors || vectors.length !== schema.tables.length) return null;
    return {
      names: schema.tables.map((t) => t.name),
      vectors,
      builtAt: Date.now()
    };
  } catch {
    return null;
  }
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Choose the tables to include in the SQL prompt for a question.
 * Returns { tables: Table[], retrieved: boolean, scores? }.
 * Includes FK-connected neighbors of the top matches (1 hop).
 */
async function selectRelevantTables(schema, question, llmCfg, index, { maxTables = 8, signal } = {}) {
  const all = schema.tables;
  if (all.length <= RETRIEVAL_THRESHOLD || !index) {
    return { tables: all, retrieved: false };
  }
  let qEmb;
  try {
    [qEmb] = await llm.embed(llmCfg, [question], { signal });
  } catch {
    return { tables: all, retrieved: false };
  }

  const scored = index.names.map((name, i) => ({ name, score: cosine(qEmb, index.vectors[i]) }))
    .sort((a, b) => b.score - a.score);

  // Preserve relevance order: top matches first, then FK neighbors. This
  // matters because schemaToPromptText truncates by list order to fit the
  // context window — the most relevant tables must survive.
  const ordered = [];
  const chosen = new Set();
  const add = (name) => { if (!chosen.has(name)) { chosen.add(name); ordered.push(name); } };
  for (const s of scored.slice(0, maxTables)) add(s.name);

  // add 1-hop FK neighbors so joins across the retrieved tables resolve
  const byName = new Map(all.map((t) => [t.name, t]));
  for (const name of [...chosen]) {
    const t = byName.get(name);
    if (t) for (const fk of t.foreignKeys || []) if (byName.has(fk.refTable)) add(fk.refTable);
    for (const other of all) {
      if ((other.foreignKeys || []).some((fk) => fk.refTable === name)) add(other.name);
    }
  }

  const tables = ordered.map((name) => byName.get(name)).filter(Boolean);
  return {
    tables,
    retrieved: true,
    scores: scored.slice(0, maxTables)
  };
}

module.exports = { buildSchemaIndex, selectRelevantTables, tableText, cosine, RETRIEVAL_THRESHOLD };
