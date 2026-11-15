// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { CSP_NONCE } from "../csp-nonce.js";
import { SETTINGS_HELPERS_SCRIPT, settingsPage } from "./settings-shell.js";

/**
 * Settings > Network (/portal/settings/network), system admins only: the live state of the network
 * from every coordinator. The page shell carries no data; its script reads
 * /portal/api/admin/network (src/portal/routes/network-admin.ts), which checks the session is a
 * system admin, asks each coordinator's GET /admin/network with the coordinator admin token
 * server-side, and joins agents to account emails. Refreshes every 15 s while the tab is visible.
 *
 * Charts are inline SVG drawn by the script (no library): colors come from the theme tokens
 * through CSS classes, so light and dark follow the theme toggle.
 */
export const NETWORK_REFRESH_MS = 15_000;

export function networkPageContent(): string {
  return `
    <style nonce="${CSP_NONCE}">
      .net-head { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:14px; }
      .net-head .set-lead { margin-bottom:0; }
      .net-controls { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      .net-seg { display:inline-flex; border:1px solid var(--border-strong); border-radius:var(--radius-sm); overflow:hidden; }
      .net-seg button { border:0; border-radius:0; min-height:28px; padding:4px 12px; background:transparent; color:var(--text-secondary); }
      .net-seg button + button { border-left:1px solid var(--border-strong); }
      .net-seg button[aria-pressed="true"] { background:var(--bg-elevated); color:var(--text); font-weight:600; }
      .net-updated { font-size:12px; color:var(--muted); font-variant-numeric:tabular-nums; }
      .net-kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(104px, 1fr)); gap:10px; margin-bottom:14px; }
      .net-kpi { border:1px solid var(--card-border); border-radius:var(--radius-md); background:var(--card); padding:10px 12px; min-width:0; }
      .net-kpi .label { font-size:12px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .net-kpi .value { font-size:22px; font-weight:600; letter-spacing:-0.01em; font-family:var(--font-mono); font-variant-numeric:tabular-nums; margin-top:2px; }
      .net-kpi .sub { font-size:11.5px; color:var(--muted); font-variant-numeric:tabular-nums; }
      .net-coords { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
      .net-coord { display:flex; align-items:center; gap:8px; border:1px solid var(--card-border); border-radius:999px; padding:4px 12px; font-size:12.5px; background:var(--card); }
      .net-coord .mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; color:var(--text-secondary); }
      .net-charts { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:12px; margin-bottom:14px; }
      .net-chart { border:1px solid var(--card-border); border-radius:var(--radius-md); background:var(--card); padding:12px 12px 8px; position:relative; min-width:0; }
      .net-chart h3 { font-size:13px; font-weight:600; margin:0; }
      .net-chart .hint { font-size:11.5px; color:var(--muted); }
      .net-legend { display:flex; gap:12px; flex-wrap:wrap; font-size:11.5px; color:var(--text-secondary); margin:4px 0 2px; }
      .net-legend span { display:inline-flex; align-items:center; gap:5px; }
      .net-legend svg { flex:none; }
      .net-chart svg.plot { display:block; width:100%; height:170px; overflow:visible; }
      .net-chart .grid { stroke:var(--card-border); stroke-width:1; }
      .net-chart .axis { fill:var(--muted); font-size:10px; font-family:var(--font-mono); }
      .net-chart .line { fill:none; stroke-width:2; stroke-linejoin:round; stroke-linecap:round; }
      .net-chart .area { stroke:none; }
      .net-chart .dash { stroke-dasharray:4 3; }
      .s-brand { stroke:var(--brand); } .f-brand { fill:var(--brand); }
      .s-info { stroke:var(--info); } .f-info { fill:var(--info); }
      .a-brand { fill:var(--brand); opacity:0.14; }
      .net-chart .cross { stroke:var(--text-secondary); stroke-width:1; }
      .net-chart .hdot { stroke:var(--card); stroke-width:2; }
      .net-chart .empty { fill:var(--muted); font-size:12px; }
      .net-tip { position:absolute; pointer-events:none; z-index:5; background:var(--bg-elevated); border:1px solid var(--card-border); border-radius:var(--radius-sm); box-shadow:var(--shadow-2); padding:6px 8px; font-size:11.5px; line-height:1.45; white-space:nowrap; font-variant-numeric:tabular-nums; }
      .net-tip .t { color:var(--muted); margin-bottom:2px; }
      .net-tip .v { font-family:var(--font-mono); color:var(--text); }
      .net-card { border:1px solid var(--card-border); border-radius:var(--radius-md); background:var(--card); padding:12px; margin-bottom:14px; min-width:0; }
      .net-card h3 { font-size:13px; font-weight:600; margin:0 0 8px; }
      .net-filter { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px; }
      .net-filter input { max-width:280px; }
      .net-filter select { width:auto; min-width:140px; }
      .net-table-wrap { overflow-x:auto; }
      .net-table-wrap table { font-size:12.5px; min-width:760px; }
      .net-table-wrap td { font-variant-numeric:tabular-nums; }
      .net-table-wrap th[data-sort] { cursor:pointer; user-select:none; }
      .net-table-wrap th[aria-sort="ascending"]::after { content:" \\2191"; }
      .net-table-wrap th[aria-sort="descending"]::after { content:" \\2193"; }
      .net-table-wrap .mono { font-family:var(--font-mono); font-size:12px; }
      .net-table-wrap .nowrap { white-space:nowrap; }
      .net-models-list { color:var(--text-secondary); max-width:260px; white-space:normal; }
      .net-gaps { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:12px; }
      .net-gap h4 { font-size:12px; font-weight:600; color:var(--text-secondary); margin:0 0 6px; }
      .net-gap ul { margin:0; padding:0; list-style:none; font-size:12.5px; }
      .net-gap li { display:flex; justify-content:space-between; gap:8px; padding:4px 0; border-bottom:1px solid var(--card-border); }
      .net-gap li:last-child { border-bottom:0; }
      .net-gap li .n { font-family:var(--font-mono); font-variant-numeric:tabular-nums; color:var(--text-secondary); white-space:nowrap; }
      .net-gap .none { color:var(--muted); font-size:12.5px; }
      @media (max-width: 900px) {
        .net-charts, .net-gaps { grid-template-columns:minmax(0, 1fr); }
        .net-kpi .value { font-size:19px; }
      }
    </style>
    <div class="net-head">
      <div>
        <h2 class="set-title">Network</h2>
        <p class="set-lead">Live state of every coordinator: agents and their accounts, load, latency, models and gaps.</p>
      </div>
      <div class="net-controls">
        <div class="net-seg" role="group" aria-label="Chart range">
          <button type="button" data-range="1h" aria-pressed="true">1 h</button><button type="button" data-range="6h" aria-pressed="false">6 h</button><button type="button" data-range="24h" aria-pressed="false">24 h</button>
        </div>
        <span class="net-updated" id="netUpdated">Loading...</span>
      </div>
    </div>
    <div id="netDenied" class="callout warn hidden"><h3>Admin access required</h3><div class="muted">This section is only available to system administrators.</div></div>
    <div id="netError" class="callout warn hidden"></div>
    <div id="netBody" class="hidden">
      <div class="net-kpis" id="netKpis">
        <div class="net-kpi"><div class="label">Agents online</div><div class="value" id="kpiOnline">-</div><div class="sub" id="kpiOnlineSub"></div></div>
        <div class="net-kpi"><div class="label">Busy</div><div class="value" id="kpiBusy">-</div><div class="sub" id="kpiBusySub"></div></div>
        <div class="net-kpi"><div class="label">Free slots</div><div class="value" id="kpiFree">-</div><div class="sub" id="kpiFreeSub"></div></div>
        <div class="net-kpi"><div class="label">Queued</div><div class="value" id="kpiQueued">-</div><div class="sub" id="kpiQueuedSub"></div></div>
        <div class="net-kpi"><div class="label">Pickup p90</div><div class="value" id="kpiPickup">-</div><div class="sub" id="kpiPickupSub"></div></div>
        <div class="net-kpi"><div class="label">TTFT p90</div><div class="value" id="kpiTtft">-</div><div class="sub" id="kpiTtftSub"></div></div>
        <div class="net-kpi"><div class="label">Calls / min</div><div class="value" id="kpiCalls">-</div><div class="sub" id="kpiCallsSub"></div></div>
      </div>
      <div class="net-coords" id="netCoords" aria-label="Coordinators"></div>
      <div class="net-charts">
        <div class="net-chart" id="chartUtil"><h3>Utilization</h3><div class="hint">Model slots in use, % of all slots on live agents</div><div class="net-legend"></div></div>
        <div class="net-chart" id="chartLoad"><h3>Load</h3><div class="hint">Jobs on the queue and model calls waiting for an agent</div><div class="net-legend"></div></div>
        <div class="net-chart" id="chartCalls"><h3>Throughput</h3><div class="hint">Model calls per minute</div><div class="net-legend"></div></div>
        <div class="net-chart" id="chartLatency"><h3>Latency</h3><div class="hint">Pickup (claimable to claimed) and TTFT (submit to first piece), ms</div><div class="net-legend"></div></div>
      </div>
      <div class="net-card">
        <h3>Agents</h3>
        <div class="net-filter">
          <input id="agentFilter" type="search" placeholder="Filter by agent, email, model, region" aria-label="Filter agents" autocomplete="off" />
          <select id="agentStatus" aria-label="Status"><option value="">Any status</option><option value="idle">Idle</option><option value="busy">Busy</option><option value="stale">Stale</option><option value="blacklisted">Blacklisted</option></select>
          <select id="agentCoord" aria-label="Coordinator"><option value="">Any coordinator</option></select>
        </div>
        <div class="net-table-wrap">
          <table id="agentsTable"><thead><tr>
            <th data-sort="agentId">Agent</th><th data-sort="email">Account</th><th data-sort="coordinator">Coordinator</th><th data-sort="countryCode">Region</th>
            <th data-sort="computeClass">Class / tier</th><th data-sort="models">Models</th><th class="num" data-sort="used">Slots used</th>
            <th class="num" data-sort="lastSeenMs">Last seen</th><th data-sort="status">Status</th>
          </tr></thead><tbody id="agentsBody"></tbody></table>
        </div>
        <div class="muted" id="agentsCount"></div>
      </div>
      <div class="net-card">
        <h3>Models in use</h3>
        <div class="net-table-wrap">
          <table><thead><tr><th>Model</th><th class="num">Agents</th><th class="num">Idle</th><th class="num">Free slots</th><th class="num">Waiting</th><th class="num">Calls (15 min)</th><th class="num">Calls (24 h)</th><th class="num">Refused / no capacity (24 h)</th></tr></thead><tbody id="modelsBody"></tbody></table>
        </div>
      </div>
      <div class="net-card">
        <h3>Gaps</h3>
        <div class="net-gaps">
          <div class="net-gap"><h4>Requested with no capacity (1 h)</h4><ul id="gapMissing"></ul></div>
          <div class="net-gap"><h4>Saturated models (no free slot)</h4><ul id="gapSaturated"></ul></div>
          <div class="net-gap"><h4>Stale agents (not seen for 2 min)</h4><ul id="gapStale"></ul></div>
          <div class="net-gap"><h4>Coordinators and regions</h4><ul id="gapCoverage"></ul></div>
        </div>
      </div>
    </div>`;
}

export function networkPageScript(): string {
  return `
    ${SETTINGS_HELPERS_SCRIPT}
    const REFRESH_MS = ${NETWORK_REFRESH_MS};
    const SVGNS = "http://www.w3.org/2000/svg";
    let range = "1h";
    let data = null;
    let timer = null;
    let sortKey = "lastSeenMs";
    let sortDir = -1;
    function $(id) { return document.getElementById(id); }
    function svg(tag, attrs) { const e = document.createElementNS(SVGNS, tag); for (const k in (attrs || {})) e.setAttribute(k, attrs[k]); return e; }
    function fmtMs(ms) { if (ms === null || ms === undefined) return "-"; ms = Number(ms); return ms >= 10000 ? (ms / 1000).toFixed(1) + " s" : ms >= 1000 ? (ms / 1000).toFixed(2) + " s" : Math.round(ms) + " ms"; }
    function ago(ms) { if (!ms) return "never"; const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? s + " s ago" : s < 3600 ? Math.floor(s / 60) + " min ago" : s < 86400 ? Math.floor(s / 3600) + " h ago" : Math.floor(s / 86400) + " d ago"; }
    function clock(ms) { return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
    function plural(n, word) { return fmtNum(n, 0) + " " + word + (Number(n) === 1 ? "" : "s"); }
    function setText(id, text) { $(id).textContent = text; }
    function showError(text) { const e = $("netError"); e.textContent = text; e.classList.remove("hidden"); }
    const STATUS_TONE = { idle: "ok", busy: "info", stale: "warn", blacklisted: "danger" };
    function badge(text, tone) { return el("span", { class: "status-badge " + (tone || "") }, text); }

    // ── Charts: one y-axis each, 2px lines, crosshair and tooltip on hover ──
    function niceMax(v) { if (!(v > 0)) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 2, 4, 6, 8, 10]) if (m * p >= v) return m * p; return 10 * p; }
    function legendSwatch(cls, dashed) { const s = svg("svg", { width: "16", height: "8", "aria-hidden": "true" }); s.appendChild(svg("line", { x1: "1", y1: "4", x2: "15", y2: "4", class: "line " + cls + (dashed ? " dash" : "") })); return s; }
    function drawChart(id, points, series, opts) {
      const box = $(id);
      const legend = box.querySelector(".net-legend");
      legend.textContent = "";
      if (series.length > 1) for (const s of series) { const item = el("span"); item.appendChild(legendSwatch(s.cls, s.dashed)); item.appendChild(document.createTextNode(s.label)); legend.appendChild(item); }
      const old = box.querySelector("svg.plot"); if (old) old.remove();
      const oldTip = box.querySelector(".net-tip"); if (oldTip) oldTip.remove();
      // The viewBox is the drawn size, so text is never stretched; redrawn on resize.
      const W = Math.max(240, Math.round(box.clientWidth - 24)), H = 170, L = 44, R = 8, T = 8, B = 20;
      const plot = svg("svg", { class: "plot", viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": box.querySelector("h3").textContent });
      box.appendChild(plot);
      const vals = [];
      for (const p of points) for (const s of series) { const v = s.value(p); if (v !== null && v !== undefined && isFinite(v)) vals.push(v); }
      if (!points.length || !vals.length) {
        const t = svg("text", { x: String(W / 2), y: String(H / 2), "text-anchor": "middle", class: "empty" }); t.textContent = points.length ? "Nothing measured in this range yet" : "Collecting samples (one every 15 s)"; plot.appendChild(t);
        return;
      }
      const ymax = opts.max || niceMax(Math.max.apply(null, vals));
      const t0 = Date.now() - ({ "1h": 3600e3, "6h": 21600e3, "24h": 86400e3 })[range];
      const t1 = Date.now();
      const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
      const y = (v) => T + (1 - v / ymax) * (H - T - B);
      for (let i = 0; i <= 4; i++) {
        const v = (ymax / 4) * i;
        plot.appendChild(svg("line", { x1: String(L), x2: String(W - R), y1: String(y(v)), y2: String(y(v)), class: "grid" }));
        const lab = svg("text", { x: String(L - 6), y: String(y(v) + 3), "text-anchor": "end", class: "axis" }); lab.textContent = opts.fmt(v, true); plot.appendChild(lab);
      }
      const xt = W < 480 ? 2 : 4;
      for (let i = 0; i <= xt; i++) {
        const t = t0 + ((t1 - t0) / xt) * i;
        const lab = svg("text", { x: String(x(t)), y: String(H - 4), "text-anchor": i === 0 ? "start" : i === xt ? "end" : "middle", class: "axis" }); lab.textContent = clock(t); plot.appendChild(lab);
      }
      const gap = (data && data.series && data.series.bucketMs) ? data.series.bucketMs * 2.5 : 60000;
      for (const s of series) {
        let d = "", prevT = null, area = "", runStart = null, lastX = null;
        for (const p of points) {
          const v = s.value(p);
          if (v === null || v === undefined || !isFinite(v)) { prevT = null; continue; }
          const px = x(p.atMs).toFixed(1), py = y(v).toFixed(1);
          const join = prevT !== null && p.atMs - prevT <= gap;
          d += (join ? " L" : " M") + px + " " + py;
          if (s.area) { if (!join) { if (runStart !== null) area += " L" + lastX + " " + y(0) + " Z"; area += " M" + px + " " + y(0) + " L" + px + " " + py; runStart = px; } else area += " L" + px + " " + py; lastX = px; }
          prevT = p.atMs;
        }
        if (s.area && runStart !== null) { area += " L" + lastX + " " + y(0) + " Z"; plot.appendChild(svg("path", { d: area, class: "area a-brand" })); }
        plot.appendChild(svg("path", { d: d.trim(), class: "line " + s.cls + (s.dashed ? " dash" : "") }));
      }
      // Hover layer.
      const cross = svg("line", { y1: String(T), y2: String(H - B), class: "cross hidden" });
      plot.appendChild(cross);
      const dots = series.map((s) => { const c = svg("circle", { r: "4", class: "hdot hidden f-" + s.cls.replace("s-", "") }); plot.appendChild(c); return c; });
      const tip = el("div", { class: "net-tip hidden" }); box.appendChild(tip);
      const hit = svg("rect", { x: String(L), y: String(T), width: String(W - L - R), height: String(H - T - B), fill: "transparent" });
      plot.appendChild(hit);
      function hide() { cross.classList.add("hidden"); tip.classList.add("hidden"); for (const c of dots) c.classList.add("hidden"); }
      hit.addEventListener("mouseleave", hide);
      hit.addEventListener("mousemove", (ev) => {
        const rect = plot.getBoundingClientRect();
        const vx = ((ev.clientX - rect.left) / rect.width) * W;
        let best = null, bestD = Infinity;
        for (const p of points) { const dd = Math.abs(x(p.atMs) - vx); if (dd < bestD) { bestD = dd; best = p; } }
        if (!best) return hide();
        const bx = x(best.atMs);
        cross.setAttribute("x1", String(bx)); cross.setAttribute("x2", String(bx)); cross.classList.remove("hidden");
        tip.textContent = "";
        tip.appendChild(el("div", { class: "t" }, new Date(best.atMs).toLocaleString([], { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" })));
        series.forEach((s, i) => {
          const v = s.value(best);
          const row = el("div"); row.appendChild(legendSwatch(s.cls, s.dashed)); row.appendChild(document.createTextNode(" " + s.label + " ")); row.appendChild(el("span", { class: "v" }, v === null || v === undefined || !isFinite(v) ? "-" : opts.fmt(v)));
          tip.appendChild(row);
          if (v === null || v === undefined || !isFinite(v)) dots[i].classList.add("hidden"); else { dots[i].setAttribute("cx", String(bx)); dots[i].setAttribute("cy", String(y(v))); dots[i].classList.remove("hidden"); }
        });
        tip.classList.remove("hidden");
        const boxRect = box.getBoundingClientRect();
        let left = ev.clientX - boxRect.left + 12;
        if (left + tip.offsetWidth > boxRect.width - 4) left = ev.clientX - boxRect.left - tip.offsetWidth - 12;
        tip.style.left = Math.max(4, left) + "px";
        tip.style.top = (rect.top - boxRect.top + 8) + "px";
      });
    }
    function drawCharts() {
      const pts = (data.series && data.series.points) || [];
      const perMin = 60000 / ((data.series && data.series.bucketMs) || 15000);
      const n = (v) => (v === null || v === undefined ? null : Number(v));
      drawChart("chartUtil", pts, [
        { label: "Utilization", cls: "s-brand", area: true, value: (p) => (p.totalSlots > 0 ? (100 * (p.totalSlots - p.freeSlots)) / p.totalSlots : null) }
      ], { max: 100, fmt: (v) => Math.round(v) + "%" });
      drawChart("chartLoad", pts, [
        { label: "Queued", cls: "s-brand", value: (p) => n(p.queued) },
        { label: "Waiting for an agent", cls: "s-info", value: (p) => n(p.waitingInference) }
      ], { fmt: (v) => fmtNum(v, 1) });
      drawChart("chartCalls", pts, [
        { label: "Started", cls: "s-brand", value: (p) => n(p.started) * perMin },
        { label: "Completed", cls: "s-info", value: (p) => n(p.completed) * perMin }
      ], { fmt: (v) => fmtNum(v, 1) });
      drawChart("chartLatency", pts, [
        { label: "Pickup p90", cls: "s-brand", value: (p) => n(p.pickupP90) },
        { label: "Pickup p50", cls: "s-brand", dashed: true, value: (p) => n(p.pickupP50) },
        { label: "TTFT p90", cls: "s-info", value: (p) => n(p.ttftP90) },
        { label: "TTFT p50", cls: "s-info", dashed: true, value: (p) => n(p.ttftP50) }
      ], { fmt: (v, axis) => (axis && v >= 1000 ? (v / 1000) + " s" : fmtMs(v)) });
    }

    // ── Tables and panels ──
    function renderKpis() {
      const k = data.kpis, l = data.latency;
      setText("kpiOnline", fmtNum(k.agentsOnline, 0)); setText("kpiOnlineSub", fmtNum(data.agents.length, 0) + " known");
      setText("kpiBusy", fmtNum(k.agentsBusy, 0)); setText("kpiBusySub", k.agentsOnline ? Math.round((100 * k.agentsBusy) / k.agentsOnline) + "% of online" : "");
      setText("kpiFree", fmtNum(k.freeSlots, 0)); setText("kpiFreeSub", "of " + fmtNum(k.totalSlots, 0) + " slots");
      setText("kpiQueued", fmtNum(k.queued, 0)); setText("kpiQueuedSub", plural(k.waitingInference, "call") + " waiting");
      setText("kpiPickup", fmtMs(k.pickupP90)); setText("kpiPickupSub", "p50 " + fmtMs(l.pickup.p50));
      setText("kpiTtft", l.ttft.count ? fmtMs(k.ttftP90) : "-"); setText("kpiTtftSub", l.ttft.count ? "p50 " + fmtMs(l.ttft.p50) + " · " + l.ttft.count + " calls" : "no calls in 15 min");
      setText("kpiCalls", fmtNum(k.callsPerMin, 1)); setText("kpiCallsSub", fmtNum(k.completedPerMin, 1) + " completed");
    }
    function renderCoordinators() {
      const box = $("netCoords"); box.textContent = "";
      const sel = $("agentCoord"); const keep = sel.value; sel.textContent = ""; sel.appendChild(el("option", { value: "" }, "Any coordinator"));
      for (const c of data.coordinators) {
        const name = c.url.replace(/^https?:\\/\\//, "");
        const chip = el("div", { class: "net-coord" });
        chip.appendChild(el("span", { class: "dot " + (c.ok ? "green" : "red") }));
        chip.appendChild(el("span", {}, name + (c.region ? " (" + c.region + ")" : "")));
        chip.appendChild(el("span", { class: "mono" }, c.ok ? fmtNum(data.agents.filter((a) => a.coordinator === name && a.connected).length, 0) + " online · q " + c.queue.queued : (c.error || "unreachable")));
        box.appendChild(chip);
        if (c.ok) sel.appendChild(el("option", { value: name }, name));
      }
      sel.value = keep;
    }
    function agentRowValue(a, key) {
      if (key === "models") return (a.modelsInstalled || []).length;
      if (key === "used") return a.slots - a.freeSlots;
      if (key === "email") return a.email || "";
      return a[key] === null || a[key] === undefined ? "" : a[key];
    }
    function renderAgents() {
      const q = $("agentFilter").value.trim().toLowerCase();
      const st = $("agentStatus").value;
      const co = $("agentCoord").value;
      const rows = data.agents.filter((a) => (!st || a.status === st) && (!co || a.coordinator === co) && (!q || [a.agentId, a.email, a.accountId, a.countryCode, a.coordinator, a.computeClass, a.os, a.clientType].concat(a.modelsInstalled || []).some((v) => v && String(v).toLowerCase().includes(q))));
      rows.sort((a, b) => { const x = agentRowValue(a, sortKey), y = agentRowValue(b, sortKey); return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sortDir; });
      const body = $("agentsBody"); body.textContent = "";
      for (const a of rows) {
        const tr = el("tr");
        const idCell = el("td"); idCell.appendChild(el("div", { class: "mono nowrap" }, a.agentId)); idCell.appendChild(el("div", { class: "muted" }, [a.os, a.clientType, a.version ? "v" + a.version : ""].filter(Boolean).join(" · "))); tr.appendChild(idCell);
        const acct = el("td"); acct.appendChild(el("div", { class: "nowrap" }, a.email || "-")); acct.appendChild(el("div", { class: "muted mono" }, a.accountId || "not linked")); tr.appendChild(acct);
        const co = el("td", { class: "nowrap", title: a.coordinator }, a.coordinator.split(".")[0] + (a.coordinatorRegion ? " · " + a.coordinatorRegion : "")); tr.appendChild(co);
        tr.appendChild(el("td", {}, (a.countryCode || "-") + (a.vpnDetected ? " (VPN)" : "")));
        const cls = el("td"); cls.appendChild(el("div", {}, classLabel(a.computeClass || "-") + (a.tier ? " · " + a.tier : ""))); cls.appendChild(el("div", { class: "muted" }, a.verification ? "hw " + a.verification : "hw unverified")); tr.appendChild(cls);
        const models = el("td", { class: "net-models-list" }, (a.modelsInstalled || []).join(", ") || "-"); if (a.activeModel && (a.modelsInstalled || []).indexOf(a.activeModel) < 0) models.appendChild(el("div", { class: "muted" }, "active: " + a.activeModel)); tr.appendChild(models);
        const used = el("td", { class: "num nowrap" }, a.connected && !a.blacklisted ? (a.slots - a.freeSlots) + " / " + a.slots : "- / " + a.slots); if (a.contextWindow) used.appendChild(el("div", { class: "muted" }, fmtNum(a.contextWindow, 0) + " ctx")); tr.appendChild(used);
        tr.appendChild(el("td", { class: "num nowrap" }, ago(a.lastSeenMs)));
        const s = el("td"); s.appendChild(badge(a.status, STATUS_TONE[a.status])); if (a.status !== "stale" && a.status !== "blacklisted") s.appendChild(el("div", { class: "muted" }, a.socketConnected ? "socket open" : "polling")); if (a.blacklistReason) s.appendChild(el("div", { class: "muted" }, a.blacklistReason)); if (a.reserved) s.appendChild(el("div", { class: "muted" }, "reserved")); tr.appendChild(s);
        body.appendChild(tr);
      }
      if (!rows.length) { const tr = el("tr"); tr.appendChild(el("td", { colspan: "9" }, data.agents.length ? "No agent matches the filter." : "No agents are registered.")); body.appendChild(tr); }
      setText("agentsCount", rows.length + " of " + data.agents.length + " agents");
      for (const th of document.querySelectorAll("#agentsTable th[data-sort]")) th.setAttribute("aria-sort", th.dataset.sort === sortKey ? (sortDir > 0 ? "ascending" : "descending") : "none");
    }
    function renderModels() {
      const body = $("modelsBody"); body.textContent = "";
      for (const m of data.models) {
        const tr = el("tr");
        tr.appendChild(el("td", { class: "mono" }, m.model));
        for (const v of [m.agents, m.idleAgents, m.freeSlots, m.waiting, m.callsWindow, m.calls24h]) tr.appendChild(el("td", { class: "num" }, fmtNum(v, 0)));
        tr.appendChild(el("td", { class: "num" }, fmtNum(m.noAgentHasModel24h, 0) + " / " + fmtNum(m.noCapacity24h, 0)));
        body.appendChild(tr);
      }
      if (!data.models.length) { const tr = el("tr"); tr.appendChild(el("td", { colspan: "8" }, "No models reported or requested.")); body.appendChild(tr); }
    }
    function list(id, items, empty) {
      const ul = $(id); ul.textContent = "";
      for (const [label, n] of items) { const li = el("li"); li.appendChild(el("span", {}, label)); li.appendChild(el("span", { class: "n" }, n)); ul.appendChild(li); }
      if (!items.length) ul.appendChild(el("li", { class: "none" }, empty));
    }
    function renderGaps() {
      const g = data.gaps;
      list("gapMissing", g.missingModels.map((m) => [m.model + (m.holders ? "" : " (no holder)"), m.noAgentHasModel + " refused · " + m.noCapacity + " no capacity"]), "None in the last hour.");
      list("gapSaturated", g.saturatedModels.map((m) => [m.model, plural(m.agents, "agent") + " · " + m.waiting + " waiting"]), "Every model has a free slot.");
      list("gapStale", g.staleAgents.slice(0, 12).map((a) => [a.agentId + (a.email ? " (" + a.email + ")" : ""), ago(a.lastSeenMs)]), "No stale agents.");
      const cov = [];
      for (const u of g.unreachableCoordinators) cov.push([u.replace(/^https?:\\/\\//, ""), "unreachable"]);
      for (const c of g.thinCoordinators) cov.push([c.coordinator + (c.region ? " (" + c.region + ")" : ""), plural(c.connected, "agent") + " online"]);
      for (const r of g.regions) cov.push(["Region " + r.country, plural(r.agents, "agent") + " online"]);
      list("gapCoverage", cov, "No coordinator data.");
    }
    function render() {
      $("netError").classList.add("hidden");
      $("netBody").classList.remove("hidden");
      renderKpis(); renderCoordinators(); renderAgents(); renderModels(); renderGaps(); drawCharts();
      const down = data.coordinators.filter((c) => !c.ok).length;
      setText("netUpdated", "Updated " + new Date(data.generatedAtMs).toLocaleTimeString() + " · every " + (REFRESH_MS / 1000) + " s" + (down ? " · " + down + " coordinator(s) not answering" : ""));
    }
    async function load() {
      const r = await call("/portal/api/admin/network?range=" + range, { method: "GET", headers: {} });
      if (r.status === 403 || r.status === 401) { $("netDenied").classList.remove("hidden"); stop(); return; }
      if (!r.ok) { showError("Could not load the network: " + (r.json.detail || r.json.error || r.status)); return; }
      data = r.json;
      render();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }
    function start() { stop(); timer = setInterval(() => { if (!document.hidden) load().catch(() => undefined); }, REFRESH_MS); }
    window.__renderNetwork = (json) => { data = json; render(); };
    for (const b of document.querySelectorAll(".net-seg button")) b.addEventListener("click", () => {
      range = b.dataset.range;
      for (const o of document.querySelectorAll(".net-seg button")) o.setAttribute("aria-pressed", String(o === b));
      load().catch(() => undefined);
    });
    for (const th of document.querySelectorAll("#agentsTable th[data-sort]")) th.addEventListener("click", () => {
      if (sortKey === th.dataset.sort) sortDir = -sortDir; else { sortKey = th.dataset.sort; sortDir = sortKey === "lastSeenMs" || sortKey === "used" || sortKey === "models" ? -1 : 1; }
      if (data) renderAgents();
    });
    for (const id of ["agentFilter", "agentStatus", "agentCoord"]) $(id).addEventListener("input", () => data && renderAgents());
    document.addEventListener("visibilitychange", () => { if (!document.hidden && timer) load().catch(() => undefined); });
    window.addEventListener("resize", () => data && drawCharts());
    (async () => {
      const me = await requireAuth();
      revealSettingsAdminTab(me);
      const user = me.user || {};
      if (!(user.roles && user.roles.isSystemAdmin)) { $("netDenied").classList.remove("hidden"); setText("netUpdated", ""); return; }
      await load();
      start();
    })().catch((err) => showError("Could not load the network: " + String(err.message || err)));
    `;
}

export function registerSettingsNetworkPage(app: FastifyInstance): void {
  app.get("/portal/settings/network", async (_req, reply) => {
    return reply.type("text/html").send(settingsPage("network", "Live state of the network.", networkPageContent(), networkPageScript(), { wide: true }));
  });
}
