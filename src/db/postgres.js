'use strict';

const pg = require('pg');
const { Client } = pg;
const { normalizeRows } = require('./util');

// Return date/time types as the raw string the server sent, rather than letting
// pg build Date objects (which lose the DATE-vs-TIMESTAMP distinction and can
// shift across timezones). OIDs: 1082 date, 1114 timestamp, 1184 timestamptz.
for (const oid of [1082, 1114, 1184]) {
  pg.types.setTypeParser(oid, (v) => v);
}

async function open(db) {
  const client = new Client({
    host: db.host || 'localhost',
    port: Number(db.port) || 5432,
    user: db.user,
    password: db.password,
    database: db.database,
    ssl: sslOptions(db),
    connectionTimeoutMillis: 8000
  });
  await client.connect();
  return client;
}

// When SSL is on we verify the server certificate by default. Self-signed
// servers (common for internal DBs) need the explicit insecure opt-in.
function sslOptions(db) {
  if (!db.ssl) return undefined;
  return {
    rejectUnauthorized: db.sslInsecure ? false : true,
    ca: db.sslCa || undefined
  };
}

async function testConnection(db) {
  const client = await open(db);
  try {
    const res = await client.query('SELECT version() AS v');
    return { ok: true, info: res.rows[0].v.split(' on ')[0] };
  } finally {
    await client.end().catch(() => {});
  }
}

const SYSTEM_SCHEMAS = `('pg_catalog', 'information_schema', 'pg_toast')`;

async function getSchema(db) {
  const client = await open(db);
  try {
    const tablesRes = await client.query(
      `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
              GREATEST(c.reltuples, 0)::bigint AS row_estimate
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm')
          AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
        ORDER BY n.nspname, c.relname`
    );
    const colsRes = await client.query(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema NOT IN ${SYSTEM_SCHEMAS}
        ORDER BY table_schema, table_name, ordinal_position`
    );
    const pksRes = await client.query(
      `SELECT tc.table_schema, tc.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema NOT IN ${SYSTEM_SCHEMAS}`
    );
    const fksRes = await client.query(
      `SELECT tc.table_schema, tc.table_name, kcu.column_name,
              ccu.table_schema AS ref_schema, ccu.table_name AS ref_table,
              ccu.column_name AS ref_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema NOT IN ${SYSTEM_SCHEMAS}`
    );

    const displayName = (schema, name) => (schema === 'public' ? name : `${schema}.${name}`);
    const byName = new Map();
    for (const t of tablesRes.rows) {
      byName.set(displayName(t.schema, t.name), {
        name: displayName(t.schema, t.name),
        isView: t.kind === 'v' || t.kind === 'm',
        rowCount: t.row_estimate == null ? null : Number(t.row_estimate),
        columns: [],
        foreignKeys: []
      });
    }
    const pkSet = new Set(pksRes.rows.map((r) => `${r.table_schema}.${r.table_name}.${r.column_name}`));
    for (const c of colsRes.rows) {
      const t = byName.get(displayName(c.table_schema, c.table_name));
      if (!t) continue;
      t.columns.push({
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === 'YES',
        pk: pkSet.has(`${c.table_schema}.${c.table_name}.${c.column_name}`)
      });
    }
    for (const fk of fksRes.rows) {
      const t = byName.get(displayName(fk.table_schema, fk.table_name));
      if (!t) continue;
      t.foreignKeys.push({
        column: fk.column_name,
        refTable: displayName(fk.ref_schema, fk.ref_table),
        refColumn: fk.ref_column
      });
    }
    return { dialect: 'postgres', database: db.database, tables: [...byName.values()] };
  } finally {
    await client.end().catch(() => {});
  }
}

async function runQuery(db, sql, { timeoutMs = 15000, maxRows = 500 } = {}) {
  const client = await open(db);
  try {
    // Strongest guardrail: every transaction in this session is read-only.
    await client.query('SET default_transaction_read_only = on');
    await client.query(`SET statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);

    const start = Date.now();
    let res = await client.query({ text: sql, rowMode: 'array' });
    const durationMs = Date.now() - start;
    if (Array.isArray(res)) res = res[res.length - 1]; // multi-statement result: keep the last

    const columns = (res.fields || []).map((f) => f.name);
    const { rows: normalized, truncated } = normalizeRows(res.rows || [], maxRows);
    return { columns, rows: normalized, truncated, durationMs };
  } finally {
    await client.end().catch(() => {});
  }
}

function quoteIdent(name) {
  // Accepts schema-qualified names ("schema.table")
  return String(name)
    .split('.')
    .map((part) => '"' + part.replace(/"/g, '""') + '"')
    .join('.');
}

module.exports = { testConnection, getSchema, runQuery, quoteIdent };
