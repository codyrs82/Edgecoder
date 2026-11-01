// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { request } from "undici";

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
        <li>Amount (sats): ${input.amountSats}</li>
        <li>Destination: ${input.destination}</li>
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

  return { sendVerificationEmail, sendWalletSendMfaCodeEmail };
}
