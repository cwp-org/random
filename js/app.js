/* Depth Review & Adjustment Dashboard
 *
 * Static, browser-only app. Loads one site at a time from
 * data/sites/<SITE>.json.gz (gzipped columnar JSON, decompressed with the
 * native DecompressionStream API), plots original and adjusted depth with
 * Plotly, and lets the user apply reversible, time-windowed depth
 * adjustments. Original Depth_m values are never modified: adjustments are
 * applied to a separate Float64Array copy.
 *
 * Time handling: DateTime_GMT_minus_5 is stored as POSIXct epoch seconds.
 * All display/interaction uses fixed-offset GMT-5 "wall milliseconds"
 * (= (epoch - 18000) * 1000) rendered with UTC formatting, so what you see
 * is GMT-5 wall-clock time with no browser-timezone or DST interference.
 */

"use strict";

/* eslint-disable no-undef */ // Plotly is a global from js/vendor/plotly-basic.min.js

// ------------------------------------------------------------------ config

const GMT5_OFFSET_MS = 5 * 3600 * 1000;
const COARSE_BUCKETS = 4000;   // full-record overview resolution (per series)
const FINE_BUCKETS = 3000;     // in-view resolution when window is still large
const RAW_LIMIT = 25000;       // show every raw point when the window has fewer
const VIEW_MARGIN = 0.08;      // fraction of window width to over-fetch fine data
const STORAGE_PREFIX = "depth-dashboard:adjustments:v1:";

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ state

const state = {
  manifest: null,
  site: null,          // current site id
  data: null,          // decoded site data (see loadSite)
  adjustments: [],     // [{start, end, delta, appliedAt, rows}] wall-ms windows
  view: null,          // [loWallMs, hiWallMs] current synced x-window
  fullRange: null,     // [loWallMs, hiWallMs] full period of record
  yOverride: { "plot-raw": null, "plot-adj": null }, // manual y-zoom per plot
  applyingRelayout: false,
  loadToken: 0,        // invalidates stale fetches when switching sites fast
};

// ------------------------------------------------------------------ time utils

function wallMsFromEpochSec(sec) { return sec * 1000 - GMT5_OFFSET_MS; }

function pad(n, w = 2) { return String(n).padStart(w, "0"); }

function fmtWall(ms, withSeconds = false) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  let s = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
          `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (withSeconds) s += `:${pad(d.getUTCSeconds())}`;
  return s;
}

function fmtWallInput(ms) {
  // value for <input type="datetime-local"> (minute precision)
  if (!Number.isFinite(ms)) return "";
  return fmtWall(ms).replace(" ", "T");
}

function parseWallInput(value) {
  // "YYYY-MM-DDTHH:MM[:SS]" -> wall ms (interpreted as GMT-5 wall clock)
  if (!value) return NaN;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}

function parsePlotlyX(v) {
  // Plotly relayout ranges arrive as "YYYY-MM-DD HH:MM:SS.ssss" strings or numbers.
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), 0) +
         Math.round(parseFloat(m[6] || "0") * 1000);
}

// ------------------------------------------------------------------ UI helpers

let statusTimer = null;
function setStatus(msg, kind = "info", ttlMs = 6000) {
  const bar = $("status-bar");
  clearTimeout(statusTimer);
  if (!msg) { bar.hidden = true; return; }
  bar.textContent = msg;
  bar.className = `status-bar ${kind}`;
  bar.hidden = false;
  if (ttlMs) statusTimer = setTimeout(() => { bar.hidden = true; }, ttlMs);
}

function setLoading(text) {
  const overlay = $("loading-overlay");
  if (text == null) { overlay.hidden = true; return; }
  $("loading-text").textContent = text;
  overlay.hidden = false;
}

function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    surface: v("--surface"), grid: v("--grid"), baseline: v("--baseline"),
    text: v("--text-primary"), muted: v("--text-muted"),
    secondary: v("--text-secondary"),
    raw: v("--series-raw"), adj: v("--series-adj"), ref: v("--series-ref"),
  };
}

// ------------------------------------------------------------------ data loading

async function fetchManifest() {
  const res = await fetch("data/manifest.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
  return res.json();
}

async function fetchSiteJson(file) {
  const res = await fetch(`data/${file}`, { cache: "force-cache" });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) {
    // Some servers transparently decode .gz; accept plain JSON too.
    return JSON.parse(new TextDecoder().decode(buf));
  }
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser lacks DecompressionStream; please use a current version of Chrome, Edge, Firefox, or Safari.");
  }
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  return JSON.parse(text);
}

function decodeSite(payload) {
  const n = payload.n;

  // --- time: delta-decode POSIXct epoch seconds -> GMT-5 wall ms (NaN = missing)
  const tWall = new Float64Array(n);
  {
    const deltas = payload.t_delta;
    let prev = null;
    for (let i = 0; i < n; i++) {
      const d = deltas[i];
      if (d === null) { tWall[i] = NaN; continue; }
      const cur = prev === null ? payload.t0 : prev + d;
      tWall[i] = wallMsFromEpochSec(cur);
      prev = cur;
    }
  }

  // --- depth (original, read-only from here on)
  const depth = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = payload.depth[i];
    depth[i] = v === null ? NaN : v;
  }

  // --- categorical columns: expand RLE to per-row code arrays
  const expandRle = (rle) => {
    const codes = new Uint8Array(n);
    let i = 0;
    for (const [code, count] of rle) codes.fill(code, i, (i += count));
    if (i !== n) throw new Error("RLE length mismatch");
    return codes;
  };
  const phaseCode = expandRle(payload.phase_rle);
  const sourceCode = expandRle(payload.source_rle);

  // --- stable sort by time for plotting (original row order is preserved
  //     in all arrays above; the sorted index is a view for the charts only)
  const plotIdx = [];
  for (let i = 0; i < n; i++) if (!Number.isNaN(tWall[i])) plotIdx.push(i);
  plotIdx.sort((a, b) => (tWall[a] - tWall[b]) || (a - b));
  const m = plotIdx.length;
  const sIdx = Uint32Array.from(plotIdx);       // sorted position -> original row
  const sT = new Float64Array(m);
  for (let i = 0; i < m; i++) sT[i] = tWall[sIdx[i]];

  return {
    site: payload.site,
    n,
    dt: payload.dt,                 // original character DateTime, verbatim
    tWall, depth, phaseCode, sourceCode,
    phaseDict: payload.phase_dict,
    sourceDict: payload.source_dict,
    sIdx, sT, m,
    adjusted: null,                 // Float64Array, set by recomputeAdjusted()
    coarseRaw: null,                // cached full-range overview (original)
    coarseAdj: null,                // cached full-range overview (adjusted)
  };
}

// ------------------------------------------------------------------ downsampling

function lowerBound(arr, len, x) {
  let lo = 0, hi = len;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}
function upperBound(arr, len, x) {
  let lo = 0, hi = len;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * Min/max bucket downsampling over sorted positions [lo, hi).
 * Every emitted point is a real sample (no averaging); buckets that are
 * entirely missing emit a single null to preserve visible data gaps.
 * yAt(sortedPos) supplies the value (original or adjusted depth).
 * Returns { pos: Int32Array-like of sorted positions, gaps: Set<int> } where
 * a position of -1 marks a gap marker at time gapT[k].
 */
function bucketDownsample(d, yAt, lo, hi, nBuckets) {
  const count = hi - lo;
  const out = [];       // sorted positions; -1 entries are gaps
  const gapT = [];      // wall ms for gap markers (parallel to -1 entries)
  const per = Math.max(1, Math.ceil(count / nBuckets));
  for (let b = lo; b < hi; b += per) {
    const bEnd = Math.min(b + per, hi);
    let minP = -1, maxP = -1, minV = Infinity, maxV = -Infinity;
    for (let i = b; i < bEnd; i++) {
      const v = yAt(i);
      if (Number.isNaN(v)) continue;
      if (v < minV) { minV = v; minP = i; }
      if (v > maxV) { maxV = v; maxP = i; }
    }
    if (minP === -1) {                     // all-missing bucket -> gap
      out.push(-1); gapT.push(d.sT[b]);
      continue;
    }
    if (minP === maxP) out.push(minP);
    else if (minP < maxP) out.push(minP, maxP);
    else out.push(maxP, minP);
  }
  return { pos: out, gapT };
}

/**
 * Build piecewise-resolution plot arrays for one series: coarse everywhere,
 * fine (or raw) inside the current view window. Because the coarse overview
 * spans the full record, the range slider always shows full-record context.
 */
function buildSeries(d, yAt, coarse, viewLo, viewHi) {
  const margin = (viewHi - viewLo) * VIEW_MARGIN;
  const lo = lowerBound(d.sT, d.m, viewLo - margin);
  const hi = upperBound(d.sT, d.m, viewHi + margin);
  const count = hi - lo;

  let fine, resNote;
  if (count <= RAW_LIMIT) {
    fine = { pos: null, lo, hi };          // raw slice, no downsampling
    resNote = `${count.toLocaleString()} raw points in view`;
  } else {
    fine = bucketDownsample(d, yAt, lo, hi, FINE_BUCKETS);
    resNote = `${count.toLocaleString()} points in view (min/max downsampled)`;
  }

  // splice: coarse-left + fine + coarse-right
  const x = [], y = [], custom = [];
  const pushPos = (p) => {
    const orig = d.sIdx[p];
    x.push(d.sT[p]);
    const v = yAt(p);
    y.push(Number.isNaN(v) ? null : v);
    custom.push([
      d.dt[orig],
      d.phaseDict[d.phaseCode[orig]],
      d.sourceDict[d.sourceCode[orig]],
    ]);
  };
  const pushGap = (t) => { x.push(t); y.push(null); custom.push(["", "", ""]); };

  const emitCoarse = (fromT, toT) => {
    const cp = coarse.pos, ct = coarse.gapT;
    let g = 0;
    for (let k = 0; k < cp.length; k++) {
      const p = cp[k];
      const t = p === -1 ? ct[g++] : d.sT[p];
      if (t < fromT || t > toT) continue;
      if (p === -1) pushGap(t); else pushPos(p);
    }
  };

  const fineLoT = lo < d.m ? d.sT[lo] : Infinity;
  const fineHiT = hi > 0 ? d.sT[hi - 1] : -Infinity;
  emitCoarse(-Infinity, fineLoT - 1);
  if (fine.pos === null) {
    for (let p = fine.lo; p < fine.hi; p++) pushPos(p);
  } else {
    let g = 0;
    for (const p of fine.pos) { if (p === -1) pushGap(fine.gapT[g++]); else pushPos(p); }
  }
  emitCoarse(fineHiT + 1, Infinity);

  return { x, y, custom, resNote, viewCount: count, viewLoIdx: lo, viewHiIdx: hi };
}

// ------------------------------------------------------------------ adjustments

function netDelta(d, origRow) {
  const t = d.tWall[origRow];
  if (Number.isNaN(t)) return 0;
  let sum = 0;
  for (const a of state.adjustments) if (t >= a.start && t <= a.end) sum += a.delta;
  return sum;
}

function recomputeAdjusted() {
  const d = state.data;
  if (!d) return;
  const adj = new Float64Array(d.depth);          // copy — original untouched
  for (const a of state.adjustments) {
    for (let i = 0; i < d.n; i++) {
      const t = d.tWall[i];
      if (t >= a.start && t <= a.end) adj[i] += a.delta;   // NaN t fails both
    }
  }
  d.adjusted = adj;
  d.coarseAdj = bucketDownsample(d, (p) => adj[d.sIdx[p]], 0, d.m, COARSE_BUCKETS);
}

function countRowsInWindow(startMs, endMs) {
  const d = state.data;
  let c = 0;
  for (let i = 0; i < d.n; i++) {
    const t = d.tWall[i];
    if (t >= startMs && t <= endMs) c++;
  }
  return c;
}

function saveAdjustments() {
  try {
    const key = STORAGE_PREFIX + state.site;
    if (state.adjustments.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(state.adjustments));
  } catch { /* storage may be unavailable; adjustments still work in-memory */ }
}

function loadStoredAdjustments(site) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + site);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list)
      ? list.filter((a) => Number.isFinite(a.start) && Number.isFinite(a.end) &&
                           Number.isFinite(a.delta))
      : [];
  } catch { return []; }
}

function renderHistory() {
  const tbody = $("history-table").querySelector("tbody");
  tbody.textContent = "";
  state.adjustments.forEach((a, i) => {
    const tr = document.createElement("tr");
    const cells = [
      String(i + 1),
      fmtWall(a.start),
      fmtWall(a.end),
      (a.delta > 0 ? "+" : "") + a.delta,
      (a.rows ?? 0).toLocaleString(),
      a.appliedAt || "",
    ];
    cells.forEach((text, ci) => {
      const td = document.createElement("td");
      td.textContent = text;                    // untrusted-safe insertion
      if (ci === 3 || ci === 4) td.className = "num";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  $("history-empty").hidden = state.adjustments.length > 0;
  $("btn-undo-adj").disabled = state.adjustments.length === 0;
  $("btn-reset-adj").disabled = state.adjustments.length === 0;
}

// ------------------------------------------------------------------ plotting

const HOVER_TMPL =
  "<b>%{y:.4f} m</b>" +
  "<br><span style='color:inherit'>%{x|%Y-%m-%d %H:%M}</span> (GMT-5)" +
  "<br>Original DateTime: %{customdata[0]}" +
  "<br>%{customdata[1]} · %{customdata[2]}" +
  "<extra></extra>";

function baseLayout(colors, title, withSlider) {
  const layout = {
    uirevision: state.site,
    margin: { l: 58, r: 12, t: 8, b: withSlider ? 26 : 36 },
    paper_bgcolor: colors.surface,
    plot_bgcolor: colors.surface,
    font: { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', size: 12, color: colors.secondary },
    showlegend: false,
    hovermode: "x unified",
    hoverlabel: { font: { size: 12 } },
    dragmode: "zoom",
    xaxis: {
      type: "date",
      range: state.view.slice(),
      gridcolor: colors.grid,
      linecolor: colors.baseline,
      zeroline: false,
      hoverformat: "%Y-%m-%d %H:%M",
    },
    yaxis: {
      title: { text: title, font: { size: 12, color: colors.muted } },
      gridcolor: colors.grid,
      linecolor: colors.baseline,
      zerolinecolor: colors.baseline,
      fixedrange: false,
    },
  };
  if (withSlider) {
    layout.xaxis.rangeslider = {
      visible: true,
      thickness: 0.10,
      autorange: false,
      range: state.fullRange.slice(),
      bordercolor: colors.baseline,
      borderwidth: 1,
      bgcolor: colors.surface,
    };
  }
  return layout;
}

const PLOT_CONFIG = {
  responsive: true,
  displaylogo: false,
  scrollZoom: true,
  modeBarButtonsToRemove: ["lasso2d", "select2d"],
  toImageButtonOptions: { format: "png", scale: 2 },
};

function renderPlots() {
  const d = state.data;
  if (!d || !state.view) return;
  const colors = themeColors();
  const [lo, hi] = state.view;

  const rawSeries = buildSeries(d, (p) => d.depth[d.sIdx[p]], d.coarseRaw, lo, hi);
  const adjSeries = buildSeries(d, (p) => d.adjusted[d.sIdx[p]], d.coarseAdj, lo, hi);

  $("raw-res-note").textContent = rawSeries.resNote;
  $("adj-res-note").textContent = adjSeries.resNote;

  const rawTrace = {
    x: rawSeries.x, y: rawSeries.y, customdata: rawSeries.custom,
    type: "scatter", mode: "lines", name: "Original depth",
    line: { color: colors.raw, width: 1.3 },
    connectgaps: false,
    hovertemplate: HOVER_TMPL,
  };

  const refTrace = {
    x: rawSeries.x, y: rawSeries.y,
    type: "scatter", mode: "lines", name: "Original (reference)",
    line: { color: colors.ref, width: 1 },
    connectgaps: false,
    hoverinfo: "skip",
  };
  const adjTrace = {
    x: adjSeries.x, y: adjSeries.y, customdata: adjSeries.custom,
    type: "scatter", mode: "lines", name: "Adjusted depth",
    line: { color: colors.adj, width: 1.3 },
    connectgaps: false,
    hovertemplate: HOVER_TMPL,
  };

  const rawLayout = baseLayout(colors, "Depth (m) — original", false);
  const adjLayout = baseLayout(colors, "Depth (m) — adjusted", true);
  adjLayout.showlegend = true;
  adjLayout.legend = {
    orientation: "h", x: 0, y: 1.06, yanchor: "bottom",
    font: { size: 11, color: colors.secondary }, bgcolor: "rgba(0,0,0,0)",
  };

  applyYRange(rawLayout.yaxis, "plot-raw", [rawSeries], lo, hi);
  applyYRange(adjLayout.yaxis, "plot-adj", [adjSeries, rawSeries], lo, hi);

  state.applyingRelayout = true;
  Promise.all([
    Plotly.react("plot-raw", [rawTrace], rawLayout, PLOT_CONFIG),
    Plotly.react("plot-adj", [refTrace, adjTrace], adjLayout, PLOT_CONFIG),
  ]).finally(() => { state.applyingRelayout = false; });
}

function applyYRange(yaxis, divId, seriesList, lo, hi) {
  const manual = state.yOverride[divId];
  if (manual) {
    yaxis.autorange = false;
    yaxis.range = manual.slice();
    return;
  }
  autoYRange(yaxis, seriesList, lo, hi);
}

function autoYRange(yaxis, seriesList, lo, hi) {
  let min = Infinity, max = -Infinity;
  for (const s of seriesList) {
    for (let i = 0; i < s.x.length; i++) {
      const t = s.x[i], v = s.y[i];
      if (v === null || t < lo || t > hi) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min)) return; // leave autorange on
  const pad = (max - min || Math.abs(max) || 1) * 0.06;
  yaxis.autorange = false;
  yaxis.range = [min - pad, max + pad];
}

let renderTimer = null;
function queueRender() {
  // Trailing debounce: continuous relayout streams (slider drag, pan) only
  // trigger one data rebuild once the gesture pauses.
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPlots, 160);
}

function setViewUser(lo, hi) {
  // Range set from the left panel: fresh window, y auto-fits on both plots.
  state.yOverride["plot-raw"] = null;
  state.yOverride["plot-adj"] = null;
  setView(lo, hi);
}

function setView(lo, hi, { render = true } = {}) {
  const [flo, fhi] = state.fullRange;
  if (!(hi > lo)) return;
  state.view = [Math.max(lo, flo - 1), Math.min(hi, fhi + 1)];
  $("range-start").value = fmtWallInput(state.view[0]);
  $("range-end").value = fmtWallInput(state.view[1]);
  if (render) queueRender();
}

function handleRelayout(divId, ev) {
  if (state.applyingRelayout || !state.data) return;

  // Track manual y zoom on the source plot so re-renders keep it.
  let yChanged = false;
  if (ev["yaxis.autorange"]) {
    state.yOverride[divId] = null;
    yChanged = true;
  } else if (ev["yaxis.range"] !== undefined) {
    state.yOverride[divId] = [Number(ev["yaxis.range"][0]), Number(ev["yaxis.range"][1])];
    yChanged = true;
  } else if (ev["yaxis.range[0]"] !== undefined && ev["yaxis.range[1]"] !== undefined) {
    state.yOverride[divId] = [Number(ev["yaxis.range[0]"]), Number(ev["yaxis.range[1]"])];
    yChanged = true;
  }

  let lo = null, hi = null;
  if (ev["xaxis.autorange"]) {
    [lo, hi] = state.fullRange;
  } else if (ev["xaxis.range"] !== undefined) {
    lo = parsePlotlyX(ev["xaxis.range"][0]); hi = parsePlotlyX(ev["xaxis.range"][1]);
  } else if (ev["xaxis.range[0]"] !== undefined || ev["xaxis.range[1]"] !== undefined) {
    lo = ev["xaxis.range[0]"] !== undefined ? parsePlotlyX(ev["xaxis.range[0]"]) : state.view[0];
    hi = ev["xaxis.range[1]"] !== undefined ? parsePlotlyX(ev["xaxis.range[1]"]) : state.view[1];
  } else {
    return; // y-only change: Plotly already applied it, nothing to rebuild
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
  const [clo, chi] = state.view;
  if (Math.abs(lo - clo) < 500 && Math.abs(hi - chi) < 500) {
    if (yChanged && ev["xaxis.autorange"]) queueRender();
    return; // no-op echo of our own relayout
  }
  // The x-window moved: the other plot follows with an auto-fit y, and the
  // source plot keeps a manual y only if this same gesture set one.
  if (!yChanged) state.yOverride[divId] = null;
  state.yOverride[divId === "plot-raw" ? "plot-adj" : "plot-raw"] = null;
  setView(lo, hi);
}

// ------------------------------------------------------------------ site UI

function populateSiteSelect() {
  const sel = $("site-select");
  sel.textContent = "";
  for (const s of state.manifest.sites) {
    const opt = document.createElement("option");
    opt.value = s.id;
    const name = s.site_name ? ` — ${s.site_name}` : "";
    const sensor = s.sensor_id != null ? ` (sensor ${Math.round(s.sensor_id)})` : "";
    opt.textContent = `${s.id}${name}${sensor}`;
    sel.appendChild(opt);
  }
}

function renderSiteInfo(meta) {
  const dl = $("site-info");
  dl.textContent = "";
  const rows = [
    ["Site name", meta.site_name || "—"],
    ["Records", meta.rows.toLocaleString()],
    ["From", fmtWall(wallMsFromEpochSec(meta.t_min))],
    ["To", fmtWall(wallMsFromEpochSec(meta.t_max))],
    ["Phases", (meta.phases || []).join(", ")],
    ["Missing depth", meta.rows_missing_depth.toLocaleString()],
    ["Missing time", meta.rows_missing_time.toLocaleString()],
    ["Source file", meta.source_chunk],
  ];
  for (const [k, v] of rows) {
    const div = document.createElement("div");
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    div.append(dt, dd);
    dl.appendChild(div);
  }
}

async function loadSite(siteId) {
  const meta = state.manifest.sites.find((s) => s.id === siteId);
  if (!meta) { setStatus(`Unknown site ${siteId}`, "error"); return; }
  const token = ++state.loadToken;
  const mb = meta.bytes_gz ? ` (~${(meta.bytes_gz / 1e6).toFixed(1)} MB)` : "";
  setLoading(`Loading ${siteId}${mb}…`);
  try {
    const payload = await fetchSiteJson(meta.file);
    if (token !== state.loadToken) return;   // user already switched away
    setLoading(`Decoding ${siteId} (${meta.rows.toLocaleString()} records)…`);
    await new Promise((r) => setTimeout(r, 20)); // let the overlay paint
    const d = decodeSite(payload);
    if (token !== state.loadToken) return;

    state.site = siteId;
    state.data = d;
    d.coarseRaw = bucketDownsample(d, (p) => d.depth[d.sIdx[p]], 0, d.m, COARSE_BUCKETS);
    state.fullRange = [d.sT[0], d.sT[d.m - 1]];
    state.adjustments = loadStoredAdjustments(siteId);
    state.yOverride = { "plot-raw": null, "plot-adj": null };
    recomputeAdjusted();
    renderHistory();
    renderSiteInfo(meta);
    setView(state.fullRange[0], state.fullRange[1], { render: false });
    $("adj-start").value = "";
    $("adj-end").value = "";
    renderPlots();
    if (state.adjustments.length) {
      setStatus(`${siteId}: restored ${state.adjustments.length} saved adjustment(s) from this browser.`, "info");
    }
  } catch (err) {
    if (token === state.loadToken) setStatus(`Failed to load ${siteId}: ${err.message}`, "error", 0);
  } finally {
    if (token === state.loadToken) setLoading(null);
  }
}

// ------------------------------------------------------------------ adjustment actions

function applyAdjustment() {
  if (!state.data) return;
  const start = parseWallInput($("adj-start").value);
  const end = parseWallInput($("adj-end").value);
  const delta = parseFloat($("adj-delta").value);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    setStatus("Enter both an adjustment start and end date/time.", "error"); return;
  }
  if (end <= start) {
    setStatus("Adjustment end must be after the start.", "error"); return;
  }
  if (!Number.isFinite(delta) || delta === 0) {
    setStatus("Enter a non-zero depth adjustment in meters (e.g. -0.15).", "error"); return;
  }
  const rows = countRowsInWindow(start, end);
  if (rows === 0) {
    setStatus("No records fall inside that window — nothing to adjust.", "error"); return;
  }
  state.adjustments.push({
    start, end, delta, rows,
    appliedAt: fmtWall(Date.now() - GMT5_OFFSET_MS, true),
  });
  recomputeAdjusted();
  saveAdjustments();
  renderHistory();
  queueRender();
  setStatus(`Applied ${delta > 0 ? "+" : ""}${delta} m to ${rows.toLocaleString()} records.`, "success");
}

function undoAdjustment() {
  if (!state.adjustments.length) return;
  const a = state.adjustments.pop();
  recomputeAdjusted();
  saveAdjustments();
  renderHistory();
  queueRender();
  setStatus(`Undid adjustment of ${a.delta > 0 ? "+" : ""}${a.delta} m (${fmtWall(a.start)} → ${fmtWall(a.end)}).`, "info");
}

function resetAdjustments() {
  if (!state.adjustments.length) return;
  if (!window.confirm(`Remove all ${state.adjustments.length} adjustment(s) for ${state.site}?`)) return;
  state.adjustments = [];
  recomputeAdjusted();
  saveAdjustments();
  renderHistory();
  queueRender();
  setStatus("All adjustments removed. Adjusted depth now equals original depth.", "info");
}

// ------------------------------------------------------------------ downloads

function csvField(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadBlob(text, filename) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function stamp() {
  return fmtWall(Date.now() - GMT5_OFFSET_MS, true).replace(/[-: ]/g, "").slice(0, 13);
}

function downloadAdjustedCsv() {
  const d = state.data;
  if (!d) return;
  setStatus(`Preparing CSV for ${d.n.toLocaleString()} records…`, "info", 0);
  setTimeout(() => {
    try {
      const lines = new Array(d.n + 1);
      lines[0] = "Site,DateTime,DateTime_GMT_minus_5,Depth_m,Depth_m_adjusted,Adjustment_m,Phase,Source_Block";
      for (let i = 0; i < d.n; i++) {
        const t = d.tWall[i];
        const orig = d.depth[i];
        const adj = d.adjusted[i];
        const delta = netDelta(d, i);
        lines[i + 1] = [
          state.site,
          csvField(d.dt[i]),
          Number.isNaN(t) ? "" : fmtWall(t, true),
          Number.isNaN(orig) ? "" : String(orig),
          Number.isNaN(adj) ? "" : String(adj),
          delta === 0 ? "0" : String(delta),
          csvField(d.phaseDict[d.phaseCode[i]]),
          csvField(d.sourceDict[d.sourceCode[i]]),
        ].join(",");
      }
      downloadBlob(lines.join("\n"), `${state.site}_adjusted_${stamp()}.csv`);
      setStatus(`Downloaded adjusted data for ${state.site} (${d.n.toLocaleString()} rows).`, "success");
    } catch (err) {
      setStatus(`CSV export failed: ${err.message}`, "error", 0);
    }
  }, 30);
}

function downloadHistoryCsv() {
  if (!state.site) return;
  const lines = ["Site,Order,Start_GMT_minus_5,End_GMT_minus_5,Adjustment_m,Rows_Affected,Applied_At_GMT_minus_5"];
  state.adjustments.forEach((a, i) => {
    lines.push([
      state.site, i + 1, fmtWall(a.start), fmtWall(a.end),
      String(a.delta), a.rows ?? "", csvField(a.appliedAt || ""),
    ].join(","));
  });
  downloadBlob(lines.join("\n"), `${state.site}_adjustment_history_${stamp()}.csv`);
  setStatus("Downloaded adjustment history.", "success");
}

// ------------------------------------------------------------------ wiring

function wireEvents() {
  $("site-select").addEventListener("change", (e) => loadSite(e.target.value));

  $("btn-apply-range").addEventListener("click", () => {
    const lo = parseWallInput($("range-start").value);
    const hi = parseWallInput($("range-end").value);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
      setStatus("Enter a valid date range (end after start).", "error"); return;
    }
    setViewUser(lo, hi);
  });
  $("btn-full-range").addEventListener("click", () => {
    if (state.fullRange) setViewUser(state.fullRange[0], state.fullRange[1]);
  });
  $("btn-last-year").addEventListener("click", () => {
    if (state.fullRange) setViewUser(state.fullRange[1] - 365 * 86400e3, state.fullRange[1]);
  });
  $("btn-last-90").addEventListener("click", () => {
    if (state.fullRange) setViewUser(state.fullRange[1] - 90 * 86400e3, state.fullRange[1]);
  });

  $("btn-use-view").addEventListener("click", () => {
    if (!state.view) return;
    $("adj-start").value = fmtWallInput(state.view[0]);
    $("adj-end").value = fmtWallInput(state.view[1]);
  });
  $("btn-apply-adj").addEventListener("click", applyAdjustment);
  $("btn-undo-adj").addEventListener("click", undoAdjustment);
  $("btn-reset-adj").addEventListener("click", resetAdjustments);
  $("btn-dl-adjusted").addEventListener("click", downloadAdjustedCsv);
  $("btn-dl-history").addEventListener("click", downloadHistoryCsv);

  for (const id of ["plot-raw", "plot-adj"]) {
    $(id).on?.("plotly_relayout", (ev) => handleRelayout(id, ev));
  }

  // Re-theme the plots when the OS color scheme flips.
  window.matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => queueRender());
}

async function init() {
  try {
    setLoading("Loading site index…");
    state.manifest = await fetchManifest();
  } catch (err) {
    setLoading(null);
    setStatus(`Failed to load data/manifest.json: ${err.message}. ` +
              "Did the preprocessing step run?", "error", 0);
    return;
  }
  populateSiteSelect();

  // Plot divs must exist before we can attach plotly_relayout, and Plotly
  // only adds .on() after the first plot — so create empty plots first.
  const colors = themeColors();
  const empty = {
    margin: { l: 58, r: 12, t: 8, b: 36 },
    paper_bgcolor: colors.surface, plot_bgcolor: colors.surface,
    xaxis: { visible: false }, yaxis: { visible: false },
    annotations: [{ text: "Select a site to load data", showarrow: false,
                    font: { color: colors.muted, size: 13 } }],
  };
  await Plotly.newPlot("plot-raw", [], empty, PLOT_CONFIG);
  await Plotly.newPlot("plot-adj", [], structuredClone(empty), PLOT_CONFIG);
  wireEvents();

  const first = state.manifest.sites[0];
  if (first) {
    $("site-select").value = first.id;
    await loadSite(first.id);
  }
}

// Started by the client-side access gate (js/auth.js) after successful
// authentication — no data is fetched or processed before login succeeds.
window.__startDashboard = init;
