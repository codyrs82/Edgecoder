// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { icon } from "./design-system.js";
import { displayEnrollmentToken, escapeHtml } from "./escape.js";
import { settingsPage, settingsSection } from "./settings-shell.js";

// #16: moved verbatim from src/portal/server.ts.
export function detectOS(userAgent: string): "macos" | "windows" | "linux" | "ios" | "unknown" {
  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (/macintosh|mac os x/.test(ua)) return "macos";
  if (/windows/.test(ua)) return "windows";
  if (/linux|ubuntu|debian/.test(ua)) return "linux";
  return "unknown";
}

export function registerAccountPages(app: FastifyInstance): void {
// Settings > Plan & usage: the wallet (balance, buying cSats, payouts, where we pay you). Was /portal/wallet.
app.get("/portal/settings/plan", async (_req, reply) => {
  const content = `
    <div class="card" id="payoutDestinationCard">
      <h2 style="margin-top:0;">Where should we pay you?</h2>
      <p class="muted" style="margin-top:0;">
        Earnings are paid to a wallet you control. Enter the Lightning address your wallet gives you
        (it looks like name@wallet-domain.com). EdgeCoder never creates or stores your wallet keys.
        On-chain Bitcoin addresses are not supported for payouts yet.
      </p>
      <div id="payoutDestRetired" class="hidden" style="margin:8px 0;padding:8px 10px;border:1px solid var(--warn);border-radius:6px;">
        The address EdgeCoder generated for this account earlier has been retired because no one holds its keys.
        Nothing was ever paid to it. Your earnings are kept until you set a destination below.
      </div>
      <div id="payoutCallbackChanged" class="hidden" role="alert" style="margin:8px 0;padding:8px 10px;border:1px solid var(--warn);border-radius:6px;">
        <p style="margin:0 0 6px;"><strong id="payoutCallbackText"></strong></p>
        <p class="muted" style="margin:0 0 6px;">Payouts to this address are paused and your earnings are kept. Confirm only if your wallet provider moved its servers; otherwise change your address to a wallet you trust.</p>
        <div class="row"><button class="primary" id="payoutCallbackSendBtn">Email me a code</button></div>
        <div id="payoutCallbackCodeWrap" class="hidden" style="margin-top:8px;">
          <label for="payoutCallbackCode">Email code</label>
          <div class="row">
            <input id="payoutCallbackCode" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" style="flex:1;" />
            <button class="primary" id="payoutCallbackConfirmBtn">Confirm payment server</button>
          </div>
        </div>
        <div id="payoutCallbackMsg" class="muted hidden" style="margin-top:6px;"></div>
      </div>
      <table>
        <tbody>
          <tr><th style="width:34%;">Current destination</th><td id="payoutDestCurrent">Loading...</td></tr>
          <tr><th>Network</th><td id="payoutDestNetwork">-</td></tr>
        </tbody>
      </table>
      <label for="payoutDestInput">Lightning address</label>
      <div class="row">
        <input id="payoutDestInput" type="text" autocomplete="off" spellcheck="false" placeholder="you@wallet.example" style="flex:1;" />
        <button class="primary" id="payoutDestSaveBtn">Save</button>
      </div>
      <div id="payoutDestCodeWrap" class="hidden" style="margin-top:8px;">
        <label for="payoutDestCode">Email code</label>
        <div class="row">
          <input id="payoutDestCode" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" style="flex:1;" />
          <button class="primary" id="payoutDestConfirmBtn">Confirm change</button>
        </div>
      </div>
      <div id="payoutDestError" role="alert" class="hidden" style="margin-top:8px;color:var(--danger);"></div>
      <div id="payoutDestInfo" class="muted hidden" style="margin-top:8px;"></div>
    </div>
    <div class="grid2">
      <div class="card">
        <h3 style="margin-top:0;">Deposit details</h3>
        <div class="muted">Use these public wallet details to send BTC into EdgeCoder credits.</div>
        <table>
          <tbody>
            <tr><th style="width:34%;">Account</th><td id="depositAccountValue">-</td></tr>
            <tr><th>Network</th><td id="depositNetworkValue">-</td></tr>
            <tr><th>Lightning node pubkey</th><td id="depositLnPubkeyValue">Not configured</td></tr>
            <tr><th>XPUB</th><td id="depositXpubValue">Not configured</td></tr>
            <tr><th>Payout/deposit address</th><td id="depositAddressValue">Not configured</td></tr>
          </tbody>
        </table>
      </div>
      <div class="card">
        <h3 style="margin-top:0;">Send bitcoin (MFA required)</h3>
        <div class="muted">
          Every send request requires email code + passkey verification. Requests are queued for secure processing.
        </div>
        <label>Destination address</label><input id="sendDestination" type="text" placeholder="bc1... or invoice reference" />
        <label>Amount (sats)</label><input id="sendAmountSats" type="number" min="1" step="1" placeholder="10000" />
        <label>Note (optional)</label><input id="sendNote" type="text" placeholder="Reason for transfer" />
        <div class="row">
          <button class="primary" id="startSendMfaBtn">Start secure send</button>
        </div>
        <div id="sendMfaWrap" class="hidden" style="margin-top:10px;">
          <div class="muted">Step 2: Enter email code and approve passkey challenge.</div>
          <label>Email code</label><input id="sendEmailCode" type="text" placeholder="6-digit code" />
          <div class="row">
            <button id="confirmSendMfaBtn">Confirm send request</button>
          </div>
        </div>
      </div>
    </div>
    <div class="grid2">
      <div class="card">
        <h3 style="margin-top:0;">Withdraw sats</h3>
        <p class="muted" style="margin-top:0;">Sats earned by your agents, paid from the coordinator's Lightning node. Withdrawals need an invoice for an exact amount; automatic payouts go to a Lightning address once the balance passes the minimum.</p>
        <div class="kpis" style="margin-bottom:12px;">
          <div class="kpi"><div class="k">Earned</div><div class="v" id="payoutEarned">–</div></div>
          <div class="kpi"><div class="k">Paid out</div><div class="v" id="payoutPaid">–</div></div>
          <div class="kpi"><div class="k">Available</div><div class="v" id="payoutPayable">–</div></div>
        </div>
        <label>BOLT11 invoice (amount in sats, from your wallet)</label>
        <textarea id="withdrawInvoice" rows="3" placeholder="lnbc…" style="font-family:var(--font-mono);font-size:12px;"></textarea>
        <div class="row" style="margin-top:8px;">
          <button class="primary" id="withdrawBtn">Pay invoice</button>
          <span class="muted" id="payoutPolicyNote"></span>
        </div>
        <div id="withdrawCodeWrap" class="hidden" style="margin-top:8px;">
          <label for="withdrawCode">Email code</label>
          <div class="row">
            <input id="withdrawCode" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" style="flex:1;" />
            <button class="primary" id="withdrawConfirmBtn">Confirm withdrawal</button>
          </div>
          <div class="muted" id="withdrawCodeInfo" style="margin-top:6px;"></div>
        </div>
        <p class="muted" style="margin:14px 0 0;">Automatic payouts go to the Lightning address under "Where should we pay you?".</p>
        <table style="margin-top:14px;">
          <thead><tr><th>Time</th><th>Kind</th><th>Sats</th><th>Fee</th><th>Status</th></tr></thead>
          <tbody id="payoutsBody"></tbody>
        </table>
      </div>
      <div class="card">
        <h3 style="margin-top:0;">Credit ledger</h3>
        <table>
          <thead><tr><th>Time</th><th>Type</th><th>Credits</th><th>Reason</th></tr></thead>
          <tbody id="creditHistoryBody"></tbody>
        </table>
      </div>
      <div class="card">
        <h3 style="margin-top:0;">Wallets and payment intents</h3>
        <table>
          <thead><tr><th>Wallet type</th><th>Network</th><th>Payout</th><th>Node/Xpub</th></tr></thead>
          <tbody id="walletsBody"></tbody>
        </table>
        <h3>Payment intents</h3>
        <div class="table-controls">
          <select id="intentStatusFilter">
            <option value="all">All statuses</option>
            <option value="created">Created</option>
            <option value="settled">Settled</option>
            <option value="expired">Expired</option>
          </select>
          <select id="intentSortOrder">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </div>
        <table>
          <thead><tr><th>Intent</th><th>Status</th><th>Sats</th><th>Credits</th><th>Created</th></tr></thead>
          <tbody id="paymentIntentsBody"></tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">Send request history</h3>
      <div class="table-controls">
        <select id="sendRequestStatusFilter">
          <option value="all">All statuses</option>
          <option value="pending_manual_review">Pending review</option>
          <option value="sent">Sent</option>
          <option value="rejected">Rejected</option>
        </select>
        <select id="sendRequestSortOrder">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>
      <table>
        <thead><tr><th>Created</th><th>Destination</th><th>Sats</th><th>Status</th><th>Request ID</th></tr></thead>
        <tbody id="sendRequestsBody"></tbody>
      </table>
    </div>
  `;
  const script = `
    function fmtTime(ms) { return ms ? new Date(ms).toISOString() : "n/a"; }
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
    function renderRows(targetId, rowsHtml, colspan, emptyText) {
      const el = document.getElementById(targetId);
      el.innerHTML = rowsHtml.length > 0 ? rowsHtml.join("") : "<tr><td colspan='" + colspan + "'>" + emptyText + "</td></tr>";
    }
    let pendingSendMfa = null;
    let allPaymentIntents = [];
    function sats(msat) { return (Number(msat || 0) / 1000).toLocaleString("en-US", { maximumFractionDigits: 0 }); }
    async function loadPayouts() {
      try {
        const p = await api("/wallet/payouts", { method: "GET", headers: {} });
        const b = p.balance || {};
        document.getElementById("payoutEarned").textContent = sats(b.earnedMsat) + " sats";
        document.getElementById("payoutPaid").textContent = sats(b.paidMsat) + " sats";
        document.getElementById("payoutPayable").textContent = sats(b.payableMsat) + " sats";
        const pol = p.policy || {};
        document.getElementById("payoutPolicyNote").textContent = pol.lightningEnabled === false
          ? "Lightning payouts are not enabled on this coordinator yet."
          : "Minimum " + (pol.minPayoutSats || 0).toLocaleString() + " sats; routing fee up to " + ((pol.maxFeeBps || 0) / 100) + "% is deducted. Network: " + (pol.network || "");
        const rows = (p.payouts || []).map((x) => "<tr><td>" + fmtTime(x.createdAtMs) + "</td><td>" + escapeHtml(x.kind) + "</td><td>" + sats(x.amountMsat) +
          "</td><td>" + sats(x.feeMsat) + "</td><td>" + statusBadge(x.status, x.status === "paid" ? "ok" : x.status === "failed" ? "danger" : "warn") + (x.error ? " <span class='muted'>" + escapeHtml(x.error) + "</span>" : "") + "</td></tr>");
        renderRows("payoutsBody", rows, 5, "No payouts yet.");
      } catch (err) {
        document.getElementById("payoutPolicyNote").textContent = "Payout balance unavailable: " + String(err.message || err);
      }
    }
    // Withdrawing asks for an emailed code bound to this invoice: POST { bolt11 } -> 202 { challengeId },
    // then POST { bolt11, challengeId, emailCode }.
    let withdrawChallenge = null;
    function resetWithdrawCode() {
      withdrawChallenge = null;
      document.getElementById("withdrawCodeWrap").classList.add("hidden");
      document.getElementById("withdrawCode").value = "";
    }
    async function submitWithdraw(withCode) {
      const bolt11 = document.getElementById("withdrawInvoice").value.trim();
      if (!bolt11) { showToast("Paste a BOLT11 invoice first.", true); return; }
      const body = { bolt11 };
      if (withCode) {
        const emailCode = document.getElementById("withdrawCode").value.trim();
        if (!emailCode || !withdrawChallenge || withdrawChallenge.bolt11 !== bolt11) { showToast("Enter the code from the email, or request a new one.", true); return; }
        body.challengeId = withdrawChallenge.id;
        body.emailCode = emailCode;
      }
      try {
        const res = await fetch("/wallet/payouts/withdraw", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        let r = {};
        try { r = await res.json(); } catch {}
        if (res.status === 202 && r.verificationRequired) {
          withdrawChallenge = { id: r.challengeId, bolt11 };
          document.getElementById("withdrawCode").value = "";
          document.getElementById("withdrawCodeInfo").textContent = (r.detail || "We emailed you a code.") + " Amount: " + sats(r.amountMsat) + " sats.";
          document.getElementById("withdrawCodeWrap").classList.remove("hidden");
          document.getElementById("withdrawCode").focus();
          return;
        }
        if (withCode) resetWithdrawCode();
        if (res.ok && r.ok) { showToast("Paid " + sats(r.payout.amountMsat) + " sats."); document.getElementById("withdrawInvoice").value = ""; }
        else showToast("Payout " + (r.code || r.error || "failed") + (r.detail ? ": " + r.detail : ""), true);
      } catch (err) { showToast("Withdrawal failed: " + String(err.message || err), true); }
      loadPayouts();
    }
    document.getElementById("withdrawBtn").addEventListener("click", () => { resetWithdrawCode(); submitWithdraw(false); });
    document.getElementById("withdrawConfirmBtn").addEventListener("click", () => submitWithdraw(true));
    let payoutDestChallenge = null;
    function payoutDestMessage(kind, text) {
      const err = document.getElementById("payoutDestError");
      const info = document.getElementById("payoutDestInfo");
      err.classList.add("hidden"); info.classList.add("hidden");
      if (!text) return;
      const el = kind === "error" ? err : info;
      el.textContent = text;
      el.classList.remove("hidden");
    }
    async function payoutDestRequest(method, body) {
      const res = await fetch("/wallet/payout-destination", {
        method,
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      let payload = {};
      try { payload = await res.json(); } catch {}
      return { status: res.status, payload };
    }
    function renderPayoutDest(v) {
      const current = v.destination ? v.destination.destination : null;
      document.getElementById("payoutDestCurrent").textContent = current || "Not set. Payouts are held until you add one.";
      document.getElementById("payoutDestNetwork").textContent = v.network || "-";
      document.getElementById("payoutDestRetired").classList.toggle("hidden", !(v.legacyAddressRetired && !current));
      const input = document.getElementById("payoutDestInput");
      if (current && !input.value) input.value = current;
      const cc = v.callbackChange;
      document.getElementById("payoutCallbackChanged").classList.toggle("hidden", !cc);
      if (cc) document.getElementById("payoutCallbackText").textContent = "Your wallet's payment server changed from " + originHost(cc.previousOrigin) + " to " + originHost(cc.newOrigin) + ". Confirm to keep receiving payouts.";
    }
    function originHost(o) { try { return new URL(o).host; } catch { return String(o); } }
    let payoutCallbackChallenge = null;
    function payoutCallbackMsg(text, isError) {
      const el = document.getElementById("payoutCallbackMsg");
      el.textContent = text || "";
      el.classList.toggle("hidden", !text);
      el.style.color = isError ? "var(--danger)" : "";
    }
    async function confirmPayoutCallback(withCode) {
      const body = {};
      if (withCode) {
        const emailCode = document.getElementById("payoutCallbackCode").value.trim();
        if (!emailCode || !payoutCallbackChallenge) { payoutCallbackMsg("Enter the code from the email.", true); return; }
        body.challengeId = payoutCallbackChallenge;
        body.emailCode = emailCode;
      }
      const res = await fetch("/wallet/payout-destination/callback/confirm", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      let r = {};
      try { r = await res.json(); } catch {}
      if (res.status === 202 && r.verificationRequired) {
        payoutCallbackChallenge = r.challengeId;
        document.getElementById("payoutCallbackCodeWrap").classList.remove("hidden");
        payoutCallbackMsg(r.detail || "We emailed you a code.");
        return;
      }
      payoutCallbackChallenge = null;
      document.getElementById("payoutCallbackCodeWrap").classList.add("hidden");
      document.getElementById("payoutCallbackCode").value = "";
      if (res.ok && r.ok) { payoutCallbackMsg(""); showToast("Confirmed. Payouts will resume."); loadPayoutDestination().catch(() => undefined); return; }
      payoutCallbackMsg(res.status === 429 ? "Too many attempts. Wait a minute and try again." : (r.detail || ("Could not confirm: " + (r.error || res.status))), true);
    }
    document.getElementById("payoutCallbackSendBtn").addEventListener("click", () => confirmPayoutCallback(false).catch((e) => payoutCallbackMsg(String(e.message || e), true)));
    document.getElementById("payoutCallbackConfirmBtn").addEventListener("click", () => confirmPayoutCallback(true).catch((e) => payoutCallbackMsg(String(e.message || e), true)));
    async function loadPayoutDestination() {
      const r = await payoutDestRequest("GET");
      if (r.status !== 200) {
        document.getElementById("payoutDestCurrent").textContent = "Unavailable";
        payoutDestMessage("error", "Could not load your payout destination (" + (r.payload.error || r.status) + ").");
        return;
      }
      renderPayoutDest(r.payload);
    }
    function payoutDestSaved(r) {
      payoutDestChallenge = null;
      document.getElementById("payoutDestCodeWrap").classList.add("hidden");
      document.getElementById("payoutDestCode").value = "";
      renderPayoutDest(r.payload);
      const reg = r.payload.registration || {};
      const registered = reg.controlPlane === "ok" || reg.coordinator === "ok";
      payoutDestMessage("info", registered
        ? "Saved. Payouts will go to " + r.payload.destination.destination + "."
        : "Saved here, but the payout service could not be reached. Save again later so payouts can reach you.");
    }
    async function savePayoutDest(withCode) {
      const destination = document.getElementById("payoutDestInput").value.trim();
      if (!destination) { payoutDestMessage("error", "Enter a Lightning address from your wallet."); return; }
      const body = { destination };
      if (withCode) {
        const emailCode = document.getElementById("payoutDestCode").value.trim();
        if (!emailCode || !payoutDestChallenge) { payoutDestMessage("error", "Enter the code from the email."); return; }
        body.challengeId = payoutDestChallenge;
        body.emailCode = emailCode;
      }
      payoutDestMessage(null);
      const r = await payoutDestRequest("PUT", body);
      if (r.status === 200) return payoutDestSaved(r);
      if (r.status === 202 && r.payload.verificationRequired) {
        payoutDestChallenge = r.payload.challengeId;
        document.getElementById("payoutDestCodeWrap").classList.remove("hidden");
        payoutDestMessage("info", r.payload.detail || "We emailed you a code. Enter it to confirm the change.");
        return;
      }
      if (r.status === 429) { payoutDestMessage("error", "Too many attempts. Wait a minute and try again."); return; }
      if (withCode) { payoutDestChallenge = null; document.getElementById("payoutDestCodeWrap").classList.add("hidden"); }
      payoutDestMessage("error", r.payload.detail || ("Could not save: " + (r.payload.error || r.status)));
    }
    document.getElementById("payoutDestSaveBtn").addEventListener("click", () => savePayoutDest(false).catch((e) => payoutDestMessage("error", String(e.message || e))));
    document.getElementById("payoutDestConfirmBtn").addEventListener("click", () => savePayoutDest(true).catch((e) => payoutDestMessage("error", String(e.message || e))));
    loadPayoutDestination().catch(() => undefined);
    loadPayouts();
    let allSendRequests = [];
    function renderDepositDetails(accountId, wallet) {
      document.getElementById("depositAccountValue").textContent = accountId || "n/a";
      document.getElementById("depositNetworkValue").textContent = wallet && wallet.network ? wallet.network : "n/a";
      document.getElementById("depositLnPubkeyValue").textContent = wallet && wallet.lnNodePubkey ? wallet.lnNodePubkey : "Not configured";
      document.getElementById("depositXpubValue").textContent = wallet && wallet.xpub ? wallet.xpub : "Not configured";
      document.getElementById("depositAddressValue").textContent = wallet && wallet.payoutAddress ? wallet.payoutAddress : "Not configured";
    }
    function renderPaymentIntents(intents) {
      const rows = (intents || []).map((p) => {
        const tone = p.status === "settled" ? "ok" : p.status === "expired" ? "danger" : "warn";
        return "<tr><td>" + escapeHtml(p.intentId) + "</td><td>" + statusBadge(p.status, tone) + "</td><td>" + escapeHtml(p.amountSats) + "</td><td>" + escapeHtml(p.quotedCredits) +
          "</td><td>" + fmtTime(p.createdAtMs) + "</td></tr>";
      });
      renderRows("paymentIntentsBody", rows, 5, "No payment intents.");
    }
    function applyPaymentIntentView() {
      const statusFilter = document.getElementById("intentStatusFilter").value;
      const sortOrder = document.getElementById("intentSortOrder").value;
      const filtered = (allPaymentIntents || []).filter((p) => statusFilter === "all" || String(p.status) === statusFilter);
      filtered.sort((a, b) => sortOrder === "oldest" ? Number(a.createdAtMs || 0) - Number(b.createdAtMs || 0) : Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0));
      renderPaymentIntents(filtered);
    }
    function renderSendRequests(requests) {
      const rows = (requests || []).map((req) => {
        const tone = req.status === "sent" ? "ok" : req.status === "rejected" ? "danger" : "warn";
        return "<tr><td>" + fmtTime(req.createdAtMs) + "</td><td>" + escapeHtml(req.destination) + "</td><td>" + escapeHtml(req.amountSats) +
          "</td><td>" + statusBadge(req.status, tone) + "</td><td>" + escapeHtml(req.requestId) + "</td></tr>";
      });
      renderRows("sendRequestsBody", rows, 5, "No send requests yet.");
    }
    function applySendRequestView() {
      const statusFilter = document.getElementById("sendRequestStatusFilter").value;
      const sortOrder = document.getElementById("sendRequestSortOrder").value;
      const filtered = (allSendRequests || []).filter((r) => statusFilter === "all" || String(r.status) === statusFilter);
      filtered.sort((a, b) => sortOrder === "oldest" ? Number(a.createdAtMs || 0) - Number(b.createdAtMs || 0) : Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0));
      renderSendRequests(filtered);
    }
    async function loadSendRequests() {
      const payload = await api("/wallet/send/requests", { method: "GET", headers: {} });
      allSendRequests = payload.requests || [];
      applySendRequestView();
    }
    async function loadWalletView() {
      await requireAuth();
      const summary = await api("/dashboard/summary", { method: "GET", headers: {} });
      const walletSnapshot = summary.walletSnapshot || {};
      const accountId = (summary.user && summary.user.userId) ? ("acct-" + summary.user.userId) : "n/a";
      const creditHistoryRows = (walletSnapshot.creditHistory || []).map((tx) =>
        "<tr><td>" + fmtTime(tx.timestampMs) + "</td><td>" + escapeHtml(tx.type) + "</td><td>" + escapeHtml(tx.credits) + "</td><td>" + escapeHtml(tx.reason) + "</td></tr>"
      );
      renderRows("creditHistoryBody", creditHistoryRows, 4, "No credit transactions yet.");
      const wallets = walletSnapshot.wallets || [];
      const walletRows = wallets.map((w) =>
        "<tr><td>" + escapeHtml(w.walletType || "") + "</td><td>" + escapeHtml(w.network || "") + "</td><td>" + escapeHtml(w.payoutAddress || "n/a") +
        "</td><td>" + escapeHtml(w.lnNodePubkey || w.xpub || "n/a") + "</td></tr>"
      );
      renderRows("walletsBody", walletRows, 4, "No wallets linked.");
      renderDepositDetails(accountId, wallets[0] || null);
      allPaymentIntents = walletSnapshot.paymentIntents || [];
      applyPaymentIntentView();
      await loadSendRequests();
    }
    document.getElementById("intentStatusFilter").addEventListener("change", applyPaymentIntentView);
    document.getElementById("intentSortOrder").addEventListener("change", applyPaymentIntentView);
    document.getElementById("sendRequestStatusFilter").addEventListener("change", applySendRequestView);
    document.getElementById("sendRequestSortOrder").addEventListener("change", applySendRequestView);
    document.getElementById("startSendMfaBtn").addEventListener("click", async () => {
      try {
        await requireAuth();
        const destination = document.getElementById("sendDestination").value.trim();
        const amountSats = Number(document.getElementById("sendAmountSats").value);
        const note = document.getElementById("sendNote").value.trim();
        if (!destination) throw new Error("destination_required");
        if (!Number.isFinite(amountSats) || amountSats <= 0) throw new Error("amount_sats_invalid");
        const start = await api("/wallet/send/mfa/start", {
          method: "POST",
          body: JSON.stringify({ destination, amountSats, note: note || undefined })
        });
        pendingSendMfa = start;
        document.getElementById("sendMfaWrap").classList.remove("hidden");
        showToast("Verification code sent to your email. Complete passkey confirmation.");
      } catch (err) {
        showToast("Could not start secure send: " + String(err.message || err), true);
      }
    });
    document.getElementById("confirmSendMfaBtn").addEventListener("click", async () => {
      if (!window.PublicKeyCredential) {
        showToast("Passkeys are not supported in this browser.", true);
        return;
      }
      if (!pendingSendMfa || !pendingSendMfa.passkeyOptions) {
        showToast("Start secure send first.", true);
        return;
      }
      try {
        await requireAuth();
        const emailCode = document.getElementById("sendEmailCode").value.trim();
        if (!emailCode) throw new Error("email_code_required");
        const options = pendingSendMfa.passkeyOptions;
        options.challenge = b64urlToArrayBuffer(options.challenge);
        options.allowCredentials = (options.allowCredentials || []).map((c) => ({ ...c, id: b64urlToArrayBuffer(c.id) }));
        const assertion = await navigator.credentials.get({ publicKey: options });
        const response = assertion.response;
        await api("/wallet/send/mfa/confirm", {
          method: "POST",
          body: JSON.stringify({
            challengeId: pendingSendMfa.challengeId,
            emailCode,
            credentialId: assertion.id,
            response: {
              id: assertion.id,
              rawId: arrayBufferToB64url(assertion.rawId),
              type: assertion.type,
              response: {
                clientDataJSON: arrayBufferToB64url(response.clientDataJSON),
                authenticatorData: arrayBufferToB64url(response.authenticatorData),
                signature: arrayBufferToB64url(response.signature),
                userHandle: response.userHandle ? arrayBufferToB64url(response.userHandle) : null
              }
            }
          })
        });
        pendingSendMfa = null;
        document.getElementById("sendMfaWrap").classList.add("hidden");
        document.getElementById("sendEmailCode").value = "";
        showToast("Send request submitted. Status: pending manual review.");
        await loadSendRequests();
      } catch (err) {
        showToast("Could not confirm secure send: " + String(err.message || err), true);
      }
    });
    loadWalletView().catch((err) => showToast("Could not load wallet data: " + String(err.message || err), true));
  `;
  const section = settingsSection("plan", "Plan &amp; usage", "Credits, buying cSats, payouts and where we pay you.", content);
  return reply.type("text/html").send(settingsPage("plan", "Credits, payouts and where we pay you.", section, script + "\n    requireAuth().then(revealSettingsAdminTab).catch(() => undefined);\n", { wide: true }));
});

// Settings > Install agent. Was /portal/download (which redirects here with its ?token=).
app.get("/portal/settings/install", async (req, reply) => {
  const GH_RELEASE_BASE = "https://github.com/codyrs82/Edgecoder/releases/latest/download";
  const GH_RELEASES_PAGE = "https://github.com/codyrs82/Edgecoder/releases/latest";
  const userAgent = req.headers["user-agent"] || "";
  const detectedOS = detectOS(userAgent);
  // Only a well-formed enrolment token is shown in the commands; anything else is the placeholder.
  // Both values are HTML-escaped as well (they land in markup and in copyable shell commands).
  const tokenDisplay = escapeHtml(displayEnrollmentToken((req.query as Record<string, unknown> | undefined)?.token));
  const portalBase = escapeHtml((process.env.PORTAL_PUBLIC_URL || "https://edgecoder.io").replace(/\/$/, ""));

  const osLabels: Record<string, string> = {
    macos: "macOS", windows: "Windows", linux: "Linux", ios: "iOS", unknown: "your OS"
  };

  /* ── helper: build a wizard card ─────────────────────────────────── */
  function wizardCard(
    id: string,
    icon: string,
    title: string,
    steps: string[],
    isPrimary: boolean
  ): string {
    const cls = isPrimary ? "wizard-card" : "wizard-card secondary";
    const badge = isPrimary
      ? `<span class="rec-badge">Recommended for you</span>`
      : "";
    const stepsHtml = steps
      .map(
        (s, i) =>
          `<div class="step"><span class="step-num">${i + 1}</span><div class="step-content">${s}</div></div>`
      )
      .join("");
    return `<div class="${cls}" id="card-${id}">${badge}<h3 style="margin:0 0 14px;font-size:15px;display:flex;align-items:center;gap:10px;"><span class="wz-icon">${icon}</span>${title}</h3>${stepsHtml}</div>`;
  }

  /* ── platform card builders ──────────────────────────────────────── */
  const macCard = wizardCard("macos", icon("apple", 15), "macOS", [
    `<a class="dl-btn" href="${GH_RELEASE_BASE}/EdgeCoder_aarch64.dmg">Download Desktop App (.dmg)</a>
     <a href="${GH_RELEASES_PAGE}" target="_blank" style="font-size:11px;color:var(--brand);margin-left:8px;">All releases</a>`,
    `Open the <strong>.dmg</strong> and drag EdgeCoder to Applications. The app bundles the agent — no separate install needed.`,
    `Sign in with your EdgeCoder account. The app auto-discovers local models and connects to the mesh.`
  ], detectedOS === "macos");

  const winCard = wizardCard("windows", icon("windows", 15), "Windows", [
    `<a class="dl-btn" href="${GH_RELEASE_BASE}/EdgeCoder_x64-setup.exe">Download installer (.exe)</a>
     <a href="${GH_RELEASES_PAGE}" target="_blank" style="font-size:11px;color:var(--brand);margin-left:8px;">All releases</a>`,
    `Run the installer. Allow admin access if prompted.`,
    `Sign in with your EdgeCoder account to connect to the mesh.`
  ], detectedOS === "windows");

  const linuxCard = wizardCard("linux", icon("terminal", 15), "Linux (Debian / Ubuntu)", [
    `<a class="dl-btn" href="${GH_RELEASE_BASE}/EdgeCoder_amd64.deb">Download .deb package</a>
     <a class="dl-btn" href="${GH_RELEASE_BASE}/EdgeCoder_amd64.AppImage" style="background:var(--surface);color:var(--brand);border:1px solid var(--brand);">Download AppImage</a>
     <a href="${GH_RELEASES_PAGE}" target="_blank" style="font-size:11px;color:var(--brand);margin-left:8px;">All releases</a>`,
    `<div class="code-block" id="linux-install"><code>sudo dpkg -i EdgeCoder_amd64.deb</code><button class="copy-btn" data-copy="linux-install">Copy</button></div>`,
    `Sign in with your EdgeCoder account to connect to the mesh.`
  ], detectedOS === "linux");

  const iosCard = wizardCard("ios", icon("phone", 15), "iOS (iPhone / iPad)", [
    `<a class="dl-btn" href="#">Download from App Store</a>
     <span style="font-size:10px;color:var(--muted);margin-left:8px;">TestFlight available now</span>`,
    `Sign in with your <strong>EdgeCoder account</strong>.`,
    `Go to <strong>Settings</strong> and paste your token: <div class="code-block" id="ios-token" style="margin-top:6px;"><code>${tokenDisplay}</code><button class="copy-btn" data-copy="ios-token">Copy</button></div>`
  ], detectedOS === "ios");

  const vscodeCard = wizardCard("vscode", icon("code", 15), "VS Code Extension", [
    `<div class="code-block" id="vscode-cmd"><code>ext install edgecoder.edgecoder</code><button class="copy-btn" data-copy="vscode-cmd">Copy</button></div>
     <span style="font-size:10px;color:var(--muted);">Run in the VS Code command line, or search "EdgeCoder" in the Extensions panel.</span>`,
    `Open the Command Palette (<kbd>Ctrl+Shift+P</kbd> / <kbd>Cmd+Shift+P</kbd>) &rarr; <strong>EdgeCoder: Configure</strong>.`
  ], false);

  const dockerCard = wizardCard("docker", icon("box", 15), "Docker", [
    `<div class="code-block" id="docker-cmd"><code>docker run -d --restart unless-stopped \\
  --name edgecoder \\
  -e EDGE_RUNTIME_MODE=worker \\
  -e AGENT_REGISTRATION_TOKEN=${tokenDisplay} \\
  ghcr.io/edgecoder-io/edgecoder:latest</code><button class="copy-btn" data-copy="docker-cmd">Copy</button></div>`
  ], false);

  /* ── pick primary vs secondary cards ─────────────────────────────── */
  const allCards: Record<string, string> = {
    macos: macCard, windows: winCard, linux: linuxCard, ios: iosCard, vscode: vscodeCard, docker: dockerCard
  };
  const primaryKey = (detectedOS === "unknown") ? "macos" : detectedOS;
  const primaryCard = allCards[primaryKey];
  // One installer for every platform (docs/install.md): detects GPUs, one agent per GPU.
  const universalCard = `<div class="wizard-card secondary" id="card-universal"><h3 style="margin:0 0 6px;font-size:15px;display:flex;align-items:center;gap:10px;"><span class="wz-icon">${icon("server", 15)}</span>Servers and GPU hosts: one-line install (Linux, macOS, Windows)</h3>
    <p style="margin:0 0 12px;font-size:13px;color:var(--muted);">Detects every GPU and runs one agent per card with a model sized to its memory. Same options on all three platforms; the packages above run the same installer.</p>
    <div class="code-block" id="install-sh"><code>curl -fsSLo install.sh ${portalBase}/install.sh && sudo bash install.sh --token ${tokenDisplay}</code><button class="copy-btn" data-copy="install-sh">Copy</button></div>
    <div class="code-block" id="install-ps1" style="margin-top:8px;"><code>irm ${portalBase}/install.ps1 -OutFile install.ps1; .\\install.ps1 -- --token ${tokenDisplay}</code><button class="copy-btn" data-copy="install-ps1">Copy</button></div>
    <div style="font-size:12px;color:var(--muted);margin-top:8px;">Then <code>sudo edgecoder-install plan</code> shows the node ids to enrol; pass each token with <code>--token &lt;node-id&gt;=&lt;token&gt;</code>.</div></div>`;
  const secondaryCards = universalCard + Object.entries(allCards)
    .filter(([k]) => k !== primaryKey)
    .map(([, v]) => v)
    .join("");

  const content = `
    <style>
      .hero-dl{padding:4px 0 20px;}
      .hero-dl h1{font-size:22px;font-weight:600;margin:0 0 6px;color:var(--text);letter-spacing:-0.02em;}
      .hero-dl p{font-size:14px;color:var(--muted);margin:0 0 10px;}
      .hero-dl .os-badge{display:inline-flex;align-items:center;gap:6px;background:var(--brand-soft);color:var(--brand-2);border:1px solid var(--brand-border);font-size:11px;padding:3px 10px;border-radius:999px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;}
      .feature-row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:0 0 24px;}
      @media(max-width:720px){.feature-row{grid-template-columns:repeat(2,1fr);}}
      .feature-card{background:var(--card);border:1px solid var(--card-border);border-radius:var(--radius-md);padding:14px;text-align:left;}
      .feature-card .fc-icon{width:30px;height:30px;border-radius:var(--radius-sm);border:1px solid var(--card-border);background:var(--bg-surface);display:inline-flex;align-items:center;justify-content:center;color:var(--brand-2);margin-bottom:8px;}
      .feature-card .fc-title{font-size:12px;font-weight:700;margin-bottom:4px;color:var(--text);}
      .feature-card .fc-desc{font-size:11px;color:var(--muted);line-height:1.45;}
      .wz-icon{width:28px;height:28px;border-radius:var(--radius-sm);border:1px solid var(--card-border);background:var(--bg-surface);display:inline-flex;align-items:center;justify-content:center;color:var(--brand-2);flex:none;}
      .wizard-card{position:relative;background:var(--card);border:1px solid var(--brand-border);border-radius:var(--radius-md);padding:22px 20px;margin-bottom:18px;}
      .wizard-card.secondary{border:1px solid var(--card-border);}
      .rec-badge{position:absolute;top:-10px;left:16px;background:var(--brand);color:var(--on-accent);font-size:10px;font-weight:700;padding:3px 10px;border-radius:999px;letter-spacing:0.04em;}
      .step{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px;}
      .step:last-child{margin-bottom:0;}
      .step-num{flex-shrink:0;width:26px;height:26px;border-radius:50%;background:var(--brand);color:var(--on-accent);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;margin-top:1px;font-family:var(--font-mono);}
      .step-content{font-size:13px;color:var(--text);line-height:1.55;flex:1;}
      .step-content strong{font-weight:600;}
      .dl-btn{display:inline-block;padding:8px 18px;border-radius:8px;background:var(--brand);color:var(--on-accent);text-decoration:none;font-size:13px;font-weight:600;border:none;cursor:pointer;transition:opacity .15s;}
      .dl-btn:hover{opacity:.88;}
      .code-block{position:relative;background:var(--bg-input);border:1px solid var(--card-border);border-radius:var(--radius-sm);padding:9px 60px 9px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--text);word-break:break-all;line-height:1.55;}
      .code-block code{background:none;padding:0;font-size:inherit;color:inherit;}
      .copy-btn{position:absolute;right:8px;top:50%;transform:translateY(-50%);background:var(--bg-elevated);color:var(--text-secondary);border:1px solid var(--border-strong);border-radius:var(--radius-sm);padding:3px 10px;min-height:0;font-size:11px;cursor:pointer;font-weight:600;}
      .copy-btn:hover{color:var(--text);}
      .toggle-link{background:none;border:none;color:var(--brand-2);cursor:pointer;font-size:13px;font-weight:600;padding:0;min-height:0;margin:10px 0 16px;display:inline-block;}
      .toggle-link:hover{background:none;}
      .toggle-link:hover{text-decoration:underline;}
      .other-platforms{display:none;}
      .other-platforms.show{display:block;}
      .other-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;}
      @media(max-width:720px){.other-grid{grid-template-columns:1fr;}}
    </style>

    <!-- ── Hero ──────────────────────────────────────────────────────── -->
    <div class="hero-dl">
      <h1>Get EdgeCoder</h1>
      <p>Install the agent. Join the mesh. Earn credits.</p>
      <span class="os-badge">Detected: ${osLabels[detectedOS] || "Unknown"}</span>
    </div>

    <!-- ── Feature cards ─────────────────────────────────────────────── -->
    <div class="feature-row">
      <div class="feature-card">
        <div class="fc-icon">${icon("globe", 14)}</div>
        <div class="fc-title">P2P Mesh Network</div>
        <div class="fc-desc">Your device joins a global peer-to-peer mesh for distributed AI inference.</div>
      </div>
      <div class="feature-card">
        <div class="fc-icon">${icon("zap", 14)}</div>
        <div class="fc-title">Earn Credits</div>
        <div class="fc-desc">Contribute idle compute and earn EdgeCoder credits automatically.</div>
      </div>
      <div class="feature-card">
        <div class="fc-icon">${icon("shield", 14)}</div>
        <div class="fc-title">Private &amp; Local-First</div>
        <div class="fc-desc">Code and prompts stay on your machine. Inference runs locally when possible.</div>
      </div>
      <div class="feature-card">
        <div class="fc-icon">${icon("server", 14)}</div>
        <div class="fc-title">Multi-Platform</div>
        <div class="fc-desc">macOS, Windows, Linux, iOS, Docker, and VS Code — one mesh everywhere.</div>
      </div>
    </div>

    <!-- ── Primary platform card ─────────────────────────────────────── -->
    ${primaryCard}

    <!-- ── Other platforms toggle ─────────────────────────────────────── -->
    <button class="toggle-link" id="toggle-others">Show other platforms</button>
    <div class="other-platforms" id="other-platforms">
      <div class="other-grid">
        ${secondaryCards}
      </div>
    </div>
  `;

  const script = `
    requireAuth().then(revealSettingsAdminTab).catch(() => {});

    function copyCmd(id) {
      var el = document.getElementById(id);
      if (!el) return;
      var text = el.textContent.replace(/Copy$/, '').replace(/Copied!$/, '').trim();
      navigator.clipboard.writeText(text).then(function() {
        var btn = el.querySelector('.copy-btn');
        if (btn) { btn.textContent = 'Copied!'; setTimeout(function() { btn.textContent = 'Copy'; }, 2000); }
      });
    }
    document.querySelectorAll('.copy-btn[data-copy]').forEach(function(btn) {
      btn.addEventListener('click', function() { copyCmd(btn.getAttribute('data-copy')); });
    });

    document.getElementById('toggle-others').addEventListener('click', function() {
      var el = document.getElementById('other-platforms');
      var btn = document.getElementById('toggle-others');
      if (!el || !btn) return;
      el.classList.toggle('show');
      btn.textContent = el.classList.contains('show') ? 'Hide other platforms' : 'Show other platforms';
    });
  `;

  // The token is rendered (escaped) on the server; the script no longer rewrites it.
  return reply.type("text/html").send(settingsPage("install", "Install the agent, join the mesh, start contributing.", content, script, { wide: true }));
});

}
