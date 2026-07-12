'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseCsv, detectDelimiter } = require('../src/import/csv');
const { inferColumn, numericValue, toIsoDate } = require('../src/import/ingest');

let buildSqliteFromFiles, sqliteAvailable = true;
try { ({ buildSqliteFromFiles } = require('../src/import/ingest')); require('node:sqlite'); }
catch { sqliteAvailable = false; }

function tmp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askmydb-imp-'));
  return path.join(dir, name);
}

// ---- CSV parsing ----

test('parses quoted fields with embedded commas and newlines', () => {
  const csv = 'name,note\n"Acme, Inc.","line1\nline2"\n"O""Brien",ok';
  const { columns, rows } = parseCsv(csv);
  assert.deepStrictEqual(columns, ['name', 'note']);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0][0], 'Acme, Inc.');
  assert.strictEqual(rows[0][1], 'line1\nline2');
  assert.strictEqual(rows[1][0], 'O"Brien');
});

test('strips BOM and detects tab / semicolon delimiters', () => {
  const withBom = '﻿a,b\n1,2';
  assert.deepStrictEqual(parseCsv(withBom).columns, ['a', 'b']);
  assert.strictEqual(detectDelimiter('a\tb\tc'), '\t');
  assert.strictEqual(detectDelimiter('a;b;c'), ';');
  const tsv = parseCsv('x\ty\n1\t2');
  assert.deepStrictEqual(tsv.columns, ['x', 'y']);
  assert.strictEqual(tsv.rows[0][1], '2');
});

test('pads ragged rows and dedupes blank/duplicate headers', () => {
  const { columns, rows } = parseCsv('a,a,\n1\n2,3,4,5');
  assert.deepStrictEqual(columns, ['a', 'a_1', 'column_3']);
  assert.deepStrictEqual(rows[0], ['1', '', '']);   // padded
  assert.deepStrictEqual(rows[1], ['2', '3', '4']); // trimmed to width
});

// ---- type inference ----

test('numericValue handles integers, decimals, currency, and rejects IDs/ZIPs', () => {
  assert.strictEqual(numericValue('42'), 42);
  assert.strictEqual(numericValue('3.14'), 3.14);
  assert.strictEqual(numericValue('$85,000.00'), 85000);
  assert.strictEqual(numericValue('1,234'), 1234);
  assert.strictEqual(numericValue('00123'), null);          // leading-zero ZIP → text
  assert.strictEqual(numericValue('I-200-12345-678901'), null); // case number → text
});

test('numericValue rejects malformed comma values (no silent corruption)', () => {
  // these must NOT be coerced to a wrong number — they stay text
  assert.strictEqual(numericValue('1,2,3'), null);
  assert.strictEqual(numericValue(',5'), null);
  assert.strictEqual(numericValue('1,,2'), null);
  assert.strictEqual(numericValue('12,34'), null);   // bad grouping
  // properly grouped still works
  assert.strictEqual(numericValue('1,234,567'), 1234567);
});

test('inferColumn keeps ZIP codes and case numbers as TEXT', () => {
  // any leading-zero value forces TEXT so the zero is preserved
  assert.strictEqual(inferColumn(['02134', '00501']).type, 'TEXT');
  assert.strictEqual(inferColumn(['90210', '02134', '10001']).type, 'TEXT'); // one leading-zero ZIP → whole column text
  assert.strictEqual(inferColumn(['90210', '75201', '10001']).type, 'INTEGER'); // no leading zeros → plain integers
  assert.strictEqual(inferColumn(['I-200-1', 'I-200-2']).type, 'TEXT');
  assert.strictEqual(inferColumn(['1.5', '2', '3.7']).type, 'REAL');
  assert.strictEqual(inferColumn(['$1,000', '$2,500']).type, 'REAL');
});

test('US dates normalize to ISO', () => {
  assert.strictEqual(toIsoDate('3/1/2024'), '2024-03-01');
  assert.strictEqual(toIsoDate('12/25/2023'), '2023-12-25');
  assert.strictEqual(toIsoDate('2024-06-15'), '2024-06-15');
  assert.strictEqual(toIsoDate('not a date'), null);
  const col = inferColumn(['1/1/2024', '2/15/2024', '12/31/2024']);
  assert.ok(col.isDate);
  assert.strictEqual(col.coerce('3/4/2024'), '2024-03-04');
});

// ---- end-to-end build ----

test('builds a queryable SQLite DB from a CSV file', () => {
  if (!sqliteAvailable) return;
  const csvPath = tmp('employers.csv');
  fs.writeFileSync(csvPath,
    'employer,worksite_city,worksite_zip,wage,filed\n' +
    'Acme,Austin,78701,"$95,000",3/1/2024\n' +
    'Globex,Austin,78701,"$120,000",4/2/2024\n' +
    'Initech,Dallas,75201,"$85,000",5/5/2024\n');
  const dbPath = tmp('out.sqlite');
  const { tables } = buildSqliteFromFiles([csvPath], dbPath);
  assert.strictEqual(tables.length, 1);
  assert.strictEqual(tables[0].rowCount, 3);
  const wageCol = tables[0].columns.find((c) => c.name === 'wage');
  assert.strictEqual(wageCol.type, 'REAL');

  // query it via the sqlite adapter path
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare(`SELECT worksite_city AS c, AVG(wage) AS avg_wage FROM ${quote(tables[0].name)} GROUP BY worksite_city ORDER BY avg_wage DESC`).all();
  db.close();
  assert.strictEqual(rows[0].c, 'Austin');
  assert.strictEqual(Number(rows[0].avg_wage), 107500);  // (95000+120000)/2
});

test('builds one table per sheet from an Excel workbook', () => {
  if (!sqliteAvailable) return;
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['id', 'name'], [1, 'a'], [2, 'b']]), 'Main');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['code', 'label'], ['H', 'Home'], ['O', 'Office']]), 'Lookup');
  const xlsxPath = tmp('book.xlsx');
  XLSX.writeFile(wb, xlsxPath);

  const dbPath = tmp('book.sqlite');
  const { tables } = buildSqliteFromFiles([xlsxPath], dbPath);
  const names = tables.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['Lookup', 'Main']);
  assert.strictEqual(tables.find((t) => t.name === 'Main').rowCount, 2);
});

function quote(n) { return '"' + n.replace(/"/g, '""') + '"'; }
