// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { settingRow, settingsPage } from "./settings-shell.js";
import { HOST_ADMIN_JS } from "./host-admin.js";
import { machinesPageScript, machinesSectionHtml } from "./settings-machines.js";
import { securityResearchScript, securityResearchSectionHtml } from "./settings-security-research.js";

/** Settings > Nodes (/portal/settings/nodes) and Settings > Admin (/portal/settings/admin). */
/**
 * Compact UTC date for admin tables: "Nov 16, 21:02", full ISO in the title tooltip, never wraps.
 * Serialised into the page script with toString(), so it must stay self-contained.
 */
export function formatAdminDate(ms: number | null | undefined): string {
  if (!ms) return "n/a";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "n/a";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => (n < 10 ? "0" : "") + n;
  const label = months[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
  const iso = d.toISOString();
  return "<time class='nowrap' datetime='" + iso + "' title='" + iso + "'>" + label + "</time>";
}

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
      ${machinesSectionHtml()}
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
    ${HOST_ADMIN_JS}
    let allNodes = [];
    let nodeOwnerEmail = "";
    onHostDirectoryChange(function() { applyNodeTableView(); });
    function renderNodes(nodes) {
      const body = document.getElementById("nodesBody");
      const rows = (nodes || []).map((n) =>
        "<tr><td>" + escapeHtml(n.nodeId) + "</td><td>" + escapeHtml(n.nodeKind) + "</td><td>" + boolBadge(Boolean(n.emailVerified), "VERIFIED", "UNVERIFIED") + "</td><td>" +
        boolBadge(Boolean(n.nodeApproved), "APPROVED", "PENDING") + "</td><td>" + (n.active ? statusBadge("ACTIVE", "ok") : statusBadge("DORMANT", "warn")) +
        (hostAdmin.enabled ? " " + hostBadge(nodeOwnerEmail) : "") +
        "</td><td>" + fmtTime(n.lastSeenMs) + "</td><td class='nowrap'>" + (hostAdmin.enabled && !isHostEmail(nodeOwnerEmail) ? hostButton(nodeOwnerEmail, "Approve owner as host") + " " : "") + "<button class='deleteNodeBtn' data-node-id='" + encodeAttr(n.nodeId) + "'>Delete</button></td></tr>"
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

    ${machinesPageScript()}
    (async () => {
      const me = await requireAuth();
      revealSettingsAdminTab(me);
      const user = me.user || {};
      if (!user.emailVerified) document.getElementById("emailVerifyNote").classList.remove("hidden");
      nodeOwnerEmail = user.email || "";
      // Admins see whether each machine's owner is a host, with one-click approval (host-admin.ts).
      if (user.roles && user.roles.isSystemAdmin) await loadHostDirectory();
      // Host approval (src/portal/host-requests.ts): approved hosts' machines also take other people's work.
      api("/portal/api/host/status", { method: "GET", headers: {} }).then(function(st) {
        if (!st || !st.required || !st.approved) return;
        document.getElementById("hostStatusTitle").textContent = "Approved host";
        document.getElementById("hostStatusText").textContent = "Your account is an approved early-access host: your agents run your own work and take work from the network.";
      }).catch(function() {});
      await loadNodes();
      await loadMachines();
    })().catch((err) => {
      showToast("Could not load nodes: " + String(err.message || err), true);
    });
  `;
  return reply.type("text/html").send(settingsPage("nodes", "Enroll nodes, track their activation and manage their models.", content, script));
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
      <div class="table-scroll wide"><table>
        <thead><tr><th>Code</th><th>Label</th><th>Uses</th><th>Expires</th><th>Status</th><th>Created by</th><th>Actions</th></tr></thead>
        <tbody id="inviteBody"></tbody>
      </table></div>
    </div>
    </div>
    <div id="hostRequestSection" class="hidden">
    <div class="card" id="hostRequests">
      <h2 class="u-mt-0">Host requests</h2>
      <p class="muted" id="hostGateNote">Loading…</p>
      <div class="table-scroll wide"><table>
        <thead><tr><th>Received</th><th>Who</th><th>Would host</th><th>Hardware / region</th><th>Message</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead>
        <tbody id="hostRequestBody"></tbody>
      </table></div>
      <div id="hostInviteWrap" class="hidden u-mt-10">
        <div class="muted" id="hostInviteNote">Invite code for the approved host, shown only once.</div>
        <div id="hostInviteCode" class="token-box"></div>
      </div>
    </div>
    <div class="card">
      <h3 class="u-mt-0">Approved hosts</h3>
      <p class="muted">Accounts with these emails may take other people's work. Everyone else's machines run only their own work.</p>
      <details class="u-mt-10">
      <summary>Add by email</summary>
      <div class="row">
        <input id="hostApproveEmail" type="email" maxlength="254" placeholder="host@example.com" aria-label="Host email" />
        <input id="hostApproveNote" type="text" maxlength="200" placeholder="Note (optional)" aria-label="Note" />
        <button class="primary" id="hostApproveBtn">Approve host</button>
      </div>
      </details>
      <div class="table-scroll wide"><table>
        <thead><tr><th>Email</th><th>Source</th><th>Approved</th><th>By</th><th>Note</th><th>Actions</th></tr></thead>
        <tbody id="hostListBody"></tbody>
      </table></div>
    </div>
    </div>
    ${securityResearchSectionHtml}
    <div id="userMgmtSection" class="hidden">
    <div class="card">
      <h2 class="u-mt-0">User management</h2>
      <p class="muted">Accounts that signed up with an agent key have no email by design and are labelled "Agent (key sign-in)". Delete needs no machines, no balance and no pending payout on any coordinator; recent activity needs force.</p>
      <div class="row" id="userFilterRow">
        <button class="userFilterBtn primary" data-filter="all">All <span id="userCount-all"></span></button>
        <button class="userFilterBtn" data-filter="verified">Verified <span id="userCount-verified"></span></button>
        <button class="userFilterBtn" data-filter="unverified">Unverified <span id="userCount-unverified"></span></button>
        <button class="userFilterBtn" data-filter="agent">Agent key <span id="userCount-agent"></span></button>
        <button class="userFilterBtn" data-filter="admin">Admins <span id="userCount-admin"></span></button>
        <input id="userSearch" type="search" maxlength="200" placeholder="Search email, id or name" aria-label="Search users" />
      </div>
      <div class="table-scroll wide"><table>
        <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th>Last sign-in</th><th>Machines</th><th>API keys</th><th>Balance</th><th class="sticky-actions">Actions</th></tr></thead>
        <tbody id="userMgmtBody"></tbody>
      </table></div>
      <div class="row">
        <button id="userPrevBtn">Previous</button>
        <span class="muted" id="userPageNote"></span>
        <button id="userNextBtn">Next</button>
      </div>
    </div>
    <div class="card">
      <h3 class="u-mt-0">Locked accounts</h3>
      <p class="muted">Locked from the link in a withdrawal receipt: payouts are paused and sessions were signed out. Unlock after checking with the owner (it registers their payout address again).</p>
      <div class="table-scroll wide"><table>
        <thead><tr><th>Email</th><th>Locked</th><th>By</th><th></th></tr></thead>
        <tbody id="lockedBody"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody>
      </table></div>
    </div>
    <div class="card">
      <h3 class="u-mt-0">Clean up abandoned sign-ups</h3>
      <p class="muted">Lists unverified accounts older than N days with no machines, API keys, recent activity, balance or pending payout. Nothing is deleted until you confirm the list.</p>
      <div class="row">
        <input id="cleanupDays" type="number" min="1" max="3650" step="1" value="30" aria-label="Older than days" title="Older than this many days" />
        <label><input id="cleanupAgents" type="checkbox" /> Include agent-key accounts</label>
        <button id="cleanupDryRunBtn">Show accounts (dry run)</button>
      </div>
      <div id="cleanupResult" class="hidden u-mt-10">
        <div class="muted" id="cleanupNote"></div>
        <div class="table-scroll wide"><table>
          <thead><tr><th>Email</th><th>Status</th><th>Created</th><th>Last activity</th><th>Result</th></tr></thead>
          <tbody id="cleanupBody"></tbody>
        </table></div>
        <button class="danger" id="cleanupConfirmBtn">Delete these accounts</button>
      </div>
    </div>
    </div>
    <div id="adminNodeApprovalSection" class="hidden">
    <div class="card">
      <h3 class="u-mt-0">Enrollment requests</h3>
      <p class="muted u-mt-0" data-node-kinds-explainer>Agents run jobs. Coordinators route jobs between agents (EdgeCoder runs these today).</p>
      <div class="row">
        <button class="primary" id="filterAllBtn">All <span id="pendingCount-all"></span></button>
        <button id="filterAgentBtn">Agents <span id="pendingCount-agent"></span></button>
        <button id="filterCoordinatorBtn">Coordinators <span id="pendingCount-coordinator"></span></button>
      </div>
      <div class="row">
        <label class="muted" for="rejectBlockDays">On reject of an ownerless request, block the agent id for
        <input type="number" class="u-w-num" id="rejectBlockDays" min="0" max="365" value="0" aria-label="Block days"> days (0 = no block)</label>
      </div>
      <div class="table-scroll wide"><table>
        <thead><tr><th>Node</th><th>Kind</th><th>Owner email</th><th>Email verified</th><th>IP</th><th>Country</th><th>VPN</th><th>Last seen</th><th class="sticky-actions">Actions</th></tr></thead>
        <tbody id="opsPendingBody"></tbody>
      </table></div>
      <div id="opsPendingNote" class="muted"></div>
    </div>
    <div class="card">
      <h3 class="u-mt-0">Approved nodes</h3>
      <p class="muted u-mt-0" data-node-kinds-explainer>Agents run jobs. Coordinators route jobs between agents (EdgeCoder runs these today).</p>
      <div class="row">
        <button class="primary" id="approvedFilterAllBtn">All <span id="approvedCount-all"></span></button>
        <button id="approvedFilterAgentBtn">Agents <span id="approvedCount-agent"></span></button>
        <button id="approvedFilterCoordinatorBtn">Coordinators <span id="approvedCount-coordinator"></span></button>
        <button id="approvedFilterActiveBtn">Active only <span id="approvedCount-active"></span></button>
        <button id="approvedFilterStaleBtn">Offline &gt; 7 days <span id="approvedCount-stale"></span></button>
      </div>
      <div class="table-scroll wide"><table>
        <thead><tr><th>Node</th><th>Kind</th><th>Owner email</th><th>Email verified</th><th>Active</th><th>IP</th><th>Country</th><th>VPN</th><th>Last seen</th><th>Updated</th><th class="sticky-actions">Actions</th></tr></thead>
        <tbody id="opsApprovedBody"></tbody>
      </table></div>
      <div id="opsApprovedNote" class="muted"></div>
    </div>
    </div>
  `;
  const script = `
    ${formatAdminDate.toString()}
    function fmtTime(ms) { return formatAdminDate(ms); }
    ${HOST_ADMIN_JS}
    function trunc(v) { const t = escapeHtml(v); return "<span class='cell-trunc' title='" + t + "'>" + t + "</span>"; }
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
    const OFFLINE_AFTER_MS = 10 * 60 * 1000;
    const STALE_MS = 7 * 24 * 60 * 60 * 1000;
    // Offline: not active, or not seen for 10 minutes. Stale: offline and not seen for over 7 days.
    function isOffline(n) { return n.active !== true || !n.lastSeenMs || Date.now() - Number(n.lastSeenMs) > OFFLINE_AFTER_MS; }
    function isStale(n) { return isOffline(n) && (!n.lastSeenMs || Date.now() - Number(n.lastSeenMs) > STALE_MS); }
    function filterApproved(nodes, mode, activeOnly, staleOnly) {
      let values = nodes || [];
      if (mode !== "all") values = values.filter((n) => String(n.nodeKind) === mode);
      if (activeOnly) values = values.filter((n) => n.active === true);
      if (staleOnly) values = values.filter(isStale);
      return values;
    }
    function lastSeenCell(n) {
      if (!isOffline(n)) return fmtTime(n.lastSeenMs);
      return n.lastSeenMs ? "<span class='u-danger'>Offline since " + fmtTime(n.lastSeenMs) + "</span>" : "<span class='u-danger'>Offline (never seen)</span>";
    }
    function setCount(id, value) { const el = document.getElementById(id); if (el) el.textContent = "(" + value + ")"; }
    let pendingFilter = "all";
    let approvedFilter = "all";
    let approvedActiveOnly = false;
    let approvedStaleOnly = false;
    let canRemoveNodes = false;
    let cachedPending = [];
    let cachedApproved = [];
    let canManageApprovals = false;

    const NO_OWNER_TIP = "No owner: the machine must be enrolled with a token from a signed-in account";
    // A row with no owner account is an agent a coordinator saw try /register without enrollment.
    // It can never be approved; Reject dismisses it on the coordinators instead.
    function pendingActions(n) {
      const id = encodeAttr(n.nodeId);
      const kind = encodeAttr(n.nodeKind);
      const owned = Boolean(n.ownerEmail);
      const approve = owned
        ? "<button class='approveBtn' data-node-id='" + id + "' data-node-kind='" + kind + "' data-approved='true'>Approve</button>"
        : "<button class='approveBtn' disabled title='" + NO_OWNER_TIP + "' aria-label='Approve (unavailable: no owner)'>Approve</button>";
      return approve + " <button class='approveBtn' data-node-id='" + id + "' data-node-kind='" + kind + "' data-approved='false' data-owned='" + (owned ? "true" : "false") + "'>Reject</button>";
    }
    function approvalToast(approved, err) {
      if (err) return (approved ? "Approve failed: " : "Reject failed: ") + err;
      return approved ? "Approved" : "Rejected";
    }
    function renderPending() {
      const body = document.getElementById("opsPendingBody");
      const rows = filterPending(cachedPending, pendingFilter).map((n) =>
        "<tr><td>" + trunc(n.nodeId) + "</td><td>" + escapeHtml(n.nodeKind) + "</td><td>" + trunc(n.ownerEmail || "unknown") + "</td><td>" +
        String(Boolean(n.emailVerified)) + "</td><td>" + escapeHtml(n.sourceIp || "unknown") + "</td><td>" + escapeHtml(n.countryCode || "unknown") +
        "</td><td>" + (n.vpnDetected === true ? "yes" : "no") + "</td><td>" + fmtTime(n.lastSeenMs) + "</td><td class='sticky-actions'>" +
        (canManageApprovals ? pendingActions(n) : "<span class='muted'>Read-only</span>") +
        "</td></tr>"
      );
      body.innerHTML = rows.length > 0 ? rows.join("") : "<tr><td colspan='9'>No pending nodes for this filter.</td></tr>";
      const counts = {
        all: cachedPending.length,
        coordinator: cachedPending.filter((n) => n.nodeKind === "coordinator").length,
        agent: cachedPending.filter((n) => n.nodeKind === "agent").length
      };
      setCount("pendingCount-all", counts.all);
      setCount("pendingCount-agent", counts.agent);
      setCount("pendingCount-coordinator", counts.coordinator);
      document.getElementById("opsPendingNote").textContent = "";
      document.getElementById("filterAllBtn").className = pendingFilter === "all" ? "primary" : "";
      document.getElementById("filterCoordinatorBtn").className = pendingFilter === "coordinator" ? "primary" : "";
      document.getElementById("filterAgentBtn").className = pendingFilter === "agent" ? "primary" : "";
    }

    function renderApproved() {
      const body = document.getElementById("opsApprovedBody");
      const rows = filterApproved(cachedApproved, approvedFilter, approvedActiveOnly, approvedStaleOnly).map((n) => {
        const removeBtn = canRemoveNodes
          ? "<button class='danger removeNodeBtn' data-node-id='" + encodeAttr(n.nodeId) + "' data-node-kind='" + encodeAttr(n.nodeKind) + "'>Remove</button>"
          : "<span class='muted'>Read-only</span>";
        const ownerHost = n.ownerEmail ? "<div class='nowrap'>" + hostBadge(n.ownerEmail) + (isHostEmail(n.ownerEmail) ? "" : " " + hostButton(n.ownerEmail, "Approve owner as host")) + "</div>" : "";
        return "<tr><td>" + trunc(n.nodeId) + "</td><td>" + escapeHtml(n.nodeKind) + "</td><td>" + trunc(n.ownerEmail || "unknown") + ownerHost + "</td><td>" +
          String(Boolean(n.emailVerified)) + "</td><td>" + (n.active === true ? "yes" : "no") + "</td><td>" + escapeHtml(n.sourceIp || "unknown") +
          "</td><td>" + escapeHtml(n.countryCode || "unknown") + "</td><td>" + (n.vpnDetected === true ? "yes" : "no") + "</td><td>" +
          lastSeenCell(n) + "</td><td>" + fmtTime(n.updatedAtMs) + "</td><td class='sticky-actions'>" + removeBtn + "</td></tr>";
      });
      body.innerHTML = rows.length > 0 ? rows.join("") : "<tr><td colspan='11'>No approved nodes for this filter.</td></tr>";
      const counts = {
        all: cachedApproved.length,
        coordinator: cachedApproved.filter((n) => n.nodeKind === "coordinator").length,
        agent: cachedApproved.filter((n) => n.nodeKind === "agent").length,
        active: cachedApproved.filter((n) => n.active === true).length,
        stale: cachedApproved.filter(isStale).length
      };
      setCount("approvedCount-all", counts.all);
      setCount("approvedCount-agent", counts.agent);
      setCount("approvedCount-coordinator", counts.coordinator);
      setCount("approvedCount-active", counts.active);
      setCount("approvedCount-stale", counts.stale);
      document.getElementById("opsApprovedNote").textContent = "";
      document.getElementById("approvedFilterAllBtn").className = approvedFilter === "all" ? "primary" : "";
      document.getElementById("approvedFilterCoordinatorBtn").className = approvedFilter === "coordinator" ? "primary" : "";
      document.getElementById("approvedFilterAgentBtn").className = approvedFilter === "agent" ? "primary" : "";
      document.getElementById("approvedFilterActiveBtn").className = approvedActiveOnly ? "primary" : "";
      document.getElementById("approvedFilterStaleBtn").className = approvedStaleOnly ? "primary" : "";
    }

    async function refreshOps() {
      const data = await api("/coordinator/ops/summary", { method: "GET", headers: {} });
      cachedPending = data.pendingNodes || [];
      cachedApproved = data.approvedNodes || [];
      canManageApprovals = Boolean(data.access && data.access.canManageApprovals);
      canRemoveNodes = canManageApprovals && Boolean(data.access && data.access.isSystemAdmin);
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
    document.getElementById("approvedFilterStaleBtn").addEventListener("click", () => { approvedStaleOnly = !approvedStaleOnly; renderApproved(); });

    // Remove an approved machine (POST /coordinator/ops/node-remove): revokes its token, drops it on the
    // coordinators, keeps its earnings history. A reservation lease or a running task blocks it; the
    // admin is then offered a forced removal.
    async function removeNode(nodeId, nodeKind, force) {
      return api("/coordinator/ops/node-remove", { method: "POST", body: JSON.stringify({ nodeId, nodeKind, force }) });
    }
    document.getElementById("opsApprovedBody").addEventListener("click", async (event) => {
      const target = event.target;
      if (!target || !target.classList || !target.classList.contains("removeNodeBtn")) return;
      const nodeId = decodeURIComponent(target.getAttribute("data-node-id") || "");
      const nodeKind = decodeURIComponent(target.getAttribute("data-node-kind") || "agent");
      if (!nodeId) return;
      if (!window.confirm("Remove " + nodeId + "? Its token stops working; it must be re-enrolled to come back. Earnings history is kept.")) return;
      try {
        await removeNode(nodeId, nodeKind, false);
        showToast("Removed " + nodeId);
      } catch (err) {
        const msg = String(err.message || err);
        const why = /active_reservation/.test(msg) ? "it holds an active reservation lease" : /running_task/.test(msg) ? "it is running a task" : "";
        if (!why) { showToast("Remove failed: " + msg, true); return; }
        if (!window.confirm("Cannot remove " + nodeId + " yet: " + why + " (" + msg + "). Remove it anyway (force)?")) return;
        try {
          await removeNode(nodeId, nodeKind, true);
          showToast("Removed " + nodeId + " (forced)");
        } catch (err2) {
          showToast("Remove failed: " + String(err2.message || err2), true);
          return;
        }
      }
      await refreshOps();
    });

    document.getElementById("opsPendingBody").addEventListener("click", async (event) => {
      const target = event.target;
      if (!target || !target.classList || !target.classList.contains("approveBtn")) return;
      const coordinatorIdRaw = target.getAttribute("data-node-id");
      const nodeKindRaw = target.getAttribute("data-node-kind");
      if (!coordinatorIdRaw || !nodeKindRaw) return;
      const nodeId = decodeURIComponent(coordinatorIdRaw);
      const nodeKind = decodeURIComponent(nodeKindRaw);
      const approved = target.getAttribute("data-approved") === "true";
      const owned = target.getAttribute("data-owned") !== "false";
      try {
        if (approved || owned) {
          await api("/coordinator/ops/node-approval", {
            method: "POST",
            body: JSON.stringify({ nodeId, nodeKind, approved })
          });
        } else {
          const days = Math.max(0, Math.min(365, Math.floor(Number(document.getElementById("rejectBlockDays").value) || 0)));
          await api("/coordinator/ops/node-dismiss", {
            method: "POST",
            body: JSON.stringify({ nodeId, nodeKind, blockDays: days })
          });
        }
        showToast(approvalToast(approved) + " " + nodeKind + " " + nodeId);
        await refreshOps();
      } catch (err) {
        showToast(approvalToast(approved, String(err.message || err)), true);
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
        setHostDirectory(data);
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
          return "<tr><td>" + trunc(h.email) + "</td><td>" + escapeHtml(h.source) + "</td><td>" + fmtTime(h.approvedAtMs) + "</td><td>" + escapeHtml(h.approvedBy) +
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

    ${securityResearchScript}
    /* ── User management (admin only; routes/admin-users.ts) ── */
    const userView = { filter: "all", q: "", page: 1, pages: 1, selfUserId: "" };
    const STATUS_TONE = { verified: "ok", unverified: "warn", agent: "info" };
    async function apiDetail(path, options) {
      const res = await fetch(path, { credentials: "include", headers: { "content-type": "application/json" }, ...options });
      let payload = null;
      try { payload = await res.json(); } catch {}
      if (!res.ok) throw new Error(payload ? String(payload.error || res.status) + (payload.detail ? ": " + payload.detail : "") : String(res.status));
      return payload;
    }
    /* ── Locked accounts (routes/account-security.ts) ── */
    async function loadLockedAccounts() {
      const body = document.getElementById("lockedBody");
      try {
        const data = await api("/portal/api/admin/security/locked", { method: "GET", headers: {} });
        const rows = (data.accounts || []).map((a) => "<tr><td>" + escapeHtml(a.email || a.userId) + "</td><td>" + escapeHtml(new Date(a.lockedAtMs).toLocaleString()) + "</td><td>" + escapeHtml(a.source === "admin" ? "Admin" : "Owner (receipt link)") + "</td><td><button data-unlock='" + escapeHtml(a.userId) + "'>Unlock</button></td></tr>");
        body.innerHTML = rows.length ? rows.join("") : "<tr><td colspan='4' class='muted'>No locked accounts.</td></tr>";
      } catch (err) {
        body.innerHTML = "<tr><td colspan='4' class='muted'>Could not load: " + escapeHtml(String(err.message || err)) + "</td></tr>";
      }
    }
    document.getElementById("lockedBody").addEventListener("click", async (e) => {
      const uid = e.target && e.target.getAttribute && e.target.getAttribute("data-unlock");
      if (!uid || !window.confirm("Unlock this account? Payouts resume to its saved address.")) return;
      try { await apiDetail("/portal/api/admin/security/" + encodeURIComponent(uid) + "/unlock", { method: "POST", body: "{}" }); showToast("Unlocked."); }
      catch (err) { showToast("Unlock failed: " + String(err.message || err), true); }
      loadLockedAccounts();
    });
    function userStatusBadge(u) { return statusBadge(u.labelText || u.label, STATUS_TONE[u.label] || "neutral"); }
    async function loadUserManagement() {
      try {
        const qs = "?filter=" + encodeURIComponent(userView.filter) + "&page=" + userView.page + (userView.q ? "&q=" + encodeURIComponent(userView.q) : "");
        const data = await api("/portal/api/admin/users" + qs, { method: "GET", headers: {} });
        userView.page = Number(data.page) || 1;
        userView.pages = Number(data.pages) || 1;
        userView.selfUserId = String(data.selfUserId || "");
        const counts = data.counts || {};
        ["all", "verified", "unverified", "agent", "admin"].forEach(function(f) {
          const el = document.getElementById("userCount-" + f);
          if (el) el.textContent = counts[f] === undefined ? "" : "(" + Number(counts[f]) + ")";
        });
        document.querySelectorAll(".userFilterBtn").forEach(function(btn) { btn.classList.toggle("primary", btn.getAttribute("data-filter") === userView.filter); });
        document.getElementById("userPageNote").textContent = "Page " + userView.page + " of " + userView.pages + " (" + Number(data.total || 0) + " accounts)";
        const rows = (data.users || []).map(function(u) {
          const uid = encodeAttr(u.userId);
          const roleBtn = u.role === "admin"
            ? "<button class='userRoleBtn' data-uid='" + uid + "' data-role='user'>Remove Admin</button>"
            : "<button class='userRoleBtn primary' data-uid='" + uid + "' data-role='admin'>Make Admin</button>";
          const canDelete = u.role !== "admin" && u.userId !== userView.selfUserId;
          const delBtn = canDelete ? " <button class='userDeleteBtn danger' data-uid='" + uid + "' data-email='" + encodeAttr(u.email) + "'>Delete</button>" : "";
          const machines = Number(u.machines) + (Number(u.approvedMachines) ? " · " + Number(u.approvedMachines) + " approved" : "");
          const lastSignIn = u.lastSessionMs ? fmtTime(u.lastSessionMs) + (Number(u.activeSessions) ? " · " + Number(u.activeSessions) + " active" : "") : "never";
          return "<tr><td>" + trunc(u.email) + (u.displayName ? "<div class='muted'>" + escapeHtml(u.displayName) + "</div>" : "") + "</td><td>" + escapeHtml(u.role) + "</td><td>" +
            userStatusBadge(u) + " " + hostBadge(u.email) + "</td><td>" + fmtTime(u.createdAtMs) + "</td><td class='nowrap'>" + lastSignIn + "</td><td class='nowrap'>" + escapeHtml(machines) + "</td><td>" + Number(u.apiKeys) +
            "</td><td><span id='bal-" + uid + "'><button class='userBalanceBtn' data-uid='" + uid + "'>Check</button></span></td><td class='sticky-actions'>" + roleBtn + " " + hostButton(u.email, "Approve host") + delBtn + "</td></tr>";
        });
        renderRows("userMgmtBody", rows, 9, "No users found.");
      } catch (err) {
        document.getElementById("userMgmtBody").innerHTML = "<tr><td colspan='9'>Failed to load users.</td></tr>";
      }
    }
    document.getElementById("userFilterRow").addEventListener("click", function(event) {
      const btn = event.target && event.target.closest ? event.target.closest(".userFilterBtn") : null;
      if (!btn) return;
      userView.filter = btn.getAttribute("data-filter") || "all";
      userView.page = 1;
      loadUserManagement();
    });
    let userSearchTimer = null;
    document.getElementById("userSearch").addEventListener("input", function(event) {
      clearTimeout(userSearchTimer);
      userSearchTimer = setTimeout(function() { userView.q = String(event.target.value || "").trim(); userView.page = 1; loadUserManagement(); }, 250);
    });
    document.getElementById("userPrevBtn").addEventListener("click", function() { if (userView.page > 1) { userView.page--; loadUserManagement(); } });
    document.getElementById("userNextBtn").addEventListener("click", function() { if (userView.page < userView.pages) { userView.page++; loadUserManagement(); } });
    async function deleteUser(uid, email, force) {
      const typed = window.prompt("Delete " + email + "?\\n\\nAll of its portal data (sessions, API keys, passkeys, chats, agent identity) is removed. The coordinator ledger is kept.\\n\\nType the email to confirm:");
      if (typed === null) return;
      try {
        const r = await apiDetail("/portal/api/admin/users/" + encodeURIComponent(uid) + "/delete", { method: "POST", body: JSON.stringify({ confirmEmail: typed, force: Boolean(force) }) });
        showToast("Deleted " + email + " (audit " + String(r.auditId || "") + ").");
        await loadUserManagement();
      } catch (err) {
        const msg = String(err.message || err);
        if (!force && msg.indexOf("recent_activity") === 0 && window.confirm(msg + "\\n\\nDelete anyway (force)? A balance or machine still blocks it.")) return deleteUser(uid, email, true);
        showToast("Delete refused: " + msg, true);
      }
    }
    document.getElementById("userMgmtBody").addEventListener("click", async function(event) {
      var target = event.target;
      if (!target || !target.classList) return;
      var uid = decodeURIComponent(target.getAttribute("data-uid") || "");
      if (!uid) return;
      if (target.classList.contains("userDeleteBtn")) return deleteUser(uid, decodeURIComponent(target.getAttribute("data-email") || ""), false);
      if (target.classList.contains("userBalanceBtn")) {
        const cell = document.getElementById("bal-" + encodeAttr(uid));
        cell.textContent = "…";
        try {
          const b = await apiDetail("/portal/api/admin/users/" + encodeURIComponent(uid) + "/balance", { method: "GET" });
          const text = Number(b.cSats) + " cSats" + (Number(b.pendingPayouts) ? ", " + Number(b.pendingPayouts) + " pending payout(s)" : "") + (b.complete ? "" : " (incomplete: " + (b.coordinators || []).filter(function(c) { return !c.ok; }).length + " coordinator(s) did not answer)");
          cell.textContent = text;
        } catch (err) {
          cell.textContent = "error";
        }
        return;
      }
      if (!target.classList.contains("userRoleBtn")) return;
      var role = target.getAttribute("data-role");
      if (!role) return;
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

    /* ── Bulk cleanup: dry run, then delete exactly the listed accounts ── */
    let cleanupPlan = null;
    function cleanupRequest() {
      return { olderThanDays: Number(document.getElementById("cleanupDays").value || 30), includeAgentAccounts: document.getElementById("cleanupAgents").checked };
    }
    document.getElementById("cleanupDryRunBtn").addEventListener("click", async function() {
      try {
        const plan = await apiDetail("/portal/api/admin/users/cleanup", { method: "POST", body: JSON.stringify({ ...cleanupRequest(), dryRun: true }) });
        cleanupPlan = { request: cleanupRequest(), userIds: (plan.candidates || []).map(function(c) { return c.userId; }) };
        const rows = (plan.candidates || []).map(function(c) {
          return "<tr><td>" + trunc(c.email) + "</td><td>" + escapeHtml(c.label) + "</td><td>" + fmtTime(c.createdAtMs) + "</td><td>" + fmtTime(c.lastActivityMs) + "</td><td>will be deleted</td></tr>";
        }).concat((plan.skipped || []).map(function(s) {
          return "<tr><td>" + escapeHtml(s.email) + "</td><td></td><td></td><td></td><td>skipped: " + escapeHtml(s.error) + "</td></tr>";
        }));
        document.getElementById("cleanupResult").classList.remove("hidden");
        renderRows("cleanupBody", rows, 5, "No accounts match.");
        document.getElementById("cleanupNote").textContent = cleanupPlan.userIds.length + " account(s) would be deleted, " + (plan.skipped || []).length + " skipped.";
        document.getElementById("cleanupConfirmBtn").classList.toggle("hidden", cleanupPlan.userIds.length === 0);
      } catch (err) {
        showToast("Dry run failed: " + String(err.message || err), true);
      }
    });
    document.getElementById("cleanupConfirmBtn").addEventListener("click", async function() {
      if (!cleanupPlan || cleanupPlan.userIds.length === 0) return;
      const phrase = "DELETE " + cleanupPlan.userIds.length;
      const typed = window.prompt("Delete the " + cleanupPlan.userIds.length + " listed account(s)? Each is re-checked first.\\n\\nType " + phrase + " to confirm:");
      if (typed === null) return;
      try {
        const r = await apiDetail("/portal/api/admin/users/cleanup", { method: "POST", body: JSON.stringify({ ...cleanupPlan.request, dryRun: false, userIds: cleanupPlan.userIds, confirm: typed.trim() }) });
        showToast("Deleted " + (r.deleted || []).length + " account(s); " + (r.skipped || []).length + " skipped.");
        cleanupPlan = null;
        document.getElementById("cleanupResult").classList.add("hidden");
        await loadUserManagement();
      } catch (err) {
        showToast("Cleanup failed: " + String(err.message || err), true);
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
      document.getElementById("securityResearchSection").classList.remove("hidden");
      loadSecurityResearch();
      await loadHostDirectory();
      onHostDirectoryChange(function() { loadUserManagement(); loadHostRequests(); renderApproved(); });
      document.getElementById("userMgmtSection").classList.remove("hidden");
      document.getElementById("adminNodeApprovalSection").classList.remove("hidden");
      loadUserManagement();
      loadLockedAccounts();
      await refreshApprovalsSafe();
      setInterval(refreshApprovalsSafe, 15000);
    })().catch((err) => {
      showToast("Could not load admin settings: " + String(err.message || err), true);
    });
  `;
  return reply.type("text/html").send(settingsPage("admin", "Invites, host requests, user management and node enrollment approvals.", content, script, { wide: true }));
});
}
