'use strict';

// Named-connection registry. The app can hold several database connections at
// once (mixed MySQL/Postgres/SQLite). Backward compat: a pre-existing single
// `config.db` is migrated into the registry as the connection named "default".

const { getAdapter } = require('./index');

function newId() {
  return 'c' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
}

function isConfigured(db) {
  return Boolean(db && db.type && (db.type === 'sqlite' ? db.file : db.database));
}

/** Ensure config.connections exists and absorb a legacy config.db (once). */
function migrateLegacy(config) {
  if (!Array.isArray(config.connections)) config.connections = [];
  // Only migrate the legacy single db ONCE. A `migrated` flag prevents a
  // deleted "default" connection from being silently resurrected on the next
  // call (which would happen because config.db stays configured).
  if (!config.connectionsMigrated && config.connections.length === 0 && isConfigured(config.db)) {
    config.connections.push({
      id: 'default',
      label: connectionLabel(config.db),
      ...config.db
    });
  }
  config.connectionsMigrated = true;
  return config.connections;
}

function connectionLabel(db) {
  if (!db) return 'connection';
  if (db.type === 'sqlite') return (db.file || 'sqlite').split(/[\\/]/).pop();
  return db.database || db.host || db.type || 'connection';
}

function listConnections(config) {
  migrateLegacy(config);
  return config.connections.map((c) => sanitize(c));
}

function sanitize(c) {
  const { password, ...rest } = c;
  return { ...rest, hasPassword: Boolean(password) };
}

/** Resolve a connection by id. With no id, returns the first (or legacy db). */
function getConnection(config, id) {
  migrateLegacy(config);
  if (!id) return config.connections[0] || (isConfigured(config.db) ? { id: 'default', ...config.db } : null);
  return config.connections.find((c) => c.id === id) || null;
}

function addConnection(config, dbCfg) {
  migrateLegacy(config);
  const id = newId();
  const entry = { id, label: dbCfg.label || connectionLabel(dbCfg), ...stripMeta(dbCfg) };
  config.connections.push(entry);
  return entry;
}

function updateConnection(config, id, dbCfg) {
  migrateLegacy(config);
  const idx = config.connections.findIndex((c) => c.id === id);
  if (idx < 0) return null;
  const prev = config.connections[idx];
  // empty password means "keep the saved one"
  const merged = { ...prev, ...stripMeta(dbCfg), id };
  if ((dbCfg.password === '' || dbCfg.password == null) && prev.password) merged.password = prev.password;
  merged.label = dbCfg.label || connectionLabel(merged);
  config.connections[idx] = merged;
  return merged;
}

function removeConnection(config, id) {
  migrateLegacy(config);
  const before = config.connections.length;
  config.connections = config.connections.filter((c) => c.id !== id);
  return config.connections.length < before;
}

function stripMeta(dbCfg) {
  const { hasPassword, ...rest } = dbCfg || {};
  return rest;
}

/** Get { dbConfig, adapter } for a connection id. Throws if missing. */
function getConnectionAdapter(config, id) {
  const dbConfig = getConnection(config, id);
  if (!dbConfig) throw new Error(`No such connection: ${id || '(default)'}`);
  return { dbConfig, adapter: getAdapter(dbConfig.type) };
}

module.exports = {
  migrateLegacy, listConnections, getConnection, addConnection,
  updateConnection, removeConnection, getConnectionAdapter, connectionLabel, isConfigured, sanitize
};
