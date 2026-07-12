'use strict';

// Profile a result set's columns so the recommender can reason about analytic
// roles. Operates on the standard result shape: { columns: string[],
// rows: Array<Array<null|number|string>> } — rows are ROW-MAJOR arrays.

const { toNumber, describe, frequencyTable } = require('../stats/descriptive');

const ID_NAME = /(^|_)(id|uuid|guid|code|key|sku|isbn|ean)$/i;
const DATE_NAME = /(date|time|_at$|_on$|timestamp|year|month|day)/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?/;

/** Extract one column's raw cell values from a result set. */
function columnVector(result, nameOrIndex) {
  const idx = typeof nameOrIndex === 'number'
    ? nameOrIndex
    : result.columns.indexOf(nameOrIndex);
  if (idx < 0) return [];
  return result.rows.map((r) => r[idx]);
}

function inferType(values, name) {
  let numeric = 0;
  let dateLike = 0;
  let boolLike = 0;
  let nonNull = 0;
  const distinct = new Set();
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    nonNull++;
    distinct.add(typeof v === 'number' ? v : String(v));
    if (Number.isFinite(toNumber(v))) numeric++;
    if (typeof v === 'string' && ISO_DATE.test(v)) dateLike++;
    if (v === true || v === false || v === 0 || v === 1 || /^(true|false|yes|no|y|n)$/i.test(String(v))) boolLike++;
  }
  const cardinality = distinct.size;
  const distinctFrac = nonNull ? cardinality / nonNull : 0;

  // decide type
  let type = 'text';
  if (nonNull === 0) type = 'empty';
  else if (dateLike / nonNull > 0.8 || (DATE_NAME.test(name) && dateLike / nonNull > 0.5)) type = 'datetime';
  else if (numeric / nonNull > 0.9) type = cardinality === 2 ? 'binary' : 'numeric';
  else if (boolLike === nonNull && cardinality <= 2) type = 'binary';
  else type = 'categorical';

  // ID detection is name-based: an all-distinct numeric column is just as
  // likely a continuous measure (revenue, signups) as a key, and wrongly
  // flagging a measure as an id would drop it from every analysis.
  const isLikelyId = ID_NAME.test(name);
  const isLikelyDate = type === 'datetime';
  // a numeric column that isn't an id is a candidate measure
  const isLikelyMeasure = type === 'numeric' && !isLikelyId;
  // low-cardinality columns (incl. small-int) are grouping dimensions
  const isLikelyDimension = (type === 'categorical' || type === 'binary' ||
    (type === 'numeric' && cardinality <= Math.max(12, 0.05 * nonNull))) && !isLikelyId;

  return { type, cardinality, distinctFrac, nonNull, isLikelyId, isLikelyMeasure, isLikelyDimension, isLikelyDate };
}

/** Profile all columns of a result set. */
function profileColumns(result) {
  const nRows = result.rows.length;
  const columns = result.columns.map((name, index) => {
    const values = result.rows.map((r) => r[index]);
    const info = inferType(values, name);
    const nMissing = values.filter((v) => v === null || v === undefined || v === '').length;
    const col = {
      name, index,
      inferredType: info.type,
      cardinality: info.cardinality,
      distinctFrac: info.distinctFrac,
      nMissing,
      missingFrac: nRows ? nMissing / nRows : 0,
      isLikelyId: info.isLikelyId,
      isLikelyMeasure: info.isLikelyMeasure,
      isLikelyDimension: info.isLikelyDimension,
      isLikelyDate: info.isLikelyDate
    };
    // attach a lightweight summary
    if (info.type === 'numeric') col.summary = describe(values);
    else if (info.type === 'categorical' || info.type === 'binary') col.summary = frequencyTable(values, 8);
    return col;
  });
  return {
    nRows,
    columns,
    measures: columns.filter((c) => c.isLikelyMeasure),
    dimensions: columns.filter((c) => c.isLikelyDimension),
    dates: columns.filter((c) => c.isLikelyDate),
    ids: columns.filter((c) => c.isLikelyId)
  };
}

module.exports = { profileColumns, columnVector, inferType };
