'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  port: 3600,
  llm: {
    baseUrl: 'http://localhost:1234/v1', // LM Studio default. Ollama: http://localhost:11434/v1
    apiKey: '',                          // most local servers ignore this; set it if yours requires one
    model: '',                           // picked in the UI from /v1/models
    embeddingModel: '',                  // optional; enables schema retrieval for large DBs
    headers: {},                         // extra request headers (e.g. Cloudflare Access
                                         // service token). File-configured only — never
                                         // shown to or set from the browser.
    temperature: 0.1,
    timeoutMs: 300000,                   // local models can be slow; 5 minutes
    schemaMaxChars: 24000,               // cap on schema text sent to the model (small context windows)
    selfConsistency: 1,                  // sample N SQL candidates and vote (1 = off)
    retrievalMaxTables: 8                // when retrieving, how many tables to include
  },
  // Multiple named connections. A legacy single `db` (below) is migrated in
  // once, tracked by connectionsMigrated so a deleted default isn't recreated.
  connections: [],
  connectionsMigrated: false,
  db: {
    type: '',                            // 'mysql' | 'postgres' | 'sqlite'
    host: 'localhost',
    port: 3306,
    user: '',
    password: '',
    database: '',
    file: '',                            // sqlite only
    ssl: false,                          // encrypt the connection (mysql/postgres)
    sslInsecure: false,                  // skip certificate verification (self-signed servers)
    sslCa: ''                            // optional CA certificate (PEM) to trust
  },
  guardrails: {
    maxRows: 500,        // hard cap on rows returned to the browser
    timeoutMs: 15000,    // per-query timeout
    approvalMode: false, // true = show the SQL and wait for you to click Run
    sampleValues: true   // include example values for text columns in the schema prompt
  }
};

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function loadConfig() {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`Could not read config.json: ${e.message}`);
  }
  return deepMerge(DEFAULTS, fileCfg);
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

// What the browser is allowed to see: everything except DB passwords and the
// LLM API key (which can be a real bearer token for a hosted endpoint).
function sanitizeConfig(cfg) {
  const hdrs = (cfg.llm && cfg.llm.headers) || {};
  return {
    ...cfg,
    llm: {
      ...cfg.llm,
      apiKey: '', hasApiKey: Boolean(cfg.llm && cfg.llm.apiKey),
      // expose only which header keys are set, never their (secret) values
      headers: {}, headerNames: Object.keys(hdrs)
    },
    db: { ...cfg.db, password: '', hasPassword: Boolean(cfg.db.password) },
    connections: (cfg.connections || []).map((c) => {
      const { password, ...rest } = c;
      return { ...rest, hasPassword: Boolean(password) };
    })
  };
}

module.exports = { loadConfig, saveConfig, sanitizeConfig, deepMerge, DEFAULTS, CONFIG_PATH };
