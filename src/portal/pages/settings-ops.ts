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
      <div class="callout" id="hostStatusNote">
        <h3 id="hostStatusTitle">My machines run your own work, free</h3>
        <div class="muted" id="hostStatusText">Hosting for others is by request during early access. <a href="/host#request">Request to host</a>.</div>
      </div>
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
    function encodeAttr(v) { return encodeURIComponent(String(v || "")).replace(/'/g, "%27"); }
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
      // Host approval (src/portal/host-requests.ts): approved hosts' machines also take other people's work.
      api("/portal/api/host/status", { method: "GET", headers: {} }).then(function(st) {
        if (!st || !st.required || !st.approved) return;
        document.getElementById("hostStatusTitle").textContent = "Approved host";
        document.getElementById("hostStatusText").textContent = "Your account is an approved early-access host: your agents run your own work and take work from the network.";
      }).catch(function() {});
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
    <p class="set-lead">Early access invites, host requests, user management and node enrollment approvals.</p>
    <div id="adminDeniedNote" class="callout warn hidden">
      <h3>Admin access required</h3>
      <div class="muted">This section is only available to system administrators.</div>
    </div>
    <div id="inviteSection" class="hidden">
    <div class="card">
      <h2 class="u-mt-0">Early access</h2>
      <p class="muted" id="inviteModeNote">Loading launch mode…</p>
      <div class="row">
        <input id="inviteLabel" type="text" maxlength="80" placeholder="Label, e.g. who it is for" aria-label="Invite label" />
        <input id="inviteMaxUses" type="number" min="1" max="1000" step="1" value="1" aria-label="Number of uses" title="Number of accounts the code can create" />
        <input id="inviteExpiresDays" type="number" min="1" max="365" step="1" placeholder="Days valid (blank: no expiry)" aria-label="Days until it expires" />
        <button class="primary" id="mintInviteBtn">Create invite code</button>
      </div>
      <div id="newInviteWrap" class="hidden u-mt-10">
        <div class="muted">Shown only once. Send it, or the sign-up link, to the person you invite.</div>
        <div id="newInviteCode" class="token-box"></div>
        <div id="newInviteLink" class="token-box"></div>
      </div>
      <table>
        <thead><tr><th>Code</th><th>Label</th><th>Uses</th><th>Expires</th><th>Status</th><th>Created by</th><th>Actions</th></tr></thead>
        <tbody id="inviteBody"></tbody>
      </table>
    </div>
    </div>
    <div id="hostRequestSection" class="hidden">
    <div class="card" id="hostRequests">
      <h2 class="u-mt-0">Host requests</h2>
      <p class="muted" id="hostGateNote">Loading…</p>
      <table>
        <thead><tr><th>Received</th><th>Who</th><th>Would host</th><th>Hardware / region</th><th>Message</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead>
        <tbody id="hostRequestBody"></tbody>
      </table>
      <div id="hostInviteWrap" class="hidden u-mt-10">
        <div class="muted" id="hostInviteNote">Invite code for the approved host, shown only once.</div>
        <div id="hostInviteCode" class="token-box"></div>
      </div>
    </div>
    <div class="card">
      <h3 class="u-mt-0">Approved hosts</h3>
      <p class="muted">Accounts with these emails may take other people's work. Everyone else's machines run only their own work.</p>
      <div class="row">
        <input id="hostApproveEmail" type="email" maxlength="254" placeholder="host@example.com" aria-label="Host email" />
        <input id="hostApproveNote" type="text" maxlength="200" placeholder="Note (optional)" aria-label="Note" />
        <button class="primary" id="hostApproveBtn">Approve host</button>
      </div>
      <table>
        <thead><tr><th>Email</th><th>Source</th><th>Approved</th><th>By</th><th>Note</th><th>Actions</th></tr></thead>
        <tbody id="hostListBody"></tbody>
      </table>
    </div>
    </div>
    <div id="userMgmtSection" class="hidden">
    <div class="card">
      <h2 class="u-mt-0">User management</h2>
      <table>
        <thead><tr><th>Email</th><th>Role</th><th>Email verified</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody id="userMgmtBody"></tbody>
      </table>
    </div>
    </div>
    <div id="adminNodeApprovalSection" class="hidden">
    <div class="card">
      <h3 class="u-mt-0">Coordinator enrollment requests</h3>
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
      <h3 class="u-mt-0">Approved nodes</h3>
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
    function encodeAttr(v) { return encodeURIComponent(String(v || "")).replace(/'/g, "%27"); }
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

    /* ── Early access: invite codes (admin only; src/portal/invites.ts) ── */
    const INVITE_STATUS = { active: ["ACTIVE", "ok"], used_up: ["USED UP", "warn"], expired: ["EXPIRED", "warn"], revoked: ["REVOKED", "warn"] };
    async function loadInvites() {
      try {
        const data = await api("/portal/api/admin/invites", { method: "GET", headers: {} });
        document.getElementById("inviteModeNote").textContent = data.launchMode === "invite"
          ? "Invite-only (LAUNCH_MODE=invite): new accounts need one of these codes. Existing accounts are not affected."
          : "Open (LAUNCH_MODE=open): anyone can sign up. Codes you create here start to matter once LAUNCH_MODE=invite is set.";
        const rows = (data.invites || []).map(function(i) {
          const st = INVITE_STATUS[i.status] || [String(i.status), "warn"];
          const action = i.status === "revoked" ? "<span class='muted'>–</span>" : "<button class='revokeInviteBtn' data-code-id='" + encodeAttr(i.codeId) + "'>Revoke</button>";
          return "<tr><td><code>" + escapeHtml(i.prefix) + "-…</code></td><td>" + escapeHtml(i.label || "") + "</td><td>" + Number(i.uses) + " / " + Number(i.maxUses) +
            "</td><td>" + (i.expiresAtMs ? fmtTime(i.expiresAtMs) : "never") + "</td><td>" + statusBadge(st[0], st[1]) + "</td><td>" + escapeHtml(i.createdBy) +
            "</td><td>" + action + "</td></tr>";
        });
        renderRows("inviteBody", rows, 7, "No invite codes yet.");
      } catch (err) {
        renderRows("inviteBody", [], 7, "Could not load invite codes.");
      }
    }
    document.getElementById("mintInviteBtn").addEventListener("click", async function() {
      const days = document.getElementById("inviteExpiresDays").value;
      const body = { maxUses: Number(document.getElementById("inviteMaxUses").value || 1) };
      const label = document.getElementById("inviteLabel").value.trim();
      if (label) body.label = label;
      if (days) body.expiresInDays = Number(days);
      try {
        const r = await api("/portal/api/admin/invites", { method: "POST", body: JSON.stringify(body) });
        document.getElementById("newInviteWrap").classList.remove("hidden");
        document.getElementById("newInviteCode").textContent = r.code;
        document.getElementById("newInviteLink").textContent = location.origin + "/portal?invite=" + encodeURIComponent(r.code) + "#signup";
        showToast("Invite code created.");
        await loadInvites();
      } catch (err) {
        showToast("Could not create the invite: " + String(err.message || err), true);
      }
    });
    document.getElementById("inviteBody").addEventListener("click", async function(event) {
      const target = event.target;
      if (!target || !target.classList || !target.classList.contains("revokeInviteBtn")) return;
      const id = decodeURIComponent(target.getAttribute("data-code-id") || "");
      if (!id || !window.confirm("Revoke this invite code? Accounts already created with it stay.")) return;
      try {
        await api("/portal/api/admin/invites/" + encodeURIComponent(id) + "/revoke", { method: "POST", body: JSON.stringify({}) });
        showToast("Invite code revoked.");
        await loadInvites();
      } catch (err) {
        showToast("Revoke failed: " + String(err.message || err), true);
      }
    });

    /* ── Host requests (admin only; src/portal/host-requests.ts) ── */
    const HOST_STATUS = { new: ["NEW", "info"], contacted: ["CONTACTED", "warn"], approved: ["APPROVED", "ok"], declined: ["DECLINED", "warn"] };
    const HOST_KIND = { compute_agent: "Compute agent", coordinator: "Coordinator", bitcoin_node: "Bitcoin node", lightning_node: "Lightning node" };
    const HW = { cpu: "CPU", nvidia_gpu: "NVIDIA GPU", amd_gpu: "AMD GPU", apple_silicon: "Apple silicon", other: "Other" };
    let hostRequestsCache = [];
    async function loadHostRequests() {
      try {
        const data = await api("/portal/api/admin/host-requests", { method: "GET", headers: {} });
        document.getElementById("hostGateNote").textContent = data.required
          ? "HOST_APPROVAL_REQUIRED is on: only approved hosts' machines take other people's work. Approving a request approves its email" + (data.allowlist && data.allowlist.length ? " (also always approved: " + data.allowlist.length + " allowlisted email(s))." : ".")
          : "HOST_APPROVAL_REQUIRED=0: every account's machines may take network work. Approvals here start to matter once the gate is on.";
        hostRequestsCache = data.requests || [];
        const rows = hostRequestsCache.map(function(r) {
          const st = HOST_STATUS[r.status] || [String(r.status), "warn"];
          const sel = "<select class='hostStatusSel' data-id='" + encodeAttr(r.requestId) + "' aria-label='Status'>" +
            ["new", "contacted", "approved", "declined"].map(function(s) { return "<option value='" + s + "'" + (s === r.status ? " selected" : "") + ">" + s + "</option>"; }).join("") + "</select>";
          return "<tr><td>" + fmtTime(r.createdAtMs) + "</td><td><b>" + escapeHtml(r.name) + "</b><br><a href='mailto:" + encodeAttr(r.email) + "'>" + escapeHtml(r.email) + "</a>" +
            (r.organisation ? "<br><span class='muted'>" + escapeHtml(r.organisation) + "</span>" : "") + "</td><td>" +
            (r.hostKinds || []).map(function(k) { return escapeHtml(HOST_KIND[k] || k); }).join(", ") + "</td><td>" +
            escapeHtml(r.computeHardware ? (HW[r.computeHardware] || r.computeHardware) : "") + (r.hardwareDetails ? "<br><span class='muted'>" + escapeHtml(r.hardwareDetails) + "</span>" : "") +
            (r.region ? "<br>" + escapeHtml(r.region) : "") + "</td><td>" + escapeHtml(r.message || "") + "</td><td>" + statusBadge(st[0], st[1]) + "<br>" + sel +
            "</td><td><textarea class='hostNotes' data-id='" + encodeAttr(r.requestId) + "' rows='2' maxlength='4000' aria-label='Notes'>" + escapeHtml(r.notes || "") + "</textarea></td>" +
            "<td><button class='hostSaveBtn' data-id='" + encodeAttr(r.requestId) + "'>Save</button></td></tr>";
        });
        renderRows("hostRequestBody", rows, 8, "No host requests yet.");
        const hosts = (data.hosts || []).map(function(h) {
          return "<tr><td>" + escapeHtml(h.email) + "</td><td>" + escapeHtml(h.source) + "</td><td>" + fmtTime(h.approvedAtMs) + "</td><td>" + escapeHtml(h.approvedBy) +
            "</td><td>" + escapeHtml(h.note || "") + "</td><td><button class='hostRevokeBtn' data-email='" + encodeAttr(h.email) + "'>Revoke</button></td></tr>";
        });
        renderRows("hostListBody", hosts, 6, "No approved hosts.");
      } catch (err) {
        renderRows("hostRequestBody", [], 8, "Could not load host requests.");
      }
    }
    document.getElementById("hostRequestBody").addEventListener("click", async function(event) {
      const target = event.target;
      if (!target || !target.classList || !target.classList.contains("hostSaveBtn")) return;
      const id = decodeURIComponent(target.getAttribute("data-id") || "");
      const row = target.closest("tr");
      const status = row.querySelector(".hostStatusSel").value;
      const notes = row.querySelector(".hostNotes").value;
      const prev = hostRequestsCache.find(function(r) { return r.requestId === id; });
      if (status === "approved" && prev && prev.status !== "approved" &&
          !window.confirm("Approve " + prev.email + " as a host? Their machines will take other people's work. If they have no account yet, an invite code is created and emailed.")) return;
      try {
        const r = await api("/portal/api/admin/host-requests/" + encodeURIComponent(id), { method: "POST", body: JSON.stringify({ status: status, notes: notes }) });
        if (r.invite) {
          document.getElementById("hostInviteWrap").classList.remove("hidden");
          document.getElementById("hostInviteCode").textContent = r.invite.code;
          document.getElementById("hostInviteNote").textContent = r.invite.emailed
            ? "Invite code emailed to " + prev.email + " (shown only once):"
            : "Email is not configured: send this invite code to " + (prev ? prev.email : "the requester") + " yourself (shown only once):";
        }
        showToast(status === "approved" && r.approvalEmailed ? "Saved; the requester was emailed." : "Saved.");
        await loadHostRequests();
      } catch (err) {
        showToast("Could not save: " + String(err.message || err), true);
      }
    });
    document.getElementById("hostApproveBtn").addEventListener("click", async function() {
      const email = document.getElementById("hostApproveEmail").value.trim();
      const note = document.getElementById("hostApproveNote").value.trim();
      if (!email) return;
      try {
        await api("/portal/api/admin/hosts", { method: "POST", body: JSON.stringify(note ? { email: email, note: note } : { email: email }) });
        document.getElementById("hostApproveEmail").value = "";
        document.getElementById("hostApproveNote").value = "";
        showToast("Host approved. Their agents pick it up within a few minutes.");
        await loadHostRequests();
      } catch (err) {
        showToast("Could not approve: " + String(err.message || err), true);
      }
    });
    document.getElementById("hostListBody").addEventListener("click", async function(event) {
      const target = event.target;
      if (!target || !target.classList || !target.classList.contains("hostRevokeBtn")) return;
      const email = decodeURIComponent(target.getAttribute("data-email") || "");
      if (!email || !window.confirm("Revoke host approval for " + email + "? Their machines go back to running only their own work.")) return;
      try {
        await api("/portal/api/admin/hosts/revoke", { method: "POST", body: JSON.stringify({ email: email }) });
        showToast("Host approval revoked.");
        await loadHostRequests();
      } catch (err) {
        showToast("Revoke failed: " + String(err.message || err), true);
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
      document.getElementById("inviteSection").classList.remove("hidden");
      loadInvites();
      document.getElementById("hostRequestSection").classList.remove("hidden");
      loadHostRequests();
      document.getElementById("userMgmtSection").classList.remove("hidden");
      document.getElementById("adminNodeApprovalSection").classList.remove("hidden");
      loadUserManagement();
      await refreshApprovalsSafe();
      setInterval(refreshApprovalsSafe, 15000);
    })().catch((err) => {
      showToast("Could not load admin settings: " + String(err.message || err), true);
    });
  `;
  return reply.type("text/html").send(settingsPage("admin", "Invites, host requests, user management and node enrollment approvals.", content, script));
});
}
