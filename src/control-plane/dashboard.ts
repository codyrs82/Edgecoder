import type { FastifyInstance } from "fastify";
import type { CreditEngine } from "../credits/engine.js";
import { countPendingHumanEscalations, listHumanEscalations } from "../escalation/human-store.js";

/**
 * In-memory agent record shape used by the control-plane server.
 * Mirrors the AgentRecord type defined in server.ts.
 */
export interface DashboardAgentRecord {
  agentId: string;
  os: "debian" | "ubuntu" | "windows" | "macos" | "ios";
  version: string;
  mode: "swarm-only" | "ide-enabled";
  health: "healthy" | "stale";
  localModelEnabled: boolean;
  lastSeenMs: number;
}

export interface AdminDashboardDeps {
  agents: Map<string, DashboardAgentRecord>;
  networkMode: () => string;
  creditEngine: CreditEngine;
  pgStore: {
    listRolloutPolicies(): Promise<Array<any>>;
    listAgentRolloutStates(rolloutId: string): Promise<Array<any>>;
    creditBalance(accountId: string): Promise<number>;
    listCreditAccounts?(): Promise<Array<any>>;
    listRecentCreditTransactions?(limit: number): Promise<Array<any>>;
  } | null;
  coordinatorUrl: string;
  coordinatorMeshHeaders: (contentType?: boolean) => Record<string, string>;
  portalServiceUrl: string;
  authorizeAdmin: (req: any, reply: any) => boolean;
}

export function buildAdminDashboardRoutes(
  app: FastifyInstance,
  deps: AdminDashboardDeps,
): void {
  const {
    agents,
    networkMode,
    creditEngine,
    pgStore,
    coordinatorUrl,
    coordinatorMeshHeaders,
    portalServiceUrl,
    authorizeAdmin,
  } = deps;

  // ── HTML Dashboard ──────────────────────────────────────────────
  app.get("/admin/dashboard", async (req, reply) => {
    if (!authorizeAdmin(req as any, reply)) return;
    return reply.type("text/html").send(adminDashboardHtml(portalServiceUrl));
  });

  // ── JSON Data Endpoint ──────────────────────────────────────────
  app.get("/admin/api/dashboard-data", async (req, reply) => {
    if (!authorizeAdmin(req as any, reply)) return;

    const now = Date.now();
    const agentList = [...agents.values()].map((a) => ({
      ...a,
      health: now - a.lastSeenMs > 120_000 ? "stale" : "healthy",
    }));

    const totalAgents = agentList.length;
    const onlineAgents = agentList.filter((a) => a.health === "healthy").length;
    const offlineAgents = totalAgents - onlineAgents;

    // OS breakdown
    const byOs: Record<string, number> = {};
    for (const a of agentList) {
      byOs[a.os] = (byOs[a.os] ?? 0) + 1;
    }

    // Sandbox/local model breakdown
    const localModelEnabled = agentList.filter((a) => a.localModelEnabled).length;

    // Task summary from coordinator (best-effort)
    let taskSummary = { active: 0, queued: 0, completedToday: 0 };
    try {
      const { request } = await import("undici");
      const res = await request(`${coordinatorUrl}/status`, {
        method: "GET",
        headers: coordinatorMeshHeaders(),
      });
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const status = (await res.body.json()) as any;
        taskSummary = {
          active: status.agents ?? 0,
          queued: status.queued ?? 0,
          completedToday: status.results ?? 0,
        };
      }
    } catch {
      // coordinator unreachable
    }

    // Rollout summary
    let rolloutSummary: Array<any> = [];
    if (pgStore) {
      try {
        const policies = await pgStore.listRolloutPolicies();
        rolloutSummary = await Promise.all(
          policies.map(async (policy: any) => {
            const agentStates = await pgStore!.listAgentRolloutStates(policy.rolloutId);
            const total = agentStates.length;
            const applied = agentStates.filter(
              (s: any) => s.status === "applied" || s.status === "healthy",
            ).length;
            return {
              rolloutId: policy.rolloutId,
              modelId: policy.modelId,
              stage: policy.stage,
              progressPercent: total > 0 ? Math.round((applied / total) * 100) : 0,
              agentCount: total,
            };
          }),
        );
      } catch {
        // pgStore may not be available
      }
    }

    // Network summary (best-effort)
    let networkSummary = {
      mode: networkMode(),
      coordinatorCount: 0,
      peerCount: 0,
    };
    try {
      const { request } = await import("undici");
      const [coordRes, peersRes] = await Promise.all([
        request(`${coordinatorUrl}/identity`, {
          method: "GET",
          headers: coordinatorMeshHeaders(),
        }).catch(() => null),
        request(`${coordinatorUrl}/mesh/peers`, {
          method: "GET",
          headers: coordinatorMeshHeaders(),
        }).catch(() => null),
      ]);

      let coordCount = 1; // at least the bootstrap coordinator
      let peerCount = 0;

      if (peersRes && peersRes.statusCode >= 200 && peersRes.statusCode < 300) {
        const peersData = (await peersRes.body.json()) as any;
        const peers = peersData.peers ?? [];
        peerCount = peers.length;
        coordCount = peers.filter((p: any) => p.role === "coordinator").length || 1;
      } else if (peersRes) {
        await peersRes.body.dump();
      }

      if (coordRes && coordRes.statusCode >= 200 && coordRes.statusCode < 300) {
        await coordRes.body.json(); // consume
      } else if (coordRes) {
        await coordRes.body.dump();
      }

      networkSummary = {
        mode: networkMode(),
        coordinatorCount: coordCount,
        peerCount,
      };
    } catch {
      // best-effort
    }

    // Credit summary (in-memory engine for accounts)
    const creditSummary = {
      totalCreditsIssued: 0,
      activeAccounts: 0,
      recentTransactions: 0,
    };
    // Use in-memory engine stats (the engine is always available)
    // We approximate by iterating known agent accounts
    const knownAccountIds = new Set<string>();
    for (const a of agentList) {
      knownAccountIds.add(a.agentId);
    }
    let totalIssued = 0;
    let activeCount = 0;
    for (const accountId of knownAccountIds) {
      const bal = creditEngine.balance(accountId);
      if (bal > 0) {
        activeCount++;
        totalIssued += bal;
      }
    }
    creditSummary.totalCreditsIssued = Number(totalIssued.toFixed(3));
    creditSummary.activeAccounts = activeCount;
    creditSummary.recentTransactions = knownAccountIds.size;

    // Escalation summary
    const pendingEscalations = countPendingHumanEscalations();
    const allEscalations = listHumanEscalations();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const resolvedToday = allEscalations.filter(
      (e) => e.status === "resolved" && e.updatedAtMs >= todayStart.getTime(),
    ).length;

    // Avg resolution time for resolved escalations
    let avgResolutionMs = 0;
    const resolved = allEscalations.filter((e) => e.status === "resolved");
    if (resolved.length > 0) {
      const totalMs = resolved.reduce((sum, e) => sum + (e.updatedAtMs - e.createdAtMs), 0);
      avgResolutionMs = Math.round(totalMs / resolved.length);
    }

    return reply.send({
      generatedAt: now,
      uptimeSeconds: Math.floor(process.uptime()),
      agents: {
        total: totalAgents,
        online: onlineAgents,
        offline: offlineAgents,
        byOs,
        localModelEnabled,
        list: agentList,
      },
      tasks: taskSummary,
      rollouts: rolloutSummary,
      network: networkSummary,
      credits: creditSummary,
      escalations: {
        pending: pendingEscalations,
        resolvedToday,
        avgResolutionMs,
      },
    });
  });
}

// ── HTML Template ──────────────────────────────────────────────────
function adminDashboardHtml(portalServiceUrl: string): string {
  const portalLink = portalServiceUrl
    ? `${portalServiceUrl.replace(/\/$/, "")}/portal/dashboard`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EdgeCoder Admin Dashboard</title>
<style>
  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff; --green: #3fb950; --orange: #d29922; --red: #f85149; --yellow: #d29922; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px 16px; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
  header h1 { font-size: 20px; font-weight: 600; }
  header .badge { font-size: 12px; padding: 2px 8px; border-radius: 12px; background: var(--green); color: #000; font-weight: 600; }
  .nav-links { display: flex; gap: 12px; align-items: center; }
  .nav-links a { color: var(--accent); text-decoration: none; font-size: 13px; }
  .nav-links a:hover { text-decoration: underline; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .grid-wide { display: grid; grid-template-columns: 1fr; gap: 16px; margin-bottom: 24px; }
  .grid-2col { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); margin-bottom: 12px; }
  .stat { font-size: 28px; font-weight: 700; margin-bottom: 4px; }
  .stat-label { font-size: 13px; color: var(--muted); }
  .stat-row { display: flex; gap: 24px; flex-wrap: wrap; }
  .stat-item { text-align: center; }
  .stat-item .num { font-size: 24px; font-weight: 700; }
  .stat-item .lbl { font-size: 11px; color: var(--muted); text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 10px; border-bottom: 2px solid var(--border); color: var(--muted); font-weight: 600; cursor: pointer; user-select: none; white-space: nowrap; }
  th:hover { color: var(--accent); }
  th .sort-arrow { font-size: 10px; margin-left: 4px; }
  td { padding: 8px 10px; border-bottom: 1px solid var(--border); }
  tr:last-child td { border-bottom: none; }
  .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .status-dot.green { background: var(--green); }
  .status-dot.red { background: var(--red); }
  .status-dot.yellow { background: var(--yellow); }
  .progress-bar { background: var(--border); border-radius: 4px; height: 8px; overflow: hidden; margin-top: 4px; }
  .progress-fill { height: 100%; border-radius: 4px; background: var(--accent); transition: width 0.3s; }
  .rollout-item { padding: 12px 0; border-bottom: 1px solid var(--border); }
  .rollout-item:last-child { border-bottom: none; }
  .rollout-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .rollout-model { font-weight: 600; }
  .rollout-stage { font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; }
  .stage-canary { background: var(--yellow); color: #000; }
  .stage-batch { background: var(--accent); color: #fff; }
  .stage-full { background: var(--green); color: #000; }
  .stage-paused { background: var(--muted); color: #fff; }
  .stage-rolled_back { background: var(--red); color: #fff; }
  .rollout-actions { display: flex; gap: 6px; margin-top: 8px; }
  button { background: var(--accent); color: #fff; border: none; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500; }
  button:hover { opacity: 0.9; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button.danger { background: var(--red); }
  button.small { padding: 3px 8px; font-size: 11px; }
  .empty-state { color: var(--muted); font-size: 13px; font-style: italic; }
  .toast { position: fixed; bottom: 24px; right: 24px; background: var(--card); border: 1px solid var(--green); padding: 12px 20px; border-radius: 8px; font-size: 14px; display: none; z-index: 100; }
  .toast.error { border-color: var(--red); }
  #refresh-timer { font-size: 12px; color: var(--muted); }
  .section-title { font-size: 16px; font-weight: 600; margin-bottom: 12px; margin-top: 8px; }
</style>
</head>
<body>
<div class="container">
  <header>
    <div>
      <h1>EdgeCoder Admin Dashboard</h1>
      <span id="refresh-timer">Auto-refresh: 10s</span>
    </div>
    <div class="nav-links">
      ${portalLink ? '<a href="' + portalLink + '" target="_blank">Portal Dashboard</a>' : ""}
      <span id="uptime-badge" class="badge">Loading...</span>
    </div>
  </header>

  <!-- Overview Stats -->
  <div class="grid">
    <div class="card">
      <h2>Total Agents</h2>
      <div class="stat" id="total-agents">--</div>
      <div class="stat-label"><span id="online-agents">--</span> online / <span id="offline-agents">--</span> offline</div>
    </div>
    <div class="card">
      <h2>Tasks</h2>
      <div class="stat" id="active-tasks">--</div>
      <div class="stat-label">active | <span id="queued-tasks">--</span> queued</div>
    </div>
    <div class="card">
      <h2>Network Mode</h2>
      <div class="stat" id="network-mode" style="font-size: 18px;">--</div>
      <div class="stat-label"><span id="coord-count">--</span> coordinators | <span id="peer-count">--</span> peers</div>
    </div>
    <div class="card">
      <h2>System Uptime</h2>
      <div class="stat" id="uptime">--</div>
      <div class="stat-label">since last restart</div>
    </div>
  </div>

  <!-- Credit Economy & Escalations -->
  <div class="grid-2col">
    <div class="card">
      <h2>Credit Economy</h2>
      <div class="stat-row">
        <div class="stat-item"><div class="num" id="credits-issued">--</div><div class="lbl">Credits Issued</div></div>
        <div class="stat-item"><div class="num" id="credits-accounts">--</div><div class="lbl">Active Accounts</div></div>
        <div class="stat-item"><div class="num" id="credits-txns">--</div><div class="lbl">Recent Txns</div></div>
      </div>
    </div>
    <div class="card">
      <h2>Human Escalations</h2>
      <div class="stat-row">
        <div class="stat-item"><div class="num" id="escalation-pending">--</div><div class="lbl">Pending</div></div>
        <div class="stat-item"><div class="num" id="escalation-resolved">--</div><div class="lbl">Resolved Today</div></div>
        <div class="stat-item"><div class="num" id="escalation-avg">--</div><div class="lbl">Avg Resolution</div></div>
      </div>
      ${portalLink ? '<div style="margin-top:10px;"><a href="' + portalLink.replace("/dashboard", "/reviews") + '" target="_blank" style="color:var(--accent);font-size:12px;">View in Portal</a></div>' : ""}
    </div>
  </div>

  <!-- Agent Table -->
  <div class="grid-wide">
    <div class="card">
      <h2>Agents</h2>
      <table id="agent-table">
        <thead>
          <tr>
            <th data-col="agentId">Agent ID <span class="sort-arrow"></span></th>
            <th data-col="os">OS <span class="sort-arrow"></span></th>
            <th data-col="health">Status <span class="sort-arrow"></span></th>
            <th data-col="localModelEnabled">Local Model <span class="sort-arrow"></span></th>
            <th data-col="mode">Mode <span class="sort-arrow"></span></th>
            <th data-col="lastSeenMs">Last Heartbeat <span class="sort-arrow"></span></th>
            <th data-col="version">Version <span class="sort-arrow"></span></th>
          </tr>
        </thead>
        <tbody id="agent-tbody">
          <tr><td colspan="7" class="empty-state">Loading...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Rollout Status -->
  <div class="grid-wide">
    <div class="card">
      <h2>Rollout Status</h2>
      <div id="rollout-list">
        <div class="empty-state">Loading...</div>
      </div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const API = window.location.origin;
let currentData = null;
let sortCol = 'agentId';
let sortAsc = true;

function toast(msg, isError) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.className = isError ? 'toast error' : 'toast';
  el.style.display = 'block';
  setTimeout(function() { el.style.display = 'none'; }, 3000);
}

function formatUptime(secs) {
  if (secs < 60) return secs + 's';
  if (secs < 3600) return Math.floor(secs/60) + 'm ' + (secs%60) + 's';
  var h = Math.floor(secs/3600);
  var m = Math.floor((secs%3600)/60);
  if (h < 24) return h + 'h ' + m + 'm';
  var d = Math.floor(h/24);
  return d + 'd ' + (h%24) + 'h';
}

function formatMs(ms) {
  if (ms < 60000) return Math.round(ms/1000) + 's';
  if (ms < 3600000) return Math.round(ms/60000) + 'm';
  return Math.round(ms/3600000) + 'h';
}

function timeAgo(ms) {
  var diff = Date.now() - ms;
  if (diff < 60000) return Math.round(diff/1000) + 's ago';
  if (diff < 3600000) return Math.round(diff/60000) + 'm ago';
  if (diff < 86400000) return Math.round(diff/3600000) + 'h ago';
  return Math.round(diff/86400000) + 'd ago';
}

function getAdminToken() {
  var params = new URLSearchParams(window.location.search);
  return params.get('token') || '';
}

function apiHeaders() {
  var h = { 'Accept': 'application/json' };
  var token = getAdminToken();
  if (token) h['X-Admin-Token'] = token;
  return h;
}

function statusDot(health) {
  if (health === 'healthy') return '<span class="status-dot green"></span>Online';
  if (health === 'stale') return '<span class="status-dot red"></span>Offline';
  return '<span class="status-dot yellow"></span>Unknown';
}

function stageClass(stage) {
  return 'stage-' + stage;
}

function renderAgents(agentList) {
  var tbody = document.getElementById('agent-tbody');
  if (!agentList || agentList.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No agents registered</td></tr>';
    return;
  }
  var sorted = agentList.slice().sort(function(a, b) {
    var va = a[sortCol], vb = b[sortCol];
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return sortAsc ? -1 : 1;
    if (va > vb) return sortAsc ? 1 : -1;
    return 0;
  });
  tbody.innerHTML = sorted.map(function(a) {
    return '<tr>' +
      '<td style="font-family:monospace;font-size:12px;">' + a.agentId + '</td>' +
      '<td>' + a.os + '</td>' +
      '<td>' + statusDot(a.health) + '</td>' +
      '<td>' + (a.localModelEnabled ? 'Yes' : 'No') + '</td>' +
      '<td>' + a.mode + '</td>' +
      '<td>' + timeAgo(a.lastSeenMs) + '</td>' +
      '<td>' + a.version + '</td>' +
    '</tr>';
  }).join('');

  // Update sort arrows
  document.querySelectorAll('#agent-table th').forEach(function(th) {
    var arrow = th.querySelector('.sort-arrow');
    if (th.dataset.col === sortCol) {
      arrow.textContent = sortAsc ? '\\u25B2' : '\\u25BC';
    } else {
      arrow.textContent = '';
    }
  });
}

function renderRollouts(rollouts) {
  var container = document.getElementById('rollout-list');
  if (!rollouts || rollouts.length === 0) {
    container.innerHTML = '<div class="empty-state">No active rollouts</div>';
    return;
  }
  container.innerHTML = rollouts.map(function(r) {
    var canPromote = r.stage === 'canary' || r.stage === 'batch';
    var canRollback = r.stage !== 'rolled_back';
    return '<div class="rollout-item">' +
      '<div class="rollout-header">' +
        '<span class="rollout-model">' + r.modelId + ' <span class="rollout-stage ' + stageClass(r.stage) + '">' + r.stage + '</span></span>' +
        '<span style="color:var(--muted);font-size:12px;">' + r.agentCount + ' agents | ' + r.progressPercent + '%</span>' +
      '</div>' +
      '<div class="progress-bar"><div class="progress-fill" style="width:' + r.progressPercent + '%;"></div></div>' +
      '<div class="rollout-actions">' +
        (canPromote ? '<button class="small" onclick="promoteRollout(\\'' + r.rolloutId + '\\')">Promote</button>' : '') +
        (canRollback ? '<button class="small danger" onclick="rollbackRollout(\\'' + r.rolloutId + '\\')">Rollback</button>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

async function promoteRollout(rolloutId) {
  try {
    var res = await fetch(API + '/rollouts/' + rolloutId + '/promote', {
      method: 'POST',
      headers: Object.assign({}, apiHeaders(), { 'Content-Type': 'application/json' }),
      body: '{}'
    });
    var data = await res.json();
    if (res.ok) {
      toast('Promoted ' + rolloutId);
      await refresh();
    } else {
      toast('Promote failed: ' + (data.error || res.status), true);
    }
  } catch (e) {
    toast('Promote error: ' + e.message, true);
  }
}

async function rollbackRollout(rolloutId) {
  try {
    var res = await fetch(API + '/rollouts/' + rolloutId + '/rollback', {
      method: 'POST',
      headers: Object.assign({}, apiHeaders(), { 'Content-Type': 'application/json' }),
      body: '{}'
    });
    var data = await res.json();
    if (res.ok) {
      toast('Rolled back ' + rolloutId);
      await refresh();
    } else {
      toast('Rollback failed: ' + (data.error || res.status), true);
    }
  } catch (e) {
    toast('Rollback error: ' + e.message, true);
  }
}

async function refresh() {
  try {
    var res = await fetch(API + '/admin/api/dashboard-data', { headers: apiHeaders() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    currentData = data;

    // Overview
    document.getElementById('total-agents').textContent = data.agents.total;
    document.getElementById('online-agents').textContent = data.agents.online;
    document.getElementById('offline-agents').textContent = data.agents.offline;
    document.getElementById('active-tasks').textContent = data.tasks.active;
    document.getElementById('queued-tasks').textContent = data.tasks.queued;
    document.getElementById('network-mode').textContent = data.network.mode.replace('_', ' ');
    document.getElementById('coord-count').textContent = data.network.coordinatorCount;
    document.getElementById('peer-count').textContent = data.network.peerCount;
    document.getElementById('uptime').textContent = formatUptime(data.uptimeSeconds);
    document.getElementById('uptime-badge').textContent = 'Uptime: ' + formatUptime(data.uptimeSeconds);

    // Credits
    document.getElementById('credits-issued').textContent = data.credits.totalCreditsIssued.toFixed(1);
    document.getElementById('credits-accounts').textContent = data.credits.activeAccounts;
    document.getElementById('credits-txns').textContent = data.credits.recentTransactions;

    // Escalations
    document.getElementById('escalation-pending').textContent = data.escalations.pending;
    document.getElementById('escalation-resolved').textContent = data.escalations.resolvedToday;
    document.getElementById('escalation-avg').textContent = data.escalations.avgResolutionMs > 0 ? formatMs(data.escalations.avgResolutionMs) : '--';

    // Agent table
    renderAgents(data.agents.list);

    // Rollouts
    renderRollouts(data.rollouts);
  } catch (e) {
    document.getElementById('uptime-badge').textContent = 'Error';
    document.getElementById('uptime-badge').style.background = 'var(--red)';
  }
}

// Column sorting
document.querySelectorAll('#agent-table th').forEach(function(th) {
  th.addEventListener('click', function() {
    var col = this.dataset.col;
    if (!col) return;
    if (sortCol === col) {
      sortAsc = !sortAsc;
    } else {
      sortCol = col;
      sortAsc = true;
    }
    if (currentData) renderAgents(currentData.agents.list);
  });
});

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;
}
