// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { portalAuthedPageHtml } from "./layout.js";
import { icon } from "./design-system.js";

// #16: moved verbatim from src/portal/server.ts.
export function registerDashboardPages(app: FastifyInstance): void {
app.get("/portal/dashboard", async (_req, reply) => {
  const content = `
    <style>
      .welcome-section { padding: 4px 0 16px; }
      .welcome-section h1 { margin: 0 0 4px; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
      .welcome-section .welcome-sub { color: var(--muted); font-size: 13px; margin: 0; }
      .status-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 10px; }
      .status-card {
        display: flex; align-items: center; gap: 10px;
        padding: 12px 14px; background: var(--card);
        border: 1px solid var(--card-border); border-radius: var(--radius-md);
        transition: border-color var(--transition-fast);
      }
      .status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
      .status-dot.green { background: var(--ok); }
      .status-dot.yellow { background: var(--yellow); }
      .status-dot.red { background: var(--danger); }
      .status-dot.gray { background: var(--muted); }
      .status-card .sc-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
      .status-card .sc-value { font-size: 13px; font-weight: 600; }
      .activity-feed { list-style: none; margin: 0; padding: 0; }
      .activity-feed li {
        display: flex; align-items: flex-start; gap: 10px;
        padding: 10px 0; border-bottom: 1px solid var(--card-border);
        font-size: 12px;
      }
      .activity-feed li:last-child { border-bottom: none; }
      .activity-feed .af-icon {
        width: 28px; height: 28px; border-radius: 6px;
        display: flex; align-items: center; justify-content: center;
        background: var(--bg-surface); font-size: 14px; flex-shrink: 0;
      }
      .activity-feed .af-text { flex: 1; color: var(--text-secondary); line-height: 1.5; }
      .activity-feed .af-text strong { color: var(--text); }
      .activity-feed .af-time { color: var(--muted); font-size: 10px; white-space: nowrap; }
      @media (max-width: 920px) {
        .status-grid { grid-template-columns: 1fr; }
      }
    </style>
    <!-- Welcome Section -->
    <div class="welcome-section">
      <h1 id="welcomeHeading">Welcome back</h1>
      <p class="welcome-sub" id="welcomeSub">Loading your dashboard...</p>
    </div>
    <!-- System Status Indicators -->
    <div class="status-grid" id="statusGrid">
      <div class="status-card">
        <div class="status-dot gray" id="statusCoordinator"></div>
        <div><div class="sc-label">Coordinator</div><div class="sc-value" id="statusCoordinatorText">Checking...</div></div>
      </div>
      <div class="status-card">
        <div class="status-dot gray" id="statusInference"></div>
        <div><div class="sc-label">Inference</div><div class="sc-value" id="statusInferenceText">Checking...</div></div>
      </div>
      <div class="status-card">
        <div class="status-dot gray" id="statusAgents"></div>
        <div><div class="sc-label">Connected Agents</div><div class="sc-value" id="statusAgentsText">--</div></div>
      </div>
    </div>
    <!-- Account Overview KPIs -->
    <div class="card">
      <h2 style="margin-top:0;">Account overview</h2>
      <div id="accountMeta" class="muted"><span class="loading-spinner sm"></span> Loading account...</div>
      <div class="kpis">
        <div class="kpi"><div class="label">Current credits</div><div class="value" id="creditsValue">--</div></div>
        <div class="kpi"><div class="label">Estimated sats</div><div class="value" id="creditsSatsValue">--</div></div>
        <div class="kpi"><div class="label">Enrolled nodes</div><div class="value" id="nodeCountValue">--</div></div>
        <div class="kpi"><div class="label">Tasks today</div><div class="value" id="tasksToday">--</div></div>
      </div>
    </div>
    <div id="adminOpsSection" class="hidden">
    </div>
    <div id="emailVerifyCard" class="callout warn hidden">
      <h3>Email verification required</h3>
      <div class="muted">Your account email is not verified yet. Verify it to fully activate enrolled nodes.</div>
      <div class="row" style="margin-top:10px;">
        <button class="primary" id="emailVerifyNowBtn">Send verification email</button>
      </div>
    </div>
    <!-- Recent Activity Feed -->
    <div class="card">
      <h3 style="margin-top:0;">Recent activity</h3>
      <ul class="activity-feed" id="activityFeed">
        <li><div class="af-icon">${icon("clock", 14)}</div><div class="af-text">Loading recent activity...</div></li>
      </ul>
    </div>
    <!-- Coordinator Operations (coordinator operators and system admins only) -->
    <div class="card hidden" id="coordOpsCard">
      <h2 style="margin-top:0;">Coordinator Operations</h2>
      <div id="opsAccountLine" class="muted"><span class="loading-spinner sm"></span> Loading operator session...</div>
      <div id="opsFinalityLine" class="muted">Loading finality state...</div>
      <div class="kpis">
        <div class="kpi"><div class="label">Connected agents</div><div class="value" id="opsAgentsValue">--</div></div>
        <div class="kpi"><div class="label">Queue depth</div><div class="value" id="opsQueueValue">--</div></div>
        <div class="kpi"><div class="label">Results</div><div class="value" id="opsResultsValue">--</div></div>
      </div>
    </div>
    <div id="adminInsightsSection" class="hidden">
    <div class="card">
      <h3 style="margin-top:0;">Live issuance (rolling 24h)</h3>
      <div class="kpis">
        <div class="kpi"><div class="label">Daily pool</div><div class="value" id="issuancePoolValue">-</div></div>
        <div class="kpi"><div class="label">Load index</div><div class="value" id="issuanceLoadValue">-</div></div>
        <div class="kpi"><div class="label">Contributors</div><div class="value" id="issuanceContribValue">-</div></div>
      </div>
      <table>
        <thead><tr><th>Account</th><th>Share</th><th>Hourly tokens</th><th>Weighted contribution</th></tr></thead>
        <tbody id="issuanceAllocBody"></tbody>
      </table>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">Decentralized local model mesh</h3>
      <div id="modelMeshMeta" class="muted">Loading model-serving agents...</div>
      <table>
        <thead><tr><th>Agent</th><th>Provider</th><th>Model catalog</th><th>Capacity</th></tr></thead>
        <tbody id="modelMeshBody"></tbody>
      </table>
    </div>
    </div>
  `;
  const script = `
    function fmtFixed(v, digits) {
      const n = Number(v);
      return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
    }
    function escapeHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
    function renderRows(targetId, rowsHtml, colspan, emptyText) {
      const body = document.getElementById(targetId);
      body.innerHTML = rowsHtml.length > 0 ? rowsHtml.join("") : "<tr><td colspan='" + colspan + "'>" + emptyText + "</td></tr>";
    }

    /* ── Coordinator Ops summary ── */
    async function refreshOps() {
      const me = await requireAuth();
      const user = me.user || {};
      const data = await api("/coordinator/ops/summary", { method: "GET", headers: {} });
      var agentCount = (data.status && data.status.agents) || 0;
      document.getElementById("opsAgentsValue").textContent = String(agentCount);
      document.getElementById("opsQueueValue").textContent = String((data.status && data.status.queued) || 0);
      document.getElementById("opsResultsValue").textContent = String((data.status && data.status.results) || 0);
      const scopeText = data.access && data.access.isSystemAdmin ? "global scope" : "owner scope";
      const federationState = data.federation && data.federation.stale ? "stale federation" : "federation healthy";
      const finalityRaw = String((data.federation && data.federation.finalityState) || "unknown");
      const finalityLabel =
        finalityRaw === "anchored_confirmed"
          ? "hard finalized (Bitcoin anchor confirmed)"
          : finalityRaw === "anchored_pending"
            ? "soft finalized (anchor pending)"
            : finalityRaw === "soft_finalized"
              ? "soft finalized (quorum commit)"
              : finalityRaw === "no_checkpoint"
                ? "no checkpoint yet"
                : finalityRaw === "stale_federation"
                  ? "stale federation (checkpoint disagreement)"
                  : "finality unknown";
      const anchorTxRef = data.federation && data.federation.anchorTxRef ? String(data.federation.anchorTxRef) : "n/a";
      document.getElementById("opsAccountLine").textContent =
        (user.email || "unknown") + " | coordinator operations access | " + scopeText + " | " + federationState;
      document.getElementById("opsFinalityLine").textContent =
        "Stats ledger finality: " + finalityLabel + " | anchor tx: " + anchorTxRef;
      /* Update status indicators */
      var coordDot = document.getElementById("statusCoordinator");
      var coordText = document.getElementById("statusCoordinatorText");
      if (!data.federation || data.federation.stale) {
        coordDot.className = "status-dot yellow";
        coordText.textContent = "Degraded";
      } else {
        coordDot.className = "status-dot green";
        coordText.textContent = "Online";
      }
      var infDot = document.getElementById("statusInference");
      var infText = document.getElementById("statusInferenceText");
      if (agentCount > 0) {
        infDot.className = "status-dot green";
        infText.textContent = "Healthy";
      } else {
        infDot.className = "status-dot yellow";
        infText.textContent = "No agents";
      }
      var agDot = document.getElementById("statusAgents");
      document.getElementById("statusAgentsText").textContent = String(agentCount);
      agDot.className = agentCount > 0 ? "status-dot green" : "status-dot gray";
    }

    /* ── Status cards (every signed-in user; operators also get them from refreshOps) ── */
    async function refreshStatus() {
      const s = await api("/dashboard/network-status", { method: "GET", headers: {} });
      document.getElementById("statusCoordinator").className = "status-dot " + (s.coordinatorOnline ? "green" : "red");
      document.getElementById("statusCoordinatorText").textContent = s.coordinatorOnline ? "Online" : "Unreachable";
      const agents = Number(s.agents || 0);
      document.getElementById("statusInference").className = "status-dot " + (!s.coordinatorOnline ? "gray" : agents > 0 ? "green" : "yellow");
      document.getElementById("statusInferenceText").textContent = !s.coordinatorOnline ? "Unknown" : agents > 0 ? "Healthy" : "No agents";
      document.getElementById("statusAgents").className = "status-dot " + (agents > 0 ? "green" : "gray");
      document.getElementById("statusAgentsText").textContent = String(agents);
    }
    function refreshStatusSafe() {
      refreshStatus().catch(() => {
        document.getElementById("statusCoordinatorText").textContent = "Unavailable";
        document.getElementById("statusInferenceText").textContent = "Unavailable";
      });
    }
    refreshStatusSafe();
    setInterval(refreshStatusSafe, 30000);

    /* ── Dashboard main load ── */
    function timeAgo(ms) {
      if (!ms) return "";
      var diff = Date.now() - ms;
      if (diff < 60000) return "just now";
      if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
      if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
      return Math.floor(diff / 86400000) + "d ago";
    }
    function renderActivityFeed(history) {
      var feed = document.getElementById("activityFeed");
      var items = (history || []).slice(0, 5);
      if (items.length === 0) {
        feed.innerHTML = '<li><div class="af-icon">${icon("clock", 14)}</div><div class="af-text" style="color:var(--muted);">No recent activity. Start a chat or enroll a node to get going.</div></li>';
        return;
      }
      var html = "";
      for (var i = 0; i < items.length; i++) {
        var tx = items[i];
        var icon = tx.type === "earn" ? '${icon("zap", 14)}' : tx.type === "spend" ? '${icon("arrowRight", 14)}' : '${icon("bitcoin", 14)}';
        var desc = tx.reason === "compute_contribution" ? "<strong>Compute contribution</strong> earned" :
                   tx.reason === "task_completion" ? "<strong>Task completed</strong>" :
                   tx.reason === "credit_purchase" ? "<strong>Credits purchased</strong>" :
                   "<strong>" + escapeHtml(tx.reason || "Activity") + "</strong>";
        var amount = tx.credits ? " <strong>" + (tx.type === "earn" ? "+" : "-") + String(tx.credits) + "</strong> credits" : "";
        var time = timeAgo(tx.createdAtMs || tx.timestamp);
        html += '<li><div class="af-icon">' + icon + '</div><div class="af-text">' + desc + amount + '</div><div class="af-time">' + time + '</div></li>';
      }
      feed.innerHTML = html;
    }
    (async () => {
      const me = await requireAuth();
      const summary = await api("/dashboard/summary", { method: "GET", headers: {} });
      const insights = await api("/dashboard/network-insights", { method: "GET", headers: {} });
      const user = me.user || {};
      const emailVerified = Boolean(user.emailVerified);
      /* Welcome section */
      var displayName = user.displayName || user.email || "there";
      if (displayName.includes("@")) displayName = displayName.split("@")[0];
      var hour = new Date().getHours();
      var greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
      document.getElementById("welcomeHeading").textContent = greeting + ", " + displayName;
      document.getElementById("welcomeSub").textContent =
        "Signed in as " + (user.email || "unknown") + (emailVerified ? "" : " (unverified)");
      const isAdmin = Boolean(user.roles && user.roles.isSystemAdmin);
      document.getElementById("accountMeta").textContent =
        (user.email || "unknown") + " | email verified: " + String(emailVerified);
      const credits = (summary.walletSnapshot || {}).credits;
      document.getElementById("creditsValue").textContent =
        credits && typeof credits.balance !== "undefined" ? String(credits.balance) : "n/a";
      const quote = (summary.walletSnapshot || {}).quote;
      document.getElementById("creditsSatsValue").textContent =
        quote && typeof quote.estimatedSats !== "undefined" ? String(quote.estimatedSats) : "n/a";
      document.getElementById("nodeCountValue").textContent = String((summary.nodes || []).length);
      /* Tasks today */
      var creditHistory = ((summary.walletSnapshot || {}).creditHistory || []);
      var todayStart = new Date(); todayStart.setHours(0,0,0,0);
      var todayMs = todayStart.getTime();
      var tasksToday = creditHistory.filter(function(tx) {
        return (tx.reason === "compute_contribution" || tx.reason === "task_completion") && Number(tx.createdAtMs || tx.timestamp || 0) >= todayMs;
      }).length;
      document.getElementById("tasksToday").textContent = String(tasksToday);
      /* Populate activity feed */
      renderActivityFeed(creditHistory);

      /* show admin-only sections */
      if (isAdmin) {
        document.getElementById("adminOpsSection").classList.remove("hidden");
        document.getElementById("adminInsightsSection").classList.remove("hidden");
      }

      const issuance = insights.issuance || {};
      const epoch = issuance.epoch || null;
      document.getElementById("issuancePoolValue").textContent = epoch ? fmtFixed(epoch.dailyPoolTokens, 3) : "n/a";
      document.getElementById("issuanceLoadValue").textContent = epoch ? fmtFixed(epoch.loadIndex, 4) : "n/a";
      document.getElementById("issuanceContribValue").textContent = epoch ? String(epoch.contributionCount || 0) : "0";
      const allocRows = ((issuance.allocations || []).slice(0, 8)).map((row) =>
        "<tr><td>" + String(row.accountId || "-") + "</td><td>" + fmtFixed((Number(row.allocationShare || 0) * 100), 2) + "%</td><td>" +
        fmtFixed(row.issuedTokens, 6) + "</td><td>" + fmtFixed(row.weightedContribution, 4) + "</td></tr>"
      );
      renderRows("issuanceAllocBody", allocRows, 4, "No issuance allocations available yet.");

      const modelMesh = insights.modelMesh || {};
      const models = modelMesh.models || [];
      document.getElementById("modelMeshMeta").textContent =
        "Model-serving agents online: " + String(models.length) +
        (modelMesh.generatedAtMs ? " | updated " + new Date(modelMesh.generatedAtMs).toISOString() : "");
      const modelRows = models.slice(0, 12).map((m) =>
        "<tr><td>" + String(m.agentId || "-") + "</td><td>" + String(m.provider || "-") + "</td><td>" +
        String((m.modelCatalog || []).join(", ") || "-") + "</td><td>" + String(m.maxConcurrentTasks || 0) + "</td></tr>"
      );
      renderRows("modelMeshBody", modelRows, 4, "No model-serving agents advertising yet.");

      const emailVerifyCard = document.getElementById("emailVerifyCard");
      const emailVerifyNowBtn = document.getElementById("emailVerifyNowBtn");
      if (!emailVerified) {
        emailVerifyCard.classList.remove("hidden");
        emailVerifyNowBtn.addEventListener("click", async () => {
          try {
            const payload = await api("/auth/resend-verification", {
              method: "POST",
              body: JSON.stringify({ email: user.email || "" })
            });
            if (payload && payload.alreadyVerified) {
              showToast("Your email is already verified.");
            } else {
              showToast("Verification email sent. Check your inbox.");
            }
          } catch (err) {
            showToast("Could not send verification email: " + String(err.message || err), true);
          }
        });
      } else {
        emailVerifyCard.classList.add("hidden");
      }
    })().catch((err) => {
      showToast("Could not load dashboard: " + String(err.message || err), true);
    });

    /* ── Coordinator Ops load + refresh ── */
    let opsTimer = null;
    async function refreshOpsSafe() {
      try {
        await refreshOps();
      } catch (err) {
        // Not an operator after all: hide the card quietly and stop asking.
        if (/forbidden|403/.test(String(err.message || err))) {
          document.getElementById("coordOpsCard").classList.add("hidden");
          if (opsTimer) clearInterval(opsTimer);
          return;
        }
        const message = "Could not load coordinator operations: " + String(err.message || err);
        document.getElementById("opsAccountLine").textContent = message + " (auto-retrying)";
        document.getElementById("opsFinalityLine").textContent = "Stats ledger finality: unavailable";
        document.getElementById("opsAgentsValue").textContent = "-";
        document.getElementById("opsQueueValue").textContent = "-";
        document.getElementById("opsResultsValue").textContent = "-";
        showToast(message, true);
      }
    }
    (async () => {
      const me = await requireAuth();
      const roles = (me.user || {}).roles || {};
      if (!roles.isSystemAdmin && !roles.isCoordinatorAdmin) return;
      document.getElementById("coordOpsCard").classList.remove("hidden");
      refreshOpsSafe();
      opsTimer = setInterval(refreshOpsSafe, 15000);
    })().catch(() => undefined);
  `;
  return reply.type("text/html").send(portalAuthedPageHtml({
    title: "EdgeCoder Portal | Dashboard",
    activeTab: "dashboard",
    heading: "Overview",
    subtitle: "High-level account and network view.",
    content,
    script
  }));
});
}
