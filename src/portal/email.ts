// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { request } from "undici";
import { escapeHtml } from "./pages/escape.js";
import { COMPUTE_HARDWARE_LABELS, HOST_KIND_LABELS, type HostRequestRecord } from "./host-requests.js";

/** #16: transactional email via Resend (verification link, wallet send code). Moved from server.ts. */
export interface PortalMailerConfig {
  resendApiKey: string;
  resendFromEmail: string;
  portalPublicUrl: string;
  walletSendMfaTtlMs: number;
}

export function createPortalMailer(cfg: PortalMailerConfig, log: { warn: (msg: string) => void }) {
  async function sendVerificationEmail(email: string, verifyToken: string): Promise<void> {
    if (!cfg.resendApiKey || !cfg.resendFromEmail) {
      log.warn("cfg.resendApiKey/cfg.resendFromEmail not set; skipping email verification send.");
      return;
    }
    const verifyLink = `${cfg.portalPublicUrl}/auth/verify-email?token=${encodeURIComponent(verifyToken)}`;
    const html = `
      <p>Welcome to EdgeCoder.</p>
      <p>Verify your email to activate your account and enrolled nodes:</p>
      <p><a href="${verifyLink}">${verifyLink}</a></p>
      <p>This link expires in 24 hours.</p>
    `;

    const res = await request("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.resendApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: cfg.resendFromEmail,
        to: email,
        subject: "Verify your EdgeCoder account",
        html
      })
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const body = await res.body.text();
      throw new Error(`resend_email_failed:${res.statusCode}:${body}`);
    }
  }

  async function sendWalletSendMfaCodeEmail(input: {
    email: string;
    code: string;
    amountSats: number;
    destination: string;
  }): Promise<void> {
    if (!cfg.resendApiKey || !cfg.resendFromEmail) {
      throw new Error("email_mfa_not_configured");
    }
    const html = `
      <p>EdgeCoder Wallet send verification</p>
      <p>Your one-time send code is:</p>
      <p><strong style="font-size:22px;letter-spacing:0.18em;">${input.code}</strong></p>
      <p>Requested transfer:</p>
      <ul>
        <li>Amount (sats): ${escapeHtml(input.amountSats)}</li>
        <li>Destination: ${escapeHtml(input.destination)}</li>
      </ul>
      <p>This code expires in ${Math.floor(cfg.walletSendMfaTtlMs / 60000)} minutes.</p>
      <p>If you did not request this, do not share the code and review account access immediately.</p>
    `;
    const res = await request("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.resendApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: cfg.resendFromEmail,
        to: input.email,
        subject: "EdgeCoder wallet send verification code",
        html
      })
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const body = await res.body.text();
      throw new Error(`wallet_send_mfa_email_failed:${res.statusCode}:${body}`);
    }
  }

  async function sendResendEmail(to: string, subject: string, html: string, errorTag: string): Promise<boolean> {
    if (!cfg.resendApiKey || !cfg.resendFromEmail) {
      log.warn(`cfg.resendApiKey/cfg.resendFromEmail not set; skipping ${errorTag} send.`);
      return false;
    }
    const res = await request("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.resendApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: cfg.resendFromEmail, to, subject, html })
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const body = await res.body.text();
      throw new Error(`${errorTag}_failed:${res.statusCode}:${body}`);
    }
    return true;
  }

  /** Password reset link (the token is single use and expires after `ttlMinutes`). */
  async function sendPasswordResetEmail(email: string, resetToken: string, ttlMinutes: number): Promise<void> {
    const link = `${cfg.portalPublicUrl}/portal/reset-password?token=${encodeURIComponent(resetToken)}`;
    const html = `
      <p>Someone asked to reset the password for your EdgeCoder account.</p>
      <p><a href="${link}">${link}</a></p>
      <p>This link works once and expires in ${ttlMinutes} minutes. Resetting signs you out on every device.</p>
      <p>If you did not ask for this, ignore this email; your password stays the same.</p>
    `;
    await sendResendEmail(email, "Reset your EdgeCoder password", html, "password_reset_email");
  }

  /** Reset requested for an account that has no password (it signs in with SSO or a passkey). */
  async function sendPasswordResetSsoNoticeEmail(email: string): Promise<void> {
    const html = `
      <p>Someone asked to reset the password for your EdgeCoder account.</p>
      <p>This account has no password: it signs in with single sign-on (Google, Microsoft or GitHub) or a passkey.
      Use that option on the <a href="${cfg.portalPublicUrl}/portal">sign-in page</a>.</p>
      <p>If you did not ask for this, you can ignore this email.</p>
    `;
    await sendResendEmail(email, "Signing in to EdgeCoder", html, "password_reset_sso_email");
  }

  /** Confirm connecting a sign-in provider to the account (oauth-pending-link.ts). The link works once, for 15 minutes. */
  async function sendOauthLinkConfirmEmail(input: { email: string; providerLabel: string; token: string; ttlMinutes: number }): Promise<boolean> {
    const link = `${cfg.portalPublicUrl}/auth/oauth-link/confirm?token=${encodeURIComponent(input.token)}`;
    const p = escapeHtml(input.providerLabel);
    const html = `
      <p>Someone just tried to sign in to EdgeCoder with ${p} using this email address.</p>
      <p>If it was you, confirm connecting ${p} to your EdgeCoder account:</p>
      <p><a href="${link}">${link}</a></p>
      <p>This link works once and expires in ${input.ttlMinutes} minutes. Open it in the browser you signed in from, or continue with ${p} again when it asks.</p>
      <p>If it was not you, ignore this email: nothing is connected unless the link is used. You can review your sign-in methods under <a href="${cfg.portalPublicUrl}/portal/settings#profile">Settings</a>.</p>
    `;
    return sendResendEmail(input.email, `Confirm connecting ${input.providerLabel} to your EdgeCoder account`, html, "oauth_link_confirm_email");
  }

  /** Security notice after a provider was connected to the account. */
  async function sendOauthConnectedEmail(input: { email: string; providerLabel: string; identity?: string }): Promise<boolean> {
    const p = escapeHtml(input.providerLabel);
    const settings = `${cfg.portalPublicUrl}/portal/settings#profile`;
    const html = `
      <p>${p}${input.identity ? ` (${escapeHtml(input.identity)})` : ""} was connected to your EdgeCoder account. You can now sign in with it.</p>
      <p>Review or remove it under Connected sign-ins: <a href="${settings}">${settings}</a></p>
      <p>If this was not you, remove it there and reset your password: <a href="${cfg.portalPublicUrl}/portal/reset-password">${cfg.portalPublicUrl}/portal/reset-password</a></p>
    `;
    return sendResendEmail(input.email, `${input.providerLabel} was connected to your EdgeCoder account`, html, "oauth_connected_email");
  }

  /** A provider sign-in matched an account whose address was never verified: nothing was connected. */
  async function sendOauthLinkClaimNoticeEmail(input: { email: string; providerLabel: string }): Promise<boolean> {
    const p = escapeHtml(input.providerLabel);
    const html = `
      <p>Someone just tried to sign in to EdgeCoder with ${p} using this email address.</p>
      <p>An EdgeCoder account with this address exists, but the address has not been verified yet, so ${p} was not connected.</p>
      <p>If the account is yours, reset its password (the link comes to this address and removes every other way in):
      <a href="${cfg.portalPublicUrl}/portal/reset-password">${cfg.portalPublicUrl}/portal/reset-password</a>. Then sign in and connect ${p} under Settings, Connected sign-ins.</p>
      <p>If it was not you, you can ignore this email.</p>
    `;
    return sendResendEmail(input.email, `Connecting ${input.providerLabel} to your EdgeCoder account`, html, "oauth_link_claim_email");
  }

  /** One-time code to confirm changing where payouts go (routes/payout-destination.ts). */
  async function sendPayoutDestinationCodeEmail(input: { email: string; code: string; destination: string }): Promise<void> {
    if (!cfg.resendApiKey || !cfg.resendFromEmail) throw new Error("email_mfa_not_configured");
    const html = `
      <p>Someone asked to change where your EdgeCoder payouts are sent.</p>
      <p>New payout destination: <strong>${escapeHtml(input.destination)}</strong></p>
      <p>Your one-time code is:</p>
      <p><strong style="font-size:22px;letter-spacing:0.18em;">${input.code}</strong></p>
      <p>This code expires in ${Math.floor(cfg.walletSendMfaTtlMs / 60000)} minutes.</p>
      <p>If you did not ask for this, do not share the code and change your password now.</p>
    `;
    await sendResendEmail(input.email, "Confirm your new EdgeCoder payout destination", html, "payout_destination_email");
  }

  /** One-time code to confirm one withdrawal to a Lightning invoice (routes/payouts.ts). */
  async function sendWithdrawCodeEmail(input: { email: string; code: string; amountSats: number }): Promise<void> {
    if (!cfg.resendApiKey || !cfg.resendFromEmail) throw new Error("email_mfa_not_configured");
    const html = `
      <p>Someone asked to withdraw <strong>${input.amountSats.toLocaleString("en-US")} sats</strong> from your EdgeCoder balance to a Lightning invoice.</p>
      <p>Your one-time code is:</p>
      <p><strong style="font-size:22px;letter-spacing:0.18em;">${input.code}</strong></p>
      <p>The code works once, only for that invoice, and expires in ${Math.floor(cfg.walletSendMfaTtlMs / 60000)} minutes.</p>
      <p>If you did not ask for this, do not share the code and change your password now.</p>
    `;
    await sendResendEmail(input.email, "Confirm your EdgeCoder withdrawal", html, "withdraw_code_email");
  }

  /** The wallet's payment server (LNURL callback host) changed; payouts are held (routes/payout-callback.ts). Resolves false when email is not configured. */
  async function sendPayoutCallbackChangedEmail(input: { email: string; destination: string; previousHost: string; newHost: string }): Promise<boolean> {
    const link = `${cfg.portalPublicUrl}/portal/settings/plan`;
    const html = `
      <p>Your wallet's payment server changed from <strong>${escapeHtml(input.previousHost)}</strong> to <strong>${escapeHtml(input.newHost)}</strong>
      for your payout address <strong>${escapeHtml(input.destination)}</strong>.</p>
      <p>We have paused payouts to that address. Your earnings are safe and still payable.</p>
      <p>If your wallet provider moved its servers, confirm the change under Settings, Wallet to keep receiving payouts:
      <a href="${link}">${link}</a></p>
      <p>If you did not expect this, do not confirm. Change your payout address to a wallet you trust instead.</p>
    `;
    return sendResendEmail(input.email, "Action needed: your EdgeCoder payouts are paused", html, "payout_callback_changed_email");
  }

  /** One-time code to confirm a changed payment server (routes/payout-callback.ts). */
  async function sendPayoutCallbackCodeEmail(input: { email: string; code: string; destination: string; previousHost: string; newHost: string }): Promise<void> {
    if (!cfg.resendApiKey || !cfg.resendFromEmail) throw new Error("email_mfa_not_configured");
    const html = `
      <p>Someone asked to confirm that payouts to <strong>${escapeHtml(input.destination)}</strong> may go through the payment server
      <strong>${escapeHtml(input.newHost)}</strong> (it was <strong>${escapeHtml(input.previousHost)}</strong>).</p>
      <p>Your one-time code is:</p>
      <p><strong style="font-size:22px;letter-spacing:0.18em;">${input.code}</strong></p>
      <p>This code expires in ${Math.floor(cfg.walletSendMfaTtlMs / 60000)} minutes.</p>
      <p>If you did not ask for this, do not share the code and change your password now.</p>
    `;
    await sendResendEmail(input.email, "Confirm your wallet's new payment server", html, "payout_callback_code_email");
  }

  /** A new "Request to host" (host-requests.ts) for the system admins. Resolves false when email or admins are not configured. */
  async function sendHostRequestAdminEmail(adminEmails: string[], r: HostRequestRecord): Promise<boolean> {
    if (adminEmails.length === 0) {
      log.warn("SYSTEM_ADMIN_EMAILS not set; skipping host request notification.");
      return false;
    }
    const link = `${cfg.portalPublicUrl}/portal/settings/admin#hostRequests`;
    const row = (k: string, v: string | null) => (v ? `<li>${k}: ${escapeHtml(v)}</li>` : "");
    const html = `
      <p>New request to host on EdgeCoder.</p>
      <ul>
        ${row("Name", r.name)}${row("Email", r.email)}${row("Organisation", r.organisation)}
        ${row("Would host", r.hostKinds.map((k) => HOST_KIND_LABELS[k]).join(", "))}
        ${row("Hardware", r.computeHardware ? COMPUTE_HARDWARE_LABELS[r.computeHardware] : null)}${row("Hardware details", r.hardwareDetails)}
        ${row("Region", r.region)}
      </ul>
      ${r.message ? `<p>Message:</p><blockquote>${escapeHtml(r.message).replace(/\n/g, "<br>")}</blockquote>` : ""}
      <p>Review it under Settings, Admin, Host requests: <a href="${link}">${link}</a></p>
    `;
    return sendResendEmail(adminEmails.join(","), `Host request: ${r.name.slice(0, 60)}`, html, "host_request_admin_email");
  }

  /** An approved host request: what to do next (create an account first when there is none for the email). */
  async function sendHostApprovedEmail(input: { email: string; name: string; hasAccount: boolean }): Promise<boolean> {
    const signup = `${cfg.portalPublicUrl}/portal#signup`;
    const signin = `${cfg.portalPublicUrl}/portal`;
    const html = !input.hasAccount
      ? `
      <p>Hi ${escapeHtml(input.name)},</p>
      <p>Thanks for offering to host on EdgeCoder. Your request is approved.</p>
      <p>Create your account here: <a href="${signup}">${signup}</a></p>
      <p>Use this email address for the account: host approval is tied to it. Once signed in, Settings, Install agent has the installer and your node token.</p>
    `
      : `
      <p>Hi ${escapeHtml(input.name)},</p>
      <p>Thanks for offering to host on EdgeCoder. Your request is approved: machines on the account with this email can now take work from the network.</p>
      <p>Sign in at <a href="${signin}">${signin}</a>; Settings, Install agent has the installer. Agents already running pick this up within a few minutes.</p>
    `;
    return sendResendEmail(input.email, "Your EdgeCoder host request is approved", html, "host_approved_email");
  }

  const when = (ms: number) => new Date(ms).toUTCString();

  /**
   * Adding or changing a payout destination (src/portal/account-security.ts): a link that confirms
   * it (single use, expires after ttlMinutes), and the same confirmation as a code for the app.
   */
  async function sendPayoutDestinationConfirmEmail(input: { email: string; destination: string; token: string; code: string; ttlMinutes: number; cooldownHours: number }): Promise<void> {
    const link = `${cfg.portalPublicUrl}/auth/account-security/confirm-destination?token=${encodeURIComponent(input.token)}`;
    const html = `
      <p>Someone signed in to your EdgeCoder account asked to send your payouts to:</p>
      <p><strong>${escapeHtml(input.destination)}</strong></p>
      <p>If this was you, confirm it: <a href="${link}">${link}</a></p>
      <p>Or enter this code in the app: <strong style="font-size:20px;letter-spacing:0.18em;">${escapeHtml(input.code)}</strong></p>
      <p>The link and code work once and expire in ${input.ttlMinutes} minutes. After you confirm, payouts start going to this address in ${input.cooldownHours} hours.</p>
      <p>If this was not you, do not click the link. Change your password and turn on two-factor authentication.</p>
    `;
    if (!(await sendResendEmail(input.email, "Confirm your new EdgeCoder payout address", html, "payout_destination_confirm_email"))) throw new Error("email_not_configured");
  }

  /** Sent when a destination change is confirmed: when it takes effect, and a one-click cancel. */
  async function sendPayoutDestinationAddedEmail(input: { email: string; destination: string; activatesAtMs: number; cancelToken: string }): Promise<boolean> {
    const link = `${cfg.portalPublicUrl}/auth/account-security/cancel-destination?token=${encodeURIComponent(input.cancelToken)}`;
    const html = `
      <p>A new payout address was added to your EdgeCoder account:</p>
      <p><strong>${escapeHtml(input.destination)}</strong></p>
      <p>Payouts go there from ${escapeHtml(when(input.activatesAtMs))}. Until then your previous address (if you had one) keeps receiving them, and withdrawals are paused.</p>
      <p><strong>If this wasn't you</strong>, click to cancel the change and secure your account (this signs out every session): <a href="${link}">${link}</a></p>
    `;
    return sendResendEmail(input.email, "A new payout address was added to your EdgeCoder account", html, "payout_destination_added_email");
  }

  /** Every withdrawal: what, where (masked) and when, with a link that locks the account. */
  async function sendWithdrawalReceiptEmail(input: { email: string; amountSats: number; destination: string; atMs: number; lockToken: string; status: string; what?: string }): Promise<boolean> {
    const link = `${cfg.portalPublicUrl}/auth/account-security/lock?token=${encodeURIComponent(input.lockToken)}`;
    const html = `
      <p>${escapeHtml(input.what ?? "A withdrawal")} was made from your EdgeCoder account.</p>
      <ul>
        <li>Amount: ${escapeHtml(input.amountSats.toLocaleString("en-US"))} sats</li>
        <li>To: ${escapeHtml(input.destination)}</li>
        <li>Time: ${escapeHtml(when(input.atMs))}</li>
        <li>Status: ${escapeHtml(input.status)}</li>
      </ul>
      <p><strong>Not you?</strong> Lock your account: <a href="${link}">${link}</a></p>
      <p>Locking pauses payouts and signs out every session. An EdgeCoder admin unlocks it after checking with you.</p>
    `;
    return sendResendEmail(input.email, `EdgeCoder withdrawal receipt: ${input.amountSats.toLocaleString("en-US")} sats`, html, "withdrawal_receipt_email");
  }

  async function sendAccountLockedEmail(input: { email: string }): Promise<boolean> {
    const html = `
      <p>Your EdgeCoder account was locked: payouts are paused and every session was signed out.</p>
      <p>Reset your password, then contact support (or reply to this email) so an admin can unlock it.</p>
    `;
    return sendResendEmail(input.email, "Your EdgeCoder account is locked", html, "account_locked_email");
  }

  /** Two-factor authentication turned on or off. */
  async function sendTwoFactorChangedEmail(input: { email: string; enabled: boolean }): Promise<boolean> {
    const html = input.enabled
      ? `<p>Two-factor authentication was turned on for your EdgeCoder account. Keep your recovery codes somewhere safe.</p>`
      : `<p>Two-factor authentication was turned off for your EdgeCoder account.</p><p>If this was not you, reset your password now.</p>`;
    return sendResendEmail(input.email, `Two-factor authentication ${input.enabled ? "on" : "off"} for your EdgeCoder account`, html, "two_factor_changed_email");
  }

  return { sendOauthLinkConfirmEmail, sendOauthConnectedEmail, sendOauthLinkClaimNoticeEmail, sendHostRequestAdminEmail, sendHostApprovedEmail, sendVerificationEmail, sendWalletSendMfaCodeEmail, sendPasswordResetEmail, sendPasswordResetSsoNoticeEmail, sendPayoutDestinationCodeEmail, sendWithdrawCodeEmail, sendPayoutCallbackChangedEmail, sendPayoutCallbackCodeEmail, sendPayoutDestinationConfirmEmail, sendPayoutDestinationAddedEmail, sendWithdrawalReceiptEmail, sendAccountLockedEmail, sendTwoFactorChangedEmail };
}
