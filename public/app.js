'use strict';

/* askmydb frontend. No dependencies, no build step.
   All data is rendered with textContent/createElement — never innerHTML with
   database content — so query results can't inject markup. */

const $ = (sel) => document.querySelector(sel);

const state = {
  config: null,
  schema: null,
  connections: [],
  activeConnectionId: null,
  editingConnId: null,      // null = adding a new connection
  pendingFiles: [],         // files being attached to a files-connection
  lastModels: { chat: [], embedding: [] },
  history: [],   // [{question, sql}] for follow-up context
  busy: false
};

/* ---------------- tiny DOM helper ---------------- */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const child of children.flat()) if (child) node.append(child);
  return node;
}

const nfmt = new Intl.NumberFormat('en-US');
const nfmtCompact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
function fmtNum(v) {
  if (typeof v !== 'number') return String(v);
  if (Number.isInteger(v)) return nfmt.format(v);
  return nfmt.format(Math.round(v * 100) / 100);
}
function fmtAxis(v) {
  return Math.abs(v) >= 10000 ? nfmtCompact.format(v) : nfmt.format(v);
}

/* ---------------- API helpers ---------------- */

async function api(path, body) {
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return res.json();
}

async function sendJson(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return res.json();
}

/** POST that reads a server-sent-event stream; calls onEvent per event. */
async function sseStream(path, body, onEvent) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok || !res.body) throw new Error(`Server error ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = raw.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try { onEvent(JSON.parse(line.slice(5))); } catch { /* skip malformed */ }
    }
  }
}

/* ---------------- theme ---------------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('askmydb-theme', theme);
}
$('#themeBtn').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

/* ---------------- connections ---------------- */

function activeConn() {
  return state.connections.find((c) => c.id === state.activeConnectionId) || state.connections[0] || null;
}

function renderConnections() {
  const listEl = $('#connList');
  listEl.textContent = '';
  const hasAny = state.connections.length > 0;
  $('#connectBtn').hidden = hasAny;
  $('#correlateBtn').hidden = state.connections.length < 1;

  for (const c of state.connections) {
    const active = c.id === state.activeConnectionId;
    const dot = el('span', { class: 'dot' + (active && state.schema ? ' on' : '') });
    const item = el('div', { class: 'conn-item' + (active ? ' active' : '') },
      dot,
      el('div', { class: 'conn-labels' },
        el('div', { class: 'conn-name', title: c.label }, c.label || c.database || c.file || c.type),
        el('div', { class: 'conn-type' }, c.type === 'files' ? 'spreadsheets' : c.type)),
      el('button', {
        class: 'icon-btn icon-btn-sm conn-edit', type: 'button', title: 'Edit',
        onclick: (e) => { e.stopPropagation(); openConnectionEditor(c.id); }
      }, svgEl('svg', { viewBox: '0 0 24 24' }, svgEl('path', { d: 'M4 20h4L18 10l-4-4L4 16v4zM14 6l4 4', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linejoin': 'round' })))
    );
    item.addEventListener('click', () => switchConnection(c.id));
    listEl.append(item);
  }
  updateComposerEnabled();
}

async function switchConnection(id) {
  if (id === state.activeConnectionId && state.schema) return;
  state.activeConnectionId = id;
  await api(`/connections/${id}/activate`, {});
  state.schema = null;
  renderConnections();
  const conn = activeConn();
  const schemaRes = await api(`/schema?connectionId=${id}`);
  if (schemaRes.ok) {
    state.schema = schemaRes.schema;
  } else {
    const refreshed = await api('/schema/refresh', { connectionId: id });
    if (refreshed.ok) state.schema = refreshed.schema;
  }
  renderSchemaTree();
  renderConnections();
  loadSuggestions();
}

function connIsReady(conn) {
  if (!conn || !conn.type) return false;
  if (conn.type === 'sqlite') return Boolean(conn.file);
  if (conn.type === 'files') return Array.isArray(conn.files) && conn.files.length > 0;
  return Boolean(conn.database);
}
function updateComposerEnabled() {
  const conn = activeConn();
  const ready = connIsReady(conn);
  const canAsk = ready && Boolean(state.config?.llm?.model);
  $('#questionInput').disabled = !canAsk;
  $('#sendBtn').disabled = !canAsk || state.busy;
}

// kept as an alias so existing call sites still work
function renderConnStatus() { renderConnections(); }

/* ---------------- schema sidebar ---------------- */

function renderSchemaTree() {
  const tree = $('#schemaTree');
  tree.textContent = '';
  if (!state.schema) { $('#schemaSection').hidden = true; return; }
  $('#schemaSection').hidden = false;

  for (const table of state.schema.tables) {
    const cols = el('div', { class: 'tbl-cols' },
      table.columns.map((c) =>
        el('div', { class: 'tbl-col' },
          c.pk ? el('span', { class: 'key', title: 'primary key' }, 'PK') : null,
          el('span', { class: 'cname' }, c.name),
          el('span', { class: 'ctype' }, c.type)
        ))
    );
    const row = el('button', { class: 'tbl-row', type: 'button' },
      svgEl('svg', { class: 'caret', viewBox: '0 0 16 16' },
        svgEl('path', { d: 'M6 4l4 4-4 4', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' })),
      el('span', { class: 'tname', title: table.name }, table.name),
      el('span', { class: 'tcount' }, table.rowCount == null ? '' : nfmtCompact.format(table.rowCount))
    );
    const box = el('div', { class: 'tbl', dataset: { name: table.name.toLowerCase() } }, row, cols);
    row.addEventListener('click', () => box.classList.toggle('open'));
    tree.append(box);
  }
}

$('#schemaFilter').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  for (const box of document.querySelectorAll('.tbl')) {
    box.style.display = !q || box.dataset.name.includes(q) ? '' : 'none';
  }
});

$('#refreshSchemaBtn').addEventListener('click', async () => {
  const res = await api('/schema/refresh', { connectionId: state.activeConnectionId });
  if (res.ok) {
    state.schema = res.schema;
    renderSchemaTree();
    loadSuggestions();
  }
  renderConnections();
});

/* ---------------- suggestions ---------------- */

function renderSuggestions(list) {
  const box = $('#suggestions');
  if (!box) return; // welcome screen already dismissed
  box.textContent = '';
  for (const q of list) {
    box.append(el('button', { class: 'chip', type: 'button', onclick: () => { $('#questionInput').value = q; askCurrent(); } }, q));
  }
}

async function loadSuggestions() {
  if (!state.schema) return;
  const fallback = defaultSuggestions();
  renderSuggestions(fallback);
  try {
    const res = await api('/suggest', { connectionId: state.activeConnectionId });
    if (res.ok && res.suggestions?.length) renderSuggestions(res.suggestions);
  } catch { /* keep fallback */ }
}

function defaultSuggestions() {
  const tables = state.schema?.tables || [];
  const first = tables[0]?.name;
  const list = ['How many rows are in each table?'];
  if (first) list.push(`Show me a sample of ${first}`);
  const withDate = tables.find((t) => t.columns.some((c) => /date|time/i.test(c.type)));
  if (withDate) list.push(`How has ${withDate.name} grown over time?`);
  return list.slice(0, 4);
}

/* ---------------- chat rendering ---------------- */

const chat = $('#chat');

function scrollChat() {
  chat.scrollTop = chat.scrollHeight;
}

function addUserMessage(text) {
  $('#welcome')?.remove();
  chat.append(el('div', { class: 'msg msg-user' }, el('div', { class: 'bubble' }, text)));
  scrollChat();
}

function newAssistantCard() {
  const statusText = el('span');
  const statusLine = el('div', { class: 'status-line' }, el('span', { class: 'spinner' }), statusText);
  const thinkingBody = el('div', { class: 'thinking-body' });
  const thinking = el('details', { class: 'thinking' },
    el('summary', {}, 'model output'), thinkingBody);
  thinking.style.display = 'none';
  const body = el('div', { class: 'card-body' });
  const card = el('div', { class: 'card' }, statusLine, thinking, body);
  chat.append(el('div', { class: 'msg' }, card));
  scrollChat();

  return {
    card, body,
    setStatus(msg) { statusText.textContent = msg; statusLine.style.display = ''; },
    clearStatus() { statusLine.style.display = 'none'; },
    appendThinking(text) {
      thinking.style.display = '';
      thinkingBody.append(document.createTextNode(text));
      thinkingBody.scrollTop = thinkingBody.scrollHeight;
    },
    collapseThinking() { thinking.open = false; }
  };
}

/* SQL syntax highlighting — builds DOM nodes, never innerHTML. */
const SQL_KEYWORDS = new Set(('select from where group by order having limit offset join left right inner outer full cross on as and or not in is null like between union all distinct case when then else end with count sum avg min max round cast desc asc show describe explain values exists').split(' '));

function highlightSql(sql) {
  const pre = el('pre');
  const tokens = sql.split(/('(?:[^'\\]|\\.|'')*'|--[^\n]*|\/\*[\s\S]*?\*\/|`[^`]*`|"[^"]*"|\b\d+(?:\.\d+)?\b)/g);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith("'")) pre.append(el('span', { class: 'str' }, t));
    else if (t.startsWith('--') || t.startsWith('/*')) pre.append(el('span', { class: 'cmt' }, t));
    else if (/^\d/.test(t)) pre.append(el('span', { class: 'num' }, t));
    else if (t.startsWith('`') || t.startsWith('"')) pre.append(t);
    else {
      // split plain text into words; color keywords
      for (const part of t.split(/(\w+)/g)) {
        if (SQL_KEYWORDS.has(part.toLowerCase())) pre.append(el('span', { class: 'kw' }, part));
        else if (part) pre.append(part);
      }
    }
  }
  return pre;
}

function sqlBlock(sql) {
  return el('div', { class: 'sql-block' }, highlightSql(sql));
}

/* ---------------- results: table ---------------- */

function isNumericColumn(rows, colIdx) {
  let seen = false;
  for (const row of rows) {
    const v = row[colIdx];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'number') return false;
    seen = true;
  }
  return seen;
}

function renderTable(columns, rows) {
  const numeric = columns.map((_, i) => isNumericColumn(rows, i));
  const thead = el('thead', {}, el('tr', {},
    columns.map((c, i) => el('th', { class: numeric[i] ? 'num' : '' }, c))));
  const tbody = el('tbody', {},
    rows.map((row) => el('tr', {},
      row.map((v, i) => {
        const td = el('td', { class: numeric[i] ? 'num' : '' });
        if (v === null || v === undefined) td.append(el('span', { class: 'null' }, 'NULL'));
        else {
          const text = typeof v === 'number' ? fmtNum(v) : String(v);
          td.textContent = text;
          if (text.length > 40) td.title = String(v);
        }
        return td;
      }))));
  return el('div', { class: 'table-wrap' }, el('table', { class: 'result' }, thead, tbody));
}

/* ---------------- results: chart ---------------- */

const SERIES_VARS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];
const tooltip = $('#chartTooltip');

function showTooltip(evt, label, valueText) {
  tooltip.textContent = '';
  tooltip.append(el('span', { class: 'tt-label' }, label + ': '), el('span', { class: 'tt-val' }, valueText));
  tooltip.hidden = false;
  const pad = 12;
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  const r = tooltip.getBoundingClientRect();
  if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - pad;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}
function hideTooltip() { tooltip.hidden = true; }

/** Decide whether/how to chart a result. */
function chartPlan(columns, rows) {
  if (!rows.length || rows.length < 2 || rows.length > 100 || columns.length < 2) return null;
  const numericIdx = columns.map((_, i) => i).filter((i) => isNumericColumn(rows, i));
  const labelIdx = columns.map((_, i) => i).find((i) => !numericIdx.includes(i));
  if (labelIdx === undefined || !numericIdx.length) return null;
  const series = numericIdx.slice(0, 3);
  const labels = rows.map((r) => r[labelIdx] === null ? '(null)' : String(r[labelIdx]));
  const dateLike = labels.every((l) => /^\d{4}[-/]\d{2}/.test(l));
  const type = dateLike && rows.length >= 6 ? 'line' : 'bar';
  return { type, labelIdx, series, labels };
}

function niceTicks(maxValue, count = 4) {
  if (maxValue <= 0) return [0, 1];
  const rough = maxValue / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) || mag * 10;
  // The top tick must cover maxValue, or bars overflow the plot area.
  const top = Math.ceil(maxValue / step - 1e-9) * step;
  const ticks = [];
  for (let v = 0; v <= top + step * 0.001; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/** Horizontal bars: rounded data-end, 2px gaps, hairline grid, direct labels. */
function renderBarChart(columns, rows, plan) {
  const { labelIdx, series, labels } = plan;
  const n = rows.length;
  const multi = series.length > 1;
  const rowH = multi ? series.length * 14 + 10 : 22;
  const gap = 6;
  const labelW = 150;
  const valueW = 62;
  const W = 760;
  const chartH = n * (rowH + gap);
  const topPad = 18;
  const H = chartH + topPad + 24;
  const plotW = W - labelW - valueW - 16;

  let maxV = 0;
  for (const r of rows) for (const s of series) maxV = Math.max(maxV, Number(r[s]) || 0);
  if (maxV <= 0) maxV = 1;
  const ticks = niceTicks(maxV);
  const scaleMax = ticks[ticks.length - 1];
  const x = (v) => (v / scaleMax) * plotW;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });

  // hairline gridlines + tick labels
  for (const t of ticks) {
    const gx = labelW + x(t);
    svg.append(svgEl('line', { x1: gx, y1: topPad - 6, x2: gx, y2: topPad + chartH, stroke: 'var(--grid)', 'stroke-width': 1 }));
    svg.append(svgEl('text', { x: gx, y: topPad + chartH + 16, 'text-anchor': 'middle', fill: 'var(--ink-3)', 'font-size': 11 }, fmtAxis(t)));
  }
  // baseline
  svg.append(svgEl('line', { x1: labelW, y1: topPad - 6, x2: labelW, y2: topPad + chartH, stroke: 'var(--baseline)', 'stroke-width': 1 }));

  rows.forEach((row, i) => {
    const y0 = topPad + i * (rowH + gap);
    // category label (muted ink, truncated)
    const label = labels[i];
    const labelText = svgEl('text', {
      x: labelW - 8, y: y0 + rowH / 2 + 4, 'text-anchor': 'end',
      fill: 'var(--ink-2)', 'font-size': 12
    }, label.length > 22 ? label.slice(0, 21) + '…' : label);
    labelText.append(svgEl('title', {}, label));
    svg.append(labelText);

    series.forEach((s, si) => {
      const v = Number(row[s]) || 0;
      const bw = Math.max(x(v), 0);
      const bh = multi ? 12 : rowH - 6;
      const by = multi ? y0 + si * 14 + 2 : y0 + 3;
      const r = Math.min(4, bh / 2, bw);
      // bar with rounded data-end (right corners only), anchored to the baseline
      const d = bw <= 0.5
        ? `M ${labelW} ${by} h1 v${bh} h-1 Z`
        : `M ${labelW} ${by} h ${Math.max(bw - r, 0)} a ${r} ${r} 0 0 1 ${r} ${r} v ${bh - 2 * r} a ${r} ${r} 0 0 1 -${r} ${r} h -${Math.max(bw - r, 0)} Z`;
      const bar = svgEl('path', { d, fill: SERIES_VARS[si] });
      bar.addEventListener('mousemove', (evt) => showTooltip(evt, multi ? `${label} — ${columns[s]}` : label, fmtNum(v)));
      bar.addEventListener('mouseleave', hideTooltip);
      svg.append(bar);
      // direct value label at the bar end (single series, ≤ 20 rows)
      if (!multi && n <= 20) {
        svg.append(svgEl('text', {
          x: labelW + bw + 6, y: by + bh / 2 + 4,
          fill: 'var(--ink-2)', 'font-size': 11.5, 'font-variant-numeric': 'tabular-nums'
        }, fmtAxis(v)));
      }
    });
  });

  const wrap = el('div', { class: 'chart-wrap' });
  if (multi) {
    wrap.append(el('div', { class: 'chart-legend' },
      series.map((s, si) => el('span', { class: 'legend-item' },
        el('span', { class: 'legend-swatch', style: `background:${SERIES_VARS[si]}` }), columns[s]))));
  }
  wrap.append(svg);
  return wrap;
}

/** Line chart for date-like x axes. */
function renderLineChart(columns, rows, plan) {
  const { series, labels } = plan;
  const n = rows.length;
  const multi = series.length > 1;
  const W = 760, H = 300;
  const padL = 56, padR = 16, padT = 14, padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  let maxV = 0;
  for (const r of rows) for (const s of series) maxV = Math.max(maxV, Number(r[s]) || 0);
  if (maxV <= 0) maxV = 1;
  const ticks = niceTicks(maxV);
  const scaleMax = ticks[ticks.length - 1];
  const xPos = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yPos = (v) => padT + plotH - (v / scaleMax) * plotH;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });

  for (const t of ticks) {
    svg.append(svgEl('line', { x1: padL, y1: yPos(t), x2: padL + plotW, y2: yPos(t), stroke: 'var(--grid)', 'stroke-width': 1 }));
    svg.append(svgEl('text', { x: padL - 8, y: yPos(t) + 4, 'text-anchor': 'end', fill: 'var(--ink-3)', 'font-size': 11 }, fmtAxis(t)));
  }
  svg.append(svgEl('line', { x1: padL, y1: padT + plotH, x2: padL + plotW, y2: padT + plotH, stroke: 'var(--baseline)', 'stroke-width': 1 }));

  // x labels: at most ~8, evenly picked
  const step = Math.max(1, Math.ceil(n / 8));
  for (let i = 0; i < n; i += step) {
    svg.append(svgEl('text', { x: xPos(i), y: padT + plotH + 18, 'text-anchor': 'middle', fill: 'var(--ink-3)', 'font-size': 11 }, labels[i].slice(0, 10)));
  }

  series.forEach((s, si) => {
    const pts = rows.map((r, i) => [xPos(i), yPos(Number(r[s]) || 0)]);
    svg.append(svgEl('path', {
      d: pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' '),
      fill: 'none', stroke: SERIES_VARS[si], 'stroke-width': 2, 'stroke-linejoin': 'round'
    }));
    if (n <= 40) {
      pts.forEach((p, i) => {
        const v = Number(rows[i][s]) || 0;
        const dot = svgEl('circle', { cx: p[0], cy: p[1], r: 4, fill: SERIES_VARS[si], stroke: 'var(--surface)', 'stroke-width': 2 });
        dot.addEventListener('mousemove', (evt) => showTooltip(evt, multi ? `${labels[i]} — ${columns[s]}` : labels[i], fmtNum(v)));
        dot.addEventListener('mouseleave', hideTooltip);
        svg.append(dot);
      });
    }
  });

  const wrap = el('div', { class: 'chart-wrap' });
  if (multi) {
    wrap.append(el('div', { class: 'chart-legend' },
      series.map((s, si) => el('span', { class: 'legend-item' },
        el('span', { class: 'legend-swatch', style: `background:${SERIES_VARS[si]}` }), columns[s]))));
  }
  wrap.append(svg);
  return wrap;
}

/* ---------------- results: assembled card section ---------------- */

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Formula-injection guard for spreadsheet apps (leading CR too — a spreadsheet
  // treats a bare CR as a row break, so a "\r=FORMULA" cell could re-inject).
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  // Quote any field with a delimiter OR a bare CR/LF, so embedded line breaks
  // stay inside the cell instead of splitting the row.
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv(columns, rows) {
  const lines = [columns.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'askmydb-result.csv' });
  a.click();
  URL.revokeObjectURL(a.href);
}

function renderResult(cardCtl, data, question) {
  const { columns, rows, truncated, durationMs, sql } = data;
  const body = cardCtl.body;

  body.append(sqlBlock(sql));

  const meta = el('div', { class: 'result-meta' },
    el('span', {}, `${nfmt.format(rows.length)} row${rows.length === 1 ? '' : 's'}`),
    el('span', {}, `${durationMs} ms`)
  );
  if (truncated || data.autoLimited) meta.append(el('span', { class: 'badge', title: 'The row cap in Settings limits how much data one query can pull.' }, 'row limit applied'));

  const plan = rows.length ? chartPlan(columns, rows) : null;
  const tableView = rows.length
    ? renderTable(columns, rows)
    : el('div', { class: 'result-meta' }, 'The query ran fine but returned no rows.');
  let chartView = null;
  if (plan) {
    chartView = plan.type === 'line' ? renderLineChart(columns, rows, plan) : renderBarChart(columns, rows, plan);
    chartView.style.display = 'none';
  }

  if (plan) {
    const tabTable = el('button', { class: 'tab active', type: 'button' }, 'Table');
    const tabChart = el('button', { class: 'tab', type: 'button' }, 'Chart');
    tabTable.addEventListener('click', () => {
      tabTable.classList.add('active'); tabChart.classList.remove('active');
      tableView.style.display = ''; chartView.style.display = 'none';
    });
    tabChart.addEventListener('click', () => {
      tabChart.classList.add('active'); tabTable.classList.remove('active');
      tableView.style.display = 'none'; chartView.style.display = '';
    });
    meta.prepend(el('span', { class: 'tabs' }, tabTable, tabChart));
  }

  body.append(meta, tableView);
  if (chartView) body.append(chartView);

  // actions
  const actions = el('div', { class: 'actions-row' });
  const copyBtn = el('button', { class: 'btn btn-sm', type: 'button' }, 'Copy SQL');
  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(sql);
    copyBtn.textContent = 'Copied ✓';
    setTimeout(() => (copyBtn.textContent = 'Copy SQL'), 1500);
  });
  const editBtn = el('button', { class: 'btn btn-sm', type: 'button' }, 'Edit SQL');
  editBtn.addEventListener('click', () => openSqlEditor(cardCtl, sql, question));
  const csvBtn = el('button', { class: 'btn btn-sm', type: 'button' }, 'Download CSV');
  csvBtn.addEventListener('click', () => downloadCsv(columns, rows));
  actions.append(copyBtn, editBtn, csvBtn);

  if (rows.length) {
    const explainBtn = el('button', { class: 'btn btn-sm', type: 'button' }, 'Explain this result');
    explainBtn.addEventListener('click', () => explainResult(cardCtl, explainBtn, { question, sql, columns, rows }));
    actions.append(explainBtn);

    const analyzeBtn = el('button', { class: 'btn btn-sm', type: 'button' }, '📊 Analyze');
    analyzeBtn.addEventListener('click', () => analyzeResult(cardCtl, analyzeBtn, { question, columns, rows, resultId: data.resultId }));
    actions.append(analyzeBtn);
  }
  body.append(actions);
  scrollChat();
}

function openSqlEditor(cardCtl, sql, question) {
  const editor = el('textarea', { class: 'sql-editor', spellcheck: 'false' });
  editor.value = sql;
  const runBtn = el('button', { class: 'btn btn-sm btn-primary', type: 'button' }, 'Run');
  const cancelBtn = el('button', { class: 'btn btn-sm', type: 'button' }, 'Cancel');
  const box = el('div', {}, editor, el('div', { class: 'actions-row' }, runBtn, cancelBtn));
  cardCtl.body.append(box);
  editor.focus();

  cancelBtn.addEventListener('click', () => box.remove());
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    runBtn.textContent = 'Running…';
    const res = await api('/run', { sql: editor.value, connectionId: state.activeConnectionId });
    box.remove();
    if (res.ok) {
      cardCtl.body.textContent = '';
      renderResult(cardCtl, res, question);
      const last = state.history[state.history.length - 1];
      if (last && last.question === question) last.sql = res.sql;
    } else {
      cardCtl.body.append(el('div', { class: 'error-box' }, res.error || 'Query failed'));
      scrollChat();
    }
  });
}

async function explainResult(cardCtl, btn, payload) {
  btn.disabled = true;
  const box = el('div', { class: 'explain-box' });
  cardCtl.body.append(box);
  scrollChat();
  try {
    let acc = '';
    await sseStream('/explain', payload, (ev) => {
      if (ev.type === 'token') { acc += ev.text; box.textContent = acc; scrollChat(); }
      else if (ev.type === 'message') box.textContent = ev.text;
      else if (ev.type === 'error') box.textContent = `Could not explain: ${ev.message}`;
    });
  } catch (e) {
    box.textContent = `Could not explain: ${e.message}`;
  }
  btn.disabled = false;
}

/* ---------------- statistical analysis ---------------- */

// resultRef is preferred (server holds the data); fall back to inline columns/rows.
function analysisPayload(payload, extra) {
  return payload.resultId
    ? { resultRef: payload.resultId, question: payload.question, ...extra }
    : { columns: payload.columns, rows: payload.rows, question: payload.question, ...extra };
}

async function analyzeResult(cardCtl, btn, payload) {
  btn.disabled = true;
  const panel = el('div', { class: 'stat-card' });
  const head = el('div', { class: 'stat-card-head' }, 'Suggested analyses');
  const chips = el('div', { class: 'analysis-suggestions' });
  const slot = el('div', {});
  panel.append(head, chips, slot);
  cardCtl.body.append(panel);
  scrollChat();

  try {
    const res = await api('/recommend', analysisPayload(payload));
    if (!res.ok || !res.recommendations?.length) {
      head.textContent = res.ok ? 'No analyses fit this result — try a query with numeric columns.' : (res.error || 'Analysis unavailable');
      btn.disabled = false;
      return;
    }
    for (const rec of res.recommendations) {
      const chip = el('button', { class: 'analysis-chip', type: 'button', title: rec.rationale },
        el('span', {}, rec.title),
        el('span', { class: 'why', title: rec.rationale }, 'ⓘ'));
      chip.addEventListener('click', () => runAnalysisChip(slot, payload, rec));
      chips.append(chip);
    }
    // auto-run the top recommendation
    runAnalysisChip(slot, payload, res.recommendations[0]);
  } catch (e) {
    head.textContent = `Analysis failed: ${e.message}`;
  }
  btn.disabled = false;
}

async function runAnalysisChip(slot, payload, rec) {
  slot.textContent = '';
  const loading = el('div', { class: 'status-line' }, el('span', { class: 'spinner' }), el('span', {}, `Computing: ${rec.title}…`));
  slot.append(loading);
  try {
    const res = await api('/analyze', analysisPayload(payload, { kind: rec.kind, columns: rec.columns }));
    slot.textContent = '';
    if (!res.ok) { slot.append(el('div', { class: 'error-box' }, res.error || 'Analysis failed')); return; }
    renderStatCard(slot, res, payload, rec);
  } catch (e) {
    slot.textContent = '';
    slot.append(el('div', { class: 'error-box' }, e.message));
  }
}

function renderStatCard(slot, res, payload, rec) {
  const card = res.card;
  const wrap = el('div', {});
  // headline tiles
  const tiles = el('div', { class: 'stat-tiles' });
  for (const h of card.headline) {
    tiles.append(el('div', { class: 'stat-tile' },
      el('div', { class: 'st-label' }, h.label),
      el('div', { class: 'st-value' }, h.value)));
  }
  wrap.append(el('div', { class: 'stat-card-head' }, card.title), tiles);

  if (card.detail && card.detail.length) {
    const detail = el('div', { class: 'stat-detail' });
    for (const d of card.detail) detail.append(el('span', {}, el('span', { class: 'sd-label' }, d.label + ': '), d.value));
    wrap.append(detail);
  }

  // chart for the analysis, if applicable
  const chart = renderAnalysisChart(card.chart, res, payload, rec);
  if (chart) wrap.append(chart);

  // caveats
  if (res.caveats && res.caveats.length) {
    const box = el('div', { class: 'caveats' });
    for (const c of res.caveats) {
      const icon = c.level === 'strong' ? '⚠' : c.level === 'warn' ? '!' : 'ⓘ';
      box.append(el('div', { class: `caveat ${c.level}` }, el('span', { class: 'caveat-icon' }, icon), el('span', {}, c.message)));
    }
    wrap.append(box);
  }

  // plain-English interpretation, streamed from the model
  const interp = el('div', { class: 'explain-box' });
  interp.textContent = 'Interpreting…';
  wrap.append(interp);
  streamInterpretation(interp, res, payload.question);

  slot.append(wrap);
  scrollChat();
}

async function streamInterpretation(box, res, question) {
  try {
    let acc = '';
    let first = true;
    await sseStream('/interpret', { kind: res.kind, result: res.result, caveats: (res.caveats || []).map((c) => c.message), question }, (ev) => {
      if (ev.type === 'token') { if (first) { box.textContent = ''; first = false; } acc += ev.text; box.textContent = acc; scrollChat(); }
      else if (ev.type === 'error') box.textContent = `(interpretation unavailable: ${ev.message})`;
    });
    if (!acc) box.remove();
  } catch {
    box.remove();
  }
}

/* ---------------- analysis charts ---------------- */

function renderAnalysisChart(type, res, payload, rec) {
  const cols = rec.columns || {};
  try {
    if (type === 'scatter' && cols.x && cols.y) return scatterChart(payload, cols.x, cols.y, res.result);
    if (type === 'histogram' && (cols.values || cols.x)) return histogramChart(payload, cols.values || cols.x);
    if (type === 'groupCompare' && cols.value && cols.group) return groupCompareChart(payload, cols.value, cols.group);
    if (type === 'heatmap' && res.result.matrix) return heatmapChart(res.result);
  } catch { /* charts are best-effort */ }
  return null;
}

function colFromPayload(payload, name) {
  const idx = payload.columns.indexOf(name);
  return payload.rows.map((r) => r[idx]);
}

function scatterChart(payload, xName, yName, result) {
  const xs = colFromPayload(payload, xName).map(Number);
  const ys = colFromPayload(payload, yName).map(Number);
  const pts = xs.map((x, i) => [x, ys[i]]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < 2) return null;
  const W = 760, H = 320, padL = 56, padR = 16, padT = 14, padB = 40;
  const xsV = pts.map((p) => p[0]);
  const ysV = pts.map((p) => p[1]);
  const xMin = Math.min(...xsV), xMax = Math.max(...xsV);
  const yMin = Math.min(...ysV), yMax = Math.max(...ysV);
  const sx = (v) => padL + ((v - xMin) / (xMax - xMin || 1)) * (W - padL - padR);
  const sy = (v) => H - padB - ((v - yMin) / (yMax - yMin || 1)) * (H - padT - padB);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  for (const t of niceTicks(yMax - yMin || 1, 4).map((v) => v + yMin)) {
    svg.append(svgEl('line', { x1: padL, y1: sy(t), x2: W - padR, y2: sy(t), stroke: 'var(--grid)', 'stroke-width': 1 }));
    svg.append(svgEl('text', { x: padL - 8, y: sy(t) + 4, 'text-anchor': 'end', fill: 'var(--ink-3)', 'font-size': 11 }, fmtAxis(t)));
  }
  // regression line if present
  if (result && Number.isFinite(result.slope)) {
    const x1 = xMin, x2 = xMax;
    svg.append(svgEl('line', { x1: sx(x1), y1: sy(result.intercept + result.slope * x1), x2: sx(x2), y2: sy(result.intercept + result.slope * x2), stroke: 'var(--series-3)', 'stroke-width': 2 }));
  }
  for (const p of pts) {
    const dot = svgEl('circle', { cx: sx(p[0]), cy: sy(p[1]), r: 3.5, fill: 'var(--series-1)', 'fill-opacity': 0.7 });
    dot.addEventListener('mousemove', (e) => showTooltip(e, `${xName}, ${yName}`, `${fmtNum(p[0])}, ${fmtNum(p[1])}`));
    dot.addEventListener('mouseleave', hideTooltip);
    svg.append(dot);
  }
  svg.append(svgEl('text', { x: (W) / 2, y: H - 6, 'text-anchor': 'middle', fill: 'var(--ink-3)', 'font-size': 11 }, xName));
  return el('div', { class: 'chart-wrap' }, svg);
}

function histogramChart(payload, valName) {
  const vals = colFromPayload(payload, valName).map(Number).filter(Number.isFinite);
  if (vals.length < 2) return null;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const k = Math.max(1, Math.ceil(Math.log2(vals.length) + 1));
  const width = (hi - lo) / k || 1;
  const bins = new Array(k).fill(0);
  for (const v of vals) { let i = Math.floor((v - lo) / width); if (i >= k) i = k - 1; bins[i]++; }
  const W = 760, H = 260, padL = 40, padR = 16, padT = 14, padB = 34;
  const maxC = Math.max(...bins);
  const bw = (W - padL - padR) / k;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  bins.forEach((c, i) => {
    const h = (c / maxC) * (H - padT - padB);
    const x = padL + i * bw;
    const bar = svgEl('rect', { x: x + 1, y: H - padB - h, width: Math.max(1, bw - 2), height: h, rx: 3, fill: 'var(--series-1)' });
    bar.addEventListener('mousemove', (e) => showTooltip(e, `${fmtNum(lo + i * width)}–${fmtNum(lo + (i + 1) * width)}`, `${c}`));
    bar.addEventListener('mouseleave', hideTooltip);
    svg.append(bar);
  });
  svg.append(svgEl('line', { x1: padL, y1: H - padB, x2: W - padR, y2: H - padB, stroke: 'var(--baseline)', 'stroke-width': 1 }));
  return el('div', { class: 'chart-wrap' }, svg);
}

function groupCompareChart(payload, valName, groupName) {
  const vIdx = payload.columns.indexOf(valName);
  const gIdx = payload.columns.indexOf(groupName);
  const map = new Map();
  for (const r of payload.rows) {
    const g = r[gIdx]; const v = Number(r[vIdx]);
    if (g == null || !Number.isFinite(v)) continue;
    const k = String(g);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  }
  const groups = [...map.entries()].map(([name, vs]) => ({ name, mean: vs.reduce((s, x) => s + x, 0) / vs.length, n: vs.length }))
    .sort((a, b) => b.mean - a.mean).slice(0, 20);
  if (groups.length < 2) return null;
  const W = 760, rowH = 26, gap = 6, labelW = 140, padT = 10;
  const H = groups.length * (rowH + gap) + padT + 20;
  const plotW = W - labelW - 70;
  const maxV = Math.max(...groups.map((g) => g.mean));
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  groups.forEach((g, i) => {
    const y = padT + i * (rowH + gap);
    const bw = Math.max(2, (g.mean / (maxV || 1)) * plotW);
    svg.append(svgEl('text', { x: labelW - 8, y: y + rowH / 2 + 4, 'text-anchor': 'end', fill: 'var(--ink-2)', 'font-size': 12 }, g.name.length > 18 ? g.name.slice(0, 17) + '…' : g.name));
    const bar = svgEl('rect', { x: labelW, y: y + 3, width: bw, height: rowH - 6, rx: 4, fill: 'var(--series-1)' });
    bar.addEventListener('mousemove', (e) => showTooltip(e, `${g.name} (n=${g.n})`, `mean ${fmtNum(g.mean)}`));
    bar.addEventListener('mouseleave', hideTooltip);
    svg.append(bar);
    svg.append(svgEl('text', { x: labelW + bw + 6, y: y + rowH / 2 + 4, fill: 'var(--ink-2)', 'font-size': 11.5 }, fmtAxis(g.mean)));
  });
  return el('div', { class: 'chart-wrap' }, svg);
}

function heatmapChart(result) {
  const { names, matrix } = result;
  if (!names || !matrix) return null;
  const k = names.length;
  const cell = Math.min(48, Math.floor(560 / k));
  const labelW = 90;
  const W = labelW + k * cell + 10, H = labelW + k * cell + 10;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  for (let i = 0; i < k; i++) {
    svg.append(svgEl('text', { x: labelW - 6, y: labelW + i * cell + cell / 2 + 4, 'text-anchor': 'end', fill: 'var(--ink-2)', 'font-size': 11 }, short(names[i])));
    const t = svgEl('text', { x: labelW + i * cell + cell / 2, y: labelW - 6, 'text-anchor': 'start', fill: 'var(--ink-2)', 'font-size': 11, transform: `rotate(-45 ${labelW + i * cell + cell / 2} ${labelW - 6})` }, short(names[i]));
    svg.append(t);
    for (let j = 0; j < k; j++) {
      const r = matrix[i][j];
      const rect = svgEl('rect', { x: labelW + j * cell, y: labelW + i * cell, width: cell - 2, height: cell - 2, rx: 3, fill: corrColor(r) });
      rect.addEventListener('mousemove', (e) => showTooltip(e, `${names[i]} × ${names[j]}`, Number.isFinite(r) ? `r=${fmtNum(r)}` : 'n/a'));
      rect.addEventListener('mouseleave', hideTooltip);
      svg.append(rect);
    }
  }
  return el('div', { class: 'chart-wrap' }, svg);
}
function short(s) { return s.length > 12 ? s.slice(0, 11) + '…' : s; }
function corrColor(r) {
  if (!Number.isFinite(r)) return 'var(--surface-3)';
  // blue (neg) ↔ neutral ↔ yellow (pos)
  const a = Math.min(1, Math.abs(r));
  return r >= 0
    ? `color-mix(in srgb, var(--series-3) ${Math.round(a * 100)}%, var(--surface))`
    : `color-mix(in srgb, var(--series-1) ${Math.round(a * 100)}%, var(--surface))`;
}

/* ---------------- the ask flow ---------------- */

async function ask(question) {
  addUserMessage(question);
  const cardCtl = newAssistantCard();
  cardCtl.setStatus('Contacting the model…');
  state.busy = true;
  renderConnStatus();

  let gotResult = false;
  try {
    await sseStream('/ask', { question, history: state.history.slice(-6), connectionId: state.activeConnectionId }, (ev) => {
      switch (ev.type) {
        case 'status':
          cardCtl.setStatus(ev.message);
          break;
        case 'token':
          cardCtl.appendThinking(ev.text);
          break;
        case 'schema_ready':
          api(`/schema?connectionId=${state.activeConnectionId || ''}`).then((r) => { if (r.ok) { state.schema = r.schema; renderSchemaTree(); renderConnections(); } });
          break;
        case 'retry':
          cardCtl.body.append(el('div', { class: 'notice' }, `Attempt ${ev.attempt} didn't work (${ev.reason}) — trying again…`));
          scrollChat();
          break;
        case 'sql':
          cardCtl.collapseThinking();
          break;
        case 'awaiting_approval': {
          cardCtl.clearStatus();
          cardCtl.collapseThinking();
          const block = sqlBlock(ev.sql);
          const runBtn = el('button', { class: 'btn btn-sm btn-primary', type: 'button' }, 'Run this query');
          const editBtn = el('button', { class: 'btn btn-sm', type: 'button' }, 'Edit first');
          const row = el('div', { class: 'approval-row' },
            el('span', { class: 'badge' }, 'approval mode'), runBtn, editBtn);
          cardCtl.body.append(block, row);
          runBtn.addEventListener('click', async () => {
            runBtn.disabled = true; runBtn.textContent = 'Running…';
            const res = await api('/run', { sql: ev.sql, connectionId: state.activeConnectionId });
            block.remove(); row.remove();
            if (res.ok) {
              renderResult(cardCtl, res, question);
              state.history.push({ question, sql: res.sql });
            } else {
              cardCtl.body.append(el('div', { class: 'error-box' }, res.error || 'Query failed'));
            }
            scrollChat();
          });
          editBtn.addEventListener('click', () => { row.remove(); block.remove(); openSqlEditor(cardCtl, ev.sql, question); });
          scrollChat();
          break;
        }
        case 'result':
          gotResult = true;
          cardCtl.clearStatus();
          cardCtl.collapseThinking();
          renderResult(cardCtl, ev, question);
          state.history.push({ question, sql: ev.sql });
          break;
        case 'message':
          cardCtl.clearStatus();
          cardCtl.collapseThinking();
          cardCtl.body.append(el('div', { class: 'prose' }, ev.text));
          scrollChat();
          break;
        case 'error':
          cardCtl.clearStatus();
          if (ev.sql) cardCtl.body.append(sqlBlock(ev.sql));
          cardCtl.body.append(el('div', { class: 'error-box' }, ev.message));
          scrollChat();
          break;
      }
    });
  } catch (e) {
    cardCtl.body.append(el('div', { class: 'error-box' }, `Connection to askmydb failed: ${e.message}`));
  }
  cardCtl.clearStatus();
  state.busy = false;
  renderConnStatus();
  if (gotResult) $('#questionInput').focus();
}

function askCurrent() {
  const input = $('#questionInput');
  const q = input.value.trim();
  if (!q || state.busy) return;
  input.value = '';
  autosize(input);
  ask(q);
}

$('#composer').addEventListener('submit', (e) => { e.preventDefault(); askCurrent(); });
$('#questionInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askCurrent(); }
});
function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
}
$('#questionInput').addEventListener('input', (e) => autosize(e.target));

/* ---------------- setup modal ---------------- */

const setupModal = $('#setupModal');
const settingsModal = $('#settingsModal');

const DB_DEFAULT_PORTS = { mysql: 3306, postgres: 5432 };

// Open the setup modal to add a new connection (connId=null) or edit one.
function openConnectionEditor(connId) {
  state.editingConnId = connId || null;
  const db = connId ? (state.connections.find((c) => c.id === connId) || {}) : {};
  const llm = state.config?.llm || {};
  // default new connections to files (the easiest on-ramp); load existing files
  state.pendingFiles = (db.type === 'files' && Array.isArray(db.files))
    ? db.files.map((p) => ({ path: p, name: p.split(/[\\/]/).pop(), status: 'saved' }))
    : [];
  renderFileList();
  $('#dbType').value = db.type || 'files';
  $('#dbHost').value = db.host || 'localhost';
  $('#dbPort').value = db.port || DB_DEFAULT_PORTS[db.type || 'mysql'] || '';
  $('#dbUser').value = db.user || '';
  $('#dbPassword').value = '';
  $('#dbPassword').placeholder = db.hasPassword ? '(saved — leave blank to keep)' : '';
  $('#dbName').value = db.database || '';
  $('#dbFile').value = db.file || '';
  $('#dbSsl').checked = Boolean(db.ssl);
  $('#dbSslInsecure').checked = Boolean(db.sslInsecure);
  $('#llmUrl').value = llm.baseUrl || 'http://localhost:1234/v1';
  $('#saveSetupBtn').textContent = connId ? 'Save' : 'Save & connect';
  $('#removeConnBtn').hidden = !connId;
  $('#testDbResult').textContent = '';
  toggleDbFields();
  populateModelSelect($('#llmModel'), [], llm.model);
  populateModelSelect($('#llmEmbedModel'), [], llm.embeddingModel, { allowNone: true });
  setupModal.showModal();
  refreshModelsInto($('#llmModel'), $('#llmEmbedModel'), $('#llmUrl').value.trim());
}
function fillSetupForm() { openConnectionEditor(null); }

function toggleDbFields() {
  const type = $('#dbType').value;
  const isSqlite = type === 'sqlite';
  const isFiles = type === 'files';
  const isNet = !isSqlite && !isFiles;
  for (const n of document.querySelectorAll('.db-net')) n.hidden = !isNet;
  for (const n of document.querySelectorAll('.db-file')) n.hidden = !isSqlite;
  for (const n of document.querySelectorAll('.db-files')) n.hidden = !isFiles;
  // The "allow self-signed" row only matters once SSL is on.
  for (const n of document.querySelectorAll('.db-ssl')) n.hidden = !isNet || !$('#dbSsl').checked;
  if (isNet) $('#dbPort').placeholder = DB_DEFAULT_PORTS[type] || '';
}
$('#dbType').addEventListener('change', () => {
  $('#dbPort').value = DB_DEFAULT_PORTS[$('#dbType').value] || '';
  toggleDbFields();
});
$('#dbSsl').addEventListener('change', toggleDbFields);

function collectDbForm() {
  const type = $('#dbType').value;
  if (type === 'files') {
    const files = state.pendingFiles.map((f) => f.path).filter(Boolean);
    const first = state.pendingFiles[0];
    return { type: 'files', files, label: files.length > 1 ? `${files.length} files` : (first ? first.name : 'spreadsheets') };
  }
  return {
    type,
    host: $('#dbHost').value.trim() || 'localhost',
    port: Number($('#dbPort').value) || DB_DEFAULT_PORTS[type] || 0,
    user: $('#dbUser').value.trim(),
    password: $('#dbPassword').value,
    database: $('#dbName').value.trim(),
    file: $('#dbFile').value.trim(),
    ssl: $('#dbSsl').checked,
    sslInsecure: $('#dbSslInsecure').checked
  };
}

/* ---------------- file import (spreadsheets / CSV) ---------------- */

function renderFileList() {
  const box = $('#fileList');
  box.textContent = '';
  state.pendingFiles.forEach((f, i) => {
    const item = el('div', { class: 'file-item' },
      el('span', { class: 'fi-name', title: f.path }, f.name),
      el('span', { class: 'fi-status' }, f.status || ''),
      el('button', { class: 'fi-remove', type: 'button', title: 'Remove', onclick: () => { state.pendingFiles.splice(i, 1); renderFileList(); } }, '×'));
    box.append(item);
  });
}

async function uploadFile(file) {
  const entry = { path: null, name: file.name, status: 'uploading…' };
  state.pendingFiles.push(entry);
  renderFileList();
  try {
    const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: await file.arrayBuffer()
    });
    const data = await res.json();
    if (data.ok) { entry.path = data.path; entry.status = 'ready'; }
    else { entry.status = data.error || 'failed'; }
  } catch (e) {
    entry.status = 'upload failed';
  }
  renderFileList();
}

function wireFileImport() {
  const drop = $('#fileDrop');
  const input = $('#fileInput');
  $('#browseFilesBtn').addEventListener('click', () => input.click());
  drop.addEventListener('click', (e) => { if (e.target.id === 'browseFilesBtn') return; input.click(); });
  input.addEventListener('change', () => { for (const f of input.files) uploadFile(f); input.value = ''; });
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', (e) => { for (const f of e.dataTransfer.files) uploadFile(f); });
  $('#addFilePathBtn').addEventListener('click', () => {
    const p = $('#filePathInput').value.trim();
    if (!p) return;
    state.pendingFiles.push({ path: p, name: p.split(/[\\/]/).pop(), status: 'on disk' });
    $('#filePathInput').value = '';
    renderFileList();
  });
}
wireFileImport();

function populateModelSelect(select, models, current, { allowNone = false, noneLabel = '— none —' } = {}) {
  select.textContent = '';
  if (allowNone) select.append(el('option', { value: '' }, noneLabel));
  const all = [...new Set([...(models || []), ...(current ? [current] : [])])];
  if (!all.length && !allowNone) select.append(el('option', { value: '' }, '— click ↻ to list models —'));
  for (const m of all) select.append(el('option', { value: m }, m));
  select.value = current || '';
}

// Fetch models and populate a chat select and (optionally) an embedding select.
async function refreshModelsInto(chatSelect, embedSelect, urlOverride) {
  const res = await api('/test-llm', { llm: urlOverride ? { baseUrl: urlOverride } : {} });
  const resultEl = $('#testLlmResult');
  if (res.ok) {
    const models = res.models && res.models.chat ? res.models : { chat: res.models || [], embedding: [] };
    state.lastModels = models;
    if (chatSelect) populateModelSelect(chatSelect, models.chat, chatSelect.value || state.config?.llm?.model);
    if (embedSelect) populateModelSelect(embedSelect, models.embedding, embedSelect.value || state.config?.llm?.embeddingModel, { allowNone: true });
    if (resultEl) {
      resultEl.textContent = `✓ ${models.chat.length} chat model${models.chat.length === 1 ? '' : 's'}` + (models.embedding.length ? `, ${models.embedding.length} embedding` : '');
      resultEl.className = 'test-result ok';
    }
  } else if (resultEl) {
    resultEl.textContent = res.error;
    resultEl.className = 'test-result err';
  }
  return res.ok;
}

$('#addConnBtn').addEventListener('click', () => openConnectionEditor(null));
$('#connectBtn').addEventListener('click', () => openConnectionEditor(null));
$('#cancelSetupBtn').addEventListener('click', () => setupModal.close());
$('#refreshModelsBtn').addEventListener('click', () => refreshModelsInto($('#llmModel'), $('#llmEmbedModel'), $('#llmUrl').value.trim()));
$('#removeConnBtn').addEventListener('click', async () => {
  if (!state.editingConnId) return;
  await sendJson('DELETE', `/connections/${state.editingConnId}`);
  const list = await api('/connections');
  state.connections = list.connections;
  if (state.activeConnectionId === state.editingConnId) {
    state.activeConnectionId = state.connections[0]?.id || null;
    state.schema = null;
  }
  state.editingConnId = null;
  setupModal.close();
  renderConnections();
  if (state.activeConnectionId) switchConnection(state.activeConnectionId);
  else { renderSchemaTree(); }
});

$('#testDbBtn').addEventListener('click', async () => {
  const out = $('#testDbResult');
  out.textContent = 'Connecting…';
  out.className = 'test-result';
  const res = await api('/test-db', { db: collectDbForm(), id: state.editingConnId });
  out.textContent = res.ok ? `✓ ${res.info}` : res.error;
  out.className = `test-result ${res.ok ? 'ok' : 'err'}`;
});

$('#saveSetupBtn').addEventListener('click', async () => {
  const btn = $('#saveSetupBtn');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Saving…';
  try {
    const db = collectDbForm();

    // Test the connection details BEFORE creating anything (no orphans).
    const test = await api('/test-db', { db, id: state.editingConnId });
    if (!test.ok) { $('#testDbResult').textContent = test.error; $('#testDbResult').className = 'test-result err'; return; }

    // Save the shared LLM settings (base URL + models) alongside the connection.
    const cfg = await api('/config', {
      llm: { baseUrl: $('#llmUrl').value.trim(), model: $('#llmModel').value, embeddingModel: $('#llmEmbedModel').value }
    });
    state.config = cfg.config;

    const saved = state.editingConnId
      ? await sendJson('PUT', `/connections/${state.editingConnId}`, { db })
      : await api('/connections', { db });
    if (!saved.ok) { $('#testDbResult').textContent = saved.error || 'Save failed'; $('#testDbResult').className = 'test-result err'; return; }

    const list = await api('/connections');
    state.connections = list.connections;
    const connId = state.editingConnId || saved.connection.id;
    setupModal.close();
    state.editingConnId = null;
    renderConnections();
    await switchConnection(connId);
    $('#questionInput').focus();
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

/* ---------------- settings modal ---------------- */

function fillSettingsForm() {
  const { llm, guardrails } = state.config;
  populateModelSelect($('#settingsModel'), [], llm.model);
  populateModelSelect($('#settingsEmbedModel'), [], llm.embeddingModel, { allowNone: true });
  $('#settingsTemperature').value = llm.temperature;
  $('#settingsSchemaMaxChars').value = llm.schemaMaxChars;
  $('#settingsSelfConsistency').value = llm.selfConsistency || 1;
  $('#settingsRetrievalMaxTables').value = llm.retrievalMaxTables || 8;
  $('#settingsMaxRows').value = guardrails.maxRows;
  $('#settingsTimeout').value = Math.round(guardrails.timeoutMs / 1000);
  $('#settingsApproval').checked = Boolean(guardrails.approvalMode);
  $('#settingsSamples').checked = guardrails.sampleValues !== false;
}

$('#settingsBtn').addEventListener('click', () => {
  fillSettingsForm();
  settingsModal.showModal();
  refreshModelsInto($('#settingsModel'), $('#settingsEmbedModel'));
});
$('#cancelSettingsBtn').addEventListener('click', () => settingsModal.close());
$('#settingsRefreshModelsBtn').addEventListener('click', () => refreshModelsInto($('#settingsModel'), $('#settingsEmbedModel')));

$('#saveSettingsBtn').addEventListener('click', async () => {
  const saved = await api('/config', {
    llm: {
      model: $('#settingsModel').value,
      embeddingModel: $('#settingsEmbedModel').value,
      temperature: Number($('#settingsTemperature').value) || 0.1,
      schemaMaxChars: Number($('#settingsSchemaMaxChars').value) || 24000,
      selfConsistency: Math.max(1, Math.min(5, Number($('#settingsSelfConsistency').value) || 1)),
      retrievalMaxTables: Math.max(3, Math.min(30, Number($('#settingsRetrievalMaxTables').value) || 8))
    },
    guardrails: {
      maxRows: Math.max(1, Number($('#settingsMaxRows').value) || 500),
      timeoutMs: Math.max(1000, (Number($('#settingsTimeout').value) || 15) * 1000),
      approvalMode: $('#settingsApproval').checked,
      sampleValues: $('#settingsSamples').checked
    }
  });
  state.config = saved.config;
  settingsModal.close();
});

/* ---------------- cross-database correlation ---------------- */

const correlateModal = $('#correlateModal');

async function openCorrelate() {
  const res = await api('/results');
  const results = res.results || [];
  if (results.length < 1) {
    alert('Run at least one query first — correlation joins two result sets you have already produced.');
    return;
  }
  const optionsFor = (sel) => {
    sel.textContent = '';
    for (const r of results) sel.append(el('option', { value: r.id }, `${r.label || r.question || r.id} (${r.rowCount} rows)`));
  };
  optionsFor($('#corrLeft'));
  optionsFor($('#corrRight'));
  if (results.length > 1) $('#corrRight').selectedIndex = 1;
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  const fillCols = (resultId, keySel, valSel) => {
    const r = byId[resultId];
    for (const s of [keySel, valSel]) { s.textContent = ''; (r?.columns || []).forEach((c) => s.append(el('option', { value: c }, c))); }
    if (r && r.columns.length > 1) valSel.selectedIndex = 1;
  };
  const sync = () => {
    fillCols($('#corrLeft').value, $('#corrLeftKey'), $('#corrLeftValue'));
    fillCols($('#corrRight').value, $('#corrRightKey'), $('#corrRightValue'));
  };
  $('#corrLeft').onchange = sync;
  $('#corrRight').onchange = sync;
  sync();
  $('#corrResult').textContent = '';
  correlateModal.showModal();
}

$('#correlateBtn').addEventListener('click', openCorrelate);
$('#cancelCorrelateBtn').addEventListener('click', () => correlateModal.close());
$('#runCorrelateBtn').addEventListener('click', async () => {
  const out = $('#corrResult');
  out.textContent = 'Joining and correlating…';
  out.className = 'test-result';
  const res = await api('/correlate', {
    leftRef: $('#corrLeft').value, leftKey: $('#corrLeftKey').value, leftValue: $('#corrLeftValue').value,
    rightRef: $('#corrRight').value, rightKey: $('#corrRightKey').value, rightValue: $('#corrRightValue').value
  });
  if (!res.ok) { out.textContent = res.error; out.className = 'test-result err'; return; }
  correlateModal.close();
  // render the cross-DB result as an assistant card
  $('#welcome')?.remove();
  const leftLabel = $('#corrLeftValue').value;
  const rightLabel = $('#corrRightValue').value;
  addUserMessage(`Correlate ${leftLabel} with ${rightLabel} across databases`);
  const cardCtl = newAssistantCard();
  cardCtl.clearStatus();
  cardCtl.body.append(el('div', { class: 'prose' }, `Joined ${res.matched} matching rows across the two databases.`));
  const slot = el('div', {});
  cardCtl.body.append(slot);
  const payload = { question: `relationship between ${leftLabel} and ${rightLabel}`, columns: res.joinResult.columns, rows: res.joinResult.rows, resultId: res.joinResultId };
  renderStatCard(slot, { ok: true, kind: res.kind, result: res.result, card: res.card, caveats: res.caveats }, payload, { kind: res.kind, columns: { x: 'left_value', y: 'right_value' } });
});

/* ---------------- boot ---------------- */

async function init() {
  applyTheme(localStorage.getItem('askmydb-theme') || 'dark');
  const res = await api('/config');
  state.config = res.config;
  state.connections = res.connections || [];
  state.activeConnectionId = res.activeConnectionId || state.connections[0]?.id || null;
  renderConnections();

  if (!res.dbReady || !state.connections.length) {
    fillSetupForm();
    return;
  }

  const id = state.activeConnectionId;
  const schemaRes = await api(`/schema?connectionId=${id}`);
  if (schemaRes.ok) {
    state.schema = schemaRes.schema;
  } else {
    const refreshed = await api('/schema/refresh', { connectionId: id });
    if (refreshed.ok) state.schema = refreshed.schema;
  }
  renderSchemaTree();
  renderConnections();
  loadSuggestions();
}

init();
