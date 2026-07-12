'use strict';

const express = require('express');
const { saveConfig, sanitizeConfig, deepMerge } = require('./config');
const { getAdapter } = require('./db');
const { discoverSchema, schemaToPromptText, dialectName } = require('./schema');
const { validateSql } = require('./guardrails');
const llm = require('./llm');
const prompts = require('../prompts');

const MAX_ATTEMPTS = 3;      // 1 try + 2 self-corrections when SQL is rejected or errors
const MAX_HISTORY_TURNS = 6; // follow-up context sent to the model
const MAX_QUESTION_CHARS = 2000;

function createRoutes(config) {
  const router = express.Router();

  // In-memory cache of the discovered schema.
  const state = { schema: null, schemaText: '', schemaTruncated: false };

  const dbReady = () => Boolean(config.db.type && (config.db.type === 'sqlite' ? config.db.file : config.db.database));

  function sse(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    return {
      send(obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); },
      end() { res.end(); }
    };
  }

  const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---- config ------------------------------------------------------------

  router.get('/config', (req, res) => {
    res.json({ ok: true, config: sanitizeConfig(config), dbReady: dbReady(), schemaLoaded: Boolean(state.schema) });
  });

  router.post('/config', (req, res) => {
    const incoming = req.body || {};
    const prevDb = JSON.stringify(config.db);

    // An empty password in the form means "keep the saved one".
    if (incoming.db && incoming.db.password === '' && config.db.password) {
      delete incoming.db.password;
    }
    if (incoming.db) delete incoming.db.hasPassword;

    Object.assign(config, deepMerge(config, incoming));
    saveConfig(config);

    if (JSON.stringify(config.db) !== prevDb) {
      state.schema = null;
      state.schemaText = '';
    }
    res.json({ ok: true, config: sanitizeConfig(config), dbReady: dbReady() });
  });

  // ---- connectivity ------------------------------------------------------

  router.post('/test-db', asyncRoute(async (req, res) => {
    const dbCfg = normalizeDbInput(req.body?.db, config.db);
    try {
      const adapter = getAdapter(dbCfg.type);
      const result = await adapter.testConnection(dbCfg);
      res.json({ ok: true, info: result.info });
    } catch (e) {
      res.json({ ok: false, error: friendlyDbError(e) });
    }
  }));

  router.post('/test-llm', asyncRoute(async (req, res) => {
    const llmCfg = { ...config.llm, ...(req.body?.llm || {}) };
    try {
      const models = await llm.listModels(llmCfg);
      res.json({ ok: true, models });
    } catch (e) {
      res.json({
        ok: false,
        error: `Could not reach the model server at ${llmCfg.baseUrl} — is LM Studio's server running? (${e.message})`
      });
    }
  }));

  router.get('/models', asyncRoute(async (req, res) => {
    try {
      const models = await llm.listModels(config.llm);
      res.json({ ok: true, models });
    } catch (e) {
      res.json({ ok: false, error: e.message, models: [] });
    }
  }));

  // ---- schema ------------------------------------------------------------

  async function refreshSchema() {
    const schema = await discoverSchema(config.db, {
      sampleValues: config.guardrails.sampleValues !== false
    });
    const { text, truncated } = schemaToPromptText(schema, { maxChars: config.llm.schemaMaxChars });
    state.schema = schema;
    state.schemaText = text;
    state.schemaTruncated = truncated;
    return schema;
  }

  router.post('/schema/refresh', asyncRoute(async (req, res) => {
    if (!dbReady()) return res.status(400).json({ ok: false, error: 'Configure a database connection first' });
    try {
      const schema = await refreshSchema();
      res.json({ ok: true, schema, promptChars: state.schemaText.length, truncated: state.schemaTruncated });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyDbError(e) });
    }
  }));

  router.get('/schema', (req, res) => {
    if (!state.schema) return res.json({ ok: false, error: 'Schema not discovered yet' });
    res.json({ ok: true, schema: state.schema, promptChars: state.schemaText.length, truncated: state.schemaTruncated });
  });

  // ---- suggested questions -----------------------------------------------

  router.post('/suggest', asyncRoute(async (req, res) => {
    const fallback = staticSuggestions(state.schema);
    if (!state.schemaText || !config.llm.model) return res.json({ ok: true, suggestions: fallback });
    try {
      const reply = await llm.streamChat(
        { ...config.llm, timeoutMs: 60000 },
        [{ role: 'user', content: prompts.suggestPrompt({ dialectName: dialectName(config.db.type), schemaText: state.schemaText }) }]
      );
      const cleaned = reply.replace(/<think>[\s\S]*?<\/think>/gi, '');
      const match = /\[[\s\S]*\]/.exec(cleaned);
      const parsed = match ? JSON.parse(match[0]) : [];
      const suggestions = parsed.filter((s) => typeof s === 'string' && s.length < 160).slice(0, 4);
      res.json({ ok: true, suggestions: suggestions.length ? suggestions : fallback });
    } catch {
      res.json({ ok: true, suggestions: fallback });
    }
  }));

  // ---- ask (the main flow, streamed) --------------------------------------

  router.post('/ask', asyncRoute(async (req, res) => {
    const stream = sse(res);
    const abort = new AbortController();
    // Cancel LLM work when the browser goes away. Listen on res, not req —
    // req 'close' fires as soon as the request body is consumed.
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });

    try {
      const question = String(req.body?.question || '').trim().slice(0, MAX_QUESTION_CHARS);
      if (!question) { stream.send({ type: 'error', message: 'Empty question' }); return stream.end(); }
      if (!dbReady()) { stream.send({ type: 'error', message: 'No database configured yet — click Connect first.' }); return stream.end(); }
      if (!config.llm.model) { stream.send({ type: 'error', message: 'No model selected — open Settings and pick a model.' }); return stream.end(); }

      if (!state.schema) {
        stream.send({ type: 'status', message: 'Discovering your database schema…' });
        await refreshSchema();
        stream.send({ type: 'schema_ready' });
      }

      const dialect = config.db.type;
      const system = prompts.sqlSystemPrompt({
        dialectName: dialectName(dialect),
        schemaText: state.schemaText,
        maxRows: config.guardrails.maxRows,
        today: new Date().toISOString().slice(0, 10)
      });

      const messages = [{ role: 'system', content: system }];
      const history = Array.isArray(req.body?.history) ? req.body.history.slice(-MAX_HISTORY_TURNS) : [];
      for (const turn of history) {
        if (!turn || typeof turn.question !== 'string' || typeof turn.sql !== 'string') continue;
        messages.push({ role: 'user', content: turn.question.slice(0, MAX_QUESTION_CHARS) });
        messages.push({ role: 'assistant', content: '```sql\n' + turn.sql.slice(0, 4000) + '\n```' });
      }
      messages.push({ role: 'user', content: question });

      const adapter = getAdapter(dialect);

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        stream.send({ type: 'status', message: attempt === 1 ? 'Thinking…' : `Fixing the query (attempt ${attempt})…` });

        const reply = await llm.streamChat(config.llm, messages, {
          signal: abort.signal,
          onToken: (tok) => stream.send({ type: 'token', text: tok.text, kind: tok.kind, attempt })
        });

        const { sql, message } = llm.extractSql(reply);
        if (!sql) {
          // The model answered in prose (can't answer / needs clarification).
          stream.send({ type: 'message', text: message || 'The model returned an empty reply.' });
          break;
        }

        const verdict = validateSql(sql, { dialect, maxRows: config.guardrails.maxRows });
        if (!verdict.ok) {
          if (attempt === MAX_ATTEMPTS) {
            stream.send({ type: 'error', message: `The model kept producing disallowed SQL. Last reason: ${verdict.reason}`, sql });
            break;
          }
          stream.send({ type: 'retry', attempt, reason: verdict.reason, sql });
          messages.push({ role: 'assistant', content: reply });
          messages.push({ role: 'user', content: prompts.retryPrompt({ kind: 'rejected', detail: verdict.reason, dialectName: dialectName(dialect) }) });
          continue;
        }

        stream.send({ type: 'sql', sql: verdict.sql, autoLimited: verdict.autoLimited });

        if (config.guardrails.approvalMode) {
          stream.send({ type: 'awaiting_approval', sql: verdict.sql });
          break;
        }

        stream.send({ type: 'status', message: 'Running the query…' });
        try {
          const result = await adapter.runQuery(config.db, verdict.sql, {
            timeoutMs: config.guardrails.timeoutMs,
            maxRows: config.guardrails.maxRows
          });
          stream.send({ type: 'result', sql: verdict.sql, ...result });
          break;
        } catch (e) {
          const friendly = friendlyDbError(e);
          if (attempt === MAX_ATTEMPTS) {
            stream.send({ type: 'error', message: `The query failed: ${friendly}`, sql: verdict.sql });
            break;
          }
          stream.send({ type: 'retry', attempt, reason: friendly, sql: verdict.sql });
          messages.push({ role: 'assistant', content: reply });
          messages.push({ role: 'user', content: prompts.retryPrompt({ kind: 'failed', detail: friendly, dialectName: dialectName(dialect) }) });
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) stream.send({ type: 'error', message: e.message });
    }
    stream.send({ type: 'done' });
    stream.end();
  }));

  // ---- run a (possibly hand-edited) query ---------------------------------

  router.post('/run', asyncRoute(async (req, res) => {
    if (!dbReady()) return res.status(400).json({ ok: false, error: 'No database configured' });
    const raw = String(req.body?.sql || '');
    const verdict = validateSql(raw, { dialect: config.db.type, maxRows: config.guardrails.maxRows });
    if (!verdict.ok) return res.json({ ok: false, error: `Blocked by guardrails: ${verdict.reason}` });
    try {
      const adapter = getAdapter(config.db.type);
      const result = await adapter.runQuery(config.db, verdict.sql, {
        timeoutMs: config.guardrails.timeoutMs,
        maxRows: config.guardrails.maxRows
      });
      res.json({ ok: true, sql: verdict.sql, autoLimited: verdict.autoLimited, ...result });
    } catch (e) {
      res.json({ ok: false, error: friendlyDbError(e), sql: verdict.sql });
    }
  }));

  // ---- explain a result ----------------------------------------------------

  router.post('/explain', asyncRoute(async (req, res) => {
    const stream = sse(res);
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const { question, sql, columns, rows } = req.body || {};
      const sample = (rows || []).slice(0, 30);
      const table = [columns, ...sample].map((r) => (r || []).join(' | ')).join('\n');
      const reply = await llm.streamChat(
        { ...config.llm, timeoutMs: 120000 },
        [
          { role: 'system', content: prompts.explainSystemPrompt({ dialectName: dialectName(config.db.type) }) },
          {
            role: 'user',
            content: `Question: ${String(question || '').slice(0, 500)}\n\nSQL used:\n${String(sql || '').slice(0, 2000)}\n\nResult (${(rows || []).length} rows${(rows || []).length > 30 ? ', first 30 shown' : ''}):\n${table.slice(0, 6000)}`
          }
        ],
        {
          signal: abort.signal,
          onToken: (tok) => { if (tok.kind !== 'reasoning') stream.send({ type: 'token', text: tok.text }); }
        }
      );
      stream.send({ type: 'message', text: reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() });
    } catch (e) {
      if (!abort.signal.aborted) stream.send({ type: 'error', message: e.message });
    }
    stream.send({ type: 'done' });
    stream.end();
  }));

  return router;
}

// ---------------------------------------------------------------------------

function staticSuggestions(schema) {
  const tables = schema?.tables || [];
  const list = ['How many rows are in each table?'];
  if (tables[0]) list.push(`Show me a sample of ${tables[0].name}`);
  const withDate = tables.find((t) => t.columns.some((c) => /date|time/i.test(c.type)));
  if (withDate) list.push(`How has ${withDate.name} changed over time?`);
  return list.slice(0, 4);
}

function normalizeDbInput(incoming, saved) {
  const merged = { ...saved, ...(incoming || {}) };
  // Empty password in a test request means "use the saved one".
  if (incoming && incoming.password === '' && saved.password) merged.password = saved.password;
  delete merged.hasPassword;
  return merged;
}

function friendlyDbError(e) {
  const msg = e.message || String(e);
  if (/ECONNREFUSED/.test(msg)) return 'Connection refused — is the database server running, and are host/port right?';
  if (/ETIMEDOUT|ESOCKET|connect timeout/i.test(msg)) return 'Connection timed out — check host, port, and firewall.';
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return 'Host not found — check the hostname.';
  if (/access denied/i.test(msg)) return `Access denied — check username and password. (${msg})`;
  if (/ER_QUERY_TIMEOUT|max_execution_time|statement timeout|canceling statement/i.test(msg)) {
    return 'The query hit the time limit. Try a narrower question, or raise the timeout in Settings.';
  }
  return msg;
}

module.exports = { createRoutes };
