'use strict';

/* askmydb frontend. No dependencies, no build step.
   All data is rendered with textContent/createElement — never innerHTML with
   database content — so query results can't inject markup. */

const $ = (sel) => document.querySelector(sel);

const state = {
  config: null,
  schema: null,
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

/* ---------------- connection status ---------------- */

function renderConnStatus() {
  const db = state.config?.db || {};
  const ready = Boolean(db.type && (db.type === 'sqlite' ? db.file : db.database));
  const dot = $('#connDot');
  if (!ready) {
    dot.className = 'dot';
    $('#connTitle').textContent = 'Not connected';
    $('#connSub').textContent = 'Set up a database to begin';
    $('#connectBtn').textContent = 'Connect a database';
  } else {
    dot.className = state.schema ? 'dot on' : 'dot';
    const label = db.type === 'sqlite' ? (db.file || '').split(/[\\/]/).pop() : db.database;
    $('#connTitle').textContent = label;
    $('#connSub').textContent = state.schema
      ? `${state.schema.tables.length} tables · ${db.type}`
      : `${db.type} — connecting…`;
    $('#connectBtn').textContent = 'Edit connection';
  }
  const canAsk = ready && Boolean(state.config?.llm?.model);
  $('#questionInput').disabled = !canAsk;
  $('#sendBtn').disabled = !canAsk || state.busy;
}

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
  $('#connSub').textContent = 'Discovering schema…';
  const res = await api('/schema/refresh', {});
  if (res.ok) {
    state.schema = res.schema;
    renderSchemaTree();
    loadSuggestions();
  } else {
    $('#connSub').textContent = res.error || 'Schema discovery failed';
  }
  renderConnStatus();
});

/* ---------------- suggestions ---------------- */

function renderSuggestions(list) {
  const box = $('#suggestions');
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
    const res = await api('/suggest', {});
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
    const res = await api('/run', { sql: editor.value });
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

/* ---------------- the ask flow ---------------- */

async function ask(question) {
  addUserMessage(question);
  const cardCtl = newAssistantCard();
  cardCtl.setStatus('Contacting the model…');
  state.busy = true;
  renderConnStatus();

  let gotResult = false;
  try {
    await sseStream('/ask', { question, history: state.history.slice(-6) }, (ev) => {
      switch (ev.type) {
        case 'status':
          cardCtl.setStatus(ev.message);
          break;
        case 'token':
          cardCtl.appendThinking(ev.text);
          break;
        case 'schema_ready':
          api('/schema').then((r) => { if (r.ok) { state.schema = r.schema; renderSchemaTree(); renderConnStatus(); } });
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
            const res = await api('/run', { sql: ev.sql });
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

function fillSetupForm() {
  const db = state.config?.db || {};
  const llm = state.config?.llm || {};
  $('#dbType').value = db.type || 'mysql';
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
  toggleDbFields();
  populateModelSelect($('#llmModel'), [], llm.model);
}

function toggleDbFields() {
  const isSqlite = $('#dbType').value === 'sqlite';
  for (const n of document.querySelectorAll('.db-net')) n.hidden = isSqlite;
  for (const n of document.querySelectorAll('.db-file')) n.hidden = !isSqlite;
  // The "allow self-signed" row only matters once SSL is on.
  for (const n of document.querySelectorAll('.db-ssl')) n.hidden = isSqlite || !$('#dbSsl').checked;
  if (!isSqlite) {
    const placeholder = DB_DEFAULT_PORTS[$('#dbType').value];
    $('#dbPort').placeholder = placeholder || '';
  }
}
$('#dbType').addEventListener('change', () => {
  $('#dbPort').value = DB_DEFAULT_PORTS[$('#dbType').value] || '';
  toggleDbFields();
});
$('#dbSsl').addEventListener('change', toggleDbFields);

function collectDbForm() {
  const type = $('#dbType').value;
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

function populateModelSelect(select, models, current) {
  select.textContent = '';
  const all = [...new Set([...(models || []), ...(current ? [current] : [])])];
  if (!all.length) select.append(el('option', { value: '' }, '— click ↻ to list models —'));
  for (const m of all) select.append(el('option', { value: m }, m));
  if (current) select.value = current;
}

async function refreshModelsInto(select, urlOverride) {
  const res = await api('/test-llm', { llm: urlOverride ? { baseUrl: urlOverride } : {} });
  const resultEl = $('#testLlmResult');
  if (res.ok) {
    populateModelSelect(select, res.models, select.value || state.config?.llm?.model);
    if (resultEl) { resultEl.textContent = `✓ found ${res.models.length} model${res.models.length === 1 ? '' : 's'}`; resultEl.className = 'test-result ok'; }
  } else if (resultEl) {
    resultEl.textContent = res.error;
    resultEl.className = 'test-result err';
  }
  return res.ok;
}

$('#connectBtn').addEventListener('click', () => { fillSetupForm(); setupModal.showModal(); refreshModelsInto($('#llmModel'), $('#llmUrl').value.trim()); });
$('#cancelSetupBtn').addEventListener('click', () => setupModal.close());
$('#refreshModelsBtn').addEventListener('click', () => refreshModelsInto($('#llmModel'), $('#llmUrl').value.trim()));

$('#testDbBtn').addEventListener('click', async () => {
  const out = $('#testDbResult');
  out.textContent = 'Connecting…';
  out.className = 'test-result';
  const res = await api('/test-db', { db: collectDbForm() });
  out.textContent = res.ok ? `✓ ${res.info}` : res.error;
  out.className = `test-result ${res.ok ? 'ok' : 'err'}`;
});

$('#saveSetupBtn').addEventListener('click', async () => {
  const btn = $('#saveSetupBtn');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    const saved = await api('/config', {
      db: collectDbForm(),
      llm: { baseUrl: $('#llmUrl').value.trim(), model: $('#llmModel').value }
    });
    state.config = saved.config;
    renderConnStatus();

    const test = await api('/test-db', {});
    if (!test.ok) {
      $('#testDbResult').textContent = test.error;
      $('#testDbResult').className = 'test-result err';
      return;
    }
    setupModal.close();
    $('#connSub').textContent = 'Discovering schema…';
    const res = await api('/schema/refresh', {});
    if (res.ok) {
      state.schema = res.schema;
      renderSchemaTree();
      renderConnStatus();
      loadSuggestions();
      $('#questionInput').focus();
    } else {
      $('#connSub').textContent = res.error || 'Schema discovery failed';
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & connect';
  }
});

/* ---------------- settings modal ---------------- */

function fillSettingsForm() {
  const { llm, guardrails } = state.config;
  populateModelSelect($('#settingsModel'), [], llm.model);
  $('#settingsTemperature').value = llm.temperature;
  $('#settingsSchemaMaxChars').value = llm.schemaMaxChars;
  $('#settingsMaxRows').value = guardrails.maxRows;
  $('#settingsTimeout').value = Math.round(guardrails.timeoutMs / 1000);
  $('#settingsApproval').checked = Boolean(guardrails.approvalMode);
  $('#settingsSamples').checked = guardrails.sampleValues !== false;
}

$('#settingsBtn').addEventListener('click', () => {
  fillSettingsForm();
  settingsModal.showModal();
  refreshModelsInto($('#settingsModel'));
});
$('#cancelSettingsBtn').addEventListener('click', () => settingsModal.close());
$('#settingsRefreshModelsBtn').addEventListener('click', () => refreshModelsInto($('#settingsModel')));

$('#saveSettingsBtn').addEventListener('click', async () => {
  const saved = await api('/config', {
    llm: {
      model: $('#settingsModel').value,
      temperature: Number($('#settingsTemperature').value) || 0.1,
      schemaMaxChars: Number($('#settingsSchemaMaxChars').value) || 24000
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
  renderConnStatus();
});

/* ---------------- boot ---------------- */

async function init() {
  applyTheme(localStorage.getItem('askmydb-theme') || 'dark');
  const res = await api('/config');
  state.config = res.config;

  if (!res.dbReady) {
    renderConnStatus();
    fillSetupForm();
    setupModal.showModal();
    refreshModelsInto($('#llmModel'), $('#llmUrl').value.trim());
    return;
  }

  renderConnStatus();
  const schemaRes = res.schemaLoaded ? await api('/schema') : await api('/schema/refresh', {});
  if (schemaRes.ok) {
    state.schema = schemaRes.schema;
    renderSchemaTree();
    loadSuggestions();
  } else {
    $('#connSub').textContent = schemaRes.error || 'Could not read schema';
    $('#connDot').className = 'dot err';
  }
  renderConnStatus();
}

init();
