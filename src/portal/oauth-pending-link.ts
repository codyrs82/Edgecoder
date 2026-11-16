// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Connecting a sign-in provider to an existing account by email confirmation.
 *
 * When an OAuth sign-in matches a verified account by email but the provider did not prove the
 * address (Microsoft without `xms_edov`, an unverified Google address, a personal Microsoft
 * account, ...), nothing is signed in. A pending link is stored instead and the account's own
 * address gets a link to confirm it:
 *  - the token is 256 random bits, kept only as its SHA-256, single use, 15 minutes;
 *  - the row is bound to the provider, the provider subject (Microsoft: tid:oid) and the email;
 *  - the browser that started it gets a __Host- cookie whose hash is on the row. Confirming in
 *    that browser completes the link. Anywhere else, the confirmer must sign in with the same
 *    provider identity again (the callback checks the subject against the row).
 * So completing it needs the account's inbox AND either this browser or the provider identity.
 * Links are capped per account and per client address (LINK_MAX_PER_*).
 */

import { randomBytes } from "node:crypto";
import { escapeHtml } from "./pages/escape.js";
import { portalCardPageHtml } from "./pages/layout.js";
import { OAUTH_PROVIDER_LABEL, type OauthProvider } from "./oauth-identity.js";

export const LINK_TOKEN_TTL_MS = 15 * 60 * 1000;
export const LINK_RATE_WINDOW_MS = 60 * 60 * 1000;
/** Emails (confirmation links and claim notices) per account per hour. */
export const LINK_MAX_PER_ACCOUNT = 3;
/** Pending links started from one client address per hour, across all accounts. */
export const LINK_MAX_PER_IP = 10;

export const LINK_BROWSER_COOKIE = "__Host-edgecoder_oauth_link";

export function newLinkSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function linkBrowserSetCookie(nonce: string): string {
  return `${LINK_BROWSER_COOKIE}=${nonce}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(LINK_TOKEN_TTL_MS / 1000)}`;
}

export function linkBrowserClearCookie(): string {
  return `${LINK_BROWSER_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** "c…@bigdigital.energy": the address the person just used, masked like a reset prompt. */
export function maskLinkEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "your email address";
  return `${email.slice(0, 1)}…@${email.slice(at + 1)}`;
}

export function linkCheckEmailMessage(provider: OauthProvider, maskedEmail: string): string {
  return `We sent a link to ${maskedEmail} to connect ${OAUTH_PROVIDER_LABEL[provider]} to your account.`;
}

/** Shown in the browser after an OAuth sign-in that needs email confirmation. */
export function linkCheckEmailPage(provider: OauthProvider, maskedEmail: string): string {
  const p = OAUTH_PROVIDER_LABEL[provider];
  return portalCardPageHtml({
    title: "EdgeCoder Portal | Check your email",
    content: `<h2>Check your email</h2>
          <div class="sub">${escapeHtml(linkCheckEmailMessage(provider, maskedEmail))}</div>
          <p>The link works once and expires in 15 minutes. Open it in this browser, or continue with ${escapeHtml(p)} again when it asks. Then you can sign in with ${escapeHtml(p)} from now on.</p>
          <p><a class="btn" href="/portal">Sign in with password instead</a></p>`,
    script: ""
  });
}

/**
 * GET /auth/oauth-link/confirm (the emailed link). Opening it changes nothing: the button POSTs
 * the token back. The token is read by the script and never echoed into the HTML.
 */
export function linkConfirmPage(): string {
  return portalCardPageHtml({
    title: "EdgeCoder Portal | Connect sign-in",
    content: `<h2>Connect your sign-in</h2>
          <div class="sub">Connect the Google, Microsoft or GitHub account you just used to your EdgeCoder account, and sign in.</div>
          <button class="primary" id="confirmLinkBtn" type="button">Connect and sign in</button>`,
    note: `Did not try to sign in? Close this page: nothing is connected unless you confirm, and the link expires in 15 minutes.`,
    script: `
        const token = new URLSearchParams(location.search).get("token") || "";
        if (token) history.replaceState(null, "", location.pathname);
        const btn = document.getElementById("confirmLinkBtn");
        if (!token) { btn.classList.add("hidden"); show("This link is incomplete. Open it again from the email.", "danger"); }
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          const res = await fetch("/auth/oauth-link/confirm", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token })
          });
          let payload = {};
          try { payload = (await res.json()) || {}; } catch {}
          if (res.ok && payload.status === "linked") {
            btn.classList.add("hidden");
            show("Connected. Opening your dashboard...", "ok");
            location.href = payload.next || "/portal/dashboard";
          } else if (res.ok && payload.status === "reauth_required" && payload.authorizeUrl) {
            show("To finish, continue with " + (payload.providerLabel || "the same account") + " to confirm it's you...", "");
            location.href = payload.authorizeUrl;
          } else if (res.status === 429) {
            btn.disabled = false;
            show("Too many attempts. Wait a minute and try again.", "warn");
          } else if (payload.error === "oauth_identity_linked_elsewhere") {
            btn.classList.add("hidden");
            show("That sign-in is already connected to a different EdgeCoder account.", "danger");
          } else {
            btn.classList.add("hidden");
            show("This link has expired or was already used. Sign in again to get a new one, or sign in with your password.", "danger");
          }
        });
    `
  });
}
