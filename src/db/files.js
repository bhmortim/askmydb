'use strict';

// A "files" connection: one or more CSV/Excel files ingested into a local
// SQLite database, then queried through the SQLite adapter. This lets someone
// point askmydb at spreadsheets with no database server at all.

const fs = require('fs');
const path = require('path');
const sqlite = require('./sqlite');
const { buildSqliteFromFiles, supportedExt } = require('../import/ingest');

function fileList(db) {
  return Array.isArray(db.files) ? db.files.filter(Boolean) : [];
}

/** Build the backing SQLite DB if it doesn't exist yet. Returns the build info. */
function ensureBuilt(db) {
  if (!db.dataFile) throw new Error('This spreadsheet connection has no data file configured.');
  if (!fs.existsSync(db.dataFile)) return rebuild(db);
  return null;
}

/** (Re)ingest all source files into the backing SQLite DB. */
function rebuild(db) {
  const files = fileList(db);
  if (!files.length) throw new Error('No spreadsheet or CSV files selected.');
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) throw new Error(`File(s) not found: ${missing.map((f) => path.basename(f)).join(', ')}`);
  return buildSqliteFromFiles(files, db.dataFile);
}

async function testConnection(db) {
  const files = fileList(db);
  if (!files.length) throw new Error('Add at least one CSV or Excel file.');
  const problems = [];
  for (const f of files) {
    if (!fs.existsSync(f)) problems.push(`not found: ${path.basename(f)}`);
    else if (!supportedExt(path.extname(f).toLowerCase())) problems.push(`unsupported: ${path.basename(f)}`);
  }
  if (problems.length) throw new Error(problems.join('; '));
  return { ok: true, info: `${files.length} file${files.length === 1 ? '' : 's'} ready to import` };
}

function backing(db) {
  return { type: 'sqlite', file: db.dataFile };
}

async function getSchema(db) {
  ensureBuilt(db);
  const schema = await sqlite.getSchema(backing(db));
  return { ...schema, dialect: 'sqlite', database: `${fileList(db).length} file(s)` };
}

async function runQuery(db, sql, opts) {
  ensureBuilt(db);
  return sqlite.runQuery(backing(db), sql, opts);
}

module.exports = { testConnection, getSchema, runQuery, quoteIdent: sqlite.quoteIdent, rebuild, ensureBuilt };
