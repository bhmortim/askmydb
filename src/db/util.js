'use strict';

// Make any cell value safe to JSON-serialize and pleasant to display.
function normalizeValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    return v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER ? Number(v) : v.toString();
  }
  if (v instanceof Date) {
    // Date/time columns come back as strings from the drivers (mysql2
    // dateStrings, pg type parsers), so this only catches stray Date objects.
    // Keep the full instant — never collapse to date-only, which silently
    // loses the time on a midnight-UTC timestamp.
    if (Number.isNaN(v.getTime())) return String(v);
    return v.toISOString().replace('.000Z', 'Z');
  }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const buf = Buffer.from(v);
    if (buf.length <= 16) return '0x' + buf.toString('hex');
    return `<binary ${buf.length} bytes>`;
  }
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return v;
}

function normalizeRows(rows, maxRows) {
  const truncated = rows.length > maxRows;
  const sliced = truncated ? rows.slice(0, maxRows) : rows;
  return {
    rows: sliced.map((row) => row.map(normalizeValue)),
    truncated
  };
}

module.exports = { normalizeValue, normalizeRows };
