'use strict';

// A dependency-free CSV/TSV parser (RFC 4180-ish): handles quoted fields,
// embedded delimiters and newlines, doubled-quote escapes, CRLF, and a BOM.
// Delimiter is auto-detected from the header line if not given.

function detectDelimiter(sample) {
  const firstLine = sample.split(/\r?\n/, 1)[0] || '';
  const candidates = [
    [',', (firstLine.match(/,/g) || []).length],
    ['\t', (firstLine.match(/\t/g) || []).length],
    [';', (firstLine.match(/;/g) || []).length],
    ['|', (firstLine.match(/\|/g) || []).length]
  ];
  candidates.sort((a, b) => b[1] - a[1]);
  return candidates[0][1] > 0 ? candidates[0][0] : ',';
}

/**
 * Parse CSV text into { columns, rows }.
 * rows is an array of arrays aligned to columns (ragged rows are padded/trimmed).
 */
function parseCsv(text, { delimiter } = {}) {
  let s = String(text || '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // strip BOM
  const delim = delimiter || detectDelimiter(s);

  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  const n = s.length;

  for (let i = 0; i < n; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === delim) { record.push(field); field = ''; continue; }
    if (c === '\r') { if (s[i + 1] === '\n') i++; pushRecord(); continue; }
    if (c === '\n') { pushRecord(); continue; }
    field += c;
  }
  // last field / record (unless the file ended on a clean newline)
  if (field !== '' || record.length) pushRecord();

  function pushRecord() {
    record.push(field);
    field = '';
    rows.push(record);
    record = [];
  }

  if (!rows.length) return { columns: [], rows: [] };

  // header row → column names (dedupe + fill blanks)
  const header = rows[0];
  const seen = new Map();
  const columns = header.map((h, i) => {
    let name = String(h).trim() || `column_${i + 1}`;
    const k = seen.get(name) || 0;
    seen.set(name, k + 1);
    return k ? `${name}_${k}` : name;
  });

  const width = columns.length;
  const body = rows.slice(1)
    // drop fully empty trailing rows
    .filter((r) => !(r.length === 1 && r[0] === ''))
    .map((r) => {
      const row = r.slice(0, width);
      while (row.length < width) row.push('');
      return row;
    });

  return { columns, rows: body, delimiter: delim };
}

module.exports = { parseCsv, detectDelimiter };
