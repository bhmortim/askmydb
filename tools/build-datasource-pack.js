'use strict';

// Build the public-data-source recommendation pack from the embedding corpus.
// Embeds one vector per source (description + research-applications text) with
// the configured embedding model, and writes a compact runtime pack that
// askmydb loads to recommend relevant public datasets for a research question.
//
// Usage:
//   node tools/build-datasource-pack.js <sources.jsonl> [outDir] \
//        [--base http://localhost:1234/v1] [--model text-embedding-nomic-embed-text-v1.5]
//
// Output (outDir, default data/datasources/):
//   meta.json      — array of trimmed source metadata (the recommendation cards)
//   vectors.f32    — Float32Array binary, count*dim, row-aligned to meta.json
//   pack.json      — { count, dim, model, builtAt }

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : def;
}

const SOURCES = process.argv[2];
const OUT_DIR = process.argv[3] && !process.argv[3].startsWith('--')
  ? process.argv[3]
  : path.join(__dirname, '..', 'data', 'datasources');
const BASE = arg('--base', 'http://localhost:1234/v1').replace(/\/+$/, '');
const MODEL = arg('--model', 'text-embedding-nomic-embed-text-v1.5');
const BATCH = Number(arg('--batch', 128));

if (!SOURCES || !fs.existsSync(SOURCES)) {
  console.error('Usage: node tools/build-datasource-pack.js <sources.jsonl> [outDir] [--base URL] [--model NAME]');
  process.exit(1);
}

async function embed(texts) {
  const res = await fetch(`${BASE}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: texts })
  });
  if (!res.ok) throw new Error(`embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// Text we embed per source: what it is + what it's for (research applications).
function embedText(src) {
  const apps = (src.chunks || []).find((c) => c.type === 'research_applications');
  const appText = apps ? apps.text.replace(/^.*?:\s*/, '') : '';
  return `${src.name} — ${src.publisher}. ${src.description || ''} ${appText}`.slice(0, 1200);
}

// The "why this helps" line shown to the user.
function whyText(src) {
  const apps = (src.chunks || []).find((c) => c.type === 'research_applications');
  return apps ? apps.text.replace(/^.*?:\s*/, '').trim() : '';
}

function trimMeta(src) {
  return {
    id: src.id,
    name: src.name,
    publisher: src.publisher,
    url: src.url,
    primary_topic: src.primary_topic,
    topics: src.topics,
    geo: src.geo,
    coverage_start: src.coverage_start,
    coverage_end: src.coverage_end,
    tier: src.tier,
    priority: src.priority_score,
    why: whyText(src),
    desc: (src.description || '').slice(0, 400)
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const meta = [];
  const vectorChunks = [];
  let dim = 0;
  let pending = [];
  let pendingSrc = [];
  let done = 0;

  async function flush() {
    if (!pending.length) return;
    const vecs = await embed(pending);
    dim = vecs[0].length;
    for (let i = 0; i < vecs.length; i++) {
      meta.push(trimMeta(pendingSrc[i]));
      vectorChunks.push(Float32Array.from(vecs[i]));
    }
    done += pending.length;
    process.stdout.write(`\r  embedded ${done} sources…`);
    pending = [];
    pendingSrc = [];
  }

  const rl = readline.createInterface({ input: fs.createReadStream(SOURCES, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let src;
    try { src = JSON.parse(line); } catch { continue; }
    pending.push(embedText(src));
    pendingSrc.push(src);
    if (pending.length >= BATCH) await flush();
  }
  await flush();

  // write vectors as one contiguous Float32 buffer
  const buf = Buffer.allocUnsafe(meta.length * dim * 4);
  for (let i = 0; i < vectorChunks.length; i++) {
    Buffer.from(vectorChunks[i].buffer).copy(buf, i * dim * 4);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'vectors.f32'), buf);
  fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(OUT_DIR, 'pack.json'), JSON.stringify({
    count: meta.length, dim, model: MODEL, builtAt: new Date().toISOString()
  }, null, 2));

  console.log(`\n  done: ${meta.length} sources, dim ${dim}`);
  console.log(`  wrote ${OUT_DIR}\\{meta.json, vectors.f32, pack.json}`);
}

main().catch((e) => { console.error('\n', e.message); process.exit(1); });
