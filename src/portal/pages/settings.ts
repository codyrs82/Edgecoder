// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { portalAuthedPageHtml } from "./layout.js";

/**
 * Settings area: Account (/portal/settings), Nodes (/portal/settings/nodes) and Admin
 * (/portal/settings/admin). The Admin sub-tab is revealed client-side only for system admins;
 * the admin APIs it calls (/portal/api/admin/*, /coordinator/ops/*) enforce authorization
 * server-side.
 */
type SettingsSection = "account" | "nodes" | "admin";

function settingsTabs(active: SettingsSection): string {
  const tabs: Array<{ key: SettingsSection; href: string; label: string; adminOnly?: boolean }> = [
    { key: "account", href: "/portal/settings", label: "Account" },
    { key: "nodes", href: "/portal/settings/nodes", label: "Nodes" },
    { key: "admin", href: "/portal/settings/admin", label: "Admin", adminOnly: true }
  ];
  const links = tabs
    .map((t) => {
      const cls = ["btn", t.key === active ? "primary" : "", t.adminOnly && t.key !== active ? "hidden" : ""].filter(Boolean).join(" ");
      const id = t.adminOnly ? ' id="settingsAdminTab"' : "";
      const current = t.key === active ? ' aria-current="page"' : "";
      return `<a class="${cls}" href="${t.href}"${id}${current}>${t.label}</a>`;
    })
    .join("");
  return `<nav class="row settings-tabs" aria-label="Settings sections" style="margin-bottom:12px;">${links}</nav>`;
}

/** Reveals the Admin sub-tab for system admins (cosmetic only; the APIs enforce authz). */
const SETTINGS_TABS_SCRIPT = `
    function revealSettingsAdminTab(me) {
      const user = (me && me.user) || {};
      const tab = document.getElementById("settingsAdminTab");
      if (tab && user.roles && user.roles.isSystemAdmin) tab.classList.remove("hidden");
    }
`;

function settingsPage(section: SettingsSection, subtitle: string, content: string, script: string): string {
  return portalAuthedPageHtml({
    title: "EdgeCoder Portal | Settings",
    activeTab: "settings",
    heading: "Settings",
    subtitle,
    content: settingsTabs(section) + content,
    script: SETTINGS_TABS_SCRIPT + script
  });
}

export function registerSettingsPages(app: FastifyInstance): void {
app.get("/portal/settings", async (_req, reply) => {
  const content = `
    <div class="grid2">
      <div class="card">
        <h2 style="margin-top:0;">Account</h2>
        <div id="accountLine" class="muted"><span class="loading-spinner sm"></span> Loading account...</div>
        <label for="displayNameInput">Display name</label>
        <div class="row">
          <input id="displayNameInput" maxlength="80" placeholder="Your name" style="max-width:260px;" />
          <button class="primary" id="saveProfileBtn">Save</button>
        </div>
        <label>Theme</label>
        <select id="themeSelect" style="max-width:220px;">
          <option value="warm">Graphite (default)</option>
          <option value="midnight">Midnight</option>
          <option value="emerald">Evergreen</option>
        </select>
        <div class="row" style="margin-top:10px;">
          <button class="primary" id="saveThemeBtn">Save theme</button>
        </div>
      </div>
      <div class="card" style="grid-column:1 / -1;">
        <h2 style="margin-top:0;">API keys</h2>
        <p class="muted" style="margin-bottom:8px;">For tools that use EdgeCoder models from anywhere, including Cursor and Claude Code on machines without the app. Requests run on the network and are paid from your cSats.</p>
        <div class="row" style="margin-bottom:10px;">
          <input id="newKeyName" maxlength="60" placeholder="Key name, e.g. Cursor on laptop" style="max-width:300px;" />
          <button class="primary" id="createKeyBtn">Create key</button>
        </div>
        <div id="newKeyBox" class="hidden card" style="margin-bottom:10px;">
          <strong>Copy this key now. It won't be shown again.</strong>
          <div class="row" style="margin-top:6px;"><code id="newKeyValue" style="word-break:break-all;"></code><button id="copyKeyBtn">Copy</button></div>
        </div>
        <table class="table"><thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody id="keysBody"><tr><td colspan="5" class="muted">Loading...</td></tr></tbody></table>
        <details style="margin-top:12px;">
          <summary>How to connect your tools</summary>
          <p class="muted">Base URL <code><span class="portal-origin"></span>/v1</code>. Model names: <code>network/&lt;model&gt;</code> (any machine), <code>network/&lt;model&gt;@gpu</code> (one class: cpu, apple, gpu, gpu.dc), <code>mine/&lt;model&gt;</code> (your own machines, free), <code>reserved/&lt;reservation id&gt;/&lt;model&gt;</code> (a machine you reserved). <a href="/portal/market">Prices by class are on the market page.</a></p>
          <p><strong>Cursor</strong>: Settings → Models → API keys: turn on "OpenAI API key", paste the key, turn on "Override OpenAI Base URL" with <code><span class="portal-origin"></span>/v1</code>, then add a custom model such as <code>network/qwen2.5-coder:32b@gpu</code>.</p>
          <p><strong>Claude Code</strong>:</p>
          <pre>export ANTHROPIC_BASE_URL=<span class="portal-origin"></span>
export ANTHROPIC_AUTH_TOKEN=&lt;your key&gt;
export ANTHROPIC_MODEL=network/qwen3.5:9b
export ANTHROPIC_SMALL_FAST_MODEL=network/qwen3.5:9b
claude</pre>
          <p><strong>Any OpenAI client</strong>: base URL <code><span class="portal-origin"></span>/v1</code>, the key as the API key.</p>
        </details>
      </div>
      <div class="card">
        <h2 style="margin-top:0;">Passkey</h2>
        <p class="muted" style="margin-bottom:12px;">Enroll a passkey while logged in for passwordless sign-in on future visits.</p>
        <div class="row">
          <button class="primary" id="passkeyEnrollBtn">Enroll passkey</button>
        </div>
      </div>
    </div>
  `;
  const script = `
    function b64urlToArrayBuffer(base64url) {
      const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }
    function arrayBufferToB64url(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
    }
    let currentUserTheme = "warm";
    async function bootstrapSettings() {
      const me = await requireAuth();
      const user = me.user || {};
      currentUserTheme = user.uiTheme || "warm";
      document.getElementById("accountLine").textContent = (user.email || "unknown") + " | user ID: " + (user.userId || "n/a");
      document.getElementById("themeSelect").value = currentUserTheme;
      document.getElementById("displayNameInput").value = user.displayName || "";
      loadKeys();
      for (const el of document.querySelectorAll(".portal-origin")) el.textContent = location.origin;
    }
    function fmtDate(ms) { return ms ? new Date(ms).toLocaleString() : "never"; }
    async function loadKeys() {
      const body = document.getElementById("keysBody");
      try {
        const res = await api("/portal/api/keys");
        body.textContent = "";
        if (!res.keys.length) { body.innerHTML = '<tr><td colspan="5" class="muted">No keys yet.</td></tr>'; return; }
        for (const k of res.keys) {
          const tr = document.createElement("tr");
          for (const v of [k.name, k.prefix + "…", fmtDate(k.createdAtMs), fmtDate(k.lastUsedMs)]) {
            const td = document.createElement("td"); td.textContent = v; tr.appendChild(td);
          }
          const td = document.createElement("td");
          const btn = document.createElement("button"); btn.textContent = "Revoke";
          btn.addEventListener("click", async () => {
            if (!confirm("Revoke " + k.name + "? Tools using it stop working.")) return;
            try { await api("/portal/api/keys/" + encodeURIComponent(k.keyId), { method: "DELETE" }); showToast("Key revoked."); loadKeys(); }
            catch (err) { showToast("Could not revoke: " + String(err.message || err), true); }
          });
          td.appendChild(btn); tr.appendChild(td); body.appendChild(tr);
        }
      } catch (err) {
        body.innerHTML = '<tr><td colspan="5" class="muted">Could not load keys.</td></tr>';
      }
    }
    document.getElementById("createKeyBtn").addEventListener("click", async () => {
      const name = document.getElementById("newKeyName").value.trim();
      if (!name) { showToast("Name the key first.", true); return; }
      try {
        const res = await api("/portal/api/keys", { method: "POST", body: JSON.stringify({ name }) });
        document.getElementById("newKeyValue").textContent = res.key;
        document.getElementById("newKeyBox").classList.remove("hidden");
        document.getElementById("newKeyName").value = "";
        loadKeys();
      } catch (err) {
        showToast("Could not create key: " + String(err.message || err), true);
      }
    });
    document.getElementById("copyKeyBtn").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(document.getElementById("newKeyValue").textContent); showToast("Copied."); } catch { showToast("Copy failed; select the key and copy it.", true); }
    });
    document.getElementById("saveProfileBtn").addEventListener("click", async () => {
      try {
        const displayName = document.getElementById("displayNameInput").value.trim();
        await api("/me/profile", { method: "POST", body: JSON.stringify({ displayName }) });
        showToast("Profile saved.");
      } catch (err) {
        showToast("Could not save: " + String(err.message || err), true);
      }
    });
    document.getElementById("saveThemeBtn").addEventListener("click", async () => {
      try {
        await requireAuth();
        const theme = document.getElementById("themeSelect").value;
        await api("/me/theme", { method: "POST", body: JSON.stringify({ theme }) });
        applyTheme(theme);
        showToast("Theme updated.");
      } catch (err) {
        showToast("Could not save theme: " + String(err.message || err), true);
      }
    });
    document.getElementById("passkeyEnrollBtn").addEventListener("click", async () => {
      if (!window.PublicKeyCredential) {
        showToast("Passkeys are not supported in this browser.", true);
        return;
      }
      try {
        await requireAuth();
        const payload = await api("/auth/passkey/register/options", { method: "POST", body: JSON.stringify({}) });
        const challengeId = payload.challengeId;
        const options = payload.options;
        options.challenge = b64urlToArrayBuffer(options.challenge);
        options.user.id = b64urlToArrayBuffer(options.user.id);
        options.excludeCredentials = (options.excludeCredentials || []).map((c) => ({ ...c, id: b64urlToArrayBuffer(c.id) }));
        const credential = await navigator.credentials.create({ publicKey: options });
        const response = credential.response;
        await api("/auth/passkey/register/verify", {
          method: "POST",
          body: JSON.stringify({
            challengeId,
            response: {
              id: credential.id,
              rawId: arrayBufferToB64url(credential.rawId),
              type: credential.type,
              response: {
                clientDataJSON: arrayBufferToB64url(response.clientDataJSON),
                attestationObject: arrayBufferToB64url(response.attestationObject),
                transports: response.getTransports ? response.getTransports() : []
              }
            }
          })
        });
        showToast("Passkey enrolled successfully.");
      } catch (err) {
        showToast("Passkey enrollment failed: " + String(err.message || err), true);
      }
    });
    requireAuth().then(revealSettingsAdminTab).catch(() => {});
    bootstrapSettings().catch((err) => showToast("Could not load settings: " + String(err.message || err), true));
  `;
  return reply.type("text/html").send(settingsPage("account", "Account preferences and authentication options.", content, script));
});

app.get("/portal/settings/nodes", async (_req, reply) => {
  const content = `
    <div id="emailVerifyNote" class="callout warn hidden">
      <h3>Email verification required</h3>
      <div class="muted">Your account email is not verified yet. Verify it on the dashboard to fully activate enrolled nodes.</div>
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
  `;
  const script = `
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
    <div id="adminDeniedNote" class="callout warn hidden">
      <h3>Admin access required</h3>
      <div class="muted">This section is only available to system administrators.</div>
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
    function escapeHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
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
