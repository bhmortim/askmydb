'use strict';

// Turn CSV/Excel files into a queryable SQLite database. Each CSV becomes one
// table; each sheet of an Excel workbook becomes one table. Column types are
// inferred so numbers, currency, and dates work in SQL and the stats engine.

const fs = require('fs');
const path = require('path');
const { parseCsv } = require('./csv');

function loadSqlite() {
  try {
    return require('node:sqlite');
  } catch {
    throw new Error('Spreadsheet import needs the built-in node:sqlite module (Node 22.5+, Node 24 recommended).');
  }
}

const CSV_EXT = new Set(['.csv', '.tsv', '.txt']);
const XLS_EXT = new Set(['.xlsx', '.xls', '.xlsm', '.xlsb', '.ods']);

function supportedExt(ext) {
  return CSV_EXT.has(ext) || XLS_EXT.has(ext);
}

/** Read one file into one or more { name, columns, rows } tables. */
function readTables(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath, path.extname(filePath));
  if (CSV_EXT.has(ext)) {
    // A CSV is read into memory as one string; V8 caps strings near 512MB, so
    // fail clearly (not with an opaque crash) on files beyond a safe bound.
    const bytes = fs.statSync(filePath).size;
    if (bytes > 400 * 1024 * 1024) {
      throw new Error(`${path.basename(filePath)} is ${(bytes / 1024 / 1024) | 0} MB — too large to import in one piece. Split it into smaller CSVs.`);
    }
    const text = fs.readFileSync(filePath, 'utf8');
    const { columns, rows } = parseCsv(text);
    return [{ name: base, sheet: null, columns, rows }];
  }
  if (XLS_EXT.has(ext)) {
    // Lazy-require SheetJS so CSV-only use doesn't pay for it.
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(filePath, { cellDates: false, raw: false });
    const out = [];
    const multi = wb.SheetNames.length > 1;
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      if (!ws) continue;
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
      if (!aoa.length) continue;
      const header = (aoa[0] || []).map((h, i) => String(h).trim() || `column_${i + 1}`);
      const seen = new Map();
      const columns = header.map((name) => {
        const k = seen.get(name) || 0;
        seen.set(name, k + 1);
        return k ? `${name}_${k}` : name;
      });
      const width = columns.length;
      const rows = aoa.slice(1).map((r) => {
        const row = r.slice(0, width).map((v) => (v == null ? '' : String(v)));
        while (row.length < width) row.push('');
        return row;
      });
      out.push({ name: multi ? sheetName : base, sheet: multi ? sheetName : null, columns, rows });
    }
    return out.length ? out : [{ name: base, sheet: null, columns: [], rows: [] }];
  }
  throw new Error(`Unsupported file type: ${ext} (${path.basename(filePath)})`);
}

// ---- type inference --------------------------------------------------------

const INT_RE = /^-?(?:0|[1-9]\d*)$/;          // no leading zeros (keeps ZIP codes as text)
const DEC_RE = /^-?\d*\.\d+$/;
const SCI_RE = /^-?\d+(?:\.\d+)?[eE][+-]?\d+$/;
// $ and/or properly grouped thousands only — rejects "1,2,3", ",5", "1,,2"
const CURRENCY_RE = /^-?\$?\s?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;
const US_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;

function numericValue(v) {
  const t = v.trim();
  if (t === '') return null;
  if (INT_RE.test(t)) {
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : null; // long IDs stay text
  }
  if (DEC_RE.test(t) || SCI_RE.test(t)) return Number(t);
  if (CURRENCY_RE.test(t) && /[,$]/.test(t)) {
    const n = Number(t.replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isIntegerText(v) {
  const t = v.trim();
  if (!INT_RE.test(t)) return false;
  return Number.isSafeInteger(Number(t));
}

function toIsoDate(v) {
  const t = v.trim();
  if (ISO_DATE_RE.test(t)) return t.replace(' ', 'T');
  const m = US_DATE_RE.exec(t);
  if (m) {
    const [, mm, dd, yyyy] = m;
    if (+mm >= 1 && +mm <= 12 && +dd >= 1 && +dd <= 31) {
      return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    }
  }
  return null;
}

/** Infer a SQLite affinity + a coercion function for one column. */
function inferColumn(values) {
  let nonEmpty = 0;
  let allInt = true;
  let allNum = true;
  let allDate = true;
  for (const raw of values) {
    const v = raw == null ? '' : String(raw);
    if (v.trim() === '') continue;
    nonEmpty++;
    if (!isIntegerText(v)) allInt = false;
    if (numericValue(v) === null) allNum = false;
    if (toIsoDate(v) === null) allDate = false;
    if (!allInt && !allNum && !allDate) break;
  }
  if (nonEmpty === 0) return { type: 'TEXT', coerce: (v) => (v === '' ? null : v) };
  if (allInt) return { type: 'INTEGER', coerce: (v) => (v.trim() === '' ? null : Number(v)) };
  if (allNum) return { type: 'REAL', coerce: (v) => (v.trim() === '' ? null : numericValue(v)) };
  if (allDate) return { type: 'TEXT', isDate: true, coerce: (v) => (v.trim() === '' ? null : (toIsoDate(v) || v)) };
  return { type: 'TEXT', coerce: (v) => (v === '' ? null : v) };
}

// ---- build the database ----------------------------------------------------

function sanitizeTableName(name, used) {
  let s = String(name).trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 't$1');
  if (!s) s = 'table';
  let candidate = s;
  let i = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${s}_${i++}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/**
 * Build a SQLite DB at destPath from the given files.
 * @returns { tables: [{ name, source, sheet, rowCount, columns:[{name,type,isDate}] }], warnings }
 */
function buildSqliteFromFiles(files, destPath) {
  const { DatabaseSync } = loadSqlite();
  if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const db = new DatabaseSync(destPath);

  const usedNames = new Set();
  const tables = [];
  const warnings = [];

  try {
    db.exec('PRAGMA journal_mode = MEMORY');
    for (const filePath of files) {
      let fileTables;
      try {
        fileTables = readTables(filePath);
      } catch (e) {
        warnings.push(`${path.basename(filePath)}: ${e.message}`);
        continue;
      }
      for (const t of fileTables) {
        if (!t.columns.length) { warnings.push(`${path.basename(filePath)}${t.sheet ? ` [${t.sheet}]` : ''}: no columns found, skipped`); continue; }
        const tableName = sanitizeTableName(t.name, usedNames);

        // sanitize + dedupe column names for SQL
        const colUsed = new Set();
        const colNames = t.columns.map((c, i) => {
          let cn = String(c).trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || `col_${i + 1}`;
          if (/^\d/.test(cn)) cn = 'c_' + cn;
          let cand = cn;
          let k = 2;
          while (colUsed.has(cand.toLowerCase())) cand = `${cn}_${k++}`;
          colUsed.add(cand.toLowerCase());
          return cand;
        });

        const inferred = t.columns.map((_, ci) => inferColumn(t.rows.map((r) => r[ci])));
        const colDefs = colNames.map((cn, ci) => `${quoteIdent(cn)} ${inferred[ci].type}`).join(', ');
        db.exec(`CREATE TABLE ${quoteIdent(tableName)} (${colDefs})`);

        if (t.rows.length) {
          const placeholders = colNames.map(() => '?').join(', ');
          const stmt = db.prepare(`INSERT INTO ${quoteIdent(tableName)} VALUES (${placeholders})`);
          db.exec('BEGIN');
          for (const row of t.rows) {
            const vals = inferred.map((inf, ci) => {
              const cell = row[ci] == null ? '' : String(row[ci]);
              const coerced = inf.coerce(cell);
              return coerced === undefined ? null : coerced;
            });
            stmt.run(...vals);
          }
          db.exec('COMMIT');
        }

        tables.push({
          name: tableName,
          source: path.basename(filePath),
          sheet: t.sheet,
          rowCount: t.rows.length,
          columns: colNames.map((cn, ci) => ({ name: cn, type: inferred[ci].type, isDate: Boolean(inferred[ci].isDate) }))
        });
      }
    }
  } finally {
    db.close();
  }

  if (!tables.length) throw new Error('No tables could be built from the selected files. ' + (warnings.join('; ') || ''));
  return { tables, warnings };
}

module.exports = { buildSqliteFromFiles, readTables, inferColumn, numericValue, toIsoDate, supportedExt, CSV_EXT, XLS_EXT };
