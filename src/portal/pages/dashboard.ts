// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { portalAuthedPageHtml } from "./layout.js";

// #16: moved verbatim from src/portal/server.ts.
export function registerDashboardPages(app: FastifyInstance): void {
app.get("/portal/dashboard", async (_req, reply) => {
  const content = `
    <style>
      .welcome-section {
        padding: 20px 0 12px;
      }
      .welcome-section h1 {
        margin: 0 0 4px; font-size: 22px; font-weight: 700;
        background: linear-gradient(135deg, var(--text), var(--brand));
        -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        background-clip: text;
      }
      .welcome-section .welcome-sub { color: var(--muted); font-size: 13px; margin: 0; }
      .quick-actions-grid {
        display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 10px;
      }
      .quick-action-card {
        display: flex; flex-direction: column; align-items: center; gap: 8px;
        padding: 18px 12px; text-align: center; text-decoration: none;
        background: var(--card); border: 1px solid var(--card-border);
        border-radius: var(--radius-md); color: var(--text);
        transition: all var(--transition-fast); cursor: pointer;
      }
      .quick-action-card:hover {
        border-color: var(--brand); transform: translateY(-2px);
        box-shadow: 0 6px 20px rgba(0,0,0,0.2);
      }
      .quick-action-card .qa-icon {
        font-size: 24px; width: 44px; height: 44px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 10px; background: rgba(193, 120, 80, 0.1);
      }
      .quick-action-card .qa-label { font-size: 13px; font-weight: 600; }
      .quick-action-card .qa-desc { font-size: 11px; color: var(--muted); line-height: 1.4; }
      .status-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 10px; }
      .status-card {
        display: flex; align-items: center; gap: 10px;
        padding: 12px 14px; background: var(--card);
        border: 1px solid var(--card-border); border-radius: var(--radius-md);
        transition: border-color var(--transition-fast);
      }
      .status-dot {
        width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
        animation: pulse 2s ease-in-out infinite;
      }
      .status-dot.green { background: var(--ok); box-shadow: 0 0 6px rgba(74, 222, 128, 0.4); }
      .status-dot.yellow { background: var(--yellow); box-shadow: 0 0 6px rgba(251, 191, 36, 0.4); }
      .status-dot.red { background: var(--danger); box-shadow: 0 0 6px rgba(248, 113, 113, 0.4); }
      .status-dot.gray { background: var(--muted); animation: none; }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
      .status-card .sc-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
      .status-card .sc-value { font-size: 13px; font-weight: 600; }
      .activity-feed { list-style: none; margin: 0; padding: 0; }
      .activity-feed li {
        display: flex; align-items: flex-start; gap: 10px;
        padding: 10px 0; border-bottom: 1px solid var(--card-border);
        font-size: 12px; animation: fadeSlideIn 0.3s ease both;
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
        .quick-actions-grid { grid-template-columns: repeat(2, 1fr); }
        .status-grid { grid-template-columns: 1fr; }
      }
      @media (max-width: 480px) {
        .quick-actions-grid { grid-template-columns: 1fr; }
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
    <div id="adminOpsSection" class="hidden">
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
    </div>
    <div id="userMgmtSection" class="hidden">
    <div class="card">
      <h2 style="margin-top:0;">User Management</h2>
      <table>
        <thead><tr><th>Email</th><th>Role</th><th>Email verified</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody id="userMgmtBody"></tbody>
      </table>
    </div>
    </div>
    <div id="emailVerifyCard" class="card hidden" style="border-color: rgba(245, 158, 11, 0.55); background: rgba(120, 53, 15, 0.22);">
      <h3 style="margin-top:0;">&#9888; Email verification required</h3>
      <div class="muted">Your account email is not verified yet. Verify it to fully activate enrolled nodes.</div>
      <div class="row" style="margin-top:10px;">
        <button class="primary" id="emailVerifyNowBtn">Send verification email</button>
      </div>
    </div>
    <!-- Quick Actions -->
    <div class="quick-actions-grid">
      <a href="/portal/chat" class="quick-action-card">
        <div class="qa-icon">&#9993;</div>
        <div class="qa-label">Open Chat</div>
        <div class="qa-desc">Talk to your AI assistant</div>
      </a>
      <a href="/portal/reviews" class="quick-action-card">
        <div class="qa-icon">&#9998;</div>
        <div class="qa-label">Code Reviews</div>
        <div class="qa-desc">Review escalated diffs</div>
      </a>
      <a href="/portal/wallet" class="quick-action-card">
        <div class="qa-icon">&#9733;</div>
        <div class="qa-label">Wallet</div>
        <div class="qa-desc">Credits, deposits, sends</div>
      </a>
      <a href="/portal/settings" class="quick-action-card">
        <div class="qa-icon">&#9881;</div>
        <div class="qa-label">Settings</div>
        <div class="qa-desc">Account and preferences</div>
      </a>
    </div>
    <!-- Recent Activity Feed -->
    <div class="card">
      <h3 style="margin-top:0;">&#9200; Recent Activity</h3>
      <ul class="activity-feed" id="activityFeed">
        <li><div class="af-icon">&#8987;</div><div class="af-text">Loading recent activity...</div></li>
      </ul>
    </div>
    <!-- Coordinator Operations -->
    <div class="card">
      <h2 style="margin-top:0;">Coordinator Operations</h2>
      <div id="opsAccountLine" class="muted"><span class="loading-spinner sm"></span> Loading operator session...</div>
      <div id="opsFinalityLine" class="muted">Loading finality state...</div>
      <div class="kpis">
        <div class="kpi"><div class="label">Connected agents</div><div class="value" id="opsAgentsValue">--</div></div>
        <div class="kpi"><div class="label">Queue depth</div><div class="value" id="opsQueueValue">--</div></div>
        <div class="kpi"><div class="label">Results</div><div class="value" id="opsResultsValue">--</div></div>
      </div>
    </div>
    <div class="grid2">
      <div class="card">
        <h2 style="margin-top:0;">Enroll node</h2>
        <label>Node ID</label><input id="nodeId" type="text" placeholder="mac-worker-001" />
        <label>Node type</label>
        <select id="nodeKind">
          <option value="agent">Agent</option>
          <option value="coordinator">Coordinator</option>
        </select>
        <div class="row">
          <button class="primary" id="enrollBtn">Generate node token</button>
        </div>
        <p class="muted">Save this token now. It is shown only once.</p>
        <div id="newTokenWrap" class="hidden">
          <div id="newToken" class="token-box"></div>
        </div>
      </div>
      <div class="card">
        <h2 style="margin-top:0;">Node activation states</h2>
        <p class="muted">Nodes become active after email verification and coordinator approval.</p>
        <div class="table-controls">
          <input id="nodesFilterInput" type="text" placeholder="Filter by node id or type" />
          <select id="nodesStatusFilter">
            <option value="all">All states</option>
            <option value="active">Active only</option>
            <option value="pending">Pending activation</option>
          </select>
          <select id="nodesSortOrder">
            <option value="asc">Node A-Z</option>
            <option value="desc">Node Z-A</option>
          </select>
        </div>
        <table>
          <thead><tr><th>Node</th><th>Type</th><th>Email verified</th><th>Approved</th><th>Active</th><th>Last seen</th><th>Actions</th></tr></thead>
          <tbody id="nodesBody"></tbody>
        </table>
      </div>
    </div>
    <div id="adminNodeApprovalSection" class="hidden">
    <div class="card">
      <h3 style="margin-top:0;">Coordinator enrollment requests</h3>
      <div class="row">
        <button class="primary" id="filterAllBtn">All pending</button>
        <button id="filterCoordinatorBtn">Coordinator enrollment requests</button>
        <button id="filterAgentBtn">Agent enrollment requests</button>
      </div>
      <table>
        <thead><tr><th>Node</th><th>Kind</th><th>Owner email</th><th>Email verified</th><th>IP</th><th>Country</th><th>VPN</th><th>Last seen</th><th>Actions</th></tr></thead>
        <tbody id="opsPendingBody"></tbody>
      </table>
      <div id="opsPendingNote" class="muted"></div>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">Approved nodes</h3>
      <div class="row">
        <button class="primary" id="approvedFilterAllBtn">All approved</button>
        <button id="approvedFilterCoordinatorBtn">Coordinators</button>
        <button id="approvedFilterAgentBtn">Agents</button>
        <button id="approvedFilterActiveBtn">Active only</button>
      </div>
      <table>
        <thead><tr><th>Node</th><th>Kind</th><th>Owner email</th><th>Email verified</th><th>Active</th><th>IP</th><th>Country</th><th>VPN</th><th>Last seen</th><th>Updated</th></tr></thead>
        <tbody id="opsApprovedBody"></tbody>
      </table>
      <div id="opsApprovedNote" class="muted"></div>
    </div>
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
    function fmtTime(ms) { return ms ? new Date(ms).toISOString() : "n/a"; }
    function encodeAttr(v) { return encodeURIComponent(String(v || "")); }
    function escapeHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
    function renderRows(targetId, rowsHtml, colspan, emptyText) {
      const body = document.getElementById(targetId);
      body.innerHTML = rowsHtml.length > 0 ? rowsHtml.join("") : "<tr><td colspan='" + colspan + "'>" + emptyText + "</td></tr>";
    }

    /* ── Nodes ── */
    let allNodes = [];
    function renderNodes(nodes) {
      const body = document.getElementById("nodesBody");
      const rows = (nodes || []).map((n) =>
        "<tr><td>" + n.nodeId + "</td><td>" + n.nodeKind + "</td><td>" + boolBadge(Boolean(n.emailVerified), "VERIFIED", "UNVERIFIED") + "</td><td>" +
        boolBadge(Boolean(n.nodeApproved), "APPROVED", "PENDING") + "</td><td>" + (n.active ? statusBadge("ACTIVE", "ok") : statusBadge("DORMANT", "warn")) +
        "</td><td>" + fmtTime(n.lastSeenMs) + "</td><td><button class='deleteNodeBtn' data-node-id='" + encodeAttr(n.nodeId) + "'>Delete</button></td></tr>"
      );
      body.innerHTML = rows.length > 0 ? rows.join("") : "<tr><td colspan='7'>No nodes enrolled.</td></tr>";
    }
    function applyNodeTableView() {
      const text = (document.getElementById("nodesFilterInput").value || "").trim().toLowerCase();
      const statusFilter = document.getElementById("nodesStatusFilter").value;
      const sortOrder = document.getElementById("nodesSortOrder").value;
      const filtered = (allNodes || []).filter((n) => {
        const matchesText = !text || String(n.nodeId).toLowerCase().includes(text) || String(n.nodeKind).toLowerCase().includes(text);
        const active = Boolean(n.active);
        const matchesStatus = statusFilter === "all" || (statusFilter === "active" ? active : !active);
        return matchesText && matchesStatus;
      });
      filtered.sort((a, b) => {
        const aa = String(a.nodeId || "").toLowerCase();
        const bb = String(b.nodeId || "").toLowerCase();
        if (sortOrder === "desc") return bb.localeCompare(aa);
        return aa.localeCompare(bb);
      });
      renderNodes(filtered);
    }
    async function loadNodes() {
      await requireAuth();
      const summary = await api("/dashboard/summary", { method: "GET", headers: {} });
      allNodes = summary.nodes || [];
      applyNodeTableView();
    }
    document.getElementById("nodesFilterInput").addEventListener("input", applyNodeTableView);
    document.getElementById("nodesStatusFilter").addEventListener("change", applyNodeTableView);
    document.getElementById("nodesSortOrder").addEventListener("change", applyNodeTableView);
    document.getElementById("nodesBody").addEventListener("click", async (event) => {
      const target = event.target;
      if (!target || !target.classList || !target.classList.contains("deleteNodeBtn")) return;
      const nodeIdRaw = target.getAttribute("data-node-id");
      if (!nodeIdRaw) return;
      const nodeId = decodeURIComponent(nodeIdRaw);
      if (!window.confirm("Delete node '" + nodeId + "'? This removes enrollment from your portal account.")) return;
      try {
        await api("/nodes/" + encodeURIComponent(nodeId), { method: "DELETE", headers: {} });
        showToast("Deleted node " + nodeId);
        await loadNodes();
      } catch (err) {
        showToast("Delete failed: " + String(err.message || err), true);
      }
    });
    document.getElementById("enrollBtn").addEventListener("click", async () => {
      try {
        await requireAuth();
        const payload = await api("/nodes/enroll", {
          method: "POST",
          body: JSON.stringify({
            nodeId: document.getElementById("nodeId").value,
            nodeKind: document.getElementById("nodeKind").value
          })
        });
        document.getElementById("newTokenWrap").classList.remove("hidden");
        document.getElementById("newToken").textContent = payload.registrationToken;
        await loadNodes();
        showToast("Node enrollment token generated.");
      } catch (err) {
        showToast("Enroll failed: " + String(err.message || err), true);
      }
    });

    /* ── Coordinator Ops ── */
    function filterPending(nodes, mode) {
      if (mode === "all") return nodes;
      return (nodes || []).filter((n) => String(n.nodeKind) === mode);
    }
    function filterApproved(nodes, mode, activeOnly) {
      let values = nodes || [];
      if (mode !== "all") values = values.filter((n) => String(n.nodeKind) === mode);
      if (activeOnly) values = values.filter((n) => n.active === true);
      return values;
    }
    let pendingFilter = "all";
    let approvedFilter = "all";
    let approvedActiveOnly = false;
    let cachedPending = [];
    let cachedApproved = [];
    let canManageApprovals = false;

    function renderPending() {
      const body = document.getElementById("opsPendingBody");
      const rows = filterPending(cachedPending, pendingFilter).map((n) =>
        "<tr><td>" + n.nodeId + "</td><td>" + n.nodeKind + "</td><td>" + (n.ownerEmail || "unknown") + "</td><td>" +
        String(Boolean(n.emailVerified)) + "</td><td>" + (n.sourceIp || "unknown") + "</td><td>" + (n.countryCode || "unknown") +
        "</td><td>" + (n.vpnDetected === true ? "yes" : "no") + "</td><td>" + fmtTime(n.lastSeenMs) + "</td><td>" +
        (canManageApprovals
          ? "<button class='approveBtn' data-node-id='" + encodeAttr(n.nodeId) + "' data-node-kind='" + encodeAttr(n.nodeKind) + "' data-approved='true'>Approve</button> <button class='approveBtn' data-node-id='" + encodeAttr(n.nodeId) + "' data-node-kind='" + encodeAttr(n.nodeKind) + "' data-approved='false'>Reject</button>"
          : "<span class='muted'>Read-only</span>") +
        "</td></tr>"
      );
      body.innerHTML = rows.length > 0 ? rows.join("") : "<tr><td colspan='9'>No pending nodes for this filter.</td></tr>";
      const counts = {
        all: cachedPending.length,
        coordinator: cachedPending.filter((n) => n.nodeKind === "coordinator").length,
        agent: cachedPending.filter((n) => n.nodeKind === "agent").length
      };
      document.getElementById("opsPendingNote").textContent = "Filter: " + pendingFilter + " | all=" + counts.all + " coordinator=" + counts.coordinator + " agent=" + counts.agent;
      document.getElementById("filterAllBtn").className = pendingFilter === "all" ? "primary" : "";
      document.getElementById("filterCoordinatorBtn").className = pendingFilter === "coordinator" ? "primary" : "";
      document.getElementById("filterAgentBtn").className = pendingFilter === "agent" ? "primary" : "";
    }

    function renderApproved() {
      const body = document.getElementById("opsApprovedBody");
      const rows = filterApproved(cachedApproved, approvedFilter, approvedActiveOnly).map((n) => {
        return "<tr><td>" + escapeHtml(n.nodeId) + "</td><td>" + n.nodeKind + "</td><td>" + (n.ownerEmail || "unknown") + "</td><td>" +
          String(Boolean(n.emailVerified)) + "</td><td>" + (n.active === true ? "yes" : "no") + "</td><td>" + (n.sourceIp || "unknown") +
          "</td><td>" + (n.countryCode || "unknown") + "</td><td>" + (n.vpnDetected === true ? "yes" : "no") + "</td><td>" +
          fmtTime(n.lastSeenMs) + "</td><td>" + fmtTime(n.updatedAtMs) + "</td></tr>";
      });
      body.innerHTML = rows.length > 0 ? rows.join("") : "<tr><td colspan='10'>No approved nodes for this filter.</td></tr>";
      const counts = {
        all: cachedApproved.length,
        coordinator: cachedApproved.filter((n) => n.nodeKind === "coordinator").length,
        agent: cachedApproved.filter((n) => n.nodeKind === "agent").length,
        active: cachedApproved.filter((n) => n.active === true).length
      };
      document.getElementById("opsApprovedNote").textContent =
        "Filter: " + approvedFilter + (approvedActiveOnly ? " + active-only" : "") +
        " | all=" + counts.all + " coordinator=" + counts.coordinator + " agent=" + counts.agent + " active=" + counts.active;
      document.getElementById("approvedFilterAllBtn").className = approvedFilter === "all" ? "primary" : "";
      document.getElementById("approvedFilterCoordinatorBtn").className = approvedFilter === "coordinator" ? "primary" : "";
      document.getElementById("approvedFilterAgentBtn").className = approvedFilter === "agent" ? "primary" : "";
      document.getElementById("approvedFilterActiveBtn").className = approvedActiveOnly ? "primary" : "";
    }

    async function refreshOps() {
      const me = await requireAuth();
      const user = me.user || {};
      const data = await api("/coordinator/ops/summary", { method: "GET", headers: {} });
      var agentCount = (data.status && data.status.agents) || 0;
      document.getElementById("opsAgentsValue").textContent = String(agentCount);
      document.getElementById("opsQueueValue").textContent = String((data.status && data.status.queued) || 0);
      document.getElementById("opsResultsValue").textContent = String((data.status && data.status.results) || 0);
      cachedPending = data.pendingNodes || [];
      cachedApproved = data.approvedNodes || [];
      canManageApprovals = Boolean(data.access && data.access.canManageApprovals);
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
      renderPending();
      renderApproved();
    }

    document.getElementById("filterAllBtn").addEventListener("click", () => { pendingFilter = "all"; renderPending(); });
    document.getElementById("filterCoordinatorBtn").addEventListener("click", () => { pendingFilter = "coordinator"; renderPending(); });
    document.getElementById("filterAgentBtn").addEventListener("click", () => { pendingFilter = "agent"; renderPending(); });
    document.getElementById("approvedFilterAllBtn").addEventListener("click", () => { approvedFilter = "all"; renderApproved(); });
    document.getElementById("approvedFilterCoordinatorBtn").addEventListener("click", () => { approvedFilter = "coordinator"; renderApproved(); });
    document.getElementById("approvedFilterAgentBtn").addEventListener("click", () => { approvedFilter = "agent"; renderApproved(); });
    document.getElementById("approvedFilterActiveBtn").addEventListener("click", () => { approvedActiveOnly = !approvedActiveOnly; renderApproved(); });

    document.getElementById("opsPendingBody").addEventListener("click", async (event) => {
      const target = event.target;
      if (!target || !target.classList || !target.classList.contains("approveBtn")) return;
      const coordinatorIdRaw = target.getAttribute("data-node-id");
      const nodeKindRaw = target.getAttribute("data-node-kind");
      if (!coordinatorIdRaw || !nodeKindRaw) return;
      const nodeId = decodeURIComponent(coordinatorIdRaw);
      const nodeKind = decodeURIComponent(nodeKindRaw);
      const approved = target.getAttribute("data-approved") === "true";
      try {
        await api("/coordinator/ops/node-approval", {
          method: "POST",
          body: JSON.stringify({ nodeId, nodeKind, approved })
        });
        showToast("Updated " + nodeKind + " " + nodeId + " to " + (approved ? "approved" : "rejected"));
        await refreshOps();
      } catch (err) {
        showToast("Approval failed: " + String(err.message || err), true);
      }
    });

    /* ── User management (admin only) ── */
    async function loadUserManagement() {
      try {
        const data = await api("/portal/api/admin/users", { method: "GET", headers: {} });
        const body = document.getElementById("userMgmtBody");
        const rows = (data.users || []).map(function(u) {
          const roleBtn = u.role === "admin"
            ? "<button class='userRoleBtn' data-uid='" + encodeAttr(u.userId) + "' data-role='user'>Remove Admin</button>"
            : "<button class='userRoleBtn primary' data-uid='" + encodeAttr(u.userId) + "' data-role='admin'>Make Admin</button>";
          return "<tr><td>" + escapeHtml(u.email) + "</td><td>" + escapeHtml(u.role) + "</td><td>" +
            boolBadge(Boolean(u.emailVerified), "VERIFIED", "UNVERIFIED") + "</td><td>" +
            fmtTime(u.createdAtMs) + "</td><td>" + roleBtn + "</td></tr>";
        });
        body.innerHTML = rows.length > 0 ? rows.join("") : "<tr><td colspan='5'>No users found.</td></tr>";
      } catch (err) {
        document.getElementById("userMgmtBody").innerHTML = "<tr><td colspan='5'>Failed to load users.</td></tr>";
      }
    }
    document.getElementById("userMgmtBody").addEventListener("click", async function(event) {
      var target = event.target;
      if (!target || !target.classList || !target.classList.contains("userRoleBtn")) return;
      var uid = target.getAttribute("data-uid");
      var role = target.getAttribute("data-role");
      if (!uid || !role) return;
      try {
        await api("/portal/api/admin/users/" + encodeURIComponent(uid) + "/role", {
          method: "POST",
          body: JSON.stringify({ role: role })
        });
        showToast("User role updated to " + role);
        await loadUserManagement();
      } catch (err) {
        showToast("Role update failed: " + String(err.message || err), true);
      }
    });

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
        feed.innerHTML = '<li><div class="af-icon">&#128203;</div><div class="af-text" style="color:var(--muted);">No recent activity. Start a chat or enroll a node to get going.</div></li>';
        return;
      }
      var html = "";
      for (var i = 0; i < items.length; i++) {
        var tx = items[i];
        var icon = tx.type === "earn" ? "&#9889;" : tx.type === "spend" ? "&#9733;" : "&#9654;";
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
        document.getElementById("adminNodeApprovalSection").classList.remove("hidden");
        document.getElementById("userMgmtSection").classList.remove("hidden");
        loadUserManagement();
      }

      /* populate nodes table from the same summary */
      allNodes = summary.nodes || [];
      applyNodeTableView();

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
    async function refreshOpsSafe() {
      try {
        await refreshOps();
      } catch (err) {
        const message = "Could not load coordinator operations: " + String(err.message || err);
        document.getElementById("opsAccountLine").textContent = message + " (auto-retrying)";
        document.getElementById("opsFinalityLine").textContent = "Stats ledger finality: unavailable";
        document.getElementById("opsAgentsValue").textContent = "-";
        document.getElementById("opsQueueValue").textContent = "-";
        document.getElementById("opsResultsValue").textContent = "-";
        showToast(message, true);
      }
    }
    refreshOpsSafe();
    setInterval(refreshOpsSafe, 15000);
  `;
  return reply.type("text/html").send(portalAuthedPageHtml({
    title: "EdgeCoder Portal | Dashboard",
    activeTab: "dashboard",
    heading: "Dashboard",
    subtitle: "High-level account and network view.",
    content,
    script
  }));
});

app.get("/portal/nodes", async (_req, reply) => {
  return reply.redirect("/portal/dashboard");
});

app.get("/portal/coordinator-ops", async (_req, reply) => {
  return reply.redirect("/portal/dashboard");
});
}
