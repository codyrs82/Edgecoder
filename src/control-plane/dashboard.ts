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
    const creditSummary: {
      totalCreditsIssued: number;
      activeAccounts: number;
      recentTransactions: number;
      topEarners: Array<{ accountId: string; balance: number }>;
      dailyCredits: number[];
    } = {
      totalCreditsIssued: 0,
      activeAccounts: 0,
      recentTransactions: 0,
      topEarners: [],
      dailyCredits: [0, 0, 0, 0, 0, 0, 0],
    };
    // Use in-memory engine stats (the engine is always available)
    // We approximate by iterating known agent accounts
    const knownAccountIds = new Set<string>();
    for (const a of agentList) {
      knownAccountIds.add(a.agentId);
    }
    let totalIssued = 0;
    let activeCount = 0;
    const earnerList: Array<{ accountId: string; balance: number }> = [];
    for (const accountId of knownAccountIds) {
      const bal = creditEngine.balance(accountId);
      if (bal > 0) {
        activeCount++;
        totalIssued += bal;
        earnerList.push({ accountId, balance: Number(bal.toFixed(3)) });
      }
    }
    creditSummary.totalCreditsIssued = Number(totalIssued.toFixed(3));
    creditSummary.activeAccounts = activeCount;
    creditSummary.recentTransactions = knownAccountIds.size;
    // Top 5 earners sorted by balance descending
    earnerList.sort((a, b) => b.balance - a.balance);
    creditSummary.topEarners = earnerList.slice(0, 5);
    // Daily credits for last 7 days from in-memory transaction history
    const dayMs = 86_400_000;
    for (const accountId of knownAccountIds) {
      const history = creditEngine.history(accountId);
      for (const tx of history) {
        if (tx.type === "earn") {
          const daysAgo = Math.floor((now - tx.timestampMs) / dayMs);
          if (daysAgo >= 0 && daysAgo < 7) {
            creditSummary.dailyCredits[6 - daysAgo] += tx.credits;
          }
        }
      }
    }
    creditSummary.dailyCredits = creditSummary.dailyCredits.map((v) => Number(v.toFixed(2)));

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

    // Build recent escalation timeline (last 10 resolved)
    const recentEscalations = allEscalations
      .filter((e) => e.status === "resolved" || e.status === "pending_human")
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .slice(0, 10)
      .map((e) => ({
        escalationId: e.escalationId,
        taskId: e.taskId,
        agentId: e.agentId,
        status: e.status,
        iterationsAttempted: e.iterationsAttempted,
        createdAtMs: e.createdAtMs,
        updatedAtMs: e.updatedAtMs,
        resolutionMs: e.status === "resolved" ? e.updatedAtMs - e.createdAtMs : 0,
      }));

    // Peer topology (best-effort, from network fetch above)
    let peerTopology: Array<{ peerId: string; role: string; latencyMs?: number }> = [];
    // Re-fetch peer details for topology -- use cached data from network summary fetch
    try {
      const { request: req2 } = await import("undici");
      const topoRes = await req2(`${coordinatorUrl}/mesh/peers`, {
        method: "GET",
        headers: coordinatorMeshHeaders(),
      }).catch(() => null);
      if (topoRes && topoRes.statusCode >= 200 && topoRes.statusCode < 300) {
        const topoData = (await topoRes.body.json()) as any;
        const peers = topoData.peers ?? [];
        peerTopology = peers.slice(0, 20).map((p: any) => ({
          peerId: p.peerId ?? p.id ?? "unknown",
          role: p.role ?? "agent",
          latencyMs: p.latencyMs ?? undefined,
        }));
      } else if (topoRes) {
        await topoRes.body.dump();
      }
    } catch {
      // best-effort
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
      network: {
        ...networkSummary,
        peerTopology,
      },
      credits: creditSummary,
      escalations: {
        pending: pendingEscalations,
        resolvedToday,
        avgResolutionMs,
        recent: recentEscalations,
      },
    });
  });
}

// ── HTML Template ──────────────────────────────────────────────────
function adminDashboardHtml(portalServiceUrl: string): string {
  const portalLink = portalServiceUrl
    ? `${portalServiceUrl.replace(/\/$/, "")}/portal/dashboard`
    : "";
  const reviewsLink = portalLink ? portalLink.replace("/dashboard", "/reviews") : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EdgeCoder Admin Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --card: #161b22; --card-hover: #1c2129; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff; --green: #3fb950;
    --orange: #d29922; --red: #f85149; --yellow: #d29922; --blue: #388bfd;
    --purple: #a371f7; --card-shadow: 0 1px 3px rgba(0,0,0,0.3);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  .container { max-width: 1280px; margin: 0 auto; padding: 24px 16px; }

  /* Header */
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
  .header-left { display: flex; align-items: center; gap: 12px; }
  .logo-text { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
  .logo-text .ec { color: var(--accent); }
  .version-tag { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--border); color: var(--muted); font-weight: 500; }
  header .badge { font-size: 12px; padding: 2px 8px; border-radius: 12px; background: var(--green); color: #000; font-weight: 600; }
  .nav-links { display: flex; gap: 12px; align-items: center; }
  .nav-links a { color: var(--accent); text-decoration: none; font-size: 13px; }
  .nav-links a:hover { text-decoration: underline; }

  /* Breadcrumb */
  .breadcrumb { font-size: 12px; color: var(--muted); margin-bottom: 16px; }
  .breadcrumb a { color: var(--accent); text-decoration: none; }
  .breadcrumb a:hover { text-decoration: underline; }
  .breadcrumb .sep { margin: 0 6px; }

  /* Last-updated indicator */
  .last-updated { font-size: 12px; color: var(--muted); margin-bottom: 20px; display: flex; align-items: center; gap: 8px; }
  .refresh-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--green); }

  /* Pulse animation on data update */
  @keyframes pulse-update { 0% { box-shadow: 0 0 0 0 rgba(88,166,255,0.4); } 70% { box-shadow: 0 0 0 6px rgba(88,166,255,0); } 100% { box-shadow: 0 0 0 0 rgba(88,166,255,0); } }
  .card.pulse { animation: pulse-update 0.6s ease-out; }

  /* Grid layouts */
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .grid-wide { display: grid; grid-template-columns: 1fr; gap: 16px; margin-bottom: 24px; }
  .grid-2col { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .grid-3col { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-bottom: 24px; }

  /* Cards */
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; box-shadow: var(--card-shadow); transition: border-color 0.2s, box-shadow 0.2s; }
  .card:hover { border-color: #3d444d; box-shadow: 0 2px 8px rgba(0,0,0,0.4); }
  .card h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); margin-bottom: 12px; }

  /* Stats */
  .stat { font-size: 28px; font-weight: 700; margin-bottom: 4px; }
  .stat-label { font-size: 13px; color: var(--muted); }
  .stat-row { display: flex; gap: 24px; flex-wrap: wrap; }
  .stat-item { text-align: center; }
  .stat-item .num { font-size: 24px; font-weight: 700; }
  .stat-item .lbl { font-size: 11px; color: var(--muted); text-transform: uppercase; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 10px; border-bottom: 2px solid var(--border); color: var(--muted); font-weight: 600; cursor: pointer; user-select: none; white-space: nowrap; }
  th:hover { color: var(--accent); }
  th .sort-arrow { font-size: 10px; margin-left: 4px; }
  td { padding: 8px 10px; border-bottom: 1px solid var(--border); }
  tr:last-child td { border-bottom: none; }
  tbody tr:nth-child(even) { background: rgba(255,255,255,0.02); }
  tbody tr:hover { background: rgba(88,166,255,0.06); }

  /* Agent filter bar */
  .filter-bar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; align-items: center; }
  .filter-bar input, .filter-bar select { background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 5px 10px; border-radius: 6px; font-size: 12px; outline: none; }
  .filter-bar input:focus, .filter-bar select:focus { border-color: var(--accent); }
  .filter-bar input { min-width: 200px; }

  /* Pagination */
  .pagination { display: flex; gap: 4px; align-items: center; justify-content: center; margin-top: 12px; font-size: 12px; }
  .pagination button { background: var(--border); color: var(--text); border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .pagination button:hover { background: var(--accent); }
  .pagination button.active { background: var(--accent); color: #fff; }
  .pagination button:disabled { opacity: 0.3; cursor: not-allowed; }
  .pagination .page-info { color: var(--muted); margin: 0 8px; }

  /* Status dots and badges */
  .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .status-dot.green { background: var(--green); }
  .status-dot.red { background: var(--red); }
  .status-dot.yellow { background: var(--yellow); }
  .mode-badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; display: inline-block; }
  .mode-swarm-only { background: var(--blue); color: #fff; }
  .mode-ide-enabled { background: var(--green); color: #000; }

  /* Progress bar */
  .progress-bar { background: var(--border); border-radius: 4px; height: 8px; overflow: hidden; margin-top: 4px; }
  .progress-fill { height: 100%; border-radius: 4px; background: var(--accent); transition: width 0.3s; }

  /* Rollouts */
  .rollout-item { padding: 12px 0; border-bottom: 1px solid var(--border); }
  .rollout-item:last-child { border-bottom: none; }
  .rollout-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; flex-wrap: wrap; gap: 8px; }
  .rollout-model { font-weight: 600; }
  .rollout-stage { font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; }
  .stage-canary { background: var(--yellow); color: #000; }
  .stage-batch { background: var(--orange); color: #000; }
  .stage-full { background: var(--green); color: #000; }
  .stage-paused { background: var(--muted); color: #fff; }
  .stage-rolled_back { background: var(--red); color: #fff; }
  .rollout-actions { display: flex; gap: 6px; margin-top: 8px; }
  .rollout-meta { font-size: 12px; color: var(--muted); margin-top: 4px; }

  /* Rollout timeline */
  .rollout-timeline { display: flex; align-items: center; gap: 0; margin: 8px 0; }
  .timeline-step { display: flex; align-items: center; gap: 0; }
  .timeline-node { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; border: 2px solid var(--border); background: var(--bg); color: var(--muted); position: relative; }
  .timeline-node.active { border-color: var(--accent); background: var(--accent); color: #fff; }
  .timeline-node.completed { border-color: var(--green); background: var(--green); color: #000; }
  .timeline-node.failed { border-color: var(--red); background: var(--red); color: #fff; }
  .timeline-connector { width: 32px; height: 2px; background: var(--border); }
  .timeline-connector.completed { background: var(--green); }
  .timeline-label { font-size: 9px; color: var(--muted); text-align: center; margin-top: 2px; }

  /* Buttons */
  button { background: var(--accent); color: #fff; border: none; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500; transition: opacity 0.15s; }
  button:hover { opacity: 0.9; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button.danger { background: var(--red); }
  button.small { padding: 3px 8px; font-size: 11px; }
  button.faucet { background: var(--purple); }
  .empty-state { color: var(--muted); font-size: 13px; font-style: italic; }

  /* Toast */
  .toast { position: fixed; bottom: 24px; right: 24px; background: var(--card); border: 1px solid var(--green); padding: 12px 20px; border-radius: 8px; font-size: 14px; display: none; z-index: 100; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
  .toast.error { border-color: var(--red); }
  #refresh-timer { font-size: 12px; color: var(--muted); }
  .section-title { font-size: 16px; font-weight: 600; margin-bottom: 12px; margin-top: 8px; }

  /* Confirmation dialog */
  .dialog-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); display: none; z-index: 200; align-items: center; justify-content: center; }
  .dialog-overlay.visible { display: flex; }
  .dialog { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; max-width: 400px; width: 90%; box-shadow: 0 8px 24px rgba(0,0,0,0.6); }
  .dialog h3 { font-size: 16px; margin-bottom: 12px; }
  .dialog p { font-size: 13px; color: var(--muted); margin-bottom: 20px; }
  .dialog-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .dialog-actions button { padding: 6px 16px; }
  .dialog-actions .cancel { background: var(--border); color: var(--text); }

  /* Credit bar chart */
  .credit-chart { display: flex; align-items: flex-end; gap: 4px; height: 60px; margin-top: 12px; }
  .credit-bar-wrapper { flex: 1; display: flex; flex-direction: column; align-items: center; }
  .credit-bar { width: 100%; background: var(--accent); border-radius: 2px 2px 0 0; min-height: 2px; transition: height 0.3s; }
  .credit-bar-label { font-size: 9px; color: var(--muted); margin-top: 3px; }

  /* Top earners */
  .earner-list { margin-top: 10px; }
  .earner-item { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; font-size: 12px; border-bottom: 1px solid var(--border); }
  .earner-item:last-child { border-bottom: none; }
  .earner-id { font-family: monospace; font-size: 11px; color: var(--text); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .earner-bal { font-weight: 600; color: var(--green); }

  /* Network topology */
  .peer-list { max-height: 180px; overflow-y: auto; }
  .peer-item { display: flex; justify-content: space-between; align-items: center; padding: 5px 0; font-size: 12px; border-bottom: 1px solid var(--border); }
  .peer-item:last-child { border-bottom: none; }
  .peer-role { font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 600; }
  .peer-role.coordinator { background: var(--accent); color: #fff; }
  .peer-role.agent { background: var(--border); color: var(--text); }
  .latency-indicator { font-size: 11px; font-family: monospace; }
  .latency-good { color: var(--green); }
  .latency-warn { color: var(--yellow); }
  .latency-bad { color: var(--red); }
  .gossip-rate { font-size: 12px; color: var(--muted); margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }

  /* Escalation timeline */
  .esc-timeline { max-height: 200px; overflow-y: auto; }
  .esc-item { display: flex; gap: 10px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
  .esc-item:last-child { border-bottom: none; }
  .esc-priority { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex-shrink: 0; }
  .esc-priority.high { background: var(--red); }
  .esc-priority.medium { background: var(--yellow); }
  .esc-priority.low { background: var(--green); }
  .esc-detail { flex: 1; min-width: 0; }
  .esc-detail .esc-task { font-family: monospace; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .esc-detail .esc-meta { font-size: 11px; color: var(--muted); }
  .esc-status-badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 600; }
  .esc-status-badge.resolved { background: var(--green); color: #000; }
  .esc-status-badge.pending { background: var(--yellow); color: #000; }

  /* Keyboard shortcut hint */
  .kbd-hints { font-size: 11px; color: var(--muted); margin-top: 16px; text-align: center; padding: 8px; border-top: 1px solid var(--border); }
  .kbd { display: inline-block; background: var(--border); padding: 1px 6px; border-radius: 3px; font-family: monospace; font-size: 11px; margin: 0 2px; }

  /* Responsive */
  @media (max-width: 768px) {
    .grid { grid-template-columns: repeat(2, 1fr); }
    .grid-2col, .grid-3col { grid-template-columns: 1fr; }
    header { flex-direction: column; gap: 12px; align-items: flex-start; }
    .nav-links { width: 100%; justify-content: flex-start; }
    .filter-bar { flex-direction: column; }
    .filter-bar input { min-width: 100%; }
    .rollout-header { flex-direction: column; align-items: flex-start; }
    table { font-size: 12px; }
    th, td { padding: 6px 6px; }
    .stat { font-size: 22px; }
  }
  @media (max-width: 480px) {
    .grid { grid-template-columns: 1fr; }
    .container { padding: 12px 8px; }
    .stat-row { gap: 12px; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="header-left">
      <span class="logo-text"><span class="ec">Edge</span>Coder</span>
      <span class="version-tag">v1.0.0</span>
      <span id="refresh-timer" style="font-size:12px;color:var(--muted);">Auto-refresh: 10s</span>
    </div>
    <div class="nav-links">
      ${portalLink ? '<a href="' + portalLink + '" target="_blank">Portal Dashboard</a>' : ""}
      ${reviewsLink ? '<a href="' + reviewsLink + '" target="_blank">Reviews</a>' : ""}
      <span id="uptime-badge" class="badge">Loading...</span>
    </div>
  </header>

  <!-- Breadcrumb -->
  <div class="breadcrumb">
    <a href="/admin/dashboard">Admin</a><span class="sep">/</span>Dashboard
  </div>

  <!-- Last updated -->
  <div class="last-updated">
    <span class="refresh-dot" id="refresh-dot"></span>
    <span id="last-updated-text">Loading...</span>
  </div>

  <!-- Overview Stats -->
  <div class="grid">
    <div class="card" id="card-agents">
      <h2>Total Agents</h2>
      <div class="stat" id="total-agents">--</div>
      <div class="stat-label"><span id="online-agents">--</span> online / <span id="offline-agents">--</span> offline</div>
    </div>
    <div class="card" id="card-tasks">
      <h2>Tasks</h2>
      <div class="stat" id="active-tasks">--</div>
      <div class="stat-label">active | <span id="queued-tasks">--</span> queued</div>
    </div>
    <div class="card" id="card-network">
      <h2>Network Mode</h2>
      <div class="stat" id="network-mode" style="font-size: 18px;">--</div>
      <div class="stat-label"><span id="coord-count">--</span> coordinators | <span id="peer-count">--</span> peers</div>
    </div>
    <div class="card" id="card-uptime">
      <h2>System Uptime</h2>
      <div class="stat" id="uptime">--</div>
      <div class="stat-label">since last restart</div>
    </div>
  </div>

  <!-- Credit Economy & Escalations & Network Health -->
  <div class="grid-3col">
    <div class="card" id="card-credits">
      <h2>Credit Economy</h2>
      <div class="stat-row">
        <div class="stat-item"><div class="num" id="credits-issued">--</div><div class="lbl">Credits Issued</div></div>
        <div class="stat-item"><div class="num" id="credits-accounts">--</div><div class="lbl">Active Accounts</div></div>
        <div class="stat-item"><div class="num" id="credits-txns">--</div><div class="lbl">Recent Txns</div></div>
      </div>
      <div class="credit-chart" id="credit-chart"></div>
      <div id="top-earners" class="earner-list"></div>
      <div style="margin-top:10px;">
        <button class="small faucet" onclick="faucetCredits()">Faucet (Testnet)</button>
      </div>
    </div>
    <div class="card" id="card-escalations">
      <h2>Human Escalations</h2>
      <div class="stat-row">
        <div class="stat-item"><div class="num" id="escalation-pending">--</div><div class="lbl">Pending</div></div>
        <div class="stat-item"><div class="num" id="escalation-resolved">--</div><div class="lbl">Resolved Today</div></div>
        <div class="stat-item"><div class="num" id="escalation-avg">--</div><div class="lbl">Avg Resolution</div></div>
      </div>
      <div id="escalation-timeline" class="esc-timeline" style="margin-top:12px;"></div>
      ${reviewsLink ? '<div style="margin-top:10px;"><a href="' + reviewsLink + '" target="_blank" style="color:var(--accent);font-size:12px;">View in Portal &rarr;</a></div>' : ""}
    </div>
    <div class="card" id="card-nethealth">
      <h2>Network Health</h2>
      <div id="peer-topology" class="peer-list"></div>
      <div class="gossip-rate" id="gossip-rate">Gossip rate: -- msg/min</div>
    </div>
  </div>

  <!-- Agent Table -->
  <div class="grid-wide">
    <div class="card" id="card-agent-table">
      <h2>Agents</h2>
      <div class="filter-bar">
        <input type="text" id="agent-search" placeholder="Search agent ID..." />
        <select id="agent-os-filter">
          <option value="">All OS</option>
          <option value="debian">Debian</option>
          <option value="ubuntu">Ubuntu</option>
          <option value="windows">Windows</option>
          <option value="macos">macOS</option>
          <option value="ios">iOS</option>
        </select>
        <select id="agent-status-filter">
          <option value="">All Status</option>
          <option value="healthy">Online</option>
          <option value="stale">Offline</option>
        </select>
      </div>
      <table id="agent-table">
        <thead>
          <tr>
            <th data-col="agentId">Agent ID <span class="sort-arrow"></span></th>
            <th data-col="os">OS <span class="sort-arrow"></span></th>
            <th data-col="health">Status <span class="sort-arrow"></span></th>
            <th data-col="localModelEnabled">Local Model <span class="sort-arrow"></span></th>
            <th data-col="mode">Mode <span class="sort-arrow"></span></th>
            <th data-col="uptime">Uptime <span class="sort-arrow"></span></th>
            <th data-col="lastSeenMs">Last Heartbeat <span class="sort-arrow"></span></th>
            <th data-col="version">Version <span class="sort-arrow"></span></th>
          </tr>
        </thead>
        <tbody id="agent-tbody">
          <tr><td colspan="8" class="empty-state">Loading...</td></tr>
        </tbody>
      </table>
      <div class="pagination" id="agent-pagination"></div>
    </div>
  </div>

  <!-- Rollout Status -->
  <div class="grid-wide">
    <div class="card" id="card-rollouts">
      <h2>Rollout Status</h2>
      <div id="rollout-list">
        <div class="empty-state">Loading...</div>
      </div>
    </div>
  </div>

  <!-- Keyboard shortcuts -->
  <div class="kbd-hints">
    <span class="kbd">R</span> Refresh &nbsp; <span class="kbd">Esc</span> Close dialogs
  </div>
</div>

<!-- Confirmation Dialog -->
<div class="dialog-overlay" id="confirm-dialog">
  <div class="dialog">
    <h3 id="dialog-title">Confirm Action</h3>
    <p id="dialog-message">Are you sure?</p>
    <div class="dialog-actions">
      <button class="cancel" onclick="closeDialog()">Cancel</button>
      <button id="dialog-confirm-btn" onclick="confirmDialogAction()">Confirm</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
var API = window.location.origin;
var currentData = null;
var sortCol = 'agentId';
var sortAsc = true;
var agentPage = 0;
var AGENTS_PER_PAGE = 20;
var lastRefreshTime = 0;
var lastRefreshTimer = null;
var pendingDialogAction = null;

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

function agentUptime(lastSeenMs) {
  // Estimate uptime from first-seen (lastSeenMs serves as proxy; real uptime would require registeredAt)
  var diff = Date.now() - lastSeenMs;
  if (diff < 0) diff = 0;
  return formatUptime(Math.floor(diff / 1000));
}

function updateLastUpdated() {
  if (!lastRefreshTime) return;
  var diff = Math.floor((Date.now() - lastRefreshTime) / 1000);
  var el = document.getElementById('last-updated-text');
  if (el) el.textContent = 'Last updated: ' + diff + 's ago';
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

function modeBadge(mode) {
  if (mode === 'ide-enabled') return '<span class="mode-badge mode-ide-enabled">ide-enabled</span>';
  return '<span class="mode-badge mode-swarm-only">swarm-only</span>';
}

function stageClass(stage) {
  return 'stage-' + stage;
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Dialog ──

function showDialog(title, message, btnText, btnClass, action) {
  document.getElementById('dialog-title').textContent = title;
  document.getElementById('dialog-message').textContent = message;
  var btn = document.getElementById('dialog-confirm-btn');
  btn.textContent = btnText;
  btn.className = btnClass || '';
  pendingDialogAction = action;
  document.getElementById('confirm-dialog').classList.add('visible');
}

function closeDialog() {
  document.getElementById('confirm-dialog').classList.remove('visible');
  pendingDialogAction = null;
}

function confirmDialogAction() {
  if (pendingDialogAction) pendingDialogAction();
  closeDialog();
}

// ── Filtering ──

function getFilteredAgents(agentList) {
  var search = (document.getElementById('agent-search').value || '').toLowerCase();
  var osFilter = document.getElementById('agent-os-filter').value;
  var statusFilter = document.getElementById('agent-status-filter').value;
  return agentList.filter(function(a) {
    if (search && a.agentId.toLowerCase().indexOf(search) === -1) return false;
    if (osFilter && a.os !== osFilter) return false;
    if (statusFilter && a.health !== statusFilter) return false;
    return true;
  });
}

// ── Agent Table ──

function renderAgents(agentList) {
  var tbody = document.getElementById('agent-tbody');
  if (!agentList || agentList.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No agents registered</td></tr>';
    document.getElementById('agent-pagination').innerHTML = '';
    return;
  }

  var filtered = getFilteredAgents(agentList);
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No agents match filters</td></tr>';
    document.getElementById('agent-pagination').innerHTML = '';
    return;
  }

  var sorted = filtered.slice().sort(function(a, b) {
    var va = a[sortCol], vb = b[sortCol];
    if (sortCol === 'uptime') { va = a.lastSeenMs; vb = b.lastSeenMs; }
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return sortAsc ? -1 : 1;
    if (va > vb) return sortAsc ? 1 : -1;
    return 0;
  });

  // Pagination
  var totalPages = Math.ceil(sorted.length / AGENTS_PER_PAGE);
  if (agentPage >= totalPages) agentPage = Math.max(0, totalPages - 1);
  var start = agentPage * AGENTS_PER_PAGE;
  var pageItems = sorted.slice(start, start + AGENTS_PER_PAGE);

  tbody.innerHTML = pageItems.map(function(a) {
    return '<tr>' +
      '<td style="font-family:monospace;font-size:12px;" title="' + escapeHtml(a.agentId) + '">' + escapeHtml(a.agentId) + '</td>' +
      '<td>' + escapeHtml(a.os) + '</td>' +
      '<td>' + statusDot(a.health) + '</td>' +
      '<td>' + (a.localModelEnabled ? 'Yes' : 'No') + '</td>' +
      '<td>' + modeBadge(a.mode) + '</td>' +
      '<td>' + (a.health === 'healthy' ? agentUptime(a.lastSeenMs) : '--') + '</td>' +
      '<td>' + timeAgo(a.lastSeenMs) + '</td>' +
      '<td>' + escapeHtml(a.version) + '</td>' +
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

  // Render pagination
  var pag = document.getElementById('agent-pagination');
  if (totalPages <= 1) {
    pag.innerHTML = '<span class="page-info">' + filtered.length + ' agents</span>';
    return;
  }
  var pagHtml = '<button ' + (agentPage === 0 ? 'disabled' : '') + ' onclick="agentPage=0;renderAgents(currentData.agents.list);">&laquo;</button>';
  pagHtml += '<button ' + (agentPage === 0 ? 'disabled' : '') + ' onclick="agentPage--;renderAgents(currentData.agents.list);">&lsaquo;</button>';
  for (var i = 0; i < totalPages; i++) {
    if (totalPages > 7 && Math.abs(i - agentPage) > 2 && i !== 0 && i !== totalPages - 1) {
      if (i === agentPage - 3 || i === agentPage + 3) pagHtml += '<span class="page-info">...</span>';
      continue;
    }
    pagHtml += '<button class="' + (i === agentPage ? 'active' : '') + '" onclick="agentPage=' + i + ';renderAgents(currentData.agents.list);">' + (i + 1) + '</button>';
  }
  pagHtml += '<button ' + (agentPage >= totalPages - 1 ? 'disabled' : '') + ' onclick="agentPage++;renderAgents(currentData.agents.list);">&rsaquo;</button>';
  pagHtml += '<button ' + (agentPage >= totalPages - 1 ? 'disabled' : '') + ' onclick="agentPage=' + (totalPages-1) + ';renderAgents(currentData.agents.list);">&raquo;</button>';
  pagHtml += '<span class="page-info">Page ' + (agentPage+1) + ' of ' + totalPages + ' (' + filtered.length + ' agents)</span>';
  pag.innerHTML = pagHtml;
}

// ── Rollout Timeline ──

function rolloutTimeline(stage) {
  var stages = ['canary', 'batch', 'full'];
  var currentIdx = stages.indexOf(stage);
  var isRolledBack = stage === 'rolled_back';

  return stages.map(function(s, i) {
    var nodeClass = 'timeline-node';
    if (isRolledBack) {
      nodeClass += ' failed';
    } else if (i < currentIdx) {
      nodeClass += ' completed';
    } else if (i === currentIdx) {
      nodeClass += ' active';
    }
    var connectorClass = 'timeline-connector';
    if (!isRolledBack && i < currentIdx) connectorClass += ' completed';

    var html = '<div class="timeline-step">';
    html += '<div style="display:flex;flex-direction:column;align-items:center;">';
    html += '<div class="' + nodeClass + '">' + (i + 1) + '</div>';
    html += '<div class="timeline-label">' + s + '</div>';
    html += '</div>';
    if (i < stages.length - 1) {
      html += '<div class="' + connectorClass + '"></div>';
    }
    html += '</div>';
    return html;
  }).join('');
}

// ── Rollouts ──

function renderRollouts(rollouts) {
  var container = document.getElementById('rollout-list');
  if (!rollouts || rollouts.length === 0) {
    container.innerHTML = '<div class="empty-state">No active rollouts</div>';
    return;
  }
  container.innerHTML = rollouts.map(function(r) {
    var canPromote = r.stage === 'canary' || r.stage === 'batch';
    var canRollback = r.stage !== 'rolled_back';
    var modelDisplay = r.modelId || r.rolloutId;
    var targetProvider = r.targetProvider || '';

    return '<div class="rollout-item">' +
      '<div class="rollout-header">' +
        '<span class="rollout-model">' + escapeHtml(modelDisplay) +
          (targetProvider ? ' <span style="color:var(--muted);font-size:11px;">(' + escapeHtml(targetProvider) + ')</span>' : '') +
          ' <span class="rollout-stage ' + stageClass(r.stage) + '">' + escapeHtml(r.stage) + '</span>' +
        '</span>' +
        '<span style="color:var(--muted);font-size:12px;">' + r.agentCount + ' agents | ' + r.progressPercent + '%</span>' +
      '</div>' +
      '<div class="rollout-timeline">' + rolloutTimeline(r.stage) + '</div>' +
      '<div class="progress-bar"><div class="progress-fill" style="width:' + r.progressPercent + '%;"></div></div>' +
      '<div class="rollout-meta">Rollout: ' + escapeHtml(r.rolloutId) + '</div>' +
      '<div class="rollout-actions">' +
        (canPromote ? '<button class="small" onclick="confirmPromote(\\'' + escapeHtml(r.rolloutId) + '\\')">Promote</button>' : '') +
        (canRollback ? '<button class="small danger" onclick="confirmRollback(\\'' + escapeHtml(r.rolloutId) + '\\')">Rollback</button>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

// ── Credit Chart ──

function renderCreditChart(dailyCredits) {
  var chart = document.getElementById('credit-chart');
  if (!dailyCredits || dailyCredits.length === 0) {
    chart.innerHTML = '<span class="empty-state">No data</span>';
    return;
  }
  var max = Math.max.apply(null, dailyCredits) || 1;
  var days = ['6d', '5d', '4d', '3d', '2d', '1d', 'Today'];
  chart.innerHTML = dailyCredits.map(function(v, i) {
    var h = Math.max(2, Math.round((v / max) * 50));
    return '<div class="credit-bar-wrapper">' +
      '<div class="credit-bar" style="height:' + h + 'px;" title="' + v + ' credits"></div>' +
      '<div class="credit-bar-label">' + days[i] + '</div>' +
    '</div>';
  }).join('');
}

function renderTopEarners(topEarners) {
  var el = document.getElementById('top-earners');
  if (!topEarners || topEarners.length === 0) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = '<div style="font-size:11px;color:var(--muted);margin-bottom:4px;font-weight:600;">TOP EARNERS</div>' +
    topEarners.map(function(e) {
      return '<div class="earner-item">' +
        '<span class="earner-id" title="' + escapeHtml(e.accountId) + '">' + escapeHtml(e.accountId) + '</span>' +
        '<span class="earner-bal">' + e.balance.toFixed(2) + '</span>' +
      '</div>';
    }).join('');
}

// ── Network Health ──

function renderPeerTopology(peerTopology) {
  var el = document.getElementById('peer-topology');
  if (!peerTopology || peerTopology.length === 0) {
    el.innerHTML = '<div class="empty-state">No peers connected</div>';
    return;
  }
  el.innerHTML = peerTopology.map(function(p) {
    var roleClass = p.role === 'coordinator' ? 'coordinator' : 'agent';
    var latencyHtml = '';
    if (typeof p.latencyMs === 'number') {
      var lClass = p.latencyMs < 50 ? 'latency-good' : (p.latencyMs < 200 ? 'latency-warn' : 'latency-bad');
      latencyHtml = '<span class="latency-indicator ' + lClass + '">' + p.latencyMs + 'ms</span>';
    }
    return '<div class="peer-item">' +
      '<span><span class="peer-role ' + roleClass + '">' + escapeHtml(p.role) + '</span> <span style="font-family:monospace;font-size:11px;">' + escapeHtml(p.peerId) + '</span></span>' +
      latencyHtml +
    '</div>';
  }).join('');
}

// ── Escalation Timeline ──

function renderEscalationTimeline(recent) {
  var el = document.getElementById('escalation-timeline');
  if (!recent || recent.length === 0) {
    el.innerHTML = '<div class="empty-state">No recent escalations</div>';
    return;
  }
  var portalReviewUrl = '${reviewsLink}';
  el.innerHTML = recent.map(function(e) {
    var priority = 'low';
    if (e.iterationsAttempted >= 5) priority = 'high';
    else if (e.iterationsAttempted >= 3) priority = 'medium';
    var statusClass = e.status === 'resolved' ? 'resolved' : 'pending';
    var resText = e.resolutionMs > 0 ? ' | Resolved in ' + formatMs(e.resolutionMs) : '';
    var reviewLink = portalReviewUrl ? '<a href="' + portalReviewUrl + '?id=' + encodeURIComponent(e.escalationId) + '" target="_blank" style="color:var(--accent);font-size:10px;margin-left:4px;">Open</a>' : '';
    return '<div class="esc-item">' +
      '<div class="esc-priority ' + priority + '" title="Priority: ' + priority + '"></div>' +
      '<div class="esc-detail">' +
        '<div class="esc-task" title="' + escapeHtml(e.taskId) + '">' + escapeHtml(e.taskId) + '</div>' +
        '<div class="esc-meta">Agent: ' + escapeHtml(e.agentId) + ' | ' + timeAgo(e.updatedAtMs) + resText + reviewLink + '</div>' +
      '</div>' +
      '<span class="esc-status-badge ' + statusClass + '">' + escapeHtml(e.status) + '</span>' +
    '</div>';
  }).join('');
}

// ── Rollout Actions with Confirmation ──

function confirmPromote(rolloutId) {
  showDialog(
    'Promote Rollout',
    'Are you sure you want to promote rollout "' + rolloutId + '" to the next stage?',
    'Promote',
    '',
    function() { promoteRollout(rolloutId); }
  );
}

function confirmRollback(rolloutId) {
  showDialog(
    'Rollback Rollout',
    'Are you sure you want to rollback rollout "' + rolloutId + '"? This will revert all agents.',
    'Rollback',
    'danger',
    function() { rollbackRollout(rolloutId); }
  );
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

// ── Faucet ──

async function faucetCredits() {
  var agentId = prompt('Enter agent ID to drip testnet credits:');
  if (!agentId) return;
  try {
    var res = await fetch(API + '/credits/adjust', {
      method: 'POST',
      headers: Object.assign({}, apiHeaders(), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ accountId: agentId, credits: 10, reason: 'testnet_faucet' })
    });
    if (res.ok) {
      toast('Dripped 10 credits to ' + agentId);
      await refresh();
    } else {
      var data = await res.json();
      toast('Faucet failed: ' + (data.error || res.status), true);
    }
  } catch (e) {
    toast('Faucet error: ' + e.message, true);
  }
}

// ── Pulse animation helper ──

function pulseCards() {
  var cards = document.querySelectorAll('.card');
  cards.forEach(function(c) {
    c.classList.remove('pulse');
    void c.offsetWidth; // force reflow
    c.classList.add('pulse');
  });
}

// ── Main Refresh ──

async function refresh() {
  try {
    var res = await fetch(API + '/admin/api/dashboard-data', { headers: apiHeaders() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    currentData = data;
    lastRefreshTime = Date.now();

    // Pulse animation
    pulseCards();

    // Last updated
    document.getElementById('last-updated-text').textContent = 'Last updated: just now';

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
    renderCreditChart(data.credits.dailyCredits);
    renderTopEarners(data.credits.topEarners);

    // Escalations
    document.getElementById('escalation-pending').textContent = data.escalations.pending;
    document.getElementById('escalation-resolved').textContent = data.escalations.resolvedToday;
    document.getElementById('escalation-avg').textContent = data.escalations.avgResolutionMs > 0 ? formatMs(data.escalations.avgResolutionMs) : '--';
    renderEscalationTimeline(data.escalations.recent);

    // Network health
    renderPeerTopology(data.network.peerTopology);
    // Approximate gossip rate: peers * 6 (gossip every ~10s)
    var gossipRate = (data.network.peerCount || 0) * 6;
    document.getElementById('gossip-rate').textContent = 'Gossip rate: ~' + gossipRate + ' msg/min';

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

// Filter event listeners
document.getElementById('agent-search').addEventListener('input', function() {
  agentPage = 0;
  if (currentData) renderAgents(currentData.agents.list);
});
document.getElementById('agent-os-filter').addEventListener('change', function() {
  agentPage = 0;
  if (currentData) renderAgents(currentData.agents.list);
});
document.getElementById('agent-status-filter').addEventListener('change', function() {
  agentPage = 0;
  if (currentData) renderAgents(currentData.agents.list);
});

// Keyboard shortcuts
document.addEventListener('keydown', function(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    refresh();
  }
  if (e.key === 'Escape') {
    closeDialog();
  }
});

// Update last-updated timer every second
setInterval(updateLastUpdated, 1000);

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;
}
