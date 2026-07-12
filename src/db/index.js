'use strict';

// Adapter registry. To add a database, create a module exporting
// { testConnection, getSchema, runQuery, quoteIdent } and register it here.
const ADAPTERS = {
  mysql: () => require('./mysql'),
  postgres: () => require('./postgres'),
  sqlite: () => require('./sqlite'),
  files: () => require('./files')
};

const DIALECT_NAMES = {
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  sqlite: 'SQLite',
  files: 'SQLite'   // files are queried as SQLite
};

// The SQL dialect (for guardrails/quoting) a connection speaks — files → sqlite.
function sqlDialect(type) {
  return type === 'files' ? 'sqlite' : type;
}

function getAdapter(type) {
  const load = ADAPTERS[type];
  if (!load) {
    throw new Error(`Unknown database type "${type}". Supported: ${Object.keys(ADAPTERS).join(', ')}`);
  }
  return load();
}

module.exports = { getAdapter, DIALECT_NAMES, sqlDialect, SUPPORTED: Object.keys(ADAPTERS) };
