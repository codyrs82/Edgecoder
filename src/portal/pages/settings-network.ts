// Copyright (c) 2025 EdgeCoder
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
 * The Alerts card (src/portal/alerts.ts) lists active incidents from the portal and every
 * coordinator, the recent history, an Acknowledge button per incident and "Send test alert".
 *
 * Charts are inline SVG drawn by the script (no library): colors come from the theme tokens
 * through CSS classes, so light and dark follow the theme toggle.
 */
export const NETWORK_REFRESH_MS = 15_000;

/** Chart ranges (the coordinator's SERIES_RANGES), in ms. */
export const NETWORK_RANGES_MS = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000 } as const;

/**
 * Page-script helper (plain JS, tested on its own): the spans of [t0, t1] with no samples, where a
 * coordinator was down or had not started. Points are bucket starts, oldest first; a jump of more
 * than 2.5 buckets between them is a gap, and so is the time before the first point and after the
 * last one. The chart shades these and breaks its lines there instead of drawing zeros.
 */
export const SERIES_GAPS_SCRIPT = `
    function seriesGaps(points, bucketMs, t0, t1) {
      const limit = bucketMs * 2.5;
      const gaps = [];
      // prevEnd: covered up to here. Between points this matches the chart's line break (start to
      // start more than 2.5 buckets apart).
      let prevEnd = t0;
      for (const p of points) {
        if (p.atMs + bucketMs <= t0) continue;
        if (p.atMs - prevEnd > limit - bucketMs) gaps.push({ fromMs: prevEnd, toMs: p.atMs });
        prevEnd = Math.max(prevEnd, p.atMs + bucketMs);
      }
      if (t1 - prevEnd > limit) gaps.push({ fromMs: prevEnd, toMs: t1 });
      return gaps;
    }
`;

/**
 * Page-script helpers for the Gaps charts (PR 340; plain JS, tested on their own). The series carry
 * keyed maps per point (unmetByModel, modelSlots, agentsByRegion); a chart shows the GAP_KEYS keys
 * largest over the range, in the categorical slots c1..c4 (--chart-1..4), and folds the rest into "Other".
 *
 * - topKeys: the largest keys over the points (the coordinators' "(other)" is never one of them).
 * - assignSlots: a color slot per key that stays with the key across refreshes and ranges (color
 *   follows the entity, not its rank); a key that drops out frees its slot.
 * - keyedSeries: chart series for those keys, plus "Other" when anything else is in the maps.
 * - gapSummaries: the one-line current state under each chart, from the snapshot's gaps.
 */
export const GAP_CHARTS_SCRIPT = `
    const GAP_KEYS = 4;
    const OTHER_KEY = "(other)";
    function topKeys(points, field, size, n) {
      const tot = {};
      for (const p of points) { const m = p[field]; if (!m) continue; for (const k in m) tot[k] = (tot[k] || 0) + size(m[k]); }
      const named = Object.keys(tot).filter((k) => k !== OTHER_KEY).sort((a, b) => tot[b] - tot[a] || (a < b ? -1 : 1));
      return { keys: named.slice(0, n), rest: named.length > n || OTHER_KEY in tot };
    }
    const slotMemo = {};
    function assignSlots(chartId, keys) {
      const memo = slotMemo[chartId] || (slotMemo[chartId] = {});
      for (const k of Object.keys(memo)) if (keys.indexOf(k) < 0) delete memo[k];
      const used = Object.values(memo);
      for (const k of keys) {
        if (memo[k]) continue;
        for (let i = 1; i <= GAP_KEYS; i++) if (used.indexOf(i) < 0) { memo[k] = i; used.push(i); break; }
      }
      return memo;
    }
    function keyedSeries(chartId, points, field, size, pick, withOther) {
      const top = topKeys(points, field, size, GAP_KEYS);
      const slots = assignSlots(chartId, top.keys);
      const keys = top.keys.slice().sort((a, b) => slots[a] - slots[b]);
      const out = keys.map((k) => ({ key: k, label: k, cls: "s-c" + slots[k], value: (p) => (p[field] ? pick(p[field][k]) : null) }));
      if (withOther && top.rest) out.push({ key: OTHER_KEY, label: "Other", cls: "s-other", value: (p) => { const m = p[field]; if (!m) return null; let t = 0; for (const k in m) if (keys.indexOf(k) < 0) t += pick(m[k]); return t; } });
      return out;
    }
    function gapAgo(ms, nowMs) { const s = Math.max(0, Math.round((nowMs - ms) / 1000)); return s < 60 ? s + " s ago" : s < 3600 ? Math.floor(s / 60) + " min ago" : s < 86400 ? Math.floor(s / 3600) + " h ago" : Math.floor(s / 86400) + " d ago"; }
    function gapSummaries(d, nowMs) {
      const g = d.gaps || {};
      const n = (v, w) => v + " " + w + (v === 1 ? "" : "s");
      const more = (list, shown) => (list.length > shown ? " and " + (list.length - shown) + " more" : "");
      const missing = g.missingModels || [];
      const unmet = missing.length
        ? "Last hour: " + missing.slice(0, 3).map((m) => m.model + " " + [m.noAgentHasModel ? m.noAgentHasModel + " refused (no agent has it)" : "", m.noCapacity ? m.noCapacity + " cancelled (no free slot)" : ""].filter(Boolean).join(", ")).join(" · ") + more(missing, 3) + "."
        : "None in the last hour.";
      const sat = g.saturatedModels || [];
      const saturation = sat.length
        ? "Saturated now: " + sat.slice(0, 4).map((m) => m.model + " (" + n(m.agents, "agent") + (m.waiting ? ", " + m.waiting + " waiting" : "") + ")").join(", ") + more(sat, 4) + "."
        : "Every model has a free slot.";
      // Agents out of memory (pressure, paused) or cooling down after failures: no capacity until they recover.
      const mem = g.memoryLimitedAgents || [];
      const memoryNote = mem.length
        ? " " + n(mem.length, "agent") + " memory-limited now: " + mem.slice(0, 3).map((a) => a.agentId + " (" + (a.circuitOpen ? "cooling down" : (a.pressure || "paused") + " pressure") + ")").join(", ") + more(mem, 3) + "."
        : "";
      const st = g.staleAgents || [];
      const stale = st.length
        ? st.length + " stale now: " + st.slice(0, 3).map((a) => a.agentId + " (" + gapAgo(a.lastSeenMs, nowMs) + ")").join(", ") + more(st, 3) + "."
        : "No stale agents.";
      const regs = g.regions || [];
      const reported = regs.reduce((a, r) => a + (r.reported || 0), 0);
      let regions = regs.length
        ? "Online now: " + regs.map((r) => r.region + " " + r.agents).join(" · ") + ". " + (reported ? reported + " reported their own region; the rest" : "Agents report no region of their own, so they") + " count under their coordinator's."
        : "No agents online.";
      const thin = g.thinCoordinators || [];
      if (thin.length) regions += " Few agents: " + thin.map((c) => c.connected + " on " + c.coordinator.split(".")[0] + (c.region ? " (" + c.region + ")" : "")).join(", ") + ".";
      const down = g.unreachableCoordinators || [];
      if (down.length) regions += " Not answering: " + down.map((u) => u.replace(/^https?:\\/\\//, "")).join(", ") + ".";
      return { unmet, saturation: saturation + memoryNote, stale, regions };
    }
`;

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
      .net-chart .gapband { fill:var(--muted); opacity:0.12; }
      .net-chart .gaplabel { fill:var(--muted); font-size:10px; }
      .net-tip { position:absolute; pointer-events:none; z-index:5; background:var(--bg-elevated); border:1px solid var(--card-border); border-radius:var(--radius-sm); box-shadow:var(--shadow-2); padding:6px 8px; font-size:11.5px; line-height:1.45; white-space:nowrap; font-variant-numeric:tabular-nums; }
      .net-tip .t { color:var(--muted); margin-bottom:2px; }
      .net-tip .v { font-family:var(--font-mono); color:var(--text); }
      .net-alerts-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-content:space-between; }
      .net-alerts-head h3 { margin:0; }
      .net-alerts-sources { font-size:12px; color:var(--text-secondary); margin:6px 0 10px; line-height:1.5; }
      .net-alerts-empty { font-size:13px; color:var(--text-secondary); padding:6px 0; }
      .net-alert-sev { font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:0.04em; }
      .net-alerts details summary { cursor:pointer; font-size:13px; font-weight:600; margin-top:10px; }
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
      /* Gaps charts: the shared categorical chart tokens (--chart-1..4, light and dark in
         @edgecoder/tokens), taken in order; "Other" is neutral ink. */
      .s-c1 { stroke:var(--chart-1); } .f-c1 { fill:var(--chart-1); } .a-c1 { fill:var(--chart-1); opacity:0.3; }
      .s-c2 { stroke:var(--chart-2); } .f-c2 { fill:var(--chart-2); } .a-c2 { fill:var(--chart-2); opacity:0.3; }
      .s-c3 { stroke:var(--chart-3); } .f-c3 { fill:var(--chart-3); } .a-c3 { fill:var(--chart-3); opacity:0.3; }
      .s-c4 { stroke:var(--chart-4); } .f-c4 { fill:var(--chart-4); } .a-c4 { fill:var(--chart-4); opacity:0.3; }
      .s-other { stroke:var(--text-muted); } .f-other { fill:var(--text-muted); } .a-other { fill:var(--text-muted); opacity:0.22; }
      .net-section-head { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin:0 0 8px; }
      .net-section-head h3 { font-size:13px; font-weight:600; margin:0; }
      .net-section-head .hint { font-size:11.5px; color:var(--muted); }
      .net-chart .net-sum { font-size:12px; color:var(--text-secondary); margin:6px 0 0; line-height:1.45; }
      .net-ble summary { cursor:pointer; display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; list-style:none; }
      .net-ble summary h3 { margin:0; }
      .net-ble ul { margin:10px 0 0; padding-left:18px; color:var(--text-secondary); font-size:13px; line-height:1.6; }
      .net-ble li { margin-bottom:6px; }
      .net-ble a { color:var(--brand-2); }
      @media (max-width: 900px) {
        .net-charts { grid-template-columns:minmax(0, 1fr); }
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
          <button type="button" data-range="1h" aria-pressed="true">1 h</button><button type="button" data-range="6h" aria-pressed="false">6 h</button><button type="button" data-range="24h" aria-pressed="false">24 h</button><button type="button" data-range="7d" aria-pressed="false">7 d</button>
        </div>
        <span class="net-updated" id="netUpdated">Loading...</span>
      </div>
    </div>
    <div id="netDenied" class="callout warn hidden"><h3>Admin access required</h3><div class="muted">This section is only available to system administrators.</div></div>
    <div id="netError" class="callout warn hidden"></div>
    <div class="net-card net-alerts hidden" id="alerts">
      <div class="net-alerts-head">
        <h3>Alerts</h3>
        <div><button type="button" class="btn-secondary" id="alertTestBtn">Send test alert</button></div>
      </div>
      <div class="net-alerts-sources" id="alertSources"></div>
      <div class="muted" id="alertStatus" role="status"></div>
      <div class="net-table-wrap">
        <table><thead><tr><th>Severity</th><th>Alert</th><th>What is wrong</th><th class="num">Since</th><th>Seen by</th><th></th></tr></thead><tbody id="alertsBody"></tbody></table>
      </div>
      <details id="alertHistory">
        <summary>History</summary>
        <div class="net-table-wrap">
          <table><thead><tr><th class="num">When</th><th>Event</th><th>Alert</th><th>Seen by</th></tr></thead><tbody id="alertHistoryBody"></tbody></table>
        </div>
      </details>
    </div>
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
      <details class="net-card net-ble" id="netBle">
        <summary><h3>Bluetooth mesh</h3><span class="hint">Not in this view: Bluetooth work is offline, peer to peer. What it is and how it reaches the ledger.</span></summary>
        <ul>
          <li><b>Purpose.</b> When an agent can't reach any coordinator, it can send a model prompt to a nearby EdgeCoder device over Bluetooth LE and get the answer back. The internet path is always preferred. macOS (desktop app and agent) and iOS only.</li>
          <li><b>Not reported live.</b> Coordinators never see Bluetooth peers or jobs as they happen, so the agents table and charts above don't include them. They show up only when the signed payment records are settled.</li>
          <li><b>Settlement.</b> Both devices sign a credit record (CPU seconds × a model-size multiplier, 0.3 to 1.0) and keep it in an offline ledger. When one is back online it posts the records to <code>POST /credits/ble-sync</code>. The coordinator verifies both Ed25519 signatures against the registered keys and accounts, skips duplicates, caps each record at <code>BLE_SYNC_MAX_CREDITS_PER_TX</code> (default 100), and moves the credits with reason <code>ble_compute</code>. Records that can't settle yet (low balance, account mismatch) stay pending on the device and are retried.</li>
          <li><b>Admission (Macs).</b> A Mac refuses all incoming Bluetooth work unless <code>MESH_AUTH_TOKEN</code> is set on the agent; coordinators no longer hand out the mesh token (security pull request 288). With it, requests need an HMAC proof, are replay-protected within 2 minutes, limited to 64 KiB and rate-limited per sender. Bluetooth jobs are model prompts only: no code runs.</li>
          <li><b>Known gaps.</b> No link encryption or pairing (prompts travel in plain text); iOS providers don't authenticate requesters yet and iOS requests are refused by Macs; Macs don't yet originate Bluetooth work; Macs advertise model size 0 and so earn the 0.3 multiplier.</li>
          <li><b>Switches.</b> Desktop: Settings &gt; General &gt; Bluetooth mesh (on by default). Agent: <code>EDGECODER_BLE=0</code> turns it off. iOS: runs with the runtime. Public explainer: <a href="/bluetooth" target="_blank" rel="noopener">/bluetooth</a>; threat model: docs/security/agent-threat-model.md.</li>
        </ul>
      </details>
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
      <div class="net-card" id="blacklistCard">
        <h3>Paused agents (blacklisted)</h3>
        <div class="hint muted">Agents a coordinator refuses: they can't register, so they are not in the table above. Automatic pauses come from behavioural monitoring and lift by themselves at their expiry; Lift ends one now on every coordinator that has it.</div>
        <div class="net-table-wrap">
          <table><thead><tr><th>Agent</th><th>Owner</th><th>Reason</th><th>By</th><th class="num">Since</th><th class="num">Lifts</th><th>Coordinators</th><th></th></tr></thead><tbody id="blacklistBody"></tbody></table>
        </div>
        <div class="muted" id="blacklistStatus"></div>
      </div>
      <div class="net-card">
        <h3>Models in use</h3>
        <div class="net-table-wrap">
          <table><thead><tr><th>Model</th><th class="num">Agents</th><th class="num">Idle</th><th class="num">Free slots</th><th class="num">Waiting</th><th class="num">Calls (15 min)</th><th class="num">Calls (24 h)</th><th class="num">Refused / no capacity (24 h)</th></tr></thead><tbody id="modelsBody"></tbody></table>
        </div>
      </div>
      <div class="net-card">
        <h3>Routing decisions</h3>
        <div class="hint muted">Network requests that leave the model to the network (model "auto"): the default for the API without a model, portal chat on Auto, the app's Auto and bots when a step goes to the network, <code>edgecoder code</code> and tentacle helpers. A pinned model skips best-fit routing; it is listed only when the portal chose its coordinator. Each row: the job and its complexity, what best-fit routing chose and why, the score breakdown (quality · latency · price · reliability), and the estimate against what happened. Coordinator: where the portal sent the call and why (latency-aware choice: expected latency = the portal's round trip + queueing + the coordinator's round trip to the agent; a nearer coordinator wins only with a free slot and by the margin, or when the load pick has no free slot). Kept across restarts for NETWORK_HISTORY_DAYS.</div>
        <div class="net-table-wrap">
          <table><thead><tr><th>When</th><th>Coordinator</th><th>Job</th><th>Complexity</th><th>Chosen</th><th>Score (Q · L · P · R)</th><th class="num">Est. wait / TTFT / total</th><th class="num">Actual TTFT / total</th><th class="num">Est. / actual cSats</th><th>Why</th></tr></thead><tbody id="routingBody"></tbody></table>
        </div>
        <div class="muted" id="routingWeights"></div>
      </div>
      <section aria-labelledby="netGapsTitle">
        <div class="net-section-head"><h3 id="netGapsTitle">Gaps</h3><span class="hint">Where the network falls short, over the chart range; the line under each chart is the state now.</span></div>
        <div class="net-charts" id="netGaps">
          <div class="net-chart" id="chartUnmet"><h3>Unmet demand</h3><div class="hint">Requests per minute with no capacity: no agent has the model, or no free slot. By model</div><div class="net-legend"></div><p class="net-sum" id="gapMissing"></p></div>
          <div class="net-chart" id="chartSaturation"><h3>Saturation</h3><div class="hint">Free slots per model on live agents (the models with the most slots); 0 is saturated</div><div class="net-legend"></div><p class="net-sum" id="gapSaturated"></p></div>
          <div class="net-chart" id="chartStale"><h3>Stale agents</h3><div class="hint">Agents not seen for 2 min</div><div class="net-legend"></div><p class="net-sum" id="gapStale"></p></div>
          <div class="net-chart" id="chartRegions"><h3>Agents by region</h3><div class="hint">Agents online, stacked by hosting region</div><div class="net-legend"></div><p class="net-sum" id="gapCoverage"></p></div>
        </div>
      </section>
    </div>`;
}

export function networkPageScript(): string {
  return `
    ${SETTINGS_HELPERS_SCRIPT}
    ${SERIES_GAPS_SCRIPT}
    ${GAP_CHARTS_SCRIPT}
    const REFRESH_MS = ${NETWORK_REFRESH_MS};
    const RANGE_MS = ${JSON.stringify(NETWORK_RANGES_MS)};
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
    function clock(ms) { return range === "7d" ? new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" }) : new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
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
      // A legend for two or more series, or when the series are named keys (a model, a region).
      if (series.length > 1 || opts.legend) for (const s of series) { const item = el("span"); item.appendChild(legendSwatch(s.cls, s.dashed)); item.appendChild(document.createTextNode(s.label)); legend.appendChild(item); }
      const old = box.querySelector("svg.plot"); if (old) old.remove();
      const oldTip = box.querySelector(".net-tip"); if (oldTip) oldTip.remove();
      // The viewBox is the drawn size, so text is never stretched; redrawn on resize.
      const W = Math.max(240, Math.round(box.clientWidth - 24)), H = 170, L = 44, R = 8, T = 8, B = 20;
      const title = box.querySelector("h3").textContent;
      const plot = svg("svg", { class: "plot", viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": opts.desc ? title + ". " + opts.desc : title });
      // Above the one-line summary when the chart has one.
      box.insertBefore(plot, box.querySelector(".net-sum"));
      // Each series' plotted height per point: its value, or with opts.stacked the running total.
      const isNum = (v) => v !== null && v !== undefined && isFinite(v);
      const base = points.map(() => 0);
      const tops = series.map((s) => points.map((p, k) => { const v = s.value(p); if (!isNum(v)) return null; if (!opts.stacked) return v; base[k] += v; return base[k]; }));
      const vals = [];
      for (const col of tops) for (const v of col) if (v !== null) vals.push(v);
      if (!points.length || !vals.length) {
        const t = svg("text", { x: String(W / 2), y: String(H / 2), "text-anchor": "middle", class: "empty" }); t.textContent = points.length ? "Nothing measured in this range yet" : "Collecting samples (one every 15 s)"; plot.appendChild(t);
        return;
      }
      const ymax = opts.max || niceMax(Math.max.apply(null, vals));
      const t1 = Date.now();
      const t0 = t1 - RANGE_MS[range];
      const x = (t) => L + ((Math.max(t0, Math.min(t1, t)) - t0) / (t1 - t0)) * (W - L - R);
      const y = (v) => T + (1 - v / ymax) * (H - T - B);
      // Spans with no samples (coordinator down): shaded and left empty, never drawn as zeros.
      const bucketMs = (data && data.series && data.series.bucketMs) || 15000;
      const gaps = seriesGaps(points, bucketMs, t0, t1);
      for (const g of gaps) {
        const gx = x(g.fromMs), gw = Math.max(1, x(g.toMs) - gx);
        plot.appendChild(svg("rect", { x: gx.toFixed(1), y: String(T), width: gw.toFixed(1), height: String(H - T - B), class: "gapband" }));
        if (gw > 48) { const gl = svg("text", { x: (gx + gw / 2).toFixed(1), y: String(T + 12), "text-anchor": "middle", class: "gaplabel" }); gl.textContent = "no data"; plot.appendChild(gl); }
      }
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
      const gap = bucketMs * 2.5;
      const lines = [];
      series.forEach((s, i) => {
        // Runs of joined points; a run is a line along the tops and, for an area, a band down to the
        // series below (stacked) or to zero.
        const runs = [];
        let run = null, prevT = null;
        points.forEach((p, k) => {
          const top = tops[i][k];
          if (top === null) { prevT = null; return; }
          const join = prevT !== null && p.atMs - prevT <= gap;
          if (!join || !run) { run = []; runs.push(run); }
          run.push({ x: x(p.atMs).toFixed(1), top: y(top).toFixed(1), low: y(opts.stacked && i > 0 ? (tops[i - 1][k] || 0) : 0).toFixed(1) });
          prevT = p.atMs;
        });
        const fill = opts.stacked ? "a-" + s.cls.replace("s-", "") : s.area ? "a-brand" : null;
        if (fill) {
          let area = "";
          for (const r of runs) area += " M" + r.map((q) => q.x + " " + q.top).join(" L") + " L" + r.slice().reverse().map((q) => q.x + " " + q.low).join(" L") + " Z";
          if (area) plot.appendChild(svg("path", { d: area.trim(), class: "area " + fill }));
        }
        let d = "";
        for (const r of runs) d += " M" + r.map((q) => q.x + " " + q.top).join(" L");
        lines.push(svg("path", { d: d.trim(), class: "line " + s.cls + (s.dashed ? " dash" : "") }));
      });
      for (const l of lines) plot.appendChild(l);
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
        const vt = t0 + ((vx - L) / (W - L - R)) * (t1 - t0);
        const inGap = gaps.find((g) => vt >= g.fromMs && vt < g.toMs);
        if (inGap) {
          hide();
          cross.setAttribute("x1", String(vx)); cross.setAttribute("x2", String(vx)); cross.classList.remove("hidden");
          tip.textContent = "";
          const fmt = (t) => new Date(t).toLocaleString([], { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
          tip.appendChild(el("div", { class: "t" }, fmt(inGap.fromMs) + " to " + fmt(inGap.toMs)));
          tip.appendChild(el("div", {}, "No samples: coordinator down or not yet started"));
          tip.classList.remove("hidden");
          const boxRect0 = box.getBoundingClientRect();
          let left0 = ev.clientX - boxRect0.left + 12;
          if (left0 + tip.offsetWidth > boxRect0.width - 4) left0 = ev.clientX - boxRect0.left - tip.offsetWidth - 12;
          tip.style.left = Math.max(4, left0) + "px";
          tip.style.top = (rect.top - boxRect0.top + 8) + "px";
          return;
        }
        let best = null, bestK = -1, bestD = Infinity;
        points.forEach((p, k) => { const dd = Math.abs(x(p.atMs) - vx); if (dd < bestD) { bestD = dd; best = p; bestK = k; } });
        if (!best) return hide();
        const bx = x(best.atMs);
        cross.setAttribute("x1", String(bx)); cross.setAttribute("x2", String(bx)); cross.classList.remove("hidden");
        tip.textContent = "";
        tip.appendChild(el("div", { class: "t" }, new Date(best.atMs).toLocaleString([], { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" })));
        series.forEach((s, i) => {
          const v = s.value(best);
          const row = el("div"); row.appendChild(legendSwatch(s.cls, s.dashed)); row.appendChild(document.createTextNode(" " + s.label + " ")); row.appendChild(el("span", { class: "v" }, v === null || v === undefined || !isFinite(v) ? "-" : opts.fmt(v)));
          tip.appendChild(row);
          const top = tops[i][bestK];
          if (top === null) dots[i].classList.add("hidden"); else { dots[i].setAttribute("cx", String(bx)); dots[i].setAttribute("cy", String(y(top))); dots[i].classList.remove("hidden"); }
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
      drawGapCharts(pts, perMin);
    }
    function drawGapCharts(pts, perMin) {
      const sum = gapSummaries(data, Date.now());
      setText("gapMissing", sum.unmet); setText("gapSaturated", sum.saturation); setText("gapStale", sum.stale); setText("gapCoverage", sum.regions);
      const count = (v) => Number(v) || 0;
      // Nothing unmet in the whole range: a zero line rather than an empty legend.
      let unmet = keyedSeries("chartUnmet", pts, "unmetByModel", count, (v) => count(v) * perMin, true);
      if (!unmet.length) unmet = [{ label: "All models", cls: "s-c1", value: (p) => (p.unmetByModel ? 0 : null) }];
      drawChart("chartUnmet", pts, unmet, { stacked: true, legend: true, fmt: (v) => fmtNum(v, 1), desc: sum.unmet });
      const slots = keyedSeries("chartSaturation", pts, "modelSlots", (v) => (v ? count(v.total) : 0), (v) => (v ? count(v.free) : 0), false);
      // Memory-limited agents (no capacity for memory or an open circuit) on the same chart, when the coordinators report them.
      if (pts.some((p) => p.memoryLimitedAgents !== undefined)) slots.push({ label: "Memory-limited agents", cls: "s-info", dashed: true, value: (p) => (p.memoryLimitedAgents === undefined ? null : Number(p.memoryLimitedAgents)) });
      drawChart("chartSaturation", pts, slots, { legend: true, fmt: (v) => fmtNum(v, 1), desc: sum.saturation });
      drawChart("chartStale", pts, [{ label: "Stale agents", cls: "s-brand", area: true, value: (p) => (p.staleAgents === undefined ? null : Number(p.staleAgents)) }], { fmt: (v) => fmtNum(v, 1), desc: sum.stale });
      let regions = keyedSeries("chartRegions", pts, "agentsByRegion", count, count, true);
      if (!regions.length) regions = [{ label: "No agents online", cls: "s-c1", value: (p) => (p.agentsByRegion ? 0 : null) }];
      drawChart("chartRegions", pts, regions, { stacked: true, legend: true, fmt: (v) => fmtNum(v, 1), desc: sum.regions });
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
        const used = el("td", { class: "num nowrap" }, a.connected && !a.blacklisted ? (a.slots - a.freeSlots) + " / " + a.slots : "- / " + a.slots); if (a.contextWindow) used.appendChild(el("div", { class: "muted" }, fmtNum(a.contextWindow, 0) + " ctx")); if (a.memory) { const m = a.memory; const gb = (b) => fmtNum((b || 0) / 1073741824, 1) + " GB"; used.appendChild(el("div", { class: "muted", title: "Loaded: " + ((m.loadedModels || []).map((x) => x.name + " " + gb(x.bytes)).join(", ") || "none") + (m.peakPressure && m.peakPressure !== "normal" ? " · peak pressure " + m.peakPressure : "") }, "mem " + m.pressure + " · " + gb(m.usedBytes) + " / " + gb(m.budgetBytes) + ((m.loadedModels || []).length ? " · " + m.loadedModels.map((x) => x.name).join(", ") : ""))); } if (a.circuit && a.circuit.open) used.appendChild(el("div", { class: "muted" }, "cooling down (failures)")); tr.appendChild(used);
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
    function renderRouting() {
      const body = $("routingBody"); body.textContent = "";
      const r = data.routing || { decisions: [] };
      const two = (n) => (n === null || n === undefined ? "-" : Number(n).toFixed(2));
      for (const d of r.decisions || []) {
        const tr = el("tr");
        tr.appendChild(el("td", {}, ago(d.atMs)));
        const cc = d.coordinatorChoice;
        const short = (h) => String(h || "-").split(".")[0];
        const ccTitle = cc ? [cc.reason, "client " + (cc.clientRegion || "?") + " · portal " + (cc.portalRegion || "?")].concat((cc.candidates || []).map((c) => c.coordinator + ": expected " + fmtMs(c.expectedMs) + " = rtt " + fmtMs(c.rttMs) + " + queue " + fmtMs(c.queueMs) + " + agent " + fmtMs(c.agentRttMs) + " · free " + c.free + " · waiting " + c.waiting + (c.stale ? " · stale" : ""))).join("\\n") : "";
        const mine = cc ? (cc.candidates || []).find((c) => c.coordinator === cc.chosen) : null;
        tr.appendChild(el("td", { class: "mono", title: ccTitle }, short(d.coordinator) + (cc ? " · " + cc.rule + (mine && mine.expectedMs !== null && mine.expectedMs !== undefined ? " " + fmtMs(mine.expectedMs) : "") + (cc.clientRegion ? " · from " + cc.clientRegion : "") : "")));
        tr.appendChild(el("td", {}, d.pinned ? "named model" : String(d.job || "-").replace("_", " ") + (d.jobInferred ? "" : " (sent)") + (d.quality && d.quality !== "balanced" ? " · " + d.quality : "")));
        const cx = d.complexity || {};
        const sig = (cx.signals || []).filter((s) => s.contribution > 0).slice(0, 3).map((s) => s.detail).join(", ");
        tr.appendChild(el("td", { title: (cx.signals || []).map((s) => s.name + " " + two(s.value) + " (" + (s.contribution >= 0 ? "+" : "") + two(s.contribution) + ")").join("\\n") }, String(cx.level || "-").replace("_", " ") + " " + two(cx.score) + (sig ? " · " + sig : "") + (cx.hinted !== undefined ? " · hint" : "")));
        const actual = d.actual || {};
        tr.appendChild(el("td", { class: "mono" }, (d.model || "-") + " @ " + (d.computeClass || "-") + (d.agent ? " · " + d.agent : "") + (actual.agent && actual.ranOnPreferred === false ? " (ran on " + actual.agent + ")" : "")));
        const p = d.parts || {};
        tr.appendChild(el("td", { class: "mono" }, two(d.score) + " = " + [p.quality, p.latency, p.price, p.reliability].map(two).join(" · ")));
        const e = d.estimate || {};
        tr.appendChild(el("td", { class: "num" }, fmtMs(e.waitMs) + " / " + fmtMs(e.ttftMs) + " / " + fmtMs(e.totalMs)));
        tr.appendChild(el("td", { class: "num" }, fmtMs(actual.ttftMs) + " / " + fmtMs(actual.totalMs) + (actual.ok === false ? " · failed" : "")));
        tr.appendChild(el("td", { class: "num" }, (e.cSats === undefined ? "-" : String(e.cSats)) + " / " + (actual.cSats === undefined ? "-" : String(actual.cSats))));
        tr.appendChild(el("td", {}, String(d.reason || "") + (d.affinity && d.affinity.status === "broken" ? " · affinity broken: " + d.affinity.reason : "")));
        body.appendChild(tr);
      }
      if (!(r.decisions || []).length) { const tr = el("tr"); tr.appendChild(el("td", { colspan: "10" }, 'No routed requests on this coordinator yet. A row appears for each network request that leaves the model to the network (no model, or "auto"). Calls that name a model, and Auto steps that ran free on the caller’s own machines, are not routed here.')); body.appendChild(tr); }
      const w = r.config && r.config.weights;
      setText("routingWeights", w ? "Base weights: quality " + w.quality + " · latency " + w.latency + " · price " + w.price + " · reliability " + w.reliability + " · complexity shift " + r.config.complexityShift + " · preference " + r.config.preferMs + " ms" : "");
    }
    function render() {
      $("netError").classList.add("hidden");
      $("netBody").classList.remove("hidden");
      renderKpis(); renderCoordinators(); renderAgents(); renderModels(); renderRouting(); drawCharts();
      const down = data.coordinators.filter((c) => !c.ok).length;
      setText("netUpdated", "Updated " + new Date(data.generatedAtMs).toLocaleTimeString() + " · every " + (REFRESH_MS / 1000) + " s" + (down ? " · " + down + " coordinator(s) not answering" : ""));
    }
    async function load() {
      const r = await call("/portal/api/admin/network?range=" + range, { method: "GET", headers: {} });
      if (r.status === 403 || r.status === 401) { $("netDenied").classList.remove("hidden"); stop(); return; }
      if (!r.ok) { showError("Could not load the network: " + (r.json.detail || r.json.error || r.status)); return; }
      data = r.json;
      render();
      loadBlacklist().catch(() => undefined);
    }
    function renderBlacklist(b) {
      const body = $("blacklistBody");
      body.textContent = "";
      for (const a of b.agents || []) {
        const tr = el("tr");
        tr.appendChild(el("td", { class: "mono" }, a.agentId));
        tr.appendChild(el("td", {}, a.ownerEmail || "-"));
        tr.appendChild(el("td", {}, String(a.reason || a.reasonCode || "")));
        tr.appendChild(el("td", {}, a.automatic ? "automatic" : (a.reportedBy || "-")));
        tr.appendChild(el("td", { class: "num" }, ago(a.timestampMs)));
        tr.appendChild(el("td", { class: "num" }, a.expiresAtMs ? "in " + fmtMs(Math.max(0, a.expiresAtMs - Date.now())) : "never"));
        tr.appendChild(el("td", {}, (a.coordinators || []).join(", ")));
        const td = el("td");
        const btn = el("button", { type: "button", class: "btn-secondary", "data-agent": a.agentId }, "Lift");
        btn.addEventListener("click", () => liftAgent(a.agentId, btn).catch((err) => setText("blacklistStatus", "Lift failed: " + String(err.message || err))));
        td.appendChild(btn);
        tr.appendChild(td);
        body.appendChild(tr);
      }
      if (!(b.agents || []).length) { const tr = el("tr"); tr.appendChild(el("td", { colspan: "8" }, "No agent is paused.")); body.appendChild(tr); }
      const down = (b.coordinators || []).filter((c) => !c.ok);
      setText("blacklistStatus", down.length ? down.length + " coordinator(s) did not answer: " + down.map((c) => c.url + " (" + c.error + ")").join(", ") : "");
    }
    async function loadBlacklist() {
      const r = await call("/portal/api/admin/blacklist", { method: "GET", headers: {} });
      if (!r.ok) { setText("blacklistStatus", "Could not load paused agents: " + (r.json.detail || r.json.error || r.status)); return; }
      renderBlacklist(r.json);
    }
    async function liftAgent(agentId, btn) {
      if (!confirm("Lift the pause on " + agentId + "? It can register and take work again at once.")) return;
      btn.disabled = true;
      const r = await call("/portal/api/admin/blacklist/" + encodeURIComponent(agentId) + "/lift", { method: "POST", body: "{}" });
      setText("blacklistStatus", r.ok ? "Lifted " + agentId + " on " + r.json.lifted + " coordinator(s)." : "Lift failed: " + (r.json.error || r.status));
      await loadBlacklist();
    }
    window.__renderBlacklist = (json) => renderBlacklist(json);
    // ── Alerts (src/portal/alerts.ts): active incidents from the portal and every coordinator ──
    const ALERT_EVENT_LABEL = { raised: "Raised", notified: "Notified", renotified: "Reminder sent", resolved: "Resolved", acknowledged: "Acknowledged", notify_failed: "Notification failed", test: "Test alert" };
    function renderAlerts(a) {
      $("alerts").classList.remove("hidden");
      const src = (a.sources || []).map((x) => x.reporter + ": " + (!x.ok ? "not answering (" + x.error + ")" : !x.enabled ? "alerting off" : x.channels.length ? x.channels.join(", ") : "no channel set"));
      setText("alertSources", "Notification channels. " + src.join(" · ") + (a.coordinatorAdminToken === false ? " · coordinators not asked: COORDINATOR_ADMIN_TOKEN is not set on the portal" : ""));
      const body = $("alertsBody");
      body.textContent = "";
      for (const x of a.active || []) {
        const tr = el("tr");
        const sev = el("td"); sev.appendChild(badge(x.severity, x.severity === "critical" ? "danger" : "warn")); tr.appendChild(sev);
        tr.appendChild(el("td", {}, x.title));
        tr.appendChild(el("td", {}, x.summary));
        tr.appendChild(el("td", { class: "num", title: new Date(x.firstSeenMs).toLocaleString() }, ago(x.firstSeenMs)));
        tr.appendChild(el("td", {}, x.reporter || x.origin));
        const td = el("td");
        if (x.acknowledgedAtMs) td.appendChild(el("span", { class: "muted" }, "Acknowledged by " + (x.acknowledgedBy || "admin")));
        else {
          const btn = el("button", { type: "button", class: "btn-secondary" }, "Acknowledge");
          btn.addEventListener("click", () => ackAlert(x, btn).catch((err) => setText("alertStatus", "Acknowledge failed: " + String(err.message || err))));
          td.appendChild(btn);
        }
        tr.appendChild(td);
        body.appendChild(tr);
      }
      if (!(a.active || []).length) { const tr = el("tr"); tr.appendChild(el("td", { colspan: "6" }, "No active alerts.")); body.appendChild(tr); }
      const hist = $("alertHistoryBody");
      hist.textContent = "";
      for (const e of (a.history || []).slice(0, 100)) {
        const tr = el("tr");
        tr.appendChild(el("td", { class: "num", title: new Date(e.atMs).toLocaleString() }, ago(e.atMs)));
        tr.appendChild(el("td", {}, ALERT_EVENT_LABEL[e.kind] || e.kind));
        tr.appendChild(el("td", { title: e.summary }, e.title));
        tr.appendChild(el("td", {}, e.reporter || e.origin));
        hist.appendChild(tr);
      }
      if (!(a.history || []).length) { const tr = el("tr"); tr.appendChild(el("td", { colspan: "4" }, "Nothing yet.")); hist.appendChild(tr); }
    }
    async function loadAlerts() {
      const r = await call("/portal/api/admin/alerts", { method: "GET", headers: {} });
      if (!r.ok) { $("alerts").classList.remove("hidden"); setText("alertStatus", "Could not load alerts: " + (r.json.error || r.status)); return; }
      renderAlerts(r.json);
    }
    async function ackAlert(x, btn) {
      btn.disabled = true;
      const r = await call("/portal/api/admin/alerts/ack", { method: "POST", body: JSON.stringify({ origin: x.origin, source: x.source, key: x.key }) });
      setText("alertStatus", r.ok ? "Acknowledged: " + x.title + ". No more reminders until it resolves." : "Acknowledge failed: " + (r.json.error || r.status));
      await loadAlerts();
    }
    async function sendTestAlert() {
      if (!confirm("Send a test alert to every configured channel (email and webhook) from the portal and each coordinator?")) return;
      const btn = $("alertTestBtn");
      btn.disabled = true;
      setText("alertStatus", "Sending...");
      try {
        const r = await call("/portal/api/admin/alerts/test", { method: "POST", body: "{}" });
        if (!r.ok) { setText("alertStatus", "Test failed: " + (r.json.error || r.status)); return; }
        const short = (o) => o === "portal" ? "portal" : String(o).replace(/^https?:\\/\\//, "");
        setText("alertStatus", "Test alert: " + (r.json.results || []).map((x) => short(x.origin) + " " + (x.ok ? "sent (" + x.channels.map((c) => c.channel).join(", ") + ")" : "failed: " + (x.error || x.channels.filter((c) => !c.ok).map((c) => c.channel + " " + c.error).join(", ")))).join(" · "));
        await loadAlerts();
      } finally {
        btn.disabled = false;
      }
    }
    $("alertTestBtn").addEventListener("click", () => sendTestAlert().catch((err) => setText("alertStatus", "Test failed: " + String(err.message || err))));
    window.__renderAlerts = (json) => renderAlerts(json);
    function stop() { if (timer) clearInterval(timer); timer = null; }
    function start() { stop(); timer = setInterval(() => { if (!document.hidden) { load().catch(() => undefined); loadAlerts().catch(() => undefined); } }, REFRESH_MS); }
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
      // Alerts load on their own too: they matter most when the network view cannot load.
      loadAlerts().catch(() => undefined);
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
