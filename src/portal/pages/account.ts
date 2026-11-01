// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { portalAuthedPageHtml } from "./layout.js";
import { DOCS_SITE_URL } from "./urls.js";

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
app.get("/portal/wallet", async (_req, reply) => {
  const content = `
    <div class="card">
      <h2 style="margin-top:0;">Wallet security checklist</h2>
      <div id="walletOnboardingMeta" class="muted">Loading wallet onboarding status...</div>
      <div class="row">
        <button class="primary" id="setupSeedBtn">Set up recovery seed phrase</button>
        <button id="walletAckBtn">I backed up my seed phrase</button>
      </div>
      <div id="seedPhraseWrap" class="hidden" style="margin-top:10px;">
        <p class="muted">
          Record this seed phrase now. It is shown only for this setup action and cannot be recovered later.
        </p>
        <div id="seedPhraseValue" class="token-box"></div>
        <div id="derivedAddressWrap" class="hidden" style="margin-top:10px;">
          <strong>Your Bitcoin address (BIP84 native SegWit):</strong>
          <div id="derivedAddressValue" class="token-box" style="margin-top:4px;word-break:break-all;"></div>
        </div>
        <div id="seedGuidance" class="muted" style="margin-top:8px;"></div>
      </div>
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
    function renderSeedGuidance(guidance) {
      const target = document.getElementById("seedGuidance");
      if (!guidance || !Array.isArray(guidance.steps) || guidance.steps.length === 0) {
        target.textContent = "";
        return;
      }
      target.innerHTML = "<strong>" + (guidance.title || "Seed phrase safety guidance") + "</strong><br/>" +
        guidance.steps.map((step, idx) => (idx + 1) + ". " + step).join("<br/>");
    }
    let pendingSendMfa = null;
    let allPaymentIntents = [];
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
        return "<tr><td>" + p.intentId + "</td><td>" + statusBadge(p.status, tone) + "</td><td>" + p.amountSats + "</td><td>" + p.quotedCredits +
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
        return "<tr><td>" + fmtTime(req.createdAtMs) + "</td><td>" + req.destination + "</td><td>" + req.amountSats +
          "</td><td>" + statusBadge(req.status, tone) + "</td><td>" + req.requestId + "</td></tr>";
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
        "<tr><td>" + fmtTime(tx.timestampMs) + "</td><td>" + tx.type + "</td><td>" + tx.credits + "</td><td>" + tx.reason + "</td></tr>"
      );
      renderRows("creditHistoryBody", creditHistoryRows, 4, "No credit transactions yet.");
      const wallets = walletSnapshot.wallets || [];
      const walletRows = wallets.map((w) =>
        "<tr><td>" + (w.walletType || "") + "</td><td>" + (w.network || "") + "</td><td>" + (w.payoutAddress || "n/a") +
        "</td><td>" + (w.lnNodePubkey || w.xpub || "n/a") + "</td></tr>"
      );
      renderRows("walletsBody", walletRows, 4, "No wallets linked.");
      renderDepositDetails(accountId, wallets[0] || null);
      allPaymentIntents = walletSnapshot.paymentIntents || [];
      applyPaymentIntentView();
      try {
        const onboarding = await api("/wallet/onboarding", { method: "GET", headers: {} });
        const status = onboarding.acknowledgedAtMs
          ? "Seed backup confirmed on " + fmtTime(onboarding.acknowledgedAtMs)
          : "Backup not yet confirmed. Generate and record your seed phrase now.";
        var addressInfo = onboarding.derivedAddress ? " | Address: " + onboarding.derivedAddress : "";
        document.getElementById("walletOnboardingMeta").textContent =
          "Network: " + onboarding.network + " | Account: " + onboarding.accountId + addressInfo + " | " + status;
        if (onboarding.derivedAddress) {
          document.getElementById("depositAddressValue").textContent = onboarding.derivedAddress;
        }
      } catch {
        document.getElementById("walletOnboardingMeta").textContent = "Wallet onboarding status unavailable.";
      }
      await loadSendRequests();
    }
    document.getElementById("intentStatusFilter").addEventListener("change", applyPaymentIntentView);
    document.getElementById("intentSortOrder").addEventListener("change", applyPaymentIntentView);
    document.getElementById("sendRequestStatusFilter").addEventListener("change", applySendRequestView);
    document.getElementById("sendRequestSortOrder").addEventListener("change", applySendRequestView);
    document.getElementById("setupSeedBtn").addEventListener("click", async () => {
      try {
        await requireAuth();
        const setup = await api("/wallet/onboarding/setup-seed", { method: "POST", body: JSON.stringify({}) });
        document.getElementById("seedPhraseWrap").classList.remove("hidden");
        document.getElementById("seedPhraseValue").textContent = setup.seedPhrase;
        if (setup.derivedAddress) {
          document.getElementById("derivedAddressWrap").classList.remove("hidden");
          document.getElementById("derivedAddressValue").textContent = setup.derivedAddress;
        }
        renderSeedGuidance(setup.guidance);
        await loadWalletView();
        showToast("New recovery seed phrase generated. Record it before leaving this page.");
      } catch (err) {
        showToast("Could not set up seed phrase: " + String(err.message || err), true);
      }
    });
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
    document.getElementById("walletAckBtn").addEventListener("click", async () => {
      try {
        await requireAuth();
        await api("/wallet/onboarding/acknowledge", { method: "POST", body: JSON.stringify({}) });
        await loadWalletView();
        showToast("Seed backup acknowledgement saved.");
      } catch (err) {
        showToast("Could not save acknowledgement: " + String(err.message || err), true);
      }
    });
    loadWalletView().catch((err) => showToast("Could not load wallet data: " + String(err.message || err), true));
  `;
  return reply.type("text/html").send(portalAuthedPageHtml({
    title: "EdgeCoder Portal | Wallet",
    activeTab: "wallet",
    heading: "Wallet & Credits",
    subtitle: "Credits, payment intents, and wallet onboarding status.",
    content,
    script
  }));
});

app.get("/portal/settings", async (_req, reply) => {
  const content = `
    <style>
      .settings-nav-grid {
        display:grid; grid-template-columns:repeat(4, 1fr); gap:10px; margin-bottom:12px;
      }
      .settings-nav-card {
        display:flex; flex-direction:column; align-items:center; gap:6px;
        padding:18px 12px; text-align:center; text-decoration:none;
        background:var(--card); border:1px solid var(--card-border);
        border-radius:var(--radius-md); color:var(--text);
        transition:all var(--transition-fast);
      }
      .settings-nav-card:hover {
        border-color:var(--brand); transform:translateY(-2px);
        box-shadow:0 4px 16px rgba(0,0,0,0.2);
      }
      .settings-nav-card .snc-icon { font-size:22px; margin-bottom:2px; }
      .settings-nav-card h3 { margin:0; font-size:13px; font-weight:600; }
      .settings-nav-card .muted { font-size:11px; }
      @media (max-width:680px) {
        .settings-nav-grid { grid-template-columns:1fr 1fr; }
      }
    </style>
    <div class="settings-nav-grid">
      <a href="/portal/dashboard" class="settings-nav-card">
        <div class="snc-icon">&#9632;</div>
        <h3>Dashboard</h3>
        <div class="muted">Account and network overview</div>
      </a>
      <a href="/portal/wallet" class="settings-nav-card">
        <div class="snc-icon">&#9733;</div>
        <h3>Wallet & Credits</h3>
        <div class="muted">Manage credits and seeds</div>
      </a>
      <a href="/portal/download" class="settings-nav-card">
        <div class="snc-icon">&#11015;</div>
        <h3>Get EdgeCoder</h3>
        <div class="muted">Download for all platforms</div>
      </a>
      <a href="${DOCS_SITE_URL}" target="_blank" rel="noreferrer" class="settings-nav-card">
        <div class="snc-icon">&#128214;</div>
        <h3>Documentation</h3>
        <div class="muted">Guides and API reference</div>
      </a>
    </div>
    <div class="grid2">
      <div class="card">
        <h2 style="margin-top:0;">&#128100; Account</h2>
        <div id="accountLine" class="muted"><span class="loading-spinner sm"></span> Loading account...</div>
        <label>Theme</label>
        <select id="themeSelect" style="max-width:220px;">
          <option value="warm">Warm</option>
          <option value="midnight">Midnight</option>
          <option value="emerald">Emerald</option>
        </select>
        <div class="row" style="margin-top:10px;">
          <button class="primary" id="saveThemeBtn">Save theme</button>
        </div>
      </div>
      <div class="card">
        <h2 style="margin-top:0;">&#128272; Passkey</h2>
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
      currentUserTheme = "warm";
      document.getElementById("accountLine").textContent = (user.email || "unknown") + " | user ID: " + (user.userId || "n/a");
      document.getElementById("themeSelect").value = currentUserTheme;
    }
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
    bootstrapSettings().catch((err) => showToast("Could not load settings: " + String(err.message || err), true));
  `;
  return reply.type("text/html").send(portalAuthedPageHtml({
    title: "EdgeCoder Portal | Settings",
    activeTab: "settings",
    heading: "Settings",
    subtitle: "Account preferences and authentication options.",
    content,
    script
  }));
});

app.get("/portal/download", async (req, reply) => {
  const GH_RELEASE_BASE = "https://github.com/codyrs82/Edgecoder/releases/latest/download";
  const GH_RELEASES_PAGE = "https://github.com/codyrs82/Edgecoder/releases/latest";
  const userAgent = req.headers["user-agent"] || "";
  const detectedOS = detectOS(userAgent);
  const queryToken = ((req.query as Record<string, string>)?.token || "").trim();
  const tokenDisplay = queryToken || "YOUR_TOKEN";

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
    return `<div class="${cls}" id="card-${id}">${badge}<h3 style="margin:0 0 14px;font-size:15px;">${icon}&nbsp; ${title}</h3>${stepsHtml}</div>`;
  }

  /* ── platform card builders ──────────────────────────────────────── */
  const macCard = wizardCard("macos", "&#127822;", "macOS", [
    `<a class="dl-btn" href="${GH_RELEASE_BASE}/EdgeCoder_aarch64.dmg">Download Desktop App (.dmg)</a>
     <a href="${GH_RELEASES_PAGE}" target="_blank" style="font-size:11px;color:var(--brand);margin-left:8px;">All releases</a>`,
    `Open the <strong>.dmg</strong> and drag EdgeCoder to Applications. The app bundles the agent — no separate install needed.`,
    `Sign in with your EdgeCoder account. The app auto-discovers local models and connects to the mesh.`
  ], detectedOS === "macos");

  const winCard = wizardCard("windows", "&#128187;", "Windows", [
    `<a class="dl-btn" href="${GH_RELEASE_BASE}/EdgeCoder_x64-setup.exe">Download installer (.exe)</a>
     <a href="${GH_RELEASES_PAGE}" target="_blank" style="font-size:11px;color:var(--brand);margin-left:8px;">All releases</a>`,
    `Run the installer. Allow admin access if prompted.`,
    `Sign in with your EdgeCoder account to connect to the mesh.`
  ], detectedOS === "windows");

  const linuxCard = wizardCard("linux", "&#128039;", "Linux (Debian / Ubuntu)", [
    `<a class="dl-btn" href="${GH_RELEASE_BASE}/EdgeCoder_amd64.deb">Download .deb package</a>
     <a class="dl-btn" href="${GH_RELEASE_BASE}/EdgeCoder_amd64.AppImage" style="background:var(--surface);color:var(--brand);border:1px solid var(--brand);">Download AppImage</a>
     <a href="${GH_RELEASES_PAGE}" target="_blank" style="font-size:11px;color:var(--brand);margin-left:8px;">All releases</a>`,
    `<div class="code-block" id="linux-install"><code>sudo dpkg -i EdgeCoder_amd64.deb</code><button class="copy-btn" onclick="copyCmd('linux-install')">Copy</button></div>`,
    `Sign in with your EdgeCoder account to connect to the mesh.`
  ], detectedOS === "linux");

  const iosCard = wizardCard("ios", "&#128241;", "iOS (iPhone / iPad)", [
    `<a class="dl-btn" href="#">Download from App Store</a>
     <span style="font-size:10px;color:var(--muted);margin-left:8px;">TestFlight available now</span>`,
    `Sign in with your <strong>EdgeCoder account</strong>.`,
    `Go to <strong>Settings</strong> and paste your token: <div class="code-block" id="ios-token" style="margin-top:6px;"><code>${tokenDisplay}</code><button class="copy-btn" onclick="copyCmd('ios-token')">Copy</button></div>`
  ], detectedOS === "ios");

  const vscodeCard = wizardCard("vscode", "&#9881;&#65039;", "VS Code Extension", [
    `<div class="code-block" id="vscode-cmd"><code>ext install edgecoder.edgecoder</code><button class="copy-btn" onclick="copyCmd('vscode-cmd')">Copy</button></div>
     <span style="font-size:10px;color:var(--muted);">Run in the VS Code command line, or search "EdgeCoder" in the Extensions panel.</span>`,
    `Open the Command Palette (<kbd>Ctrl+Shift+P</kbd> / <kbd>Cmd+Shift+P</kbd>) &rarr; <strong>EdgeCoder: Configure</strong>.`
  ], false);

  const dockerCard = wizardCard("docker", "&#128051;", "Docker", [
    `<div class="code-block" id="docker-cmd"><code>docker run -d --restart unless-stopped \\
  --name edgecoder \\
  -e EDGE_RUNTIME_MODE=worker \\
  -e AGENT_REGISTRATION_TOKEN=${tokenDisplay} \\
  ghcr.io/edgecoder-io/edgecoder:latest</code><button class="copy-btn" onclick="copyCmd('docker-cmd')">Copy</button></div>`
  ], false);

  /* ── pick primary vs secondary cards ─────────────────────────────── */
  const allCards: Record<string, string> = {
    macos: macCard, windows: winCard, linux: linuxCard, ios: iosCard, vscode: vscodeCard, docker: dockerCard
  };
  const primaryKey = (detectedOS === "unknown") ? "macos" : detectedOS;
  const primaryCard = allCards[primaryKey];
  const secondaryCards = Object.entries(allCards)
    .filter(([k]) => k !== primaryKey)
    .map(([, v]) => v)
    .join("");

  const content = `
    <style>
      .hero-dl{text-align:center;padding:28px 0 18px;}
      .hero-dl h1{font-size:28px;font-weight:700;margin:0 0 6px;color:var(--text);}
      .hero-dl p{font-size:14px;color:var(--muted);margin:0 0 10px;}
      .hero-dl .os-badge{display:inline-block;background:var(--brand);color:#fff;font-size:11px;padding:3px 10px;border-radius:999px;font-weight:600;}
      .feature-row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:0 0 24px;}
      @media(max-width:720px){.feature-row{grid-template-columns:repeat(2,1fr);}}
      .feature-card{background:var(--card);border:1px solid var(--card-border);border-radius:10px;padding:14px;text-align:center;}
      .feature-card .fc-icon{font-size:22px;margin-bottom:6px;}
      .feature-card .fc-title{font-size:12px;font-weight:700;margin-bottom:4px;color:var(--text);}
      .feature-card .fc-desc{font-size:11px;color:var(--muted);line-height:1.45;}
      .wizard-card{position:relative;background:var(--card);border:2px solid var(--brand);border-radius:12px;padding:22px 20px;margin-bottom:18px;}
      .wizard-card.secondary{border:1px solid var(--card-border);}
      .rec-badge{position:absolute;top:-10px;left:16px;background:var(--brand);color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:999px;}
      .step{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px;}
      .step:last-child{margin-bottom:0;}
      .step-num{flex-shrink:0;width:28px;height:28px;border-radius:50%;background:linear-gradient(140deg,var(--brand),var(--brand-2));color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;margin-top:1px;}
      .step-content{font-size:13px;color:var(--text);line-height:1.55;flex:1;}
      .step-content strong{font-weight:600;}
      .dl-btn{display:inline-block;padding:8px 18px;border-radius:8px;background:linear-gradient(140deg,var(--brand),var(--brand-2));color:#fff;text-decoration:none;font-size:13px;font-weight:600;border:none;cursor:pointer;transition:opacity .15s;}
      .dl-btn:hover{opacity:.88;}
      .code-block{position:relative;background:var(--bg-soft);border:1px dashed var(--card-border);border-radius:8px;padding:9px 60px 9px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--text);word-break:break-all;line-height:1.55;}
      .code-block code{background:none;padding:0;font-size:inherit;color:inherit;}
      .copy-btn{position:absolute;right:8px;top:50%;transform:translateY(-50%);background:rgba(193,120,80,0.1);color:var(--brand);border:1px solid rgba(193,120,80,0.25);border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;font-weight:600;transition:background .15s;}
      .copy-btn:hover{background:rgba(193,120,80,0.18);}
      .toggle-link{background:none;border:none;color:var(--brand);cursor:pointer;font-size:13px;font-weight:600;padding:0;margin:10px 0 16px;display:inline-block;}
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
        <div class="fc-icon">&#127760;</div>
        <div class="fc-title">P2P Mesh Network</div>
        <div class="fc-desc">Your device joins a global peer-to-peer mesh for distributed AI inference.</div>
      </div>
      <div class="feature-card">
        <div class="fc-icon">&#9889;</div>
        <div class="fc-title">Earn Credits</div>
        <div class="fc-desc">Contribute idle compute and earn EdgeCoder credits automatically.</div>
      </div>
      <div class="feature-card">
        <div class="fc-icon">&#128274;</div>
        <div class="fc-title">Private &amp; Local-First</div>
        <div class="fc-desc">Code and prompts stay on your machine. Inference runs locally when possible.</div>
      </div>
      <div class="feature-card">
        <div class="fc-icon">&#128421;</div>
        <div class="fc-title">Multi-Platform</div>
        <div class="fc-desc">macOS, Windows, Linux, iOS, Docker, and VS Code — one mesh everywhere.</div>
      </div>
    </div>

    <!-- ── Primary platform card ─────────────────────────────────────── -->
    ${primaryCard}

    <!-- ── Other platforms toggle ─────────────────────────────────────── -->
    <button class="toggle-link" id="toggle-others" onclick="toggleOthers()">Show other platforms</button>
    <div class="other-platforms" id="other-platforms">
      <div class="other-grid">
        ${secondaryCards}
      </div>
    </div>
  `;

  const script = `
    requireAuth().catch(() => {});

    function copyCmd(id) {
      var el = document.getElementById(id);
      if (!el) return;
      var text = el.textContent.replace(/Copy$/, '').replace(/Copied!$/, '').trim();
      navigator.clipboard.writeText(text).then(function() {
        var btn = el.querySelector('.copy-btn');
        if (btn) { btn.textContent = 'Copied!'; setTimeout(function() { btn.textContent = 'Copy'; }, 2000); }
      });
    }

    function toggleOthers() {
      var el = document.getElementById('other-platforms');
      var btn = document.getElementById('toggle-others');
      if (!el || !btn) return;
      el.classList.toggle('show');
      btn.textContent = el.classList.contains('show') ? 'Hide other platforms' : 'Show other platforms';
    }
    ${queryToken ? `
    (function() {
      document.querySelectorAll('.code-block code').forEach(function(el) {
        el.innerHTML = el.innerHTML.replace(/YOUR_TOKEN/g, '${queryToken}');
      });
    })();
    ` : ""}
  `;

  return reply.type("text/html").send(portalAuthedPageHtml({
    title: "EdgeCoder Portal | Get EdgeCoder",
    activeTab: "download",
    heading: "Get EdgeCoder",
    subtitle: "Install the agent, join the mesh, start contributing.",
    content,
    script
  }));
});

}
