// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { request } from "undici";
import { escapeHtml } from "./pages/escape.js";

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
      <p>If your wallet provider moved its servers, confirm the change under Settings, Plan &amp; usage to keep receiving payouts:
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

  return { sendVerificationEmail, sendWalletSendMfaCodeEmail, sendPasswordResetEmail, sendPasswordResetSsoNoticeEmail, sendPayoutDestinationCodeEmail, sendWithdrawCodeEmail, sendPayoutCallbackChangedEmail, sendPayoutCallbackCodeEmail };
}
