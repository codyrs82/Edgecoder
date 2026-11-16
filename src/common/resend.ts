// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { request } from "undici";

/**
 * One email through Resend (https://resend.com), the sender the portal uses for verification and
 * password-reset mail (src/portal/email.ts). Shared with production alerting (src/alerting), so the
 * coordinators email alerts the same way. Throws `${errorTag}_failed:<status>` on a non-2xx answer.
 */
export interface ResendMessage {
  apiKey: string;
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

export async function postResendEmail(m: ResendMessage, errorTag = "resend_email", timeoutMs = 15_000): Promise<void> {
  const res = await request("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${m.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: m.from, to: m.to, subject: m.subject, html: m.html, ...(m.text ? { text: m.text } : {}) }),
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const body = await res.body.text();
    throw new Error(`${errorTag}_failed:${res.statusCode}:${body.slice(0, 300)}`);
  }
  try {
    await res.body.text();
  } catch {
    // The send succeeded; an unread body is not an error.
  }
}
