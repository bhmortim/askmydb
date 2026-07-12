'use strict';

// Minimal OpenAI-compatible chat client. Works with LM Studio, Ollama
// (http://localhost:11434/v1), llama.cpp server, vLLM, etc.

function baseUrl(llmCfg) {
  return String(llmCfg.baseUrl || 'http://localhost:1234/v1').replace(/\/+$/, '');
}

function headers(llmCfg) {
  const h = { 'Content-Type': 'application/json' };
  if (llmCfg.apiKey) h.Authorization = `Bearer ${llmCfg.apiKey}`;
  return h;
}

async function listModels(llmCfg) {
  const res = await fetch(`${baseUrl(llmCfg)}/models`, {
    headers: headers(llmCfg),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`LLM server replied ${res.status} ${res.statusText}`);
  const body = await res.json();
  const ids = (body.data || []).map((m) => m.id);
  return {
    chat: ids.filter((id) => !/embed/i.test(id)),
    embedding: ids.filter((id) => /embed/i.test(id))
  };
}

/**
 * Get embedding vectors for an array of texts via the OpenAI-compatible
 * /embeddings endpoint (LM Studio, Ollama, …). Returns number[][].
 */
async function embed(llmCfg, texts, { signal } = {}) {
  if (!llmCfg.embeddingModel) throw new Error('No embedding model configured');
  const res = await fetch(`${baseUrl(llmCfg)}/embeddings`, {
    method: 'POST',
    headers: headers(llmCfg),
    body: JSON.stringify({ model: llmCfg.embeddingModel, input: texts }),
    signal: signal || AbortSignal.timeout(llmCfg.timeoutMs || 120000)
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Embedding server error ${res.status}: ${t.slice(0, 200) || res.statusText}`);
  }
  const body = await res.json();
  // preserve request order
  return (body.data || []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/**
 * Stream a chat completion. Calls onToken({ text, kind }) as tokens arrive
 * (kind is 'reasoning' for models that emit a separate reasoning channel).
 * Resolves with the full assistant message content.
 */
async function streamChat(llmCfg, messages, { onToken, signal } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('LLM request timed out')), llmCfg.timeoutMs || 300000);
  const onOuterAbort = () => controller.abort(new Error('Request cancelled'));
  if (signal) {
    if (signal.aborted) onOuterAbort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  try {
    const res = await fetch(`${baseUrl(llmCfg)}/chat/completions`, {
      method: 'POST',
      headers: headers(llmCfg),
      body: JSON.stringify({
        model: llmCfg.model,
        messages,
        temperature: llmCfg.temperature ?? 0.1,
        stream: true
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM server error ${res.status}: ${text.slice(0, 300) || res.statusText}`);
    }

    let content = '';
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }
        const delta = parsed.choices?.[0]?.delta || {};
        if (delta.reasoning_content) {
          onToken?.({ text: delta.reasoning_content, kind: 'reasoning' });
        }
        if (delta.content) {
          content += delta.content;
          onToken?.({ text: delta.content, kind: 'content' });
        }
      }
    }
    return content;
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Pull the SQL out of a model reply. Handles <think> blocks, ```sql fences,
 * and bare queries. Returns { sql, message } — sql is null when the model
 * answered in prose (e.g. "that isn't in the schema").
 */
function extractSql(text) {
  let t = String(text || '');
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, ''); // closed thinking blocks
  t = t.replace(/<think>[\s\S]*$/i, '');           // unterminated thinking block
  t = t.trim();

  const fenced = [...t.matchAll(/```(?:sql)?\s*\n?([\s\S]*?)```/gi)].map((m) => m[1].trim()).filter(Boolean);
  if (fenced.length) return { sql: fenced[fenced.length - 1], message: t };

  // No code fence: only treat the reply as bare SQL when it *starts* with a
  // query keyword, so prose refusals that merely mention "select" stay prose.
  if (/^(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i.test(t)) {
    return { sql: t.replace(/[.!?]+\s*$/, ''), message: t };
  }
  return { sql: null, message: t };
}

module.exports = { listModels, embed, streamChat, extractSql };
