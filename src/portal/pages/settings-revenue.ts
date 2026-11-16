// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { CSP_NONCE } from "../csp-nonce.js";
import { SETTINGS_HELPERS_SCRIPT, settingsPage } from "./settings-shell.js";

/**
 * Settings > Revenue (/portal/settings/revenue), system admins only: EdgeCoder's fee revenue (the
 * network fee pool) and withdrawing it over Lightning. The page shell carries no data; its
 * script calls /portal/api/admin/revenue*, which check the session is a system admin and talk to the
 * coordinator server-side (src/portal/routes/revenue.ts).
 */
export function registerSettingsRevenuePage(app: FastifyInstance): void {
  app.get("/portal/settings/revenue", async (_req, reply) => {
    const content = `
    <style nonce="${CSP_NONCE}">
      .rev-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:12px; margin:12px 0; }
      .rev-stat { border:1px solid var(--card-border); border-radius:var(--radius-sm); padding:10px 12px; background:var(--card); }
      .rev-stat .label { font-size:12px; color:var(--muted); }
      .rev-stat .value { font-size:20px; font-weight:700; margin-top:2px; }
      .rev-bars { display:flex; align-items:flex-end; gap:2px; height:80px; margin:8px 0 4px; }
      .rev-bars span { flex:1; min-width:2px; background:var(--brand); border-radius:2px 2px 0 0; }
      .rev-form { display:flex; flex-direction:column; gap:8px; max-width:640px; }
      .rev-form textarea { width:100%; min-height:72px; font-family:var(--font-mono); font-size:12px; }
      table.rev-table { width:100%; }
    </style>
    <h2 class="set-title">Revenue</h2>
    <p class="set-lead">EdgeCoder's share of every compute payment (the network fee pool), and withdrawing it over Lightning.</p>
    <div id="revDenied" class="callout warn hidden"><h3>Admin access required</h3><div class="muted">This section is only available to system administrators.</div></div>
    <div id="revError" class="callout warn hidden"></div>
    <div id="revBody" class="hidden">
      <div class="card">
        <div class="rev-grid">
          <div class="rev-stat"><div class="label">Fee income (all time)</div><div class="value" id="revIncome">-</div></div>
          <div class="rev-stat"><div class="label">Payable now</div><div class="value" id="revPayable">-</div></div>
          <div class="rev-stat"><div class="label">In earnings hold</div><div class="value" id="revHeld">-</div></div>
          <div class="rev-stat"><div class="label">Withdrawn</div><div class="value" id="revPaid">-</div></div>
          <div class="rev-stat"><div class="label">In flight</div><div class="value" id="revPending">-</div></div>
          <div class="rev-stat"><div class="label">Shared with hosts</div><div class="value" id="revHosts">-</div></div>
        </div>
        <div class="muted" id="revPolicy"></div>
      </div>
      <div class="card">
        <h3 class="u-mt-0">Last 30 days</h3>
        <div class="rev-bars" id="revBars" aria-hidden="true"></div>
        <table class="rev-table"><thead><tr><th>Day (UTC)</th><th>Fee income</th><th>Payments</th></tr></thead><tbody id="revDays"></tbody></table>
      </div>
      <div class="card">
        <h3 class="u-mt-0">Withdraw</h3>
        <p class="muted">Paste a Lightning payment code (lnbc…) with an amount from your wallet's Receive screen. Room for the routing fee cap must remain in the payable balance. We email you a code to confirm. The coordinator's payout caps, pause switch and earnings hold apply.</p>
        <div class="rev-form">
          <textarea id="revInvoice" placeholder="lnbc..." aria-label="Lightning payment code"></textarea>
          <div id="revCodeRow" class="hidden"><input id="revCode" inputmode="numeric" autocomplete="one-time-code" placeholder="Code from the email" aria-label="Email code" /></div>
          <div><button class="primary" id="revWithdrawBtn">Withdraw</button></div>
          <div id="revWithdrawNote" class="muted"></div>
        </div>
      </div>
      <div class="card">
        <h3 class="u-mt-0">Payouts from revenue</h3>
        <table class="rev-table"><thead><tr><th>Created</th><th>Amount</th><th>Fee</th><th>Status</th></tr></thead><tbody id="revPayouts"></tbody></table>
      </div>
    </div>`;
    const script = `
    ${SETTINGS_HELPERS_SCRIPT}
    const sats = (msat) => fmtNum(Math.floor(Number(msat || 0) / 1000), 0) + " sats";
    let challengeId = null;
    function showError(text) { const e = document.getElementById("revError"); e.textContent = text; e.classList.remove("hidden"); }
    function render(r) {
      document.getElementById("revError").classList.add("hidden");
      document.getElementById("revBody").classList.remove("hidden");
      const b = r.balance || {};
      document.getElementById("revIncome").textContent = sats(r.feeIncome && r.feeIncome.totalMsat);
      document.getElementById("revPayable").textContent = sats(b.payableMsat);
      document.getElementById("revHeld").textContent = sats(b.heldMsat);
      document.getElementById("revPaid").textContent = sats(b.paidMsat);
      document.getElementById("revPending").textContent = sats(b.pendingMsat);
      document.getElementById("revHosts").textContent = sats(r.distributedToHostsMsat);
      const hold = Math.round(Number(r.earningsHoldMs || 0) / 3600000);
      document.getElementById("revPolicy").textContent = "Fee " + (Number(r.feeBps || 0) / 100) + "% of each compute payment" +
        (hold ? "; earnings hold " + hold + " h" : "") + (r.hostDistribution ? "; shared with infrastructure hosts" : "") +
        (r.payoutsPaused ? ". Payouts are PAUSED." : ".");
      const days = r.byDay || [];
      const max = Math.max(1, ...days.map((d) => Number(d.msat || 0)));
      const bars = document.getElementById("revBars"); bars.textContent = "";
      for (const d of days) { const s = el("span", { title: d.date + ": " + sats(d.msat) }); s.style.height = Math.max(2, Math.round((Number(d.msat || 0) / max) * 80)) + "px"; bars.appendChild(s); }
      const body = document.getElementById("revDays"); body.textContent = "";
      for (const d of days.slice().reverse()) {
        if (!d.msat && !d.payments) continue;
        const tr = el("tr"); tr.appendChild(el("td", {}, d.date)); tr.appendChild(el("td", {}, sats(d.msat))); tr.appendChild(el("td", {}, String(d.payments))); body.appendChild(tr);
      }
      if (!body.children.length) { const tr = el("tr"); const td = el("td", { colspan: "3" }, "No fee income in the last 30 days."); tr.appendChild(td); body.appendChild(tr); }
      const pb = document.getElementById("revPayouts"); pb.textContent = "";
      for (const p of r.payouts || []) {
        const tr = el("tr"); tr.appendChild(el("td", {}, fmtDate(p.createdAtMs))); tr.appendChild(el("td", {}, sats(p.amountMsat))); tr.appendChild(el("td", {}, sats(p.feeMsat))); tr.appendChild(el("td", {}, p.status + (p.error ? " (" + p.error + ")" : ""))); pb.appendChild(tr);
      }
      if (!pb.children.length) { const tr = el("tr"); tr.appendChild(el("td", { colspan: "4" }, "No withdrawals yet.")); pb.appendChild(tr); }
    }
    async function load() {
      const r = await call("/portal/api/admin/revenue", { method: "GET", headers: {} });
      if (r.status === 403) { document.getElementById("revDenied").classList.remove("hidden"); return; }
      if (!r.ok) { showError("Could not load revenue: " + (r.json.detail || r.json.error || r.status)); return; }
      render(r.json);
    }
    document.getElementById("revWithdrawBtn").addEventListener("click", async () => {
      const note = document.getElementById("revWithdrawNote");
      const bolt11 = document.getElementById("revInvoice").value.trim();
      if (!bolt11) { note.textContent = "Paste an invoice first."; return; }
      const code = document.getElementById("revCode").value.trim();
      const body = challengeId && code ? { bolt11, challengeId, emailCode: code } : { bolt11 };
      note.textContent = "Working...";
      const r = await call("/portal/api/admin/revenue/withdraw", { method: "POST", body: JSON.stringify(body) });
      if (r.status === 202 && r.json.verificationRequired) {
        challengeId = r.json.challengeId;
        document.getElementById("revCodeRow").classList.remove("hidden");
        note.textContent = r.json.detail || "Enter the emailed code and press Withdraw again.";
        return;
      }
      challengeId = null;
      document.getElementById("revCode").value = "";
      document.getElementById("revCodeRow").classList.add("hidden");
      if (r.ok && r.json.ok) { note.textContent = "Paid " + sats(r.json.payout && r.json.payout.amountMsat) + "."; document.getElementById("revInvoice").value = ""; }
      else note.textContent = "Not paid: " + (r.json.detail || r.json.code || r.json.error || r.status);
      await load();
    });
    (async () => {
      const me = await requireAuth();
      revealSettingsAdminTab(me);
      const user = me.user || {};
      if (!(user.roles && user.roles.isSystemAdmin)) { document.getElementById("revDenied").classList.remove("hidden"); return; }
      await load();
    })().catch((err) => showError("Could not load revenue: " + String(err.message || err)));
    `;
    return reply.type("text/html").send(settingsPage("revenue", "EdgeCoder's fee revenue and withdrawals.", content, script));
  });
}
