// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { portalCardPageHtml } from "./layout.js";

/**
 * GET /auth/verify-email (the link in the verification email). Opening the link changes nothing:
 * the script POSTs the token back, which succeeds only for whoever is signed in to that account
 * in this browser or types its password (routes/auth.ts). The token is read from the URL by the
 * script and never echoed into the HTML.
 */
export function verifyEmailPage(): string {
  return portalCardPageHtml({
    title: "EdgeCoder Portal | Verify email",
    message: "Checking your link...",
    content: `<form id="passwordForm" class="hidden">
            <h2>Confirm your email</h2>
            <div class="sub">Enter the password you chose when you created this account.</div>
            <label for="verifyPassword">Password</label>
            <input id="verifyPassword" type="password" autocomplete="current-password" required />
            <button class="primary" type="submit">Verify and sign in</button>
          </form>`,
    note: `Did not create this account? <a href="/portal/reset-password">Reset its password</a> to take it over; that removes every other way in.`,
    script: `
        const token = new URLSearchParams(location.search).get("token") || "";
        if (token) history.replaceState(null, "", location.pathname);
        const form = document.getElementById("passwordForm");
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
    `
  });
}
