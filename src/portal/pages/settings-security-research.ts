// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Settings > Admin > Security research access (src/portal/security-research.ts): grant, suspend,
 * reinstate and revoke the restricted-model tier. Shown to system admins only, like the other
 * admin sections; the API checks it again.
 */

export const securityResearchSectionHtml = `
    <div id="securityResearchSection" class="hidden">
    <div class="card">
      <h2 class="u-mt-0">Security research access</h2>
      <p class="muted">For verified organisations doing authorized security testing. Grant only with a signed authorization agreement to test only systems they own or are authorized to test. Restricted models run only on the holder's own approved machines or machines it reserved, never on the open network. Suspending takes effect at once and cancels calls in flight. See docs/security-research-tier.md.</p>
      <div class="row">
        <input id="srAccount" type="text" maxlength="320" placeholder="Account email or user id" aria-label="Account email or user id" />
        <select id="srKind" aria-label="Access kind">
          <option value="security_research">Call restricted models</option>
          <option value="security_research_host">Host restricted models (their machines)</option>
        </select>
        <input id="srOrg" type="text" maxlength="200" placeholder="Organisation name" aria-label="Organisation name" />
      </div>
      <div class="row">
        <input id="srAgreement" type="text" maxlength="500" placeholder="Signed agreement: document id or URL" aria-label="Signed authorization agreement reference" />
        <label class="muted">Accepted <input id="srAccepted" type="date" aria-label="Date the agreement was accepted" /></label>
        <label class="muted">Expires <input id="srExpires" type="date" aria-label="Expiry date" /></label>
      </div>
      <div class="row">
        <textarea id="srNotes" maxlength="4000" rows="3" placeholder="Verification notes: how the organisation and signatory were verified" aria-label="Verification notes"></textarea>
        <button class="primary" id="srGrantBtn">Grant access</button>
      </div>
      <div class="table-scroll"><table>
        <thead><tr><th>Account</th><th>Kind</th><th>Organisation</th><th>Agreement</th><th>Expires</th><th>Status</th><th>Granted by</th><th>Actions</th></tr></thead>
        <tbody id="srBody"></tbody>
      </table></div>
    </div>
    </div>`;

export const securityResearchScript = `
    /* ── Security research access (admin only; src/portal/security-research.ts) ── */
    const SR_STATUS = { active: ["ACTIVE", "ok"], suspended: ["SUSPENDED", "warn"], revoked: ["REVOKED", "warn"], expired: ["EXPIRED", "warn"] };
    const SR_KIND = { security_research: "Call", security_research_host: "Host" };
    async function loadSecurityResearch() {
      try {
        const data = await api("/portal/api/admin/security-research", { method: "GET", headers: {} });
        const rows = (data.entitlements || []).map(function(e) {
          const st = SR_STATUS[e.effectiveStatus] || [String(e.effectiveStatus), "warn"];
          const attrs = " data-uid='" + encodeAttr(e.userId) + "' data-kind='" + encodeAttr(e.kind) + "'";
          let actions = "<span class='muted'>–</span>";
          if (e.status === "active") actions = "<button class='srActionBtn'" + attrs + " data-action='suspend'>Suspend</button> <button class='srActionBtn'" + attrs + " data-action='revoke'>Revoke</button>";
          else if (e.status === "suspended") actions = "<button class='srActionBtn primary'" + attrs + " data-action='reinstate'>Reinstate</button> <button class='srActionBtn'" + attrs + " data-action='revoke'>Revoke</button>";
          return "<tr><td>" + escapeHtml(e.email || e.userId) + "</td><td>" + escapeHtml(SR_KIND[e.kind] || e.kind) + "</td><td>" + escapeHtml(e.orgName) +
            "<div class='muted'>" + escapeHtml(e.verificationNotes) + "</div></td><td>" + escapeHtml(e.agreementRef) + "<div class='muted'>accepted " + fmtTime(e.agreementAcceptedAtMs) +
            "</div></td><td>" + fmtTime(e.expiresAtMs) + "</td><td>" + statusBadge(st[0], st[1]) + "</td><td>" + escapeHtml(e.grantedBy) + "</td><td>" + actions + "</td></tr>";
        });
        renderRows("srBody", rows, 8, "No security research access granted.");
      } catch (err) {
        renderRows("srBody", [], 8, "Could not load security research access.");
      }
    }
    document.getElementById("srGrantBtn").addEventListener("click", async function() {
      const body = {
        account: document.getElementById("srAccount").value.trim(),
        kind: document.getElementById("srKind").value,
        orgName: document.getElementById("srOrg").value.trim(),
        agreementRef: document.getElementById("srAgreement").value.trim(),
        agreementAcceptedAt: document.getElementById("srAccepted").value,
        expiresAt: document.getElementById("srExpires").value,
        verificationNotes: document.getElementById("srNotes").value.trim()
      };
      try {
        const r = await api("/portal/api/admin/security-research", { method: "POST", body: JSON.stringify(body) });
        const c = r.coordinators || {};
        showToast("Access granted (" + Number(c.notified || 0) + " coordinator(s) told now" + (c.failed ? ", " + Number(c.failed) + " will pick it up on their next sync" : "") + ").");
        await loadSecurityResearch();
      } catch (err) {
        showToast("Could not grant access: " + String(err.message || err), true);
      }
    });
    document.getElementById("srBody").addEventListener("click", async function(event) {
      const target = event.target;
      if (!target || !target.classList || !target.classList.contains("srActionBtn")) return;
      const uid = target.getAttribute("data-uid");
      const kind = target.getAttribute("data-kind");
      const action = target.getAttribute("data-action");
      if (!uid || !kind || !action) return;
      if (action === "revoke" && !window.confirm("Revoke this access? It cannot be reinstated; access again needs a new grant.")) return;
      try {
        await api("/portal/api/admin/security-research/" + encodeURIComponent(uid) + "/" + encodeURIComponent(kind) + "/" + action, { method: "POST", body: JSON.stringify({}) });
        showToast(action === "reinstate" ? "Access reinstated." : action === "suspend" ? "Access suspended; calls in flight were cancelled." : "Access revoked; calls in flight were cancelled.");
        await loadSecurityResearch();
      } catch (err) {
        showToast("Update failed: " + String(err.message || err), true);
      }
    });
`;
