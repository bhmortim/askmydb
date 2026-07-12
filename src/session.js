'use strict';

// In-app session state for a single-user localhost tool: per-connection schema
// caches (with optional embedding index) and a bounded registry of recent
// result sets. Storing results by id lets later turns reference and join them
// ("correlate the last result with sales from db2") without re-sending payloads.

const MAX_RESULTS = 40;          // LRU cap on stored result sets
const RESULT_TTL_MS = 60 * 60 * 1000;

function createSession() {
  // connectionId -> { schema, schemaText, truncated, index }
  const schemas = new Map();
  // resultId -> { result, question, connectionId, kind, createdAt, label }
  const results = new Map();
  let activeConnectionId = null;
  let seq = 0;

  function setSchema(connId, entry) {
    schemas.set(connId, entry);
  }
  function getSchema(connId) {
    return schemas.get(connId) || null;
  }
  function clearSchema(connId) {
    schemas.delete(connId);
  }

  function putResult(result, meta = {}) {
    evictExpired();
    const id = `r${++seq}`;
    results.set(id, {
      id,
      result,
      question: meta.question || '',
      connectionId: meta.connectionId || null,
      label: meta.label || meta.question || `result ${seq}`,
      createdAt: Date.now()
    });
    // LRU: drop oldest beyond cap
    while (results.size > MAX_RESULTS) {
      const oldest = results.keys().next().value;
      results.delete(oldest);
    }
    return id;
  }

  function getResult(id) {
    const e = results.get(id);
    if (!e) return null;
    // touch for LRU recency
    results.delete(id);
    results.set(id, e);
    return e;
  }

  function listResults() {
    evictExpired();
    return [...results.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((e) => ({
        id: e.id, label: e.label, question: e.question,
        connectionId: e.connectionId,
        columns: e.result.columns, rowCount: e.result.rows.length,
        createdAt: e.createdAt
      }));
  }

  function evictExpired() {
    const now = Date.now();
    for (const [id, e] of results) if (now - e.createdAt > RESULT_TTL_MS) results.delete(id);
  }

  return {
    schemas, setSchema, getSchema, clearSchema,
    putResult, getResult, listResults,
    get activeConnectionId() { return activeConnectionId; },
    set activeConnectionId(v) { activeConnectionId = v; }
  };
}

module.exports = { createSession };
