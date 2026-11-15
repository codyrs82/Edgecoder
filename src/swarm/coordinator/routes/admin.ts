// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Admin plugin: every /admin/* route, behind authorizeAdmin.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { payoutsPausedByEnv } from "../../../economy/payout-safeguards.js";
import type { CoordinatorApp } from "../app.js";
import { queue, mesh } from "../context.js";
import { agentCapabilities, behaviorTracker, anomalyDetector, autoBlacklister } from "../agent-state.js";
import { authorizeAdmin } from "../auth.js";
import { payoutPause, payoutLimits, payoutReconcileConfig, payoutReconciler } from "../payouts.js";
import { revenueReport, withdrawRevenue } from "../revenue.js";
import { payoutRefusalStatus } from "../../../economy/revenue.js";

function adminDashboardHtml(status: { queued: number; agents: number; results: number }, agentList: Array<{ agentId: string; os?: string; provider?: string; maxConcurrentTasks?: number; modelCatalog?: string[] }>, nonce: string): string {
  const agentRows = agentList.map((a) =>
    `<tr><td>${esc(a.agentId)}</td><td>${esc(a.os ?? "-")}</td><td>${esc(a.provider ?? "-")}</td><td>${esc((a.modelCatalog ?? []).join(", ") || "-")}</td><td>${a.maxConcurrentTasks ?? 0}</td></tr>`
  ).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EdgeCoder Coordinator Admin</title>
<style>
  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff; --green: #3fb950; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  .container { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
  header { margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
  header h1 { font-size: 20px; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); margin-bottom: 12px; }
  .stat { font-size: 28px; font-weight: 700; }
  .stat-label { font-size: 13px; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; }
  #refresh-timer { font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>EdgeCoder Coordinator Admin</h1>
    <span id="refresh-timer">Auto-refresh: 10s</span>
  </header>
  <div class="grid">
    <div class="card"><h2>Connected Agents</h2><div class="stat" id="v-agents">${status.agents}</div></div>
    <div class="card"><h2>Queue Depth</h2><div class="stat" id="v-queued">${status.queued}</div></div>
    <div class="card"><h2>Results</h2><div class="stat" id="v-results">${status.results}</div></div>
    <div class="card"><h2>Uptime</h2><div class="stat" id="v-uptime">${Math.floor(process.uptime())}s</div></div>
    <div class="card"><h2>Memory</h2><div class="stat" id="v-mem">${Math.round(process.memoryUsage.rss() / 1_048_576)} MB</div></div>
    <div class="card"><h2>Mesh Peers</h2><div class="stat" id="v-peers">${mesh.listPeers().length}</div></div>
  </div>
  <div class="card" style="margin-bottom:24px;">
    <h2>Connected Agents</h2>
    <table>
      <thead><tr><th>Agent</th><th>OS</th><th>Provider</th><th>Models</th><th>Capacity</th></tr></thead>
      <tbody id="agent-body">${agentRows || "<tr><td colspan='5'>No agents connected.</td></tr>"}</tbody>
    </table>
  </div>
</div>
<script nonce="${nonce}">
// #40 review: the admin token is sent only in the x-admin-token header, never in the URL.
const TOKEN_KEY = "edgecoder_admin_token";
let token = sessionStorage.getItem(TOKEN_KEY) || "";
if (!token) {
  token = window.prompt("Admin token") || "";
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
}
async function refresh() {
  try {
    const res = await fetch("/admin/dashboard/api/overview", { headers: { "x-admin-token": token } });
    if (res.status === 401) { sessionStorage.removeItem(TOKEN_KEY); return; }
    const d = await res.json();
    document.getElementById("v-agents").textContent = d.coordinator.agents;
    document.getElementById("v-queued").textContent = d.coordinator.queued;
    document.getElementById("v-results").textContent = d.coordinator.results;
    document.getElementById("v-uptime").textContent = d.uptimeSeconds + "s";
    document.getElementById("v-mem").textContent = d.memoryMB + " MB";
    document.getElementById("v-peers").textContent = d.meshPeers;
    // Agent fields are agent-supplied: set as text, never parsed as HTML.
    const body = document.getElementById("agent-body");
    const row = function(cells, colspan) {
      const tr = document.createElement("tr");
      cells.forEach(function(text) {
        const td = document.createElement("td");
        if (colspan) td.colSpan = colspan;
        td.textContent = String(text);
        tr.appendChild(td);
      });
      return tr;
    };
    const rows = d.agents.length === 0
      ? [row(["No agents connected."], 5)]
      : d.agents.map(function(a) {
          return row([a.agentId || "-", a.os || "-", a.provider || "-", (a.modelCatalog || []).join(", ") || "-", a.maxConcurrentTasks || 0]);
        });
    body.replaceChildren.apply(body, rows);
  } catch(e) { console.error("refresh failed", e); }
}
setInterval(refresh, 10000);
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function registerAdminRoutes(app: CoordinatorApp): void {
  // #40: every /admin/* route lives in this plugin behind authorizeAdmin (in addition to the
  // per-route checks), so new admin routes can't forget it.
  app.register(async (admin) => {
  admin.addHook("onRequest", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return reply;
  });

  admin.get("/admin/dashboard", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return;
    const status = queue.status();
    const agentList = [...agentCapabilities.entries()].map(([agentId, info]) => ({
      agentId,
      os: info.os,
      provider: info.localModelProvider,
      maxConcurrentTasks: info.maxConcurrentTasks,
      modelCatalog: info.localModelCatalog
    }));
    // Agent fields are agent-supplied: the page renders them as text, and only its own script may run.
    const nonce = randomBytes(16).toString("base64");
    reply.header("content-security-policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    return reply.type("text/html").send(adminDashboardHtml(status, agentList, nonce));
  });

  admin.get("/admin/dashboard/api/overview", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return;
    const status = queue.status();
    const agentList = [...agentCapabilities.entries()].map(([agentId, info]) => ({
      agentId,
      os: info.os,
      provider: info.localModelProvider,
      maxConcurrentTasks: info.maxConcurrentTasks,
      modelCatalog: info.localModelCatalog
    }));
    return reply.send({
      coordinator: { queued: status.queued, agents: status.agents, results: status.results },
      agents: agentList,
      uptimeSeconds: Math.floor(process.uptime()),
      memoryMB: Math.round(process.memoryUsage.rss() / 1_048_576),
      meshPeers: mesh.listPeers().length
    });
  });

  // Payout kill switch: halts withdrawals, auto payouts and fee-pool distribution (purchases keep working).
  admin.get("/admin/payouts/pause", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return;
    return { ...(await payoutPause.state()), envForced: payoutsPausedByEnv(), limits: payoutLimits };
  });
  admin.post("/admin/payouts/pause", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return;
    const parsed = z.object({ paused: z.boolean(), reason: z.string().max(500).optional(), actor: z.string().max(128).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const actor = `admin:${parsed.data.actor ?? "token"}@${req.ip}`;
    if (parsed.data.paused) return { ok: true, state: await payoutPause.pause(parsed.data.reason ?? "paused by operator", "admin", actor) };
    const resumed = await payoutPause.resume(actor, parsed.data.reason);
    if (!resumed.ok) return reply.code(409).send({ ok: false, code: resumed.code, state: resumed.state });
    return resumed;
  });
  admin.get("/admin/payouts/reconciliation", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return;
    return { config: payoutReconcileConfig, webhookConfigured: Boolean(process.env.PAYOUT_ALERT_WEBHOOK_URL?.trim()), last: payoutReconciler.last() };
  });
  admin.post("/admin/payouts/reconciliation/run", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return;
    return payoutReconciler.run();
  });

  // EdgeCoder's revenue: the network fee pool (network:fee_pool). Withdrawals go through
  // PayoutService like any account's (caps, pause, earnings hold, reconciliation, ledger record).
  admin.get("/admin/revenue", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return;
    return revenueReport();
  });
  admin.post("/admin/revenue/withdraw", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return;
    const parsed = z.object({ bolt11: z.string().min(20).max(4096), actor: z.string().max(128).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "invalid_request", detail: parsed.error.issues.map((i) => i.message).join("; ") });
    const actor = `admin:${parsed.data.actor ?? "token"}@${req.ip}`;
    const result = await withdrawRevenue(parsed.data.bolt11.trim(), actor, req.ip);
    if (!result.ok) return reply.code(payoutRefusalStatus(result.code)).send(result);
    return result;
  });

  admin.get("/admin/agents/:agentId/behavior", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return;
    const params = z.object({ agentId: z.string() }).parse(req.params);
    const stats = behaviorTracker.getStats(params.agentId);
    if (!stats) {
      return reply.code(404).send({ error: "agent_not_found", agentId: params.agentId });
    }
    const anomalies = anomalyDetector.evaluate(stats);
    const strikeCount = autoBlacklister.getStrikeCount(params.agentId);
    return reply.send({ agentId: params.agentId, stats, anomalies, strikeCount });
  });
  });
}
