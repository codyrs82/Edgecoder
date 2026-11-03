// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { settingRow, settingsPage } from "./settings-shell.js";

/** Settings > Nodes (/portal/settings/nodes) and Settings > Admin (/portal/settings/admin). */
export function registerSettingsOpsPages(app: FastifyInstance): void {
app.get("/portal/settings/nodes", async (_req, reply) => {
  const content = `
    <div id="emailVerifyNote" class="callout warn hidden">
      <h3>Email verification required</h3>
      <div class="muted">Your account email is not verified yet. Verify it on the dashboard to fully activate enrolled nodes.</div>
    </div>
    <section class="set-section">
      <h2 class="set-title">Nodes</h2>
      <p class="set-lead">Machines enrolled to your account. Nodes become active after email verification and coordinator approval.</p>
      <div class="set-group">Enroll a node</div>
      <div class="set-card">
        ${settingRow("Node ID", "A name for the machine, e.g. mac-worker-001.", '<input id="nodeId" type="text" placeholder="mac-worker-001" />')}
        ${settingRow("Node type", "Agents run jobs; coordinators route them.", '<select id="nodeKind"><option value="agent">Agent</option><option value="coordinator">Coordinator</option></select>')}
        ${settingRow("Registration token", "Shown only once. Save it before leaving the page.", '<button class="primary" id="enrollBtn">Generate node token</button>')}
        <div id="newTokenWrap" class="hidden set-row wide"><div id="newToken" class="token-box"></div></div>
      </div>
      <div class="set-group">Your nodes</div>
      <div class="set-card">
        <div class="set-row wide">
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
    </section>
  `;
  const script = `
    function fmtTime(ms) { return ms ? new Date(ms).toISOString() : "n/a"; }
    function encodeAttr(v) { return encodeURIComponent(String(v || "")); }
    // escapeHtml comes from the app shell (pages/escape.ts); every node, owner and network field
    // below is user- or agent-supplied and goes through it before reaching innerHTML.
    function renderRows(targetId, rowsHtml, colspan, emptyText) {
      const body = document.getElementById(targetId);
      body.innerHTML = rowsHtml.length > 0 ? rowsHtml.join("") : "<tr><td colspan='" + colspan + "'>" + emptyText + "</td></tr>";
    }

    /* ── Nodes ── */
    let allNodes = [];
    function renderNodes(nodes) {
      const body = document.getElementById("nodesBody");
      const rows = (nodes || []).map((n) =>
        "<tr><td>" + escapeHtml(n.nodeId) + "</td><td>" + escapeHtml(n.nodeKind) + "</td><td>" + boolBadge(Boolean(n.emailVerified), "VERIFIED", "UNVERIFIED") + "</td><td>" +
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

    (async () => {
      const me = await requireAuth();
      revealSettingsAdminTab(me);
      const user = me.user || {};
      if (!user.emailVerified) document.getElementById("emailVerifyNote").classList.remove("hidden");
      await loadNodes();
    })().catch((err) => {
      showToast("Could not load nodes: " + String(err.message || err), true);
    });
  `;
  return reply.type("text/html").send(settingsPage("nodes", "Enroll nodes and track their activation.", content, script));
});

app.get("/portal/settings/admin", async (_req, reply) => {
  const content = `
    <h2 class="set-title">Admin</h2>
    <p class="set-lead">User management and node enrollment approvals.</p>
    <div id="adminDeniedNote" class="callout warn hidden">
      <h3>Admin access required</h3>
      <div class="muted">This section is only available to system administrators.</div>
    </div>
    <div id="userMgmtSection" class="hidden">
    <div class="card">
      <h2 style="margin-top:0;">User management</h2>
      <table>
        <thead><tr><th>Email</th><th>Role</th><th>Email verified</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody id="userMgmtBody"></tbody>
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
    </div>
  `;
  const script = `
    function fmtTime(ms) { return ms ? new Date(ms).toISOString() : "n/a"; }
    function encodeAttr(v) { return encodeURIComponent(String(v || "")); }
    // escapeHtml comes from the app shell (pages/escape.ts); every node, owner and network field
    // below is user- or agent-supplied and goes through it before reaching innerHTML.
    function renderRows(targetId, rowsHtml, colspan, emptyText) {
      const body = document.getElementById(targetId);
      body.innerHTML = rowsHtml.length > 0 ? rowsHtml.join("") : "<tr><td colspan='" + colspan + "'>" + emptyText + "</td></tr>";
    }

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
        "<tr><td>" + escapeHtml(n.nodeId) + "</td><td>" + escapeHtml(n.nodeKind) + "</td><td>" + escapeHtml(n.ownerEmail || "unknown") + "</td><td>" +
        String(Boolean(n.emailVerified)) + "</td><td>" + escapeHtml(n.sourceIp || "unknown") + "</td><td>" + escapeHtml(n.countryCode || "unknown") +
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
        return "<tr><td>" + escapeHtml(n.nodeId) + "</td><td>" + escapeHtml(n.nodeKind) + "</td><td>" + escapeHtml(n.ownerEmail || "unknown") + "</td><td>" +
          String(Boolean(n.emailVerified)) + "</td><td>" + (n.active === true ? "yes" : "no") + "</td><td>" + escapeHtml(n.sourceIp || "unknown") +
          "</td><td>" + escapeHtml(n.countryCode || "unknown") + "</td><td>" + (n.vpnDetected === true ? "yes" : "no") + "</td><td>" +
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
      const data = await api("/coordinator/ops/summary", { method: "GET", headers: {} });
      cachedPending = data.pendingNodes || [];
      cachedApproved = data.approvedNodes || [];
      canManageApprovals = Boolean(data.access && data.access.canManageApprovals);
      renderPending();
      renderApproved();
    }
    async function refreshApprovalsSafe() {
      try {
        await refreshOps();
      } catch (err) {
        document.getElementById("opsPendingNote").textContent = "Could not load enrollment requests: " + String(err.message || err) + " (auto-retrying)";
      }
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

    (async () => {
      const me = await requireAuth();
      revealSettingsAdminTab(me);
      const user = me.user || {};
      if (!(user.roles && user.roles.isSystemAdmin)) {
        document.getElementById("adminDeniedNote").classList.remove("hidden");
        return;
      }
      document.getElementById("userMgmtSection").classList.remove("hidden");
      document.getElementById("adminNodeApprovalSection").classList.remove("hidden");
      loadUserManagement();
      await refreshApprovalsSafe();
      setInterval(refreshApprovalsSafe, 15000);
    })().catch((err) => {
      showToast("Could not load admin settings: " + String(err.message || err), true);
    });
  `;
  return reply.type("text/html").send(settingsPage("admin", "User management and node enrollment approvals.", content, script));
});
}
