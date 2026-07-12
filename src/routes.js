'use strict';

const express = require('express');
const { saveConfig, sanitizeConfig, deepMerge } = require('./config');
const { getAdapter } = require('./db');
const conns = require('./db/connections');
const { discoverSchema, schemaToPromptText, dialectName } = require('./schema');
const { validateSql } = require('./guardrails');
const retrieval = require('./retrieval');
const { createSession } = require('./session');
const { profileColumns, columnVector } = require('./analysis/profile');
const { recommendAnalyses } = require('./analysis/recommender');
const { auditAnalysis } = require('./analysis/audit');
const { buildInterpretationContext, buildStatCard } = require('./analysis/interpret');
const { prepareArgs } = require('./analysis/prepare');
const { runAnalysis } = require('./stats');
const { createStore } = require('./analysis/store');
const llm = require('./llm');
const prompts = require('../prompts');

const MAX_ATTEMPTS = 3;
const MAX_HISTORY_TURNS = 6;
const MAX_QUESTION_CHARS = 2000;

function createRoutes(config) {
  const router = express.Router();
  const session = createSession();
  conns.migrateLegacy(config);

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

  // Resolve the connection to use: explicit id, else active, else first/legacy.
  function resolveConn(id) {
    const wanted = id || session.activeConnectionId;
    return conns.getConnection(config, wanted);
  }
  function connReady(dbCfg) {
    return Boolean(dbCfg && dbCfg.type && (dbCfg.type === 'sqlite' ? dbCfg.file : dbCfg.database));
  }
  function anyReady() {
    return conns.listConnections(config).some((c) => connReady(c)) || connReady(config.db);
  }

  // ---- schema discovery + retrieval index (per connection) ----------------

  async function refreshSchema(dbCfg) {
    const schema = await discoverSchema(dbCfg, { sampleValues: config.guardrails.sampleValues !== false });
    const { text, truncated } = schemaToPromptText(schema, { maxChars: config.llm.schemaMaxChars });
    const entry = { schema, schemaText: text, truncated, index: null, type: dbCfg.type };
    session.setSchema(dbCfg.id || 'default', entry);
    // Build an embedding retrieval index in the background for large schemas.
    if (config.llm.embeddingModel && schema.tables.length > retrieval.RETRIEVAL_THRESHOLD) {
      retrieval.buildSchemaIndex(schema, config.llm).then((idx) => { entry.index = idx; }).catch(() => {});
    }
    return entry;
  }

  async function ensureSchema(dbCfg) {
    const id = dbCfg.id || 'default';
    return session.getSchema(id) || await refreshSchema(dbCfg);
  }

  // Build the schema text to put in the prompt, using retrieval when the schema
  // is large and an embedding model is available.
  async function promptSchema(entry, question, signal) {
    const schema = entry.schema;
    if (schema.tables.length <= retrieval.RETRIEVAL_THRESHOLD || !config.llm.embeddingModel) {
      return { text: entry.schemaText, retrieved: false };
    }
    if (!entry.index) entry.index = await retrieval.buildSchemaIndex(schema, config.llm, { signal });
    const sel = await retrieval.selectRelevantTables(schema, question, config.llm, entry.index, {
      maxTables: config.llm.retrievalMaxTables || 8, signal
    });
    if (!sel.retrieved) return { text: entry.schemaText, retrieved: false };
    const pruned = { ...schema, tables: sel.tables };
    const { text } = schemaToPromptText(pruned, { maxChars: config.llm.schemaMaxChars });
    return { text, retrieved: true, tables: sel.tables.map((t) => t.name), scores: sel.scores };
  }

  // ---- config -------------------------------------------------------------

  router.get('/config', (req, res) => {
    res.json({
      ok: true,
      config: sanitizeConfig(config),
      connections: conns.listConnections(config),
      activeConnectionId: session.activeConnectionId,
      dbReady: anyReady()
    });
  });

  router.post('/config', (req, res) => {
    const incoming = req.body || {};
    if (incoming.db && incoming.db.password === '' && config.db.password) delete incoming.db.password;
    if (incoming.db) delete incoming.db.hasPassword;
    // Empty apiKey means "keep the saved one" (it was redacted for the browser).
    if (incoming.llm && incoming.llm.apiKey === '' && config.llm.apiKey) delete incoming.llm.apiKey;
    if (incoming.llm) delete incoming.llm.hasApiKey;
    if (incoming.connections) delete incoming.connections; // managed via /connections

    const prevEmbed = config.llm.embeddingModel;
    Object.assign(config, deepMerge(config, incoming));
    saveConfig(config);

    // Changing the embedding model invalidates every cached retrieval index —
    // old vectors are not comparable to a new model's query embeddings.
    if (incoming.llm && incoming.llm.embeddingModel !== undefined && incoming.llm.embeddingModel !== prevEmbed) {
      for (const c of conns.listConnections(config)) session.clearSchema(c.id);
      session.clearSchema('default');
    }
    res.json({ ok: true, config: sanitizeConfig(config) });
  });

  // ---- connections --------------------------------------------------------

  router.get('/connections', (req, res) => {
    res.json({ ok: true, connections: conns.listConnections(config), activeConnectionId: session.activeConnectionId });
  });

  router.post('/connections', (req, res) => {
    const entry = conns.addConnection(config, req.body?.db || {});
    saveConfig(config);
    if (!session.activeConnectionId) session.activeConnectionId = entry.id;
    res.json({ ok: true, connection: conns.sanitize(entry) });
  });

  router.put('/connections/:id', (req, res) => {
    const updated = conns.updateConnection(config, req.params.id, req.body?.db || {});
    if (!updated) return res.status(404).json({ ok: false, error: 'No such connection' });
    saveConfig(config);
    session.clearSchema(req.params.id);
    res.json({ ok: true, connection: conns.sanitize(updated) });
  });

  router.delete('/connections/:id', (req, res) => {
    const removed = conns.removeConnection(config, req.params.id);
    saveConfig(config);
    session.clearSchema(req.params.id);
    if (session.activeConnectionId === req.params.id) session.activeConnectionId = null;
    res.json({ ok: removed });
  });

  router.post('/connections/:id/activate', (req, res) => {
    const c = conns.getConnection(config, req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'No such connection' });
    session.activeConnectionId = req.params.id;
    res.json({ ok: true, activeConnectionId: req.params.id });
  });

  router.post('/test-db', asyncRoute(async (req, res) => {
    const dbCfg = normalizeDbInput(req.body?.db, req.body?.id ? conns.getConnection(config, req.body.id) : config.db);
    try {
      const result = await getAdapter(dbCfg.type).testConnection(dbCfg);
      res.json({ ok: true, info: result.info });
    } catch (e) {
      res.json({ ok: false, error: friendlyDbError(e) });
    }
  }));

  // ---- LLM connectivity ---------------------------------------------------

  router.post('/test-llm', asyncRoute(async (req, res) => {
    const llmCfg = { ...config.llm, ...(req.body?.llm || {}) };
    try {
      const models = await llm.listModels(llmCfg);
      res.json({ ok: true, models });
    } catch (e) {
      res.json({ ok: false, error: `Could not reach the model server at ${llmCfg.baseUrl} — is the server running? (${e.message})` });
    }
  }));

  router.get('/models', asyncRoute(async (req, res) => {
    try {
      res.json({ ok: true, models: await llm.listModels(config.llm) });
    } catch (e) {
      res.json({ ok: false, error: e.message, models: { chat: [], embedding: [] } });
    }
  }));

  // ---- schema -------------------------------------------------------------

  router.post('/schema/refresh', asyncRoute(async (req, res) => {
    const dbCfg = resolveConn(req.body?.connectionId);
    if (!connReady(dbCfg)) return res.status(400).json({ ok: false, error: 'Configure a database connection first' });
    try {
      const entry = await refreshSchema(dbCfg);
      res.json({ ok: true, connectionId: dbCfg.id || 'default', schema: entry.schema, promptChars: entry.schemaText.length, truncated: entry.truncated });
    } catch (e) {
      res.status(500).json({ ok: false, error: friendlyDbError(e) });
    }
  }));

  router.get('/schema', asyncRoute(async (req, res) => {
    const dbCfg = resolveConn(req.query.connectionId);
    if (!connReady(dbCfg)) return res.json({ ok: false, error: 'No database configured' });
    const entry = session.getSchema(dbCfg.id || 'default');
    if (!entry) return res.json({ ok: false, error: 'Schema not discovered yet' });
    res.json({ ok: true, connectionId: dbCfg.id || 'default', schema: entry.schema, promptChars: entry.schemaText.length, truncated: entry.truncated });
  }));

  // ---- suggested questions ------------------------------------------------

  router.post('/suggest', asyncRoute(async (req, res) => {
    const dbCfg = resolveConn(req.body?.connectionId);
    const entry = connReady(dbCfg) ? session.getSchema(dbCfg.id || 'default') : null;
    const fallback = staticSuggestions(entry && entry.schema);
    if (!entry || !config.llm.model) return res.json({ ok: true, suggestions: fallback });
    try {
      const reply = await llm.streamChat({ ...config.llm, timeoutMs: 60000 },
        [{ role: 'user', content: prompts.suggestPrompt({ dialectName: dialectName(dbCfg.type), schemaText: entry.schemaText }) }]);
      const match = /\[[\s\S]*\]/.exec(reply.replace(/<think>[\s\S]*?<\/think>/gi, ''));
      const parsed = match ? JSON.parse(match[0]) : [];
      const suggestions = parsed.filter((s) => typeof s === 'string' && s.length < 160).slice(0, 4);
      res.json({ ok: true, suggestions: suggestions.length ? suggestions : fallback });
    } catch {
      res.json({ ok: true, suggestions: fallback });
    }
  }));

  // ---- ask (streamed) -----------------------------------------------------

  router.post('/ask', asyncRoute(async (req, res) => {
    const stream = sse(res);
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });

    try {
      const question = String(req.body?.question || '').trim().slice(0, MAX_QUESTION_CHARS);
      const dbCfg = resolveConn(req.body?.connectionId);
      if (!question) { stream.send({ type: 'error', message: 'Empty question' }); return stream.end(); }
      if (!connReady(dbCfg)) { stream.send({ type: 'error', message: 'No database configured yet — click Connect first.' }); return stream.end(); }
      if (!config.llm.model) { stream.send({ type: 'error', message: 'No model selected — open Settings and pick a model.' }); return stream.end(); }

      let entry = session.getSchema(dbCfg.id || 'default');
      if (!entry) {
        stream.send({ type: 'status', message: 'Discovering your database schema…' });
        entry = await refreshSchema(dbCfg);
        stream.send({ type: 'schema_ready', connectionId: dbCfg.id || 'default' });
      }

      const dialect = dbCfg.type;
      const ps = await promptSchema(entry, question, abort.signal);
      if (ps.retrieved) stream.send({ type: 'status', message: `Focusing on ${ps.tables.length} relevant tables…` });

      const system = prompts.sqlSystemPrompt({
        dialectName: dialectName(dialect), schemaText: ps.text,
        maxRows: config.guardrails.maxRows, today: new Date().toISOString().slice(0, 10)
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
      const nCandidates = Math.max(1, Math.min(5, config.llm.selfConsistency || 1));

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        stream.send({ type: 'status', message: attempt === 1 ? 'Thinking…' : `Fixing the query (attempt ${attempt})…` });

        // Self-consistency: generate N candidates, stream the first, keep the rest quiet.
        let reply;
        const candidates = [];
        for (let c = 0; c < (attempt === 1 ? nCandidates : 1); c++) {
          const streamThis = c === 0;
          if (nCandidates > 1 && c === 1) stream.send({ type: 'status', message: `Cross-checking with ${nCandidates} candidates…` });
          const r = await llm.streamChat(
            { ...config.llm, temperature: c === 0 ? config.llm.temperature : Math.max(0.3, config.llm.temperature + 0.3) },
            messages,
            { signal: abort.signal, onToken: streamThis ? (tok) => stream.send({ type: 'token', text: tok.text, kind: tok.kind, attempt }) : undefined }
          );
          if (c === 0) reply = r;
          const ex = llm.extractSql(r);
          if (ex.sql) candidates.push(ex.sql);
        }

        const primary = llm.extractSql(reply);
        if (!primary.sql && !candidates.length) {
          stream.send({ type: 'message', text: primary.message || 'The model returned an empty reply.' });
          break;
        }

        // Validate candidates; vote across the ones that pass.
        const valid = [];
        for (const sql of (candidates.length ? candidates : [primary.sql])) {
          const v = validateSql(sql, { dialect, maxRows: config.guardrails.maxRows });
          if (v.ok) valid.push(v.sql);
        }
        if (!valid.length) {
          const v = validateSql(primary.sql || candidates[0], { dialect, maxRows: config.guardrails.maxRows });
          if (attempt === MAX_ATTEMPTS) { stream.send({ type: 'error', message: `The model kept producing disallowed SQL. Last reason: ${v.reason}`, sql: primary.sql }); break; }
          stream.send({ type: 'retry', attempt, reason: v.reason, sql: primary.sql });
          messages.push({ role: 'assistant', content: reply });
          messages.push({ role: 'user', content: prompts.retryPrompt({ kind: 'rejected', detail: v.reason, dialectName: dialectName(dialect) }) });
          continue;
        }

        const chosen = pickBySql(valid); // plurality by normalized SQL
        stream.send({ type: 'sql', sql: chosen, autoLimited: chosen !== (primary.sql || ''), candidates: valid.length });

        if (config.guardrails.approvalMode) { stream.send({ type: 'awaiting_approval', sql: chosen }); break; }

        stream.send({ type: 'status', message: 'Running the query…' });
        try {
          const result = await adapter.runQuery(dbCfg, chosen, { timeoutMs: config.guardrails.timeoutMs, maxRows: config.guardrails.maxRows });
          const resultId = session.putResult(result, { question, connectionId: dbCfg.id || 'default' });
          stream.send({ type: 'result', sql: chosen, resultId, ...result });
          break;
        } catch (e) {
          const friendly = friendlyDbError(e);
          if (attempt === MAX_ATTEMPTS) { stream.send({ type: 'error', message: `The query failed: ${friendly}`, sql: chosen }); break; }
          stream.send({ type: 'retry', attempt, reason: friendly, sql: chosen });
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
    const dbCfg = resolveConn(req.body?.connectionId);
    if (!connReady(dbCfg)) return res.status(400).json({ ok: false, error: 'No database configured' });
    const verdict = validateSql(String(req.body?.sql || ''), { dialect: dbCfg.type, maxRows: config.guardrails.maxRows });
    if (!verdict.ok) return res.json({ ok: false, error: `Blocked by guardrails: ${verdict.reason}` });
    try {
      const result = await getAdapter(dbCfg.type).runQuery(dbCfg, verdict.sql, { timeoutMs: config.guardrails.timeoutMs, maxRows: config.guardrails.maxRows });
      const resultId = session.putResult(result, { question: 'manual query', connectionId: dbCfg.id || 'default' });
      res.json({ ok: true, sql: verdict.sql, autoLimited: verdict.autoLimited, resultId, ...result });
    } catch (e) {
      res.json({ ok: false, error: friendlyDbError(e), sql: verdict.sql });
    }
  }));

  // ---- explain ------------------------------------------------------------

  router.post('/explain', asyncRoute(async (req, res) => {
    const stream = sse(res);
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const { question, sql, columns, rows } = resolveResultBody(req.body, session);
      const sample = (rows || []).slice(0, 30);
      const table = [columns, ...sample].map((r) => (r || []).join(' | ')).join('\n');
      await llm.streamChat({ ...config.llm, timeoutMs: 120000 }, [
        { role: 'system', content: prompts.explainSystemPrompt({ dialectName: 'SQL' }) },
        { role: 'user', content: `Question: ${String(question || '').slice(0, 500)}\n\nSQL used:\n${String(sql || '').slice(0, 2000)}\n\nResult (${(rows || []).length} rows${(rows || []).length > 30 ? ', first 30 shown' : ''}):\n${table.slice(0, 6000)}` }
      ], { signal: abort.signal, onToken: (tok) => { if (tok.kind !== 'reasoning') stream.send({ type: 'token', text: tok.text }); } });
    } catch (e) {
      if (!abort.signal.aborted) stream.send({ type: 'error', message: e.message });
    }
    stream.send({ type: 'done' });
    stream.end();
  }));

  // ---- results registry ---------------------------------------------------

  router.get('/results', (req, res) => {
    res.json({ ok: true, results: session.listResults() });
  });

  // ---- analysis: recommend ------------------------------------------------

  router.post('/recommend', (req, res) => {
    const body = resolveResultBody(req.body, session);
    if (!body.columns) return res.json({ ok: false, error: 'No result to analyze' });
    const profile = profileColumns({ columns: body.columns, rows: body.rows });
    const recommendations = recommendAnalyses(profile, body.question || '', { maxSuggestions: 5 });
    res.json({ ok: true, recommendations, profile: profileSummary(profile) });
  });

  // ---- analysis: run one analysis -----------------------------------------

  router.post('/analyze', (req, res) => {
    const body = resolveResultBody(req.body, session);
    if (!body.columns) return res.json({ ok: false, error: 'No result to analyze' });
    const kind = String(req.body?.kind || '');
    const mapping = req.body?.columns || {};
    const result = { columns: body.columns, rows: body.rows };
    try {
      const args = prepareArgs(kind, result, mapping, req.body?.options || {});
      const analysis = runAnalysis(kind, args);
      if (analysis.error) return res.json({ ok: false, error: analysis.error, kind });
      const profile = profileColumns(result);
      const sampleForNormality = mapping.y ? columnVector(result, mapping.y) : (mapping.values ? columnVector(result, mapping.values) : undefined);
      const audit = auditAnalysis(kind, analysis, profile, {
        comparisons: req.body?.comparisons || 1,
        sampleForNormality
      });
      const card = buildStatCard(kind, analysis, profile);
      res.json({ ok: true, kind, result: analysis, card, caveats: audit.caveats, mapping });
    } catch (e) {
      res.json({ ok: false, error: e.message, kind });
    }
  });

  // ---- analysis: interpret (streamed narration of computed numbers) -------

  router.post('/interpret', asyncRoute(async (req, res) => {
    const stream = sse(res);
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const { kind, result, caveats, question } = req.body || {};
      const card = buildStatCard(kind, result, null);
      const ctx = buildInterpretationContext(kind, result, null, { caveats: (caveats || []).map((c) => (typeof c === 'string' ? { message: c } : c)) }, question);
      await llm.streamChat({ ...config.llm, timeoutMs: 120000 }, [
        { role: 'system', content: prompts.interpretStatsPrompt() },
        { role: 'user', content: prompts.interpretStatsUser({ statText: ctx.statText, caveats: ctx.caveats, question }) }
      ], { signal: abort.signal, onToken: (tok) => { if (tok.kind !== 'reasoning') stream.send({ type: 'token', text: tok.text }); } });
      stream.send({ type: 'card', card });
    } catch (e) {
      if (!abort.signal.aborted) stream.send({ type: 'error', message: e.message });
    }
    stream.send({ type: 'done' });
    stream.end();
  }));

  // ---- analysis: cross-database correlation -------------------------------

  router.post('/correlate', asyncRoute(async (req, res) => {
    const { leftRef, leftKey, leftValue, rightRef, rightKey, rightValue, method } = req.body || {};
    const left = session.getResult(leftRef);
    const right = session.getResult(rightRef);
    if (!left || !right) return res.json({ ok: false, error: 'Both result sets must exist (run the two queries first)' });

    let store;
    try {
      store = createStore();
    } catch (e) {
      return res.json({ ok: false, error: e.message }); // Node < 22.5
    }
    try {
      const L = store.ingest('left', left.result);
      const R = store.ingest('right', right.result);
      // The client sends ORIGINAL column names; the store sanitized them. Map
      // by position in the original result to the ingested (sanitized) name.
      const mapName = (result, ingest, name) => {
        const idx = result.columns.indexOf(name);
        return idx >= 0 ? ingest.columns[idx] : null;
      };
      const lk = mapName(left.result, L, leftKey);
      const rk = mapName(right.result, R, rightKey);
      const lv = mapName(left.result, L, leftValue);
      const rv = mapName(right.result, R, rightValue);
      if (!lk || !rk || !lv || !rv) return res.json({ ok: false, error: 'key/value columns not found in the selected results' });

      // Aggregate each side to one numeric value per key before joining. This
      // (a) prevents a Cartesian blow-up when a key repeats, and (b) casting the
      // key to TEXT lets keys that differ only by driver type (number vs string)
      // still match across databases.
      const leftUnique = new Set(left.result.rows.map((row) => String(row[left.result.columns.indexOf(leftKey)]))).size;
      const rightUnique = new Set(right.result.rows.map((row) => String(row[right.result.columns.indexOf(rightKey)]))).size;
      const aggregated = leftUnique < left.result.rows.length || rightUnique < right.result.rows.length;

      const joinSql =
        `SELECT l.v AS left_value, r.v AS right_value FROM ` +
        `(SELECT CAST("${lk}" AS TEXT) AS k, AVG("${lv}") AS v FROM "${L.table}" GROUP BY CAST("${lk}" AS TEXT)) l ` +
        `JOIN ` +
        `(SELECT CAST("${rk}" AS TEXT) AS k, AVG("${rv}") AS v FROM "${R.table}" GROUP BY CAST("${rk}" AS TEXT)) r ` +
        `ON l.k = r.k`;
      const joined = store.align(joinSql);
      const n = joined.rows.length;
      if (n < 3) return res.json({ ok: false, error: `Only ${n} keys matched between the two result sets — not enough to correlate. Check that the join columns share values.` });

      const x = joined.rows.map((row) => row[0]);
      const y = joined.rows.map((row) => row[1]);
      const kind = method === 'spearman' ? 'spearman' : 'pearson';
      const analysis = runAnalysis(kind, { x, y });
      const audit = auditAnalysis(kind, analysis, null, { sampleForNormality: y });
      if (aggregated) audit.caveats.unshift({ level: 'info', code: 'aggregated', message: 'One or both datasets had multiple rows per key, so values were averaged per key before correlating.' });
      const card = buildStatCard(kind, analysis, null);
      const joinResult = { columns: ['left_value', 'right_value'], rows: joined.rows, truncated: joined.truncated, durationMs: 0 };
      const resultId = session.putResult(joinResult, { question: 'cross-database join', connectionId: null, label: `join: ${leftValue} × ${rightValue}` });
      res.json({ ok: true, kind, result: analysis, card, caveats: audit.caveats, matched: n, joinResultId: resultId, joinResult });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    } finally {
      store.close();
    }
  }));

  return router;
}

// ---------------------------------------------------------------------------

/** Resolve a request body that may carry an inline result OR a resultRef. */
function resolveResultBody(body, session) {
  if (body && body.resultRef) {
    const e = session.getResult(body.resultRef);
    if (e) return { columns: e.result.columns, rows: e.result.rows, sql: e.sql, question: body.question || e.question };
  }
  return { columns: body?.columns, rows: body?.rows, sql: body?.sql, question: body?.question };
}

function pickBySql(validSqls) {
  if (validSqls.length === 1) return validSqls[0];
  const norm = (s) => s.replace(/\s+/g, ' ').replace(/`|"/g, '').trim().toLowerCase();
  const counts = new Map();
  for (const s of validSqls) {
    const k = norm(s);
    if (!counts.has(k)) counts.set(k, { sql: s, n: 0 });
    counts.get(k).n++;
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0].sql;
}

function profileSummary(profile) {
  return {
    nRows: profile.nRows,
    columns: profile.columns.map((c) => ({ name: c.name, type: c.inferredType, role: c.isLikelyMeasure ? 'measure' : c.isLikelyDate ? 'date' : c.isLikelyDimension ? 'dimension' : c.isLikelyId ? 'id' : 'other' }))
  };
}

function safe(name, cols) { return cols.includes(name) ? name : null; }

function staticSuggestions(schema) {
  const tables = (schema && schema.tables) || [];
  const list = ['How many rows are in each table?'];
  if (tables[0]) list.push(`Show me a sample of ${tables[0].name}`);
  const withDate = tables.find((t) => t.columns.some((c) => /date|time/i.test(c.type)));
  if (withDate) list.push(`How has ${withDate.name} changed over time?`);
  return list.slice(0, 4);
}

function normalizeDbInput(incoming, saved) {
  const merged = { ...(saved || {}), ...(incoming || {}) };
  if (incoming && incoming.password === '' && saved && saved.password) merged.password = saved.password;
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
