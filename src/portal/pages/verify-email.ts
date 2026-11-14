// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { BASE_CSS, TOKENS_CSS, brandMark } from "./design-system.js";
import { htmlOpenTag, themeHeadTags } from "../assets.js";
import { CSP_NONCE } from "../csp-nonce.js";

/**
 * GET /auth/verify-email (the link in the verification email). Opening the link changes nothing:
 * the script POSTs the token back, which succeeds only for whoever is signed in to that account
 * in this browser or types its password (routes/auth.ts). The token is read from the URL by the
 * script and never echoed into the HTML.
 */
export function verifyEmailPage(): string {
  return `<!doctype html>
  ${htmlOpenTag()}
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="referrer" content="no-referrer" />
      <title>EdgeCoder Portal | Verify email</title>
      ${themeHeadTags()}
      <style>
        ${TOKENS_CSS}
        ${BASE_CSS}
        .wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 36px 16px; }
        .verify-card { width: min(420px, 100%); }
        .verify-card .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; margin-bottom: 24px; }
        .verify-card h2 { font-size: 20px; margin-bottom: 4px; }
        .verify-card .sub { color: var(--muted); font-size: 13px; margin-bottom: 8px; }
        .verify-card button.primary { width: 100%; margin-top: 14px; }
        .msg { margin-top: 14px; }
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="verify-card">
          <div class="brand">${brandMark(28)}<span>EdgeCoder</span></div>
          <form id="passwordForm" class="hidden">
            <h2>Confirm your email</h2>
            <div class="sub">Enter the password you chose when you created this account.</div>
            <label for="verifyPassword">Password</label>
            <input id="verifyPassword" type="password" autocomplete="current-password" required />
            <button class="primary" type="submit">Verify and sign in</button>
          </form>
          <div id="msg" class="callout msg">Checking your link...</div>
          <p class="muted" style="margin-top:16px;">Did not create this account? <a href="/portal/reset-password">Reset its password</a> to take it over; that removes every other way in.</p>
          <p class="muted"><a href="/portal">Back to sign in</a></p>
        </div>
      </div>
      <script nonce="${CSP_NONCE}">
        const token = new URLSearchParams(location.search).get("token") || "";
        if (token) history.replaceState(null, "", location.pathname);
        const msg = document.getElementById("msg");
        const form = document.getElementById("passwordForm");
        function show(text, kind) {
          msg.textContent = text;
          msg.className = "callout msg " + (kind || "");
        }
        async function confirmLink(password) {
          const res = await fetch("/auth/verify-email", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(password ? { token, password } : { token })
          });
          let payload = {};
          try { payload = (await res.json()) || {}; } catch {}
          if (res.ok) {
            form.classList.add("hidden");
            show("Email verified. Opening your dashboard...", "ok");
            location.href = "/portal/dashboard";
          } else if (res.status === 429) {
            show("Too many attempts. Wait a minute and try again.", "warn");
          } else if (payload.error === "verify_password_required") {
            form.classList.remove("hidden");
            show(password ? "That password is not right." : "Enter your password to confirm this address.", password ? "danger" : "");
          } else if (payload.error === "verify_sign_in_required") {
            show("Sign in to this account in this browser (the way you created it), then open the link again.", "warn");
          } else {
            form.classList.add("hidden");
            show("This verification link has expired or was already used. Sign in and request a new one.", "danger");
          }
        }
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          confirmLink(document.getElementById("verifyPassword").value);
        });
        confirmLink("");
      </script>
    </body>
  </html>`;
}
