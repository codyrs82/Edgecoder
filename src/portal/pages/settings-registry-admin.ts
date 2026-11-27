// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Settings > Admin: the signed coordinator registry (src/portal/coordinator-registry.ts). Lists
 * every member with its status, clean days and health; Approve (pending, suspended, or a new key)
 * asks for the owner's passkey for that approval; Suspend asks for a reason; Billing on (ledger
 * service, phase 4) asks for the passkey too, Billing off does not. Shows whether the
 * audit chain checks out. Client script for the page shell (needs apiDetail, showToast,
 * escapeHtml, formatAdminDate and window.edgecoderPasskeyAssertion from layout.ts).
 */
export const registryAdminSectionHtml = `
    <div id="registryAdminSection" class="hidden">
    <div class="card">
      <h2 class="u-mt-0">Coordinator registry</h2>
      <p class="muted">Community coordinators apply from their account (verified email and a passkey, https, a published key, contact details). Approving needs your passkey. A new member serves 7 clean days on probation before it is active. EdgeCoder's ledger service bills network calls for an outside member only once it is active and you turn its billing on (your passkey again).</p>
      <p class="muted" id="registryAuditNote">Loading…</p>
      <div class="table-scroll wide"><table>
        <thead><tr><th>Node</th><th>Operator</th><th>Status</th><th>Clean days</th><th>Health</th><th>URLs</th><th>Key</th><th>Admitted</th><th>Billing</th><th class="sticky-actions">Actions</th></tr></thead>
        <tbody id="registryBody"><tr><td colspan="10" class="muted">Loading…</td></tr></tbody>
      </table></div>
    </div>
    </div>`;

export const registryAdminScript = `
    /* ── Coordinator registry (admin only; coordinator-registry.ts) ── */
    async function loadRegistryAdmin() {
      const body = document.getElementById("registryBody");
      try {
        const r = await apiDetail("/admin/network/registry", { method: "GET", headers: {} });
        const chain = r.auditChain || {};
        document.getElementById("registryAuditNote").textContent =
          (r.configured ? "Signing key set." : "Signing key not set: the registry is not served.") +
          " Audit chain: " + (chain.ok ? "intact." : "broken at entry " + chain.brokenAtSeq + ".") +
          " At most " + r.maxPerOperator + " coordinators per operator.";
        const rows = (r.members || []).map(function(m) {
          const h = m.health ? m.health.status + (m.health.reason ? " (" + m.health.reason + ")" : "") : "n/a";
          const canApprove = m.operator.kind === "community" && (m.status === "pending" || m.status === "suspended");
          const canSuspend = m.operator.kind === "community" && m.status !== "suspended";
          const id = encodeURIComponent(m.nodeId).replace(/'/g, "%27");
          return "<tr><td><code>" + escapeHtml(m.nodeId) + "</code></td>" +
            "<td>" + escapeHtml(m.operator.kind === "edgecoder" ? "EdgeCoder" : (m.operator.name || m.operator.id) + (m.contact ? " · " + m.contact : "")) + "</td>" +
            "<td>" + escapeHtml(m.status + (m.suspensionReason ? ": " + m.suspensionReason : "")) + "</td>" +
            "<td>" + (m.status === "probation" ? m.cleanDays + " / 7" : "") + "</td>" +
            "<td>" + escapeHtml(h) + "</td>" +
            "<td>" + escapeHtml((m.urls || []).join(" ")) + "</td>" +
            "<td><code title='" + escapeHtml((m.keyFingerprints || []).join(" ")) + "'>" + escapeHtml(String((m.keyFingerprints || [""])[0]).slice(0, 12)) + "…</code></td>" +
            "<td>" + formatAdminDate(m.admittedAtMs) + "</td>" +
            "<td>" + (m.operator.kind === "community" ? (m.billingEnabled ? (m.status === "active" ? "on" : "on (after probation)") : "off") : "") + "</td>" +
            "<td class='sticky-actions'>" +
            (canApprove ? "<button class='primary registryApproveBtn' data-node='" + id + "'>Approve</button> " : "") +
            (m.operator.kind === "community" && m.status !== "pending" ? "<button class='registryRekeyBtn' data-node='" + id + "'>New key</button> " : "") +
            (m.operator.kind === "community" && !m.billingEnabled && (m.status === "probation" || m.status === "active") ? "<button class='registryBillingOnBtn' data-node='" + id + "'>Billing on</button> " : "") +
            (m.operator.kind === "community" && m.billingEnabled ? "<button class='registryBillingOffBtn' data-node='" + id + "'>Billing off</button> " : "") +
            (canSuspend ? "<button class='danger registrySuspendBtn' data-node='" + id + "'>Suspend</button>" : "") +
            "</td></tr>";
        });
        body.innerHTML = rows.join("") || "<tr><td colspan='10' class='muted'>No members yet.</td></tr>";
      } catch (err) {
        body.innerHTML = "<tr><td colspan='10' class='muted'>" + escapeHtml("Could not load the registry: " + String(err.message || err)) + "</td></tr>";
      }
    }
    async function approveRegistryMember(nodeId, publicKeyFingerprint) {
      if (typeof window.edgecoderPasskeyAssertion !== "function") { showToast("Passkeys are not available in this browser.", true); return; }
      try {
        const assertion = await window.edgecoderPasskeyAssertion("/admin/network/registry/passkey-options");
        const payload = Object.assign({ nodeId: nodeId }, publicKeyFingerprint ? { publicKeyFingerprint: publicKeyFingerprint } : {}, assertion);
        await apiDetail("/admin/network/registry/approve", { method: "POST", body: JSON.stringify(payload) });
        showToast(nodeId + " approved: on probation.");
      } catch (err) {
        showToast("Approval failed: " + String(err.message || err), true);
      }
      await loadRegistryAdmin();
    }
    document.getElementById("registryBody").addEventListener("click", async function(ev) {
      const btn = ev.target && ev.target.closest ? ev.target.closest("button") : null;
      if (!btn || !btn.dataset.node) return;
      const nodeId = decodeURIComponent(btn.dataset.node);
      if (btn.classList.contains("registryApproveBtn")) {
        if (!window.confirm("Approve " + nodeId + "? It starts 7 days of probation. You will confirm with your passkey.")) return;
        await approveRegistryMember(nodeId, null);
      } else if (btn.classList.contains("registryRekeyBtn")) {
        const fp = window.prompt("New key fingerprint for " + nodeId + " (64 hex, the fingerprint its /identity reports). It restarts probation. You will confirm with your passkey.");
        if (!fp) return;
        await approveRegistryMember(nodeId, fp.trim().toLowerCase());
      } else if (btn.classList.contains("registryBillingOnBtn")) {
        if (!window.confirm("Turn billing on for " + nodeId + "? EdgeCoder's ledger service bills its network calls once it is active. You will confirm with your passkey.")) return;
        if (typeof window.edgecoderPasskeyAssertion !== "function") { showToast("Passkeys are not available in this browser.", true); return; }
        try {
          const assertion = await window.edgecoderPasskeyAssertion("/admin/network/registry/passkey-options");
          await apiDetail("/admin/network/registry/billing", { method: "POST", body: JSON.stringify(Object.assign({ nodeId: nodeId, enabled: true }, assertion)) });
          showToast("Billing on for " + nodeId + ".");
        } catch (err) {
          showToast("Billing change failed: " + String(err.message || err), true);
        }
        await loadRegistryAdmin();
      } else if (btn.classList.contains("registryBillingOffBtn")) {
        if (!window.confirm("Turn billing off for " + nodeId + "? Seeds stop billing for it at their next registry refresh.")) return;
        try {
          await apiDetail("/admin/network/registry/billing", { method: "POST", body: JSON.stringify({ nodeId: nodeId, enabled: false }) });
          showToast("Billing off for " + nodeId + ".");
        } catch (err) {
          showToast("Billing change failed: " + String(err.message || err), true);
        }
        await loadRegistryAdmin();
      } else if (btn.classList.contains("registrySuspendBtn")) {
        const reason = window.prompt("Suspend " + nodeId + "? Peers stop trusting it at their next registry refresh. Reason:");
        if (reason === null) return;
        try {
          await apiDetail("/admin/network/registry/suspend", { method: "POST", body: JSON.stringify({ nodeId: nodeId, reason: reason.trim() || "suspended_by_owner" }) });
          showToast(nodeId + " suspended.");
        } catch (err) {
          showToast("Suspend failed: " + String(err.message || err), true);
        }
        await loadRegistryAdmin();
      }
    });
`;
