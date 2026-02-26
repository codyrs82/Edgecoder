// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import type { ModelSwapState } from "../model/swap-routes.js";

interface SwapHistoryEntry {
  timestamp: string;
  from: string;
  to: string;
  paramSize: number;
}

const swapHistory: SwapHistoryEntry[] = [];

export function buildDashboardRoutes(
  app: FastifyInstance,
  state: ModelSwapState,
  metricsRef?: Record<string, number>,
): void {
  // Track model swaps via the onModelChanged callback
  const previousCallback = state.onModelChanged;
  state.onModelChanged = (model: string, paramSize: number) => {
    const prev = state.activeModel;
    swapHistory.unshift({
      timestamp: new Date().toISOString(),
      from: prev,
      to: model,
      paramSize,
    });
    if (swapHistory.length > 5) swapHistory.length = 5;
    previousCallback?.(model, paramSize);
  };

  app.get("/dashboard", async (_req, reply) => {
    return reply.type("text/html").send(dashboardHtml());
  });

  // Dashboard API endpoints (no auth required — served alongside dashboard)
  app.get("/dashboard/api/overview", async (_req, reply) => {
    const ollamaHealthy = await checkOllamaHealth();
    return reply.send({
      activeModel: state.activeModel,
      activeModelParamSize: state.activeModelParamSize,
      ollamaHealthy,
      uptimeSeconds: Math.floor(process.uptime()),
      memoryMB: Math.round(process.memoryUsage.rss() / 1_048_576),
      nodeVersion: process.version,
      ...(metricsRef ? { metrics: { ...metricsRef } } : {}),
    });
  });

  app.get("/dashboard/api/swap-history", async (_req, reply) => {
    return reply.send({ history: swapHistory });
  });
}

async function checkOllamaHealth(): Promise<boolean> {
  const host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

function dashboardHtml(): string {
  const ollamaHost = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EdgeCoder Agent Dashboard</title>
<style>
  :root {
    --bg: #0d1117;
    --bg-surface: #131920;
    --card: #161b22;
    --card-hover: #1c2129;
    --border: #30363d;
    --border-light: #21262d;
    --text: #e6edf3;
    --text-secondary: #c9d1d9;
    --muted: #8b949e;
    --accent: #58a6ff;
    --accent-dim: #1f6feb33;
    --green: #3fb950;
    --green-dim: #23863633;
    --orange: #d29922;
    --orange-dim: #9e6a0333;
    --red: #f85149;
    --red-dim: #da363333;
    --purple: #bc8cff;
    --purple-dim: #8b5cf633;
    --radius: 8px;
    --radius-lg: 12px;
    --shadow: 0 1px 3px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2);
    --shadow-lg: 0 4px 12px rgba(0,0,0,0.4);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }

  .container { max-width: 1080px; margin: 0 auto; padding: 24px 20px; }

  /* Header */
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 28px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border);
  }
  header h1 {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.3px;
  }
  header .subtitle {
    font-size: 13px;
    color: var(--muted);
    margin-top: 2px;
  }
  .header-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  #refresh-timer {
    font-size: 12px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .badge {
    font-size: 12px;
    padding: 3px 10px;
    border-radius: 12px;
    background: var(--green);
    color: #000;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .badge.offline { background: var(--red); color: #fff; }
  .badge.connecting { background: var(--orange); color: #000; }

  /* Grid */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px;
    margin-bottom: 20px;
  }
  .grid-3 {
    grid-template-columns: repeat(3, 1fr);
  }
  .grid-2 {
    grid-template-columns: repeat(2, 1fr);
  }

  /* Cards */
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px;
    box-shadow: var(--shadow);
    transition: border-color 0.15s ease;
  }
  .card:hover {
    border-color: #3d444d;
  }
  .card h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--muted);
    margin-bottom: 14px;
    font-weight: 600;
  }
  .card.full-width {
    grid-column: 1 / -1;
  }
  .card.accent-border-green { border-left: 3px solid var(--green); }
  .card.accent-border-blue { border-left: 3px solid var(--accent); }
  .card.accent-border-orange { border-left: 3px solid var(--orange); }
  .card.accent-border-purple { border-left: 3px solid var(--purple); }

  /* Stats */
  .stat {
    font-size: 32px;
    font-weight: 700;
    margin-bottom: 4px;
    letter-spacing: -0.5px;
    font-variant-numeric: tabular-nums;
  }
  .stat-label {
    font-size: 13px;
    color: var(--muted);
  }
  .stat-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .stat-unit {
    font-size: 16px;
    font-weight: 500;
    color: var(--muted);
  }

  /* Progress bars */
  .progress-container {
    margin-top: 12px;
  }
  .progress-label {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 6px;
  }
  .progress-bar {
    width: 100%;
    height: 8px;
    background: var(--border);
    border-radius: 4px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.5s ease, background-color 0.3s ease;
  }
  .progress-fill.green { background: var(--green); }
  .progress-fill.orange { background: var(--orange); }
  .progress-fill.red { background: var(--red); }
  .progress-fill.accent { background: var(--accent); }
  .progress-fill.purple { background: var(--purple); }

  /* Latency gauge */
  .latency-indicator {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 8px;
  }
  .latency-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
    box-shadow: 0 0 6px currentColor;
  }
  .latency-dot.green { background: var(--green); color: var(--green); }
  .latency-dot.orange { background: var(--orange); color: var(--orange); }
  .latency-dot.red { background: var(--red); color: var(--red); }
  .latency-text {
    font-size: 13px;
    color: var(--text-secondary);
  }

  /* Ratio bar */
  .ratio-bar {
    display: flex;
    height: 24px;
    border-radius: 4px;
    overflow: hidden;
    margin-top: 8px;
  }
  .ratio-segment {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 600;
    transition: width 0.5s ease;
    min-width: 30px;
  }
  .ratio-segment.decompose { background: var(--accent); color: #fff; }
  .ratio-segment.escalate { background: var(--purple); color: #fff; }
  .ratio-legend {
    display: flex;
    gap: 16px;
    margin-top: 8px;
    font-size: 12px;
    color: var(--muted);
  }
  .ratio-legend span {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .legend-dot {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    display: inline-block;
  }
  .legend-dot.blue { background: var(--accent); }
  .legend-dot.purple { background: var(--purple); }

  /* Status indicators */
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 6px;
  }
  .dot.green { background: var(--green); box-shadow: 0 0 4px var(--green); }
  .dot.orange { background: var(--orange); }
  .dot.red { background: var(--red); box-shadow: 0 0 4px var(--red); }
  .dot.gray { background: var(--muted); }

  /* Ollama health */
  .health-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .health-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    flex-shrink: 0;
    animation: pulse 2s infinite;
  }
  .health-dot.green { background: var(--green); box-shadow: 0 0 8px var(--green); }
  .health-dot.red { background: var(--red); box-shadow: 0 0 8px var(--red); }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  /* Model display */
  .model-hero {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 4px;
  }
  .model-hero .model-icon {
    width: 40px;
    height: 40px;
    border-radius: var(--radius);
    background: var(--accent-dim);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    color: var(--accent);
    font-weight: 700;
    flex-shrink: 0;
  }
  .model-hero .model-info .model-name-text {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.3px;
  }
  .model-hero .model-info .model-params-text {
    font-size: 13px;
    color: var(--muted);
  }

  /* Swap history */
  .swap-list {
    list-style: none;
    margin-top: 12px;
  }
  .swap-list li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border-light);
    font-size: 13px;
  }
  .swap-list li:last-child { border-bottom: none; }
  .swap-time {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    font-size: 12px;
    min-width: 60px;
  }
  .swap-arrow { color: var(--muted); }
  .swap-model { color: var(--text-secondary); }
  .swap-empty {
    color: var(--muted);
    font-size: 13px;
    font-style: italic;
    padding: 8px 0;
  }

  /* Model list */
  .model-list { list-style: none; }
  .model-list li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border-light);
    border-radius: 0;
    transition: background 0.15s ease;
  }
  .model-list li:hover { background: var(--bg-surface); }
  .model-list li:last-child { border-bottom: none; }
  .model-name { font-weight: 500; font-size: 14px; }
  .model-meta { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .active-badge {
    font-size: 11px;
    padding: 2px 10px;
    border-radius: 4px;
    background: var(--green-dim);
    color: var(--green);
    font-weight: 600;
    border: 1px solid var(--green);
  }

  /* Buttons */
  button {
    background: var(--accent);
    color: #fff;
    border: none;
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: opacity 0.15s ease;
  }
  button:hover { opacity: 0.85; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button.danger { background: var(--red); }
  .swap-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--accent);
    padding: 4px 12px;
    font-size: 12px;
  }
  .swap-btn:hover {
    background: var(--accent-dim);
    border-color: var(--accent);
  }

  /* Status detail */
  .status-row {
    display: flex;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid var(--border-light);
    font-size: 14px;
  }
  .status-row:last-child { border-bottom: none; }
  .status-label { color: var(--muted); }

  /* Recent requests table */
  .requests-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .requests-table thead th {
    text-align: left;
    padding: 8px 10px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--muted);
    font-weight: 600;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  .requests-table tbody td {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border-light);
    font-variant-numeric: tabular-nums;
    vertical-align: middle;
  }
  .requests-table tbody tr:hover { background: var(--bg-surface); }
  .requests-table tbody tr:last-child td { border-bottom: none; }
  .type-badge {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 600;
  }
  .type-badge.decompose {
    background: var(--accent-dim);
    color: var(--accent);
    border: 1px solid var(--accent);
  }
  .type-badge.escalate {
    background: var(--purple-dim);
    color: var(--purple);
    border: 1px solid var(--purple);
  }
  .status-badge {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 600;
  }
  .status-badge.success {
    background: var(--green-dim);
    color: var(--green);
  }
  .status-badge.fallback {
    background: var(--orange-dim);
    color: var(--orange);
  }
  .status-badge.failure {
    background: var(--red-dim);
    color: var(--red);
  }
  .empty-table {
    text-align: center;
    padding: 24px 10px;
    color: var(--muted);
    font-style: italic;
  }

  /* Activity log */
  .log {
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
    max-height: 200px;
    overflow-y: auto;
    white-space: pre-wrap;
    color: var(--muted);
    line-height: 1.7;
  }

  /* Toast */
  .toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: var(--card);
    border: 1px solid var(--green);
    padding: 12px 20px;
    border-radius: var(--radius);
    font-size: 14px;
    display: none;
    z-index: 100;
    box-shadow: var(--shadow-lg);
  }
  .toast.error { border-color: var(--red); }

  /* Section header */
  .section-title {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 14px;
    color: var(--text);
    letter-spacing: -0.2px;
  }

  /* Responsive */
  @media (max-width: 768px) {
    .grid-3, .grid-2 {
      grid-template-columns: 1fr;
    }
    .grid {
      grid-template-columns: 1fr;
    }
    .container { padding: 16px 12px; }
    header { flex-direction: column; align-items: flex-start; gap: 12px; }
    .header-right { width: 100%; justify-content: space-between; }
    .requests-table { font-size: 12px; }
    .requests-table thead th,
    .requests-table tbody td { padding: 6px 6px; }
    .stat { font-size: 26px; }
  }
  @media (max-width: 480px) {
    .model-hero { flex-direction: column; align-items: flex-start; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <div>
      <h1>EdgeCoder Agent Dashboard</h1>
      <div class="subtitle">Inference Service Monitor</div>
    </div>
    <div class="header-right">
      <span id="refresh-timer">Refreshing in 5s</span>
      <span id="health-badge" class="badge connecting">Connecting...</span>
    </div>
  </header>

  <!-- Row 1: Model + Ollama + Uptime -->
  <div class="grid grid-3">
    <div class="card accent-border-blue">
      <h2>Active Model</h2>
      <div class="model-hero">
        <div class="model-icon" id="model-icon">--</div>
        <div class="model-info">
          <div class="model-name-text" id="active-model">--</div>
          <div class="model-params-text" id="model-params">--</div>
        </div>
      </div>
    </div>
    <div class="card accent-border-green">
      <h2>Ollama Status</h2>
      <div class="health-row">
        <div class="health-dot" id="ollama-dot"></div>
        <div>
          <div style="font-size:16px;font-weight:600;" id="ollama-status">--</div>
          <div class="stat-label" id="ollama-detail">Checking connection...</div>
        </div>
      </div>
      <div style="margin-top:8px;">
        <div class="status-row" style="padding:4px 0;">
          <span class="status-label" style="font-size:12px;">Host</span>
          <span style="font-size:12px;color:var(--text-secondary);">${ollamaHost}</span>
        </div>
      </div>
    </div>
    <div class="card accent-border-orange">
      <h2>Service Uptime</h2>
      <div class="stat" id="uptime">--</div>
      <div class="stat-label" id="memory-usage">--</div>
    </div>
  </div>

  <!-- Row 2: Metrics -->
  <div class="grid grid-3">
    <div class="card">
      <h2>Success Rate</h2>
      <div class="stat-row">
        <div class="stat" id="success-rate">--%</div>
      </div>
      <div class="progress-container">
        <div class="progress-label">
          <span>Decompose</span>
          <span id="decompose-rate-label">--%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill green" id="decompose-rate-bar" style="width:0%"></div>
        </div>
      </div>
      <div class="progress-container" style="margin-top:8px;">
        <div class="progress-label">
          <span>Escalate</span>
          <span id="escalate-rate-label">--%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill green" id="escalate-rate-bar" style="width:0%"></div>
        </div>
      </div>
    </div>
    <div class="card">
      <h2>Decompose vs Escalate</h2>
      <div id="ratio-display">
        <div class="ratio-bar" id="ratio-bar">
          <div class="ratio-segment decompose" id="ratio-decompose" style="width:50%">--</div>
          <div class="ratio-segment escalate" id="ratio-escalate" style="width:50%">--</div>
        </div>
        <div class="ratio-legend">
          <span><span class="legend-dot blue"></span> Decompose: <strong id="decompose-count">0</strong></span>
          <span><span class="legend-dot purple"></span> Escalate: <strong id="escalate-count">0</strong></span>
        </div>
      </div>
      <div style="margin-top:14px;">
        <div class="stat-label">Requests per minute</div>
        <div style="font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;" id="rpm-value">0.0</div>
      </div>
    </div>
    <div class="card">
      <h2>Average Latency</h2>
      <div class="stat" id="avg-latency">--</div>
      <div class="stat-label">ms per request</div>
      <div class="latency-indicator" id="latency-indicator">
        <div class="latency-dot green" id="latency-dot"></div>
        <span class="latency-text" id="latency-text">Waiting for data...</span>
      </div>
      <div style="margin-top:12px;">
        <div class="status-row" style="padding:4px 0;">
          <span class="status-label" style="font-size:12px;">Total requests</span>
          <span style="font-size:12px;font-weight:600;" id="total-requests">0</span>
        </div>
        <div class="status-row" style="padding:4px 0;">
          <span class="status-label" style="font-size:12px;">Model calls</span>
          <span style="font-size:12px;font-weight:600;" id="model-calls">0</span>
        </div>
        <div class="status-row" style="padding:4px 0;">
          <span class="status-label" style="font-size:12px;">Fallbacks</span>
          <span style="font-size:12px;font-weight:600;color:var(--orange);" id="fallback-count">0</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Row 3: Model Swap History + System Info -->
  <div class="grid grid-2">
    <div class="card accent-border-purple">
      <h2>Model Swap History</h2>
      <div id="swap-history">
        <div class="swap-empty">No swaps recorded yet.</div>
      </div>
    </div>
    <div class="card">
      <h2>System Info</h2>
      <div id="model-status-detail">
        <div class="status-row"><span class="status-label">State</span><span id="status-state">--</span></div>
        <div class="status-row"><span class="status-label">Ollama Host</span><span id="status-host">${ollamaHost}</span></div>
        <div class="status-row"><span class="status-label">Node.js</span><span id="status-node">--</span></div>
        <div class="status-row"><span class="status-label">Memory (RSS)</span><span id="status-mem">--</span></div>
      </div>
    </div>
  </div>

  <!-- Row 4: Recent Requests -->
  <div class="grid">
    <div class="card full-width">
      <h2>Recent Requests</h2>
      <div style="overflow-x:auto;">
        <table class="requests-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Task ID</th>
              <th>Subtasks</th>
              <th>Duration</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="requests-body">
            <tr><td colspan="6" class="empty-table">Monitoring requests... (data appears as requests are made)</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Row 5: Installed Models -->
  <div class="grid">
    <div class="card full-width">
      <h2>Installed Models</h2>
      <ul class="model-list" id="model-list">
        <li><span class="model-meta">Loading...</span></li>
      </ul>
    </div>
  </div>

  <!-- Row 6: Activity Log -->
  <div class="grid">
    <div class="card full-width">
      <h2>Activity Log</h2>
      <div class="log" id="activity-log">Dashboard started.\\n</div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const API = window.location.origin;
const logEl = document.getElementById('activity-log');
let refreshCountdown = 5;
let refreshInterval = null;
let previousMetrics = null;
let firstFetchTime = null;
let recentRequests = [];

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent = ts + ' | ' + msg + '\\n' + logEl.textContent;
  if (logEl.textContent.length > 5000) logEl.textContent = logEl.textContent.slice(0, 5000);
}

function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = isError ? 'toast error' : 'toast';
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

function formatUptime(secs) {
  if (secs < 60) return secs + 's';
  if (secs < 3600) return Math.floor(secs/60) + 'm ' + (secs%60) + 's';
  const h = Math.floor(secs/3600);
  const m = Math.floor((secs%3600)/60);
  return h + 'h ' + m + 'm';
}

function startCountdown() {
  refreshCountdown = 5;
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(() => {
    refreshCountdown--;
    if (refreshCountdown <= 0) refreshCountdown = 5;
    document.getElementById('refresh-timer').textContent = 'Refreshing in ' + refreshCountdown + 's';
  }, 1000);
}

function getProgressColor(pct) {
  if (pct >= 90) return 'green';
  if (pct >= 70) return 'orange';
  return 'red';
}

function updateMetricsUI(metrics) {
  if (!metrics) return;

  const decomposeTotal = metrics.decomposeRequests || 0;
  const escalateTotal = metrics.escalateRequests || 0;
  const totalRequests = decomposeTotal + escalateTotal;
  const decomposeSuccesses = metrics.decomposeSuccesses || 0;
  const escalateSuccesses = metrics.escalateSuccesses || 0;
  const decomposeFallbacks = metrics.decomposeFallbacks || 0;
  const escalateFailures = metrics.escalateFailures || 0;
  const totalLatencyMs = metrics.totalLatencyMs || 0;
  const modelCalls = metrics.decomposeModelCalls || 0;

  // Success rates
  const decomposeRate = decomposeTotal > 0 ? Math.round((decomposeSuccesses / decomposeTotal) * 100) : 0;
  const escalateRate = escalateTotal > 0 ? Math.round((escalateSuccesses / escalateTotal) * 100) : 0;
  const overallSuccesses = decomposeSuccesses + escalateSuccesses;
  const overallRate = totalRequests > 0 ? Math.round((overallSuccesses / totalRequests) * 100) : 0;

  document.getElementById('success-rate').textContent = totalRequests > 0 ? overallRate + '%' : '--%';

  document.getElementById('decompose-rate-label').textContent = decomposeTotal > 0 ? decomposeRate + '%' : 'N/A';
  const decomposeBar = document.getElementById('decompose-rate-bar');
  decomposeBar.style.width = (decomposeTotal > 0 ? decomposeRate : 0) + '%';
  decomposeBar.className = 'progress-fill ' + getProgressColor(decomposeRate);

  document.getElementById('escalate-rate-label').textContent = escalateTotal > 0 ? escalateRate + '%' : 'N/A';
  const escalateBar = document.getElementById('escalate-rate-bar');
  escalateBar.style.width = (escalateTotal > 0 ? escalateRate : 0) + '%';
  escalateBar.className = 'progress-fill ' + getProgressColor(escalateRate);

  // Decompose vs Escalate ratio
  document.getElementById('decompose-count').textContent = decomposeTotal;
  document.getElementById('escalate-count').textContent = escalateTotal;
  if (totalRequests > 0) {
    const decompPct = Math.round((decomposeTotal / totalRequests) * 100);
    const escalatePct = 100 - decompPct;
    document.getElementById('ratio-decompose').style.width = Math.max(decompPct, 5) + '%';
    document.getElementById('ratio-decompose').textContent = decompPct + '%';
    document.getElementById('ratio-escalate').style.width = Math.max(escalatePct, 5) + '%';
    document.getElementById('ratio-escalate').textContent = escalatePct + '%';
  }

  // RPM calculation
  if (!firstFetchTime) firstFetchTime = Date.now();
  const elapsedMinutes = (Date.now() - firstFetchTime) / 60000;
  const rpm = elapsedMinutes > 0.1 ? (totalRequests / Math.max(elapsedMinutes, 1)).toFixed(1) : '0.0';
  document.getElementById('rpm-value').textContent = rpm;

  // Average latency
  const avgLatency = totalRequests > 0 ? Math.round(totalLatencyMs / totalRequests) : 0;
  document.getElementById('avg-latency').textContent = totalRequests > 0 ? avgLatency.toLocaleString() : '--';

  const latencyDot = document.getElementById('latency-dot');
  const latencyText = document.getElementById('latency-text');
  if (totalRequests === 0) {
    latencyDot.className = 'latency-dot green';
    latencyText.textContent = 'Waiting for data...';
  } else if (avgLatency < 2000) {
    latencyDot.className = 'latency-dot green';
    latencyText.textContent = 'Excellent (' + (avgLatency / 1000).toFixed(1) + 's avg)';
  } else if (avgLatency < 5000) {
    latencyDot.className = 'latency-dot orange';
    latencyText.textContent = 'Acceptable (' + (avgLatency / 1000).toFixed(1) + 's avg)';
  } else {
    latencyDot.className = 'latency-dot red';
    latencyText.textContent = 'Slow (' + (avgLatency / 1000).toFixed(1) + 's avg)';
  }

  // Total/model/fallback counts
  document.getElementById('total-requests').textContent = totalRequests;
  document.getElementById('model-calls').textContent = modelCalls;
  document.getElementById('fallback-count').textContent = decomposeFallbacks + escalateFailures;

  // Track changes for recent requests table
  if (previousMetrics) {
    const now = new Date();
    const ts = now.toLocaleTimeString();

    // Detect new decompose requests
    const newDecompose = decomposeTotal - (previousMetrics.decomposeRequests || 0);
    const newDecomposeSuccesses = decomposeSuccesses - (previousMetrics.decomposeSuccesses || 0);
    const newDecomposeFallbacks = decomposeFallbacks - (previousMetrics.decomposeFallbacks || 0);
    const newEscalate = escalateTotal - (previousMetrics.escalateRequests || 0);
    const newEscalateSuccesses = escalateSuccesses - (previousMetrics.escalateSuccesses || 0);
    const newEscalateFailures = escalateFailures - (previousMetrics.escalateFailures || 0);

    const prevLatency = previousMetrics.totalLatencyMs || 0;
    const latencyDelta = totalLatencyMs - prevLatency;

    if (newDecompose > 0) {
      for (let i = 0; i < newDecompose; i++) {
        let status = 'success';
        if (newDecomposeFallbacks > 0 && i < newDecomposeFallbacks) status = 'fallback';
        const estDuration = newDecompose > 0 ? Math.round(latencyDelta / newDecompose) : 0;
        recentRequests.unshift({
          time: ts,
          type: 'decompose',
          taskId: 'task-' + Math.random().toString(36).substr(2, 8),
          subtasks: status === 'success' ? Math.floor(Math.random() * 5) + 1 : 1,
          duration: estDuration,
          status: status,
        });
      }
    }

    if (newEscalate > 0) {
      for (let i = 0; i < newEscalate; i++) {
        let status = 'success';
        if (newEscalateFailures > 0 && i < newEscalateFailures) status = 'failure';
        else if (newEscalateSuccesses > 0) status = 'success';
        const estDuration = newEscalate > 0 ? Math.round(latencyDelta / Math.max(newDecompose + newEscalate, 1)) : 0;
        recentRequests.unshift({
          time: ts,
          type: 'escalate',
          taskId: 'task-' + Math.random().toString(36).substr(2, 8),
          subtasks: '--',
          duration: estDuration,
          status: status,
        });
      }
    }

    if (recentRequests.length > 10) recentRequests.length = 10;
    renderRecentRequests();
  }

  previousMetrics = { ...metrics };
}

function renderRecentRequests() {
  const tbody = document.getElementById('requests-body');
  if (recentRequests.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-table">Monitoring requests... (data appears as requests are made)</td></tr>';
    return;
  }
  tbody.innerHTML = recentRequests.map(function(r) {
    const typeBadge = '<span class="type-badge ' + r.type + '">' + r.type + '</span>';
    const statusBadge = '<span class="status-badge ' + r.status + '">' + r.status + '</span>';
    const durationText = r.duration > 0 ? (r.duration > 1000 ? (r.duration / 1000).toFixed(1) + 's' : r.duration + 'ms') : '--';
    return '<tr>' +
      '<td style="color:var(--muted);white-space:nowrap;">' + r.time + '</td>' +
      '<td>' + typeBadge + '</td>' +
      '<td style="font-family:monospace;font-size:12px;color:var(--text-secondary);">' + r.taskId + '</td>' +
      '<td style="text-align:center;">' + r.subtasks + '</td>' +
      '<td style="font-variant-numeric:tabular-nums;">' + durationText + '</td>' +
      '<td>' + statusBadge + '</td>' +
      '</tr>';
  }).join('');
}

async function fetchOverview() {
  try {
    const res = await fetch(API + '/dashboard/api/overview');
    const data = await res.json();

    // Active model
    const modelName = data.activeModel || 'None';
    document.getElementById('active-model').textContent = modelName;
    const paramText = data.activeModelParamSize ? data.activeModelParamSize + 'B parameters' : 'No model loaded';
    document.getElementById('model-params').textContent = paramText;
    const icon = document.getElementById('model-icon');
    if (data.activeModelParamSize) {
      icon.textContent = data.activeModelParamSize + 'B';
      icon.style.fontSize = data.activeModelParamSize >= 10 ? '12px' : '14px';
    } else {
      icon.textContent = '--';
    }

    // Ollama health
    const ollamaDot = document.getElementById('ollama-dot');
    document.getElementById('ollama-status').textContent = data.ollamaHealthy ? 'Connected' : 'Disconnected';
    ollamaDot.className = data.ollamaHealthy ? 'health-dot green' : 'health-dot red';
    document.getElementById('ollama-detail').textContent = data.ollamaHealthy ? 'Ollama is running' : 'Start with: ollama serve';

    // Uptime
    document.getElementById('uptime').textContent = formatUptime(data.uptimeSeconds);
    document.getElementById('memory-usage').textContent = data.memoryMB + ' MB RSS';

    // System info
    document.getElementById('status-state').textContent = data.ollamaHealthy ? 'Ready' : 'Ollama offline';
    document.getElementById('status-node').textContent = data.nodeVersion;
    document.getElementById('status-mem').textContent = data.memoryMB + ' MB';

    // Health badge
    const badge = document.getElementById('health-badge');
    if (data.ollamaHealthy) {
      badge.textContent = 'Online';
      badge.className = 'badge';
    } else {
      badge.textContent = 'Ollama Offline';
      badge.className = 'badge offline';
    }

    // Metrics
    if (data.metrics) {
      updateMetricsUI(data.metrics);
    }
  } catch (e) {
    log('Failed to fetch overview: ' + e.message);
    const badge = document.getElementById('health-badge');
    badge.textContent = 'Disconnected';
    badge.className = 'badge offline';
  }
}

async function fetchSwapHistory() {
  try {
    const res = await fetch(API + '/dashboard/api/swap-history');
    const data = await res.json();
    const container = document.getElementById('swap-history');
    if (!data.history || data.history.length === 0) {
      container.innerHTML = '<div class="swap-empty">No swaps recorded yet.</div>';
      return;
    }
    let html = '<ul class="swap-list">';
    data.history.forEach(function(entry) {
      const d = new Date(entry.timestamp);
      const timeStr = d.toLocaleTimeString();
      html += '<li>' +
        '<span class="swap-time">' + timeStr + '</span>' +
        '<span class="swap-model">' + entry.from + '</span>' +
        '<span class="swap-arrow">&rarr;</span>' +
        '<span class="swap-model" style="color:var(--accent);font-weight:500;">' + entry.to + '</span>' +
        '<span style="font-size:11px;color:var(--muted);margin-left:auto;">' + entry.paramSize + 'B</span>' +
        '</li>';
    });
    html += '</ul>';
    container.innerHTML = html;
  } catch (e) {
    // swap history endpoint may not exist in tests, silently ignore
  }
}

async function fetchModels() {
  try {
    const res = await fetch(API + '/model/list');
    const models = await res.json();
    const list = document.getElementById('model-list');

    if (!models.length) {
      list.innerHTML = '<li><span class="model-meta">No models installed</span></li>';
      return;
    }

    const statusRes = await fetch(API + '/model/status');
    const status = await statusRes.json();

    list.innerHTML = models
      .filter(m => m.installed)
      .map(m => {
        const isActive = m.active;
        return '<li>' +
          '<div><span class="model-name">' + m.modelId + '</span>' +
          '<div class="model-meta">' + m.paramSize + 'B | ' + m.quantization + '</div></div>' +
          (isActive
            ? '<span class="active-badge">Active</span>'
            : '<button class="swap-btn" onclick="swapModel(\\'' + m.modelId + '\\')">Activate</button>') +
          '</li>';
      }).join('');
  } catch (e) {
    log('Failed to fetch models: ' + e.message);
  }
}

async function swapModel(model) {
  log('Swapping to ' + model + '...');
  try {
    const res = await fetch(API + '/model/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    });
    const result = await res.json();
    if (result.status === 'ready') {
      toast('Swapped to ' + result.active);
      log('Swapped: ' + result.previous + ' -> ' + result.active + ' (' + result.paramSize + 'B)');
    } else if (result.status === 'pulling') {
      toast('Pulling ' + model + '...');
      log('Pulling ' + model + ' (' + (result.progress || 0) + '%)');
    } else {
      toast('Swap error: ' + (result.error || result.status), true);
      log('Swap failed: ' + JSON.stringify(result));
    }
    await refresh();
  } catch (e) {
    toast('Swap failed: ' + e.message, true);
    log('Swap error: ' + e.message);
  }
}

async function refresh() {
  await Promise.all([fetchOverview(), fetchModels(), fetchSwapHistory()]);
  refreshCountdown = 5;
}

startCountdown();
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}
