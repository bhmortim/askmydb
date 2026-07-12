'use strict';

const mysql = require('mysql2/promise');
const { normalizeRows } = require('./util');

async function open(db) {
  return mysql.createConnection({
    host: db.host || 'localhost',
    port: Number(db.port) || 3306,
    user: db.user,
    password: db.password,
    database: db.database,
    ssl: sslOptions(db),
    multipleStatements: false, // guardrail: one statement per query, enforced by the driver too
    connectTimeout: 8000,
    // Let the driver hand back DATE/DATETIME/TIMESTAMP as strings, exactly as
    // stored — avoids Date round-tripping that shifts times across timezones.
    dateStrings: true
  });
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
  const conn = await open(db);
  try {
    const [rows] = await conn.query('SELECT VERSION() AS v');
    return { ok: true, info: `MySQL ${rows[0].v}` };
  } finally {
    await conn.end().catch(() => {});
  }
}

async function getSchema(db) {
  const conn = await open(db);
  try {
    const [tables] = await conn.query(
      `SELECT TABLE_NAME AS name, TABLE_ROWS AS rowCount, TABLE_TYPE AS tableType
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME`,
      [db.database]
    );
    const [cols] = await conn.query(
      `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, COLUMN_TYPE AS type,
              IS_NULLABLE AS nullable, COLUMN_KEY AS colKey
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [db.database]
    );
    const [fks] = await conn.query(
      `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS col,
              REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refCol
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
      [db.database]
    );

    const byName = new Map();
    for (const t of tables) {
      byName.set(t.name, {
        name: t.name,
        isView: t.tableType === 'VIEW',
        rowCount: t.rowCount == null ? null : Number(t.rowCount),
        columns: [],
        foreignKeys: []
      });
    }
    for (const c of cols) {
      const t = byName.get(c.tbl);
      if (!t) continue;
      t.columns.push({
        name: c.name,
        type: c.type,
        nullable: c.nullable === 'YES',
        pk: c.colKey === 'PRI'
      });
    }
    for (const fk of fks) {
      const t = byName.get(fk.tbl);
      if (!t) continue;
      t.foreignKeys.push({ column: fk.col, refTable: fk.refTable, refColumn: fk.refCol });
    }
    return { dialect: 'mysql', database: db.database, tables: [...byName.values()] };
  } finally {
    await conn.end().catch(() => {});
  }
}

async function runQuery(db, sql, { timeoutMs = 15000, maxRows = 500 } = {}) {
  const conn = await open(db);
  try {
    // Strongest guardrail: the session itself refuses writes.
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    // Server-side kill switch for slow SELECTs (MySQL 5.7.8+); ignore if unsupported.
    await conn.query(`SET SESSION MAX_EXECUTION_TIME=${Math.max(1, Math.floor(timeoutMs))}`)
      .catch(() => {});

    const start = Date.now();
    const [rows, fields] = await conn.query({ sql, rowsAsArray: true, timeout: timeoutMs });
    const durationMs = Date.now() - start;

    const columns = (fields || []).map((f) => f.name);
    const list = Array.isArray(rows) ? rows : [];
    const { rows: normalized, truncated } = normalizeRows(list, maxRows);
    return { columns, rows: normalized, truncated, durationMs };
  } finally {
    await conn.end().catch(() => {});
  }
}

function quoteIdent(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

module.exports = { testConnection, getSchema, runQuery, quoteIdent };
