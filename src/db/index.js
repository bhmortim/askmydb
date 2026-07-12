'use strict';

// Adapter registry. To add a database, create a module exporting
// { testConnection, getSchema, runQuery, quoteIdent } and register it here.
const ADAPTERS = {
  mysql: () => require('./mysql'),
  postgres: () => require('./postgres'),
  sqlite: () => require('./sqlite')
};

const DIALECT_NAMES = {
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  sqlite: 'SQLite'
};

function getAdapter(type) {
  const load = ADAPTERS[type];
  if (!load) {
    throw new Error(`Unknown database type "${type}". Supported: ${Object.keys(ADAPTERS).join(', ')}`);
  }
  return load();
}

module.exports = { getAdapter, DIALECT_NAMES, SUPPORTED: Object.keys(ADAPTERS) };
