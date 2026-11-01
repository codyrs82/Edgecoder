// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";

// #16: moved verbatim from src/portal/server.ts.
export function registerHomePage(app: FastifyInstance): void {
app.get("/portal", async (_req, reply) => {
  const html = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>EdgeCoder Portal | Sign in</title>
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
        .shell { max-width: 980px; margin: 28px auto 42px; padding: 0 16px; }
        .hero { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
        .brand { display: inline-flex; align-items: center; gap: 10px; }
        .mark {
          width: 36px;
          height: 36px;
          border-radius: 11px;
          background: linear-gradient(140deg, var(--brand), var(--brand-2));
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .muted { color: var(--muted); font-size: 13px; }
        .layout { display: grid; grid-template-columns: 1fr; gap: 12px; }
        .auth-stack { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(260px, 1fr)); }
        .card {
          background: var(--card);
          border: 1px solid var(--card-border);
          border-radius: 12px;
          padding: 16px;
          backdrop-filter: blur(10px);
          box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
        }
        .simple-intro { background: var(--bg-soft); }
        .simple-intro h2 { margin: 0 0 6px; font-size: 26px; letter-spacing: -0.02em; }
        .simple-intro p { margin: 0; color: var(--muted); line-height: 1.6; max-width: 760px; }
        label { display: block; margin: 8px 0 4px; font-size: 13px; color: var(--muted); }
        input {
          width: 100%;
          padding: 10px 11px;
          border: 1px solid var(--card-border);
          border-radius: 10px;
          background: var(--bg);
          color: var(--text);
        }
        .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
        button {
          padding: 9px 12px;
          border-radius: 10px;
          border: 1px solid var(--card-border);
          background: var(--bg-soft);
          color: var(--text);
          cursor: pointer;
        }
        button.primary {
          background: linear-gradient(140deg, var(--brand), var(--brand-2));
          border-color: rgba(193, 120, 80, 0.75);
          color: white;
        }
        a { color: inherit; }
        #toast {
          position: fixed;
          top: 20px;
          right: 20px;
          width: min(420px, calc(100vw - 32px));
          z-index: 100;
          margin: 0;
        }
        .hidden { display: none; }
        .session-banner {
          border: 1px solid rgba(193, 120, 80, 0.34);
          background: rgba(58, 58, 55, 0.8);
        }
        @media (max-width: 920px) {
          .auth-stack { grid-template-columns: 1fr; }
        }
      </style>
    </head>
    <body>
      <div class="shell">
        <div class="hero">
          <div class="brand">
            <div class="mark">E</div>
            <div>
              <h1 style="margin:0;">EdgeCoder Portal</h1>
              <div class="muted">Sign in to access dashboard, nodes, wallet, and settings pages.</div>
            </div>
          </div>
          <a href="/">Back to edgecoder.io</a>
        </div>
        <div class="layout">
          <div class="card simple-intro">
            <h2>Simple, secure sign-in</h2>
            <p>
              Access your EdgeCoder workspace with enterprise authentication controls,
              passkeys, and policy-driven operations in one place.
            </p>
          </div>
          <div class="auth-stack">
            <div class="card">
            <h2 style="margin-top:0;">Get started</h2>
            <p class="muted">Create your account to enroll nodes and manage compute access.</p>
            <label>Email</label><input id="signupEmail" type="email" placeholder="you@company.com" />
            <label>Password</label><input id="signupPassword" type="password" placeholder="At least 8 characters" />
            <label>Display name (optional)</label><input id="signupDisplayName" type="text" placeholder="Team or your name" />
            <div class="row">
              <button class="primary" id="signupBtn">Create account</button>
            </div>
            </div>
            <div class="card">
            <h2 style="margin-top:0;">Sign in</h2>
            <label>Email</label><input id="loginEmail" type="email" placeholder="you@company.com" />
            <label>Password</label><input id="loginPassword" type="password" placeholder="Your password" />
            <div class="row">
              <button class="primary" id="loginBtn">Log in</button>
              <button id="resendBtn">Resend verification</button>
            </div>
            <div class="row">
              <button id="passkeyLoginBtn">Log in with passkey</button>
            </div>
            <h3>Single sign-on</h3>
            <div class="row">
              <a href="/auth/oauth/google/start"><button>Google</button></a>
              <a href="/auth/oauth/microsoft/start"><button>Microsoft 365</button></a>
            </div>
            </div>
          </div>
        </div>
        <div id="sessionBanner" class="card session-banner hidden">
          <h3 style="margin-top:0;">Already signed in</h3>
          <div id="sessionUserLine" class="muted">You already have an active session.</div>
          <div class="row">
            <button class="primary" id="continueSessionBtn">Continue to dashboard</button>
            <button id="switchUserBtn">Switch user</button>
          </div>
        </div>
      </div>
      <div id="toast" class="card hidden"></div>
      <script>
        const toast = document.getElementById("toast");
        const sessionBanner = document.getElementById("sessionBanner");
        const sessionUserLine = document.getElementById("sessionUserLine");
        const continueSessionBtn = document.getElementById("continueSessionBtn");
        const switchUserBtn = document.getElementById("switchUserBtn");
        function showToast(message, isError = false) {
          toast.textContent = message;
          toast.classList.remove("hidden");
          toast.style.borderColor = isError ? "#ef4444" : "#22c55e";
          setTimeout(() => toast.classList.add("hidden"), 5000);
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
        async function checkExistingSession() {
          try {
            const me = await api("/me", { method: "GET", headers: {} });
            const user = me.user || {};
            sessionUserLine.textContent = (user.email || "unknown") + " is currently signed in on this browser.";
            sessionBanner.classList.remove("hidden");
          } catch {
            sessionBanner.classList.add("hidden");
          }
        }
        document.getElementById("signupBtn").addEventListener("click", async () => {
          try {
            await api("/auth/signup", {
              method: "POST",
              body: JSON.stringify({
                email: document.getElementById("signupEmail").value,
                password: document.getElementById("signupPassword").value,
                displayName: document.getElementById("signupDisplayName").value || undefined
              })
            });
            showToast("Signup complete. Verify your email, then sign in.");
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
            window.location.href = "/portal/dashboard";
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
        document.getElementById("passkeyLoginBtn").addEventListener("click", async () => {
          if (!window.PublicKeyCredential) {
            showToast("Passkeys are not supported in this browser.", true);
            return;
          }
          try {
            const email = document.getElementById("loginEmail").value;
            const authOptions = await api("/auth/passkey/login/options", {
              method: "POST",
              body: JSON.stringify({ email })
            });
            const challengeId = authOptions.challengeId;
            const options = authOptions.options;
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
            window.location.href = "/portal/dashboard";
          } catch (err) {
            showToast("Passkey login failed: " + String(err.message || err), true);
          }
        });
        continueSessionBtn.addEventListener("click", () => {
          window.location.href = "/portal/dashboard";
        });
        switchUserBtn.addEventListener("click", async () => {
          try {
            await api("/auth/logout", { method: "POST", body: JSON.stringify({}) });
            showToast("Signed out. You can now use a different account.");
            sessionBanner.classList.add("hidden");
          } catch (err) {
            showToast("Could not switch user: " + String(err.message || err), true);
          }
        });
        checkExistingSession();
      </script>
    </body>
  </html>`;
  return reply.type("text/html").send(html);
});
}
