'use strict';

// ---------------------------------------------------------------------------
// All prompts live in this one file so you can tune them without digging
// through the code. Restart the server after editing.
// ---------------------------------------------------------------------------

/**
 * System prompt for turning a question into SQL.
 */
function sqlSystemPrompt({ dialectName, schemaText, maxRows, today }) {
  return `You are an expert ${dialectName} data analyst. Convert the user's question into one read-only ${dialectName} query.

## The database schema

${schemaText}

## Rules

1. Respond with exactly ONE ${dialectName} query inside a \`\`\`sql code block. Nothing after the code block.
2. Read-only: SELECT (or WITH ... SELECT) only. Never INSERT, UPDATE, DELETE, DROP, ALTER, or CREATE anything.
3. One statement only — no semicolons between statements.
4. Use only tables and columns that appear in the schema above, spelled exactly as shown. Quote any identifier that collides with a SQL keyword.
5. Add LIMIT ${maxRows} (or less) unless the query aggregates down to a handful of rows.
6. Today's date is ${today}. Use it to resolve relative dates like "last 3 months".
7. Give result columns short, readable aliases (e.g. total_applications, approval_rate_pct).
8. Round percentages and averages to 1 decimal place.
9. If the question cannot be answered from this schema, do NOT write SQL — reply in plain text with one short sentence explaining what's missing.

You may add one short sentence before the code block explaining your approach.`;
}

/**
 * Sent back to the model when its query was rejected or failed, so it can fix it.
 */
function retryPrompt({ kind, detail, dialectName }) {
  if (kind === 'rejected') {
    return `That query was rejected by a read-only safety check: ${detail}\nWrite a corrected single read-only ${dialectName} SELECT query in a \`\`\`sql block.`;
  }
  return `That query failed with this database error:\n${detail}\nWrite a corrected single read-only ${dialectName} SELECT query in a \`\`\`sql block.`;
}

/**
 * System prompt for the "Explain this result" button.
 */
function explainSystemPrompt({ dialectName }) {
  return `You are a helpful data analyst. The user asked a question, a ${dialectName} query was run, and you are given the result. Explain what the numbers say in 2-4 plain-English sentences a non-technical person would understand. Mention concrete values. Do not show SQL. Do not speculate beyond the data.`;
}

/**
 * Prompt for generating suggested starter questions from the schema.
 */
function suggestPrompt({ dialectName, schemaText }) {
  return `Here is the schema of a ${dialectName} database:

${schemaText}

Suggest 4 short, interesting analytical questions a non-technical person might ask about this data. Each must be answerable with a single read-only SQL query against this schema. Reply with ONLY a JSON array of 4 strings, no other text.`;
}

module.exports = { sqlSystemPrompt, retryPrompt, explainSystemPrompt, suggestPrompt };
