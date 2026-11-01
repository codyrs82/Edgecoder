// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";

// #16: moved verbatim from src/portal/server.ts.
export function registerLegacyPage(app: FastifyInstance): void {
app.get("/portal-legacy", async (_req, reply) => {
  const html = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>EdgeCoder Portal</title>
      <style>
        :root {
          --bg: #1a1a18;
          --bg-soft: #2f2f2d;
          --bg-surface: #3a3a37;
          --bg-elevated: #454542;
          --bg-input: #262624;
          --card: rgba(58, 58, 55, 0.96);
          --card-border: rgba(214, 204, 194, 0.08);
          --border-strong: rgba(214, 204, 194, 0.15);
          --text: #f7f5f0;
          --text-secondary: #b8b0a4;
          --muted: #8a8478;
          --brand: #c17850;
          --brand-2: #d4895f;
          --ok: #4ade80;
          --warn: #fbbf24;
          --danger: #f87171;
          --yellow: #fbbf24;
          --font-mono: "SF Mono", "Fira Code", "Cascadia Code", monospace;
        }
        * { box-sizing: border-box; }
        body {
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 14px;
          line-height: 1.5;
          margin: 0;
          color: var(--text);
          background: var(--bg);
          min-height: 100vh;
          -webkit-font-smoothing: antialiased;
        }
        .shell { max-width: 1180px; margin: 24px auto 48px; padding: 0 16px; }
        h1, h2, h3 { margin: 8px 0; letter-spacing: -0.01em; }
        .hidden { display: none; }
        .hero {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 14px;
          margin-bottom: 16px;
        }
        .brand-mark {
          width: 40px;
          height: 40px;
          border-radius: 12px;
          background: linear-gradient(140deg, var(--brand), var(--brand-2));
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
          box-shadow: 0 0 0 1px rgba(255,255,255,0.1) inset, 0 12px 24px rgba(14, 116, 144, 0.25);
        }
        .hero-left { display: flex; gap: 12px; align-items: center; }
        .hero h1 { font-size: 26px; margin: 0; }
        .muted { color: var(--muted); font-size: 13px; }
        .pill-row { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
        .pill {
          border: 1px solid var(--card-border);
          border-radius: 999px;
          padding: 5px 10px;
          font-size: 12px;
          color: var(--text-secondary);
          background: var(--bg-surface);
          backdrop-filter: blur(8px);
        }
        .grid { display: grid; grid-template-columns: repeat(2, minmax(320px, 1fr)); gap: 14px; }
        .card {
          background: var(--card);
          border: 1px solid var(--card-border);
          border-radius: 14px;
          padding: 16px;
          margin-bottom: 12px;
          backdrop-filter: blur(10px);
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
        }
        .card h2, .card h3 { margin-top: 0; }
        .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .kpis { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 10px; margin-top: 12px; }
        .kpi {
          border: 1px solid var(--card-border);
          border-radius: 10px;
          padding: 10px;
          background: var(--bg-input);
        }
        .kpi .label { color: var(--muted); font-size: 12px; }
        .kpi .value { font-size: 18px; font-weight: 700; margin-top: 2px; }
        label { display: block; margin: 8px 0 4px; font-size: 13px; color: var(--text-secondary); }
        input, select {
          width: 100%;
          padding: 10px 11px;
          border: 1px solid var(--card-border);
          border-radius: 10px;
          background: var(--bg-input);
          color: var(--text);
          font-family: inherit;
        }
        input::placeholder { color: var(--muted); }
        button {
          padding: 9px 12px;
          border-radius: 10px;
          border: 1px solid var(--card-border);
          background: var(--bg-soft);
          color: var(--text);
          cursor: pointer;
          transition: transform .08s ease, border-color .12s ease, background .12s ease;
        }
        button:hover { border-color: var(--border-strong); transform: translateY(-1px); }
        button.primary {
          background: linear-gradient(140deg, var(--brand), var(--brand-2));
          border-color: rgba(193, 120, 80, 0.7);
          color: white;
        }
        button.primary:hover { background: linear-gradient(140deg, var(--brand-2), var(--brand)); }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th, td {
          border-bottom: 1px solid var(--card-border);
          text-align: left;
          padding: 8px 6px;
          vertical-align: top;
          font-family: inherit;
        }
        th { color: var(--text-secondary); font-weight: 600; }
        code {
          background: rgba(193, 120, 80, 0.15);
          border: 1px solid rgba(193, 120, 80, 0.25);
          padding: 2px 5px;
          border-radius: 6px;
          font-family: var(--font-mono);
        }
        .token-box {
          border: 1px dashed rgba(193, 120, 80, 0.4);
          border-radius: 10px;
          padding: 10px;
          background: rgba(193, 120, 80, 0.08);
          word-break: break-all;
          font-family: var(--font-mono);
          line-height: 1.45;
        }
        #toast {
          position: fixed;
          top: 20px;
          right: 20px;
          width: min(420px, calc(100vw - 32px));
          z-index: 100;
          margin: 0;
        }
        @media (max-width: 920px) {
          .grid { grid-template-columns: 1fr; }
          .hero { flex-direction: column; align-items: flex-start; }
          .pill-row { justify-content: flex-start; }
          .kpis { grid-template-columns: 1fr; }
        }
      </style>
    </head>
    <body>
      <div class="shell">
        <div class="hero">
          <div class="hero-left">
            <div class="brand-mark">E</div>
            <div>
              <h1>EdgeCoder Portal</h1>
              <div class="muted">Manage identity, node activation, credits, and wallets in one place.</div>
            </div>
          </div>
          <div class="pill-row">
            <span class="pill">Privacy-first</span>
            <span class="pill">SSO + Passkeys</span>
            <span class="pill">BTC/LN credits</span>
          </div>
        </div>

        <div id="authView" class="grid">
          <div class="card">
            <h2>Get started</h2>
            <p class="muted">Create your account to enroll agents and coordinators. Accounts remain dormant until email is verified.</p>
            <label>Email</label><input id="signupEmail" type="email" placeholder="you@company.com" />
            <label>Password</label><input id="signupPassword" type="password" placeholder="At least 8 characters" />
            <label>Display name (optional)</label><input id="signupDisplayName" type="text" placeholder="Team or your name" />
            <div class="row" style="margin-top:10px;">
              <button class="primary" id="signupBtn">Create account</button>
            </div>
          </div>
          <div class="card">
            <h2>Sign in</h2>
            <label>Email</label><input id="loginEmail" type="email" placeholder="you@company.com" />
            <label>Password</label><input id="loginPassword" type="password" placeholder="Your password" />
            <div class="row" style="margin-top:10px;">
              <button class="primary" id="loginBtn">Log in</button>
              <button id="resendBtn">Resend verification</button>
            </div>
            <div class="row" style="margin-top:10px;">
              <button id="passkeyLoginBtn">Log in with passkey</button>
              <button id="passkeyEnrollBtn">Enroll passkey</button>
            </div>
            <h3 style="margin-top:16px;">Single sign-on</h3>
            <div class="row">
              <a href="/auth/oauth/google/start"><button>Google</button></a>
              <a href="/auth/oauth/microsoft/start"><button>Microsoft 365</button></a>
            </div>
          </div>
        </div>

        <div id="dashboardView" class="hidden">
          <div class="card">
            <div class="row" style="justify-content:space-between;">
              <div>
                <h2>Account Overview</h2>
                <div id="accountMeta" class="muted"></div>
              </div>
              <div class="row">
                <select id="themeSelect" style="min-width: 140px;">
                  <option value="warm">Warm</option>
                  <option value="midnight">Midnight</option>
                  <option value="emerald">Emerald</option>
                </select>
                <button id="refreshBtn">Refresh</button>
                <button id="logoutBtn">Log out</button>
              </div>
            </div>
            <div class="kpis">
              <div class="kpi"><div class="label">Current credits</div><div class="value" id="creditsValue">-</div></div>
              <div class="kpi"><div class="label">Estimated sats</div><div class="value" id="creditsSatsValue">n/a</div></div>
              <div class="kpi"><div class="label">Account ID</div><div class="value" style="font-size:13px;font-family:ui-monospace,monospace;" id="accountIdLabel"></div></div>
            </div>
          </div>

          <div class="card">
            <h3>Wallet Security Checklist</h3>
            <p class="muted">Your seed phrase is shown only once at signup. Confirm you have safely backed it up offline.</p>
            <div id="walletOnboardingMeta" class="muted">Loading wallet onboarding status...</div>
            <div class="row" style="margin-top:8px;">
              <button id="walletAckBtn">I backed up my seed phrase</button>
            </div>
          </div>

          <div class="grid">
            <div class="card">
              <h3>Enroll node</h3>
              <label>Node ID</label><input id="nodeId" type="text" placeholder="mac-worker-001" />
              <label>Node type</label>
              <select id="nodeKind">
                <option value="agent">Agent</option>
                <option value="coordinator">Coordinator</option>
              </select>
              <div class="row" style="margin-top:10px;">
                <button class="primary" id="enrollBtn">Generate node token</button>
              </div>
              <p class="muted">Install this token as <code>AGENT_REGISTRATION_TOKEN</code> or coordinator registration token.</p>
              <div id="newTokenWrap" class="hidden">
                <p class="muted">Registration token (save now; it will not be shown again):</p>
                <div id="newToken" class="token-box"></div>
              </div>
            </div>

            <div class="card">
              <h3>Node activation</h3>
              <p class="muted">A node is active only when email is verified and coordinator admin approval is complete.</p>
              <table>
                <thead><tr><th>Node</th><th>Type</th><th>Email verified</th><th>Approved</th><th>Active</th><th>Last seen</th></tr></thead>
                <tbody id="nodesBody"></tbody>
              </table>
            </div>
          </div>

          <div class="grid">
            <div class="card">
              <h3>Credit ledger</h3>
              <table>
                <thead><tr><th>Time</th><th>Type</th><th>Credits</th><th>Reason</th></tr></thead>
                <tbody id="creditHistoryBody"></tbody>
              </table>
            </div>

            <div class="card">
              <h3>Wallets and BTC/LN intents</h3>
              <table>
                <thead><tr><th>Wallet type</th><th>Network</th><th>Payout</th><th>Node/Xpub</th></tr></thead>
                <tbody id="walletsBody"></tbody>
              </table>
              <h3 style="margin-top:14px;">Payment intents</h3>
              <table>
                <thead><tr><th>Intent</th><th>Status</th><th>Sats</th><th>Credits</th><th>Created</th></tr></thead>
                <tbody id="paymentIntentsBody"></tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div id="toast" class="card hidden"></div>

      <script>
        const authView = document.getElementById("authView");
        const dashboardView = document.getElementById("dashboardView");
        const toast = document.getElementById("toast");
        const themeSelect = document.getElementById("themeSelect");
        const themePalettes = {
          warm: {
            "--bg": "#1a1a18", "--bg-soft": "#2f2f2d", "--bg-surface": "#3a3a37",
            "--bg-elevated": "#454542", "--bg-input": "#262624",
            "--card": "rgba(58, 58, 55, 0.96)", "--card-border": "rgba(214, 204, 194, 0.08)",
            "--border-strong": "rgba(214, 204, 194, 0.15)",
            "--text": "#f7f5f0", "--text-secondary": "#b8b0a4", "--muted": "#8a8478",
            "--brand": "#c17850", "--brand-2": "#d4895f"
          },
          midnight: {
            "--bg": "#0f0f1e", "--bg-soft": "#1a1a2e", "--bg-surface": "#252540",
            "--bg-elevated": "#30304a", "--bg-input": "#141428",
            "--card": "rgba(37, 37, 64, 0.96)", "--card-border": "rgba(99, 102, 241, 0.12)",
            "--border-strong": "rgba(99, 102, 241, 0.2)",
            "--text": "#e8e8f0", "--text-secondary": "#a0a0c0", "--muted": "#8888a0",
            "--brand": "#6366f1", "--brand-2": "#818cf8"
          },
          emerald: {
            "--bg": "#0f1e0f", "--bg-soft": "#1a2e1a", "--bg-surface": "#253025",
            "--bg-elevated": "#304030", "--bg-input": "#142814",
            "--card": "rgba(37, 48, 37, 0.96)", "--card-border": "rgba(34, 197, 94, 0.12)",
            "--border-strong": "rgba(34, 197, 94, 0.2)",
            "--text": "#e8f0e8", "--text-secondary": "#a0c0a0", "--muted": "#88a088",
            "--brand": "#22c55e", "--brand-2": "#4ade80"
          }
        };

        function applyTheme(theme) {
          const palette = themePalettes[theme] || themePalettes.warm;
          for (const [key, value] of Object.entries(palette)) {
            document.documentElement.style.setProperty(key, value);
          }
          if (themeSelect) themeSelect.value = theme;
        }

        function showToast(message, isError = false) {
          toast.textContent = message;
          toast.classList.remove("hidden");
          toast.style.borderColor = isError ? "#ef4444" : "#22c55e";
          setTimeout(() => toast.classList.add("hidden"), 5000);
        }

        function fmtTime(ms) {
          if (!ms) return "n/a";
          return new Date(ms).toISOString();
        }

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

        async function api(path, options = {}) {
          const res = await fetch(path, {
            credentials: "include",
            headers: { "content-type": "application/json", ...(options.headers || {}) },
            ...options
          });
          let payload = null;
          try { payload = await res.json(); } catch {}
          if (!res.ok) throw new Error(payload && payload.error ? payload.error : String(res.status));
          return payload;
        }

        function renderRows(targetId, rowsHtml, colspan, emptyText) {
          const el = document.getElementById(targetId);
          el.innerHTML = rowsHtml.length > 0 ? rowsHtml.join("") : '<tr><td colspan="' + colspan + '">' + emptyText + '</td></tr>';
        }

        async function loadDashboard() {
          const summary = await api("/dashboard/summary", { method: "GET", headers: {} });
          authView.classList.add("hidden");
          dashboardView.classList.remove("hidden");

          const user = summary.user || {};
          applyTheme("warm");
          document.getElementById("accountMeta").textContent =
            user.email + " | email verified: " + String(Boolean(user.emailVerified));
          document.getElementById("accountIdLabel").textContent = "acct-" + (user.userId || "unknown");

          const nodeRows = (summary.nodes || []).map((n) =>
            "<tr><td>" + n.nodeId + "</td><td>" + n.nodeKind + "</td><td>" + String(Boolean(n.emailVerified)) + "</td><td>" +
            String(Boolean(n.nodeApproved)) + "</td><td>" + String(Boolean(n.active)) + "</td><td>" + fmtTime(n.lastSeenMs) + "</td></tr>"
          );
          renderRows("nodesBody", nodeRows, 6, "No nodes enrolled.");

          const walletSnapshot = summary.walletSnapshot || {};
          const credits = walletSnapshot.credits;
          document.getElementById("creditsValue").textContent =
            credits && typeof credits.balance !== "undefined" ? String(credits.balance) : "n/a";
          const quote = walletSnapshot.quote;
          document.getElementById("creditsSatsValue").textContent =
            quote && typeof quote.estimatedSats !== "undefined"
              ? "Estimated sats: " + String(quote.estimatedSats) + " @ " + String(quote.satsPerCredit) + " sats/credit"
              : "Estimated sats: n/a";

          const creditHistoryRows = (walletSnapshot.creditHistory || []).map((tx) =>
            "<tr><td>" + fmtTime(tx.timestampMs) + "</td><td>" + tx.type + "</td><td>" + tx.credits + "</td><td>" + tx.reason + "</td></tr>"
          );
          renderRows("creditHistoryBody", creditHistoryRows, 4, "No credit transactions yet.");

          const walletRows = (walletSnapshot.wallets || []).map((w) =>
            "<tr><td>" + (w.walletType || "") + "</td><td>" + (w.network || "") + "</td><td>" + (w.payoutAddress || "n/a") +
            "</td><td>" + (w.lnNodePubkey || w.xpub || "n/a") + "</td></tr>"
          );
          renderRows("walletsBody", walletRows, 4, "No wallets linked.");

          const intentRows = (walletSnapshot.paymentIntents || []).map((p) =>
            "<tr><td>" + p.intentId + "</td><td>" + p.status + "</td><td>" + p.amountSats + "</td><td>" + p.quotedCredits +
            "</td><td>" + fmtTime(p.createdAtMs) + "</td></tr>"
          );
          renderRows("paymentIntentsBody", intentRows, 5, "No payment intents.");

          try {
            const onboarding = await api("/wallet/onboarding", { method: "GET", headers: {} });
            const status = onboarding.acknowledgedAtMs
              ? "Seed backup confirmed on " + fmtTime(onboarding.acknowledgedAtMs)
              : "Backup not yet confirmed. Please secure your seed phrase offline.";
            var addressInfo = onboarding.derivedAddress ? " | Address: " + onboarding.derivedAddress : "";
            document.getElementById("walletOnboardingMeta").textContent =
              "Network: " + onboarding.network + " | Account: " + onboarding.accountId + addressInfo + " | " + status;
          } catch {
            document.getElementById("walletOnboardingMeta").textContent = "Wallet onboarding status unavailable.";
          }
        }

        async function bootstrap() {
          try {
            await api("/me", { method: "GET", headers: {} });
            await loadDashboard();
          } catch {
            authView.classList.remove("hidden");
            dashboardView.classList.add("hidden");
          }
        }

        document.getElementById("signupBtn").addEventListener("click", async () => {
          try {
            const signup = await api("/auth/signup", {
              method: "POST",
              body: JSON.stringify({
                email: document.getElementById("signupEmail").value,
                password: document.getElementById("signupPassword").value,
                displayName: document.getElementById("signupDisplayName").value || undefined
              })
            });
            const onboarding = signup.walletOnboarding;
            if (onboarding && onboarding.seedPhrase) {
              showToast(
                "Signup complete. Save this seed phrase now: " + onboarding.seedPhrase + " | " +
                (onboarding.guidance && onboarding.guidance.steps ? onboarding.guidance.steps.join(" ") : ""),
                false
              );
            } else {
              showToast("Signup complete. Check your email for verification.");
            }
          } catch (err) {
            showToast("Signup failed: " + String(err.message || err), true);
          }
        });

        document.getElementById("loginBtn").addEventListener("click", async () => {
          try {
            await api("/auth/login", {
              method: "POST",
              body: JSON.stringify({
                email: document.getElementById("loginEmail").value,
                password: document.getElementById("loginPassword").value
              })
            });
            showToast("Logged in.");
            await loadDashboard();
          } catch (err) {
            showToast("Login failed: " + String(err.message || err), true);
          }
        });

        document.getElementById("resendBtn").addEventListener("click", async () => {
          try {
            const payload = await api("/auth/resend-verification", {
              method: "POST",
              body: JSON.stringify({ email: document.getElementById("loginEmail").value })
            });
            if (payload && payload.alreadyVerified) {
              showToast("This account is already verified. No email was sent.");
            } else {
              showToast("If the account exists, a verification email was sent.");
            }
          } catch (err) {
            showToast("Resend failed: " + String(err.message || err), true);
          }
        });

        document.getElementById("walletAckBtn").addEventListener("click", async () => {
          try {
            await api("/wallet/onboarding/acknowledge", { method: "POST", body: JSON.stringify({}) });
            await loadDashboard();
            showToast("Seed backup acknowledgement saved.");
          } catch (err) {
            showToast("Could not save acknowledgement: " + String(err.message || err), true);
          }
        });

        document.getElementById("passkeyEnrollBtn").addEventListener("click", async () => {
          if (!window.PublicKeyCredential) {
            showToast("Passkeys are not supported in this browser.", true);
            return;
          }
          try {
            const { challengeId, options } = await api("/auth/passkey/register/options", { method: "POST", body: JSON.stringify({}) });
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

        document.getElementById("passkeyLoginBtn").addEventListener("click", async () => {
          if (!window.PublicKeyCredential) {
            showToast("Passkeys are not supported in this browser.", true);
            return;
          }
          try {
            const email = document.getElementById("loginEmail").value;
            const { challengeId, options } = await api("/auth/passkey/login/options", {
              method: "POST",
              body: JSON.stringify({ email })
            });
            options.challenge = b64urlToArrayBuffer(options.challenge);
            options.allowCredentials = (options.allowCredentials || []).map((c) => ({ ...c, id: b64urlToArrayBuffer(c.id) }));
            const assertion = await navigator.credentials.get({ publicKey: options });
            const response = assertion.response;
            await api("/auth/passkey/login/verify", {
              method: "POST",
              body: JSON.stringify({
                challengeId,
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
            await loadDashboard();
            showToast("Logged in with passkey.");
          } catch (err) {
            showToast("Passkey login failed: " + String(err.message || err), true);
          }
        });

        document.getElementById("logoutBtn").addEventListener("click", async () => {
          await api("/auth/logout", { method: "POST", body: JSON.stringify({}) });
          showToast("Logged out.");
          authView.classList.remove("hidden");
          dashboardView.classList.add("hidden");
        });

        document.getElementById("refreshBtn").addEventListener("click", () => {
          loadDashboard().catch((err) => showToast("Refresh failed: " + String(err.message || err), true));
        });

        themeSelect.addEventListener("change", async () => {
          const theme = themeSelect.value;
          applyTheme(theme);
          try {
            await api("/me/theme", {
              method: "POST",
              body: JSON.stringify({ theme })
            });
            showToast("Theme updated.");
          } catch (err) {
            showToast("Could not save theme: " + String(err.message || err), true);
          }
        });

        document.getElementById("enrollBtn").addEventListener("click", async () => {
          try {
            const payload = await api("/nodes/enroll", {
              method: "POST",
              body: JSON.stringify({
                nodeId: document.getElementById("nodeId").value,
                nodeKind: document.getElementById("nodeKind").value
              })
            });
            document.getElementById("newTokenWrap").classList.remove("hidden");
            document.getElementById("newToken").textContent = payload.registrationToken;
            await loadDashboard();
            showToast("Node enrollment token generated.");
          } catch (err) {
            showToast("Enroll failed: " + String(err.message || err), true);
          }
        });

        applyTheme("warm");
        bootstrap();
      </script>
    </body>
  </html>`;
  return reply.type("text/html").send(html);
});
}
