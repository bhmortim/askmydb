'use strict';

const { normalizeRows } = require('./util');

function loadDriver() {
  try {
    return require('node:sqlite');
  } catch {
    throw new Error(
      'SQLite support uses the built-in node:sqlite module, which needs Node.js 22.5+ ' +
      '(Node 24 recommended). On Node 22.5–23.3 run with: node --experimental-sqlite server.js'
    );
  }
}

function open(db) {
  const { DatabaseSync } = loadDriver();
  if (!db.file) throw new Error('No SQLite file configured');
  // Guardrail: the file handle itself is read-only.
  const handle = new DatabaseSync(db.file, { readOnly: true });
  return handle;
}

async function testConnection(db) {
  const handle = open(db);
  try {
    const row = handle.prepare('SELECT sqlite_version() AS v').get();
    return { ok: true, info: `SQLite ${row.v} (read-only)` };
  } finally {
    handle.close();
  }
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

async function getSchema(db) {
  const handle = open(db);
  try {
    const tables = handle
      .prepare(`SELECT name, type FROM sqlite_master
                 WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
                 ORDER BY name`)
      .all();

    // Cache each table's primary-key columns so a FK that references a table's
    // PK without naming a column can resolve the real column name.
    const pkCache = new Map();
    const primaryKeyOf = (table) => {
      if (pkCache.has(table)) return pkCache.get(table);
      let pk = null;
      try {
        const info = handle.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
        pk = info.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name)[0] || null;
      } catch { /* dangling table */ }
      pkCache.set(table, pk);
      return pk;
    };

    const out = [];
    for (const t of tables) {
      let cols, fks;
      try {
        // table_info compiles a view's SELECT; a view over a dropped table
        // throws here. Skip the broken object rather than aborting discovery.
        cols = handle.prepare(`PRAGMA table_info(${quoteIdent(t.name)})`).all();
        fks = handle.prepare(`PRAGMA foreign_key_list(${quoteIdent(t.name)})`).all();
      } catch {
        continue;
      }
      let rowCount = null;
      try {
        rowCount = Number(handle.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(t.name)}`).get().c);
      } catch { /* views over missing tables, etc. */ }

      out.push({
        name: t.name,
        isView: t.type === 'view',
        rowCount,
        columns: cols.map((c) => ({
          name: c.name,
          type: c.type || 'ANY',
          nullable: !c.notnull,
          pk: Boolean(c.pk)
        })),
        foreignKeys: fks.map((fk) => ({
          column: fk.from,
          refTable: fk.table,
          // fk.to is null when the FK references the parent's PK unnamed:
          // resolve the real PK column instead of assuming 'id'.
          refColumn: fk.to || primaryKeyOf(fk.table) || null
        }))
      });
    }
    return { dialect: 'sqlite', database: db.file, tables: out };
  } finally {
    handle.close();
  }
}

async function runQuery(db, sql, { maxRows = 500, timeoutMs = 15000 } = {}) {
  // node:sqlite is synchronous and has no statement-timeout/interrupt API, so a
  // pathological query (e.g. an unbounded recursive CTE) can still block. We
  // bound the common runaway — a huge result set — by streaming rows and
  // stopping once we have maxRows or the time budget elapses, rather than
  // materializing everything with .all() first. The read-only handle remains
  // the safety net that no write can slip through. See README troubleshooting.
  const handle = open(db);
  try {
    const start = Date.now();
    const stmt = handle.prepare(sql);
    let columns = [];
    try {
      columns = stmt.columns().map((c) => c.name);
    } catch { /* older Node without StatementSync.columns() */ }

    const arrayRows = [];
    let truncated = false;
    let iterated = false;
    try {
      for (const row of stmt.iterate()) {           // Node 22.5+/24
        iterated = true;
        if (!columns.length) columns = Object.keys(row);
        if (arrayRows.length >= maxRows) { truncated = true; break; }
        if (Date.now() - start > timeoutMs) { truncated = true; break; }
        arrayRows.push(columns.map((c) => row[c]));
      }
    } catch (e) {
      if (!iterated) {
        // iterate() unsupported on this runtime — fall back to all()
        const objRows = stmt.all();
        if (!columns.length && objRows.length) columns = Object.keys(objRows[0]);
        const mapped = objRows.map((r) => columns.map((c) => r[c]));
        const capped = normalizeRows(mapped, maxRows);
        return { columns, rows: capped.rows, truncated: capped.truncated, durationMs: Date.now() - start };
      }
      throw e;
    }

    const { rows: normalized } = normalizeRows(arrayRows, maxRows);
    return { columns, rows: normalized, truncated, durationMs: Date.now() - start };
  } finally {
    handle.close();
  }
}

module.exports = { testConnection, getSchema, runQuery, quoteIdent };
