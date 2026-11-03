// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { BASE_CSS, TOKENS_CSS, brandMark, icon } from "./design-system.js";
import { siteLabel } from "./urls.js";

// #16: moved verbatim from src/portal/server.ts.
export function registerHomePage(app: FastifyInstance): void {
app.get("/portal", async (_req, reply) => {
  // Only offer SSO for providers actually configured on this portal, so we never show a dead
  // button (e.g. Microsoft after the tenant was dropped). Email + passkey are always available.
  const googleOn = Boolean(process.env.OAUTH_GOOGLE_CLIENT_ID && process.env.OAUTH_GOOGLE_CLIENT_SECRET);
  const microsoftOn = Boolean(process.env.OAUTH_MICROSOFT_CLIENT_ID && process.env.OAUTH_MICROSOFT_CLIENT_SECRET);
  const ssoButtons = [googleOn ? `<a href="/auth/oauth/google/start"><button type="button"><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.4z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"/><path fill="#FBBC05" d="M6.4 14a6 6 0 0 1 0-3.9V7.5H3.1a10 10 0 0 0 0 9z"/><path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.5L6.4 10c.8-2.3 3-4 5.6-4z"/></svg> Google</button></a>` : "", microsoftOn ? `<a href="/auth/oauth/microsoft/start"><button type="button"><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="9" height="9" fill="#F25022"/><rect x="13" y="2" width="9" height="9" fill="#7FBA00"/><rect x="2" y="13" width="9" height="9" fill="#00A4EF"/><rect x="13" y="13" width="9" height="9" fill="#FFB900"/></svg> Microsoft 365</button></a>` : ""].filter(Boolean).join("");
  const ssoBlock = ssoButtons ? `<div class="or">or continue with</div><div class="sso">${ssoButtons}</div>` : "";
  const html = `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>EdgeCoder Portal | Sign in</title>
      <style>
        ${TOKENS_CSS}
        ${BASE_CSS}
        .auth { min-height: 100vh; display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); }
        .auth-brand {
          display: flex; flex-direction: column; justify-content: space-between;
          padding: 36px 44px; background: var(--bg-soft); border-right: 1px solid var(--card-border);
        }
        .auth-brand .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; }
        .mark { display: inline-flex; align-items: center; justify-content: center; background: var(--brand); }
        .auth-brand h1 { font-size: 30px; line-height: 1.15; letter-spacing: -0.02em; margin: 0 0 12px; max-width: 480px; }
        .auth-brand .lead { color: var(--text-secondary); font-size: 15px; max-width: 480px; margin-bottom: 28px; }
        .props { display: grid; gap: 14px; max-width: 480px; }
        .prop { display: flex; gap: 12px; align-items: flex-start; }
        .prop .icon { flex: none; width: 32px; height: 32px; border-radius: var(--radius-sm); border: 1px solid var(--card-border); background: var(--bg-surface); display: inline-flex; align-items: center; justify-content: center; color: var(--brand-2); }
        .prop b { display: block; font-size: 13px; margin-bottom: 2px; }
        .prop span { font-size: 12.5px; color: var(--muted); line-height: 1.5; }
        .auth-foot { font-size: 12px; color: var(--muted); display: flex; gap: 14px; flex-wrap: wrap; margin-top: 28px; }
        .auth-foot a { color: var(--muted); } .auth-foot a:hover { color: var(--text); }
        .auth-main { display: flex; align-items: center; justify-content: center; padding: 36px 24px; }
        .auth-card { width: min(440px, 100%); }
        .tabs { display: flex; border: 1px solid var(--card-border); border-radius: var(--radius-sm); padding: 3px; background: var(--bg-surface); margin-bottom: 18px; }
        .tabs button { flex: 1; border: none; background: transparent; color: var(--muted); min-height: 30px; }
        .tabs button.active { background: var(--bg-elevated); color: var(--text); }
        .pane { display: none; } .pane.active { display: block; }
        .sso { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .sso a { display: block; }
        .sso button { width: 100%; }
        .or { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; margin: 16px 0; }
        .or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--card-border); }
        .auth-card h2 { font-size: 20px; margin-bottom: 4px; }
        .auth-card .sub { color: var(--muted); font-size: 13px; margin-bottom: 16px; }
        .session-banner { margin-top: 14px; }
        .link-btn { background: none; border: none; color: var(--text-secondary); padding: 0; min-height: 0; font-size: 12px; }
        .link-btn:hover { color: var(--brand-2); background: none; }
        @media (max-width: 860px) { .auth { grid-template-columns: 1fr; } .auth-brand { border-right: none; border-bottom: 1px solid var(--card-border); padding: 24px; } .auth-brand h1 { font-size: 24px; } }
      </style>
    </head>
    <body>
      <div class="auth">
        <section class="auth-brand">
          <div>
            <div class="brand">${brandMark(30)}<span>EdgeCoder</span></div>
            <div style="height:48px"></div>
            <h1>Compute, priced in Bitcoin.</h1>
            <p class="lead">Run AI coding workloads on a global mesh of machines. Contribute capacity and earn sats, or buy capacity with sats at a market rate recalibrated daily.</p>
            <div class="props">
              <div class="prop"><span class="icon">${icon("shield", 16)}</span><div><b>Private by default</b><span>Your code runs on your machines first. Only what you allow crosses to approved public capacity.</span></div></div>
              <div class="prop"><span class="icon">${icon("bitcoin", 16)}</span><div><b>Lightning settlement</b><span>Buy credits with a Lightning invoice. Workers and infrastructure hosts are paid in sats for measured work.</span></div></div>
              <div class="prop"><span class="icon">${icon("market", 16)}</span><div><b>An open market for compute</b><span>Agents post asks, tasks carry bids, and every hardware class trades against BTC on the market page.</span></div></div>
            </div>
          </div>
          <div class="auth-foot"><a href="/">${siteLabel()}</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><span>&copy; 2025 EdgeCoder, LLC</span></div>
        </section>
        <section class="auth-main">
          <div class="auth-card">
            <div class="tabs" role="tablist">
              <button id="tabSignin" class="active" role="tab" aria-selected="true">Sign in</button>
              <button id="tabSignup" role="tab" aria-selected="false">Create account</button>
            </div>

            <div class="pane active" id="paneSignin">
              <h2>Welcome back</h2>
              <div class="sub">Sign in with your email, a passkey, or single sign-on.</div>
              <label>Email</label><input id="loginEmail" type="email" placeholder="you@company.com" autocomplete="email" />
              <label>Password</label><input id="loginPassword" type="password" placeholder="Your password" autocomplete="current-password" />
              <div class="row" style="margin-top:14px;">
                <button class="primary" id="loginBtn" style="flex:1;">Sign in</button>
                <button id="passkeyLoginBtn">${icon("key", 14)} Passkey</button>
              </div>
              <div class="row" style="margin-top:10px; justify-content:space-between;"><a class="link-btn" id="forgotLink" href="/portal/reset-password">Forgot password?</a><button class="link-btn" id="resendBtn">Resend verification email</button></div>
              ${ssoBlock}
            </div>

            <div class="pane" id="paneSignup">
              <h2>Create your account</h2>
              <div class="sub">Enroll nodes, buy or earn credits, and manage your wallet.</div>
              <label>Email</label><input id="signupEmail" type="email" placeholder="you@company.com" autocomplete="email" />
              <label>Password</label><input id="signupPassword" type="password" placeholder="At least 8 characters" autocomplete="new-password" />
              <label>Display name (optional)</label><input id="signupDisplayName" type="text" placeholder="Team or your name" />
              <div class="row" style="margin-top:14px;">
                <button class="primary" id="signupBtn" style="flex:1;">Create account</button>
              </div>
              <p class="muted" style="margin-top:12px;">We email a verification link. Nodes you enroll activate once the address is verified.</p>
            </div>

            <div id="sessionBanner" class="callout session-banner hidden">
              <h3>Already signed in</h3>
              <div id="sessionUserLine" class="muted">You already have an active session.</div>
              <div class="row" style="margin-top:10px;">
                <button class="primary" id="continueSessionBtn">Continue to dashboard</button>
                <button id="switchUserBtn">Switch user</button>
              </div>
            </div>
          </div>
        </section>
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
          toast.style.borderLeftColor = isError ? "var(--danger)" : "var(--ok)";
          clearTimeout(toast._t);
          toast._t = setTimeout(() => toast.classList.add("hidden"), 5000);
        }
        (function tabs() {
          const map = { tabSignin: "paneSignin", tabSignup: "paneSignup" };
          for (const id of Object.keys(map)) {
            document.getElementById(id).addEventListener("click", () => {
              for (const [tab, pane] of Object.entries(map)) {
                const on = tab === id;
                document.getElementById(tab).classList.toggle("active", on);
                document.getElementById(tab).setAttribute("aria-selected", on ? "true" : "false");
                document.getElementById(pane).classList.toggle("active", on);
              }
            });
          }
          if (location.hash === "#signup") document.getElementById("tabSignup").click();
        })();
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
            const code = String(err.message || err);
            showToast(code === "invalid_credentials" ? 'Wrong email or password. To reset it, use \u201cForgot password?\u201d below.' : "Login failed: " + code, true);
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
