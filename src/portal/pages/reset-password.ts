// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../routes/password-reset.js";
import { BASE_CSS, TOKENS_CSS, brandMark } from "./design-system.js";

/**
 * /portal/reset-password: without ?token it asks for the email (POST /auth/password/forgot);
 * with ?token it asks for the new password (POST /auth/password/reset). The token is read by
 * the script from the URL and never echoed into the HTML.
 */
export function registerResetPasswordPage(app: FastifyInstance): void {
  app.get("/portal/reset-password", async (_req, reply) => {
    const html = `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="referrer" content="no-referrer" />
      <title>EdgeCoder Portal | Reset password</title>
      <style>
        ${TOKENS_CSS}
        ${BASE_CSS}
        .wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 36px 16px; }
        .reset-card { width: min(420px, 100%); }
        .reset-card .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; margin-bottom: 24px; }
        .reset-card h2 { font-size: 20px; margin-bottom: 4px; }
        .reset-card .sub { color: var(--muted); font-size: 13px; margin-bottom: 8px; }
        .reset-card button.primary { width: 100%; margin-top: 14px; }
        .msg { margin-top: 14px; }
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="reset-card">
          <div class="brand">${brandMark(28)}<span>EdgeCoder</span></div>

          <form id="requestForm" class="hidden">
            <h2>Forgot your password?</h2>
            <div class="sub">Enter your account email and we will send you a link to choose a new one.</div>
            <label for="resetEmail">Email</label>
            <input id="resetEmail" type="email" autocomplete="email" placeholder="you@company.com" required />
            <button class="primary" type="submit" id="requestBtn">Send reset link</button>
          </form>

          <form id="resetForm" class="hidden">
            <h2>Choose a new password</h2>
            <div class="sub">At least ${PASSWORD_MIN_LENGTH} characters. Saving signs you out on every device.</div>
            <label for="newPassword">New password</label>
            <input id="newPassword" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN_LENGTH}" maxlength="${PASSWORD_MAX_LENGTH}" required />
            <label for="confirmPassword">Confirm new password</label>
            <input id="confirmPassword" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN_LENGTH}" maxlength="${PASSWORD_MAX_LENGTH}" required />
            <button class="primary" type="submit" id="resetBtn">Save new password</button>
          </form>

          <div id="msg" class="callout msg hidden"></div>
          <p class="muted" style="margin-top:16px;"><a href="/portal">Back to sign in</a></p>
        </div>
      </div>
      <script>
        const MIN = ${PASSWORD_MIN_LENGTH};
        const MAX = ${PASSWORD_MAX_LENGTH};
        const params = new URLSearchParams(location.search);
        const token = params.get("token");
        if (token) history.replaceState(null, "", location.pathname);
        const msg = document.getElementById("msg");
        function show(text, kind) {
          msg.textContent = text;
          msg.className = "callout msg " + (kind || "");
        }
        async function post(path, body) {
          const res = await fetch(path, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          let payload = null;
          try { payload = await res.json(); } catch {}
          return { ok: res.ok, status: res.status, payload: payload || {} };
        }
        const requestForm = document.getElementById("requestForm");
        const resetForm = document.getElementById("resetForm");
        (token ? resetForm : requestForm).classList.remove("hidden");
        requestForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const r = await post("/auth/password/forgot", { email: document.getElementById("resetEmail").value });
          if (r.ok) { show(r.payload.message || "Check your inbox.", "ok"); requestForm.classList.add("hidden"); }
          else if (r.status === 429) show("Too many requests. Wait a few minutes and try again.", "warn");
          else show("Enter a valid email address.", "danger");
        });
        resetForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const pw = document.getElementById("newPassword").value;
          const confirm = document.getElementById("confirmPassword").value;
          if (pw.length < MIN || pw.length > MAX) return show("Use " + MIN + " to " + MAX + " characters.", "danger");
          if (pw !== confirm) return show("The passwords do not match.", "danger");
          const r = await post("/auth/password/reset", { token, password: pw });
          if (r.ok) {
            resetForm.classList.add("hidden");
            show("Password updated. Sign in with your new password.", "ok");
          } else if (r.status === 429) {
            show("Too many attempts. Wait a few minutes and try again.", "warn");
          } else if (r.payload.error === "weak_password") {
            show(r.payload.message || "Choose a longer password.", "danger");
          } else {
            resetForm.classList.add("hidden");
            requestForm.classList.remove("hidden");
            show("This reset link has expired or was already used. Request a new one below.", "danger");
          }
        });
      </script>
    </body>
  </html>`;
    return reply.header("cache-control", "no-store").type("text/html").send(html);
  });
}
