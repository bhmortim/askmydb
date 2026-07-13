'use strict';

/* Offline geographic visualization for askmydb results.
   No tile servers — a bundled US-states polygon set + an Albers USA projection,
   rendered as inline SVG. Detects state / lat-long / ZIP geography in a result
   and draws choropleths, graduated bubbles, or a density heatmap.
   Relies on globals from app.js: el, svgEl, fmtNum, fmtAxis, showTooltip, hideTooltip. */

const MAP_W = 960, MAP_H = 520; // a touch taller than 500 so the AK/HI insets aren't clipped
const RAD = Math.PI / 180;

/* ---------------- Albers USA projection ---------------- */

function conicEqualAreaRaw(phi0, phi1) {
  const sy0 = Math.sin(phi0);
  const n = (sy0 + Math.sin(phi1)) / 2;
  const c = 1 + sy0 * (2 * n - sy0);
  const r0 = Math.sqrt(c) / n;
  return (lambda, phi) => {
    const r = Math.sqrt(c - 2 * n * Math.sin(phi)) / n;
    return [r * Math.sin(lambda * n), r0 - r * Math.cos(lambda * n)];
  };
}
function makeAlbers(parallels, rotateLng, centerLng, centerLat, scale, tx, ty) {
  const raw = conicEqualAreaRaw(parallels[0] * RAD, parallels[1] * RAD);
  const dl = rotateLng * RAD;
  const c = raw(centerLng * RAD, centerLat * RAD);
  return (lng, lat) => {
    const [x, y] = raw(lng * RAD + dl, lat * RAD);
    return [tx + scale * (x - c[0]), ty - scale * (y - c[1])];
  };
}
// Composite: lower-48 + Alaska + Hawaii insets (constants from d3.geoAlbersUsa).
const K = 1070, TX = 480, TY = 250;
const lower48 = makeAlbers([29.5, 45.5], 96, -0.6, 38.7, K, TX, TY);
const alaska = makeAlbers([55, 65], 154, -2, 58.5, 0.35 * K, TX - 0.307 * K, TY + 0.201 * K);
const hawaii = makeAlbers([8, 18], 157, -3, 19.9, K, TX - 0.205 * K, TY + 0.212 * K);
const prico = makeAlbers([18, 18], 66, 0, 18.2, 6 * K, TX + 0.31 * K, TY + 0.22 * K);

function projectUSA(lng, lat) {
  if (lat > 50 && lng < -128) return alaska(lng, lat);
  if (lat >= 18 && lat <= 23 && lng < -150) return hawaii(lng, lat);
  if (lat >= 17.5 && lat <= 18.7 && lng > -68 && lng < -64.3) return prico(lng, lat); // PR + USVI
  return lower48(lng, lat);
}

/* ---------------- US states geometry (bundled, cached) ---------------- */

let statesCache = null;
async function loadStates() {
  if (statesCache) return statesCache;
  const res = await fetch('geo/us-states.json');
  statesCache = await res.json();
  return statesCache;
}

/* ---------------- geography detection ---------------- */

const STATE_CODES = new Set(('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR GU VI AS MP').split(' '));
const STATE_NAME_TO_CODE = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC', 'puerto rico': 'PR'
};

function toStateCode(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (STATE_CODES.has(s.toUpperCase())) return s.toUpperCase();
  const c = STATE_NAME_TO_CODE[s.toLowerCase()];
  return c || null;
}

// Accepts numbers AND numeric strings (drivers return DECIMAL/BIGINT/MONEY as
// strings), since the render path already coerces with Number().
function colIsNumeric(rows, i) {
  let seen = false;
  for (const r of rows) {
    const v = r[i];
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'number') { if (!Number.isFinite(v)) return false; seen = true; continue; }
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) { seen = true; continue; }
    return false;
  }
  return seen;
}

// Zero-pad a numeric ZIP so a driver-returned integer 7030 becomes "07030".
function toZip(v) {
  const s = String(v).trim();
  return /^\d{1,5}$/.test(s) ? s.padStart(5, '0') : s;
}

// Fast min/max without spreading (Math.min(...huge) overflows the call stack).
function minMax(arr) {
  let lo = Infinity, hi = -Infinity;
  for (const v of arr) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}

// Is a lat/long inside a US region we can place? Used to drop foreign points.
function inUSA(lng, lat) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  if (lat >= 22 && lat <= 50 && lng >= -126 && lng <= -66) return true;     // CONUS
  if (lat > 50 && lat <= 72 && lng <= -129) return true;                    // Alaska
  if (lat >= 18 && lat <= 23 && lng <= -154 && lng >= -161) return true;    // Hawaii
  if (lat >= 17.5 && lat <= 18.7 && lng >= -68 && lng <= -64.3) return true; // PR + USVI
  return false;
}

/** Detect mappable geography + candidate value columns. Returns null if none. */
function detectGeo(columns, rows) {
  if (!rows.length) return null;
  const lc = columns.map((c) => c.toLowerCase());
  const numericValueCols = columns.map((c, i) => i).filter((i) => colIsNumeric(rows, i));

  // lat/long pair
  const latIdx = lc.findIndex((c) => /^(lat|latitude)$/.test(c) || /_lat$|latitude/.test(c));
  const lngIdx = lc.findIndex((c) => /^(lon|lng|long|longitude)$/.test(c) || /_lon$|_lng$|longitude/.test(c));
  if (latIdx >= 0 && lngIdx >= 0 && latIdx !== lngIdx) {
    return { kind: 'latlong', latIdx, lngIdx, valueCols: numericValueCols.filter((i) => i !== latIdx && i !== lngIdx) };
  }

  // state column: prefer a name-hinted column; otherwise require a strong data
  // signal (so a column of 2-letter codes like chemical symbols isn't mistaken
  // for geography).
  let stateIdx = -1;
  const stateHint = (i) => /state|province|region|\bst\b/.test(lc[i]);
  for (let i = 0; i < columns.length; i++) {
    let ok = 0, tot = 0; const distinct = new Set();
    for (const r of rows) { const v = r[i]; if (v == null || v === '') continue; tot++; const c = toStateCode(v); if (c) { ok++; distinct.add(c); } }
    if (tot < 2) continue;
    const ratio = ok / tot;
    if (stateHint(i) && ratio > 0.6) { stateIdx = i; break; }
    if (!stateHint(i) && ratio > 0.9 && distinct.size >= 8) { stateIdx = i; break; }
  }
  if (stateIdx >= 0) {
    return { kind: 'state', stateIdx, valueCols: numericValueCols.filter((i) => i !== stateIdx) };
  }

  // ZIP column: name-hinted, mostly 5-digit (zero-padded so numeric ZIPs count)
  let zipIdx = -1;
  for (let i = 0; i < columns.length; i++) {
    if (!/zip|postal/.test(lc[i])) continue;
    let ok = 0, tot = 0;
    for (const r of rows) { const v = r[i]; if (v == null || v === '') continue; tot++; if (/^\d{5}$/.test(toZip(v))) ok++; }
    if (tot >= 2 && ok / tot > 0.7) { zipIdx = i; break; }
  }
  if (zipIdx >= 0) {
    return { kind: 'zip', zipIdx, valueCols: numericValueCols.filter((i) => i !== zipIdx) };
  }
  return null;
}

/* ---------------- color ramp ---------------- */

const RAMP = [[205, 226, 251], [110, 167, 236], [42, 120, 214], [24, 79, 149], [13, 54, 107]];
function rampColor(t) {
  t = Math.max(0, Math.min(1, t));
  const x = t * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  const a = RAMP[i], b = RAMP[i + 1];
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/* ---------------- aggregation ---------------- */

function aggregate(values, mode) {
  if (!values.length) return NaN;
  if (mode === 'sum') return values.reduce((s, v) => s + v, 0);
  if (mode === 'count') return values.length;
  if (mode === 'max') return Math.max(...values);
  return values.reduce((s, v) => s + v, 0) / values.length; // mean
}

/* ---------------- renderers ---------------- */

function polyPath(rings) {
  let d = '';
  for (const ring of rings) {
    const pts = ring.map(([lng, lat]) => projectUSA(lng, lat));
    d += 'M' + pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L') + 'Z';
  }
  return d;
}

async function renderChoropleth(container, columns, rows, geo, valueIdx, aggMode) {
  const states = await loadStates();
  // aggregate value per state
  const byState = new Map();
  for (const r of rows) {
    const code = toStateCode(r[geo.stateIdx]);
    if (!code) continue;
    const v = valueIdx === -1 ? 1 : Number(r[valueIdx]);
    if (valueIdx !== -1 && !Number.isFinite(v)) continue;
    if (!byState.has(code)) byState.set(code, []);
    byState.get(code).push(v);
  }
  const agg = new Map();
  for (const [code, vs] of byState) agg.set(code, valueIdx === -1 ? vs.length : aggregate(vs, aggMode));
  const vals = [...agg.values()].filter(Number.isFinite);
  const [min, max] = minMax(vals);
  const norm = (v) => (max > min ? (v - min) / (max - min) : 0.5);

  const svg = svgEl('svg', { viewBox: `0 0 ${MAP_W} ${MAP_H}`, role: 'img' });
  for (const st of states) {
    const v = agg.get(st.code);
    const fill = v == null || !Number.isFinite(v) ? 'var(--surface-2)' : rampColor(norm(v));
    const path = svgEl('path', { d: polyPath(st.rings), fill, stroke: 'var(--surface)', 'stroke-width': 0.6 });
    if (v != null && Number.isFinite(v)) {
      path.addEventListener('mousemove', (e) => showTooltip(e, `${st.name} (${st.code})`, fmtNum(v)));
      path.addEventListener('mouseleave', hideTooltip);
    }
    svg.append(path);
  }
  container.append(svg);
  container.append(legend(min, max, valueIdx === -1 ? 'count' : columns[valueIdx]));
}

async function renderBubbles(container, columns, rows, points, valueIdx, style) {
  // points: [{lng,lat,value,label}]
  const svg = svgEl('svg', { viewBox: `0 0 ${MAP_W} ${MAP_H}`, role: 'img' });
  const states = await loadStates();
  for (const st of states) {
    svg.append(svgEl('path', { d: polyPath(st.rings), fill: 'var(--surface-2)', stroke: 'var(--border)', 'stroke-width': 0.6 }));
  }
  const vals = points.map((p) => p.value).filter(Number.isFinite);
  const [min, max] = vals.length ? minMax(vals) : [0, 1];
  const norm = (v) => (max > min ? (v - min) / (max - min) : 0.5);
  const rScale = (v) => 3 + Math.sqrt(norm(v)) * 16;

  if (style === 'heatmap') {
    // additive translucent blobs → density
    for (const p of points) {
      const [x, y] = projectUSA(p.lng, p.lat);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const r = 14;
      svg.append(svgEl('circle', { cx: x, cy: y, r, fill: 'var(--series-3)', 'fill-opacity': 0.18 }));
    }
  } else {
    for (const p of points) {
      const [x, y] = projectUSA(p.lng, p.lat);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const dot = svgEl('circle', {
        cx: x, cy: y, r: valueIdx === -1 ? 3.5 : rScale(p.value),
        fill: valueIdx === -1 ? 'var(--series-1)' : rampColor(norm(p.value)),
        'fill-opacity': 0.75, stroke: 'var(--surface)', 'stroke-width': 0.7
      });
      dot.addEventListener('mousemove', (e) => showTooltip(e, p.label || `${p.lat.toFixed(2)}, ${p.lng.toFixed(2)}`, valueIdx === -1 ? '1' : fmtNum(p.value)));
      dot.addEventListener('mouseleave', hideTooltip);
      svg.append(dot);
    }
  }
  container.append(svg);
  if (valueIdx !== -1 && style !== 'heatmap') container.append(legend(min, max, columns[valueIdx]));
  else container.append(el('div', { class: 'map-note' }, `${points.length} locations plotted`));
}

function legend(min, max, label) {
  const grad = el('span', { class: 'grad' });
  grad.style.background = `linear-gradient(90deg, ${rampColor(0)}, ${rampColor(0.5)}, ${rampColor(1)})`;
  return el('div', { class: 'map-legend' },
    el('span', {}, label + ':'),
    el('span', {}, fmtNum(min)), grad, el('span', {}, fmtNum(max)));
}

/* ---------------- orchestrator ---------------- */

async function showMap(cardCtl, btn, { columns, rows, geo }) {
  btn.disabled = true;
  const wrap = el('div', { class: 'map-wrap' });
  const controls = el('div', { class: 'map-controls' });
  const slot = el('div', {});
  wrap.append(controls, slot);
  cardCtl.body.append(wrap);
  scrollChat();

  // value column selector (or "count")
  const valueSel = el('select', {});
  valueSel.append(el('option', { value: '-1' }, geo.kind === 'state' ? 'Count of rows' : 'Just locations'));
  for (const i of geo.valueCols) valueSel.append(el('option', { value: String(i) }, columns[i]));
  if (geo.valueCols.length) valueSel.value = String(geo.valueCols[0]);

  const aggSel = el('select', {});
  for (const [v, t] of [['mean', 'average'], ['sum', 'total'], ['max', 'max']]) aggSel.append(el('option', { value: v }, t));

  const styleSel = el('select', {});
  if (geo.kind === 'state') { styleSel.append(el('option', { value: 'choropleth' }, 'color by state')); }
  else {
    styleSel.append(el('option', { value: 'bubbles' }, 'bubbles'));
    styleSel.append(el('option', { value: 'heatmap' }, 'heatmap'));
  }

  controls.append(
    el('label', {}, 'Value', valueSel),
    geo.kind === 'state' ? el('label', {}, 'as', aggSel) : null,
    el('label', {}, 'Style', styleSel)
  );

  async function draw() {
    slot.textContent = '';
    const valueIdx = Number(valueSel.value);
    aggSel.parentElement && (aggSel.parentElement.style.display = valueIdx === -1 ? 'none' : '');
    try {
      if (geo.kind === 'state') {
        await renderChoropleth(slot, columns, rows, geo, valueIdx, aggSel.value);
      } else if (geo.kind === 'latlong') {
        const all = rows.map((r) => ({
          lng: Number(r[geo.lngIdx]), lat: Number(r[geo.latIdx]),
          value: valueIdx === -1 ? 1 : Number(r[valueIdx])
        }));
        const points = all.filter((p) => inUSA(p.lng, p.lat));
        await renderBubbles(slot, columns, rows, points, valueIdx, styleSel.value);
        if (points.length < all.length) slot.append(el('div', { class: 'map-note' }, `${all.length - points.length} point(s) outside the US were not plotted.`));
      } else if (geo.kind === 'zip') {
        const zips = await loadZips();
        const points = [];
        for (const r of rows) {
          const z = toZip(r[geo.zipIdx]);
          const ll = zips && zips[z];
          if (!ll) continue;
          points.push({ lng: ll[1], lat: ll[0], value: valueIdx === -1 ? 1 : Number(r[valueIdx]), label: `ZIP ${z}` });
        }
        if (!points.length) { slot.append(el('div', { class: 'map-note' }, 'No matching ZIP coordinates found (ZIP map data may not be installed).')); return; }
        await renderBubbles(slot, columns, rows, points.filter((p) => Number.isFinite(p.value) || valueIdx === -1), valueIdx, styleSel.value);
      }
    } catch (e) {
      slot.append(el('div', { class: 'error-box' }, `Map failed: ${e.message}`));
    }
    scrollChat();
  }
  valueSel.addEventListener('change', draw);
  aggSel.addEventListener('change', draw);
  styleSel.addEventListener('change', draw);
  await draw();
  btn.disabled = false;
}

/* ZIP centroids are optional (a large table); load lazily if bundled. */
let zipCache = null;
async function loadZips() {
  if (zipCache !== null) return zipCache;
  try {
    const res = await fetch('geo/zip-centroids.json');
    if (!res.ok) { zipCache = false; return false; }
    zipCache = await res.json();
  } catch { zipCache = false; }
  return zipCache;
}
