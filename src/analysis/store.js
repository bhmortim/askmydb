'use strict';

// The analytical store — the engine that makes CROSS-DATABASE correlation
// possible. You cannot JOIN across separate MySQL/Postgres/SQLite servers, so
// result sets pulled from each connection are ingested into a fresh in-memory
// SQLite database and joined THERE.
//
// SAFETY INVARIANT: this store is ALWAYS a brand-new in-memory DatabaseSync,
// NEVER pointed at a user's database. Its writable INSERT path only ever
// touches ingested result rows via bound parameters. The only user-influenced
// SQL — the alignment/join SELECT — is passed through the same validateSql
// guardrail as everything else (dialect 'sqlite') before it runs.

const { validateSql } = require('../guardrails');
const { normalizeRows } = require('../db/util');

function loadDriver() {
  try {
    return require('node:sqlite');
  } catch {
    throw new Error(
      'Cross-database analysis needs the built-in node:sqlite module (Node 22.5+, Node 24 recommended). ' +
      'Single-database analysis still works without it.'
    );
  }
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

// SQLite-safe table/column identifier derived from an arbitrary name.
function safeName(name, fallback) {
  const s = String(name || '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
  return s || fallback;
}

function createStore() {
  const { DatabaseSync } = loadDriver();
  const db = new DatabaseSync(':memory:'); // fresh, isolated, writable
  const tables = new Map();

  return {
    /**
     * Ingest a result set as a table. Columns are stored untyped (SQLite
     * dynamic typing); values are bound as parameters, never interpolated.
     * Returns the safe table name actually used.
     */
    ingest(name, result) {
      const table = safeName(name, `t${tables.size + 1}`);
      const cols = result.columns.map((c, i) => safeName(c, `col${i + 1}`));
      // de-dupe column names
      const seen = new Map();
      const uniqueCols = cols.map((c) => {
        const k = seen.get(c) || 0;
        seen.set(c, k + 1);
        return k ? `${c}_${k}` : c;
      });
      db.exec(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
      db.exec(`CREATE TABLE ${quoteIdent(table)} (${uniqueCols.map((c) => quoteIdent(c)).join(', ')})`);
      if (result.rows.length) {
        const placeholders = uniqueCols.map(() => '?').join(', ');
        const stmt = db.prepare(`INSERT INTO ${quoteIdent(table)} VALUES (${placeholders})`);
        for (const row of result.rows) {
          stmt.run(...uniqueCols.map((_, i) => coerce(row[i])));
        }
      }
      tables.set(table, uniqueCols);
      return { table, columns: uniqueCols };
    },

    /** Run a read-only SELECT over the ingested tables. Guardrailed. */
    align(sql, { maxRows = 10000 } = {}) {
      const verdict = validateSql(sql, { dialect: 'sqlite', maxRows });
      if (!verdict.ok) throw new Error(`Blocked by guardrails: ${verdict.reason}`);
      const stmt = db.prepare(verdict.sql);
      let columns = [];
      try { columns = stmt.columns().map((c) => c.name); } catch { /* older node */ }
      const objRows = stmt.all();
      if (!columns.length && objRows.length) columns = Object.keys(objRows[0]);
      const arrayRows = objRows.map((r) => columns.map((c) => r[c]));
      const { rows, truncated } = normalizeRows(arrayRows, maxRows);
      return { columns, rows, truncated };
    },

    tableNames() { return [...tables.keys()]; },
    close() { try { db.close(); } catch { /* already closed */ } }
  };
}

// node:sqlite only binds null/number/bigint/string/Uint8Array.
function coerce(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return String(v);
}

module.exports = { createStore };
