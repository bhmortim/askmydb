'use strict';

const { getAdapter, DIALECT_NAMES } = require('./db');

// Columns whose values should never be sampled into the LLM prompt.
const SENSITIVE_COLUMN = /pass|pwd|secret|token|hash|salt|ssn|\bsin\b|nino|social|credit|card|cvv|iban|routing|acc(oun)?t|\bpin\b|api_?key|apikey|email|phone|mobile|address|postcode|zip|dob|birth|passport|national|tax_?id|maiden|otp|\bmfa\b|security_?(q|answer)|private_?key|priv_?key/i;

// Generic "dumping ground" columns that can hold anything, including PII —
// don't sample them into the prompt.
const GENERIC_COLUMN = /^(notes?|comments?|value|data|payload|meta(data)?|description|body|content|raw|json|blob|extra|misc)$/i;

const TEXTUAL_TYPE = /char|text|enum|string|uuid/i;

/**
 * Discover tables, columns, keys — and optionally a few example values for
 * text columns (helps the model guess literals like state codes or statuses).
 */
async function discoverSchema(dbCfg, { sampleValues = true, sampleTimeoutMs = 3000, sampleBudgetMs = 20000 } = {}) {
  const adapter = getAdapter(dbCfg.type);
  const schema = await adapter.getSchema(dbCfg);

  if (sampleValues) {
    const started = Date.now();
    outer:
    for (const table of schema.tables) {
      if (table.isView) continue;
      for (const col of table.columns) {
        if (Date.now() - started > sampleBudgetMs) break outer;
        if (!TEXTUAL_TYPE.test(col.type)) continue;
        if (SENSITIVE_COLUMN.test(col.name)) continue;
        if (GENERIC_COLUMN.test(col.name)) continue;
        try {
          const sql =
            `SELECT DISTINCT ${adapter.quoteIdent(col.name)} AS v ` +
            `FROM ${adapter.quoteIdent(table.name)} ` +
            `WHERE ${adapter.quoteIdent(col.name)} IS NOT NULL LIMIT 6`;
          const res = await adapter.runQuery(dbCfg, sql, { timeoutMs: sampleTimeoutMs, maxRows: 6 });
          const values = res.rows
            .map((r) => String(r[0]))
            .filter((v) => v.length > 0 && v.length <= 60)
            .slice(0, 5);
          if (values.length) {
            col.samples = values;
            col.samplesPartial = res.rows.length > 5;
          }
        } catch { /* sampling is best-effort */ }
      }
    }
  }

  schema.generatedAt = new Date().toISOString();
  return schema;
}

/**
 * Render the schema as compact text for the system prompt.
 * Stays under maxChars: drops sample values first, then trailing tables.
 */
function schemaToPromptText(schema, { maxChars = 24000 } = {}) {
  const render = (withSamples, tableLimit) => {
    const lines = [];
    const tables = tableLimit ? schema.tables.slice(0, tableLimit) : schema.tables;
    for (const t of tables) {
      const kind = t.isView ? 'VIEW' : 'TABLE';
      const count = t.rowCount == null ? '' : ` — about ${Number(t.rowCount).toLocaleString('en-US')} rows`;
      lines.push(`${kind} ${t.name}${count}`);
      for (const c of t.columns) {
        let line = `  ${c.name} ${c.type}`;
        if (c.pk) line += ' PRIMARY KEY';
        else if (!c.nullable) line += ' NOT NULL';
        if (withSamples && c.samples) {
          const vals = c.samples.map((s) => `'${s.replace(/'/g, "''")}'`).join(', ');
          line += `  -- values like: ${vals}${c.samplesPartial ? ', …' : ''}`;
        }
        lines.push(line);
      }
      lines.push('');
    }
    const fkLines = [];
    for (const t of tables) {
      for (const fk of t.foreignKeys || []) {
        fkLines.push(`  ${t.name}.${fk.column} -> ${fk.refTable}.${fk.refColumn}`);
      }
    }
    if (fkLines.length) lines.push('RELATIONSHIPS (foreign keys):', ...fkLines);
    if (tableLimit && tableLimit < schema.tables.length) {
      lines.push('', `(… ${schema.tables.length - tableLimit} more tables omitted to fit the model's context window)`);
    }
    return lines.join('\n');
  };

  let text = render(true, 0);
  if (text.length <= maxChars) return { text, truncated: false };

  text = render(false, 0);
  if (text.length <= maxChars) return { text, truncated: false };

  // Binary-search the largest table count that fits.
  let lo = 1;
  let hi = schema.tables.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (render(false, mid).length <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  return { text: render(false, lo), truncated: true };
}

function dialectName(type) {
  return DIALECT_NAMES[type] || type;
}

module.exports = { discoverSchema, schemaToPromptText, dialectName };
